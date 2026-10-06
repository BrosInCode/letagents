import "../../../shared/room-unread.test.mjs";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey } from "vue";

let provideReactions: any, providePreviews: any, providePins: any;
let createRoomUnreadClient: any, useUnreadTimeline: any, Message: any, MessageList: any, unreadMenuKey: any;
before(async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    ({ createRoomUnreadClient, useUnreadTimeline, unreadMenuKey } = await vite.ssrLoadModule(fileURLToPath(new URL("../../../shared/room-unread-client.ts", import.meta.url))));
    Message = (await vite.ssrLoadModule("/src/components/room/ChatMessage.vue")).default;
    MessageList = (await vite.ssrLoadModule("/src/components/room/MessageList.vue")).default;
    ({ provideRoomMessageReactions: provideReactions } = await vite.ssrLoadModule("/src/composables/roomMessageReactions.ts"));
    ({ provideRoomMessageLinkPreviews: providePreviews } = await vite.ssrLoadModule("/src/composables/roomMessageLinkPreviews.ts"));
    ({ provideRoomMessagePins: providePins } = await vite.ssrLoadModule("/src/composables/roomMessagePins.ts"));
  } finally { await vite.close(); }
});

test("web menu marks the main timeline only, leaves message/receipt data untouched, and never emits a room action", async () => {
  const old = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: new EventTarget(), document: new EventTarget() });
  const message = { id: "msg_9", sender: "Ada", source: "browser", text: "Read later", timestamp: "2026-10-02T00:00:00Z", thread_root_id: null as string | null };
  const props = reactive({ message, roomIdentifier: "room" });
  const before = JSON.stringify(message);
  const marks: any[] = [], events: any[] = [];
  let vm: any;
  const app = renderer.createApp({ setup() {
    vm = Message.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) });
    return () => h("div");
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  app.provide(unreadMenuKey, { client: { account: ref("alice"), mark: (...args: any[]) => marks.push(args) }, room: ref("canonical-room") });
  try {
    app.mount({});
    assert.equal(vm.canMarkUnread.value, true);
    vm.markUnreadFromMenu();
    assert.deepEqual(marks, [["canonical-room", "msg_9"]]);
    assert.equal(JSON.stringify(message), before);
    assert.deepEqual(events, []);
    props.message.thread_root_id = "msg_1";
    assert.equal(vm.canMarkUnread.value, false);
    vm.markUnreadFromMenu();
    assert.equal(marks.length, 1);
    props.message.thread_root_id = "msg_9";
    assert.equal(vm.canMarkUnread.value, true);
    props.message.id = "pending:1";
    assert.equal(vm.canMarkUnread.value, false);
  } finally { app.unmount(); Object.assign(globalThis, old); }
});
const renderer = createRenderer<any, any>({
  patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
  createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
});
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

test("the actual web list reuses bounded reveal for an older bookmark and retains an unavailable target", async () => {
  const old = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };
  const data = new Map();
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  });
  Object.assign(globalThis, { window: win, document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }), CSS: { escape: (id: string) => id } });
  const message = (id: string) => ({ id, sender: "Ada", source: "browser", text: id, timestamp: "2026-10-02T00:00:00Z", thread_root_id: null });
  const props = reactive({ messages: [message("msg_3")], roomIdentifier: "alias", unreadRoomId: "canonical", messagesLoaded: false, hasOlderMessages: true, isLoadingOlderMessages: false });
  let vm: any, olderReads = 0;
  const el = Object.assign(new EventTarget(), {
    scrollHeight: 1500, clientHeight: 400, scrollTop: 1100,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400 }),
    scrollTo: () => { el.scrollTop = 1100; },
    querySelectorAll: () => [],
    querySelector: (selector: string) => {
      const id = props.messages.find(row => selector.includes(row.id))?.id;
      return id ? { scrollIntoView: () => { el.scrollTop = 100; }, classList: { add() {}, remove() {} } } : null;
    },
  });
  const app = renderer.createApp({ setup() {
    vm = MessageList.setup(props, { expose() {}, emit: (event: string) => {
      if (event !== "loadOlder") return;
      olderReads++;
      props.isLoadingOlderMessages = true;
      setImmediate(() => {
        props.messages = [message("msg_1"), message("msg_2"), message("msg_3")];
        props.hasOlderMessages = false;
        props.isLoadingOlderMessages = false;
      });
    } });
    vm.messagesEl.value = el;
    return () => h("div");
  } });
  app.provide(ssrContextKey, { modules: new Set() });
  try {
    app.mount({});
    vm.roomUnread.account.value = "list-reader";
    vm.roomUnread.mark("canonical", "msg_1");
    vm.roomUnread.enter("canonical");
    await flush();
    assert.equal(olderReads, 0, "wait for initial history");
    props.messagesLoaded = true;
    await flush(); await flush();
    assert.equal(olderReads, 1);
    assert.equal(vm.unreadTimeline.dividerId.value, "msg_1");
    assert.equal(el.scrollTop, 100);
    vm.roomUnread.mark("canonical", "msg_missing");
    vm.roomUnread.enter("elsewhere"); vm.roomUnread.enter("canonical");
    await flush(); await flush();
    assert.equal(vm.unreadTimeline.dividerId.value, null);
    assert.equal(vm.roomUnread.get("canonical").messageId, "msg_missing");
    assert.equal(el.scrollTop, 1100);
  } finally { app.unmount(); Object.assign(globalThis, old); }
});

