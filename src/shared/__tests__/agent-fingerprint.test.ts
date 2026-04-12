/**
 * Tests for agent fingerprint verification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  verifyAgentFingerprint,
  isKnownIdeLabel,
  isKnownModelFingerprint,
} from "../../shared/agent-fingerprint.js";

describe("verifyAgentFingerprint", () => {
  it("high confidence: both model and IDE verified via ide_label", () => {
    const result = verifyAgentFingerprint("claude-opus-4-6", "antigravity", {
      ide_label: "Antigravity",
      actor_label: "Agent | kdnotfound's agent | Antigravity",
      display_name: "Opus 4.6 Agent",
    });
    assert.ok(result.ide_verified);
    assert.ok(result.model_verified);
    assert.equal(result.confidence, "high");
    assert.equal(result.ide_match_source, "ide_label");
    assert.equal(result.model_match_source, "display_name");
  });

  it("medium confidence: IDE verified, model not", () => {
    const result = verifyAgentFingerprint("claude-opus-4-6", "codex", {
      ide_label: "Codex",
      actor_label: "My Agent | user's agent | Codex",
    });
    assert.ok(result.ide_verified);
    assert.ok(!result.model_verified);
    assert.equal(result.confidence, "medium");
  });

  it("low confidence: model verified, IDE not", () => {
    const result = verifyAgentFingerprint("gpt-4o", "windsurf", {
      user_agent: "gpt-4o-client/1.0",
    });
    assert.ok(result.model_verified);
    assert.ok(!result.ide_verified);
    assert.equal(result.confidence, "low");
  });

  it("none confidence: nothing matches", () => {
    const result = verifyAgentFingerprint("claude-opus-4-6", "antigravity", {
      actor_label: "Random Agent",
      ide_label: null,
    });
    assert.ok(!result.model_verified);
    assert.ok(!result.ide_verified);
    assert.equal(result.confidence, "none");
  });

  it("verifies model from user_agent header", () => {
    const result = verifyAgentFingerprint("claude-sonnet-4", "cursor", {
      user_agent: "cursor/0.45 claude-sonnet-4",
      ide_label: "Cursor",
    });
    assert.ok(result.model_verified);
    assert.equal(result.model_match_source, "user_agent");
    assert.ok(result.ide_verified);
    assert.equal(result.confidence, "high");
  });

  it("verifies IDE from actor_label fallback", () => {
    const result = verifyAgentFingerprint("claude-haiku-3-5", "antigravity", {
      actor_label: "Haiku Bot | test's agent | Antigravity",
    });
    assert.ok(result.ide_verified);
    assert.equal(result.ide_match_source, "actor_label");
    assert.ok(result.model_verified); // "haiku" in actor_label
    assert.equal(result.model_match_source, "actor_label");
  });

  it("handles null/undefined signals gracefully", () => {
    const result = verifyAgentFingerprint("claude-opus-4", "codex", {});
    assert.ok(!result.model_verified);
    assert.ok(!result.ide_verified);
    assert.equal(result.confidence, "none");
  });

  it("case insensitive matching", () => {
    const result = verifyAgentFingerprint("gpt-4-1", "windsurf", {
      actor_label: "GPT-4.1 Helper",
      ide_label: "WINDSURF",
    });
    assert.ok(result.model_verified);
    assert.ok(result.ide_verified);
    assert.equal(result.confidence, "high");
  });
});

describe("isKnownIdeLabel", () => {
  it("recognizes known IDEs", () => {
    assert.ok(isKnownIdeLabel("antigravity"));
    assert.ok(isKnownIdeLabel("cursor"));
    assert.ok(isKnownIdeLabel("codex"));
    assert.ok(isKnownIdeLabel("claude-code"));
    assert.ok(isKnownIdeLabel("windsurf"));
  });

  it("rejects unknown IDEs", () => {
    assert.ok(!isKnownIdeLabel("vscode"));
    assert.ok(!isKnownIdeLabel("jetbrains"));
    assert.ok(!isKnownIdeLabel(""));
  });
});

describe("isKnownModelFingerprint", () => {
  it("recognizes known models", () => {
    assert.ok(isKnownModelFingerprint("claude-opus-4-6"));
    assert.ok(isKnownModelFingerprint("claude-sonnet-4"));
    assert.ok(isKnownModelFingerprint("gpt-4o"));
    assert.ok(isKnownModelFingerprint("o3"));
    assert.ok(isKnownModelFingerprint("gemini-2-5-pro"));
  });

  it("rejects unknown models", () => {
    assert.ok(!isKnownModelFingerprint("gpt-5-ultra"));
    assert.ok(!isKnownModelFingerprint(""));
  });
});
