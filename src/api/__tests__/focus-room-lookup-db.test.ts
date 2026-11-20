import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Response } from "express";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const roomsDb = url ? await import("../db/rooms.js") : null;
const resolution = url ? await import("../rooms/resolution.js") : null;
const gitRouting = url ? await import("../github/git-room-routing.js") : null;
const rental = url ? await import("../rental/room-projection.js") : null;
const apiRoutes = url ? await import("../server/routes.js") : null;
const presenceRoutes = url ? await import("../routes/rooms/presence/index.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { apiRoutes?.closeApiRouteEventBroker(); await client?.pool.end(); });

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const unique = (label: string) => `${label}-${suffix}-${++sequence}`;

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

/** Insert a focus row directly, as an older code path or a race could leave it. */
async function insertFocusRow(input: {
  parentRoomId: string;
  focusKey: string;
  archivedAt: string | null;
  createdAt: string;
}): Promise<string> {
  const id = await roomsDb!.buildFocusRoomId();
  await client!.pool.query(
    `INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, focus_archived_at, created_at)
     VALUES ($1, $2, 'focus', $3, $4, 'active', $5, $6)`,
    [id, `Row ${id}`, input.parentRoomId, input.focusKey, input.archivedAt, input.createdAt],
  );
  return id;
}

test("one active branch room: every lookup returns it", options, async () => {
  const parent = await db!.createProjectWithName(`github.com/${unique("lookup-active")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/one" });
  const { room } = await db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey });

  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey))?.id, room.id);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, room.id);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, room.id);
});

test("one archived branch room: a read returns 404, a join returns the archived room", options, async () => {
  const parent = await db!.createProjectWithName(`github.com/${unique("lookup-archived")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/two" });
  const { room } = await db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey });
  assert.equal((await db!.archiveFocusRoom(parent.id, focusKey))?.archived, true);
  const locator = `${parent.id}/focus/${focusKey}`;

  assert.equal(await db!.getFocusRoomByKey(parent.id, focusKey), undefined);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, room.id);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, room.id);

  // Read (GET-style resolution): 404.
  assert.equal(await resolution!.resolveExistingRoomRequest(locator), undefined);
  const readRes = fakeResponse();
  assert.equal(await resolution!.resolveRoomOrReply(locator, readRes as unknown as Response), null);
  assert.equal(readRes.statusCode, 404);

  // Join (allowCreate): the archived room, still archived.
  const joinRes = fakeResponse();
  const joined = await resolution!.resolveRoomOrReply(locator, joinRes as unknown as Response, { allowCreate: true });
  assert.equal(joined?.id, room.id);
  assert.ok(joined?.focus_archived_at);
  assert.equal(joinRes.statusCode, 200);
});

test("an active row and older archived rows with one key: lookups that include archived rows return the active row", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-mixed"));
  const focusKey = unique("task");
  const archivedOld = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });
  const active = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: null, createdAt: "2026-03-01T00:00:00.000Z" });
  assert.notEqual(archivedOld, active);

  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey))?.id, active);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, active);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, active);
  // Activating finds the active row and leaves it alone (no unique-index clash).
  assert.deepEqual(
    { id: (await db!.activateFocusRoom(parent.id, focusKey))?.room.id, activated: false },
    { id: active, activated: false },
  );
});

test("only archived rows with one key: lookups return the newest archived row", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-archived-only"));
  const focusKey = unique("task");
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const newest = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-03-02T00:00:00.000Z", createdAt: "2026-03-01T00:00:00.000Z" });
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(await db!.getFocusRoomByKey(parent.id, focusKey), undefined);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, newest);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, newest);
  // The archive route's "already archived" answer is the most recently
  // archived row (staging returned the first row read, usually the oldest).
  assert.deepEqual(await db!.archiveFocusRoom(parent.id, focusKey).then((r) => ({ id: r?.room.id, archived: r?.archived })), { id: newest, archived: false });
});

