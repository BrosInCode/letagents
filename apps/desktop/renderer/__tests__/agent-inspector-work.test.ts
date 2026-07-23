import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentInspectorWorkArtifacts,
  defaultAgentInspectorWorkSource,
  humanizeAgentInspectorReceiptState,
  humanizeAgentInspectorTimeline,
  isCurrentAgentInspectorWorkResponse,
} from "../src/domain/agent-inspector-work";

test("work detail source selection uses exact active source before bounded recency", () => {
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: "active" } } } as any, { items: [{ source_message_id: "newest" }] }), "active");
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: null } } } as any, { items: [{ source_message_id: "newest" }] }), "newest");
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
  assert.equal(humanizeAgentInspectorTimeline({ phase: "turn_started" } as any), "Work started");
});

test("shell keeps work loading dark, fenced, stale-safe, and routed through canonical reveal", () => {
  const shell = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  const surface = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  const work = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorWork.vue", import.meta.url)), "utf8");
  assert.match(shell, /if \(!agentInspectorFoundationEnabled\) return;/);
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
  assert.match(work, /Open reply in Chat/);
});
