import assert from "node:assert/strict";
import test from "node:test";

type Call = { path: string; method: string };

async function load(t: test.TestContext, options: { local?: boolean; respond?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  t.mock.module("../main/auth.js", {
    namedExports: {
      apiFetch: async (path: string, init?: RequestInit) => {
        const call = { path, method: init?.method ?? "GET" };
        calls.push(call);
        return options.respond?.(call) ?? {};
      },
    },
  });
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud", localRoom: null }),
      cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier.trim(),
    },
  });
  const subject = await import(new URL(`../main/rooms/pins.js?${t.name}`, import.meta.url).href) as
    typeof import("../main/rooms/pins.js");
  return { subject, calls };
}

const room = "github.com/org/repo";
const roomPath = `/rooms/${encodeURIComponent(room)}/messages`;

test("pins use encoded cloud rooms and idempotent verbs", async (t) => {
  const { subject, calls } = await load(t, { respond: () => ({ room_id: room, pins: [], changed: true }) });
  await subject.getDesktopMessagePins(room);
  await subject.setDesktopMessagePin(room, "msg_12", true);
  await subject.setDesktopMessagePin(room, "msg_12", false);
  assert.deepEqual(calls, [{ path: `${roomPath}/pins`, method: "GET" }, { path: `${roomPath}/msg_12/pin`, method: "PUT" }, { path: `${roomPath}/msg_12/pin`, method: "DELETE" }]);
});
test("local rooms never read or write cloud pins", async (t) => {
  const { subject, calls } = await load(t, { local: true });
  assert.deepEqual(await subject.getDesktopMessagePins(room), { room_id: room, available: false, pins: [] });
  await assert.rejects(subject.setDesktopMessagePin(room, "msg_1", true), /cloud room/);
  assert.deepEqual(calls, []);
});
test("invalid ids and pin actions cannot reach the server", async (t) => {
  const { subject, calls } = await load(t);
  for (const id of ["msg_0", "msg_1/x", "pending", "msg_2147483648"]) await assert.rejects(subject.setDesktopMessagePin(room, id, true));
  await assert.rejects(subject.setDesktopMessagePin(room, "msg_1", "yes" as unknown as boolean));
  assert.deepEqual(calls, []);
});
