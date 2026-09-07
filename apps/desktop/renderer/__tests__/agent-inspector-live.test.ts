import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import { canPresentCurrentAgentStream, currentAgentRequest } from "../src/domain/agent-inspector-live-trace";

import {
  agentLiveAvailability,
  describeLiveToolCall,
  foldAgentStreamEvents,
  formatLiveWorkDuration,
  scopeAgentStreamEventsToWork,
} from "../src/domain/agent-inspector-live";
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

test("Codex commentary keeps native message blocks and turn identities separate", () => {
  const transcript = foldAgentStreamEvents([
    event({sequence:1,payload:{itemId:"one",threadId:"thread",turnId:"first",delta:"Checking"}}),
    event({sequence:2,payload:{itemId:"two",threadId:"thread",turnId:"first",delta:"Result"}}),
    event({sequence:3,payload:{itemId:"one",threadId:"thread",turnId:"first",delta:" files"}}),
    event({sequence:4,payload:{itemId:"one",threadId:"thread",turnId:"second",delta:"New turn"}}),
  ]);
  assert.deepEqual(transcript.items.map(item=>item.kind === "message" ? item.text : null), ["Checking files","Result","New turn"]);
});

test("Live keeps captured actions after work finishes and separates them from a new request", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLive.vue")).default;
    const work = { active: false, startedAt: null, state: "idle", freshness: "fresh", agentState: "online", detail: null };
    const resource = { status: "ready", sourceMessageId: "msg_old", error: null, detail: {
      items: [{ source_message_id: "msg_new", sender: "Emmy", text_preview: "Check the tests" }],
    } };
    const events = [
      event({ sequence: 1, observedAt: "2026-09-05T10:00:01Z", payload: { partId: "old", delta: "Previous request finished" } }),
      event({ sequence: 2, observedAt: "2026-09-05T10:01:01Z", kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "read", tool: "readToolCall", status: "pending", input: { path: "package.json" } } }),
      event({ sequence: 3, observedAt: "2026-09-05T10:01:02Z", payload: { partId: "new", delta: "Checking the test configuration" } }),
    ];
    const feed = { events, ended: false, droppedEvents: 0 };
    const render = (overrides: Record<string, unknown> = {}) => renderToString(createSSRApp(component, {
      resource, work, feed, activeSourceMessageId: null, supportsReasoning: false, ...overrides,
    }));
    const idle = await render();
    assert.match(idle, /Previous request finished/);
    assert.match(idle, /Checking the test configuration/);
    assert.match(idle, /Recent actions/);
    assert.match(idle, /No finish recorded/);
    assert.match(idle, /Last update:/);
    assert.doesNotMatch(idle, /Recent work|Recorded actions|No reply needed|Current turn/);

    const activeWork = { ...work, active: true, state: "awaiting_result", agentState: "responding", startedAt: "2026-09-05T10:01:00Z" };
    const active = await render({ work: activeWork, activeSourceMessageId: "msg_new" });
    assert.match(active, /Check the tests/);
    assert.match(active, /Checking the test configuration/);
    assert.doesNotMatch(active, /Previous request finished|Recent actions/);
    assert.match(active.split('class="agent-inspector-live-trigger"')[0], /Requested: Reading a file · package.json/,
      "a pending Claude action remains the current step even when commentary follows it");

    const completedFeed = { ...feed, events: [...events, event({ sequence: 4, observedAt: "2026-09-05T10:01:03Z", kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "read", status: "completed", output: "Three scripts" } })] };
    const finished = await render({ feed: completedFeed });
    assert.match(finished, /Read a file/);
    assert.match(finished, /Completed/);
    assert.match(finished, /Recent actions/);
    assert.doesNotMatch(finished, /No finish recorded/);

    for (const overrides of [{ work: { ...activeWork, startedAt: null }, activeSourceMessageId: "msg_new" }, { work: activeWork }]) {
      const unavailable = await render(overrides);
      assert.match(unavailable, /Current activity unavailable/);
      assert.doesNotMatch(unavailable, /Previous request finished|Checking the test configuration/);
    }
    assert.match(await render({ feed: { ...feed, droppedEvents: 3 } }), /Earlier live updates were omitted/);
    assert.match(await render({ feed: { ...feed, events: [] } }), /No recent actions are available/);
    assert.match(await render({ work: { ...work, freshness: "stale" } }), /Live status unavailable/);
    assert.match(await render({ feed: { ...feed, ended: true } }), /Work stream closed/);
    assert.equal(currentAgentRequest(resource as any, "msg_other"), null);
    assert.equal(canPresentCurrentAgentStream({ active: false, startedAt: activeWork.startedAt, activeSourceMessageId: "msg_new" }), false);
  } finally { await vite.close(); }
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
  assert.equal(transcript.startedAt, "2026-07-31T00:00:00.000Z");
  assert.equal(transcript.lastActivityAt, "2026-07-31T00:00:00.000Z");
});

