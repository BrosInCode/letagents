import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT,
  AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT,
  agentInspectorDiagnosticsReport,
  projectAgentInspectorDiagnostics,
  sanitizeAgentInspectorDiagnosticsValue,
} from "../src/domain/agent-inspector-diagnostics";

const CANARY = "super-secret-canary-value";

function projection(activity: unknown[] = []): any {
  return { entry: {
    id: "supervised_1", roomId: "room_1", agentKey: "emmymay/gardensignal", provider: "codex", model: "gpt-5.6", createdAt: "2026-07-23T10:00:00.000Z",
    desiredState: "running", observedState: "working", condition: "none", lastError: `Authorization: Bearer ${CANARY}`,
    agentSessionBindingState: "active", providerPid: 712, executionGenerationId: "generation_1", restartCount: 1,
    workplaceLiveness: { state: "healthy" }, nativeLiveness: { state: "healthy" },
    lastTerminal: { output: CANARY }, activity, roomAgentState: { connection: { state: "connected" }, ingress: { state: "observing" }, inbox: { state: "empty" }, turn: { state: "idle" } }, turnControl: null,
  } };
}

function event(sequence: number, payload: unknown): any {
  return { observedAt: `2026-07-23T10:00:${String(sequence).padStart(2, "0")}.000Z`, sequence, provider: "codex", kind: "notification", method: "item/started", summary: `Progress ${sequence}`, status: "working", payload, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: `durable://${CANARY}` };
}

test("diagnostics recursively redacts secret values and caps cyclic/deep/large payloads", () => {
  const cyclic: Record<string, unknown> = { token: CANARY, nested: { password: CANARY, note: "safe" }, long: "x".repeat(2_000) };
  cyclic.self = cyclic;
  const value = sanitizeAgentInspectorDiagnosticsValue(cyclic);
  const text = JSON.stringify(value.value);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[CIRCULAR\]/);
  assert.doesNotMatch(text, new RegExp(CANARY));
  assert.equal(value.redacted, true);
  assert.equal(value.truncated, true);
});

test("diagnostics redacts secrets embedded in arbitrary string leaves", () => {
  const cases = [
    `{"authorization":"Bearer ${CANARY}"}`,
    `"{\\"authorization\\":\\"Bearer ${CANARY}\\"}"`,
    `authorization: "Bearer ${CANARY}"`,
    `password='${CANARY}'`,
    `OPENAI_API_KEY="${CANARY}"`,
    `AWS_SECRET_ACCESS_KEY=${CANARY}`,
    `NPM_TOKEN='${CANARY}'`,
    `SLACK_BOT_TOKEN: "${CANARY}"`,
    `export SENTRY_AUTH_TOKEN=${CANARY}`,
    `{"CLOUDFLARE_API_TOKEN":"${CANARY}"}`,
    `"{\\"GITHUB_APP_PRIVATE_KEY\\":\\"${CANARY}\\"}"`,
    `STRIPE_SECRET_KEY=\\"${CANARY}\\"`,
    `Cookie: session=${CANARY}; theme=dark`,
    `https://user:${CANARY}@example.com/private`,
    `Bearer ${CANARY}`,
    `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----`,
    `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${CANARY}\n-----END ENCRYPTED PRIVATE KEY-----`,
    `-----BEGIN RSA PRIVATE KEY-----\n${CANARY}\n-----END RSA PRIVATE KEY-----`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${CANARY}\n-----END OPENSSH PRIVATE KEY-----`,
    `-----BEGIN EC PRIVATE KEY-----\n${CANARY}\n-----END EC PRIVATE KEY-----`,
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${CANARY}\n-----END PGP PRIVATE KEY BLOCK-----`,
  ];
  for (const hostile of cases) {
    const result = sanitizeAgentInspectorDiagnosticsValue(hostile);
    assert.doesNotMatch(JSON.stringify(result.value), new RegExp(CANARY), hostile);
    assert.equal(result.redacted, true, hostile);
  }
});

