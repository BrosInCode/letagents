import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createRenderer, createSSRApp, effectScope, h, nextTick, reactive, ref, shallowRef, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
let Message: any, Panel: any, provider: any;
const pin = { message_id: "msg_1", sender: "<Ada>", timestamp: "2026-10-02T00:00:00Z", snippet: "<script>bad</script>", pinned_by: { name: "<Owner>" } };
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    Message = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
    Panel = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/PinnedMessages.vue", import.meta.url)))).default;
    provider = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessagePins.ts");
  } finally { await vite.close(); }
});
test("zero pins render no row; pins render one compact accessible trigger", async () => {
  assert.equal(await renderToString(createSSRApp({ render: () => h(Panel, { pins: [] }) })), "<!---->");
  const html = await renderToString(createSSRApp({ render: () => h(Panel, { pins: [pin] }) }));
  assert.match(html, /Pinned \(1\)/); assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /message-pins-panel/);
});
test("the open list escapes snippets, names and attribution as text", async () => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} } });
  let vm: any;
  const OpenPanel = { ...Panel, setup(props: any, context: any) {
    vm = Panel.setup(props, context); vm.open.value = true; return vm;
  } };
  try {
    const context: any = {};
    await renderToString(createSSRApp({ render: () => h(OpenPanel, { pins: [pin] }) }), context);
    const html = context.teleports.body;
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.match(html, /&lt;Ada&gt;/); assert.match(html, /Pinned by &lt;Owner&gt;/);
    assert.doesNotMatch(html, /<script>/);
  } finally { vm?.cleanup(); Object.assign(globalThis, { document: oldDocument, window: oldWindow }); }
});
test("the shared message marks timeline and thread replies without changing message data", async () => {
  for (const context of ["timeline", "thread-reply"]) {
    const html = await renderToString(createSSRApp({
      setup() {
        provider.provideRoomMessagePins({ state: shallowRef({ pins: [pin] }), canPin: computed(() => true), isPinned: (id: string) => id === "msg_1", toggle() {}, refresh() {} });
        return () => h(Message, { context, highlightQuery: "", searchActive: false, message: { id: "msg_1", sender: "Ada", text: "Hello", source: "browser", timestamp: pin.timestamp, attachments: [], agentIdentity: null }, threadSummary: { count: 0, unreadCount: 0, participants: [] } });
      },
    }));
    assert.match(html, /aria-label="Pinned message"[^>]*><svg[^>]*aria-hidden="true"/);
    assert.doesNotMatch(html, /📌/);
  }
});
test("overlay dismissal preserves outside clicks and handles keyboard focus through the real setup handlers", async (t) => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const listeners = new Map<string, Function>(); const focus: string[] = []; const emitted: unknown[][] = [];
  Object.assign(globalThis, { window: { innerWidth: 900, innerHeight: 600, addEventListener() {}, removeEventListener() {} },
    document: { activeElement: null, addEventListener: (type: string, fn: Function) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) } });
  const props = reactive({ pins: [pin, { ...pin, message_id: "msg_2" }] });
  let vm: any;
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup() { vm = Panel.setup(props, { expose() {}, emit: (...args: unknown[]) => emitted.push(args) }); return () => h("div"); } });
  app.provide(ssrContextKey, { modules: new Set() });
  try {
    app.mount({});
    vm.trigger.value = { getBoundingClientRect: () => ({ left: 12, bottom: 40 }), focus: () => focus.push("trigger"), contains: () => false };
    vm.panel.value = { contains: () => false, querySelectorAll: () => [0, 1].map((i) => ({ focus: () => focus.push(String(i)) })) };
    await vm.toggle(); assert.equal(vm.open.value, true); assert.equal(focus.at(-1), "0");
    vm.onKeydown({ key: "ArrowUp", preventDefault() {} }); assert.equal(focus.at(-1), "1");
    vm.onKeydown({ key: "Home", preventDefault() {} }); assert.equal(focus.at(-1), "0");
    vm.onKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); assert.equal(vm.open.value, false); assert.equal(focus.at(-1), "trigger");
    await t.test("outside press closes without cancelling the target or restoring trigger focus", async () => {
      await vm.toggle();
      const before = focus.length;
      let prevented = false;
      listeners.get("pointerdown")!({ target: {}, preventDefault() { prevented = true; } });
      assert.equal(vm.open.value, false);
      assert.equal(prevented, false);
      assert.equal(focus.length, before);
    });
    await t.test("Tab and Shift+Tab dismiss and return focus to the trigger", async () => {
      for (const shiftKey of [false, true]) {
        await vm.toggle();
        let prevented = false, stopped = false;
        vm.onKeydown({ key: "Tab", shiftKey, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
        assert.equal(vm.open.value, false);
        assert.equal(focus.at(-1), "trigger");
        assert.equal(prevented, true); assert.equal(stopped, true);
      }
    });
    await vm.toggle(); vm.choose("msg_2"); assert.deepEqual(emitted, [["reveal", "msg_2"]]);
    assert.equal(listeners.size, 0);
  } finally { app.unmount(); Object.assign(globalThis, { window: oldWindow, document: oldDocument }); }
});
test("desktop provider captures the room, clears on account changes, and refreshes after reconnect", async () => {
  const oldWindow = globalThis.window; const calls: string[] = [];
  Object.assign(globalThis, { window: { letagentsDesktop: { room: {
    getMessagePins: async (id: string) => { calls.push(id); return { room_id: id, pins: [pin] }; },
    setMessagePin: async () => ({ changed: true }),
  } } } });
  const scope = effectScope(), room = ref("room-a"); let context: any;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    provider.setMessagePinViewer({ id: "account-a" });
    scope.run(() => { context = provider.useRoomMessagePins(room, () => {}); });
    await tick(); assert.equal(context.canPin.value, true);
    room.value = "room-b"; assert.deepEqual(context.state.value.pins, []); await tick();
    provider.invalidateRoomMessagePins("room-b"); await nextTick(); await tick();
    provider.setMessagePinViewer(null); assert.equal(context.canPin.value, false); assert.deepEqual(context.state.value.pins, []); await tick();
    assert.deepEqual(calls, ["room-a", "room-b", "room-b", "room-b"]);
    scope.stop(); provider.invalidateRoomMessagePins("room-b"); await tick(); assert.equal(calls.length, 4);
  } finally { scope.stop(); Object.assign(globalThis, { window: oldWindow }); }
});

