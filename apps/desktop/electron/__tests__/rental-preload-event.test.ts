import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Listener = (event: unknown, payload: unknown) => void;
const listeners = new Map<string, Listener>();
const removed: Array<{ channel: string; listener: Listener }> = [];
let exposed: Record<string, unknown> | null = null;

mock.module("electron", {
  namedExports: {
    contextBridge: {
      exposeInMainWorld(_name: string, api: Record<string, unknown>) { exposed = api; },
    },
    ipcRenderer: {
      invoke: async () => null,
      on(channel: string, listener: Listener) { listeners.set(channel, listener); },
      off(channel: string, listener: Listener) { removed.push({ channel, listener }); listeners.delete(channel); },
    },
  },
});

await import("../preload.js");

test("provider event subscription forwards payload and cleanup removes the exact listener", () => {
  assert.ok(exposed);
  const rental = exposed.rental as {
    onProviderEvent(callback: (event: unknown) => void): () => void;
  };
  const received: unknown[] = [];
  const unsubscribe = rental.onProviderEvent((event) => received.push(event));
  const listener = listeners.get("desktop:rental:provider-event");
  assert.ok(listener);
  const payload = { kind: "request.created", sessionId: "rsess_1" };
  listener({}, payload);
  assert.deepEqual(received, [payload]);

  unsubscribe();
  assert.equal(listeners.has("desktop:rental:provider-event"), false);
  assert.deepEqual(removed, [{ channel: "desktop:rental:provider-event", listener }]);
});