test("rental provisioning reuses an existing room with its key, archived or not", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-rental"));
  const now = new Date().toISOString();
  const renter = unique("renter");
  const provider = unique("provider");
  const listing = unique("listing");
  const sessionId = unique("session");
  await client!.pool.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     VALUES ($1, 'github', $1, $1, $3, $3), ($2, 'github', $2, $2, $3, $3)`,
    [renter, provider, now],
  );
  await client!.pool.query(
    `INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind) VALUES ($1, $2, 'Provider', 'codex')`,
    [listing, provider],
  );
  await client!.pool.query(
    `INSERT INTO rental_sessions (id, listing_id, renter_account_id, provider_account_id, target_room_id, task_title, task_prompt, status)
     VALUES ($1, $2, $3, $4, $5, 'Task', 'Prompt', 'accepted')`,
    [sessionId, listing, renter, provider, parent.id],
  );
  const focusKey = `rental:${sessionId}`;
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const newest = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });

  const provisioned = await rental!.provisionRentalRoom({ sessionId, parentRoomId: parent.id, providerDisplayName: "Provider" });
  assert.equal(provisioned.roomId, newest);
});

test("archiving a live room next to an older archived one: a retry answers with the room just archived", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-archive-retry"));
  const focusKey = unique("task");
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const live = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: null, createdAt: "2026-02-01T00:00:00.000Z" });

  const first = await db!.archiveFocusRoom(parent.id, focusKey);
  assert.deepEqual({ id: first?.room.id, archived: first?.archived }, { id: live, archived: true });
  const retry = await db!.archiveFocusRoom(parent.id, focusKey);
  assert.deepEqual({ id: retry?.room.id, archived: retry?.archived }, { id: live, archived: false });
});

/** The SQL statements `run` sends through the pool. */
async function countStatements<T>(run: () => Promise<T>): Promise<{ result: T; statements: number }> {
  const pool = client!.pool;
  const original = pool.query;
  let statements = 0;
  pool.query = function (this: unknown, ...args: unknown[]) {
    statements += 1;
    return (original as (...rest: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    return { result: await run(), statements };
  } finally {
    pool.query = original;
  }
}

/** What a route sees: the canonical id, the room, its nature, and the reply when there is no room. */
async function resolveBothWays(requestRoomId: string) {
  const before = fakeResponse();
  const canonical = await resolution!.resolveCanonicalRoomRequestId(requestRoomId);
  const beforeProject = await resolution!.resolveRoomOrReply(canonical, before as unknown as Response);
  const after = fakeResponse();
  const combined = await resolution!.resolveRoomRequestOrReply(requestRoomId, after as unknown as Response);
  const { getRoomNature } = await import("../rooms/room-nature.js");
  const view = (roomId: string, project: typeof beforeProject, res: ReturnType<typeof fakeResponse>) => ({
    roomId,
    project,
    nature: project ? getRoomNature(project) : null,
    status: res.statusCode,
    body: res.body,
  });
  return { before: view(canonical, beforeProject, before), after: view(combined.roomId, combined.project, after) };
}

test("the one-statement room resolver answers like the canonical id and resolve pair", options, async () => {
  const { normalizeRoomId } = await import("../rooms/routing.js");
  const repoOwner = unique("Resolve-Owner");
  const repo = await db!.createProjectWithName(`github.com/${repoOwner}/app`);
  const named = await db!.createProjectWithName(unique("resolve-named"));
  const joinCodeRoom = await db!.createProject();
  const alias = unique("resolve-alias");
  await db!.createRoomAlias(named.id, alias);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/resolve" });
  const { room: focusRoom } = await db!.getOrCreateGitChildRoom({ parentRoomId: repo.id, focusKey });
  const archivedKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/archived" });
  await db!.getOrCreateGitChildRoom({ parentRoomId: repo.id, focusKey: archivedKey });
  await db!.archiveFocusRoom(repo.id, archivedKey);
  const tombstoned = await db!.createProjectWithName(unique("resolve-tombstoned"));
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1)", [tombstoned.id]);
  const goneId = unique("resolve-gone");
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1)", [goneId]);
  const tombstonedCodeRoom = await db!.createProject();
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1)", [tombstonedCodeRoom.id]);

  const requests = [
    repo.id, `GitHub.com/${repoOwner}/App`, ` ${repo.id} `,
    named.id, named.id.toUpperCase(),
    joinCodeRoom.id, joinCodeRoom.id.toLowerCase(),
    alias, alias.toUpperCase(),
    focusRoom.id, `${repo.id}/focus/${focusKey}`, `${repo.id}/focus/${archivedKey}`, `${repo.id}/focus/no-such-key`,
    `github.com/${unique("missing")}/app/focus/${focusKey}`,
    unique("resolve-missing"), "focus_999999999", "ZZZZ-9999",
    tombstoned.id, goneId, tombstonedCodeRoom.id, tombstonedCodeRoom.id.toLowerCase(),
  ];
  for (const raw of requests) {
    for (const requestRoomId of new Set([raw, normalizeRoomId(raw)])) {
      const { before, after } = await resolveBothWays(requestRoomId);
      assert.deepEqual(after, before, requestRoomId);
    }
  }

  // Spot checks that the cases above cover each answer.
  assert.equal((await resolveBothWays(focusRoom.id)).after.project?.id, focusRoom.id);
  assert.equal((await resolveBothWays(alias)).after.project?.id, named.id);
  assert.equal((await resolveBothWays(goneId)).after.status, 410);
  assert.equal((await resolveBothWays(tombstoned.id)).after.status, 410);
  assert.equal((await resolveBothWays(unique("resolve-missing"))).after.status, 404);
});

test("a room named by its exact id costs one statement instead of three", options, async () => {
  const repo = await db!.createProjectWithName(`github.com/${unique("resolve-count")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/count" });
  const { room: focusRoom } = await db!.getOrCreateGitChildRoom({ parentRoomId: repo.id, focusKey });
  const joinCodeRoom = await db!.createProject();

  for (const [roomId, pairStatements] of [[repo.id, 3], [focusRoom.id, 3], [joinCodeRoom.id, 2]] as const) {
    const pair = await countStatements(async () => {
      const canonical = await resolution!.resolveCanonicalRoomRequestId(roomId);
      return resolution!.resolveRoomOrReply(canonical, fakeResponse() as unknown as Response);
    });
    assert.equal(pair.statements, pairStatements, roomId);
    const combined = await countStatements(() =>
      resolution!.resolveRoomRequestOrReply(roomId, fakeResponse() as unknown as Response));
    assert.equal(combined.statements, 1, roomId);
    assert.deepEqual(combined.result, { roomId, project: pair.result });
  }
});