test("desktop pin errors sanitize IPC wrappers in both the list and toast, preserving the exact limit notice", async () => {
  const oldWindow = globalThis.window, notices: string[] = [];
  const limit = "This room already has 50 pinned messages. Unpin a message first.";
  let failRead = true;
  Object.assign(globalThis, { window: { letagentsDesktop: { room: {
    getMessagePins: async () => {
      if (failRead) throw new Error("Error invoking remote method 'desktop:room:message-pins': Error: Offline Authorization: Bearer abcdefghijk");
      return { pins: [pin] };
    },
    setMessagePin: async () => { throw new Error("Error invoking remote method 'desktop:room:set-message-pin': Error: " + limit); },
  } } } });
  const scope = effectScope(); let context: any;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    provider.setMessagePinViewer({ id: "pins-error-person" });
    scope.run(() => { context = provider.useRoomMessagePins(ref("pins-errors"), (message: string) => notices.push(message)); });
    await tick();
    assert.equal(context.state.value.error, "Offline Authorization:[redacted]");
    assert.deepEqual(notices, []);
    failRead = false; context.refresh(); await tick();
    context.toggle("msg_1"); await tick();
    assert.equal(context.state.value.error, limit);
    assert.deepEqual(notices, [limit]);
  } finally { scope.stop(); provider.setMessagePinViewer(null); Object.assign(globalThis, { window: oldWindow }); }
});
