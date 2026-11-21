import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  parseWindowsTasklistCsv,
  selectWindowsEdgeProcessCandidates,
  startEdgeDaemon,
} from "./edge/daemon-edge-harness.js";
import { materializeNodeShim } from "./edge/executable-shim.js";
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
