import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schemaModule = testDatabaseUrl ? await import("../db/schema.js") : null;
const { resolveRequestAuth } = await import("../request/auth.js");
const { resolveRequestAgentIdentity } = await import("../request/agent-identity.js");
const { requireAdmin, requireParticipant } = await import("../rooms/access.js");
const { requiredAgentSessionRouteCapability } = await import("../request/agent-session-route-capabilities.js");
const { registerHttpMiddleware } = await import("../http/middleware.js");
const { registerRoomReasoningRoutes } = await import("../routes/rooms/reasoning.js");
const { registerRoomPresenceRoutes } = await import("../routes/rooms/presence/index.js");
const { registerRoomArtifactRoutes } = await import("../routes/rooms/artifacts.js");
const { requireWorkerRequestAgentIdentity } = await import("../request/agent-identity.js");
const { registerTaskLeaseActionRoute } = await import("../routes/rooms/tasks/lease-action.js");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const accounts = schemaModule?.accounts;
const room_agent_session_bearers = schemaModule?.room_agent_session_bearers;
const room_agent_sessions = schemaModule?.room_agent_sessions;
const room_agent_liveness_observations = schemaModule?.room_agent_liveness_observations;
const room_agent_presence = schemaModule?.room_agent_presence;
const task_leases = schemaModule?.task_leases;
const createProjectWithName = dbModule?.createProjectWithName;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const endRoomAgentSession = dbModule?.endRoomAgentSession;
const revokeRoomAgentSessionBearer = dbModule?.revokeRoomAgentSessionBearer;
const rotateRoomAgentSessionBearer = dbModule?.rotateRoomAgentSessionBearer;
const createTask = dbModule?.createTask;
const createTaskLease = dbModule?.createTaskLease;
let seedOrdinal = 0;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) throw new Error("DB-backed worker bearer tests require TEST_DB_URL");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
}

async function seed(expectBearer = true) {
  if (!db || !accounts || !createProjectWithName || !createRoomAgentSession) throw new Error("missing DB harness");
  const identity = ++seedOrdinal;
  const owner = {
    id: "acct_bearer_test",
    provider: "github",
    provider_user_id: "bearer-test",
    login: "worker-owner",
    display_name: "Worker Owner",
    avatar_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await db.insert(accounts).values(owner).onConflictDoNothing();
  const room = await createProjectWithName("bearer-room");
  const otherRoom = await createProjectWithName("other-bearer-room");
  const session = await createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: `BearerWorker${identity} | Worker Owner's agent | Agent`,
    agent_key: `WorkerOwner/bearerworker-${identity}`,
    agent_instance_id: `instance_bearer_${identity}`,
    display_name: `BearerWorker${identity}`,
    owner_account_id: owner.id,
    owner_label: "Worker Owner",
    ide_label: "Agent",
  });
  if (expectBearer) assert.ok(session.worker_bearer);
  return { room, otherRoom, session };
}

if (!requiresDatabase) {
  test.beforeEach(resetDatabase);
  test.after(async () => { await pool?.end(); });
}

test("worker bearer route registry is default-deny and semantic", () => {
  const allowed: Array<[string, string, string]> = [
    ["GET", "/rooms/room_1/messages", "messages.read"],
    ["POST", "/rooms/room_1/messages", "messages.write"],
    ["GET", "/rooms/room_1/artifacts", "artifacts.read"],
    ["POST", "/rooms/room_1/artifacts", "artifacts.self_write"],
    ["GET", "/rooms/room_1/tasks", "coordination.read"],
    ["POST", "/rooms/room_1/tasks", "coordination.propose"],
    ["POST", "/rooms/room_1/tasks/task_1/lease-action", "coordination.self_write"],
    ["POST", "/rooms/room_1/tasks/task_1/review-verdict", "coordination.self_write"],
    ["PATCH", "/rooms/room_1/reasoning-sessions/session_1", "coordination.self_write"],
    ["POST", "/rooms/room_1/agent-sessions/agent_session_1/disconnect", "coordination.self_write"],
    ["POST", "/rooms/room_1/agent-sessions/agent_session_1/native-activity", "coordination.self_write"],
  ];
  for (const [method, route, capability] of allowed) assert.equal(requiredAgentSessionRouteCapability(method, route), capability);
  for (const [method, route] of [
    ["POST", "/rooms/room_1/board-intents"], ["POST", "/rooms/room_1/tasks/task_1/stale-prompt-mute"],
    ["POST", "/rooms/room_1/tasks/task_1/focus-room"], ["POST", "/rooms/room_1/participants/clear-disconnected"],
    ["PATCH", "/rooms/room_1"], ["POST", "/rooms/room_1/artifacts/future-action"],
    ["GET", "/rental/provider/requests"], ["POST", "/rental/sessions/rental_1/complete"],
  ]) assert.equal(requiredAgentSessionRouteCapability(method, route), null, `${method} ${route} must remain default-deny`);
});

