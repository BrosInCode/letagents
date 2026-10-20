import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, nextTick, reactive, shallowRef } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import {
  MarkdownRenderCache,
  markdownCache,
  renderDesktopMarkdown,
} from "../src/components/desktop/content/formatting/markdown";
import { useRoomResponseParticipants } from "../src/composables/useRoomResponseParticipants";
import { RoomResponseParticipants, roomResponseParticipantsKey } from "../src/domain/room-response-participants";
import { appSource } from "./app-source";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("markdown cache: a repeated render is a hit and returns the same HTML", () => {
  markdownCache.clear();
  const first = renderDesktopMarkdown("**bold** note", { block: true, mentions: false });
  assert.equal(markdownCache.misses, 1);
  const second = renderDesktopMarkdown("**bold** note", { block: true, mentions: false });
  assert.equal(markdownCache.hits, 1);
  assert.equal(second, first);
  assert.match(first, /<strong>bold<\/strong>/);
});

test("markdown cache: text and every option are part of the key", () => {
  markdownCache.clear();
  const base = renderDesktopMarkdown("hello @agent", { block: true });
  assert.match(base, /mention-token/);
  assert.doesNotMatch(renderDesktopMarkdown("hello @agent", { block: true, mentions: false }), /mention-token/);
  // Different block mode, different text and different preservePaths must not share a slot.
  assert.notEqual(renderDesktopMarkdown("hello @agent", { mentions: true }), base);
  assert.match(renderDesktopMarkdown("see `/a/b/file.ts`", { block: true }), /<code>file\.ts<\/code>/);
  assert.match(renderDesktopMarkdown("see `/a/b/file.ts`", { block: true, preservePaths: true }), /<code>\/a\/b\/file\.ts<\/code>/);
  assert.notEqual(renderDesktopMarkdown("changed text", { block: true }), base);
  assert.equal(markdownCache.hits, 0);
});

test("markdown cache: onLink and highlightQuery calls are never cached", () => {
  markdownCache.clear();
  const seen: string[] = [];
  for (let run = 0; run < 3; run += 1) {
    renderDesktopMarkdown("see https://example.com/a", { block: true, onLink: url => seen.push(url) });
  }
  assert.deepEqual(seen, Array(3).fill("https://example.com/a"), "onLink is a side effect on every call");
  const one = renderDesktopMarkdown("find needle here", { block: true, highlightQuery: "needle" });
  const two = renderDesktopMarkdown("find needle here", { block: true, highlightQuery: "here" });
  assert.match(one, /<mark class="message-search-hit">needle<\/mark>/);
  assert.match(two, /<mark class="message-search-hit">here<\/mark>/);
  assert.equal(markdownCache.size, 0);
  assert.equal(markdownCache.hits + markdownCache.misses, 0);
});

test("markdown cache: bounded by entry count, evicts the least recently used", () => {
  const cache = new MarkdownRenderCache(3, 1_000_000);
  cache.set("a", "1"); cache.set("b", "2"); cache.set("c", "3");
  assert.equal(cache.get("a"), "1"); // a is now newest
  cache.set("d", "4");               // evicts b, the oldest
  assert.equal(cache.size, 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
  assert.equal(cache.get("d"), "4");
});

test("markdown cache: bounded by size, and one oversized entry is not stored", () => {
  const cache = new MarkdownRenderCache(100, 100); // 100 bytes = 50 UTF-16 units
  cache.set("k1", "x".repeat(20));
  cache.set("k2", "y".repeat(20));
  assert.equal(cache.size, 2);
  cache.set("k3", "z".repeat(20)); // total would be 132 bytes: oldest goes
  assert.equal(cache.get("k1"), undefined);
  assert.equal(cache.size, 2);
  cache.set("huge", "h".repeat(500));
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.size, 2);
  cache.set("k2", "w".repeat(22)); // replacing a key must not double count its bytes
  assert.equal(cache.get("k2"), "w".repeat(22));
  assert.equal(cache.size, 2);
});

test("markdown cache: the global cache stays inside its bounds under a long stream of notes", () => {
  markdownCache.clear();
  for (let n = 0; n < 2000; n += 1) renderDesktopMarkdown(`note ${n} ${"word ".repeat(40)}`, { block: true });
  assert.ok(markdownCache.size <= 500, `size ${markdownCache.size}`);
});

