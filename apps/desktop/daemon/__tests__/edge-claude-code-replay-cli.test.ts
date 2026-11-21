import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The stand-in `claude` of the daemon edge tests, tested by itself. The
// transcripts here are written by hand on purpose: they test the stand-in,
// not Claude Code. A transcript that stands for Claude Code is a recording.

const REPLAY_CLI = fileURLToPath(new URL("./edge/claude-code/replay-cli.mjs", import.meta.url));
const SESSION = "0b0f6d8e-6f0e-4c53-9d0a-3c1f3a1f0001";
const WAIT_MS = 10_000;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Entry = Record<string, unknown>;

const HEADER: Entry = {
  type: "transcript_start",
  format: 1,
  provider: "claude-code",
  protocol: "claude-code.cli/stream-json-stdio",
  providerVersion: "2.1.321",
  scenario: "stand-in self test",
  capture: { recorder: "written by hand for the stand-in's own test" },
};

const userLine = (uuid: string, text: string): Entry => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "text", text }] },
});

const ONE_TURN: Entry[] = [
  { type: "expect_outbound", label: "bootstrap", frame: userLine("<turn-1>", "recorded bootstrap wording") },
  { type: "emit_inbound", label: "init", frame: { type: "system", subtype: "init", session_id: "<session>", cwd: "<workspace>" } },
  {
    type: "emit_inbound",
    label: "bootstrap-result",
    frame: { type: "result", subtype: "success", is_error: false, result: "READY", user_message_uuid: "<turn-1>", session_id: "<session>" },
  },
  { type: "expect_outbound", label: "turn", frame: userLine("<turn-2>", "recorded turn wording") },
  {
    type: "emit_inbound",
    label: "turn-result",
    frame: { type: "result", subtype: "success", is_error: false, result: "REPLY", user_message_uuid: "<turn-2>", session_id: "<session>" },
  },
  { type: "runtime_exit", requested: true, transportClosedBeforeExit: false, code: 0, signal: null },
];

