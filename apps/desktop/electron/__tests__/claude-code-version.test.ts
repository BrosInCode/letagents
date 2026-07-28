import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectClaudeCodeVersion,
  MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION,
  requireSupportedClaudeCodeVersion,
} from "../main/agents/claude-code-version.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";

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

test("Claude Code preflight gives an update message before auth or launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-version-"));
  const bin = join(root, "claude");
  const priorBin = process.env.LETAGENTS_CLAUDE_CODE_BIN;
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('2.1.69 (Claude Code)'); process.exit(0); }",
      "process.stderr.write('auth and launch must not be reached');",
      "process.exit(9);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CLAUDE_CODE_BIN = bin;
  try {
    const result = await runDesktopAgentProviderPreflight(
      "claude-code",
      { repoRootPath: root },
      { commandTimeoutMs: 0 },
    );
    assert.equal(result.status, "error");
    assert.equal(result.canStart, false);
    assert.equal(result.message, "Claude Code needs an update.");
    assert.match(result.detail ?? "", /2\.1\.69 is too old.*claude update/);
    assert.equal(result.version, "2.1.69 (Claude Code)");
  } finally {
    if (priorBin === undefined) {
      delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
    } else {
      process.env.LETAGENTS_CLAUDE_CODE_BIN = priorBin;
    }
    await rm(root, { recursive: true, force: true });
  }
});
