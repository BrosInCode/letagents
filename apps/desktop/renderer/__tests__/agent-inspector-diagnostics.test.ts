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

test("copy report is allowlisted and bounded even when every event is hostile", () => {
  const events = Array.from({ length: AGENT_INSPECTOR_DIAGNOSTICS_EVENT_LIMIT }, (_, index) => event(index + 1, { secret: CANARY, huge: "x".repeat(20_000) }));
  const report = agentInspectorDiagnosticsReport(projectAgentInspectorDiagnostics(projection(events)));
  assert.ok(report.length <= AGENT_INSPECTOR_DIAGNOSTICS_REPORT_LIMIT);
  assert.match(report, /letagents-agent-diagnostics-v1/);
  assert.doesNotMatch(report, new RegExp(CANARY));
  assert.doesNotMatch(report, /lastTerminal|durablePayloadRef/);
});

test("the fourth diagnostics tab is lazy and participates in roving Home/End tab behavior", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  assert.match(source, /defineAsyncComponent\(\(\) => import\("\.\/AgentInspectorDiagnostics\.vue"\)\)/);
  assert.match(source, /v-else id="agent-inspector-diagnostics-panel"/);
  assert.match(source, /<button id="agent-inspector-diagnostics-tab"/);
  assert.match(source, /\["overview", "work", "settings", "diagnostics"\]/);
  assert.match(source, /event\.key === 'End' \? 'diagnostics'/);
});
