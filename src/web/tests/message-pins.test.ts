import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createSSRApp, effectScope, h, nextTick, ref, shallowRef } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
let pins: any, auth: any, Message: any;
const pin = { message_id: "msg_1", sender: "Ada", timestamp: "2026-10-02T00:00:00Z", snippet: "Hello", pinned_by: { name: "Owner" } };
before(async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    pins = await vite.ssrLoadModule("/src/composables/roomMessagePins.ts");
    auth = (await vite.ssrLoadModule("/src/composables/useAuth.ts")).useAuth();
    Message = (await vite.ssrLoadModule("/src/components/room/ChatMessage.vue")).default;
  } finally { await vite.close(); }
});
test("web messages and thread replies show pin membership from the separate provider", async () => {
  for (const thread_root_id of [null, "msg_9"]) {
    const html = await renderToString(createSSRApp({ setup() {
      pins.provideRoomMessagePins({ state: shallowRef({ pins: [pin] }), canPin: computed(() => true), isPinned: () => true, toggle() {} });
      return () => h(Message, { roomIdentifier: "room", message: { id: "msg_1", sender: "Ada", text: "Hello", source: "browser", timestamp: pin.timestamp, thread_root_id } });
    } }));
    assert.match(html, /aria-label="Pinned message"[^>]*><svg[^>]*aria-hidden="true"/);
    assert.doesNotMatch(html, /📌/);
  }
});
test("web pins encode the room, reset on sign-out, and repair matching invalidations", async (t) => {
  const calls: Array<[string, string]> = [];
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    calls.push([String(input), init?.method ?? "GET"]);
    if (input === "/auth/session") return new Response(JSON.stringify({ authenticated: true, account: { id: "a", login: "ada" } }));
    return new Response(JSON.stringify({ room_id: "room/a b", pins: [pin], changed: true }));
  });
  await auth.checkSession();
  const room = ref("room/a b"), scope = effectScope(); let context: any;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    scope.run(() => { context = pins.useRoomMessagePins(room, () => {}); });
    await tick(); assert.equal(context.canPin.value, true);
    context.toggle("msg_1"); await tick();
    assert.ok(calls.some(([path, method]) => path === "/rooms/room%2Fa%20b/messages/msg_1/pin" && method === "DELETE"));
    const before = calls.length;
    pins.publishMessagePinInvalidation("other"); await nextTick(); await tick(); assert.equal(calls.length, before);
    pins.publishMessagePinInvalidation(room.value); await nextTick(); await tick(); assert.equal(calls.length, before + 1);
    await auth.signOut(); assert.equal(context.canPin.value, false);
    room.value = ""; assert.deepEqual(context.state.value.pins, []);
    scope.stop();
  } finally { scope.stop(); }
});
