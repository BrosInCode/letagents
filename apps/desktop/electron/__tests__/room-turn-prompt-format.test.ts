import assert from "node:assert/strict";
import test from "node:test";
import { formatRoomTurnContext, RoomTurnContextCache } from "../main/agents/desktop-event-prompt-format.js";

test("current guidance appears once; historical guidance cannot become a new instruction", () => {
  const activation = { decision: "activate", guidance: "You are an equal participant." };
  const source = { id: "msg_2", text: "Your views?", activation: { for_current_agent: activation } };
  const earlier = { id: "msg_1", text: "Previous question", activation: { for_current_agent: { guidance: "Obsolete guidance" } } };
  const reply = { id: "msg_3", sender: "Alice", text: "My approach", thread_root_id: "msg_2", reply_to: source.id };
  const request = { sourceMessage: source, observedContext: [earlier, source, reply], activation };
  const before = structuredClone(request);
  const lines = formatRoomTurnContext(request);
  assert.deepEqual(JSON.parse(lines[0]!.slice("Recent bounded room context: ".length)), [
    { id: "msg_1", text: "Previous question" }, reply,
  ]);
  assert.deepEqual(JSON.parse(lines[1]!.slice("Source message: ".length)), { id: "msg_2", text: "Your views?" });
  assert.deepEqual(JSON.parse(lines[2]!.slice("Activation: ".length)), activation);
  assert.equal(lines.join("\n").split(activation.guidance).length - 1, 1);
  assert.ok(!lines.join("\n").includes("Obsolete guidance"));
  assert.deepEqual(request, before, "never mutate the durable inbox or caller's context");
});

test("ordinary turns preserve conversation data and handle synthetic context", () => {
  assert.deepEqual(formatRoomTurnContext({ sourceMessage: null, activation: { decision: "activate" } }), [
    "Recent bounded room context: []", "Source message: null", 'Activation: {"decision":"activate"}',
  ]);
  const source = { text: "Answer in the main room", sender: "Human", reply_to: { text: "Earlier answer" } };
  const lines = formatRoomTurnContext({ sourceMessage: source, observedContext: [null, "correction", source], activation: {} });
  assert.deepEqual(JSON.parse(lines[0]!.slice("Recent bounded room context: ".length)), [null, "correction", source]);
});

function formatted(sourceMessage: unknown, observedContext: unknown[] = []) {
  const lines = formatRoomTurnContext({ sourceMessage, observedContext, activation: {} });
  return {
    context: JSON.parse(lines[0]!.slice("Recent bounded room context: ".length)),
    source: JSON.parse(lines[1]!.slice("Source message: ".length)),
    text: lines.join("\n"),
  };
}

test("all selected messages and full newer human corrections survive without cross-turn state", () => {
  const source = { id: "msg_1", sender: "Human", text: "Use the old plan" };
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `msg_${index + 2}`, sender: index === 29 ? "Human" : "Peer", text: index === 29
      ? "Correction: use this complete requirement. ".repeat(150) : `Perspective ${index}`,
  }));
  const first = formatted(source, messages);
  assert.deepEqual(first.context, messages);
  assert.deepEqual(first.source, source);
  assert.deepEqual(formatted(source, messages), first, "a fresh or resumed provider gets the same complete input");
});

test("an older source does not erase changed content under the same message ID", () => {
  const source = { id: "msg_10", sender: "Human", text: "Earlier request", gif: null };
  for (const changed of [
    { ...source, text: "Updated requirement" },
    { ...source, gif: { provider: "giphy", id: "changed", title: "Changed meaning" } },
    { ...source, attachments: [{ id: "attachment_2", filename: "new-requirements.txt" }] },
  ]) {
    const result = formatted(source, [changed]);
    assert.deepEqual(result.context, [changed]);
    assert.deepEqual(result.source, source);
  }
});

test("quoted parents outside the history retain full text once and exact thread references", () => {
  const parent = { id: "msg_1", sender: "Human", text: "An enduring constraint. ".repeat(150), timestamp: "2026-10-13T01:00:00Z" };
  const earlier = { id: "msg_40", sender: "Peer", text: "My answer", thread_root_id: "msg_1", reply_to: parent };
  const source = { id: "msg_41", sender: "Human", text: "Apply that constraint", thread_root_id: "msg_1",
    thread_reply_to_id: "msg_1", reply_to: parent };
  const result = formatted(source, [earlier]);
  assert.deepEqual(result.context[0].reply_to, parent);
  assert.deepEqual(result.source.reply_to, { id: parent.id });
  assert.equal(result.source.thread_root_id, "msg_1");
  assert.equal(result.source.thread_reply_to_id, "msg_1");
  assert.equal(result.text.split(parent.text).length - 1, 1);
});

