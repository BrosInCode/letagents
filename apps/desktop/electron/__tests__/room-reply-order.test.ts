import assert from "node:assert/strict";
import test from "node:test";

async function load(t: test.TestContext, options: { local?: boolean; respond?: (path: string, init?: RequestInit) => unknown } = {}) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  t.mock.module("../main/auth.js", {
    namedExports: {
      apiFetch: async (path: string, init?: RequestInit) => {
        calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return options.respond?.(path, init) ?? {};
      },
    },
  });
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud", localRoom: null }),
      cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier.trim(),
    },
  });
  const subject = await import(new URL(`../main/rooms/reply-order.js?${t.name}`, import.meta.url).href) as
    typeof import("../main/rooms/reply-order.js");
  return { subject, calls };
}

const room = "github.com/org/repo";
const path = `/rooms/${encodeURIComponent(room)}/agent-reply-order`;

test("a room that has not chosen shows the switch off", async (t) => {
  const { subject, calls } = await load(t, {
    respond: () => ({ room_id: room, order: "parallel", chosen: false, can_manage: false }),
  });
  assert.deepEqual(await subject.getDesktopReplyOrder(room), { enabled: false, can_manage: false });
  assert.deepEqual(calls, [{ path, method: "GET", body: null }]);
});

test("the switch maps on to sequential and off to parallel", async (t) => {
  const { subject, calls } = await load(t, {
    respond: (_path, init) => ({
      room_id: room,
      order: JSON.parse(String(init?.body)).order,
      chosen: true,
      can_manage: true,
    }),
  });
  assert.deepEqual(await subject.setDesktopReplyOrder(room, true), { enabled: true, can_manage: true });
  assert.deepEqual(await subject.setDesktopReplyOrder(room, false), { enabled: false, can_manage: true });
  assert.deepEqual(calls, [
    { path, method: "PUT", body: { order: "sequential" } },
    { path, method: "PUT", body: { order: "parallel" } },
  ]);
});

test("bad input and rooms kept on this computer never reach the server", async (t) => {
  const { subject, calls } = await load(t, { local: true });
  await assert.rejects(subject.getDesktopReplyOrder("  "), /Choose a room/);
  await assert.rejects(subject.setDesktopReplyOrder(room, "yes" as unknown as boolean), /answer in turns/);
  await assert.rejects(subject.getDesktopReplyOrder(room), /cloud room/);
  assert.deepEqual(calls, []);
});
