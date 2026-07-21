import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const { registerSupervisorHostGrantRoutes, respondToStaleSupervisorGrantFence } = await import("../routes/supervisor-host-grants.js");
const { SupervisorGrantFenceStaleError } = await import("../db/auth.js");

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
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/leases/tl_1/attestation"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/leases/tl_1/rebind"), true);
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

test("the exact in-transaction stale supervisor fence error maps to HTTP 409", () => {
  const response = recorder();
  assert.equal(respondToStaleSupervisorGrantFence(response as never, new SupervisorGrantFenceStaleError()), true);
  assert.equal(response.statusCode, 409);
  assert.match((response.body as any).error, /fence is stale/i);
  assert.equal(respondToStaleSupervisorGrantFence(recorder() as never, new Error("unrelated")), false);
});

test("lifecycle mint enforces room and agent allowlists through the actual route", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const allowed = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "worker_route_1" } }, allowed);
  assert.equal(allowed.statusCode, 201); assert.equal((allowed.body as any).session_token, undefined);
  assert.ok((allowed.body as any).worker_bearer_id);
  assert.ok((allowed.body as any).worker_bearer_expires_at);
  const mintedAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${(allowed.body as any).worker_bearer}` } } as never);
  assert.ok(mintedAuth.agentSession);
  assert.ok(new Date(mintedAuth.agentSession!.expires_at).getTime() <= new Date(grantResult.grant.expires_at).getTime());
  const denied = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: "other_room", agent_key: agent.canonical_key, agent_instance_id: "worker_route_1" } }, denied);
  assert.equal(denied.statusCode, 403);
  const otherAgent = await authDb!.registerAgentIdentity({ canonical_key: "owner/disallowed-agent", name: "disallowed-agent", display_name: "Disallowed Agent", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const agentDenied = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: room.id, agent_key: otherAgent.canonical_key, agent_instance_id: "worker_route_1" } }, agentDenied);
  assert.equal(agentDenied.statusCode, 403);
});

test("idempotent supervisor worker creation rotates one session and revokes its old bearer", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const body = { generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "durable-worker-1" };
  const first = recorder();
  await mint({ ...reqBase, body }, first);
  assert.equal(first.statusCode, 201);
  const second = recorder();
  await mint({ ...reqBase, body }, second);
  assert.equal(second.statusCode, 201);
  assert.equal((first.body as any).session_id, (second.body as any).session_id);
  assert.notEqual((first.body as any).worker_bearer, (second.body as any).worker_bearer);
  assert.notEqual((first.body as any).worker_bearer_id, (second.body as any).worker_bearer_id);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(first.body as any).worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(second.body as any).worker_bearer}` } } as never)).authKind, "agent_session");
  assert.equal((second.body as any).session_token, undefined);
});