test("MarkdownBlock renders sanitized markdown and keeps the class on its element", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/formatting/MarkdownBlock.vue")).default;
    const html = await renderToString(createSSRApp(component, { text: "**hi** <script>alert(1)</script>", mentions: false, class: "agent-live-prose" }));
    assert.match(html, /^<div class="agent-live-prose">/);
    assert.match(html, /<strong>hi<\/strong>/);
    assert.doesNotMatch(html, /<script/);
  } finally {
    await vite.close();
  }
});

test("the four inline v-html markdown renders now go through MarkdownBlock", () => {
  for (const file of [
    "../src/components/desktop/content/agent-inspector/AgentInspectorLive.vue",
    "../src/components/desktop/content/agent-inspector/AgentInspectorSharedLive.vue",
    "../src/components/desktop/content/agent-inspector/AgentInspectorLiveActions.vue",
    "../src/components/desktop/content/room-board/RoomBoardTaskInspector.vue",
  ]) {
    const text = source(file);
    assert.match(text, /<MarkdownBlock\b/, file);
    assert.doesNotMatch(text, /v-html="renderDesktopMarkdown/, file);
  }
});

// ---- room response participants -------------------------------------------------

type Input = Parameters<RoomResponseParticipants["update"]>[0];
const entry = (n: number) => ({
  id: `entry-${n}`, roomId: "room", agentKey: `owner/${n}`, agentSessionId: `session-${n}`, displayName: `Agent ${n}`,
  agentSessionBindingState: "active", desiredState: "running", condition: "none",
  roomAgentState: { connection: { state: "connected" }, ingress: { state: "observing" }, inbox: { state: "empty" }, turn: { state: "idle" } },
  deliveryReceipts: [] as { sourceMessageId: string; state: string }[],
});
function manyMessages(count: number, text: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, timestamp: "2026-10-19T00:00:00.000Z", liveArrival: 0, text, sender: "someone",
    attachments: [{ id: `a${i}`, name: "x.png" }], accountAgentRouting: undefined,
  }));
}
function countUpdates<T>(run: () => Promise<T>): Promise<{ updates: number; result: T }> {
  const original = RoomResponseParticipants.prototype.update;
  let updates = 0;
  RoomResponseParticipants.prototype.update = function (this: RoomResponseParticipants, input: Input) { updates += 1; return original.call(this, input); };
  return run().then(result => ({ updates, result })).finally(() => { RoomResponseParticipants.prototype.update = original; });
}

test("participants: a poll that only changes message text does not run the tracker again", async () => {
  const messages = shallowRef(manyMessages(300, "first"));
  const entries = reactive([entry(0)]);
  const { updates } = await countUpdates(async () => {
    useRoomResponseParticipants(() => ({
      roomIdentifier: "room", loading: false, messages: messages.value as unknown as Input["messages"],
      entries: entries as unknown as Input["entries"], presence: [], fresh: true,
    }));
    for (let tick = 0; tick < 20; tick += 1) { messages.value = manyMessages(300, `text ${tick}`); await nextTick(); }
  });
  assert.equal(updates, 1, "only the immediate run; 20 text-only polls change nothing the tracker reads");
});

test("participants: arrivals, receipts, presence and room changes still run the tracker", async () => {
  const messages = shallowRef<Input["messages"]>([]);
  const entries = reactive([entry(0)]);
  const presence = shallowRef<Input["presence"]>([]);
  const loading = shallowRef(false);
  const room = shallowRef("room");
  let rows: ReturnType<typeof useRoomResponseParticipants> | undefined;
  const { updates } = await countUpdates(async () => {
    rows = useRoomResponseParticipants(() => ({
      roomIdentifier: room.value, loading: loading.value, messages: messages.value,
      entries: entries as unknown as Input["entries"], presence: presence.value, fresh: true,
    }));
    messages.value = [{ id: "new", timestamp: "2026-10-19T00:00:01.000Z", liveArrival: 1, accountAgentRouting: {
      version: 1, authority: "receipts", recipientAgentKeys: ["owner/0"],
      recipientSessions: [{ agentKey: "owner/0", agentSessionId: "session-0" }],
    } } as unknown as Input["messages"][number]];
    await nextTick();
    assert.equal(rows.value.length, 1, "new live message admits the participant");
    entries[0]!.deliveryReceipts.push({ sourceMessageId: "new", state: "acknowledged" }); // in-place change
    await nextTick();
    assert.equal(rows.value.length, 0, "an in-place receipt change retires it");
    presence.value = [{ agentSessionId: "session-0", displayName: "Renamed", actorLabel: "x" }];
    await nextTick();
    room.value = "other-room";
    await nextTick();
    loading.value = true;
    await nextTick();
  });
  assert.equal(updates, 6, "immediate + message + receipt + presence + room + loading");
});