test("live-work duration copy stays compact and freezes at the last event", () => {
  assert.equal(formatLiveWorkDuration(
    "2026-07-31T00:00:00.000Z",
    null,
    Date.parse("2026-07-31T00:00:09.900Z"),
  ), "9s");
  assert.equal(formatLiveWorkDuration(
    "2026-07-31T00:00:00.000Z",
    "2026-07-31T00:01:12.000Z",
  ), "1m 12s");
  assert.equal(formatLiveWorkDuration(
    "2026-07-31T00:00:00.000Z",
    "2026-07-31T02:04:19.000Z",
  ), "2h 4m");
  assert.equal(formatLiveWorkDuration("not-a-date", null), null);
});

test("live work scopes a persistent provider replay to the durable room turn", () => {
  const prior = event({ sequence: 1, observedAt: "2026-07-31T00:00:01.000Z" });
  const current = event({ sequence: 2, observedAt: "2026-07-31T00:01:01.000Z" });
  assert.deepEqual(scopeAgentStreamEventsToWork([prior, current], {
    active: true,
    startedAt: "2026-07-31T00:01:00.000Z",
  }), [current]);
  assert.deepEqual(scopeAgentStreamEventsToWork([prior, current], {
    active: true,
    startedAt: null,
  }), [], "an active turn without its durable boundary never replays stale work");
  assert.deepEqual(scopeAgentStreamEventsToWork([prior, current], {
    active: false,
    startedAt: null,
  }), [prior, current], "idle inspectors may retain the bounded recent-work history without claiming it is active");
});

