import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const authDb = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { resolveRequestAuth } = await import("../request/auth.js");
const { isSupervisorGrantRouteAllowed } = await import("../request/supervisor-grant-route-registry.js");
const { registerHttpMiddleware } = await import("../http/middleware.js");
const { registerSupervisorHostGrantRoutes } = await import("../routes/supervisor-host-grants.js");

async function reset() {
  if (!client) throw new Error("DB-backed supervisor tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

async function seedOwner(id: string): Promise<void> {
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: id,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

function recorder() {
  return { statusCode: 200, body: null as any, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; } };
}

async function setupLifecycle() {
  await seedOwner("owner_route");
  const room = await authDb!.createProjectWithName("supervisor-route-room");
  const agent = await authDb!.registerAgentIdentity({ canonical_key: "owner/route-agent", name: "route-agent", display_name: "Route Agent", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const grantResult = await authDb!.createSupervisorHostGrant({ owner_account_id: "owner_route", host_id: "host_route", installation_id: "install_route", allowed_room_ids: [room.id], allowed_agent_keys: [agent.canonical_key], expires_at: new Date(Date.now() + 60_000).toISOString() });
  const handlers = new Map<string, any>();
  registerSupervisorHostGrantRoutes({ post(path: string, handler: any) { handlers.set(`POST ${path}`, handler); }, delete(path: string, handler: any) { handlers.set(`DELETE ${path}`, handler); } } as never, {
    resolveCanonicalRoomRequestId: async (id: string) => id, resolveRoomOrReply: async () => room, requireParticipant: async () => true,
  });
  const principal = grantResult.grant;
  const reqBase = { authKind: "supervisor_grant", supervisorGrant: principal, headers: {}, body: { generation: principal.current_generation }, params: { grantId: principal.grant_id } };
  return { room, agent, grantResult, handlers, reqBase };
}

test("supervisor registry is exact default-deny", () => {
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/renew"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/rooms/room_1/messages"), false);
  assert.equal(isSupervisorGrantRouteAllowed("DELETE", "/supervisor-host-grants/grant_1"), false);
});

test("middleware attaches the supervisor principal and rejects non-registry routes", async () => {
  const handlers: Array<(...args: any[]) => unknown> = [];
  const app = { use(handler: (...args: any[]) => unknown) { handlers.push(handler); }, options() {} };
  const principal = { grant_id: "grant_1", owner_account_id: "owner", host_id: "host", installation_id: "install", token_version: 1, allowed_room_ids: ["room"], allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null };
  registerHttpMiddleware(app as never, { resolveRequestAuth: async () => ({ account: null, authKind: "supervisor_grant" as const, supervisorGrant: principal }) });
  const auth = handlers[1]!;
  for (const [path, status] of [["/supervisor-host-grants/grant_1/renew", 200], ["/rooms/room/messages", 403]] as const) {
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() {} }; let next = false;
    await auth({ method: "POST", path, headers: {} }, res, () => { next = true; });
    assert.equal(res.statusCode, status); assert.equal(next, status === 200);
  }
});

test("feature-off retains only owner revoke route", () => {
  const prior = process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
  process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "false";
  const paths: string[] = [];
  try {
    registerSupervisorHostGrantRoutes({ post(path: string) { paths.push(`POST ${path}`); }, delete(path: string) { paths.push(`DELETE ${path}`); } } as never, {} as never);
    assert.deepEqual(paths, ["DELETE /supervisor-host-grants/:grantId"]);
  } finally { process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = prior; }
});

test("lifecycle mint enforces room and agent allowlists through the actual route", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const allowed = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: room.id, agent_key: agent.canonical_key } }, allowed);
  assert.equal(allowed.statusCode, 201); assert.equal((allowed.body as any).session_token, undefined);
  const mintedAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${(allowed.body as any).worker_bearer}` } } as never);
  assert.ok(mintedAuth.agentSession);
  assert.ok(new Date(mintedAuth.agentSession!.expires_at).getTime() <= new Date(grantResult.grant.expires_at).getTime());
  const denied = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: "other_room", agent_key: agent.canonical_key } }, denied);
  assert.equal(denied.statusCode, 403);
});

test("wrong-session rotation route cannot mutate a grant-bound bearer", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const session = await authDb!.createRoomAgentSession({ room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Route Agent", agent_key: agent.canonical_key, display_name: "Route Agent", owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent", supervisor_grant_id: grantResult.grant.grant_id, worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString() });
  const initial = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const rotate = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate"); assert.ok(rotate);
  const response = recorder();
  await rotate({ ...reqBase, params: { grantId: grantResult.grant.grant_id, sessionId: "wrong_session" }, body: { generation: 1, bearer_id: initial.agentSession!.bearer_id } }, response);
  assert.equal(response.statusCode, 403);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never)).authKind, "agent_session");
});

test("concurrent renewal has exactly one winner and stale token cannot replay", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_1");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_1", host_id: "host_1", installation_id: "install_1",
    allowed_room_ids: ["room_1"], allowed_agent_keys: ["owner/agent_1"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const input = { grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1, expires_at: new Date(Date.now() + 120_000).toISOString() };
  const [left, right] = await Promise.all([authDb!.rotateSupervisorHostGrant(input), authDb!.rotateSupervisorHostGrant(input)]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
  const winner = left ?? right;
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${winner!.token}` } } as never)).authKind, "supervisor_grant");
});

test("handoff is a current-generation CAS and revoked/lapsed grants cannot authenticate", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_2");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_2", host_id: "host_2", installation_id: "install_2",
    allowed_room_ids: ["room_2"], allowed_agent_keys: ["owner/agent_2"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const [left, right] = await Promise.all([
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((await authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 })), null);
  await authDb!.revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: "owner_2" });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
});

test("an expired grant cannot authenticate even before a worker bearer reaches its own expiry", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_3");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_3", host_id: "host_3", installation_id: "install_3",
    allowed_room_ids: ["room_3"], allowed_agent_keys: ["owner/agent_3"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await client!.db.update(schema!.supervisor_host_grants).set({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .where(eq(schema!.supervisor_host_grants.grant_id, created.grant.grant_id));
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
});

test("a valid browser cookie plus supervisor bearer fails closed", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_5");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_5", host_id: "host_5", installation_id: "install_5",
    allowed_room_ids: ["room_5"], allowed_agent_keys: ["owner/agent_5"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await authDb!.createSession("owner_5", "browser_session", new Date(Date.now() + 60_000).toISOString());
  const auth = await resolveRequestAuth({ headers: { cookie: "letagents_session=browser_session", authorization: `Bearer ${created.token}` } } as never);
  assert.equal(auth.authKind, null);
  assert.equal(auth.account, null);
});

test("revoking a parent grant does not retroactively invalidate an already minted worker bearer", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_4");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_4", host_id: "host_4", installation_id: "install_4",
    allowed_room_ids: ["placeholder"], allowed_agent_keys: ["owner/agent_4"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const room = await authDb!.createProjectWithName("supervisor-worker-room");
  const session = await authDb!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Worker | Owner | Agent", agent_key: "owner/agent_4",
    display_name: "Worker", owner_account_id: "owner_4", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: created.grant.grant_id, worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString(),
  });
  await authDb!.revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: "owner_4" });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never)).authKind, "agent_session");
});
