import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { foldAgentStreamEvents } from "../src/domain/agent-inspector-live";
import type { DesktopAgentStreamEvent } from "../../electron/ipc-types";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function event(partial: Partial<DesktopAgentStreamEvent> & { sequence: number }): DesktopAgentStreamEvent {
  return {
    observedAt: "2026-07-31T00:00:00.000Z",
    kind: "text_delta",
    method: "item/agentMessage/delta",
    summary: null,
    payload: null,
    ...partial,
  };
}

test("fold concatenates reasoning and assistant-text deltas per part", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, method: "reasoning/summaryTextDelta", summary: "let me ", payload: { partId: "r1", delta: "let me " } }),
    event({ sequence: 2, method: "reasoning/summaryTextDelta", summary: "think", payload: { partId: "r1", delta: "think" } }),
    event({ sequence: 3, method: "item/agentMessage/delta", payload: { partId: "m1", delta: "Hello " } }),
    event({ sequence: 4, method: "item/agentMessage/delta", payload: { partId: "m1", delta: "there" } }),
  ]);
  assert.deepEqual(transcript.items, [
    { kind: "reasoning", id: "r1", text: "let me think" },
    { kind: "message", id: "m1", text: "Hello there" },
  ]);
});

test("fold renders Codex's verbatim readable reasoning summary method", () => {
  const transcript = foldAgentStreamEvents([
    event({
      sequence: 1,
      method: "item/reasoning/summaryTextDelta",
      summary: "Checking the room",
      payload: { itemId: "reasoning-1", summaryIndex: 0, delta: "Checking the room " },
    }),
    event({
      sequence: 2,
      method: "item/reasoning/summaryTextDelta",
      summary: "Checking the room boundary",
      payload: { itemId: "reasoning-1", summaryIndex: 0, delta: "boundary" },
    }),
  ]);
  assert.deepEqual(transcript.items, [{
    kind: "reasoning",
    id: "reasoning-1:0",
    text: "Checking the room boundary",
  }]);
});

test("fold ignores the useless summary fallback on assistant-text deltas", () => {
  // Assistant-text deltas carry real text only in payload.delta; the summary is
  // a "provider · method" fallback that must never be rendered.
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, method: "item/agentMessage/delta", summary: "open-model · item/agentMessage/delta", payload: { partId: "m1", delta: "Hi" } }),
  ]);
  assert.deepEqual(transcript.items, [{ kind: "message", id: "m1", text: "Hi" }]);
});

test("fold upserts a tool card by call id across status transitions", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "running", input: { command: "ls" } } }),
    event({ sequence: 2, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "completed", input: { command: "ls" }, output: "a\nb" } }),
  ], true);
  assert.equal(transcript.items.length, 1, "the same call collapses to one upserted card");
  const tool = transcript.items[0]!;
  assert.equal(tool.kind, "tool");
  assert.equal(tool.kind === "tool" && tool.status, "completed");
  assert.equal(tool.kind === "tool" && tool.output, "a\nb");
  assert.equal(transcript.ended, true);
});

test("fold ignores provider-native tool evidence and preserves started metadata on canonical completion", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, kind: "tool_lifecycle", method: "user", payload: { message: { role: "user" } } }),
    event({ sequence: 2, kind: "tool_lifecycle", method: "tool_call/started", payload: { call_id: "raw", tool_call: {} } }),
    event({ sequence: 3, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "readToolCall", status: "running", input: { path: "README.md" } } }),
    event({ sequence: 4, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "readToolCall", status: "completed", output: { totalLines: 54 } } }),
  ]);
  assert.deepEqual(transcript.items, [{
    kind: "tool", id: "c1", tool: "readToolCall", status: "completed",
    input: { path: "README.md" }, output: { totalLines: 54 }, error: null,
  }]);
});

test("fold preserves first-appearance order across interleaved kinds", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, method: "reasoning/summaryTextDelta", payload: { partId: "r1", delta: "plan" } }),
    event({ sequence: 2, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "running" } }),
    event({ sequence: 3, method: "item/agentMessage/delta", payload: { partId: "m1", delta: "done" } }),
  ]);
  assert.deepEqual(transcript.items.map((item) => item.kind), ["reasoning", "tool", "message"]);
});

test("separate Cursor assistant events preserve every content block in wire order", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, method: "item/agentMessage/delta", payload: { partId: "cursor:t:assistant:event-1", delta: "AB" } }),
    event({ sequence: 2, method: "item/agentMessage/delta", payload: { partId: "cursor:t:assistant:event-2", delta: "C" } }),
  ]);
  assert.deepEqual(transcript.items, [
    { kind: "message", id: "cursor:t:assistant:event-1", text: "AB" },
    { kind: "message", id: "cursor:t:assistant:event-2", text: "C" },
  ]);
});

test("a delayed running tool replay cannot regress a terminal card", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "completed", output: "done" } }),
    event({ sequence: 2, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "running" } }),
  ]);
  const item = transcript.items[0];
  assert.equal(item?.kind === "tool" && item.status, "completed");
  assert.equal(item?.kind === "tool" && item.output, "done");
});

test("an unmatched running tool becomes interrupted when the live feed ends", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "running" } }),
  ], true);
  assert.equal(transcript.items[0]?.kind === "tool" && transcript.items[0].status, "interrupted");
});

test("the inspector wires a lazily-subscribed Live tab that starts and stops with focus", () => {
  const surface = source("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
  const host = source("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue");
  const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");

  // A 5th tab that emits live-selected on open (the lazy-subscribe signal).
  assert.match(surface, /id="agent-inspector-live-tab"/);
  assert.match(surface, /if \(tab === "live"\) emit\("live-selected"\)/);
  assert.match(surface, /selectedTab\.value === "live" && tab !== "live"/);
  assert.match(surface, /AgentInspectorLive/);
  // Host forwards the emit on both wide and compact bindings.
  assert.equal((host.match(/@live-selected="emit\('live-selected'\)"/g) ?? []).length, 2);
  assert.equal((host.match(/@live-dismissed="emit\('live-dismissed'\)"/g) ?? []).length, 2);
  // Shell subscribes on open and tears the subscription down on close/switch.
  assert.match(shell, /@live-selected="openAgentInspectorLive"/);
  assert.match(shell, /watchAgentStream\?\.\(projection\.entryId\)/);
  assert.match(shell, /watchAgentStream\?\.\(null\)/);
  assert.match(shell, /@live-dismissed="stopAgentInspectorLive"/);
  assert.match(shell, /onAgentStream\?\.\(\(batch\)/);
  assert.match(shell, /priorEvents\.length \+ batch\.events\.length - AGENT_LIVE_FEED_LIMIT/,
    "continuous local buffer eviction is counted as a visible gap");
});
