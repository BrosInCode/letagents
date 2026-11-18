import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import express from "express";
import { z } from "zod";

import { ApiError, defineMethod } from "../../../shared/api/core.mjs";
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
const tokenStore = testDatabaseUrl ? await import("../db/api-page-tokens.js") : null;
const middleware = testDatabaseUrl ? await import("../http/middleware.js") : null;
const requestAuth = testDatabaseUrl ? await import("../request/auth.js") : null;
const router = testDatabaseUrl ? await import("../v1/router.js") : null;
const routeModule = testDatabaseUrl ? await import("../v1/route.js") : null;

const OWNER_TOKEN = "api_v1_actor_owner_token_ada";
let server: Server | null = null;
let probeServer: Server | null = null;
let origin = "";
let base = "";
let probeBase = "";
let roomA = "";
let roomB = "";

interface Person { id: string; cookie: string; session: string; sessionId: string }
async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-actor-${login}`, login, display_name: login });
  const session = `api-actor-session-${login}`;
  const row = await accountSessions!.createSession(account.id, session, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${session}`, session, sessionId: row.id };
}

// Probe methods on the real middleware and the real mounted /api/v1 router
// (real caller, room and capability steps), for what no shipped method does yet.
function probeRoutes() {
  const probe = { description: "A test probe.", input: z.strictObject({}), output: z.object({}) } as const;
  return [
    routeModule!.defineRoute(defineMethod({
      ...probe, name: "rooms.recheckProbe", area: "rooms", kind: "read", capability: "rooms.read", rateClass: "read",
      path: "/rooms/:room/recheck-probe", output: z.object({ allowed: z.boolean() }),
    }), async (_input, call) => ({ allowed: await access!.reauthorizeGitRoomParticipant(call.req, call.room) })),
    routeModule!.defineRoute(defineMethod({
      ...probe, name: "data.scopedProbe", area: "data", kind: "write", capability: "data.viewer", rateClass: "write",
      path: "/rooms/:room/scoped-probe", input: z.strictObject({ scope: z.enum(["viewer", "page", "room"]) }),
      capabilityFromInput: ({ scope }) => `data.${scope}` as const,
    }), () => ({})),
    routeModule!.defineRoute(defineMethod({
      ...probe, name: "data.readProbe", area: "data", kind: "read", capability: "data.room", rateClass: "read", path: "/rooms/:room/read-probe",
    }), () => ({})),
    routeModule!.defineRoute(defineMethod({
      ...probe, name: "messages.postProbe", area: "messages", kind: "write", capability: "messages.post", rateClass: "post", path: "/rooms/:room/post-probe",
    }), () => ({})),
    routeModule!.defineRoute(defineMethod({
      ...probe, name: "jobs.startProbe", area: "jobs", kind: "job", capability: "jobs.start", rateClass: "job", path: "/rooms/:room/job-probe",
    }), () => ({})),
  ];
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

    const probeApp = express();
    middleware!.registerHttpMiddleware(probeApp, { resolveRequestAuth: requestAuth!.resolveRequestAuth });
    router!.registerApiV1Routes(probeApp, { routes: probeRoutes() });
    probeServer = probeApp.listen(0, "127.0.0.1");
    await once(probeServer, "listening");
    probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}/api/v1`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => probeServer?.close(() => resolve()) ?? resolve());
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
const probe = (route: string, init: RequestInit & { bearer?: string } = {}) => request(`${probeBase}${route}`, init);

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
  assert.equal(await grants!.refreshPageGrant({ minter: helpers!.testPageGrantMinter(ada.id, ada.sessionId), token: grant.token }), null);
  const next = await grants!.refreshPageGrant({ minter: helpers!.testPageGrantMinter(bob.id, bob.sessionId), token: grant.token });
  assert.ok(next && next.token !== grant.token);
  const row = await dbClient!.pool.query("SELECT room_id, page_id, page_version, capabilities FROM api_page_tokens WHERE token_id = $1", [next.grantId]);
  assert.deepEqual(row.rows[0], { room_id: roomA, page_id: "page_refresh", page_version: 3, capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: next.token })).status, 200);
  // The old token works until its own expiry, so calls in flight do not fail.
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 200);
});

test("only a person's app session can mint: owner tokens, worker bearers, supervisor grants and page grants cannot", { skip }, async () => {
  const account = { account_id: ada.id, id: ada.sessionId } as never;
  const minter = grants!.requirePageGrantMinter({ authKind: "session", sessionAccount: account } as AuthenticatedRequest);
  assert.deepEqual({ ...minter }, { accountId: ada.id, sessionId: ada.sessionId });
  for (const authKind of ["owner_token", "agent_session", "supervisor_grant", "mcp_oauth", "page_grant", null] as const) {
    assert.throws(
      () => grants!.requirePageGrantMinter({ authKind, sessionAccount: authKind === "agent_session" ? null : account } as AuthenticatedRequest),
      (error: unknown) => error instanceof ApiError && error.code === "not_granted",
      String(authKind),
    );
  }
});

test("signing out revokes the page grants that session minted, on that device only; an owner token's sign-out revokes none", { skip }, async () => {
  const dee = await person("dee");
  await members!.addRoomMember({ roomId: roomA, accountId: dee.id, addedVia: "seed" });
  const thisDevice = await helpers!.mintTestPageGrant({ accountId: dee.id, sessionId: dee.sessionId, roomId: roomA, capabilities: ["rooms.read"] });
  const otherDevice = await helpers!.mintTestPageGrant({ accountId: dee.id, roomId: roomA, capabilities: ["rooms.read"] });
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: thisDevice.token })).status, 200);

  const deeOwnerToken = "api_v1_actor_owner_token_dee";
  await ownerTokens!.createOwnerToken({ accountId: dee.id, githubUserId: "api-actor-dee", token: deeOwnerToken });
  assert.equal((await request(`${origin}/auth/logout`, { method: "POST", bearer: deeOwnerToken })).status, 200);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: thisDevice.token })).status, 200);

  assert.equal((await request(`${origin}/auth/logout`, { method: "POST", headers: { cookie: dee.cookie } })).status, 200);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: thisDevice.token })).status, 401);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: otherDevice.token })).status, 200);
});

test("the live recheck accepts a page grant inside the mounted /api/v1 router, and refuses it once revoked", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, pageId: "page_mounted", capabilities: ["rooms.read"] });
  assert.deepEqual(await probe(`/rooms/${enc(roomA)}/recheck-probe`, { bearer: grant.token }), { status: 200, body: { allowed: true } });
  await grants!.revokePageGrants({ grantId: grant.grantId });
  assert.equal((await probe(`/rooms/${enc(roomA)}/recheck-probe`, { bearer: grant.token })).status, 401);
});

test("a revoke that races a refresh of the same page leaves no live token", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, sessionId: bob.sessionId, roomId: roomA, pageId: "page_race", capabilities: ["rooms.read"] });
  // Hold the page's lock, as a slow refresh would, and start a refresh and a revoke behind it.
  const holder = await dbClient!.pool.connect();
  let refreshed: Awaited<ReturnType<typeof grants.refreshPageGrant>> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 9151))", [tokenStore!.apiPageTokenLockKey("page", "page_race")]);
    const refresh = grants!.refreshPageGrant({ minter: helpers!.testPageGrantMinter(bob.id, bob.sessionId), token: grant.token })
      .then((result) => { refreshed = result; return result; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(refreshed, undefined, "the refresh waits for the page lock");
    const revoke = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return grants!.revokePageGrants({ pageId: "page_race" });
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await holder.query("COMMIT");
    await Promise.all([refresh, revoke]);
  } finally {
    holder.release();
  }
  assert.ok(refreshed, "the refresh ran first and made a token");
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: refreshed.token })).status, 401);
  assert.equal((await v1(`/rooms/${enc(roomA)}`, { bearer: grant.token })).status, 401);
  const live = await dbClient!.pool.query("SELECT 1 FROM api_page_tokens WHERE page_id = 'page_race' AND revoked_at IS NULL");
  assert.equal(live.rowCount, 0);
});

test("the capability comes from the input when the method says so, for the grant and the policy alike", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["data.viewer"] });
  const scoped = (scope: string, init: { bearer?: string; headers?: Record<string, string> }) =>
    probe(`/rooms/${enc(roomA)}/scoped-probe`, { ...init, method: "POST", body: JSON.stringify({ scope }) });
  assert.equal((await scoped("viewer", { bearer: grant.token })).status, 200);
  assert.deepEqual((await scoped("room", { bearer: grant.token })).body, {
    code: "not_granted", message: 'This caller does not hold the "data.room" capability.',
  });
  await policy!.setRoomPolicy({ roomId: roomA, capability: "data.room", mode: "deny", accountId: ada.id });
  try {
    // A person, no page: the policy of the derived capability still applies, and to reads of it too.
    assert.equal((await scoped("room", { bearer: bob.session })).body.code, "not_granted");
    assert.equal((await scoped("page", { bearer: bob.session })).status, 200);
    assert.deepEqual((await probe(`/rooms/${enc(roomA)}/read-probe`, { bearer: bob.session })).body, {
      code: "not_granted", message: 'This room does not allow "data.room" through the LetAgents API.',
    });
  } finally {
    await policy!.setRoomPolicy({ roomId: roomA, capability: "data.room", mode: null, accountId: ada.id });
  }
  const recorded = await dbClient!.pool.query("SELECT capability, outcome FROM api_actions WHERE method = 'data.scopedProbe' ORDER BY created_at");
  assert.deepEqual(recorded.rows.map((row) => `${row.capability}:${row.outcome}`), [
    "data.viewer:ok", "data.room:not_granted", "data.room:not_granted", "data.page:ok",
  ]);
});

test("confirm passes only to jobs and intents: a page's plain write that needs the viewer's confirmation is refused", { skip }, async () => {
  const grant = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId: roomA, capabilities: ["messages.post", "jobs.start"] });
  assert.deepEqual((await probe(`/rooms/${enc(roomA)}/post-probe`, { bearer: grant.token, method: "POST", body: "{}" })).body, {
    code: "not_granted", message: 'In this room "messages.post" needs the viewer\'s confirmation, which this method cannot wait for.',
  });
  assert.equal((await probe(`/rooms/${enc(roomA)}/job-probe`, { bearer: grant.token, method: "POST", body: "{}" })).status, 200);
  // The person themselves has nothing to confirm.
  assert.equal((await probe(`/rooms/${enc(roomA)}/post-probe`, { bearer: bob.session, method: "POST", body: "{}" })).status, 200);
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
  // An owner token acts through an integration, so room administration is refused before the route runs.
  assert.deepEqual(await put({ bearer: OWNER_TOKEN }), {
    status: 403, body: { code: "not_granted", message: "Only a person signed in to LetAgents, acting for themselves, can do this." },
  });
  assert.equal((await v1(route, { bearer: OWNER_TOKEN })).body.code, "not_granted");
  const adminPage = await helpers!.mintTestPageGrant({ accountId: ada.id, roomId: roomA, capabilities: ["rooms.read"] });
  // The pipeline refuses a page before the handler: room administration is never granted.
  assert.deepEqual(await put({ bearer: adminPage.token }), {
    status: 403, body: { code: "not_granted", message: "Only a person signed in to LetAgents, acting for themselves, can do this." },
  });
  await assert.rejects(helpers!.mintTestPageGrant({ accountId: ada.id, roomId: roomA, capabilities: ["rooms.admin"] }), /cannot hold: rooms\.admin/);
  // A cookie write from another site is refused too.
  assert.deepEqual(await put({ headers: { cookie: ada.cookie, origin: "https://evil.example" } }), { status: 403, body: refused });
  assert.equal((await put({ bearer: ada.session }, { capability: "rooms.read", mode: "deny" } as never)).body.code, "invalid_input");

  const set = await put({ bearer: ada.session });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.policies.find((p: { capability: string }) => p.capability === "messages.post"),
    { capability: "messages.post", mode: "approve", source: "room", rule: null });

  const actions = await dbClient!.pool.query(`SELECT principal_kind, principal_id, via_kind, method, capability, target, outcome
    FROM api_actions WHERE room_id = $1 AND method = 'rooms.setPolicy' AND outcome = 'ok' ORDER BY created_at`, [roomA]);
  assert.deepEqual(actions.rows, [{
    principal_kind: "person", principal_id: ada.id, via_kind: null, method: "rooms.setPolicy", capability: "rooms.admin",
    target: "messages.post", outcome: "ok",
  }]);
  // Refused writes after the rate limit are recorded with their code; reads never are.
  const refusedRows = await dbClient!.pool.query("SELECT via_kind, outcome FROM api_actions WHERE room_id = $1 AND method = 'rooms.setPolicy' AND outcome <> 'ok' ORDER BY created_at", [roomA]);
  assert.deepEqual(refusedRows.rows.map((row) => row.outcome), ["not_granted", "not_granted", "not_granted", "invalid_input"]);
  assert.equal(refusedRows.rows[1].via_kind, "page");
});

async function liveRequest(token: string): Promise<AuthenticatedRequest> {
  const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: `/api/v1/rooms/${enc(roomA)}/events`, method: "GET" } as unknown as AuthenticatedRequest;
  const { resolveRequestAuth } = await import("../request/auth.js");
  const auth = await resolveRequestAuth(req);
  Object.assign(req, { authKind: auth.authKind, sessionAccount: auth.account, pageGrant: auth.pageGrant ?? null });
  return req;
}