test("quoted edits and unknown substantive reference fields cannot disappear behind an ID", () => {
  const known = { id: "msg_1", sender: "Human", text: "Current requirement", gif: { provider: "giphy", id: "new" } };
  for (const quote of [
    { ...known, text: "Earlier requirement" },
    { ...known, gif: null },
    { ...known, required_context: "An additional constraint" },
  ]) {
    const source = { id: "msg_2", text: "Explain the difference", reply_to: quote };
    assert.deepEqual(formatted(source, [known]).source.reply_to, quote);
  }
});

test("quotes stay explicit when source and history contain different edits of the same ID", () => {
  const source = { id: "msg_1", sender: "Human", text: "Earlier requirement" };
  const changed = { ...source, text: "Corrected requirement" };
  const reply = { id: "msg_2", sender: "Peer", text: "I was responding to the earlier version", reply_to: source,
    thread: { root_message_id: "msg_1", latest_reply: source } };
  const result = formatted(source, [changed, reply]);
  assert.deepEqual(result.context[0], changed);
  assert.deepEqual(result.source, source);
  assert.deepEqual(result.context[1].reply_to, source, "a bare ID would ambiguously name two different versions");
  assert.deepEqual(result.context[1].thread.latest_reply, source);
});

test("UI summaries and repeated bodies shrink while media, identities and source text stay intact", () => {
  const parent = { id: "msg_1", sender: "Human", text: "Full original context. ".repeat(100), source: "human" };
  const reply = { id: "msg_2", sender: "Peer", text: "My substantive perspective. ".repeat(100), source: "agent" };
  const thread = { root_message_id: "msg_1", reply_count: 1, unread_count: 1, has_unread: true,
    latest_reply: reply, participants: [{ sender: "Human", message_count: 1 }, { sender: "Peer", message_count: 1 }],
    participant_count: 2, participants_truncated: false, last_read_message_id: "msg_1" };
  const source = { ...reply, thread, reply_to: parent, thread_root_id: "msg_1", thread_reply_to_id: "msg_1",
    client_message_id: "client-exact", agent_identity: { actor_label: "Peer | Owner | Claude", agent_key: "agent-exact", agent_session_id: "session-exact" },
    sender_profile: { login: "owner", avatar_url: "https://example.test/avatar.png" }, display_text: reply.text,
    gif: { provider: "giphy", id: "gif-exact", title: "A fitting celebration", text_fallback_only: true },
    reactions: [{ emoji: "🎉", count: 1, actors: [{ agent_key: "other-agent" }] }],
    attachments: [{ id: "attachment-exact", filename: "constraints.txt", content_type: "text/plain", byte_size: 123,
      download_url: "/rooms/exact/messages/msg_2/attachments/attachment-exact" }], future_context: { constraint: "Preserve unknown data" },
  };
  const history = [{ ...parent, thread }, source];
  const before = structuredClone({ source, history });
  const result = formatted(source, history);
  assert.equal(result.context.length, 1, "the identical source is supplied separately once");
  assert.equal(result.context[0].text, parent.text);
  assert.equal(result.source.text, reply.text);
  assert.deepEqual(result.source.reply_to, { id: "msg_1" });
  assert.deepEqual(result.source.thread, { root_message_id: "msg_1", latest_reply: { id: "msg_2" } });
  assert.deepEqual(result.source.sender_profile, { login: "owner" });
  assert.equal(result.source.display_text, undefined);
  for (const field of ["client_message_id", "agent_identity", "gif", "reactions", "attachments", "future_context"] as const) {
    assert.deepEqual(result.source[field], source[field]);
  }
  assert.ok(result.text.length < JSON.stringify(before).length / 2, "duplicate bodies are replaced with exact references");
  assert.deepEqual({ source, history }, before, "durable data is never mutated");
});

test("unknown synthetic payloads, null source and distinct display text retain their content", () => {
  const synthetic = { id: "task-continuation:example", text: "Continue work", thread: { participants: ["Required participant"] },
    sender_profile: { avatar_url: "synthetic-data" }, custom: { required: true } };
  assert.deepEqual(formatted(synthetic, [synthetic, null, "correction"]).context, [synthetic, null, "correction"]);
  const message = { id: "msg_1", text: "Canonical agent instruction", display_text: "Human-facing explanation" };
  const result = formatted(null, [message]);
  assert.deepEqual(result.context, [message]);
  assert.equal(result.source, null);
});

