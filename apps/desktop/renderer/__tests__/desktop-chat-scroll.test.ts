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

let Viewport: any, Thread: any, provideReactions: any, providePreviews: any, provideMotion: any;
let showCachedPaint: (rooms: string[]) => void, clearCachedPaint: () => void;
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    Viewport = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue")).default;
    Thread = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomThreadPanel.vue")).default;
    ({ provideRoomMessageReactions: provideReactions } = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessageReactions.ts"));
    ({ provideRoomMessageLinkPreviews: providePreviews } = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessageLinkPreviews.ts"));
    ({ showCachedPaint, clearCachedPaint } = await vite.ssrLoadModule("/renderer/src/composables/selected-room-snapshot-cache.ts"));
    ({ provideRoomMessageMotion: provideMotion } = await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/useRoomMessageMotion.ts", import.meta.url))));
  } finally { await vite.close(); }
});
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const message = (id: string) => ({ id, sender: "Ada", source: "browser", text: id, timestamp: "2026-10-02T00:00:00Z", attachments: [], agentIdentity: null });

async function scrollSurface(
  thread = false, rememberPosition = false, initialScrollTop: number | null = null,
  mount: { props?: Record<string, unknown>; scrollTop?: number; anchorRow?: { id: string; contentTop: number } } = {},
) {
  const old = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS, ResizeObserver: globalThis.ResizeObserver, IntersectionObserver: globalThis.IntersectionObserver };
  let resize = () => {};
  let intersect: (entries: any[]) => void = () => {};
  const reads: string[] = [];
  const reading: boolean[] = [];
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
    IntersectionObserver: class { constructor(callback: (entries: any[]) => void) { intersect = callback; } observe() {} disconnect() {} },
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} },
  });
  const calls: string[] = [];
  const positions: any[] = [];
  let top = mount.scrollTop ?? 1600;
  let revealTop: number | null = 100;
  const reveal = () => { if (revealTop !== null) top = revealTop; calls.push("reveal"); };
  const el = Object.assign(new EventTarget(), {
    clientHeight: 400, scrollHeight: 2000, style: { scrollBehavior: "smooth" }, isConnected: true,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => thread ? [{ dataset: { threadMessageId: "msg_1" }, getBoundingClientRect: () => ({ top: (revealTop ?? top) + 12 - top }), scrollIntoView: reveal, classList: { add() {}, remove() {} } }] : [], focus() {},
    querySelector: () => ({ closest: () => null, scrollIntoView: reveal, classList: { add() {}, remove() {} } }),
    scrollTo: ({ top: value }: { top: number }) => { el.scrollTop = value; },
    scrollTop: top,
  });
  Object.defineProperty(el, "scrollTop", { get: () => top, set: value => { top = Math.min(value, el.scrollHeight - el.clientHeight); calls.push("scroll"); } });
  if (mount.anchorRow) {
    const { id, contentTop } = mount.anchorRow;
    const row = { dataset: { messageId: id }, getBoundingClientRect: () => ({ top: contentTop - top, bottom: contentTop + 120 - top }) };
    el.querySelectorAll = (() => [row]) as typeof el.querySelectorAll;
  }
  const props = reactive<any>({
    active: true, messages: [message("msg_1"), message("msg_2")], threadMessages: [], localAgentWork: [],
    hasOlderMessages: false, loadingOlderMessages: false, roomLoading: false, roomIdentifier: "room", messageNamespace: "room", searchQuery: "", activeSearchMessageId: null,
    initialScrollPosition: initialScrollTop === null ? null : { top: initialScrollTop, latest: false, anchor: null },
    initialScrollTop,
    parent: message("msg_1"), replies: [message("msg_2")], initialThreadSummary: null, participants: [], attachmentDrafts: [], pendingAttachmentDrafts: [], taskReferenceIds: new Set(), deliveryReceiptsByMessage: {},
    ...mount.props,
  });
  const reactions = { revision: ref(0) }, previews = { revision: ref(0) };
  let vm: any, motion: any;
  const app = renderer.createApp({ setup() {
    provideReactions(reactions); providePreviews(previews);
    motion = provideMotion(() => props.messageNamespace);
    return () => h({ setup() {
      vm = (thread ? Thread : Viewport).setup(props, { expose() {}, emit(event: string, value: unknown) {
        if (event === "load-older") calls.push("load-older");
        if (event === "read-message") reads.push(String(value));
        if (event === "reading-latest") reading.push(Boolean(value));
        // DesktopRoomShell stores each live report and passes it back through
        // initialChatScrollTop on the next parent render, including when the
        // room had no saved position.
        if (!thread && event === "scroll-position") positions.push(value);
        if (rememberPosition && event === "scroll-position") void nextTick(() => { props.initialScrollPosition = value; });
      } });
      if (thread) { vm.bodyElement.value = el; vm.panelElement.value = el; }
      else vm.messagesElement.value = el;
      return () => h("div");
    } });
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({}); await flush(); calls.length = 0;
  el.addEventListener("scroll", () => vm.handleScroll?.());
  return { vm, props, reactions, previews, el, calls, reads, reading, positions,
    visibleReply: (id: string, height: number) => intersect([{ target: { dataset: { threadMessageId: id } }, isIntersecting: height > 0, intersectionRect: { height }, boundingClientRect: { height: 160 } }]),
    resize: () => resize(),
    send: (number = 1) => {
      const finish = motion.capture("my message", { getBoundingClientRect: () => ({ top: 500 }), closest: () => null });
      props.messages = [...props.messages, { ...message(`pending_${number}`), text: "my message", clientMessageId: `send_${number}`, outgoing: { status: "pending" } }];
      void nextTick(finish); // The composer releases the origin after local acceptance.
    },
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

test("timeline: a send acknowledgement does not count the same bubble as another unread message", async () => {
  const s = await scrollSurface();
  try {
    s.up();
    s.props.messages = [...s.props.messages, { ...message("pending_1"), clientMessageId: "send_1", outgoing: { status: "pending" } }];
    await flush();
    assert.equal(s.vm.unreadCount.value, 1);
    s.props.messages = s.props.messages.map((message: any) => message.id === "pending_1" ? { ...message, id: "msg_3", outgoing: undefined } : message);
    await flush();
    assert.equal(s.vm.unreadCount.value, 1);
    assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});

for (const loadingOlder of [false, true]) test(`timeline: own send follows latest during history loading=${loadingOlder}; its ack stays there`, async () => {
  const s = await scrollSurface();
  try {
    s.up();
    s.props.loadingOlderMessages = loadingOlder;
    s.send();
    await Promise.resolve(); s.el.scrollHeight += 200; await flush();
    assert.equal(s.el.scrollTop, 1800);
    assert.equal(s.vm.unreadCount.value, 0);
    if (loadingOlder) {
      s.props.messages = [message("msg_0"), ...s.props.messages];
      s.props.loadingOlderMessages = false;
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, 2000, "finishing backfill preserves the new latest position");
    }
    s.props.messages = s.props.messages.map((message: any) => message.id === "pending_1" ? { ...message, id: "msg_3", outgoing: undefined } : message);
    await flush();
    assert.equal(s.el.scrollTop, loadingOlder ? 2000 : 1800);
    assert.equal(s.vm.unreadCount.value, 0);
  } finally { s.close(); }
});

for (const fromHistory of [false, true]) test(`timeline: live scroll-memory feedback cannot disable subsequent sends, history=${fromHistory}`, async () => {
  const s = await scrollSurface(false, true);
  try {
    for (const number of [1, 2, 3]) {
      if (fromHistory) { s.up(); await flush(); }
      s.send(number);
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, s.el.scrollHeight - s.el.clientHeight, `send ${number} stays visible`);
      assert.equal(s.vm.unreadCount.value, 0);
      s.calls.length = 0;
      s.props.messages = s.props.messages.map((message: any) => message.id === `pending_${number}`
        ? { ...message, id: `msg_${number + 2}`, outgoing: undefined } : message);
      await flush();
      assert.deepEqual(s.calls, [], `ack ${number} does not navigate again`);
    }
    s.up(); await flush();
    s.props.messages = [...s.props.messages, message("msg_6")];
    await Promise.resolve(); s.el.scrollHeight += 200; await flush();
    assert.equal(s.el.scrollTop, 100, "incoming messages preserve the older reading position");
    assert.equal(s.vm.unreadCount.value, 1);
  } finally { s.close(); }
});

test("timeline: an existing saved position still restores once before own-send navigation", async () => {
  const s = await scrollSurface(false, true, 420);
  try {
    assert.equal(s.el.scrollTop, 420);
    s.send();
    await Promise.resolve(); s.el.scrollHeight += 200; await flush();
    assert.equal(s.el.scrollTop, 1800);
    s.up(); await flush();
    assert.equal(s.el.scrollTop, 100, "later memory feedback does not restore the old position");
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

// An expanded inline thread can leave the room viewport without being closed.
test("thread: read evidence requires visible replies and never advances an offscreen arrival", async () => {
  const s = await scrollSurface(true);
  try {
    assert.deepEqual(s.reads, []);
    s.visibleReply("msg_2", 100);
    assert.deepEqual(s.reads, ["msg_2"]);
    assert.equal(s.reading.at(-1), true);
    s.visibleReply("msg_2", 0);
    s.props.replies = [...s.props.replies, message("msg_3")];
    await flush();
    assert.deepEqual(s.reads, ["msg_2"]);
    assert.equal(s.reading.at(-1), false);
    s.visibleReply("msg_3", 100);
    assert.equal(s.reads.at(-1), "msg_3");
    s.props.active = false;
    await flush();
    s.visibleReply("msg_3", 100);
    assert.equal(s.reading.at(-1), false);
  } finally { s.close(); }
});

test("timeline: cached history mounts at latest when there is no saved reading position", async () => {
  const s = await scrollSurface();
  try { assert.equal(s.el.scrollTop, 1600); } finally { s.close(); }
});

test("timeline: detached and zero-height viewports cannot overwrite a saved room bookmark", async () => {
  const s = await scrollSurface(false, true, 420);
  try {
    s.el.clientHeight = 0; s.el.isConnected = false; s.el.scrollTop = 0;
    s.vm.emitScrollPosition(); s.vm.rememberScrollAnchor();
    await flush();
    assert.equal(s.positions.at(-1).top, 420);
    assert.equal(s.props.initialScrollPosition.top, 420);
  } finally { s.close(); }
});

test("timeline: a remembered latest position restores against the new page height", async () => {
  const s = await scrollSurface(false, true, 420);
  try {
    s.props.initialScrollPosition = { top: 1600, latest: true, anchor: null };
    s.el.scrollHeight = 2500;
    s.props.roomIdentifier = 'return-room';
    await flush();
    assert.equal(s.el.scrollTop, 2100);
    assert.equal(s.positions.at(-1).latest, true);
  } finally { s.close(); }
});

test("timeline: returning during snapshot loading keeps the saved position until messages arrive", async () => {
  const s = await scrollSurface(false, true, 420);
  try {
    s.props.roomLoading = true; s.props.messages = [];
    s.props.roomIdentifier = 'loading-return';
    s.props.initialScrollPosition = { top: 820, latest: false, anchor: null };
    s.el.scrollTop = 0;
    await flush(); s.vm.handleScroll(); s.vm.emitScrollPosition(); await flush();
    assert.equal(s.props.initialScrollPosition.top, 820);
    s.props.messages = [message('msg_1'), message('msg_2')]; s.props.roomLoading = false;
    await flush();
    assert.equal(s.el.scrollTop, 820);
  } finally { s.close(); }
});

// A return to a room paints its cached snapshot while the fresh read runs
// (roomLoading stays true, and the data layer marks the room as a cached
// paint). The rows must open at the saved place at mount, before any
// animation frame, and the fresh rows must not move them.
async function cachedPaintSurface(
  initialScrollPosition: unknown,
  mount: { props?: Record<string, unknown>; anchorRow?: { id: string; contentTop: number } } = {},
) {
  showCachedPaint(["room"]);
  const s = await scrollSurface(false, false, null, {
    scrollTop: 0,
    props: { roomLoading: true, initialScrollPosition, ...mount.props },
    anchorRow: mount.anchorRow,
  });
  const close = s.close;
  return { ...s, close: () => { clearCachedPaint(); close(); } };
}

const savedRow = { top: 500, latest: false, anchor: { messageId: "msg_1", offsetTop: 0 } };

for (const saved of ["none", "latest", "anchor"] as const) {
  test(`timeline: cached rows painted while loading open at the ${saved === "anchor" ? "saved row" : "bottom"} at mount (saved position: ${saved})`, async () => {
    const savedPosition = saved === "none" ? null
      : saved === "latest" ? { top: 1600, latest: true, anchor: null }
      : savedRow;
    // The saved row starts 700 px below the top of the content.
    const s = await cachedPaintSurface(savedPosition, { anchorRow: { id: "msg_1", contentTop: 700 } });
    try {
      const expected = saved === "anchor" ? 700 : 1600;
      assert.equal(s.el.scrollTop, expected, "no frame shows the top of the mount window");
      // Positions seen on cached rows are not saved for the room.
      assert.deepEqual(s.positions, []);

      // The fresh read lands with the same rows: nothing moves.
      s.props.messages = [message("msg_1"), message("msg_2")];
      s.props.roomLoading = false;
      await flush();
      assert.equal(s.el.scrollTop, expected);
    } finally { s.close(); }
  });
}

test("timeline: a cached row that is missing waits for fresh data before paging history", async () => {
  const s = await cachedPaintSurface(
    { top: 500, latest: false, anchor: { messageId: "msg_old", offsetTop: 0 } },
    { props: { hasOlderMessages: true } },
  );
  try {
    assert.equal(s.el.scrollTop, 1600, "the newest cached rows show while the room loads");
    assert.ok(!s.calls.includes("load-older"));
    s.props.roomLoading = false;
    await flush();
    assert.ok(s.calls.includes("load-older"), "the saved row is looked for on fresh data");
  } finally { s.close(); }
});

test("timeline: scrolling cached rows near the top does not page history until the room loads", async () => {
  const s = await cachedPaintSurface(savedRow, {
    props: { hasOlderMessages: true }, anchorRow: { id: "msg_1", contentTop: 700 },
  });
  try {
    s.el.scrollTop = 40; s.vm.handleScroll(); await flush();
    assert.ok(!s.calls.includes("load-older"), "no history page is cut from cached rows");
    s.props.roomLoading = false;
    await flush();
    s.el.scrollTop = 40; s.vm.handleScroll(); await flush();
    assert.ok(s.calls.includes("load-older"));
  } finally { s.close(); }
});

test("timeline: messages that came while away are no new-message pill when fresh rows replace cached ones", async () => {
  const s = await cachedPaintSurface(savedRow, { anchorRow: { id: "msg_1", contentTop: 700 } });
  try {
    assert.equal(s.el.scrollTop, 700);
    s.props.messages = ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"].map(message);
    s.props.roomLoading = false;
    await flush(); s.frame(); await flush();
    assert.equal(s.vm.unreadCount.value, 0);
    assert.equal(s.vm.arrivingMessageIds.value.size, 0);
    assert.equal(s.el.scrollTop, 700, "the reader's row stays in place");

    // After the baseline, a live message counts again.
    s.props.messages = [...s.props.messages, message("msg_9")];
    await flush();
    assert.equal(s.vm.unreadCount.value, 1);
  } finally { s.close(); }
});

test("timeline: a reader at the bottom stays there, with no arrival motion, when fresh rows replace cached ones", async () => {
  const s = await cachedPaintSurface({ top: 1600, latest: true, anchor: null });
  const animated: string[] = [];
  try {
    assert.equal(s.el.scrollTop, 1600);
    const row = {
      dataset: { messageId: "msg_3" }, isConnected: true,
      getBoundingClientRect: () => ({ top: 300, bottom: 360 }),
      animate: () => { animated.push("msg_3"); return { finished: Promise.resolve(), cancel() {} }; },
    };
    s.el.querySelectorAll = (() => [row]) as typeof s.el.querySelectorAll;
    s.el.scrollHeight = 2300;
    s.props.messages = [message("msg_1"), message("msg_2"), message("msg_3")];
    s.props.roomLoading = false;
    await flush(); s.frame(); await flush(); s.frame(); await flush();
    assert.equal(s.el.scrollTop, 1900, "the reader stays at the bottom");
    assert.deepEqual(animated, [], "messages that came while away do not animate in");
    assert.equal(s.vm.arrivingMessageIds.value.size, 0);
  } finally { s.close(); }
});

test("timeline: rows that exist while a first visit loads do not use up the saved position", async () => {
  // A live message reaches the placeholder before the first read: not a cached paint.
  const s = await scrollSurface(false, false, null, {
    scrollTop: 0,
    props: { roomLoading: true, messages: [message("msg_1")], initialScrollPosition: { top: 820, latest: false, anchor: null } },
  });
  try {
    assert.equal(s.el.scrollTop, 0, "the saved position waits for the loaded room");
    s.props.messages = [message("msg_1"), message("msg_2")];
    s.props.roomLoading = false;
    await flush();
    assert.equal(s.el.scrollTop, 820);
  } finally { s.close(); }
});

for (const navigation of ['reveal', 'send']) {
  test(`timeline: explicit ${navigation} wins over pending bookmark backfill`, async () => {
    const s = await scrollSurface();
    try {
      s.props.initialScrollPosition = { top: 900, latest: false, anchor: { messageId: 'msg_old', offsetTop: -20 } };
      s.props.roomIdentifier = s.props.messageNamespace = 'restoring-room';
      s.props.hasOlderMessages = true;
      await flush();
      assert.ok(s.calls.includes('load-older'));
      s.props.loadingOlderMessages = true;
      navigation === 'reveal' ? s.reveal() : s.send();
      await flush();
      assert.equal(s.el.scrollTop, navigation === 'reveal' ? 100 : 1600);
      s.props.messages = [message('msg_old'), ...s.props.messages];
      s.props.loadingOlderMessages = false;
      await flush();
      assert.equal(s.el.scrollTop, navigation === 'reveal' ? 100 : 1600, 'late backfill cannot replay the bookmark');
    } finally { s.close(); }
  });
}
test('timeline: a bookmarked original inside a regrouped page restores its containing group', async () => {
  const s = await scrollSurface();
  try {
    const group = { dataset: { scrollAnchorId: 'msg_newer' }, getBoundingClientRect: () => ({ top: 700 - s.el.scrollTop, bottom: 1000 - s.el.scrollTop }) };
    s.el.querySelectorAll = () => [group] as any;
    s.el.querySelector = () => ({ closest: () => group }) as any;
    s.props.initialScrollPosition = { top: 720, latest: false, anchor: { messageId: 'msg_old', offsetTop: -20 } };
    s.props.roomIdentifier = s.props.messageNamespace = 'regrouped-room';
    s.props.hasOlderMessages = true;
    await flush();
    assert.equal(s.el.scrollTop, 720);
    assert.ok(!s.calls.includes('load-older'), 'the original is loaded, despite the newer stable group anchor');
  } finally { s.close(); }
});

test('timeline: bookmark backfill continues after a page containing only thread replies', async () => {
  const s = await scrollSurface();
  try {
    s.props.initialScrollPosition = { top: 900, latest: false, anchor: { messageId: 'msg_old', offsetTop: -20 } };
    s.props.roomIdentifier = s.props.messageNamespace = 'thread-page-room'; s.props.hasOlderMessages = true;
    await flush();
    assert.equal(s.calls.filter(call => call === 'load-older').length, 1);
    s.props.loadingOlderMessages = true; await flush();
    s.props.threadMessages = [{ ...message('msg_reply'), threadRootId: 'msg_1' }];
    s.props.loadingOlderMessages = false; await flush();
    assert.equal(s.calls.filter(call => call === 'load-older').length, 2, 'the server cursor moved even though visible roots did not');
    s.props.loadingOlderMessages = true; await flush();
    const old = { dataset: { messageId: 'msg_old' }, getBoundingClientRect: () => ({ top: 700 - s.el.scrollTop, bottom: 800 - s.el.scrollTop }) };
    s.el.querySelector = () => ({ closest: () => old }) as any;
    s.props.messages = [message('msg_old'), ...s.props.messages]; s.props.loadingOlderMessages = false;
    await flush();
    assert.equal(s.el.scrollTop, 720);
  } finally { s.close(); }
});
