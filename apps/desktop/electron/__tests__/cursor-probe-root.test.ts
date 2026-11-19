import "./isolated-home.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { runCursorSandboxedInspection } from "../main/agents/cursor-mcp-authority.js";
import {
  CURSOR_PROBE_ROOT_REMOVAL_TIMEOUT_MS,
  discardCursorProbeRoot,
  removeCursorProbeRoot,
} from "../main/agents/cursor/probe-root.js";
import { needsProcessTreeHelper, useTestProcessTreeHelper } from "./platform.js";
import {
  createHarness,
  flush,
  roomTurnRequest,
  spawnDaemonLane,
  supervisedAdapter,
  waitFor,
} from "./cursor-provider-adapter.fixture.js";

// The disposable profile folder of a Cursor inspection. On Windows a process
// that is still exiting keeps its current directory and its open files, so
// the folder can stay in use for seconds after the inspection ended.

const windowsOnly: string | false = process.platform === "win32"
  ? false
  : "holds a folder open through a process's current directory, which only Windows refuses to remove";

function inUse(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rm`), { code });
}

/** A clock that only `wait` moves, and the removal attempts made against it. */
function removalClock(outcomes: Array<Error | null>) {
  let nowMs = 1_000;
  const waits: number[] = [];
  let attempts = 0;
  return {
    waits,
    attempts: () => attempts,
    options: {
      platform: "win32" as const,
      now: () => nowMs,
      wait: async (ms: number) => { waits.push(ms); nowMs += ms; },
      remove: () => {
        const outcome = attempts < outcomes.length ? outcomes[attempts] : outcomes[outcomes.length - 1];
        attempts += 1;
        if (outcome) throw outcome;
      },
    },
  };
}

test("a Windows inspection folder still in use is removed once the process that holds it has exited", async () => {
  const clock = removalClock([inUse("EPERM"), inUse("ENOTEMPTY"), inUse("EBUSY"), inUse("EACCES"), null]);

  await removeCursorProbeRoot("C:\\Temp\\letagents-cursor-mcp-inspection-a", clock.options);

  assert.equal(clock.attempts(), 5);
  assert.deepEqual(clock.waits, [25, 50, 100, 200], "each wait is longer than the one before");
});

test("a Windows inspection folder that stays in use fails the removal at the bound", async () => {
  const held = inUse("EPERM");
  const clock = removalClock([held]);

  await assert.rejects(
    removeCursorProbeRoot("C:\\Temp\\letagents-cursor-mcp-bridge-b", { ...clock.options, timeoutMs: 1_000 }),
    (error: Error) => {
      assert.match(error.message, /letagents-cursor-mcp-bridge-b was still in use 1 s after the inspection ended \(EPERM\)/);
      assert.equal(error.cause, held);
      return true;
    },
  );
  assert.equal(clock.waits.reduce((total, ms) => total + ms, 0), 1_000, "it waits for the whole bound and no longer");
  assert.equal(clock.waits.every((ms) => ms <= 250), true);
  assert.equal(CURSOR_PROBE_ROOT_REMOVAL_TIMEOUT_MS, 20_000);
});

test("a removal error that does not mean in use is reported at once", async () => {
  const clock = removalClock([Object.assign(new Error("EINVAL: invalid argument, rm"), { code: "EINVAL" })]);

  await assert.rejects(removeCursorProbeRoot("C:\\Temp\\letagents-cursor-identity-c", clock.options), /EINVAL/);

  assert.equal(clock.attempts(), 1);
  assert.deepEqual(clock.waits, []);
});

test("off Windows an inspection folder is removed once, as before", async () => {
  const clock = removalClock([inUse("EPERM")]);

  await assert.rejects(
    removeCursorProbeRoot("/tmp/letagents-cursor-mcp-inspection-d", { ...clock.options, platform: "darwin" }),
    /EPERM/,
  );
  assert.equal(clock.attempts(), 1);
  assert.deepEqual(clock.waits, []);

  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-probe-root-test-"));
  writeFileSync(join(root, "mcp.json"), "{}");
  await removeCursorProbeRoot(root);
  assert.equal(existsSync(root), false);
});

test("discarding an inspection folder never reports the folder", async () => {
  let attempts = 0;
  await discardCursorProbeRoot("C:\\Temp\\letagents-cursor-identity-e", async () => {
    attempts += 1;
    throw inUse("EPERM");
  });
  assert.equal(attempts, 1);
});

test("the packaged bridge is inspected only after the first inspection's folder is gone", async () => {
  const events: string[] = [];
  const harness = createHarness({
    onMcpAttestation(input, pass) {
      const first = harness.mcpAttestations[0]!.writableProfileRoot;
      if (pass === 2) {
        assert.equal(existsSync(first), false, "pass one's folder is removed before pass two starts");
        assert.notEqual(input.writableProfileRoot, first);
      }
      events.push(`inspect ${pass}`);
    },
    async removeProbeRoot(root) {
      // A removal that takes time, as on Windows while a process still exits.
      events.push(`remove ${basename(root).replace(/-[^-]+$/, "")} begins`);
      await flush();
      await removeCursorProbeRoot(root);
      events.push(`remove ${basename(root).replace(/-[^-]+$/, "")} ends`);
    },
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const turn = adapter.runRoomTurn(handle, roomTurnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);

  assert.deepEqual(events, [
    "inspect 1",
    "remove letagents-cursor-mcp-inspection begins",
    "remove letagents-cursor-mcp-inspection ends",
    "inspect 2",
    "remove letagents-cursor-mcp-bridge begins",
    "remove letagents-cursor-mcp-bridge ends",
    "remove letagents-cursor-identity begins",
    "remove letagents-cursor-identity ends",
  ]);
  assert.equal(harness.launches.length, 1, "Cursor starts only after all three folders are gone");

  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "ready", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await turn).text, "ready");
});

test("an inspection folder that stays in use fails the preparation before the next inspection", async () => {
  const harness = createHarness({
    async removeProbeRoot(root) {
      if (basename(root).startsWith("letagents-cursor-mcp-inspection-")) {
        throw new Error(`Cursor's inspection folder ${root} was still in use 20 s after the inspection ended (EPERM).`);
      }
      await removeCursorProbeRoot(root);
    },
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(adapter.runRoomTurn(handle, roomTurnRequest()), /was still in use 20 s after the inspection ended/);

  assert.equal(harness.mcpAttestations.length, 1, "pass two never starts beside pass one's folder");
  assert.equal(harness.launches.length, 0);
  assert.equal(handle.observedState(), "idle");
  rmSync(harness.mcpAttestations[0]!.writableProfileRoot, { recursive: true, force: true });
});