test("participants key ignores message text and changes with every field the tracker reads", () => {
  const base: Input = { roomIdentifier: "r", loading: false, fresh: true, messages: [], entries: [], presence: [] };
  const key = roomResponseParticipantsKey(base);
  const withMessages = (text: string): Input => ({ ...base, messages: [{ id: "m", timestamp: "t", liveArrival: 2, text } as unknown as Input["messages"][number]] });
  assert.equal(roomResponseParticipantsKey(withMessages("a")), roomResponseParticipantsKey(withMessages("b")));
  assert.notEqual(roomResponseParticipantsKey(withMessages("a")), key);
  assert.notEqual(roomResponseParticipantsKey({ ...base, fresh: false }), key);
  assert.notEqual(roomResponseParticipantsKey({ ...base, loading: true }), key);
  assert.notEqual(roomResponseParticipantsKey({ ...base, roomIdentifier: "s" }), key);
});

// ---- deep watchers --------------------------------------------------------------

test("App.vue and DesktopModelPicker.vue no longer walk whole lists with deep watchers", () => {
  const app = appSource();
  const settings = app.indexOf("() => settingsAccountRooms.value,");
  const settingsWatcher = app.slice(settings, app.indexOf("leaveArchivedSelectedRoomFromSettingsList();", settings) + 200);
  assert.doesNotMatch(settingsWatcher, /deep: true/);
  assert.match(settingsWatcher, /immediate: true/);
  assert.match(settingsWatcher, /currentActiveRoomAliases\(\)/);
  assert.doesNotMatch(app.slice(app.indexOf("watch(recentRootRooms"), app.indexOf("watch(recentRootRooms") + 120), /deep: true/);
  const picker = source("../src/components/desktop/controls/DesktopModelPicker.vue");
  assert.doesNotMatch(picker.slice(picker.indexOf("watch(\n  [() => props.modelValue"), picker.indexOf("watch(filteredOptions")), /deep: true/);
});

test("markdown cache: a note whose code fell back to plain text is not cached, so a later render can colour it", () => {
  markdownCache.clear();
  const realNow = performance.now;
  let fake = 1_000_000;
  const clock = (step: number) => { performance.now = () => (fake += step); };
  const fence = (n: number) => ["```javascript", `const value${n} = ${n};`, "```"].join("\n");
  const highlighted = (html: string) => /hljs-/.test(html);
  try {
    clock(300); // one highlight reads as 300 ms, which spends the 250 ms budget
    renderDesktopMarkdown(fence(100), { block: true });
    markdownCache.clear();
    const note = `note\n\n${fence(1)}`;
    const first = renderDesktopMarkdown(note, { block: true });
    assert.equal(highlighted(first), false, "budget spent: plain fallback");
    assert.equal(markdownCache.size, 0, "a result with a fallback block is not cached");
    fake += 1500; // wait out the 1 s window
    clock(0);
    const later = renderDesktopMarkdown(note, { block: true });
    assert.equal(highlighted(later), true, "a later render colours it");
    assert.equal(markdownCache.size, 1, "a fully highlighted result is cached");
    assert.equal(markdownCache.hits, 0);
  } finally {
    performance.now = realNow;
  }
});

test("markdown cache: noCache skips the cache (editor preview)", () => {
  markdownCache.clear();
  renderDesktopMarkdown("draft text", { block: true, noCache: true });
  assert.equal(markdownCache.size, 0);
  assert.match(source("../src/components/desktop/content/room-board/TaskMarkdownEditor.vue"), /noCache: true/);
});
