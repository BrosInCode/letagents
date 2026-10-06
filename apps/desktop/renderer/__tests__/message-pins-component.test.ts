import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createRenderer, createSSRApp, effectScope, h, nextTick, reactive, ref, shallowRef, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
let Message: any, Panel: any, provider: any, visibility: any;
const pin = { message_id: "msg_1", sender: "<Ada>", timestamp: "2026-10-02T00:00:00Z", snippet: "<script>bad</script>", pinned_by: { name: "<Owner>" } };
before(async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    Message = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
    Panel = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/PinnedMessages.vue", import.meta.url)))).default;
    visibility = await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/usePinnedMessageVisibility.ts", import.meta.url)));
    provider = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessagePins.ts");
  } finally { await vite.close(); }
});
test("zero pins render nothing; each pin has a labelled keyboard-accessible edge marker", async () => {
  assert.equal(await renderToString(createSSRApp({ render: () => h(Panel, { pins: [] }) })), "<!---->");
  const html = await renderToString(createSSRApp({ render: () => h(Panel, { pins: [pin, { ...pin, message_id: "msg_2" }] }) }));
  assert.match(html, /<nav[^>]*aria-label="Pinned messages"/);
  assert.equal((html.match(/data-pin-entry/g) || []).length, 2);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.match(html, /Pinned message from &lt;Ada&gt;/);
  assert.doesNotMatch(html, /Pinned \(2\)|message-pins-trigger|message-pin-preview/);
  assert.doesNotMatch(html, / data-message-id=/, "markers must not match timeline focus-restoration selectors");
  const failed = await renderToString(createSSRApp({ render: () => h(Panel, { pins: [pin], error: "Offline" }) }));
  assert.match(failed, /<button[^>]*aria-label="Offline Retry loading pinned messages"[^>]*>Retry<\/button>/);
});
test("hover expands one compact list with escaped, readable previews for every pin", async () => {
  let vm: any;
  const OpenPanel = { ...Panel, setup(props: any, context: any) {
    vm = Panel.setup(props, context); vm.expanded.value = true; return vm;
  } };
  const html = await renderToString(createSSRApp({ render: () => h(OpenPanel, {
    pins: [pin, { ...pin, message_id: "msg_2", snippet: "## Release 0.1.108 update" }],
  }) }));
  assert.match(html, /data-expanded="true"/);
  assert.equal((html.match(/class="message-pin-title"/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /Release 0.1.108 update/);
  assert.doesNotMatch(html, /<script>|role="tooltip"|message-pin-byline|Pinned by/);
  assert.equal(vm.senderLabel("Ada | Owner's agent | Codex"), "Ada");
  assert.equal(vm.previewText("**Merged** `abc` [review](https://example.com/long-link)"), "Merged abc review");
  assert.equal(vm.previewText("## Session start\n\nThe next line"), "Session start The next line");
  assert.equal(vm.previewText("   "), "Message without text");
});
test("the shared message marks timeline and thread replies without changing message data", async () => {
  for (const context of ["timeline", "thread-reply"]) {
    const html = await renderToString(createSSRApp({
      setup() {
        provider.provideRoomMessagePins({ state: shallowRef({ pins: [pin] }), canPin: computed(() => true), isPinned: (id: string) => id === "msg_1", toggle() {}, refresh() {} });
        return () => h(Message, { context, activeThreadRoot: false, highlightQuery: "", searchActive: false, message: { id: "msg_1", sender: "Ada", text: "Hello", source: "browser", timestamp: pin.timestamp, attachments: [], agentIdentity: null }, threadSummary: { count: 0, unreadCount: 0, participants: [] } });
      },
    }));
    assert.match(html, /aria-label="Pinned message"[^>]*><svg[^>]*aria-hidden="true"/);
    assert.match(html, /class="room-message-reply-action room-message-pin-action"[^>]*aria-label="Unpin message"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(html, /📌/);
  }
});
test("the hover list keeps pointer and keyboard access stable and preserves focus as pins change", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const listeners = new Map<string, Function>(), focus: string[] = [], emitted: unknown[][] = [];
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: true }) },
    document: { activeElement: null,
      addEventListener: (type: string, fn: Function) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) } });
  const props = reactive({ pins: [pin, { ...pin, message_id: "msg_2" }] });
  let vm: any;
  const inside = {}, outside = {};
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup() { vm = Panel.setup(props, { expose() {}, emit: (...args: unknown[]) => emitted.push(args) }); return () => h("div"); } });
  app.provide(ssrContextKey, { modules: new Set() });
  const settleClose = () => new Promise((resolve) => setTimeout(resolve, 120));
  try {
    app.mount({});
    vm.rail.value = { contains: (target: unknown) => target === inside, parentElement: { focus: () => focus.push("room") },
      querySelectorAll: () => props.pins.map((p) => ({ focus: () => { focus.push(p.message_id); vm.openPanel(); } })) };
    vm.onPointerEnter({ pointerType: "touch" }); assert.equal(vm.expanded.value, false);
    vm.onPointerEnter({ pointerType: "mouse" }); await nextTick();
    assert.equal(vm.expanded.value, true); assert.equal(listeners.size, 2);
    vm.scheduleClose(); vm.onPointerEnter({ pointerType: "mouse" }); await settleClose();
    assert.equal(vm.expanded.value, true, "re-entering the panel cancels a pending close");
    vm.scheduleClose(); await settleClose();
    assert.equal(vm.expanded.value, false, "leaving a pointer-opened panel dismisses it");
    vm.openPanel(); await nextTick();
    listeners.get("keydown")!({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.equal(vm.expanded.value, false, "Escape dismisses a mouse-opened panel while focus is elsewhere");
    vm.openPanel(); await nextTick();
    listeners.get("pointerdown")!({ target: inside }); assert.equal(vm.expanded.value, true);
    listeners.get("pointerdown")!({ target: outside, preventDefault() { assert.fail("outside presses retain their default action"); } });
    assert.equal(vm.expanded.value, false);
    Object.assign(document, { activeElement: inside });
    vm.openPanel(); vm.scheduleClose(); await settleClose();
    assert.equal(vm.expanded.value, true, "a keyboard-focused panel remains open when the pointer leaves");
    vm.onFocusOut({ relatedTarget: inside }); assert.equal(vm.expanded.value, true, "moving focus between rows does not collapse the panel");
    vm.onFocusOut({ relatedTarget: outside }); assert.equal(vm.expanded.value, false);
    vm.onKeydown({ key: "ArrowUp", preventDefault() {} }); assert.equal(focus.at(-1), "msg_2");
    assert.equal(vm.expanded.value, true);
    vm.onKeydown({ key: "Home", preventDefault() {} }); assert.equal(focus.at(-1), "msg_1");
    vm.onKeydown({ key: "End", preventDefault() {} }); assert.equal(focus.at(-1), "msg_2");
    let tabPrevented = false;
    vm.onKeydown({ key: "Tab", preventDefault() { tabPrevented = true; } });
    assert.equal(tabPrevented, false, "Tab can leave the rail normally");
    vm.onKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    assert.equal(vm.expanded.value, false);
    await nextTick(); assert.equal(listeners.size, 0);
    vm.choose("msg_2");
    assert.deepEqual(emitted, [["reveal", "msg_2"]]);
    assert.equal(vm.selectedId.value, "msg_2"); assert.equal(vm.expanded.value, false);
    props.pins = [{ ...pin, message_id: "msg_3" }, ...props.pins]; await nextTick(); await nextTick();
    assert.equal(focus.at(-1), "msg_2", "a newly pinned message does not displace the focused marker");
    props.pins = [pin]; await nextTick(); await nextTick();
    assert.equal(focus.at(-1), "msg_1"); assert.equal(vm.selectedId.value, null);
    props.pins = []; await nextTick(); await nextTick();
    assert.equal(focus.at(-1), "room", "removing the final pin preserves keyboard focus");
    assert.equal(vm.expanded.value, false);
    vm.openPanel(); await nextTick();
  } finally { app.unmount(); assert.equal(listeners.size, 0); Object.assign(globalThis, { window: oldWindow, document: oldDocument }); }
});
test("Hide pinned messages is off by default, persists, hides the rail, and preserves pin membership", async () => {
  const oldWindow = globalThis.window;
  const saved = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } } });
  const { pinnedMessagesHidden, togglePinnedMessages } = visibility.usePinnedMessageVisibility();
  const pins = [pin];
  try {
    assert.equal(visibility.readPinnedMessagesHidden(), false);
    assert.equal(pinnedMessagesHidden.value, false);
    togglePinnedMessages();
    assert.equal(visibility.readPinnedMessagesHidden(), true, "a new app session reads the saved preference");
    assert.equal(await renderToString(createSSRApp({ render: () => h(Panel, { pins }) })), "<!---->");
    assert.deepEqual(pins, [pin]);
    togglePinnedMessages();
    assert.equal(visibility.readPinnedMessagesHidden(), false);
    assert.match(await renderToString(createSSRApp({ render: () => h(Panel, { pins }) })), /data-pin-entry/);
    Object.assign(window, { localStorage: { getItem() { throw Error("unavailable"); }, setItem() { throw Error("unavailable"); } } });
    assert.equal(visibility.readPinnedMessagesHidden(), false);
    togglePinnedMessages(); assert.equal(pinnedMessagesHidden.value, true);
    togglePinnedMessages();
  } finally {
    if (pinnedMessagesHidden.value) togglePinnedMessages();
    Object.assign(globalThis, { window: oldWindow });
  }
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
