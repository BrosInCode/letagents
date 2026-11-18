import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { ApiError } from "../../../shared/api/core.mjs";
import type { AuthenticatedRequest } from "../http/helpers.js";

// The actor chain end to end: page grants, the /api/v1 path limit, the
// overlap of a grant and the person's room rights, revocation, sign-out, the
// room policy and the api_actions record, on the real app and database.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 actor chain DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const grants = testDatabaseUrl ? await import("../v1/page-grants.js") : null;
const helpers = testDatabaseUrl ? await import("./page-grant-test-helpers.js") : null;
const actorModule = testDatabaseUrl ? await import("../v1/actor.js") : null;
const policy = testDatabaseUrl ? await import("../v1/policy.js") : null;
const access = testDatabaseUrl ? await import("../rooms/access.js") : null;
const liveAuth = testDatabaseUrl ? await import("../rooms/live-authorization.js") : null;

const OWNER_TOKEN = "api_v1_actor_owner_token_ada";
let server: Server | null = null;
let origin = "";
let base = "";
let roomA = "";
let roomB = "";

interface Person { id: string; cookie: string; session: string }
async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-actor-${login}`, login, display_name: login });
  const session = `api-actor-session-${login}`;
  await accountSessions!.createSession(account.id, session, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${session}`, session };
}

let ada: Person;
let bob: Person;
let cy: Person;

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

    ada = await person("ada");
    bob = await person("bob");
    cy = await person("cy");
    await ownerTokens!.createOwnerToken({ accountId: ada.id, githubUserId: "api-actor-ada", token: OWNER_TOKEN });
    roomA = (await api!.createProjectWithName("api-actor-a")).id;
    roomB = (await api!.createProjectWithName("api-actor-b")).id;
    // Ada made room A (its admin); Bob is a member of A and B; Cy of neither.
    await members!.recordRoomCreator(roomA, ada.id);
    await members!.addRoomMember({ roomId: roomA, accountId: bob.id, addedVia: "seed" });
    await members!.addRoomMember({ roomId: roomB, accountId: bob.id, addedVia: "seed" });

    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `${origin}/api/v1`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await dbClient!.pool.end();
  });
}

const enc = encodeURIComponent;
async function request(url: string, init: RequestInit & { bearer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const v1 = (route: string, init: RequestInit & { bearer?: string } = {}) => request(`${base}${route}`, init);

test("a page grant reads its room through /api/v1, as the person through the page", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["rooms.read"] });
  assert.match(grant.token, /^lapg\.[0-9a-f]{64}$/);
  assert.ok(Date.parse(grant.expiresAt) - Date.now() > 14 * 60_000);
  const res = await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, roomA);
  // The table keeps only the hash.
  const stored = await dbClient!.pool.query("SELECT token_hash FROM api_page_tokens WHERE token_id = $1", [grant.grantId]);
  assert.notEqual(stored.rows[0].token_hash, grant.token);
});

test("a page grant is refused on every route outside /api/v1, task writes included", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: ada.id, roomId: roomA, capabilities: ["rooms.read", "messages.read", "tasks.read", "tasks.propose"] });
  const refused = { error: "The bearer credential is invalid or expired. Reconnect with a current credential." };
  assert.deepEqual(await request(`${origin}/rooms/${enc(roomA)}/messages`, { bearer: grant.token }), { status: 401, body: refused });
  assert.deepEqual(await request(`${origin}/rooms/${enc(roomA)}/tasks`, { bearer: grant.token, method: "POST", body: JSON.stringify({ title: "From a page" }) }), { status: 401, body: refused });
  assert.deepEqual(await request(`${origin}/rooms/${enc(roomA)}/tasks/task_1`, { bearer: grant.token, method: "PATCH", body: JSON.stringify({ status: "done" }) }), { status: 401, body: refused });
  // Express matches paths without regard to case; the grant does not.
  assert.equal((await request(`${origin}/API/V1/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 401);
  // A page token beside a browser cookie is refused, not resolved to either.
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token, headers: { cookie: ada.cookie } })).status, 401);
  const tasks = await dbClient!.pool.query("SELECT 1 FROM tasks WHERE room_id = $1", [roomA]);
  assert.equal(tasks.rowCount, 0);
});

test("a page grant for room A is refused on room B, even when its person may read room B", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomB)}`, { headers: { cookie: bob.cookie } })).status, 200);
  assert.deepEqual(await v1(`/rooms/${enc(roomB)}`, { bearer: grant.token }), {
    status: 403, body: { code: "not_granted", message: "This page may only use the room it is pinned in." },
  });
  // A room that does not exist gets the same answer: the grant tells nothing about other rooms.
  assert.equal((await v1("/rooms/no-such-room", { bearer: grant.token })).body.code, "not_granted");
});