type RegisteredRoute = { method: string; path: unknown; handlers: Array<(...args: any[]) => unknown> };

/** An app that records the routes registered on it. Callable, as `createServer` takes it as a handler. */
function recordingApp(): { app: unknown; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const app = new Proxy(function recordingApp() {}, {
    get: (_target, method: string) => (path: unknown, ...handlers: unknown[]) => {
      routes.push({ method, path, handlers: handlers.filter((handler) => typeof handler === "function") as RegisteredRoute["handlers"] });
    },
  });
  return { app, routes };
}

/** Run the first registered route that Express would pick for this request, and record the reply and the SQL. */
async function driveRoute(routes: RegisteredRoute[], method: string, path: string, principal: Record<string, unknown> = {}) {
  const route = routes.find((candidate) => candidate.method === method && candidate.path instanceof RegExp && candidate.path.test(path));
  assert.ok(route, `${method} ${path} is registered`);
  const params: Record<string, string> = {};
  (route.path as RegExp).exec(path)!.slice(1).forEach((value, index) => { if (value !== undefined) params[index] = value; });
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    headersSent: false, destroyed: false, locals: {},
    send() { return res; }, set() { return res; }, setHeader() {}, header() { return res; }, writeHead() { return res; },
    flushHeaders() {}, write() { return true; }, end() {}, on() { return res; }, once() { return res; }, off() { return res; }, removeListener() { return res; },
  };
  const req = { method: method.toUpperCase(), path, url: path, originalUrl: path, params, query: {}, body: {}, headers: {}, on() {}, once() {}, get() { return undefined; }, ...principal };
  const pool = client!.pool;
  const original = pool.query;
  const sql: string[] = [];
  pool.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    sql.push(typeof first === "string" ? first : first?.text ?? "");
    return (original as (...rest: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    for (const handler of route.handlers) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) break;
    }
  } finally {
    pool.query = original;
  }
  return { status: res.statusCode, body: res.body, roomStatements: sql.filter((text) => /"rooms"|deleted_rooms|room_aliases/.test(text)).length };
}

