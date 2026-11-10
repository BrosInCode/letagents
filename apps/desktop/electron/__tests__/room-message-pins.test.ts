import assert from "node:assert/strict";
import test from "node:test";

type Call = { path: string; method: string };

async function load(t: test.TestContext, options: { local?: boolean; token?: () => string; respond?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  t.mock.module("../main/auth.js", {
    namedExports: {
      readStoredAuth: async () => ({ token: options.token?.() ?? "pins-account" }),
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

test("concurrent pin reads for one switched room share HTTP, then release the result", async (t) => {
  let resolve!: (value: unknown) => void;
  const response = new Promise((done) => { resolve = done; });
  const { subject, calls } = await load(t, { respond: () => response });
  const reads = Array.from({ length: 6 }, () => subject.getDesktopMessagePins(room));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const pins = { room_id: room, available: true, pins: [] };
  resolve(pins);
  assert.deepEqual(await Promise.all(reads), Array(6).fill(pins));
  await subject.getDesktopMessagePins(room);
  assert.equal(calls.length, 2, "completed reads are not cached across invalidations");
});

test("pin reads do not share across rooms, accounts, writes, or failures", async (t) => {
  let token = "a";
  const pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const { subject, calls } = await load(t, { token: () => token, respond: ({ method }) => method !== "GET" ? { changed: true }
    : new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const first = subject.getDesktopMessagePins(room);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const other = subject.getDesktopMessagePins("other-room");
  token = "b";
  const account = subject.getDesktopMessagePins(room);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await subject.setDesktopMessagePin(room, "msg_1", true);
  const afterWrite = subject.getDesktopMessagePins(room);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "GET").length, 4);
  pending.forEach(({ resolve }) => resolve({ pins: [] }));
  await Promise.all([first, other, account, afterWrite]);
  const failed = subject.getDesktopMessagePins(room);
  const rejection = assert.rejects(failed, /offline/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending.at(-1)!.reject(new Error("offline"));
  await rejection;
  const retry = subject.getDesktopMessagePins(room);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "GET").length, 6);
  pending.at(-1)!.resolve({ pins: [] });
  await retry;
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
