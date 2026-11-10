import assert from "node:assert/strict";
import test from "node:test";

// On a first visit several main-process handlers ask for the same room at once.
// They must share one `POST /join`: a repo-room join is slow on the server and
// every join counts against its limit of 10 per minute per address.
type Pending = { path: string; resolve: (value: unknown) => void; reject: (error: unknown) => void };

async function loadRoomInfo(t: test.TestContext) {
  const calls: Pending[] = [];
  t.mock.module("../main/auth.js", { namedExports: {
    DesktopApiError: class ApiError extends Error { status = 500; payload = null; },
    apiFetch: (path: string) => new Promise((resolve, reject) => {
      calls.push({ path, resolve, reject });
    }),
  } });
  const subject = await import(new URL(`../main/rooms/room-info.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/room-info.js");
  return { subject, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent opens of one room send one join and all get its answer", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const opens = [
    subject.getJoinedRoomInfo("github.com/Acme/App"),
    subject.getJoinedRoomInfo("github.com/acme/app"),
    subject.getJoinedRoomInfo(" github.com/acme/app "),
    subject.getJoinedRoomInfo("github.com/acme/app"),
  ];
  await tick();
  assert.equal(calls.length, 1, "one join request for four concurrent opens");
  const payload = { room_id: "github.com/acme/app", name: "app" };
  calls[0].resolve(payload);
  const results = await Promise.all(opens);
  for (const result of results) assert.equal(result, payload);
  assert.equal(await subject.getJoinedRoomInfo("github.com/acme/app"), payload, "the cache answers afterwards");
  assert.equal(calls.length, 1);
});

test("a failed join reaches every waiting caller and the next open retries", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const opens = [subject.getJoinedRoomInfo("alerts-demo"), subject.getJoinedRoomInfo("alerts-demo")];
  await tick();
  assert.equal(calls.length, 1);
  const failure = new Error("rate limited");
  calls[0].reject(failure);
  for (const open of opens) await assert.rejects(open, (error) => error === failure);

  const retry = subject.getJoinedRoomInfo("alerts-demo");
  await tick();
  assert.equal(calls.length, 2, "the error is not reused");
  calls[1].resolve({ room_id: "alerts-demo" });
  assert.equal((await retry).room_id, "alerts-demo");
});

test("different rooms and different create variants do not share a join", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const opens = [
    subject.getJoinedRoomInfo("room-a"),
    subject.getJoinedRoomInfo("room-b"),
    subject.getJoinedRoomInfo("room-a", { create: false }),
    subject.getJoinedRoomInfo("room-a", { create: true }),
  ];
  await tick();
  assert.deepEqual(calls.map((call) => call.path), [
    "/rooms/room-a/join",
    "/rooms/room-b/join",
    "/rooms/room-a/join?create=false",
  ]);
  calls[0].resolve({ room_id: "room-a", name: "a" });
  calls[1].resolve({ room_id: "room-b", name: "b" });
  calls[2].resolve({ room_id: "room-a", name: "a-no-create" });
  const [a, b, aNoCreate, aCreate] = await Promise.all(opens);
  assert.equal(a.name, "a");
  assert.equal(b.name, "b");
  assert.equal(aNoCreate.name, "a-no-create");
  assert.equal(aCreate, a, "create: true is the plain join");
});

test("a join answered after sign-out or an account change is not stored or shared", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const before = subject.getJoinedRoomInfo("design-lounge");
  await tick();
  subject.clearJoinedRoomInfoCache();
  const after = subject.getJoinedRoomInfo("design-lounge");
  await tick();
  assert.equal(calls.length, 2, "a caller for the new account does not wait on the old account's join");

  calls[0].resolve({ room_id: "design-lounge", name: "old account" });
  assert.equal((await before).name, "old account");
  calls[1].resolve({ room_id: "design-lounge", name: "new account" });
  assert.equal((await after).name, "new account");
  assert.equal((await subject.getJoinedRoomInfo("design-lounge")).name, "new account");

  subject.clearJoinedRoomInfoCache();
  const stale = subject.getJoinedRoomInfo("quiet-corner");
  await tick();
  subject.clearJoinedRoomInfoCache();
  calls[2].resolve({ room_id: "quiet-corner", name: "old account" });
  await stale;
  const fresh = subject.getJoinedRoomInfo("quiet-corner");
  await tick();
  assert.equal(calls.length, 4, "the old account's answer did not fill the cache");
  calls[3].resolve({ room_id: "quiet-corner", name: "new account" });
  assert.equal((await fresh).name, "new account");
});

test("forgetting a room makes the next open send a new join", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const first = subject.getJoinedRoomInfo("alerts-demo");
  await tick();
  subject.forgetJoinedRoomInfo("alerts-demo");
  const second = subject.getJoinedRoomInfo("alerts-demo");
  await tick();
  assert.equal(calls.length, 2);
  calls[0].resolve({ room_id: "alerts-demo" });
  calls[1].resolve({ room_id: "alerts-demo" });
  await Promise.all([first, second]);
});
