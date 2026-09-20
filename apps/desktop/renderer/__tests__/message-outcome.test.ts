import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import { messageInterventionLabel, messageOutcomeTarget, messageOutcomeDuration, messageTriggerLabel } from "../src/domain/message-outcome";
import { resolveSupervisorEntryId } from "../src/domain/agent-inspector-identity";

test("message activity targets exact local agent identity and preserves the triggering message", () => {
  const entry = { id: "agent-1", agentKey: "owner/stone", agentSessionId: "session-1", roomId: "room", provider: "codex" } as any;
  const receipt = { agentKey: "owner/stone", actorLabel: "Stone" } as any;
  const target = messageOutcomeTarget(receipt, "human-message", "room", [entry])!;
  assert.equal(target.workSourceMessageId, "human-message");
  assert.equal(target.messageId, null, "a human source must not resolve as an agent-published message");
  assert.deepEqual(resolveSupervisorEntryId([entry], target), { state: "matched", entryId: "agent-1" });
  assert.equal(messageOutcomeTarget(receipt, "human-message", "different-room", [entry]), null);
  assert.equal(messageOutcomeTarget(receipt, "human-message", "room", [entry, { ...entry, id: "ambiguous" }]), null);
  assert.equal(messageOutcomeTarget({ ...receipt, agentKey: "Stone" }, "human-message", "room", [entry]), null);
  assert.equal(messageOutcomeTarget({ ...receipt, agentKey: "Stone" }, "human-message", "room", [{ ...entry, agentKey: "Stone" }]), null);
  assert.equal(messageOutcomeTarget(receipt, "", "room", [entry]), null);
});

test("duration requires both valid work boundaries and unknown triggers remain unknown", () => {
  const start = { phase: "turn_started", observedAt: "2026-09-20T09:00:00.000Z" };
  const finish = { phase: "turn_finished", observedAt: "2026-09-20T09:03:18.000Z" };
  const duration = (timeline: any[]) => messageOutcomeDuration({ timeline } as any);
  assert.equal(duration([start, finish]), "3m 18s");
  assert.equal(duration([start]), null);
  assert.equal(duration([finish]), null);
  assert.equal(duration([start, { ...finish, observedAt: "invalid" }]), null);
  assert.equal(duration([start, { ...finish, observedAt: "2026-09-20T08:59:00.000Z" }]), null);
  assert.equal(messageTriggerLabel({ reason: "mention" }), "Mentioned directly");
  assert.equal(messageTriggerLabel({ reason: "unrecognized" }), "Room delivery requested a response");
});

test("interventions distinguish provider delivery, uncertainty and explicit operator resolution", () => {
  const intervention = { actionId: "control", recordedAt: "2026-09-20T09:00:00.000Z", hasCorrection: true,
    correctionText: "Keep the API unchanged", strategy: "native" as const, operatorResolution: null,
    status: "completed" as const, interrupted: false, resumed: false };
  assert.equal(messageInterventionLabel(intervention), "Correction delivered");
  assert.equal(messageInterventionLabel({ ...intervention, status: "uncertain" }), "Delivery is uncertain");
  assert.equal(messageInterventionLabel({ ...intervention, operatorResolution: "not_applied" }), "Marked as not applied");
  assert.equal(messageInterventionLabel({ ...intervention, hasCorrection: false, interrupted: true }), "Turn stopped");
});

test("trajectory renders captured text safely and distinguishes missing, queued and completed evidence", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom",
    logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorWork.vue")).default;
    const detail = { availability: "available", items: [], uncertain_effects: [], timeline: [],
      source_message: { id: "msg-1", sender: "Emmy", text: "Fix auth", activation: { reason: "mention" } },
      receipt: { state: "pending" }, recorded_execution: { availability: "not_captured" } };
    const render = (patch = {}, resource = {}) => renderToString(createSSRApp(component, {
      resource: { status: "ready", sourceMessageId: "msg-1", error: null, detail: { ...detail, ...patch }, ...resource },
      selectedSourceMessageId: "msg-1", tasks: [{ id: "unrelated", title: "Other work", status: "in_progress" }], artifacts: [],
    }));
    const old = await render();
    assert.match(old, /Context wasn’t captured/);
    assert.match(old, /This message is queued/);
    assert.match(old, /not verified outcomes of the selected message/);
    assert.doesNotMatch(old, /View captured context/);
    const captured = await render({ prepared_context: {
      preparedAt: "2026-09-20T09:00:00.000Z", totalMessages: 1, omittedMessages: 0,
      messages: [{ id: "msg-0", sender: "Emmy", text: "<script>bad()<\/script>", truncated: true }],
    }, receipt: { state: "acknowledged" }, publication: { canonical_message_id: "reply-1" },
    terminal: { normalized_text: "The agent reports the fix is ready." } });
    assert.match(captured, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(captured, /<script>bad/);
    assert.match(captured, /Text shortened in this snapshot/);
    assert.match(captured, /Open reply in Chat/);
    assert.match(captured, /Reply published/);
    assert.match(await render({}, { status: "loading", detail: null }), /aria-busy="true"/);
    assert.match(await render({}, { status: "error", detail: null, error: "Service unavailable" }), /Service unavailable/);
    assert.match(await render({ availability: "pruned" }), /Older detail was removed/);
  } finally { await vite.close(); }
});