test("HTTP middleware denies unknown routes and missing semantic capabilities", async () => {
  const handlers: Array<(...args: any[]) => unknown> = [];
  const app = { use(handler: (...args: any[]) => unknown) { handlers.push(handler); }, options() {} };
  const principal = { bearer_id: "agent_bearer_1", bearer_generation: 1, capabilities: ["messages.read"], room_id: "room_1", agent_session_id: "agent_session_1", actor_label: "Worker", agent_key: "owner/worker", agent_instance_id: null, session_kind: "worker" as const, runtime: "codex", display_name: "Worker", owner_label: "Owner", ide_label: "Agent", repo_branch: null, expires_at: new Date(Date.now() + 60_000).toISOString() };
  registerHttpMiddleware(app as never, { resolveRequestAuth: async () => ({ account: null, authKind: "agent_session" as const, agentSession: principal }) });
  const authHandler = handlers[1]!;
  for (const [method, path, expected] of [["GET", "/rooms/room_1/messages", 200], ["POST", "/rooms/room_1/messages", 403], ["POST", "/rooms/room_1/tasks/task_1/stale-prompt-mute", 403]] as const) {
    const res = responseRecorder(); let nexted = false;
    await authHandler({ method, path, headers: {} }, res, () => { nexted = true; });
    assert.equal(res.statusCode, expected);
    assert.equal(nexted, expected === 200);
  }
});