test("real client lifecycle: current visit and Chat remount persist; later reading clears; automatic scroll does not", async (t) => {
  const old = { window: globalThis.window, document: globalThis.document, KeyboardEvent: globalThis.KeyboardEvent };
  const data = new Map();
  const win = Object.assign(new EventTarget(), { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) } });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true });
  class Key extends Event { key = "End"; }
  Object.assign(globalThis, { window: win, document: doc, KeyboardEvent: Key });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { calls.push("fetch"); throw Error("unexpected"); });
  (win as any).letagentsDesktop = { room: new Proxy({}, { get() { return () => { calls.push("IPC"); throw Error("unexpected"); }; } }) };
  let app: any;
  try {
    const client = createRoomUnreadClient("test-client");
    client.account.value = "alice";
    client.enter("room");
    const mark = client.mark("room", "msg_10");
    const el = Object.assign(new EventTarget(), { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    let surface: any;
    let reveals = 0;
    let found = true;
    const mount = () => {
      app = renderer.createApp({ setup() {
        surface = useUnreadTimeline({
          client, room: ref("room"), active: ref(true), ready: ref(true), element: ref(el),
          reveal: async () => { reveals++; el.scrollTop = 0; return found; },
          bottom: () => { el.scrollTop = 600; },
        });
        return () => h("div");
      } });
      app.mount({});
    };
    mount(); await flush();
    el.dispatchEvent(new Event("wheel")); win.dispatchEvent(new Event("focus")); await flush();
    assert.equal(client.get("room").revision, mark.revision);
    assert.equal(reveals, 0);
    app.unmount(); client.enter("room"); mount(); await flush();
    assert.equal(reveals, 0, "Chat tab remount is the same room visit");
    app.unmount(); client.enter("elsewhere"); client.enter("room"); mount(); await flush();
    assert.equal(surface.dividerId.value, "msg_10");
    el.scrollTop = 600; el.dispatchEvent(new Event("scroll")); await flush();
    assert.ok(client.get("room"), "arrival or automatic scroll cannot clear");
    doc.visibilityState = "hidden"; el.dispatchEvent(new Event("wheel")); await flush();
    assert.ok(client.get("room"));
    doc.visibilityState = "visible"; doc.hasFocus = () => false;
    el.dispatchEvent(new Event("wheel")); await flush(); assert.ok(client.get("room"));
    doc.hasFocus = () => true; el.dispatchEvent(new Event("wheel")); await flush();
    assert.equal(client.get("room"), null);
    assert.equal(surface.dividerId.value, "msg_10", "clearing unread keeps the divider for this visit");

    app.unmount(); mount(); await flush();
    assert.equal(surface.dividerId.value, "msg_10", "Chat remount keeps the visit's divider after clearing");
    client.enter("elsewhere"); client.enter("room"); await flush();
    assert.equal(surface.dividerId.value, null, "a new visit resets the divider");

    app.unmount(); client.mark("room", "msg_missing"); client.enter("elsewhere"); client.enter("room");
    found = false; mount(); await flush();
    assert.equal(el.scrollTop, 600); assert.equal(surface.dividerId.value, null);
    el.dispatchEvent(new Event("wheel")); win.dispatchEvent(new Event("focus")); await flush();
    assert.equal(client.get("room").messageId, "msg_missing", "unreachable bookmark survives at bottom");

    app.unmount(); client.account.value = "bob"; client.enter("room");
    assert.equal(client.get("room"), null);
    client.mark("room", "msg_bob"); client.account.value = "alice";
    assert.equal(client.get("room").messageId, "msg_missing");
    assert.deepEqual(calls, [], "no network or IPC write while marking and clearing");
  } finally { app?.unmount(); Object.assign(globalThis, old); }
});