test("rights are the overlap: a grant without the method's capability is not_granted", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: ada.id, roomId: roomA, capabilities: ["tasks.read"] });
  assert.deepEqual(await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token }), {
    status: 403, body: { code: "not_granted", message: 'This caller does not hold the "rooms.read" capability.' },
  });
});

test("a viewer without room access gets not_participant even with a grant for the room", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: cy.id, roomId: roomA, capabilities: ["rooms.read", "tasks.read"] });
  assert.deepEqual(await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token }), {
    status: 403, body: { code: "not_participant", message: "You are not a participant in this room." },
  });
});

test("a revoked grant fails at once and its open streams are told to close", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, pageId: "page_revoke", capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 200);

  const req = await liveRequest(grant.token);
  const project = (await api!.getProjectById(roomA))!;
  assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true);
  // The same grant on another room's stream is refused.
  assert.equal(await access!.reauthorizeGitRoomParticipant(req, (await api!.getProjectById(roomB))!), false);
  let closed = 0;
  const stop = liveAuth!.onRequestCredentialRetired(req, () => { closed += 1; });
  try {
    assert.equal(await grants!.revokePageGrants({ pageId: "page_revoke" }), 1);
  } finally {
    stop();
  }
  assert.equal(closed, 1);
  assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), false);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 401);
});

test("an expired grant fails", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["rooms.read"] });
  await dbClient!.pool.query("UPDATE api_page_tokens SET expires_at = now() - interval '1 second' WHERE token_id = $1", [grant.grantId]);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 401);
});

test("refresh gives a new token with the same binding, for the same person only", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, pageId: "page_refresh", pageVersion: 3, capabilities: ["rooms.read"] });
  assert.equal(await grants!.refreshPageGrant({ minter: helpers!.testPageGrantMinter(ada.id), token: grant.token }), null);
  const next = await grants!.refreshPageGrant({ minter: helpers!.testPageGrantMinter(bob.id), token: grant.token });
  assert.ok(next && next.token !== grant.token);
  const row = await dbClient!.pool.query("SELECT room_id, page_id, page_version, capabilities FROM api_page_tokens WHERE token_id = $1", [next.grantId]);
  assert.deepEqual(row.rows[0], { room_id: roomA, page_id: "page_refresh", page_version: 3, capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: next.token })).status, 200);
  // The old token works until its own expiry, so calls in flight do not fail.
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 200);
});

test("only a person's app session can mint: owner tokens, worker bearers, supervisor grants and page grants cannot", { skip }, async () => {
  const account = { account_id: ada.id } as never;
  const minter = grants!.requirePageGrantMinter({ authKind: "session", sessionAccount: account } as AuthenticatedRequest);
  assert.equal(minter.accountId, ada.id);
  for (const authKind of ["owner_token", "agent_session", "supervisor_grant", "mcp_oauth", "page_grant", null] as const) {
    assert.throws(
      () => grants!.requirePageGrantMinter({ authKind, sessionAccount: authKind === "agent_session" ? null : account } as AuthenticatedRequest),
      (error: unknown) => error instanceof ApiError && error.code === "not_granted",
      String(authKind),
    );
  }
});

test("signing out revokes the person's page grants", { skip }, async () => {
  const signOut = await person("dee");
  await members!.addRoomMember({ roomId: roomA, accountId: signOut.id, addedVia: "seed" });
  const grant = await helpers!.mintTestPageGrant({ accountId: signOut.id, roomId: roomA, capabilities: ["rooms.read"] });
  const other = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 200);
  assert.equal((await request(`${origin}/auth/logout`, { method: "POST", headers: { cookie: signOut.cookie } })).status, 200);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 401);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: other.token })).status, 200);
});

test("an agent's worker bearer resolves as the agent, in its own room only", { skip }, async () => {
  const caller = await actorModule!.identifyCaller({
    authKind: "agent_session",
    agentSession: { agent_key: "agent_helper", room_id: roomA },
  } as AuthenticatedRequest);
  assert.ok(caller);
  assert.equal(caller.account, null);
  const own = await actorModule!.resolveRoomAccess(caller, roomA);
  assert.deepEqual(own.actor, { principal: { kind: "agent", id: "agent_helper" }, roomId: roomA });
  await assert.rejects(actorModule!.resolveRoomAccess(caller, roomB), (error: unknown) => error instanceof ApiError && error.code === "not_participant");
  await assert.rejects(actorModule!.identifyCaller({ authKind: "supervisor_grant" } as AuthenticatedRequest),
    (error: unknown) => error instanceof ApiError && error.code === "not_granted");
});