test("bearer route handlers enforce self scope for reasoning and session control", async () => {
  const principal = { bearer_id: "agent_bearer_1", bearer_generation: 1, capabilities: ["coordination.self_write"], room_id: "room_1", agent_session_id: "agent_session_1", actor_label: "Worker", agent_key: "owner/worker", agent_instance_id: null, session_kind: "worker" as const, runtime: "codex", display_name: "Worker", owner_label: "Owner", ide_label: "Agent", repo_branch: null, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const reasoningHandlers = new Map<string, (...args: any[]) => Promise<void>>();
  const reasoningPatchHandlers: Array<(...args: any[]) => Promise<void>> = [];
  registerRoomReasoningRoutes({ get() {}, post(path: RegExp, handler: any) { reasoningHandlers.set(path.source, handler); }, patch(_path: RegExp, handler: any) { reasoningPatchHandlers.push(handler); } } as never, {
    reasoningEvents: { emit() {} }, resolveCanonicalRoomRequestId: async () => "room_1", resolveRoomOrReply: async () => ({ id: "room_1" }), requireParticipant: async () => true,
    reasoningStore: { getReasoningSessionById: async () => ({ actor_label: "Other" }) },
  } as never);
  const patchReasoning = reasoningPatchHandlers[0];
  const appendReasoning = [...reasoningHandlers.entries()].find(([source]) => source.includes("updates"))?.[1];
  assert.ok(patchReasoning);
  assert.ok(appendReasoning);
  for (const handler of [patchReasoning, appendReasoning]) {
    const reasoningRes = responseRecorder();
    await handler!({ params: { 0: "room_1", 1: "reasoning_1" }, body: {}, authKind: "agent_session", agentSession: principal }, reasoningRes);
    assert.equal(reasoningRes.statusCode, 403);
  }

  const presenceHandlers = new Map<string, (...args: any[]) => Promise<void>>();
  registerRoomPresenceRoutes({ get() {}, post(path: RegExp, handler: any) { presenceHandlers.set(path.source, handler); } } as never, {
    resolveCanonicalRoomRequestId: async () => "room_1", resolveRoomOrReply: async () => ({ id: "room_1" }), requireParticipant: async () => true, requireAdmin: async () => false,
    rememberAgentRoomParticipant: async () => {}, maybeEmitStaleWorkPrompt: async () => {}, emitProjectMessage: async () => ({}),
  } as never);
  const disconnect = [...presenceHandlers.entries()].find(([source]) => source.includes("agent-sessions") && source.includes("disconnect"))?.[1];
  assert.ok(disconnect);
  const presenceRes = responseRecorder();
  await disconnect!({ params: { 0: "room_1", 1: "agent_session_other" }, body: {}, authKind: "agent_session", agentSession: principal }, presenceRes);
  assert.equal(presenceRes.statusCode, 403);
});

test("worker bearer rejects cross-room and owner routes without becoming an owner principal", { skip: requiresDatabase }, async () => {
  const { room, otherRoom, session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  assert.equal(auth.authKind, "agent_session");
  assert.equal(auth.account, null);
  assert.ok(auth.agentSession);
  assert.equal(JSON.stringify(auth).includes(session.worker_bearer!), false, "auth result must not retain raw bearer");

  const adminResponse = responseRecorder();
  assert.equal(await requireAdmin(auth as never, adminResponse as never, room), false);
  assert.equal(adminResponse.statusCode, 403);
  const crossRoomResponse = responseRecorder();
  assert.equal(await requireParticipant(auth as never, crossRoomResponse as never, otherRoom), false);
  assert.equal(crossRoomResponse.statusCode, 403);
});

test("flag-off worker registration issues no bearer and cannot authenticate one", { skip: requiresDatabase }, async () => {
  process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "false";
  try {
    const { session } = await seed(false);
    assert.equal(session.worker_bearer, null);
    const rows = await db!.select().from(room_agent_session_bearers!).where(eq(room_agent_session_bearers!.session_id, session.session_id));
    assert.equal(rows.length, 0);
    assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${session.session_token}` } } as never)).authKind, null);
  } finally {
    process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
  }
});

test("ended, expired, revoked, and rotated worker bearers cannot replay", { skip: requiresDatabase }, async () => {
  const { session } = await seed();
  const token = session.worker_bearer!;
  const initial = await resolveRequestAuth({ headers: { authorization: `Bearer ${token}` } } as never);
  assert.equal(initial.authKind, "agent_session");
  const bearerId = initial.agentSession!.bearer_id;

  const rotated = await rotateRoomAgentSessionBearer!({ bearer_id: bearerId });
  assert.ok(rotated);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${token}` } } as never)).authKind, null, "stale generation rejected");
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${rotated!.token}` } } as never)).authKind, "agent_session");
  await revokeRoomAgentSessionBearer!({ bearer_id: rotated!.bearer.bearer_id });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${rotated!.token}` } } as never)).authKind, null, "revoked bearer rejected");

  const fresh = await seed();
  const freshAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${fresh.session.worker_bearer}` } } as never);
  await endRoomAgentSession!({ session_id: fresh.session.session_id });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${fresh.session.worker_bearer}` } } as never)).authKind, null, "ended session rejected");

  const expiring = await seed();
  const expiringAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${expiring.session.worker_bearer}` } } as never);
  await db!.update(room_agent_session_bearers!).set({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .where(eq(room_agent_session_bearers!.bearer_id, expiringAuth.agentSession!.bearer_id));
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${expiring.session.worker_bearer}` } } as never)).authKind, null, "expired bearer rejected");
  assert.equal(freshAuth.authKind, "agent_session");
});