test("storage events refresh the active account without allowing an earlier visit to clear a newer mark", async () => {
  const old = { window: globalThis.window, document: globalThis.document };
  const data = new Map();
  const win = Object.assign(new EventTarget(), { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) } });
  Object.assign(globalThis, { window: win });
  try {
    const first = createRoomUnreadClient("tabs"), second = createRoomUnreadClient("tabs");
    first.account.value = second.account.value = "alice";
    first.mark("room", "msg_1"); first.enter("room");
    const entered = first.visit.value.revision;
    const newer = second.mark("room", "msg_2");
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "tabs:alice" }));
    await flush();
    assert.equal(first.get("room").revision, newer.revision);
    assert.equal(first.clear("room", entered), false);
    assert.equal(first.get("room").messageId, "msg_2");
  } finally { Object.assign(globalThis, old); }
});

test("a queued user read check is cancelled by an intervening programmatic scroll", async () => {
  const old = { window: globalThis.window, document: globalThis.document, KeyboardEvent: globalThis.KeyboardEvent };
  const data = new Map();
  const win = Object.assign(new EventTarget(), { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) } });
  Object.assign(globalThis, { window: win, document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }), KeyboardEvent: class extends Event {} });
  const client = createRoomUnreadClient("queued-read"); client.account.value = "alice";
  client.mark("room", "msg_1"); client.enter("room");
  const el = Object.assign(new EventTarget(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
  let surface: any;
  const app = renderer.createApp({ setup() {
    surface = useUnreadTimeline({ client, room: ref("room"), active: ref(true), ready: ref(true), element: ref(el), reveal: async () => true, bottom() {} });
    return () => h("div");
  } });
  try {
    app.mount({}); await flush();
    el.dispatchEvent(new Event("wheel"));
    surface.programmaticScroll(); el.scrollTop = 1600;
    await flush();
    assert.ok(client.get("room"), "queued input cannot count an automatic scroll as reading");
    win.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.ok(client.get("room"), "focus and visibility do not turn automatic scrolling into reading");
    el.dispatchEvent(new Event("wheel")); await flush();
    assert.equal(client.get("room"), null, "a later genuine input still clears");
  } finally { app.unmount(); Object.assign(globalThis, old); }
});