test("live availability never presents transitional or unavailable agents as ready", () => {
  const work = (agentState: Parameters<typeof agentLiveAvailability>[0]["agentState"], active = false) => ({
    active,
    freshness: "fresh" as const,
    agentState,
  });
  assert.equal(agentLiveAvailability(work("online"), false), "idle");
  assert.equal(agentLiveAvailability(work("responding", true), false), "active");
  for (const state of ["restoring_conversation", "recovering", "reconnecting", "starting"] as const) {
    assert.equal(agentLiveAvailability(work(state), false), "transitioning");
  }
  assert.equal(agentLiveAvailability(work("retired"), true), "closed", "a closed stream wins over retained agent state");
  assert.equal(agentLiveAvailability({ ...work("responding", true), freshness: "stale" }, false), "stale");
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
    event({ sequence: 3, kind: "tool_lifecycle", method: "item/toolCall/updated", payload: { callID: "c1", tool: "bash", status: "pending" } }),
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

test("describeLiveToolCall unwraps Cursor's mcpToolCall and strips the per-turn server alias", () => {
  const reply = describeLiveToolCall("mcpToolCall", {
    name: "letagents_supervised_c0a7e4ba0ff9289147837706-complete_room_turn",
    args: { outcome: "reply", text: "Today is Sunday, August 9, 2026." },
  }, { status: "completed", output: { result: { content: [{ text: JSON.stringify({ accepted: true }) }] } }, error: null });
  assert.equal(reply.kind, "reply");
  assert.equal(reply.headline, "Replied to the room");
  assert.equal(reply.replyText, "Today is Sunday, August 9, 2026.");
  assert.equal(reply.toolName, "complete_room_turn");
});

test("describeLiveToolCall reads no_reply as a closed turn with no message content", () => {
  const closed = describeLiveToolCall("mcpToolCall", {
    name: "letagents_supervised_ab12cd34ef56-complete_room_turn",
    args: { outcome: "no_reply" },
  }, { status: "completed", output: { accepted: true }, error: null });
  assert.equal(closed.kind, "reply");
  assert.equal(closed.headline, "Closed the turn without a reply");
  assert.equal(closed.replyText, null);
});

test("describeLiveToolCall gives room tools domain sentences with a salient detail", () => {
  const status = describeLiveToolCall("mcpToolCall", {
    name: "letagents_supervised_ab12cd34ef56-post_status",
    args: { status: "Reviewing PR #901 now" },
  });
  assert.equal(status.kind, "action");
  assert.equal(status.headline, "Posted a status update");
  assert.equal(status.detail, "Reviewing PR #901 now");
});

test("complete_room_turn is a room reply only after the daemon accepted it", () => {
  const input = {
    name: "letagents_supervised_ab12cd34ef56-complete_room_turn",
    args: { outcome: "reply", text: "Done." },
  };
  const rejected = describeLiveToolCall("mcpToolCall", input, {
    status: "completed", output: { result: { errorMessage: "Service temporarily unavailable" } }, error: null,
  });
  assert.equal(rejected.kind, "action");
  assert.equal(rejected.headline, "Tried to reply to the room");
  assert.equal(rejected.replyText, null);

  const errored = describeLiveToolCall("mcpToolCall", input, {
    status: "error", output: null, error: "transport failed",
  });
  assert.equal(errored.kind, "action");
  assert.equal(errored.headline, "Tried to reply to the room");
});

test("describeLiveToolCall degrades unknown tools to their bare name, never the transport alias", () => {
  const unknown = describeLiveToolCall("mcpToolCall", {
    name: "letagents_supervised_ab12cd34ef56-register_board_intent",
    args: { description: "claim task_9" },
  });
  assert.equal(unknown.kind, "action");
  assert.equal(unknown.headline, "register_board_intent");
  assert.equal(unknown.detail, "claim task_9");
  const native = describeLiveToolCall("shellToolCall", { command: "npm test" });
  assert.equal(native.headline, "Ran a shell command");
  assert.equal(native.detail, "npm test");
  const opaque = describeLiveToolCall("somethingNew", { widget: 4 });
  assert.equal(opaque.headline, "somethingNew");
  assert.equal(opaque.detail, null);
});

test("describeLiveToolCall truncates long details but never truncates the room reply", () => {
  const longText = "x".repeat(400);
  const detail = describeLiveToolCall("shellToolCall", { command: longText });
  assert.equal(detail.detail?.length, 140);
  assert.ok(detail.detail?.endsWith("…"));
  const reply = describeLiveToolCall("mcpToolCall", {
    name: "letagents_supervised_ab12cd34ef56-complete_room_turn",
    args: { outcome: "reply", text: longText },
  }, { status: "completed", output: { structuredContent: { accepted: true } }, error: null });
  assert.equal(reply.replyText, longText);
});

test("the live surface presents a work narrative and keeps technical payloads behind disclosure", () => {
  const surface = source("../src/components/desktop/content/agent-inspector/AgentInspectorLive.vue");
  assert.match(surface, /Live work/);
  assert.match(surface, /Working for/);
  assert.match(surface, /props\.work\.active && !props\.feed\.ended/);
  assert.match(surface, /scopeAgentStreamEventsToWork\(props\.feed\.events, props\.work\)/);
  assert.match(surface, /agentLiveAvailability\(props\.work, props\.feed\.ended\)/);
  assert.match(surface, /This agent is retired and cannot receive new room work/);
  assert.match(surface, /The agent is still starting and cannot receive room work yet/);
  assert.match(surface, /Ready for a message/);
  assert.doesNotMatch(surface, /AgentInspectorLiveHistory/);
  assert.doesNotMatch(surface, /Hidden chain of thought|supervisor's room-turn lifecycle owns|Waiting for room work/);
  assert.doesNotMatch(surface, /transcript\.value\.ended \? "Ended" : "In progress"/);
  assert.match(surface, /Agent commentary/);
  assert.match(surface, /Work note/);
  assert.doesNotMatch(surface, />Thinking</);
  assert.doesNotMatch(surface, /Working aloud/);
  assert.doesNotMatch(surface, />Response</);
  assert.match(surface, /agent-inspector-live-reply/);
  assert.match(surface, /<details/);
  assert.match(surface, /Technical details · \{\{ entry\.tool\.toolName \}\}/);
  assert.match(surface, /describeLiveToolCall/);
});

test("running native actions use present-progressive copy", () => {
  const running = describeLiveToolCall(
    "readToolCall",
    { path: "README.md" },
    { status: "running", output: null, error: null },
  );
  const completed = describeLiveToolCall(
    "readToolCall",
    { path: "README.md" },
    { status: "completed", output: null, error: null },
  );
  assert.equal(running.headline, "Reading a file");
  assert.equal(completed.headline, "Read a file");
});

test("Claude room tool names read as actions without transport prefixes", () => {
  const pending = describeLiveToolCall("mcp__letagents__update_task", { status: "in_review" }, { status: "pending", output: null, error: null });
  assert.equal(pending.toolName, "update_task");
  assert.equal(pending.headline, "Requested: Update a task");
  assert.equal(pending.detail, "in_review");
});

test("recognized Claude room tools never claim completion while pending or failed", () => {
  for (const [tool, completed] of [
    ["send_message", "Sent a room message"], ["send_thread_message", "Sent a thread reply"],
    ["post_status", "Posted a status update"], ["post_reasoning", "Shared reasoning in the room"],
    ["add_task", "Added a board task"], ["get_board", "Read the room board"],
    ["get_board_settings", "Read the board settings"], ["get_current_room", "Checked the current room"],
    ["check_repo", "Checked the repository"], ["wait_for_messages", "Waited for new room messages"],
    ["update_task", "Updated a task"], ["release_task_lease", "Released a task lease"],
    ["register_task_lease_action_intent", "Registered a task lease action"],
  ]) {
    const describe = (status: string) => describeLiveToolCall(`mcp__letagents__${tool}`, {}, { status, output: null, error: null }).headline;
    assert.match(describe("pending"), /^Requested:/);
    assert.notEqual(describe("running"), completed);
    assert.match(describe("error"), /^Failed:/);
    assert.match(describe("interrupted"), /^Interrupted:/);
    assert.equal(describe("completed"), completed);
  }
});

test("Live smoothly follows growing content, yields to readers, and cleans up", async () => {
  const { followAgentLiveScroll } = await import("../src/domain/agent-inspector-live-scroll");
  const saved = new Map(["window", "Element", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let resize: () => void = () => {};
  let disconnected = false;
  const motion = { matches: false };
  const viewport = Object.assign(new EventTarget(), {
    scrollHeight: 1000, clientHeight: 400, scrollTop: 0, style: { overflowAnchor: "auto" },
  });
  // Match the browser's scrollTop clamping, including the initial jump.
  let top = 0;
  Object.defineProperty(viewport, "scrollTop", {
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(Math.round(value), viewport.scrollHeight - viewport.clientHeight)); },
  });
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { matchMedia: () => motion, getSelection: () => ({ isCollapsed: true }) }),
    Element: class {},
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  });
  let time = performance.now();
  function tick(interval = 16) {
    time += interval;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
    viewport.dispatchEvent(new Event("scroll"));
  }
  function settle(interval = 16) {
    for (let count = 0; frames.size && count < 100; count++) tick(interval);
    assert.equal(frames.size, 0, "animation settles instead of running forever");
  }
  let dispose: (() => void) | undefined;
  try {
    dispose = followAgentLiveScroll(viewport as unknown as HTMLElement, {} as HTMLElement);
    assert.equal(top, 600, "opening Live starts at the latest activity");
    viewport.scrollHeight += 200;
    resize(); tick();
    assert.ok(top > 600 && top < 800, "new activity moves smoothly instead of jumping");
    for (let index = 0; index < 10; index++) {
      const previous = top;
      viewport.scrollHeight += 50;
      resize(); tick();
      assert.ok(top > previous, "rapid text deltas do not restart or starve the animation");
    }
    settle();
    assert.ok(Math.abs(top - 1300) < 1);

    viewport.scrollHeight += 100;
    resize(); settle(8);
    assert.equal(top, viewport.scrollHeight - viewport.clientHeight, "high-refresh screens settle despite pixel rounding");

    viewport.scrollHeight += 200;
    resize(); tick();
    viewport.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -10 }));
    assert.equal(frames.size, 0, "upward wheel cancels an in-flight animation immediately");
    viewport.scrollTop -= 200;
    viewport.dispatchEvent(new Event("scroll"));
    const readingTop = top;
    viewport.scrollHeight += 200;
    resize(); tick();
    assert.equal(top, readingTop, "new content leaves the reader's position alone");

    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.scrollHeight += 100;
    resize(); settle();
    assert.ok(Math.abs(top - (viewport.scrollHeight - viewport.clientHeight)) < 1, "returning to the bottom resumes following");

    for (const [start, end] of [["pointerdown", "pointerup"], ["touchstart", "touchend"]]) {
      viewport.dispatchEvent(new Event(start));
      assert.equal(frames.size, 0);
      window.dispatchEvent(new Event(end));
      viewport.scrollHeight += 100;
      resize(); settle();
      assert.ok(Math.abs(top - (viewport.scrollHeight - viewport.clientHeight)) < 1, "a click or tap at the bottom does not leave following paused");
    }

    motion.matches = true;
    viewport.scrollHeight += 300;
    resize(); tick();
    assert.equal(top, viewport.scrollHeight - viewport.clientHeight, "reduced motion follows without animation");
    viewport.dispatchEvent(Object.assign(new Event("keydown"), { key: "PageUp" }));
    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("touchend"));
    viewport.scrollHeight += 100;
    resize();
    assert.equal(frames.size, 0, "keyboard navigation stays paused even after unrelated outside clicks");
    dispose(); dispose = undefined;
    assert.equal(disconnected, true);
    assert.equal(viewport.style.overflowAnchor, "auto");
    viewport.scrollTop += 100;
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(frames.size, 0, "unmount removes event listeners and scheduled work");
  } finally {
    dispose?.();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
