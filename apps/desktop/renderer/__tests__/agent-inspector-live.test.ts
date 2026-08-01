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

test("fold preserves first-appearance order across interleaved kinds", () => {
  const transcript = foldAgentStreamEvents([
    event({ sequence: 1, method: "reasoning/summaryTextDelta", payload: { partId: "r1", delta: "plan" } }),
    event({ sequence: 2, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "running" } }),
    event({ sequence: 3, method: "item/agentMessage/delta", payload: { partId: "m1", delta: "done" } }),
  ]);
  assert.deepEqual(transcript.items.map((item) => item.kind), ["reasoning", "tool", "message"]);
});

test("the inspector wires a lazily-subscribed Live tab that starts and stops with focus", () => {
  const surface = source("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
  const host = source("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue");
  const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");

  // A 5th tab that emits live-selected on open (the lazy-subscribe signal).
  assert.match(surface, /id="agent-inspector-live-tab"/);
  assert.match(surface, /if \(tab === "live"\) emit\("live-selected"\)/);
  assert.match(surface, /AgentInspectorLive/);
  // Host forwards the emit on both wide and compact bindings.
  assert.equal((host.match(/@live-selected="emit\('live-selected'\)"/g) ?? []).length, 2);
  // Shell subscribes on open and tears the subscription down on close/switch.
  assert.match(shell, /@live-selected="openAgentInspectorLive"/);
  assert.match(shell, /watchAgentStream\?\.\(projection\.entryId\)/);
  assert.match(shell, /watchAgentStream\?\.\(null\)/);
  assert.match(shell, /onAgentStream\?\.\(\(batch\)/);
});
