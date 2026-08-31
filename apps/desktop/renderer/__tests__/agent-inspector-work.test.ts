import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import type { RetainedExecutionDetail } from "../../shared/execution-protocol";
import {
  agentInspectorWorkArtifacts,
  defaultAgentInspectorWorkSource,
  describeAgentInspectorUncertainEffect,
  describeRecordedOperation,
  humanizeRecordedTurn,
  humanizeAgentInspectorReceiptState,
  humanizeAgentInspectorTimeline,
  isCurrentAgentInspectorWorkResponse,
} from "../src/domain/agent-inspector-work";

test("work detail source selection uses exact active source before bounded recency", () => {
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: "active" } } } as any, { items: [{ source_message_id: "newest" }] }), "active");
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: null } } } as any, { items: [{ source_message_id: "newest" }] }), "newest");
});

test("recorded execution renders partial evidence without changing the work receipt or implying live status", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorWork.vue")).default;
    const operation = { executionId: "op-1", operation: "command" as const, outcome: "failed" as const, startObserved: true, outputBytes: 120, sideEffects: "possible" as const, exitCode: 1, signalNumber: null };
    const execution: RetainedExecutionDetail = { availability: "available", evidenceIncomplete: true, truncated: true, turns: [
      { turnId: "turn-1", state: "terminal", outcome: "completed", operations: [operation, { ...operation, executionId: "op-2", outcome: null, startObserved: false, exitCode: null }] },
    ] };
    const render = (recorded_execution?: RetainedExecutionDetail) => renderToString(createSSRApp(component, {
      resource: { status: "ready", error: null, sourceMessageId: "msg-1", detail: { availability: "available", items: [], uncertain_effects: [], timeline: [], source_message: { sender: "Owner", text: "Check the project" }, receipt: { state: "acknowledged" }, recorded_execution } },
      selectedSourceMessageId: "msg-1", tasks: [], artifacts: [],
    }));
    const html = await render(execution);
    assert.match(html, /Reply published/);
    assert.match(html, /Saved observations, not live status/);
    assert.match(html, /not a complete account/);
    assert.match(html, /bounded selection/);
    assert.match(html, /<details[^>]*open/);
    assert.match(html, /Provider turn completed/);
    assert.match(html, /Command · Failed/);
    assert.match(html, /Exit code 1 · 120 bytes of output recorded · Side effects possible/);
    assert.match(html, /Command · No finish recorded/);
    assert.match(html, /Start was not recorded/);
    assert.doesNotMatch(html, /spinner|Running a command/);
    assert.match(await render({ availability: "not_captured" }), /does not mean the agent did no work/);
    assert.match(await render({ availability: "unavailable" }), /Delivery receipts are still available/);
    assert.match(await render(), /supervisor does not provide recorded execution/);
    assert.match(await render({ ...execution, turns: [] }), /No individual turns could be verified/);
    const bounded = await render({ ...execution, truncated: true, turns: [execution.turns[0]!, { ...execution.turns[0]!, turnId: "omitted-operations", operations: [] }] });
    assert.match(bounded, /0 operations shown/);
    assert.match(bounded, /No individual operations are included/);
    assert.doesNotMatch(bounded, /No individual operations were recorded/);
    for (const [outcome, label] of [["denied_before_start", "Denied before starting"], ["cancelled_before_start", "Cancelled before starting"], ["interrupted_after_start", "Interrupted after starting"], ["lost_after_start", "Outcome lost after starting"]] as const) {
      assert.match(describeRecordedOperation({ ...operation, outcome }).title, new RegExp(label));
    }
    assert.equal(humanizeRecordedTurn({ ...execution.turns[0]!, state: "active", outcome: null }), "No turn finish recorded");
    assert.equal(humanizeRecordedTurn({ ...execution.turns[0]!, state: "lost", outcome: null }), "Provider turn lost");
  } finally { await vite.close(); }
});

test("work response and artifact joins are exact durable identifiers", () => {
  const detail = { availability: "available", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: "source_a", source_message: { id: "source_a" } } as any;
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_a", "source_a"), true);
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_b", "source_a"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_a", "source_b"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse({ ...detail, requested_source_message_id: "source_b" }, "agent_a", "room_a", "source_a"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse({ availability: "pruned", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: "source_pruned", source_message: null } as any, "agent_a", "room_a", "source_pruned"), true);
  assert.equal(isCurrentAgentInspectorWorkResponse({ availability: "not_loaded", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: null, source_message: null } as any, "agent_a", "room_a", null), true);
  const artifacts = agentInspectorWorkArtifacts([{ id: "task_a" }], [
    { identityKey: "a", linkedTaskIds: ["task_a"], updatedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z", kind: "branch", provider: "git", source: "manual", roomId: "room_a", artifactId: null, artifactNumber: null, title: "Exact", url: null, ref: null, state: null, detail: null },
    { identityKey: "b", linkedTaskIds: ["task_b"], updatedAt: "2026-01-02T00:00:00.000Z", firstSeenAt: "2026-01-02T00:00:00.000Z", kind: "branch", provider: "git", source: "manual", roomId: "room_a", artifactId: null, artifactNumber: null, title: "Different", url: null, ref: null, state: null, detail: null },
  ] as any);
  assert.deepEqual(artifacts.map((item) => item.title), ["Exact"]);
});

test("work labels present human language instead of raw causal enums", () => {
  assert.equal(humanizeAgentInspectorReceiptState("acknowledged"), "Reply published");
  assert.equal(humanizeAgentInspectorReceiptState("acknowledged_failed"), "Work did not finish");
  assert.equal(
    humanizeAgentInspectorReceiptState("acknowledged_no_reply", "upgrade_authority_unavailable"),
    "Retired during a safety upgrade",
  );
  assert.match(describeAgentInspectorUncertainEffect("send_message"), /may have completed.*verify external state/i);
  assert.equal(humanizeAgentInspectorTimeline({ phase: "turn_started" } as any), "Work started");
});

test("shell keeps work loading dark, fenced, stale-safe, and routed through canonical reveal", () => {
  const shell = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  const surface = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  const work = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorWork.vue", import.meta.url)), "utf8");
  assert.doesNotMatch(shell, /agentInspectorFoundationEnabled/);
  assert.match(shell, /capabilities\.agentInspectorDetail/);
  assert.match(shell, /agentInspectorWorkRequestStillCurrent/);
  assert.match(shell, /agentInspectorWorkResource\.value = \{ status: "loading", detail: null, error: null, sourceMessageId \}/);
  assert.match(shell, /void loadAgentInspectorWorkDetail\(sourceMessageId, true\)/);
  assert.match(shell, /status: previous \? "refreshing" : "loading", detail: previous/);
  assert.match(shell, /activeTab\.value = "chat"[\s\S]{0,120}revealRoomMessage\(canonicalMessageId\)/);
  assert.match(surface, /role="tablist"/);
  assert.match(surface, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(work, /Older detail was removed by local retention/);
  assert.match(work, /did not create retained activated work/);
  assert.match(work, /mutating tool outcomes need verification/i);
  assert.match(work, /A safety upgrade retired this legacy turn/);
  assert.match(work, /Open reply in Chat/);
});