function plan(transcripts: Entry[][]): string {
  const root = mkdtempSync(join(tmpdir(), "edge-claude-replay-"));
  roots.push(root);
  transcripts.forEach((entries, index) => {
    writeFileSync(join(root, `launch-${index + 1}.ndjson`), [HEADER, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  });
  return root;
}

interface StandIn {
  child: ChildProcessWithoutNullStreams;
  /** The next line of stdout, parsed. Rejects when none comes. */
  next(): Promise<Record<string, unknown>>;
  send(frame: Entry): void;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(planDir: string, args: string[], cwd = planDir): StandIn {
  const child = spawn(process.execPath, [REPLAY_CLI, ...args], {
    cwd,
    env: { ...process.env, LETAGENTS_EDGE_CLAUDE_REPLAY_DIR: planDir },
  });
  const queued: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exit,
    send: (frame) => { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    next: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the stand-in wrote no line")), WAIT_MS);
      const take = (line: string): void => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      };
      const line = queued.shift();
      if (line !== undefined) take(line);
      else waiting.push(take);
    }),
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} was not written`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("the stand-in claude of the daemon edge tests", () => {
  it("answers the version check from the transcript and takes no start for it", async () => {
    const planDir = plan([ONE_TURN]);
    const standIn = start(planDir, ["--version"]);
    let output = "";
    standIn.child.stdout.removeAllListeners("data");
    standIn.child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    assert.deepEqual(await standIn.exit, { code: 0, signal: null });
    assert.equal(output, "2.1.321 (Claude Code)\n");
    assert.equal(existsSync(join(planDir, "claim-1")), false);
  });

  it("plays a recording with this run's session and turn ids", async () => {
    const planDir = plan([ONE_TURN]);
    const standIn = start(planDir, ["--print", "--session-id", SESSION]);

    standIn.send(userLine("turn-a", "the bootstrap wording of this run"));
    const init = await standIn.next();
    assert.equal(init.session_id, SESSION);
    assert.equal(typeof init.cwd, "string");
    assert.deepEqual(await standIn.next(), {
      type: "result", subtype: "success", is_error: false, result: "READY", user_message_uuid: "turn-a", session_id: SESSION,
    });

    standIn.send(userLine("turn-b", "the turn wording of this run"));
    assert.equal((await standIn.next()).user_message_uuid, "turn-b");

    standIn.child.stdin.end();
    assert.deepEqual(await standIn.exit, { code: 0, signal: null });
    assert.equal(readJson(join(planDir, "claim-1", "exit.json")).outcome, "played");
    assert.equal(readJson(join(planDir, "claim-1", "launch.json")).sessionId, SESSION);
    assert.equal(readFileSync(join(planDir, "claim-1", "outbound.ndjson"), "utf8").trim().split("\n").length, 2);
  });

  it("emits nothing recorded after a line it still waits for", async () => {
    const planDir = plan([ONE_TURN]);
    const standIn = start(planDir, ["--session-id", SESSION]);
    await waitForFile(join(planDir, "claim-1", "launch.json"));
    await assert.rejects(Promise.race([
      standIn.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("quiet")), 300)),
    ]), /quiet/);
    standIn.child.kill("SIGKILL");
    await standIn.exit;
  });

  it("ends with its own exit code when the daemon sends what was not recorded", async () => {
    const planDir = plan([ONE_TURN]);
    const standIn = start(planDir, ["--session-id", SESSION]);
    standIn.send({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
    assert.deepEqual(await standIn.exit, { code: 70, signal: null });
    assert.match(readFileSync(join(planDir, "claim-1", "error.txt"), "utf8"), /launch-1\.ndjson:2: frame\.type/);
    assert.equal(readJson(join(planDir, "claim-1", "exit.json")).outcome, "mismatch");
  });

  it("gives a recorded control reply the request id of this run", async () => {
    const planDir = plan([[
      { type: "expect_outbound", frame: { type: "control_request", request_id: "<control-1>", request: { subtype: "interrupt" } } },
      { type: "emit_inbound", frame: { type: "control_response", response: { subtype: "success", request_id: "<control-1>" } } },
      { type: "runtime_exit", requested: false, transportClosedBeforeExit: false, code: 3, signal: null },
    ]]);
    const standIn = start(planDir, ["--resume", SESSION]);
    standIn.send({ type: "control_request", request_id: "this-run", request: { subtype: "interrupt" } });
    assert.deepEqual(await standIn.next(), { type: "control_response", response: { subtype: "success", request_id: "this-run" } });
    assert.deepEqual(await standIn.exit, { code: 3, signal: null });
  });

  it("stops before a held entry until the test lets it go", async () => {
    const planDir = plan([ONE_TURN]);
    writeFileSync(join(planDir, "hold-bootstrap-result"), "");
    const standIn = start(planDir, ["--session-id", SESSION]);
    standIn.send(userLine("turn-a", "bootstrap"));
    assert.equal((await standIn.next()).subtype, "init");
    await waitForFile(join(planDir, "claim-1", "reached-bootstrap-result"));
    rmSync(join(planDir, "hold-bootstrap-result"));
    assert.equal((await standIn.next()).result, "READY");
    standIn.child.kill("SIGKILL");
    await standIn.exit;
  });

  it("takes the next transcript for the next start", async () => {
    const second: Entry[] = [
      { type: "emit_inbound", frame: { type: "system", subtype: "status", session_id: "<session>" } },
      { type: "runtime_exit", requested: false, transportClosedBeforeExit: false, code: 0, signal: null },
    ];
    const planDir = plan([ONE_TURN, second]);
    const first = start(planDir, ["--session-id", SESSION]);
    await waitForFile(join(planDir, "claim-1", "launch.json"));
    const resumed = start(planDir, ["--resume", SESSION]);
    assert.deepEqual(await resumed.next(), { type: "system", subtype: "status", session_id: SESSION });
    assert.deepEqual(await resumed.exit, { code: 0, signal: null });
    first.child.kill("SIGKILL");
    await first.exit;
  });

  it("ends by the signal of a stop", { skip: process.platform === "win32" && "Windows has no signals to deliver" }, async () => {
    const planDir = plan([ONE_TURN]);
    const standIn = start(planDir, ["--session-id", SESSION]);
    await waitForFile(join(planDir, "claim-1", "launch.json"));
    standIn.child.kill("SIGTERM");
    assert.deepEqual(await standIn.exit, { code: null, signal: "SIGTERM" });
    assert.equal(readJson(join(planDir, "claim-1", "exit.json")).outcome, "signalled");
  });

  it("fails a start that has no transcript", async () => {
    const planDir = plan([ONE_TURN]);
    const first = start(planDir, ["--session-id", SESSION]);
    await waitForFile(join(planDir, "claim-1", "launch.json"));
    const extra = start(planDir, ["--resume", SESSION]);
    assert.deepEqual(await extra.exit, { code: 70, signal: null });
    assert.match(readFileSync(join(planDir, "claim-2", "error.txt"), "utf8"), /start 2 has no usable transcript/);
    first.child.kill("SIGKILL");
    await first.exit;
  });
});
