import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentActorLabel } from "../../shared/agent-identity.js";
import {
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  ideLabelFromMcpClientName,
  setMcpClientNameSource,
} from "../server/runtime/identity/config.js";

test("MCP host client names map to the IDE label chat shows", () => {
  assert.equal(ideLabelFromMcpClientName("claude-code"), "Claude Code");
  assert.equal(ideLabelFromMcpClientName("opencode"), "OpenCode");
  assert.equal(ideLabelFromMcpClientName("codex-mcp-client"), "Codex");
  assert.equal(ideLabelFromMcpClientName("cursor-vscode"), "Cursor");
  assert.equal(ideLabelFromMcpClientName("some-other-host"), null);
  assert.equal(ideLabelFromMcpClientName(""), null);
  assert.equal(ideLabelFromMcpClientName(null), null);
});

const explicitRuntime = Boolean(process.env.LETAGENTS_AGENT_IDE || process.env.AGENT_IDE);

test(
  "an MCP host without LETAGENTS_AGENT_IDE is identified by its clientInfo",
  { skip: explicitRuntime ? "an explicit runtime label is set in this environment" : false },
  () => {
    let clientName: string | null = "opencode";
    try {
      setMcpClientNameSource(() => clientName);
      assert.equal(detectAgentIdeLabel(), "OpenCode");
      assert.equal(detectAgentRuntimeLabel(), "opencode");
      // Read on every call, so a name that arrives later is picked up.
      clientName = "claude-code";
      assert.equal(detectAgentIdeLabel(), "Claude Code");
      assert.equal(detectAgentRuntimeLabel(), "claude-code");
    } finally {
      setMcpClientNameSource(() => null);
    }
  }
);

test("actor labels keep the multi-word runtime spellings", () => {
  assert.equal(parseAgentActorLabel("MossDawn | EmmyMay's agent | claude-code")?.ide_label, "Claude Code");
  assert.equal(parseAgentActorLabel("MossDawn | EmmyMay's agent | OpenCode")?.ide_label, "OpenCode");
  assert.equal(parseAgentActorLabel("MossDawn | EmmyMay's agent | Open Model")?.ide_label, "Open Model");
});