test("concurrent rotation has one winner and one active next generation", { skip: requiresDatabase }, async () => {
  const { session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const [left, right] = await Promise.all([
    rotateRoomAgentSessionBearer!({ bearer_id: auth.agentSession!.bearer_id }),
    rotateRoomAgentSessionBearer!({ bearer_id: auth.agentSession!.bearer_id }),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  const rows = await db!.select().from(room_agent_session_bearers!).where(eq(room_agent_session_bearers!.session_id, session.session_id));
  assert.equal(rows.filter((row) => !row.revoked_at).length, 1);
  assert.equal(rows.filter((row) => row.generation === 2).length, 1);
});

test("bearer artifact publishing requires exactly one caller-held work lease", { skip: requiresDatabase }, async () => {
  const { room, session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  registerRoomArtifactRoutes({ get() {}, post(path: RegExp, handler: any) { handlers.set(path.source, handler); } } as never, {
    resolveCanonicalRoomRequestId: async () => room.id, resolveRoomOrReply: async () => room, requireParticipant: async () => true,
    requireWorkerRequestAgentIdentity, getActiveTaskLeases: dbModule!.getActiveTaskLeases, getRoomSharedArtifacts: async () => [], getRoomSharedArtifactByIdentityKey: async () => null,
    upsertRoomSharedArtifact: async () => ({ identity_key: "artifact" }), linkRoomSharedArtifactToTask: async () => {},
    publishWorkerArtifactFenced: async () => ({ identity_key: "artifact" }),
  } as never);
  const publish = [...handlers.values()][0]!;
  const invoke = async (body: Record<string, unknown>) => { const res = responseRecorder(); await publish({ params: { 0: room.id }, query: {}, body, ...auth }, res); return res; };
  const base = { provider: "github", kind: "commit", id: "abc" };
  assert.equal((await invoke(base)).statusCode, 403);
  const first = await createTask!(room.id, "first", "Worker");
  const second = await createTask!(room.id, "second", "Worker");
  assert.equal((await invoke({ ...base, linked_task_ids: [first.id, second.id] })).statusCode, 403);
  assert.equal((await invoke({ ...base, task_id: first.id })).statusCode, 403);
  await createTaskLease!({ room_id: room.id, task_id: first.id, kind: "work", agent_key: auth.agentSession!.agent_key, agent_session_id: auth.agentSession!.agent_session_id, actor_label: auth.agentSession!.actor_label, created_by: auth.agentSession!.actor_label });
  assert.equal((await invoke({ ...base, task_id: first.id })).statusCode, 200);
});

test("native activity accepts the scoped worker bearer without a legacy session token", { skip: requiresDatabase }, async () => {
  const { room, session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  assert.equal(auth.authKind, "agent_session");
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  registerRoomPresenceRoutes({
    get() {},
    post(path: RegExp, handler: any) { handlers.set(path.source, handler); },
  } as never, {
    resolveCanonicalRoomRequestId: async () => room.id,
    resolveRoomOrReply: async () => room,
    requireParticipant: async () => { throw new Error("scoped native activity must not require owner participation"); },
    requireAdmin: async () => true,
    rememberAgentRoomParticipant: async () => {},
    maybeEmitStaleWorkPrompt: async () => {},
    emitProjectMessage: async () => { throw new Error("native activity must not emit room chat"); },
  } as never);
  const handler = [...handlers.entries()].find(([route]) => route.includes("native-activity"))?.[1];
  assert.ok(handler);
  const invoke = async (targetSessionId: string) => {
    const res = responseRecorder();
    await handler!({
      params: { 0: room.id, 1: targetSessionId },
      body: {
        observed_at: new Date().toISOString(),
        sequence: 1,
        method: "native_harness.bound",
        status: "idle",
      },
      ...auth,
    }, res);
    return res;
  };
  const accepted = await invoke(session.session_id);
  assert.equal(accepted.statusCode, 200);
  assert.equal((accepted.body as { presence: { status: string } }).presence.status, "idle");
  assert.equal((await invoke("agent_session_other")).statusCode, 403, "a bearer remains scoped to its own session");
});

test("native harness session-token self-auth survives flag-off/expired bearers and CAS-heartbeats the exact worker lease", { skip: requiresDatabase }, async () => {
  const { room, session } = await seed();
  const task = await createTask!(room.id, "native activity", session.actor_label);
  const reviewTask = await createTask!(room.id, "native activity review", session.actor_label);
  const lease = await createTaskLease!({
    room_id: room.id,
    task_id: task.id,
    kind: "work",
    agent_key: session.agent_key,
    agent_session_id: session.session_id,
    actor_label: session.actor_label,
    created_by: session.actor_label,
  });
  const reviewLease = await createTaskLease!({
    room_id: room.id,
    task_id: reviewTask.id,
    kind: "review",
    agent_key: session.agent_key,
    agent_session_id: session.session_id,
    actor_label: session.actor_label,
    created_by: session.actor_label,
  });
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  registerRoomPresenceRoutes({
    get() {},
    post(path: RegExp, handler: any) { handlers.set(path.source, handler); },
  } as never, {
    resolveCanonicalRoomRequestId: async () => room.id,
    resolveRoomOrReply: async () => room,
    requireParticipant: async () => { throw new Error("native worker bearer route must not require an owner participant session"); },
    requireAdmin: async () => true,
    rememberAgentRoomParticipant: async () => {},
    maybeEmitStaleWorkPrompt: async () => {},
    emitProjectMessage: async () => { throw new Error("native activity must not emit room chat"); },
  } as never);
  const handler = [...handlers.entries()].find(([path]) => path.includes("native-activity"))?.[1];
  assert.ok(handler);
  const invoke = async (targetSessionId: string, body: Record<string, unknown>) => {
    const res = responseRecorder();
    await handler!({
      params: { 0: room.id, 1: targetSessionId },
      body: { agent_session_id: session.session_id, agent_session_token: session.session_token, ...body },
      authKind: null,
      sessionAccount: null,
    }, res);
    return res;
  };
  const readLastSeenAt = async () => {
    const [row] = await db!.select({ last_seen_at: room_agent_sessions!.last_seen_at }).from(room_agent_sessions!)
      .where(eq(room_agent_sessions!.session_id, session.session_id));
    return row?.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
  };
  const originalLastSeenAt = await readLastSeenAt();
  process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "false";
  try {
    const flagOff = await invoke(session.session_id, { observed_at: new Date(Date.now() - 90_000).toISOString(), sequence: 1, method: "native_harness.bound", status: "working" });
    assert.equal(flagOff.statusCode, 200, "optional worker-bearer feature cannot gate native activity");
    assert.equal((flagOff.body as { presence: { status: string; status_text: string } }).presence.status, "working");
    assert.equal((flagOff.body as { presence: { status: string; status_text: string } }).presence.status_text, "Working");
    assert.equal(await readLastSeenAt(), originalLastSeenAt, "accepted native activity cannot refresh generic session/workplace liveness");
  } finally {
    process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
  }
  await db!.update(room_agent_session_bearers!).set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .where(eq(room_agent_session_bearers!.session_id, session.session_id));
  const [reviewBefore] = await db!.select().from(task_leases!).where(eq(task_leases!.id, reviewLease.id));
  const freshAt = new Date(Date.now() - 60_000).toISOString();
  const fresh = await invoke(session.session_id, {
    agent_session_id: session.session_id,
    agent_session_token: session.session_token,
    observed_at: freshAt,
    sequence: 2,
    method: "turn/started",
    status: "idle",
  });
  assert.equal(fresh.statusCode, 200);
  assert.deepEqual((fresh.body as { lease_heartbeats: unknown[] }).lease_heartbeats, [{ id: lease.id, epoch: lease.epoch }]);
  assert.equal((fresh.body as { presence: { status: string; status_text: string } }).presence.status, "idle");
  assert.equal((fresh.body as { presence: { status: string; status_text: string } }).presence.status_text, "Connected — listening");
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "post-TTL accepted native activity leaves session last_seen_at unchanged");
  const [workAfterFresh] = await db!.select().from(task_leases!).where(eq(task_leases!.id, lease.id));

  const delayedAt = new Date(Date.parse(freshAt) - 60_000).toISOString();
  const delayed = await invoke(session.session_id, { observed_at: delayedAt, sequence: 1, method: "turn/started", status: "working" });
  assert.equal(delayed.statusCode, 200);
  assert.deepEqual((delayed.body as { lease_heartbeats: unknown[] }).lease_heartbeats, []);
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "out-of-order native activity cannot refresh generic session/workplace liveness");

  const futureAt = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await invoke(session.session_id, { observed_at: futureAt, sequence: 3, method: "turn/started" })).statusCode, 400);
  assert.equal((await invoke(session.session_id, {
    observed_at: new Date().toISOString(), sequence: 3, method: "turn/started", status: "sleeping",
  })).statusCode, 400, "native activity accepts only public presence statuses");
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "malformed/future native activity cannot refresh generic session/workplace liveness");
  assert.equal((await invoke(session.session_id, {
    agent_session_token: "invalid-native-session-token",
    observed_at: new Date().toISOString(),
    sequence: 3,
    method: "turn/started",
  })).statusCode, 401);
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "invalid session credentials cannot refresh generic session/workplace liveness");

  const [observation] = await db!.select().from(room_agent_liveness_observations!).where(eq(room_agent_liveness_observations!.agent_session_id, session.session_id));
  const [heldLease] = await db!.select().from(task_leases!).where(eq(task_leases!.id, lease.id));
  const [heldReview] = await db!.select().from(task_leases!).where(eq(task_leases!.id, reviewLease.id));
  const [presence] = await db!.select().from(room_agent_presence!).where(eq(room_agent_presence!.agent_session_id, session.session_id));
  assert.equal(observation?.source, "native_harness");
  assert.equal(new Date(observation!.last_observed_at).getTime(), new Date(freshAt).getTime());
  assert.equal(heldLease?.last_heartbeat_at, workAfterFresh?.last_heartbeat_at, "delayed/future observations cannot extend lease freshness");
  assert.ok(Date.parse(heldLease!.last_heartbeat_at!) > Date.parse(freshAt), "work lease freshness uses server-now");
  assert.equal(heldReview?.last_heartbeat_at, reviewBefore?.last_heartbeat_at, "review lease is not native-heartbeated");
  assert.equal(presence?.status, "idle");
  assert.equal(presence?.status_text, "Connected — listening");

  const successor = await createRoomAgentSession!({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: "Successor | Worker Owner's agent | Agent",
    agent_key: "WorkerOwner/successor",
    agent_instance_id: "instance_successor",
    display_name: "Successor",
    owner_account_id: "acct_bearer_test",
    owner_label: "Worker Owner",
    ide_label: "Agent",
  });
  const successorHeartbeat = new Date(Date.now() - 30_000).toISOString();
  await db!.update(task_leases!).set({
    agent_session_id: successor.session_id,
    agent_key: successor.agent_key,
    epoch: lease.epoch + 1,
    last_heartbeat_at: successorHeartbeat,
  }).where(eq(task_leases!.id, lease.id));
  await db!.update(room_agent_presence!).set({
    agent_session_id: successor.session_id,
    agent_key: successor.agent_key,
    status: "idle",
    status_text: "Successor owns presence",
  }).where(eq(room_agent_presence!.actor_label, session.actor_label));
  const successorFenceProbe = await invoke(session.session_id, { observed_at: new Date().toISOString(), sequence: 4, method: "turn/completed" });
  assert.equal(successorFenceProbe.statusCode, 200);
  assert.equal((successorFenceProbe.body as { accepted: boolean }).accepted, false);
  assert.deepEqual((successorFenceProbe.body as { lease_heartbeats: unknown[] }).lease_heartbeats, []);
  const [successorLease] = await db!.select().from(task_leases!).where(eq(task_leases!.id, lease.id));
  const [successorPresence] = await db!.select().from(room_agent_presence!).where(eq(room_agent_presence!.actor_label, session.actor_label));
  const [staleObservation] = await db!.select().from(room_agent_liveness_observations!).where(eq(room_agent_liveness_observations!.agent_session_id, session.session_id));
  assert.equal(successorLease?.agent_session_id, successor.session_id);
  assert.equal(successorLease?.epoch, lease.epoch + 1);
  assert.equal(new Date(successorLease!.last_heartbeat_at!).getTime(), new Date(successorHeartbeat).getTime());
  assert.equal(successorPresence?.agent_session_id, successor.session_id, "stale native activity cannot reclaim rendered presence");
  assert.equal(successorPresence?.status_text, "Successor owns presence");
  assert.equal(new Date(staleObservation!.last_observed_at).getTime(), new Date(freshAt).getTime(), "stale-owner activity transaction rolls native evidence back too");
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "successor-rejected native activity cannot refresh generic session/workplace liveness");
  assert.equal((await invoke("another_session", { observed_at: freshAt, sequence: 3, method: "turn/completed" })).statusCode, 403);
  assert.equal(await readLastSeenAt(), originalLastSeenAt, "cross-session native activity cannot refresh generic session/workplace liveness");
  await endRoomAgentSession!({ session_id: session.session_id });
  assert.equal((await invoke(session.session_id, { observed_at: new Date().toISOString(), sequence: 5, method: "turn/started" })).statusCode, 401, "ended session tokens cannot publish native activity");
});

