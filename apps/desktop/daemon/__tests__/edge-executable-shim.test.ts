import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseNodeShim } from "../../../../shared/codex-executable.mjs";
import { findReplayLeaks, type ReplayRedactionContext } from "../../electron/__tests__/provider-replay/redaction.js";
import { parseProviderReplayTranscript } from "../../electron/__tests__/provider-replay/transcript.js";
import { parseCodexEdgeTranscript } from "./edge/codex/parser.mjs";
import {
  EDGE_DAEMON_UNSUPPORTED_REASON,
  execWithTimeoutRetry,
  findProcessesReferencingPath,
  lastProcessListDiagnostics,
  listOsProcesses,
  parseWindowsHelperInfoResult,
  parseWindowsTasklistCsv,
  queryWindowsHelperInfoWithSettle,
  resolveDefaultDaemonCommand,
  selectWindowsEdgeProcessCandidates,
  startEdgeDaemon,
} from "./edge/daemon-edge-harness.js";
import { EDGE_STAND_IN_RUNTIME_ENV, materializeNodeShim, resolveStandInRuntime } from "./edge/executable-shim.js";
import { parseOpenCodeEdgeTranscript } from "./edge/open-model/parser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_EDGE_DIR = resolve(HERE, "edge/codex");
const OPEN_MODEL_EDGE_DIR = resolve(HERE, "edge/open-model");

