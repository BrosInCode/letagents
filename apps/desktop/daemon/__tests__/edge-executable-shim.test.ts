import assert from "node:assert/strict";
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
import { findProcessesReferencingPath, startEdgeDaemon } from "./edge/daemon-edge-harness.js";
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
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("letagents-edge-")));
  await assert.rejects(
    () =>
      startEdgeDaemon({
        daemonCommand: {
          command: process.execPath,
          args: [join(tmpdir(), "nonexistent-daemon-entry-for-edge-cleanup-test.js")],
        },
        readyTimeoutMs: 1_500,
      }),
  );
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith("letagents-edge-") && !before.has(name));
  assert.deepEqual(after, [], "Expected failed startEdgeDaemon() to clean up its temporary home directory");
  assert.deepEqual(
    findProcessesReferencingPath("nonexistent-daemon-entry-for-edge-cleanup-test.js"),
    [],
    "Expected zero leftover processes after failed startEdgeDaemon()",
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
