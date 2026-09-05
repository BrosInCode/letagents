import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import { agentLiveTrace, canPresentCurrentAgentStream, currentAgentRequest } from "../src/domain/agent-inspector-live-trace";

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

test("the Live trace shows durable history across providers and never dresses idle replay as current work", async () => {
  const vite = await createServer({root:fileURLToPath(new URL("../..",import.meta.url)),appType:"custom",logLevel:"silent",server:{middlewareMode:true}});
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLive.vue")).default;
    const item = {source_message_id:"msg_1",sender:"Emmy",text_preview:"Inspect package.json",created_at:"2026-09-05T10:00:00Z",updated_at:"2026-09-05T10:01:00Z",state:"acknowledged",terminal_reason:null,outcome:{text:"Three scripts found"},canonical_message_id:"msg_2",last_error:null};
    const detail = {availability:"available",requested_source_message_id:"msg_1",source_message:{id:"msg_1",sender:"Emmy",text:"Inspect package.json"},items:[item],terminal:{normalized_text:"Three scripts found"},recorded_execution:{availability:"available",evidenceIncomplete:false,truncated:false,turns:[{turnId:"turn",state:"terminal",outcome:"completed",operations:[{executionId:"read",operation:"file_read",outcome:"succeeded",startObserved:true,outputBytes:0,exitCode:null,signalNumber:null,sideEffects:"none"}]}]}};
    const resource = {status:"ready",sourceMessageId:"msg_1",detail,error:null};
    const work = {active:false,startedAt:null,state:"idle",freshness:"fresh",agentState:"online",detail:null};
    const feed = {events:[event({sequence:1,observedAt:"2026-09-05T10:00:01Z",payload:{partId:"public",delta:"Current public commentary"}})],ended:false,droppedEvents:0};
    const render = (overrides:Record<string,unknown>={}) => renderToString(createSSRApp(component,{resource,work,feed,selectedSourceMessageId:"msg_1",activeSourceMessageId:null,supportsReasoning:false,...overrides}));
    for (const provider of ["codex","claude-code","cursor","open-model"]) {
      const html = await render({work:{...work,provider}});
      assert.match(html,/Inspect package.json/); assert.match(html,/Three scripts found/);
      assert.match(html,/Reply published/); assert.match(html,/File read · Completed/);
      assert.match(html,/Open request in Chat/); assert.match(html,/Open reply in Chat/);
      assert.doesNotMatch(html,/Current public commentary|Following the current|Waiting for room work/);
    }
    const active = await render({work:{...work,active:true,startedAt:"2026-09-05T10:00:00Z"},activeSourceMessageId:"msg_3"});
    assert.match(active,/Current turn/); assert.match(active,/Current public commentary/);
    assert.match(active,/Inspect package.json/); assert.match(active,/Recorded actions/);
    assert.ok(active.indexOf("Current public commentary") < active.indexOf("Recent work"), "current activity is separate from selected past work");
    assert.doesNotMatch(await render({work:{...work,active:true,startedAt:null},activeSourceMessageId:"msg_3"}),/Current public commentary/);
    assert.match(await render({resource:{...resource,status:"loading",detail:null}}),/Loading recent work/);
    assert.match(await render({resource:{...resource,status:"error",detail:null}}),/Couldn’t load recent work/);
    assert.match(await render({resource:{...resource,status:"unavailable",detail:null}}),/Recent work is unavailable/);
    assert.match(await render({resource:{...resource,detail:{...detail,availability:"pruned"}}}),/Older details have expired/);
    assert.match(await render({resource:{...resource,detail:{...detail,availability:"not_loaded",items:[]}}}),/No requests have been recorded/);
    assert.match(await render({resource:{...resource,detail:{...detail,recorded_execution:{availability:"not_captured"}}}}),/does not mean the agent did no work/);
    assert.deepEqual(agentLiveTrace(resource as any,"msg_other").turns,[],"mismatched source never lends recorded operations");
    assert.equal(currentAgentRequest(resource as any,"msg_other"),null,"selected history cannot supply another current request");
    assert.equal(currentAgentRequest(resource as any,"msg_1")?.text,"Inspect package.json");
    const withActive = {...resource,detail:{...detail,items:[item,{...item,source_message_id:"msg_3",sender:"Alex",text_preview:"Fresh task"}]}};
    const triggered = await render({resource:withActive,work:{...work,active:true,startedAt:"2026-09-05T10:00:00Z"},activeSourceMessageId:"msg_3"});
    assert.ok(triggered.indexOf("Fresh task") < triggered.indexOf("Current public commentary"));
    assert.equal(canPresentCurrentAgentStream({active:false,startedAt:"2026-09-05T10:00:00Z",activeSourceMessageId:"msg_1"}),false);
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
  assert.match(surface, /AgentInspectorLiveHistory/);
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