test("edge executable shim generates a parseNodeShim-compatible Windows .cmd wrapper and supports copyScript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-shim-check-"));
  try {
    const shimPath = await materializeNodeShim(dir, "codex", join(CODEX_EDGE_DIR, "server.mjs"), {
      platform: "win32",
      copyScript: true,
      env: { LETAGENTS_EDGE_MARKER: "ok" },
    });
    assert.ok(shimPath.endsWith(".cmd"));
    const content = await readFile(shimPath, "utf8");
    const parsed = parseNodeShim(shimPath, content);
    assert.ok(parsed, "Expected Windows .cmd shim to satisfy shared/codex-executable parseNodeShim()");
    assert.ok(parsed.args.at(-1)?.endsWith("codex.entry.mjs"));
    assert.equal(existsSync(join(dir, "codex.script.mjs")), true);
    const entryText = await readFile(join(dir, "codex.entry.mjs"), "utf8");
    assert.ok(entryText.includes("codex.script.mjs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the stand-in runtime is the test process program for the default daemon command and for a daemon that is no script", () => {
  const env = {};
  // The default command: the daemon is a script under the program of the test process.
  assert.equal(resolveStandInRuntime({ command: process.execPath, args: ["/x/dist-daemon/main.js"] }, { env, hostEnv: {} }), process.execPath);
  // A daemon in another language starts no script, so it cannot run a stand-in.
  assert.equal(resolveStandInRuntime({ command: "/opt/daemon/letagents-daemon", args: ["--foreground"] }, { env, hostEnv: {}, execPath: "/usr/bin/node" }), "/usr/bin/node");
  // A command that does not exist changes nothing.
  assert.equal(resolveStandInRuntime({ command: "/no/such/runtime", args: ["main.js"] }, { env, hostEnv: {}, execPath: "/usr/bin/node" }), "/usr/bin/node");
});

test("the stand-in runtime is the daemon's program when an overridden command starts a script", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "letagents-shim-runtime-")));
  try {
    const runtime = join(dir, "runtime");
    await writeFile(runtime, "", { mode: 0o755 });
    // An absolute path.
    assert.equal(resolveStandInRuntime({ command: runtime, args: ["/x/dist-daemon/main.js"] }, { env: {}, hostEnv: {}, execPath: "/usr/bin/node" }), runtime);
    // A name on PATH.
    assert.equal(
      resolveStandInRuntime({ command: "runtime", args: ["--flag", "main.mjs"] }, { env: { PATH: ["/no/such/folder", dir].join(delimiter) }, hostEnv: {}, execPath: "/usr/bin/node" }),
      runtime,
    );
    // A relative command is read from the folder that the daemon starts in, not from the folder of the test process.
    assert.equal(resolveStandInRuntime({ command: "./runtime", args: ["main.js"] }, { env: {}, hostEnv: {}, cwd: dir, execPath: "/usr/bin/node" }), runtime);
    assert.equal(
      resolveStandInRuntime({ command: "./runtime", args: ["main.js"] }, { env: {}, hostEnv: {}, cwd: join(dir, "elsewhere"), execPath: "/usr/bin/node" }),
      "/usr/bin/node",
    );
    // The PATH of the daemon decides, not the PATH of the test process.
    assert.equal(
      resolveStandInRuntime({ command: "runtime", args: ["main.js"] }, { env: { PATH: "/no/such/folder" }, hostEnv: { PATH: dir }, execPath: "/usr/bin/node" }),
      "/usr/bin/node",
    );
    // The explicit variable of the test process decides before each other rule.
    assert.equal(
      resolveStandInRuntime({ command: runtime, args: ["main.js"] }, { env: {}, hostEnv: { [EDGE_STAND_IN_RUNTIME_ENV]: "/chosen/runtime" }, execPath: "/usr/bin/node" }),
      "/chosen/runtime",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "the stand-in runtime is the target of a link, as the daemon sees its own program",
  { skip: process.platform === "win32" ? "a link needs a special right on Windows" : false },
  async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "letagents-shim-runtime-link-")));
    try {
      const runtime = join(dir, "runtime");
      const link = join(dir, "link");
      await writeFile(runtime, "", { mode: 0o755 });
      await symlink(runtime, link);
      assert.equal(resolveStandInRuntime({ command: link, args: ["main.js"] }, { env: {}, hostEnv: {}, execPath: "/usr/bin/node" }), runtime);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a POSIX shim starts the given runtime, in Node mode only when it is not the test process program", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letagents-shim-posix-"));
  try {
    const script = join(CODEX_EDGE_DIR, "server.mjs");
    const standard = await readFile(await materializeNodeShim(dir, "standard", script, { platform: "linux" }), "utf8");
    assert.ok(standard.includes(`exec '${process.execPath}' `));
    assert.equal(standard.includes("ELECTRON_RUN_AS_NODE"), false, "the default shim is unchanged");

    const other = await readFile(await materializeNodeShim(dir, "other", script, { platform: "linux", nodeBin: "/Apps/Let Agents.app/Contents/MacOS/LetAgents" }), "utf8");
    assert.ok(other.includes("exec '/Apps/Let Agents.app/Contents/MacOS/LetAgents' "));
    assert.ok(other.indexOf("export ELECTRON_RUN_AS_NODE") < other.indexOf("exec "), "Node mode is set before the program starts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a daemon command from outside starts in Node mode, so a packaged app needs no wrapper file", () => {
  const saved = { cmd: process.env.LETAGENTS_EDGE_DAEMON_CMD, args: process.env.LETAGENTS_EDGE_DAEMON_ARGS };
  try {
    process.env.LETAGENTS_EDGE_DAEMON_CMD = "/Apps/LetAgents.app/Contents/MacOS/LetAgents";
    process.env.LETAGENTS_EDGE_DAEMON_ARGS = JSON.stringify(["/Apps/LetAgents.app/Contents/Resources/app/dist-daemon/main.js"]);
    const command = resolveDefaultDaemonCommand();
    assert.equal(command.command, "/Apps/LetAgents.app/Contents/MacOS/LetAgents");
    assert.deepEqual(command.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(command.useNodeIpc, false);
  } finally {
    for (const [name, value] of [["LETAGENTS_EDGE_DAEMON_CMD", saved.cmd], ["LETAGENTS_EDGE_DAEMON_ARGS", saved.args]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("replay stand-in transcript parsers strictly reject missing or non-terminal runtime_exit", () => {
  const missingExitCodex = [
    JSON.stringify({
      type: "transcript_start",
      format: 1,
      provider: "codex",
      protocol: "codex.app-server/jsonrpc-ws",
      providerVersion: "codex-cli 0.162.1",
      scenario: "bad",
      capture: {},
    }),
    JSON.stringify({ type: "emit_inbound", label: "initialize", frame: { id: 1, result: {} } }),
    JSON.stringify({ type: "emit_inbound", label: "thread/start", frame: { id: 2, result: { thread: { id: "<thread>" } } } }),
  ].join("\n");
  assert.throws(() => parseCodexEdgeTranscript(missingExitCodex, "bad-codex.ndjson"), /runtime_exit/);

  const trailingAfterExitCodex = [
    missingExitCodex,
    JSON.stringify({ type: "runtime_exit", requested: true, transportClosedBeforeExit: false, code: 0, signal: null }),
    JSON.stringify({ type: "emit_inbound", label: "extra", frame: { method: "warning", params: {} } }),
  ].join("\n");
  assert.throws(() => parseCodexEdgeTranscript(trailingAfterExitCodex, "bad-codex-trailing.ndjson"), /after runtime_exit/);

  const missingExitOpenModel = [
    JSON.stringify({
      type: "transcript_start",
      format: 1,
      provider: "open-model",
      protocol: "opencode.server/http-sse",
      providerVersion: "1.18.20",
      scenario: "bad",
      capture: {},
    }),
    JSON.stringify({ type: "emit_inbound", label: "response:GET /global/health", frame: { kind: "http", method: "GET", path: "/global/health", status: 200, body: { healthy: true, version: "1.18.20" } } }),
    JSON.stringify({ type: "emit_inbound", label: "response:POST /session", frame: { kind: "http", method: "POST", path: "/session", status: 200, body: { id: "<session>" } } }),
  ].join("\n");
  assert.throws(() => parseOpenCodeEdgeTranscript(missingExitOpenModel, "bad-om.ndjson"), /runtime_exit/);

  const trailingAfterExitOpenModel = [
    missingExitOpenModel,
    JSON.stringify({ type: "runtime_exit", requested: true, transportClosedBeforeExit: false, code: 0, signal: null }),
    JSON.stringify({ type: "emit_inbound", label: "extra", frame: { kind: "sse", event: { type: "session.idle" } } }),
  ].join("\n");
  assert.throws(() => parseOpenCodeEdgeTranscript(trailingAfterExitOpenModel, "bad-om-trailing.ndjson"), /after runtime_exit/);
});

test("startEdgeDaemon cleans up temp home and server on startup failure", async () => {
  const isolatedTempRoot = await mkdtemp(join(tmpdir(), "letagents-edge-startup-fail-"));
  try {
    await assert.rejects(
      () =>
        startEdgeDaemon({
          tempRoot: isolatedTempRoot,
          daemonCommand: {
            command: process.execPath,
            args: [join(isolatedTempRoot, "nonexistent-daemon-entry-for-edge-cleanup-test.js")],
          },
          readyTimeoutMs: 1_500,
        }),
    );
    const remaining = readdirSync(isolatedTempRoot);
    assert.deepEqual(remaining, [], "Expected failed startEdgeDaemon() to clean up its temporary home directory");
    assert.deepEqual(
      findProcessesReferencingPath(isolatedTempRoot),
      [],
      "Expected zero leftover processes after failed startEdgeDaemon()",
    );
  } finally {
    await rm(isolatedTempRoot, { recursive: true, force: true });
  }
});

test("process enumeration failure cannot satisfy zero-process assertions or silent dispose()", async () => {
  // 1. Direct inspection helper must throw rather than return [].
  assert.throws(
    () =>
      findProcessesReferencingPath(tmpdir(), () => {
        throw new Error("simulated process lookup failure");
      }),
    /simulated process lookup failure/,
  );

  if (process.platform !== "win32") {
    const previousPath = process.env.PATH;
    process.env.PATH = join(tmpdir(), `letagents-nonexistent-path-${randomUUID()}`);
    try {
      assert.throws(
        () => findProcessesReferencingPath(tmpdir()),
        /OS process enumeration failed/,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }

  // 2. Real harness dispose() must surface inspection failure, keep homeDir evidence,
  //    close independent roomServer handles in finally, and clean up once inspection recovers.
  if (EDGE_DAEMON_UNSUPPORTED_REASON) return;
  let failListProcesses = false;
  const harness = await startEdgeDaemon({
    ...(process.platform === "win32"
      ? {
          listProcesses: () => {
            if (failListProcesses) throw new Error("simulated Windows process lookup failure");
            return listOsProcesses();
          },
        }
      : {}),
  });

  const probeChild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);", "--", harness.homeDir],
    { stdio: "ignore", windowsHide: true },
  );
  const previousPath = process.env.PATH;
  try {
    assert.ok(probeChild.pid, "expected probe child pid");
    harness.trackProviderPid(probeChild.pid);
    const before = findProcessesReferencingPath(harness.homeDir);
    assert.ok(
      before.some((entry) => entry.pid === probeChild.pid),
      `expected normal process enumeration to find probe child ${probeChild.pid}`,
    );

    // Fault-inject enumeration failure: broken PATH on POSIX, failing enumerator on Windows.
    if (process.platform === "win32") {
      failListProcesses = true;
    } else {
      process.env.PATH = join(tmpdir(), `letagents-nonexistent-path-${randomUUID()}`);
    }

    await assert.rejects(
      () => harness.dispose(),
      /could not verify process cleanup/,
      "Expected dispose() to reject when OS process inspection fails",
    );
    assert.equal(
      existsSync(harness.homeDir),
      true,
      "Expected dispose() to preserve homeDir evidence when cleanup verification fails",
    );
    await assert.rejects(
      () => fetch(`${harness.roomServer.apiUrl}/api/health`),
      "Expected dispose() finally block to close FakeRoomServer even when process inspection fails",
    );
    // Probe child should still be alive until inspection is restored.
    assert.doesNotThrow(() => process.kill(probeChild.pid!, 0));

    // Restore inspection and confirm a follow-up dispose() finishes cleanup cleanly.
    failListProcesses = false;
    if (process.platform !== "win32") {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await harness.dispose();
    assert.equal(existsSync(harness.homeDir), false, "Expected recovery dispose() to remove homeDir after clean verification");
    assert.deepEqual(findProcessesReferencingPath(harness.homeDir), []);
  } finally {
    failListProcesses = false;
    if (process.platform !== "win32") {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    if (probeChild.pid) {
      try { process.kill(probeChild.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await harness.dispose().catch(() => undefined);
  }
});

test("Windows tasklist CSV parser, candidate filter, timeout retry, and live OS enumeration diagnostics", (t) => {
  const sampleCsv = [
    '\uFEFF"System Idle Process","0","Services","0","8 K"',
    '"System","4","Services","0","144 K"',
    '"svchost.exe","892","Services","0","15,320 K"',
    '"MsMpEng.exe","2104","Services","0","120,000 K"',
    '"node.exe","5412","Console","1","45,120 K"',
    '"cmd.exe","6120","Console","1","4,012 K"',
    '"letagents-process-tree.exe","6118","Console","1","2,100 K"',
    '"codex.exe","7001","Console","1","22,000 K"',
    '"custom-daemon.exe","7777","Console","1","12,000 K"',
    "INFO: No tasks are running which match the specified criteria.",
  ].join("\r\n");

  const parsed = parseWindowsTasklistCsv(sampleCsv);
  assert.deepEqual(
    parsed.map((row) => [row.image, row.pid]),
    [
      ["System", 4],
      ["svchost.exe", 892],
      ["MsMpEng.exe", 2104],
      ["node.exe", 5412],
      ["cmd.exe", 6120],
      ["letagents-process-tree.exe", 6118],
      ["codex.exe", 7001],
      ["custom-daemon.exe", 7777],
    ],
  );

  const selected = selectWindowsEdgeProcessCandidates(parsed, {
    currentPid: 5412,
    extraPids: [7777],
  });
  assert.deepEqual(
    selected.map((row) => row.pid),
    [5412, 6120, 6118, 7001, 7777],
    "Expected candidate filter to skip OS services while keeping node/cmd/helper/providers/tracked PIDs",
  );

  // Retry once on ETIMEDOUT, fail immediately on non-timeout errors.
  let timeoutAttempts = 0;
  const recovered = execWithTimeoutRetry(() => {
    timeoutAttempts += 1;
    if (timeoutAttempts === 1) {
      const err = new Error("timed out") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      throw err;
    }
    return "ok";
  }, 2);
  assert.equal(recovered, "ok");
  assert.equal(timeoutAttempts, 2);

  let enoentAttempts = 0;
  assert.throws(
    () =>
      execWithTimeoutRetry(() => {
        enoentAttempts += 1;
        const err = new Error("missing binary") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }, 2),
    /missing binary/,
  );
  assert.equal(enoentAttempts, 1, "Expected non-timeout errors to fail immediately without retry");

  // Live OS enumeration smoke check + Windows native helper proof.
  const live = listOsProcesses();
  assert.ok(live.some((entry) => entry.pid === process.pid), "Expected listOsProcesses() to include current runner pid");
  const diag = lastProcessListDiagnostics();
  assert.ok(diag, "Expected process list diagnostics after listOsProcesses()");
  if (
    process.platform === "win32" &&
    (process.env.LETAGENTS_PROCESS_TREE_HELPER?.trim() || process.env.LETAGENTS_TEST_PROCESS_TREE_HELPER?.trim())
  ) {
    assert.equal(
      diag.method,
      "tasklist+process-tree-helper",
      `Expected Windows CI to use tasklist + letagents-process-tree.exe instead of PowerShell, got ${JSON.stringify(diag)}`,
    );
  }
  t.diagnostic(
    `edge process list diagnostics: method=${diag.method} totalTasks=${diag.totalTasks} helperCalls=${diag.helperCalls} elapsedMs=${diag.elapsedMs}`,
  );
});

test("unreadable native helper info (commandLine: null or access denied) fails closed in parser, finder, and dispose()", async () => {
  // 1. Confirmed absent (exit 2) or exited (exited: true) stays harmless for non-required PIDs.
  assert.equal(parseWindowsHelperInfoResult(9999, { status: 2 }), null);
  assert.equal(
    parseWindowsHelperInfoResult(9999, {
      status: 0,
      stdout: JSON.stringify({
        pid: 9999,
        parentPid: 1,
        exited: true,
        image: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: null,
      }),
    }),
    null,
  );
  assert.throws(
    () => parseWindowsHelperInfoResult(process.pid, { status: 2 }, { required: true }),
    /reported required pid .* absent/,
  );

  // 2. Live process with commandLine: null never substitutes image path.
  const unreadableUntracked = parseWindowsHelperInfoResult(4242, {
    status: 0,
    stdout: JSON.stringify({
      pid: 4242,
      parentPid: 1,
      exited: false,
      image: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: null,
    }),
  });
  assert.deepEqual(unreadableUntracked, {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    command: "",
    image: "C:\\Program Files\\nodejs\\node.exe",
    helperExited: false,
    commandLineUnreadable: true,
  });

  // 2b. Transient Windows PEB init/teardown (status 0 + commandLine: null) settles on brief retry,
  //     while persistent unreadable commandLine still fails closed and access denied fails immediately.
  const sleeps: number[] = [];
  let dyingCalls = 0;
  const settledDead = queryWindowsHelperInfoWithSettle(
    4242,
    () => {
      dyingCalls += 1;
      if (dyingCalls === 1) {
        return {
          status: 0,
          stdout: JSON.stringify({
            pid: 4242,
            parentPid: 1,
            exited: false,
            image: "C:\\Program Files\\nodejs\\node.exe",
            commandLine: null,
          }),
        };
      }
      return { status: 2 };
    },
    { maxUnreadableRetries: 3, retryDelayMs: 50, sleep: (ms) => sleeps.push(ms) },
  );
  assert.equal(settledDead, null);
  assert.equal(dyingCalls, 2);
  assert.deepEqual(sleeps, [50]);

  let startingCalls = 0;
  const settledLive = queryWindowsHelperInfoWithSettle(
    4243,
    () => {
      startingCalls += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          pid: 4243,
          parentPid: 1,
          exited: false,
          image: "C:\\Program Files\\nodejs\\node.exe",
          commandLine: startingCalls === 1 ? null : "node.exe worker.js",
        }),
      };
    },
    { owned: true, maxUnreadableRetries: 3, retryDelayMs: 50, sleep: () => undefined },
  );
  assert.equal(settledLive?.command, "node.exe worker.js");
  assert.equal(startingCalls, 2);

  let persistentCalls = 0;
  assert.throws(
    () =>
      queryWindowsHelperInfoWithSettle(
        4244,
        () => {
          persistentCalls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              pid: 4244,
              parentPid: 1,
              exited: false,
              image: "C:\\Program Files\\nodejs\\node.exe",
              commandLine: null,
            }),
          };
        },
        { owned: true, maxUnreadableRetries: 2, retryDelayMs: 10, sleep: () => undefined },
      ),
    /unreadable commandLine/,
  );
  assert.equal(persistentCalls, 3);

  let deniedCalls = 0;
  assert.throws(
    () =>
      queryWindowsHelperInfoWithSettle(
        4245,
        () => {
          deniedCalls += 1;
          return { status: 3 };
        },
        { owned: true, maxUnreadableRetries: 3, retryDelayMs: 10, sleep: () => undefined },
      ),
    /access denied/,
  );
  assert.equal(deniedCalls, 1, "Expected access-denied owned PID to fail immediately without retry");
  assert.throws(
    () =>
      parseWindowsHelperInfoResult(
        4242,
        {
          status: 0,
          stdout: JSON.stringify({
            pid: 4242,
            parentPid: 1,
            exited: false,
            image: "C:\\Program Files\\nodejs\\node.exe",
            commandLine: null,
          }),
        },
        { owned: true },
      ),
    /unreadable commandLine/,
  );

  // 3. Access denied (exit 3) fails closed for owned/tracked or required PIDs.
  assert.throws(
    () => parseWindowsHelperInfoResult(4242, { status: 3 }, { owned: true }),
    /access denied/,
  );
  assert.throws(
    () => parseWindowsHelperInfoResult(process.pid, { status: 3 }, { required: true }),
    /access denied/,
  );
  assert.equal(parseWindowsHelperInfoResult(4242, { status: 3 }), null);

  // 4. findProcessesReferencingPath() refuses unreadable commandLine entries.
  assert.throws(
    () => findProcessesReferencingPath(tmpdir(), () => [unreadableUntracked!]),
    /unreadable command line/,
  );

  // 5. Real EdgeDaemonHarness.dispose() must reject and preserve homeDir when a live tracked
  //    child either reports commandLine: null or is omitted (e.g. access-denied status 3),
  //    then clean up cleanly once inspection recovers.
  if (EDGE_DAEMON_UNSUPPORTED_REASON) return;
  let mode: "null-commandline" | "omit-tracked" | "real" = "real";
  let trackedPid = 0;
  const harness = await startEdgeDaemon({
    listProcesses: (extraPids) => {
      const live = listOsProcesses(extraPids);
      if (mode === "null-commandline") {
        const converted = parseWindowsHelperInfoResult(trackedPid, {
          status: 0,
          stdout: JSON.stringify({
            pid: trackedPid,
            parentPid: process.pid,
            exited: false,
            image: process.execPath,
            commandLine: null,
          }),
        });
        return live.map((entry) => (entry.pid === trackedPid ? converted! : entry));
      }
      if (mode === "omit-tracked") {
        return live.filter((entry) => entry.pid !== trackedPid);
      }
      return live;
    },
  });

  const probeChild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);", "--", harness.homeDir],
    { stdio: "ignore", windowsHide: true },
  );
  try {
    assert.ok(probeChild.pid, "expected probe child pid");
    trackedPid = probeChild.pid;
    harness.trackProviderPid(probeChild.pid);

    // 5a. Status 0 with commandLine: null must fail dispose() and preserve homeDir.
    mode = "null-commandline";
    await assert.rejects(
      () => harness.dispose(),
      /could not verify process cleanup/,
      "Expected dispose() to reject when a live tracked child has commandLine: null",
    );
    assert.equal(existsSync(harness.homeDir), true, "Expected homeDir preserved after null commandLine");
    assert.doesNotThrow(() => process.kill(probeChild.pid!, 0));
    await assert.rejects(
      () => fetch(`${harness.roomServer.apiUrl}/api/health`),
      "Expected FakeRoomServer closed in finally even when commandLine is unreadable",
    );

    // 5b. Omitted live tracked child (e.g. status 3 access denied) must also fail dispose() and preserve homeDir.
    mode = "omit-tracked";
    await assert.rejects(
      () => harness.dispose(),
      /unverifiable live tracked pid/,
      "Expected dispose() to reject when a live tracked child is omitted from process snapshot",
    );
    assert.equal(existsSync(harness.homeDir), true, "Expected homeDir preserved when live tracked child is omitted");
    assert.doesNotThrow(() => process.kill(probeChild.pid!, 0));

    // 5c. Once inspection recovers, follow-up dispose() kills the probe child and removes homeDir.
    mode = "real";
    await harness.dispose();
    assert.equal(existsSync(harness.homeDir), false, "Expected recovery dispose() to remove homeDir");
    assert.deepEqual(findProcessesReferencingPath(harness.homeDir), []);
  } finally {
    mode = "real";
    if (probeChild.pid) {
      try { process.kill(probeChild.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await harness.dispose().catch(() => undefined);
  }
});

test("all committed Codex and Open Model edge fixtures parse strictly and have zero redaction leaks", () => {
  const context: ReplayRedactionContext = {
    workspacePaths: [],
    tempDirectories: [],
    repositoryPaths: [],
    homeDirectory: "/Users/example-nonexistent-user",
    username: "example-nonexistent-user",
    personalNames: [],
    hostnames: [],
    secrets: ["sk-edge-local-record"],
    ownerSetupNames: [],
    accountMethods: [/^account\//],
  };

  for (const [provider, dir, strictParse] of [
    ["codex", join(CODEX_EDGE_DIR, "fixtures"), parseCodexEdgeTranscript],
    ["open-model", join(OPEN_MODEL_EDGE_DIR, "fixtures"), parseOpenCodeEdgeTranscript],
  ] as const) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort();
    assert.equal(files.length, 7, `expected 7 ${provider} edge fixtures, got ${files.join(", ")}`);
    for (const file of files) {
      const fullPath = join(dir, file);
      const raw = readFileSync(fullPath, "utf8");
      const parsed = parseProviderReplayTranscript(raw, fullPath);
      assert.equal(parsed.start.provider, provider);
      assert.ok(parsed.start.capture.recorder, `${file}: expected recorded fixture metadata`);
      strictParse(raw, fullPath);
      const leaks = findReplayLeaks(raw, context);
      assert.deepEqual(leaks, [], `${provider}/${file} had redaction leaks: ${JSON.stringify(leaks)}`);
    }
  }
});