test("the busiest room routes, as the server registers them, read the room in one statement", options, async () => {
  const { app, routes } = recordingApp();
  apiRoutes!.registerApiRoutes(app as never);
  const room = (await db!.createProjectWithName(unique("resolve-wiring"))).id;
  // Routes for people only refuse a caller without an app session before they
  // resolve the room; a signed-in stranger reaches the room read and then 403.
  const stranger = { authKind: "session", sessionAccount: { account_id: "acct_resolve_wiring", login: "resolve-wiring", provider: "github", provider_user_id: "1", display_name: null, avatar_url: null } };
  const hot: Array<[string, string, Record<string, unknown>?]> = [
    ["get", `/rooms/${room}/messages/stream`],
    ["get", `/rooms/${room}/messages/poll`],
    ["post", `/rooms/${room}/agent-sessions/agent_session_1/native-activity`],
    ["get", `/rooms/${room}/attention`],
    ["get", `/rooms/${room}/reasoning-sessions`],
    ["get", `/rooms/${room}/tasks`],
    ["get", `/rooms/${room}/messages`],
    ["get", `/rooms/${room}/presence`],
    ["get", `/rooms/${room}/participants`],
    ["get", `/rooms/${room}/board-settings`],
    ["get", `/rooms/${room}/focus-rooms`],
    ["get", `/rooms/${room}/activity-history`],
    ["get", `/rooms/${room}/board-intents`],
    ["get", `/rooms/${room}/artifacts`],
    ["get", `/rooms/${room}/messages/reactions`],
    ["get", `/rooms/${room}/events`],
    ["get", `/api/rooms/${room}/integrations/github`],
    ["get", `/rooms/${room}/agent-asks`, stranger],
    ["get", `/rooms/${room}/messages/pins`],
    ["get", `/rooms/${room}/agent-work/poll`, stranger],
  ];
  for (const [method, path, principal] of hot) {
    const result = await driveRoute(routes, method, path, principal);
    assert.equal(result.roomStatements, 1, `${method.toUpperCase()} ${path} (answered ${result.status})`);
  }
});

test("a converted route answers through the one-statement resolver exactly as through the pair", options, async () => {
  const room = await db!.createProjectWithName(unique("resolve-route"));
  const tombstoned = await db!.createProjectWithName(unique("resolve-route-tombstoned"));
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1)", [tombstoned.id]);
  const register = (withResolver: boolean) => {
    const { app, routes } = recordingApp();
    presenceRoutes!.registerRoomPresenceRoutes(app as never, {
      resolveCanonicalRoomRequestId: resolution!.resolveCanonicalRoomRequestId,
      resolveRoomOrReply: resolution!.resolveRoomOrReply,
      ...(withResolver ? { resolveRoomRequestOrReply: resolution!.resolveRoomRequestOrReply } : {}),
      requireParticipant: async () => true,
      requireAdmin: async () => true,
      rememberAgentRoomParticipant: async () => {},
      emitProjectMessage: async () => ({}),
    } as never);
    return routes;
  };
  const combined = register(true);
  const pair = register(false);
  const cases: Array<[string, number]> = [[room.id, 200], [unique("resolve-route-missing"), 404], [tombstoned.id, 410]];
  for (const [roomId, status] of cases) {
    const path = `/rooms/${roomId}/presence`;
    const after = await driveRoute(combined, "get", path);
    const before = await driveRoute(pair, "get", path);
    assert.equal(after.status, status, path);
    assert.deepEqual({ status: after.status, body: after.body }, { status: before.status, body: before.body }, path);
    if (status === 200) assert.deepEqual([after.roomStatements, before.roomStatements], [1, 3]);
  }
});
