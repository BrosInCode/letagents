import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeApprovalProfileLabel,
  inspectClaudeCodeVersion,
  MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION,
  requireSupportedClaudeCodeVersion,
  resolveClaudeCodeExecutable,
} from "#provider-runtime/agents/claude-code-version.js";
import { clearProbeCache } from "#provider-runtime/provider-probe-cache.js";
import { writeFakeProvider } from "./platform.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";

// Every preflight case below fakes the Claude CLI with different output; no
// case may be answered from a probe that an earlier case memoised.
test.beforeEach(() => clearProbeCache());

test("Claude Code version readiness accepts supported output and rejects old or unreadable runtimes", () => {
  assert.equal(MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION, "2.1.70");
  assert.deepEqual(inspectClaudeCodeVersion("2.1.220 (Claude Code)"), {
    version: "2.1.220",
    supported: true,
    error: null,
  });
  assert.equal(requireSupportedClaudeCodeVersion("claude 3.0.0"), "3.0.0");
  assert.match(inspectClaudeCodeVersion("2.1.69 (Claude Code)").error ?? "", /too old.*2\.1\.70/);
  assert.match(inspectClaudeCodeVersion("unknown build").error ?? "", /unreadable version/);
});

test("Claude Code executable resolution has one explicit precedence", () => {
  assert.equal(resolveClaudeCodeExecutable({}, "configured-claude"), "configured-claude");
  assert.equal(
    resolveClaudeCodeExecutable({ LETAGENTS_CLAUDE_BIN: "/legacy/claude" }, "configured-claude"),
    "/legacy/claude",
  );
  assert.equal(
    resolveClaudeCodeExecutable({
      LETAGENTS_CLAUDE_CODE_BIN: "/exact/claude",
      LETAGENTS_CLAUDE_BIN: "/legacy/claude",
    }, "configured-claude"),
    "/exact/claude",
  );
});

for (const approval of [false, true]) test(`Claude Code ${approval ? "tool approval" : "runtime"} preflight gives an update message before auth or launch`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-version-"));
  const priorBin = process.env.LETAGENTS_CLAUDE_CODE_BIN;
  const bin = writeFakeProvider(
    join(root, "claude"),
    [
      `if (process.argv[2] === '--version') { console.log('${approval ? "2.1.220" : "2.1.69"} (Claude Code)'); process.exit(0); }`,
      "process.stderr.write('auth and launch must not be reached');",
      "process.exit(9);",
      "",
    ].join("\n"),
  );
  process.env.LETAGENTS_CLAUDE_CODE_BIN = bin;
  try {
    const result = await runDesktopAgentProviderPreflight(
      "claude-code",
      { repoRootPath: root, ...(approval ? { permissionProfileId: "ask_before_write" as const } : {}) },
      { commandTimeoutMs: 0 },
    );
    assert.equal(result.status, "error");
    assert.equal(result.canStart, false);
    assert.equal(result.message, "Claude Code needs an update.");
    assert.match(result.detail ?? "", approval ? /Ask before writes.*2\.1\.272.*claude update/ : /2\.1\.69 is too old.*claude update/);
    assert.equal(result.version, `${approval ? "2.1.220" : "2.1.69"} (Claude Code)`);
  } finally {
    if (priorBin === undefined) {
      delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
    } else {
      process.env.LETAGENTS_CLAUDE_CODE_BIN = priorBin;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code preflight truthfully includes the managed LetAgents connection", async (t) => {
  const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
  t.mock.method(supervisorDaemonClient, "isRuntimeEnvironmentCurrent", async () => true);
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-ready-"));
  const priorBin = process.env.LETAGENTS_CLAUDE_CODE_BIN;
  const bin = writeFakeProvider(
    join(root, "claude"),
    [
      "if (process.argv[2] === '--version') { console.log('2.1.220 (Claude Code)'); process.exit(0); }",
      "if (process.argv[2] === 'auth' && process.argv[3] === 'status') { console.log('signed in'); process.exit(0); }",
      "process.exit(9);",
      "",
    ].join("\n"),
  );
  process.env.LETAGENTS_CLAUDE_CODE_BIN = bin;
  try {
    const result = await runDesktopAgentProviderPreflight(
      "claude-code",
      { repoRootPath: root },
      { commandTimeoutMs: 0 },
    );
    assert.equal(result.status, "ready");
    assert.equal(result.canStart, true);
    assert.equal(
      result.detail,
      "This desktop supplies the managed LetAgents connection and can start and monitor a local Claude Code agent.",
    );
  } finally {
    if (priorBin === undefined) {
      delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
    } else {
      process.env.LETAGENTS_CLAUDE_CODE_BIN = priorBin;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude auth status JSON becomes readable setup guidance instead of a raw brace", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-auth-status-"));
  const priorBin = process.env.LETAGENTS_CLAUDE_CODE_BIN;
  try {
    for (const [index, [stdout, stderr, expected]] of [
      [JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2), "", "Sign in with Claude Code before starting a local room agent."],
      [JSON.stringify({ loggedIn: false, email: "not-for-display@example.test", apiKey: "not-for-display" }), "Session expired. Sign in again.", "Session expired. Sign in again."],
      [JSON.stringify({ error: { message: "The saved sign-in has expired." } }), "", "The saved sign-in has expired."],
      ["{\n  \"loggedIn\":", "", "Sign in with Claude Code before starting a local room agent."],
      ["Not logged in. Run claude auth login.", "", "Not logged in. Run claude auth login."],
    ].entries()) {
      clearProbeCache();
      process.env.LETAGENTS_CLAUDE_CODE_BIN = writeFakeProvider(join(root, `claude-${index}`), [
        "if (process.argv[2] === '--version') { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
        `process.stdout.write(${JSON.stringify(stdout)});`,
        `process.stderr.write(${JSON.stringify(stderr)});`,
        "process.exit(1);",
      ].join("\n"));
      const result = await runDesktopAgentProviderPreflight("claude-code", { roomOnly: true }, { commandTimeoutMs: 0 });
      assert.equal(result.status, "auth_required");
      assert.equal(result.canStart, false);
      assert.equal(result.nextAction, "authenticate");
      assert.equal(result.detail, expected);
      assert.doesNotMatch(result.detail ?? "", /not-for-display/);
    }
  } finally {
    if (priorBin === undefined) delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
    else process.env.LETAGENTS_CLAUDE_CODE_BIN = priorBin;
    clearProbeCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("tool approvals require the verified native version without raising existing Claude profile minimums", () => {
  assert.equal(inspectClaudeCodeVersion("2.1.220 (Claude Code)").supported, true);
  assert.equal(inspectClaudeCodeVersion("2.1.220 (Claude Code)", "Ask before writes").supported, false);
  assert.match(inspectClaudeCodeVersion("2.1.220 (Claude Code)", "Ask before writes").error!, /Ask before writes.*2\.1\.272.*claude update/);
  assert.equal(requireSupportedClaudeCodeVersion("2.1.272 (Claude Code)", "Ask before writes"), "2.1.272");
});

test("Auto uses the prompt bridge, so it needs the same native version as asking", () => {
  assert.equal(claudeApprovalProfileLabel("ask_before_write"), "Ask before writes");
  assert.equal(claudeApprovalProfileLabel("auto_review"), "Auto");
  assert.equal(claudeApprovalProfileLabel("full_access"), null);
  assert.equal(claudeApprovalProfileLabel(null), null);
  assert.match(inspectClaudeCodeVersion("2.1.220 (Claude Code)", claudeApprovalProfileLabel("auto_review")).error!, /too old for Auto\. Update to 2\.1\.272/);
});