test("a failed inspection reports its own error when its folder is also still in use", async () => {
  const removals: string[] = [];
  const harness = createHarness({
    mcpAttestationError: new Error("Cursor failed while inspecting the effective supervised MCP registry (ETIMEDOUT)."),
    async removeProbeRoot(root) {
      removals.push(root);
      throw inUse("EPERM");
    },
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);

  await assert.rejects(adapter.runRoomTurn(handle, roomTurnRequest()), /ETIMEDOUT/);

  assert.deepEqual(removals, [harness.mcpAttestations[0]!.writableProfileRoot], "the folder is tried once and then left");
  assert.equal(harness.launches.length, 0);
  rmSync(removals[0]!, { recursive: true, force: true });
});

/** A process whose current directory is `cwd`, for `lifetimeMs`; resolves once it runs. */
async function holdFolder(cwd: string, lifetimeMs: number): Promise<ChildProcess> {
  const holder = spawn(process.execPath, ["-e", `process.stdout.write("held"); setTimeout(() => {}, ${lifetimeMs});`], {
    cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  await once(holder.stdout!, "data");
  return holder;
}

test("Windows: a process still exiting in the first inspection's folder does not fail the turn", { skip: windowsOnly }, async () => {
  let holder: ChildProcess | null = null;
  const harness = createHarness({
    async onMcpAttestation(input, pass) {
      if (pass === 1) {
        // Stands in for the process the helper's job no longer lists: it
        // still has the folder as its current directory when the inspection
        // returns, and is gone a moment later.
        holder = await holdFolder(input.writableProfileRoot, 1_500);
        return;
      }
      assert.equal(existsSync(harness.mcpAttestations[0]!.writableProfileRoot), false);
      assert.notEqual(holder!.exitCode, null, "pass two starts only after the holder has exited");
    },
  });
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const turn = adapter.runRoomTurn(handle, roomTurnRequest());
  try {
    await waitFor(() => harness.children[0]?.isReleased === true, 30_000);
  } finally {
    (holder as ChildProcess | null)?.kill();
  }

  assert.equal(harness.mcpAttestations.length, 2);
  harness.children[0]!.emit({
    type: "result", subtype: "success", is_error: false,
    result: "ready", session_id: "sess-cursor-1",
  });
  harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal((await turn).text, "ready");
});

for (const ending of ["its time ran out", "it was interrupted"] as const) {
  test(`Windows: an inspection ended because ${ending} leaves no process in its folder`, {
    skip: windowsOnly || needsProcessTreeHelper,
  }, async () => {
    useTestProcessTreeHelper();
    const root = mkdtempSync(join(tmpdir(), "letagents-cursor-probe-root-test-"));
    const pidFile = join(root, "cursor.pid");
    const controller = new AbortController();
    try {
      // "Cursor" here is this Node: it records its pid and never ends by itself.
      const inspection = runCursorSandboxedInspection({
        cursorBin: process.execPath,
        commandArgs: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
        cwd: root,
        env: { ...process.env },
        writableProfileRoot: root,
        // Long enough for "Cursor" to start on a loaded runner before its time runs out.
        timeoutMs: ending === "its time ran out" ? 10_000 : 60_000,
        signal: controller.signal,
      });
      if (ending === "it was interrupted") {
        await waitFor(() => existsSync(pidFile), 30_000);
        controller.abort();
      }
      const result = await inspection;

      assert.equal(result.ok, false);
      assert.equal(result.errorCode, ending === "its time ran out" ? "ETIMEDOUT" : "ABORT_ERR");
      const cursorPid = Number(readFileSync(pidFile, "utf8"));
      assert.throws(() => process.kill(cursorPid, 0), "Cursor has exited when the inspection returns");
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, "the folder is free at once");
    } finally {
      controller.abort();
      await discardCursorProbeRoot(root);
    }
  });
}