test("room policy: registry defaults, the actor rules, and a room admin's choice", { skip }, async () => {
  const person = { principal: { kind: "person" as const, id: bob.id }, roomId: roomA };
  const page = { ...person, via: { kind: "page" as const, id: "page_x", version: 1 } };
  const agent = { principal: { kind: "agent" as const, id: "agent_helper" }, roomId: roomA };
  const modeOf = async (capability: Parameters<NonNullable<typeof policy>["resolvePolicy"]>[1], actor: typeof person) =>
    (await policy!.resolvePolicy(roomA, capability, actor)).mode;
  // jobs.start asks the viewer when a page starts the job; a direct caller is the one confirming.
  assert.equal(await modeOf("jobs.start", page), "confirm");
  assert.equal(await modeOf("jobs.start", person), "allow");
  // Board Manager off: proposals are allowed for everyone.
  assert.equal(await modeOf("tasks.propose", page), "allow");
  assert.equal(await modeOf("tasks.propose", agent), "allow");
  assert.deepEqual(await policy!.resolvePolicy(roomA, "tickets.propose", person), {
    capability: "tickets.propose", mode: "approve", configured: "approve", source: "default", rule: "own_tracker_connection",
  });
  assert.equal(await modeOf("rooms.read", page), "allow");

  await policy!.setRoomPolicy({ roomId: roomA, capability: "jobs.start", mode: "deny", accountId: ada.id });
  assert.deepEqual(await policy!.resolvePolicy(roomA, "jobs.start", person), {
    capability: "jobs.start", mode: "deny", configured: "deny", source: "room", rule: null,
  });
  await policy!.setRoomPolicy({ roomId: roomA, capability: "jobs.start", mode: null, accountId: ada.id });
  assert.equal(await modeOf("jobs.start", page), "confirm");
});

test("policy routes: a room admin in the app reads and sets them; others, owner tokens and pages cannot; the write is recorded", { skip }, async () => {
  const route = `/rooms/${enc(roomA)}/policies`;
  const put = (init: RequestInit & { bearer?: string }, body = { capability: "messages.post", mode: "approve" }) =>
    v1(route, { ...init, method: "PUT", body: JSON.stringify(body) });

  const list = await v1(route, { bearer: ada.session });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.policies.find((p: { capability: string }) => p.capability === "tasks.propose"),
    { capability: "tasks.propose", mode: "approve", source: "default", rule: "board_manager_mode" });
  assert.equal(list.body.policies.some((p: { capability: string }) => p.capability.endsWith(".read")), false);

  const refused = { code: "not_granted", message: "Only a room admin, signed in to LetAgents, can manage this room's API policy." };
  assert.deepEqual(await v1(route, { headers: { cookie: bob.cookie } }), { status: 403, body: refused });
  assert.deepEqual(await put({ bearer: OWNER_TOKEN }), { status: 403, body: refused });
  const adminPage = await helpers!.mintTestPageGrant({ accountId: ada.id, roomId: roomA, capabilities: ["rooms.read"] });
  assert.deepEqual(await put({ bearer: adminPage.token }), { status: 403, body: refused });
  // A cookie write from another site is refused too.
  assert.deepEqual(await put({ headers: { cookie: ada.cookie, origin: "https://evil.example" } }), { status: 403, body: refused });
  assert.equal((await put({ bearer: ada.session }, { capability: "rooms.read", mode: "deny" } as never)).body.code, "invalid_input");

  const set = await put({ bearer: ada.session });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.policies.find((p: { capability: string }) => p.capability === "messages.post"),
    { capability: "messages.post", mode: "approve", source: "room", rule: null });

  const actions = await dbClient!.pool.query(`SELECT principal_kind, principal_id, via_kind, method, capability, target, outcome
    FROM api_actions WHERE room_id = $1 AND outcome = 'ok' ORDER BY created_at`, [roomA]);
  assert.deepEqual(actions.rows, [{
    principal_kind: "person", principal_id: ada.id, via_kind: null, method: "rooms.setPolicy", capability: "rooms.read",
    target: "messages.post", outcome: "ok",
  }]);
  // Refused writes after the rate limit are recorded with their code; reads never are.
  const refusedRows = await dbClient!.pool.query("SELECT via_kind, outcome FROM api_actions WHERE room_id = $1 AND outcome <> 'ok' ORDER BY created_at", [roomA]);
  assert.deepEqual(refusedRows.rows.map((row) => row.outcome), ["not_granted", "not_granted", "not_granted", "invalid_input"]);
  assert.equal(refusedRows.rows[1].via_kind, "page");
});

async function liveRequest(token: string): Promise<AuthenticatedRequest> {
  const req = { headers: { authorization: `Bearer ${token}` }, path: `/api/v1/rooms/${enc(roomA)}/events`, method: "GET" } as unknown as AuthenticatedRequest;
  const { resolveRequestAuth } = await import("../request/auth.js");
  const auth = await resolveRequestAuth(req);
  Object.assign(req, { authKind: auth.authKind, sessionAccount: auth.account, pageGrant: auth.pageGrant ?? null });
  return req;
}