test("supervisor worker retry collapses all historical active duplicates before rotating the retained session", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const common = {
    room_id: room.id, session_kind: "worker" as const, runtime: "legacy", agent_key: agent.canonical_key,
    agent_instance_id: "duplicate-worker", display_name: "Route Agent", owner_account_id: "owner_route",
    owner_label: "Owner", ide_label: "Legacy", supervisor_grant_id: grantResult.grant.grant_id,
    worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString(),
  };
  const retained = await authDb!.createRoomAgentSession({ ...common, actor_label: "Legacy duplicate A" });
  const duplicate = await authDb!.createRoomAgentSession({ ...common, actor_label: "Legacy duplicate B" });
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const response = recorder();
  await mint({ ...reqBase, body: {
    generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "duplicate-worker",
  } }, response);
  assert.equal(response.statusCode, 201);
  assert.equal((response.body as any).session_id, retained.session_id);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${retained.worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${duplicate.worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(response.body as any).worker_bearer}` } } as never)).authKind, "agent_session");
  const [duplicateRow] = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, duplicate.session_id)).limit(1);
  assert.ok(duplicateRow.ended_at, "duplicate session is ended inside the replacement transaction");
  const matching = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.agent_instance_id, "duplicate-worker"));
  assert.equal(matching.filter((row) => row.ended_at === null
    && row.supervisor_grant_id === grantResult.grant.grant_id
    && row.room_id === room.id
    && row.agent_key === agent.canonical_key).length, 1);
});

test("stale supervisor worker fence is an explicit conflict, never an internal error", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const rotated = await authDb!.rotateSupervisorHostGrant({
    grant_id: grantResult.grant.grant_id, expected_generation: 1, expected_token_version: 1,
    expires_at: grantResult.grant.expires_at,
  });
  assert.ok(rotated);
  await assert.rejects(authDb!.createOrRotateSupervisorWorkerSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Stale Worker",
    agent_key: agent.canonical_key, agent_instance_id: "stale-worker", display_name: "Stale Worker",
    owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grantResult.grant.grant_id, supervisor_grant_fence: {
      grant_id: grantResult.grant.grant_id, generation: 1, token_version: 1,
    },
  }), (error: unknown) => authDb!.isSupervisorGrantFenceStaleError(error));
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const response = recorder();
  await mint({ ...reqBase, body: {
    generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "stale-worker",
  } }, response);
  assert.equal(response.statusCode, 409);
});

test("lifecycle handlers fail closed when the path grant differs from the authenticated grant", { skip: requiresDatabase }, async () => {
  const { handlers, reqBase } = await setupLifecycle();
  const requests: Array<[string, Record<string, unknown>]> = [
    ["POST /supervisor-host-grants/:grantId/handoff", { body: { generation: 1 } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions", { body: { generation: 1, room_id: "room", agent_key: "owner/agent", agent_instance_id: "worker_1" } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate", { params: { grantId: "different_grant", sessionId: "session" }, body: { generation: 1, bearer_id: "bearer" } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/end", { params: { grantId: "different_grant", sessionId: "session" }, body: { generation: 1 } }],
  ];
  for (const [route, override] of requests) {
    const handler = handlers.get(route); assert.ok(handler);
    const response = recorder();
    await handler({ ...reqBase, ...override, params: { grantId: "different_grant", ...(override.params as object ?? {}) } }, response);
    assert.equal(response.statusCode, 403, route);
  }
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

test("attestation route: strict inputs, in-tx authorization, immutable evidence", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const attest = handlers.get("POST /supervisor-host-grants/:grantId/leases/:leaseId/attestation"); assert.ok(attest);
  const grantId = reqBase.params.grantId;

  // The predecessor is a real supervised worker: minted under THIS grant, then
  // ended (terminal) — the in-tx authorization requires both.
  const from = await authDb!.createRoomAgentSession({ room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Route Agent", agent_key: agent.canonical_key, display_name: "Route Agent", owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent", supervisor_grant_id: grantResult.grant.grant_id });
  const lease = await authDb!.createTaskLease({ room_id: room.id, task_id: "task_1", kind: "work", agent_key: agent.canonical_key, actor_label: "Route Agent", created_by: "Route Agent", agent_session_id: from.session_id });
  const wa = randomUUID();
  const eg = randomUUID();
  const goodBody = { generation: 1, expected_epoch: 0, from_agent_session_id: from.session_id, work_attempt_id: wa, execution_generation_id: eg, cause: "crashed" };
  const call = async (body: Record<string, unknown>, leaseId = lease.id) => {
    const res = recorder();
    await attest({ ...reqBase, params: { grantId, leaseId }, body }, res);
    return res;
  };

  // A live (not ended) predecessor cannot be attested terminal.
  const live = await call(goodBody);
  assert.equal(live.statusCode, 403);
  assert.equal((live.body as any).code, "predecessor_live");

  await authDb!.endRoomAgentSession({ session_id: from.session_id });

  // Terminal predecessor, in-scope lease → 201, recorded at the grant's current
  // generation, un-consumed.
  const ok = await call(goodBody);
  assert.equal(ok.statusCode, 201);
  assert.equal((ok.body as any).lease_id, lease.id);
  assert.equal((ok.body as any).supervisor_generation, 1);
  assert.equal((ok.body as any).consumed_at, null);
  const recordedId = (ok.body as any).id;

  // Idempotent identical retry → 200, the SAME untouched row (and the body
  // cannot forge a different generation than the validated grant fence).
  const retry = await call({ ...goodBody, supervisor_generation: 99 });
  assert.equal(retry.statusCode, 200, "identical retry is idempotent, not a new insert");
  assert.equal((retry.body as any).id, recordedId);
  assert.equal((retry.body as any).supervisor_generation, 1, "generation is taken from the grant, not the body");
  assert.equal((retry.body as any).attested_at, (ok.body as any).attested_at, "evidence untouched by the retry");

  // Conflicting retry (different execution identity) → 409, evidence immutable.
  const conflict = await call({ ...goodBody, execution_generation_id: randomUUID() });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.body as any).code, "evidence_conflict");
  const [row] = await client!.db.select().from(schema!.task_lease_rebind_attestations).where(eq(schema!.task_lease_rebind_attestations.id, recordedId)).limit(1);
  assert.equal(row.execution_generation_id, eg, "original evidence not overwritten");

  // Strict JSON integer epoch: string epochs (Number-coercible or not) → 400.
  for (const expected_epoch of ["", "0", "3", null, 1.5]) {
    const bad = await call({ ...goodBody, expected_epoch });
    assert.equal(bad.statusCode, 400, `expected_epoch ${JSON.stringify(expected_epoch)} rejected`);
  }

  // Strict cause enum and UUID-shaped P1b execution ids → 400.
  assert.equal((await call({ ...goodBody, cause: "sdf" })).statusCode, 400);
  assert.equal((await call({ ...goodBody, work_attempt_id: "wa_1" })).statusCode, 400);
  assert.equal((await call({ ...goodBody, execution_generation_id: "eg_1" })).statusCode, 400);

  // Wrong epoch / wrong from-session (not the holder) → 409 lease_mismatch.
  const wrongEpoch = await call({ ...goodBody, expected_epoch: 5 });
  assert.equal(wrongEpoch.statusCode, 409);
  assert.equal((wrongEpoch.body as any).code, "lease_mismatch");
  const wrongFrom = await call({ ...goodBody, from_agent_session_id: "sess_not_holder" });
  assert.equal(wrongFrom.statusCode, 409);
  assert.equal((wrongFrom.body as any).code, "lease_mismatch");

  // Stale grant generation proof → rejected before any write.
  const staleGrant = await call({ ...goodBody, generation: 99 });
  assert.equal(staleGrant.statusCode, 403);

  // A lease the grant does not scope (different agent key) → 403, nothing written.
  const otherAgent = await authDb!.registerAgentIdentity({ canonical_key: "owner/other-agent", name: "other-agent", display_name: "Other", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const otherLease = await authDb!.createTaskLease({ room_id: room.id, task_id: "task_2", kind: "work", agent_key: otherAgent.canonical_key, actor_label: "Other", created_by: "Other" });
  const denied = await call({ ...goodBody, from_agent_session_id: "sess_x" }, otherLease.id);
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.body as any).code, "grant_scope");

  // Unknown lease → 404.
  const missing = await call(goodBody, "tl_nope");
  assert.equal(missing.statusCode, 404);

  // Missing required fields → 400.
  const bad = await call({ generation: 1, expected_epoch: 0, from_agent_session_id: from.session_id });
  assert.equal(bad.statusCode, 400);

  // Exactly one attestation row exists after the whole gauntlet.
  const rows = await client!.db.select().from(schema!.task_lease_rebind_attestations);
  assert.equal(rows.length, 1, "only the one legitimate attestation was persisted");
});

test("rebind route requires the exact attestation tuple and a strict integer epoch", { skip: requiresDatabase }, async () => {
  const { handlers, reqBase } = await setupLifecycle();
  const rebind = handlers.get("POST /supervisor-host-grants/:grantId/leases/:leaseId/rebind"); assert.ok(rebind);
  const grantId = reqBase.params.grantId;
  const call = async (body: Record<string, unknown>) => {
    const res = recorder();
    await rebind({ ...reqBase, params: { grantId, leaseId: "tl_x" }, body }, res);
    return res;
  };
  const good = {
    generation: 1, expected_epoch: 0, from_agent_session_id: "sess_a", to_agent_session_id: "sess_b",
    attestation_id: "tlra_1", work_attempt_id: randomUUID(), execution_generation_id: randomUUID(),
  };
  // Every degraded variant of the exact-tuple requirement → 400 before any DB work.
  assert.equal((await call({ ...good, attestation_id: undefined })).statusCode, 400);
  assert.equal((await call({ ...good, work_attempt_id: undefined })).statusCode, 400);
  assert.equal((await call({ ...good, execution_generation_id: "eg_1" })).statusCode, 400);
  assert.equal((await call({ ...good, expected_epoch: "0" })).statusCode, 400);
  assert.equal((await call({ ...good, expected_epoch: "" })).statusCode, 400);
  // Well-formed but nonexistent → the transaction decides (409 lost_race here).
  const wellFormed = await call(good);
  assert.equal(wellFormed.statusCode, 409);
  assert.equal((wellFormed.body as any).code, "lost_race");
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

test("handoff is a current-generation CAS, rotates its host token, and rejects stale authority", { skip: requiresDatabase }, async () => {
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
  const winner = left ?? right;
  assert.equal(winner!.grant.current_generation, 2);
  assert.equal(winner!.grant.token_version, 2);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${winner!.token}` } } as never)).authKind, "supervisor_grant");
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