function cacheFixture() {
  return {
    roomId: "focus_95", inboxItemId: "inbox", actionId: "action", activation: { guidance: "Keep your own voice" },
    sourceMessage: { id: "msg_20", source: "browser", text: "What do you think?" },
    observedContext: Array.from({ length: 12 }, (_, i) => ({ id: `msg_${i + 1}`,
      source: i === 1 ? "browser" : "agent", text: `Perspective ${i}: ${"Full useful detail. ".repeat(60)}` })),
  };
}
function cachedContext(lines: string[]) {
  return JSON.parse(lines.find(line => line.startsWith("Recent bounded room context: "))!.slice("Recent bounded room context: ".length));
}

test("native context reuse keeps humans, recent voices, source and changed media in full", () => {
  const cache = new RoomTurnContextCache(); const request = cacheFixture(); const before = structuredClone(request);
  const cold = cache.prepare(request, "native-1");
  assert.deepEqual(cold.lines, formatRoomTurnContext(request));
  assert.deepEqual(cache.prepare(request, "native-1").lines, cold.lines, "uncommitted inputs are not assumed retained");
  cold.commit();
  const warm = cache.prepare(request, "native-1"); const context = cachedContext(warm.lines);
  assert.deepEqual(context[0], { id: "msg_1", room_id: "focus_95", previously_supplied: true });
  assert.deepEqual(context[1], request.observedContext[1], "human instructions always stay full");
  assert.deepEqual(context.slice(-3), request.observedContext.slice(-3));
  assert.ok(warm.lines.includes(`Source message: ${JSON.stringify(request.sourceMessage)}`));
  assert.ok(warm.lines.includes(`Activation: ${JSON.stringify(request.activation)}`));
  assert.ok(warm.lines.join("\n").length < cold.lines.join("\n").length / 2);
  for (const change of [{ text: "An edited position" }, { gif: { id: "gif-2" } }, { reactions: [{ emoji: "👍" }] },
    { attachments: [{ id: "file-2" }] }, { future_constraint: "Must survive" }, { sender: "Changed author" }]) {
    const changed = structuredClone(request);
    Object.assign(changed.observedContext[0]!, change);
    assert.deepEqual(cachedContext(cache.prepare(changed, "native-1").lines)[0], changed.observedContext[0]);
  }
  assert.deepEqual(request, before, "never mutate durable context");
});

test("context invalidation fences in-flight commits and every scope change restores full input", () => {
  const cache = new RoomTurnContextCache(); const request = cacheFixture();
  cache.prepare(request, "native-1").commit();
  const racing = cache.prepare(request, "native-1");
  cache.reset(); racing.commit();
  assert.deepEqual(cache.prepare(request, "native-1").lines, formatRoomTurnContext(request));
  cache.prepare(request, "native-1").commit();
  assert.deepEqual(cache.prepare(request, "native-2").lines, formatRoomTurnContext(request));
  cache.prepare(request, "native-2").commit();
  const moved = { ...request, roomId: "focus_96" };
  assert.deepEqual(cache.prepare(moved, "native-2").lines, formatRoomTurnContext(moved));
  const synthetic = { ...request, sourceMessage: { text: "Task continuation" } };
  assert.deepEqual(cache.prepare(synthetic, "native-2").lines, formatRoomTurnContext(synthetic));
  assert.deepEqual(cache.prepare(request, "native-2").lines, formatRoomTurnContext(request));
  assert.deepEqual(new RoomTurnContextCache().prepare(request, "native-1").lines, formatRoomTurnContext(request));
});

test("reused context preserves quoted bodies, ambiguous edits, and bounds its history", () => {
  const cache = new RoomTurnContextCache(); const request = cacheFixture();
  cache.prepare(request, "native-1").commit();
  const quoted = { ...request, sourceMessage: { ...request.sourceMessage, reply_to: request.observedContext[0] } };
  const lines = cache.prepare(quoted, "native-1").lines;
  assert.ok(lines.includes(`Source message: ${JSON.stringify(quoted.sourceMessage)}`), "a quote of an omitted message must remain full");
  const edited = { ...request, sourceMessage: { ...request.observedContext[0]!, text: "Earlier version" } };
  assert.deepEqual(cachedContext(cache.prepare(edited, "native-1").lines)[0], request.observedContext[0]);
  const smaller = { ...request, observedContext: request.observedContext.slice(-3) };
  cache.prepare(smaller, "native-1").commit();
  assert.deepEqual(cache.prepare(request, "native-1").lines, formatRoomTurnContext(request), "messages outside the previous window are supplied again");
});