test("bearer cannot hand off or release another worker's lease", { skip: requiresDatabase }, async () => {
  const { room, session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const task = await createTask!(room.id, "leased", "Other");
  const otherSession = await createRoomAgentSession!({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: "Other | Worker Owner's agent | Agent",
    agent_key: "WorkerOwner/other",
    agent_instance_id: "instance_other",
    display_name: "Other",
    owner_account_id: "acct_bearer_test",
    owner_label: "Worker Owner",
    ide_label: "Agent",
  });
  await createTaskLease!({ room_id: room.id, task_id: task.id, kind: "work", agent_key: otherSession.agent_key, agent_session_id: otherSession.session_id, actor_label: otherSession.actor_label, created_by: otherSession.actor_label });
  let handler: ((...args: any[]) => Promise<void>) | null = null;
  registerTaskLeaseActionRoute({ post(_path: RegExp, callback: any) { handler = callback; } } as never, {
    resolveCanonicalRoomRequestId: async () => room.id, resolveRoomOrReply: async () => room, requireParticipant: async () => true, requireAdmin: async (_req: unknown, res: any) => { res.status(403).json({ error: "admin" }); return false; },
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" }), normalizeOptionalString: (value: unknown) => typeof value === "string" ? value : null,
  } as never);
  const invoke = async (body: Record<string, unknown>) => { const res = responseRecorder(); await handler!({ params: { 0: room.id, 1: task.id }, body, ...auth }, res); return res; };
  assert.equal((await invoke({ action: "handoff" })).statusCode, 403);
  assert.equal((await invoke({ action: "release" })).statusCode, 403);
});

test("bearer and body credentials must identify the same worker session", { skip: requiresDatabase }, async () => {
  const first = await seed();
  const second = await createRoomAgentSession!({
    room_id: first.room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: "OtherWorker | Worker Owner's agent | Agent",
    agent_key: "WorkerOwner/otherworker",
    agent_instance_id: "instance_other",
    display_name: "OtherWorker",
    owner_account_id: "acct_bearer_test",
    owner_label: "Worker Owner",
    ide_label: "Agent",
  });
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${first.session.worker_bearer}` } } as never);
  const identity = await resolveRequestAgentIdentity({
    req: auth as never,
    room_id: first.room.id,
    agent_session_id: second.session_id,
    agent_session_token: second.session_token,
  });
  assert.equal(identity, null);
});