async function webScrollSurface() {
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
  let revealTop: number | null = 100;
  const el = Object.assign(new EventTarget(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400 }),
    scrollTo: () => { el.scrollTop = el.scrollHeight - el.clientHeight; calls.push("bottom"); },
    querySelectorAll: () => [], querySelector: () => ({ scrollIntoView: () => { if (revealTop !== null) el.scrollTop = revealTop; calls.push("reveal"); }, classList: { add() {}, remove() {} } }),
  });
  const row = (id: string) => ({ id, sender: "Ada", source: "browser", text: id, timestamp: "2026-10-02T00:00:00Z" });
  const props = reactive<any>({ messages: [row("msg_1"), row("msg_2")], roomIdentifier: "room", messagesLoaded: true, hasOlderMessages: false, searchQuery: "" });
  const reactions = { revision: ref(0) }, previews = { revision: ref(0) }, pins = { state: ref({ pins: [] as any[] }) };
  let vm: any;
  const app = renderer.createApp({ setup() {
    provideReactions(reactions); providePreviews(previews); providePins(pins);
    return () => h({ setup() {
      vm = MessageList.setup(props, { expose() {}, emit() {} }); vm.messagesEl.value = el;
      return () => h("div");
    } });
  } });
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({}); await flush(); calls.length = 0;
  return { vm, props, el, reactions, previews, pins, calls, row,
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
    }, resize: () => resize(), close: () => { app.unmount(); Object.assign(globalThis, old); } };
}
test("web: queued revisions cannot override a reveal or user scrolling up", async () => {
  const s = await webScrollSurface();
  try {
    s.reactions.revision.value++; s.previews.revision.value++; s.pins.state.value.pins.push({});
    await Promise.resolve(); s.vm.scrollToMessage("msg_1"); await flush();
    assert.equal(s.el.scrollTop, 100);
    s.vm.scrollToBottom("instant"); s.vm.checkScroll();
    s.reactions.revision.value++;
    await Promise.resolve(); s.el.scrollTop = 100; s.vm.checkScroll(); await flush();
    assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});
test("web: simultaneous append, reaction, preview and pin changes follow once", async () => {
  const s = await webScrollSurface();
  try {
    s.props.messages.push(s.row("msg_3"));
    s.reactions.revision.value++; s.previews.revision.value++; s.pins.state.value.pins.push({});
    await Promise.resolve(); s.el.scrollHeight += 200; await flush();
    assert.equal(s.el.scrollTop, 1800); assert.deepEqual(s.calls, ["bottom"]);
    s.el.scrollTop = 100; s.vm.checkScroll(); s.calls.length = 0;
    s.reactions.revision.value++; s.previews.revision.value++; s.pins.state.value.pins = [];
    await flush(); assert.equal(s.el.scrollTop, 100); assert.deepEqual(s.calls, []);
  } finally { s.close(); }
});
test("web: search retains its target through same-tick revisions", async () => {
  const s = await webScrollSurface();
  try {
    s.props.searchQuery = "Ada"; s.reactions.revision.value++; s.previews.revision.value++;
    await flush(); assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});
test("web: typing/composer resize keeps latest visible, preserves a scrolled-up reader", async () => {
  const s = await webScrollSurface();
  try {
    s.el.clientHeight = 300; s.resize(); await flush(); assert.equal(s.el.scrollTop, 1700);
    s.el.scrollTop = 100; s.vm.checkScroll(); s.el.clientHeight = 250; s.resize(); await flush(); assert.equal(s.el.scrollTop, 100);
  } finally { s.close(); }
});

test("web: all append/reaction/preview/pin/resize combinations preserve bottom and scrolled-up intent", async () => {
  for (const atBottom of [true, false]) for (let mask = 1; mask < 32; mask++) {
    const s = await webScrollSurface();
    try {
      if (!atBottom) { s.el.scrollTop = 100; s.vm.checkScroll(); }
      if (mask & 1) s.props.messages.push(s.row("msg_3"));
      if (mask & 2) s.reactions.revision.value++;
      if (mask & 4) s.previews.revision.value++;
      if (mask & 8) s.pins.state.value.pins.push({});
      await Promise.resolve();
      if (mask & 7) s.el.scrollHeight += 200;
      if (mask & 24) { s.el.clientHeight = 300; s.resize(); }
      await flush();
      assert.equal(s.el.scrollTop, atBottom ? s.el.scrollHeight - s.el.clientHeight : 100, `bottom=${atBottom}, mask=${mask}`);
      assert.ok(s.calls.length <= 1, `duplicate follow: bottom=${atBottom}, mask=${mask}: ${s.calls}`);
    } finally { s.close(); }
  }
});
test("web: later revisions during smooth reveal preserve the target", async () => {
  const s = await webScrollSurface();
  try {
    s.vm.scrollToMessage("msg_1"); s.el.scrollTop = 1600; s.calls.length = 0;
    s.vm.checkScroll(); s.reactions.revision.value++; await flush();
    assert.deepEqual(s.calls, []);
  } finally { s.close(); }
});

for (const search of [false, true]) for (const completion of ["no movement", "missing scrollend"]) {
  test(`web ${search ? "search" : "reference"}: ${completion} releases reveal suppression before the next arrival`, async () => {
    const s = await webScrollSurface();
    try {
      s.setRevealTop(completion === "no movement" ? null : 1500);
      if (search) { s.props.searchQuery = "Ada"; await flush(); }
      else s.vm.scrollToMessage("msg_1");
      s.frame(); s.frame();
      if (completion === "missing scrollend") {
        s.el.scrollTop = 1600; // Smooth scrolling finishes without a scrollend event.
        s.calls.length = 0;
        s.advance(799);
        s.reactions.revision.value++; await flush();
        assert.deepEqual(s.calls, [], "suppress follow while the reveal is still bounded");
        s.advance(1);
      }
      s.props.messages.push(s.row("msg_3"));
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, 1800, "the next arrival follows after reveal suppression ends");
    } finally { s.close(); }
  });
}

for (const started of ["second frame", "scroll event"]) {
  test(`web: a reveal starting on the ${started} stays protected`, async () => {
    const s = await webScrollSurface();
    try {
      s.setRevealTop(null); s.vm.scrollToMessage("msg_1"); s.calls.length = 0;
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
      s.props.messages.push(s.row("msg_3"));
      await Promise.resolve(); s.el.scrollHeight += 200; await flush();
      assert.equal(s.el.scrollTop, 1800, "the maximum still releases suppression");
    } finally { s.close(); }
  });
}
