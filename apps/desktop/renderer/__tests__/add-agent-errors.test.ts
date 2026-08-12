import assert from "node:assert/strict";
import test from "node:test";
import {
  addAgentErrorDetail,
  contextualAddAgentError,
} from "../src/components/desktop/content/add-agent/add-agent-errors";

test("Add Agent errors remove Electron transport noise and redact credentials", () => {
  const detail = addAgentErrorDetail(
    new Error("Error invoking remote method 'desktop:supervisor:list-agents': Error: authorization=Bearer-secret token abc123 socket closed"),
    "Fallback",
  );

  assert.doesNotMatch(detail, /invoking remote method/i);
  assert.doesNotMatch(detail, /Bearer-secret|abc123/);
  assert.match(detail, /authorization=\[redacted\]/i);
  assert.match(detail, /token \[redacted\]/i);
  assert.match(detail, /socket closed/);
});

test("Add Agent errors always retain an operation context and safe fallback", () => {
  assert.equal(
    contextualAddAgentError("Couldn't stop Codex", null, "The agent may still be running."),
    "Couldn't stop Codex: The agent may still be running.",
  );
});

test("Add Agent errors redact standard auth headers, provider keys, and URL userinfo", () => {
  const detail = addAgentErrorDetail(
    "Authorization: Bearer secret123 sk-proj-secret123 https://user:password@example.com failed",
    "Fallback",
  );

  assert.doesNotMatch(detail, /secret123|user:password/);
  assert.equal(
    detail,
    "Authorization:[redacted] [redacted] https://[redacted]@example.com failed",
  );
});

test("Add Agent errors redact environment tokens and quoted authorization values", () => {
  const detail = addAgentErrorDetail(
    'LETAGENTS_TOKEN=room-secret-123 GITHUB_TOKEN=ghp_123456 Authorization: "Bearer secret123" failed',
    "Fallback",
  );

  assert.doesNotMatch(detail, /room-secret|ghp_|secret123/);
  assert.equal(
    detail,
    "LETAGENTS_TOKEN=[redacted] GITHUB_TOKEN=[redacted] Authorization:[redacted] failed",
  );
});

test("Add Agent errors redact standalone provider credentials and Basic auth", () => {
  const detail = addAgentErrorDetail(
    `provider rejected ghp_${"A".repeat(36)} github_pat_${"A".repeat(24)} AKIA${"A".repeat(16)} Basic dXNlcjpwYXNzd29yZA==`,
    "Fallback",
  );

  assert.doesNotMatch(detail, /ghp_|github_pat_|AKIA|dXNlcj/);
  assert.equal(detail, "provider rejected [redacted] [redacted] [redacted] Basic [redacted]");
});
