import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "../src/domain/chat-scroll";

describe("desktop chat scroll memory", () => {
  it("ignores loading-time scroll reports from the selected room", () => {
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "ROOM_FOCUS",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: true,
    }), false);
  });

  it("keeps real scroll reports and previous-room reports during a room switch", () => {
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "room_focus",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: false,
    }), true);
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "room_previous",
      selectedRoomIdentifier: "room_focus",
      selectedSnapshotLoading: true,
    }), true);
  });

  it("uses normalized storage keys and suppresses rooms with pending loading scroll", () => {
    assert.equal(chatScrollPositionKey(" ROOM_FOCUS "), "room_focus");
    assert.equal(shouldRememberChatScrollPosition({
      roomIdentifier: "ROOM_FOCUS",
      selectedRoomIdentifier: "room_parent",
      selectedSnapshotLoading: false,
      suppressedRoomIdentifiers: new Set(["room_focus"]),
    }), false);
  });
});

import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey } from "vue";

let Viewport: any, Thread: any, provideReactions: any, providePreviews: any;
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    Viewport = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue")).default;
    Thread = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomThreadPanel.vue")).default;
    ({ provideRoomMessageReactions: provideReactions } = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessageReactions.ts"));
    ({ provideRoomMessageLinkPreviews: providePreviews } = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessageLinkPreviews.ts"));
  } finally { await vite.close(); }
});
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const message = (id: string) => ({ id, sender: "Ada", source: "browser", text: id, timestamp: "2026-10-02T00:00:00Z", attachments: [], agentIdentity: null });

