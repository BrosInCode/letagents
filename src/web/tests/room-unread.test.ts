import "../../../shared/room-unread.test.mjs";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey } from "vue";

let createRoomUnreadClient: any, useUnreadTimeline: any, Message: any, MessageList: any, unreadMenuKey: any;
before(async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    ({ createRoomUnreadClient, useUnreadTimeline, unreadMenuKey } = await vite.ssrLoadModule(fileURLToPath(new URL("../../../shared/room-unread-client.ts", import.meta.url))));
    Message = (await vite.ssrLoadModule("/src/components/room/ChatMessage.vue")).default;
    MessageList = (await vite.ssrLoadModule("/src/components/room/MessageList.vue")).default;
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
    setTimeout: () => 0,
  });
  Object.assign(globalThis, { window: win, document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }), CSS: { escape: (id: string) => id } });
  const message = (id: string) => ({ id, sender: "Ada", source: "browser", text: id, timestamp: "2026-10-02T00:00:00Z", thread_root_id: null });
  const props = reactive({ messages: [message("msg_3")], roomIdentifier: "alias", unreadRoomId: "canonical", messagesLoaded: false, hasOlderMessages: true, isLoadingOlderMessages: false });
  let vm: any, olderReads = 0;
  const el = Object.assign(new EventTarget(), {
    scrollHeight: 1500, clientHeight: 400, scrollTop: 1100,
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
