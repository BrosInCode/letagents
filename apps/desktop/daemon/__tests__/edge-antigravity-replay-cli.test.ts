import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The rules of the Antigravity stand-in itself (edge/antigravity/replay-cli.mjs),
// without a daemon: what it answers, and that it refuses what the recording lacks.

const REPLAY_CLI = fileURLToPath(new URL("./edge/antigravity/replay-cli.mjs", import.meta.url));
const PLAN = fileURLToPath(new URL("./edge/antigravity/fixtures/approval", import.meta.url));

function startStandIn() {
  const planDir = mkdtempSync(join(tmpdir(), "edge-agy-cli-"));
  cpSync(PLAN, planDir, { recursive: true });
  const child = spawn(process.execPath, [REPLAY_CLI, "acp", "--gemini-dir", join(planDir, "gemini")], {
    env: { ...process.env, LETAGENTS_EDGE_AGY_REPLAY_DIR: planDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const received: Array<Record<string, any>> = [];
  let waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    received.push(JSON.parse(line) as Record<string, any>);
    for (const wake of waiters) wake();
    waiters = [];
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (match: (message: Record<string, any>) => boolean): Promise<Record<string, any>> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = received.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching message; received ${JSON.stringify(received).slice(0, 400)}`);
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  return { planDir, child, send, waitFor, exited, cleanup: () => rmSync(planDir, { recursive: true, force: true }) };
}

test("agy stand-in: --version prints the recorded version", () => {
  const planDir = mkdtempSync(join(tmpdir(), "edge-agy-cli-"));
  try {
    cpSync(PLAN, planDir, { recursive: true });
    const result = spawnSync(process.execPath, [REPLAY_CLI, "--version"], { env: { ...process.env, LETAGENTS_EDGE_AGY_REPLAY_DIR: planDir }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "1.5.16");
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
});

test("agy stand-in: answers with the daemon's ids, answers a probe at any time, and refuses a message the recording lacks", async () => {
  const standIn = startStandIn();
  try {
    standIn.send({ jsonrpc: "2.0", id: 41, method: "letagents/probe", params: {} });
    const probe = await standIn.waitFor((message) => message.id === 41);
    assert.equal(probe.error?.code, -32601);

    standIn.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test" } } });
    const init = await standIn.waitFor((message) => message.id === 7);
    assert.equal(init.result?.agentInfo?.version, "1.5.16");

    standIn.send({ jsonrpc: "2.0", id: 8, method: "session/new", params: { cwd: standIn.planDir, mcpServers: [{ name: "letagents", command: "node", args: [], env: [] }] } });
    const session = await standIn.waitFor((message) => message.id === 8);
    assert.match(String(session.result?.sessionId), /^[0-9a-f-]{36}$/);

    // The recording sets the mode next; a model change instead is not in it.
    standIn.send({ jsonrpc: "2.0", id: 9, method: "session/set_model", params: { sessionId: session.result.sessionId, modelId: "x" } });
    assert.equal(await standIn.exited, 70);
    const error = join(standIn.planDir, "claim-1", "error.txt");
    assert.ok(existsSync(error));
    assert.match(readFileSync(error, "utf8"), /recorded session\/set_mode, the daemon sent session\/set_model/);
  } finally {
    standIn.child.kill();
    standIn.cleanup();
  }
});