async function scrollSurface(thread = false) {
  const old = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS, ResizeObserver: globalThis.ResizeObserver };
  let resize = () => {};
  let now = 0, nextHandle = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), {
      requestAnimationFrame: (callback: () => void) => { frames.set(++nextHandle, callback); return nextHandle; },
      cancelAnimationFrame: (handle: number) => frames.delete(handle),
      setTimeout: (callback: () => void, delay = 0) => { timers.set(++nextHandle, { at: now + delay, callback }); return nextHandle; },
      clearTimeout: (handle: number) => timers.delete(handle), localStorage: { getItem: () => null, setItem() {} } }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }), CSS: { escape: (id: string) => id },
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} },
  });
  const calls: string[] = [];
  let top = 1600;
  let revealTop: number | null = 100;
  const reveal = () => { if (revealTop !== null) top = revealTop; calls.push("reveal"); };
  const el = Object.assign(new EventTarget(), {
    clientHeight: 400, scrollHeight: 2000, style: { scrollBehavior: "smooth" }, isConnected: true,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => thread ? [{ dataset: { threadMessageId: "msg_1" }, scrollIntoView: reveal, classList: { add() {}, remove() {} } }] : [], focus() {},
    querySelector: () => ({ scrollIntoView: reveal, classList: { add() {}, remove() {} } }),
    scrollTo: ({ top: value }: { top: number }) => { el.scrollTop = value; },
    scrollTop: top,
  });
  Object.defineProperty(el, "scrollTop", { get: () => top, set: value => { top = Math.min(value, el.scrollHeight - el.clientHeight); calls.push("scroll"); } });
  const props = reactive<any>({
    active: true, messages: [message("msg_1"), message("msg_2")], threadMessages: [], localAgentWork: [],
    hasOlderMessages: false, loadingOlderMessages: false, roomLoading: false, roomIdentifier: "room", messageNamespace: "room", searchQuery: "", activeSearchMessageId: null,
    parent: message("msg_1"), replies: [message("msg_2")], initialThreadSummary: null, participants: [], attachmentDrafts: [], pendingAttachmentDrafts: [], taskReferenceIds: new Set(), deliveryReceiptsByMessage: {},
  });
  const reactions = { revision: ref(0) }, previews = { revision: ref(0) };
  let vm: any;
  const app = renderer.createApp({ setup() {
    provideReactions(reactions); providePreviews(previews);
    return () => h({ setup() {
      vm = (thread ? Thread : Viewport).setup(props, { expose() {}, emit() {} });
      if (thread) { vm.bodyElement.value = el; vm.panelElement.value = el; }
      else vm.messagesElement.value = el;
      return () => h("div");
    } });
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({}); await flush(); calls.length = 0;
  el.addEventListener("scroll", () => vm.handleScroll?.());
  return { vm, props, reactions, previews, el, calls, resize: () => resize(),
    setRevealTop: (value: number | null) => { revealTop = value; },
    frame: () => { for (const [handle, callback] of [...frames]) { frames.delete(handle); callback(); } },
    advance: (duration: number) => {
      const end = now + duration;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = end;
    },
    reveal: () => thread ? vm.jumpToThreadMessageReference("msg_1") : vm.scrollToMessage("msg_1"),
    up: () => { el.scrollTop = 100; if (thread) el.dispatchEvent(new Event("scroll")); else vm.handleScroll(); calls.length = 0; },
    close: () => { app.unmount(); Object.assign(globalThis, old); },
  };
}
for (const thread of [false, true]) {
  const client = thread ? "thread" : "timeline";
  test(`${client}: a reveal wins over already queued reaction/preview follow`, async () => {
    const s = await scrollSurface(thread);
    try {
      s.reactions.revision.value++; s.previews.revision.value++;
      await Promise.resolve(); // The real watchers are now waiting on Vue's next tick.
      s.reveal();
      await flush();
      assert.equal(s.el.scrollTop, 100);
    } finally { s.close(); }
  });
  test(`${client}: readers who scroll up while a revision waits stay put`, async () => {
    const s = await scrollSurface(thread);
    try {
      s.reactions.revision.value++;
      await Promise.resolve(); s.up(); await flush();
      assert.equal(s.el.scrollTop, 100);
    } finally { s.close(); }
  });
  test(`${client}: simultaneous reactions and previews follow once; scrolled-up readers stay put`, async () => {
    const s = await scrollSurface(thread);
    try {
      s.reactions.revision.value++; s.previews.revision.value++;
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, 1800);
      assert.equal(s.calls.length, 1);
      s.up(); s.reactions.revision.value++; s.previews.revision.value++;
      await flush(); assert.equal(s.el.scrollTop, 100); assert.deepEqual(s.calls, []);
    } finally { s.close(); }
  });
}
test("timeline: starting agent work must not pull a scrolled-up reader to latest", async () => {
  const s = await scrollSurface();
  try {
    s.up();
    s.props.localAgentWork = [{ id: "work", displayName: "Agent", summary: "Working", startedAt: "2026-10-03T00:00:00Z" }];
    await flush(); assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});
test("timeline: a pending layout anchor cannot undo a reveal", async () => {
  const s = await scrollSurface();
  try {
    s.vm.preserveScrollAnchorOnNextLayout(); s.reveal(); await flush();
    assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});
test("timeline: composer/typing/pin resize follows bottom but respects a reveal", async () => {
  const s = await scrollSurface();
  try {
    s.el.clientHeight = 300; s.resize(); assert.equal(s.el.scrollTop, 1700);
    s.reveal(); s.el.clientHeight = 250; s.resize(); assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});

test("timeline: all append/reaction/preview/resize combinations preserve the reader's intent", async () => {
  for (const atBottom of [true, false]) for (let mask = 1; mask < 16; mask++) {
    const s = await scrollSurface();
    try {
      if (!atBottom) s.up();
      if (mask & 1) s.props.messages = [...s.props.messages, message("msg_3")];
      if (mask & 2) s.reactions.revision.value++;
      if (mask & 4) s.previews.revision.value++;
      await Promise.resolve();
      if (mask & 7) s.el.scrollHeight += 200;
      if (mask & 8) { s.el.clientHeight = 300; s.resize(); }
      await flush();
      assert.equal(s.el.scrollTop, atBottom ? s.el.scrollHeight - s.el.clientHeight : 100, `bottom=${atBottom}, mask=${mask}`);
      assert.ok(s.calls.length <= 1, `duplicate follow: bottom=${atBottom}, mask=${mask}: ${s.calls}`);
    } finally { s.close(); }
  }
});

test("thread: paged replies and later revisions never re-run a consumed reveal or search", async () => {
  const s = await scrollSurface(true);
  try {
    s.props.revealMessageId = "msg_1";
    s.props.replies = [message("msg_0"), ...s.props.replies];
    s.reactions.revision.value++; await flush();
    assert.equal(s.el.scrollTop, 100);
    s.up(); s.el.scrollTop = 200; s.calls.length = 0;
    s.props.replies = [...s.props.replies, message("msg_3")]; s.previews.revision.value++;
    await flush(); assert.equal(s.el.scrollTop, 200); assert.deepEqual(s.calls, []);
    s.props.revealMessageId = null; s.props.activeSearchMessageId = "msg_1";
    await flush(); assert.equal(s.el.scrollTop, 100);
    s.el.scrollTop = 200; s.calls.length = 0;
    s.props.replies = [...s.props.replies, message("msg_4")]; await flush();
    assert.equal(s.el.scrollTop, 200); assert.deepEqual(s.calls, []);
  } finally { s.close(); }
});

for (const thread of [false, true]) test(`${thread ? 'thread' : 'timeline'}: revisions during a smooth reveal cannot start a new bottom follow`, async () => {
  const s = await scrollSurface(thread);
  try {
    s.reveal();
    // Smooth scrolling may not have moved the viewport when another revision arrives.
    s.el.scrollTop = 1600; s.calls.length = 0;
    if (!thread) s.vm.handleScroll();
    s.reactions.revision.value++; s.previews.revision.value++; await flush();
    assert.deepEqual(s.calls, []);
  } finally { s.close(); }
});

test("thread: every append/reaction/preview combination follows bottom once and leaves older readers in place", async () => {
  for (const atBottom of [true, false]) for (let mask = 1; mask < 8; mask++) {
    const s = await scrollSurface(true);
    try {
      if (!atBottom) s.up();
      if (mask & 1) s.props.replies = [...s.props.replies, message("msg_3")];
      if (mask & 2) s.reactions.revision.value++;
      if (mask & 4) s.previews.revision.value++;
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, atBottom ? 1800 : 100, `bottom=${atBottom}, mask=${mask}`);
      assert.equal(s.calls.length, atBottom ? 1 : 0);
    } finally { s.close(); }
  }
});

test("timeline: programmatic anchor scroll events preserve subsequent transition frames", async () => {
  const s = await scrollSurface();
  const frames: Array<() => void> = [];
  Object.assign(window, { requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {} });
  try {
    s.vm.preserveScrollAnchorOnNextLayout(1000); await flush();
    frames.shift()!(); s.vm.handleScroll();
    assert.equal(frames.length, 1);
    s.el.scrollTop = 1500; // A subsequent layout frame changes geometry before its scroll event.
    frames.shift()!();
    assert.equal(s.el.scrollTop, 1600);
    s.reveal(); frames.shift()?.(); assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});

for (const entry of ["timeline", "thread reference", "thread search"]) {
  for (const completion of ["no movement", "missing scrollend"]) {
    test(`${entry}: ${completion} releases reveal suppression before the next arrival`, async () => {
      const thread = entry !== "timeline";
      const s = await scrollSurface(thread);
      try {
        s.setRevealTop(completion === "no movement" ? null : 1500);
        if (entry === "thread search") {
          s.props.activeSearchMessageId = "msg_1";
          await flush();
        } else s.reveal();
        s.frame(); s.frame();
        if (completion === "missing scrollend") {
          s.el.scrollTop = 1600; // Smooth scrolling finishes without a scrollend event.
          s.calls.length = 0;
          s.advance(799);
          s.reactions.revision.value++; await flush();
          assert.deepEqual(s.calls, [], "suppress follow while the reveal is still bounded");
          s.advance(1);
        }
        if (thread) s.props.replies = [...s.props.replies, message("msg_3")];
        else s.props.messages = [...s.props.messages, message("msg_3")];
        await Promise.resolve(); s.el.scrollHeight += 200; await flush();
        assert.equal(s.el.scrollTop, 1800, "the next arrival follows after reveal suppression ends");
      } finally { s.close(); }
    });
  }
}

for (const thread of [false, true]) {
  for (const started of ["second frame", "scroll event"]) {
    test(`${thread ? "thread" : "timeline"}: a reveal starting on the ${started} stays protected`, async () => {
      const s = await scrollSurface(thread);
      try {
        s.setRevealTop(null); s.reveal(); s.calls.length = 0;
        if (started === "second frame") {
          s.frame();
          s.reactions.revision.value++; await flush();
          assert.deepEqual(s.calls, [], "the first frame must not release bottom-follow suppression");
          s.el.scrollTop = 1500;
        } else {
          s.el.scrollTop = 1580;
          s.el.dispatchEvent(new Event("scroll"));
          s.el.scrollTop = 1600; // An event proves movement even if the next sampled offset matches.
          s.frame();
        }
        s.frame();
        s.el.scrollTop = 1600; s.calls.length = 0;
        s.previews.revision.value++; await flush();
        assert.deepEqual(s.calls, [], "a started reveal remains protected until scrollend or the maximum");
        s.advance(800);
        if (thread) s.props.replies = [...s.props.replies, message("msg_3")];
        else s.props.messages = [...s.props.messages, message("msg_3")];
        await Promise.resolve(); s.el.scrollHeight += 200; await flush();
        assert.equal(s.el.scrollTop, 1800, "the maximum still releases suppression");
      } finally { s.close(); }
    });
  }
}
