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

test("a join in flight when the room is forgotten is not cached, so the next open asks the server", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  const first = subject.getJoinedRoomInfo("alerts-demo");
  await tick();
  // The stream lost access to the room while the join was on its way.
  subject.forgetJoinedRoomInfo("alerts-demo");
  calls[0].resolve({ room_id: "alerts-demo", role: "admin" });
  assert.equal((await first).role, "admin", "the caller still gets the answer it asked for");

  const next = subject.getJoinedRoomInfo("alerts-demo");
  await tick();
  assert.equal(calls.length, 2, "the stale answer was not stored");
  calls[1].reject(new Error("forbidden"));
  await assert.rejects(next, /forbidden/);
});

test("sign-out clears joined rooms again after the token is removed", async (t) => {
  const events: string[] = [];
  let release: () => void = () => {};
  const unexpected = () => { throw new Error("unexpected auth/setup operation"); };
  t.mock.module("../main/organizations.js", { namedExports: { registerOrganizationIpcHandlers: () => {} } });
  t.mock.module("../main/auth.js", { namedExports: {
    cancelDeviceAuthFlow: unexpected, pollDeviceAuthFlow: unexpected, startDeviceAuthFlow: unexpected,
    getDesktopAuthStatus: async () => ({ signedIn: false }),
    signOutDesktopAuth: async () => { events.push("token removed"); },
    setAuthAuthorizedHandler: () => {}, setAuthInvalidatedHandler: () => {},
  } });
  t.mock.module("../main/mcp-setup.js", { namedExports: {
    buildMcpInstallState: unexpected, completeMcpOnboarding: unexpected, installLetAgentsMcpServer: unexpected,
    installLetAgentsMcpServers: unexpected, refreshInstalledLetAgentsMcpServerAuth: async () => {},
  } });
  t.mock.module("../main/notifications.js", { namedExports: {
    refreshDesktopNotificationRegistration: async () => {},
    // The network delete that can hold sign-out for up to 30 s.
    unregisterDesktopNotificationAccount: () => new Promise<void>((resolve) => {
      events.push("unregister started");
      release = resolve;
    }),
  } });
  t.mock.module("../main/rooms.js", { namedExports: { clearJoinedRoomInfoCache: () => { events.push("joined rooms cleared"); } } });
  t.mock.module("../main/attachments/html-demo-inline.js", { namedExports: { clearInlineHtmlDemoCache: () => {} } });
  t.mock.module("../main/rooms/live-demo.js", { namedExports: { reconnectLiveDemos: () => {} } });
  t.mock.module("../main/external-url.js", { namedExports: { openAllowedExternalUrl: unexpected } });
  t.mock.module("../main/supervisor-grant.js", { namedExports: {
    getDesktopSupervisorGrantMetadata: unexpected, provisionDesktopSupervisorGrant: unexpected,
    revokeDesktopSupervisorGrant: unexpected, getDesktopSupervisorGrantStorageStatus: unexpected,
  } });
  t.mock.module("../main/supervisor-grant-coordinator.js", { namedExports: { supervisorGrantCoordinator: {
    scheduleCredentialRecovery: () => {}, observeSecureStorageAvailability: () => {},
  } } });
  const { registerDesktopAuthAndSetupIpcHandlers } = await import(new URL(`../main/ipc-handlers/auth-setup.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/ipc-handlers/auth-setup.js");
  const handlers = new Map<string, () => Promise<unknown>>();
  registerDesktopAuthAndSetupIpcHandlers({ handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler) } as never);
  const signOut = handlers.get("desktop:auth:sign-out");
  assert.ok(signOut);

  const done = signOut();
  await tick();
  assert.deepEqual(events, ["joined rooms cleared", "unregister started"]);
  release();
  await done;
  assert.deepEqual(events, ["joined rooms cleared", "unregister started", "token removed", "joined rooms cleared"]);
});