test("encrypted PKCS#8 is redacted from escaped string leaves and copied reports", () => {
  const encryptedPrivateKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${CANARY}\n-----END ENCRYPTED PRIVATE KEY-----`;
  const escapedPrivateKey = JSON.stringify(encryptedPrivateKey);
  const leaf = sanitizeAgentInspectorDiagnosticsValue(escapedPrivateKey);
  assert.equal(leaf.redacted, true);
  assert.doesNotMatch(JSON.stringify(leaf.value), new RegExp(CANARY));

  const source = projection([{ ...event(1, escapedPrivateKey), summary: escapedPrivateKey }]);
  source.entry.lastError = escapedPrivateKey;
  const result = projectAgentInspectorDiagnostics(source);
  assert.doesNotMatch(result.activity[0]?.summary ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.payloadPreview ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.recovery.lastError ?? "", new RegExp(CANARY));
  assert.doesNotMatch(agentInspectorDiagnosticsReport(result), new RegExp(CANARY));
});

test("diagnostics preserves benign identifier near-misses", () => {
  const benign = {
    TOKEN_COUNT: CANARY,
    AUTH_STATUS: CANARY,
    COOKIE_POLICY: CANARY,
    ACCESS_KEY_ID: CANARY,
    PUBLIC_KEY: CANARY,
    SSH_PUBLIC_KEY: CANARY,
    CLIENT_ID: CANARY,
    COMPASS: CANARY,
    SECRETARY: CANARY,
    KEYBOARD_LAYOUT: CANARY,
  };
  const structured = sanitizeAgentInspectorDiagnosticsValue(benign);
  assert.equal(structured.redacted, false);
  assert.equal(JSON.stringify(structured.value).match(new RegExp(CANARY, "g"))?.length, Object.keys(benign).length);
  const text = sanitizeAgentInspectorDiagnosticsValue("TOKEN_COUNT=7 AUTH_STATUS=ready COMPASS=north PUBLIC_KEY=visible");
  assert.equal(text.redacted, false);
  assert.equal(text.value, "TOKEN_COUNT=7 AUTH_STATUS=ready COMPASS=north PUBLIC_KEY=visible");
});

test("diagnostics keeps only newest bounded activity and never exposes raw terminal or durable references", () => {
  const events = Array.from({ length: AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT + 5 }, (_, index) => event(index + 1, { authorization: `Bearer ${CANARY}`, durablePayloadRef: `ref:${CANARY}` }));
  const result = projectAgentInspectorDiagnostics(projection(events));
  assert.equal(result.activity.length, AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT);
  assert.equal(result.activity[0]?.sequence, events.length);
  assert.equal(result.activityTruncated, true);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, new RegExp(CANARY));
  assert.doesNotMatch(text, /durable:\/\//);
  assert.equal(result.activity[0]?.redacted, true);
});

test("projected summaries, last errors, and copied reports cannot leak string-encoded credentials", () => {
  const source = projection([
    {
      ...event(1, `{"SLACK_BOT_TOKEN":"${CANARY}"}`),
      summary: `NPM_TOKEN="${CANARY}"`,
    },
  ]);
  source.entry.lastError = `"{\\"AWS_SECRET_ACCESS_KEY\\":\\"${CANARY}\\"}"`;
  const result = projectAgentInspectorDiagnostics(source);
  assert.doesNotMatch(result.recovery.lastError ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.summary ?? "", new RegExp(CANARY));
  assert.doesNotMatch(result.activity[0]?.payloadPreview ?? "", new RegExp(CANARY));
  assert.doesNotMatch(agentInspectorDiagnosticsReport(result), new RegExp(CANARY));
});

test("copy report is allowlisted and bounded even when every event is hostile", () => {
  const events = Array.from({ length: AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT }, (_, index) => event(index + 1, { secret: CANARY, huge: "x".repeat(20_000) }));
  const report = agentInspectorDiagnosticsReport(projectAgentInspectorDiagnostics(projection(events)));
  assert.ok(report.length <= AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT);
  assert.match(report, /letagents-agent-diagnostics-v1/);
  assert.doesNotMatch(report, new RegExp(CANARY));
  assert.doesNotMatch(report, /lastTerminal|durablePayloadRef/);
});

test("the diagnostics tab is lazy and participates in roving Home/End tab behavior", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  assert.match(source, /defineAsyncComponent\(\(\) => import\("\.\/AgentInspectorDiagnostics\.vue"\)\)/);
  assert.match(source, /v-else id="agent-inspector-diagnostics-panel"/);
  assert.match(source, /<button id="agent-inspector-diagnostics-tab"/);
  // The Live tab sits between Overview and Work; Diagnostics stays the End target.
  assert.match(source, /\["overview", "live", "work", "settings", "diagnostics"\]/);
  assert.match(source, /event\.key === 'End' \? 'diagnostics'/);
});

test("the high-frequency diagnostics copy action has no transform motion", () => {
  const styles = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/agent-inspector.css", import.meta.url)), "utf8");
  assert.doesNotMatch(styles, /\.agent-inspector-diagnostics-copy[^{}]*\{[^}]*transition:[^;}]*transform/s);
  assert.doesNotMatch(styles, /\.agent-inspector-diagnostics-copy:active\s*\{[^}]*transform/s);
});
