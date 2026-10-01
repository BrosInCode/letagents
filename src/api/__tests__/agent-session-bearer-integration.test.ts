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
const { hashToken } = await import("../db/utils.js");

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
const recordNativeHarnessActivity = dbModule?.recordNativeHarnessActivity;
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
  allowed.push(
    ["POST", "/rooms/github.com/org/repo/board-intents", "coordination.propose"],
    ["POST", "/rooms/github.com/org/repo/board-intents/bi_1/approve", "coordination.self_write"],
    ["POST", "/api/rooms/github.com/org/repo/board-intents/bi_1/deny", "coordination.self_write"],
  );
  for (const [method, route, capability] of allowed) assert.equal(requiredAgentSessionRouteCapability(method, route), capability);
  for (const [method, route] of [
    ["POST", "/rooms/room_1/board-managers"], ["POST", "/rooms/room_1/tasks/task_1/stale-prompt-mute"],
    ["POST", "/rooms/room_1/tasks/task_1/focus-room"], ["POST", "/rooms/room_1/participants/clear-disconnected"],
    ["PATCH", "/rooms/room_1"], ["POST", "/rooms/room_1/artifacts/future-action"],
    ["GET", "/rental/provider/requests"], ["POST", "/rental/sessions/rental_1/complete"],
  ]) assert.equal(requiredAgentSessionRouteCapability(method, route), null, `${method} ${route} must remain default-deny`);
});

test("worker bearer routes authorize multi-segment room ids exactly like the room routes parse them", () => {
  // Git rooms are `github.com/<org>/<repo>` — three path segments. The room
  // routes match them greedily (e.g. /^\/rooms\/(.+)\/messages$/), and the
  // capability registry must authorize the same shapes: with a single-segment
  // room pattern, every supervised worker call in a Git room failed 403,
  // starting with the ingress bootstrap's room tail read.
  const gitRoom = "github.com/brosincode/letagents";
  const allowed: Array<[string, string, string]> = [
    ["GET", `/rooms/${gitRoom}/messages`, "messages.read"],
    ["GET", `/rooms/${gitRoom}/messages/poll`, "messages.read"],
    ["POST", `/rooms/${gitRoom}/messages`, "messages.write"],
    ["GET", `/rooms/${gitRoom}/presence`, "coordination.read"],
    ["POST", `/rooms/${gitRoom}/agent-sessions/agent_session_9/native-activity`, "coordination.self_write"],
    ["PUT", `/rooms/${gitRoom}/agents/self/observation`, "coordination.self_write"],
    ["POST", `/rooms/${gitRoom}/tasks`, "coordination.propose"],
  ];
  for (const [method, route, capability] of allowed) {
    assert.equal(requiredAgentSessionRouteCapability(method, route), capability, `${method} ${route}`);
  }
  for (const [method, route] of [
    ["PATCH", `/rooms/${gitRoom}`],
    ["POST", `/rooms/${gitRoom}/board-managers`],
    ["POST", `/rooms/${gitRoom}/participants/clear-disconnected`],
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

test("native activity reclaims rendered presence after an ended same-agent predecessor", { skip: requiresDatabase }, async () => {
  if (!recordNativeHarnessActivity || !endRoomAgentSession || !createRoomAgentSession || !room_agent_presence || !db) {
    throw new Error("missing DB harness");
  }
  const { room, session: predecessor } = await seed();
  const activity = (session: typeof predecessor, sequence: number) => recordNativeHarnessActivity({
    room_id: room.id,
    agent_session_id: session.session_id,
    actor_label: session.actor_label,
    agent_key: session.agent_key,
    session_kind: "worker",
    runtime: session.runtime,
    display_name: session.display_name,
    owner_label: session.owner_label,
    ide_label: session.ide_label,
    repo_branch: session.repo_branch,
    provider_observed_at: new Date().toISOString(),
    sequence,
    method: "native_harness.bound",
    status: "idle",
  });

  assert.equal((await activity(predecessor, 1)).accepted, true);
  await endRoomAgentSession({ session_id: predecessor.session_id });
  const [retainedPresence] = await db.select().from(room_agent_presence)
    .where(eq(room_agent_presence.agent_session_id, predecessor.session_id));
  assert.equal(retainedPresence, undefined,
    "ending a credential retires its live presence projection transactionally");

  const successor = await createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: predecessor.runtime,
    actor_label: predecessor.actor_label,
    agent_key: predecessor.agent_key,
    agent_instance_id: `${predecessor.agent_instance_id}-successor`,
    display_name: predecessor.display_name,
    owner_account_id: predecessor.owner_account_id,
    owner_label: predecessor.owner_label,
    ide_label: predecessor.ide_label,
  });
  assert.notEqual(successor.session_id, predecessor.session_id);

  const accepted = await activity(successor, 1);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.presence?.agent_session_id, successor.session_id);
  const [currentPresence] = await db.select().from(room_agent_presence)
    .where(eq(room_agent_presence.actor_label, predecessor.actor_label));
  assert.equal(currentPresence?.agent_session_id, successor.session_id);
  assert.equal(currentPresence?.agent_key, predecessor.agent_key);
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

// Reproduces the Hollow Wood workflow through real HTTP middleware, worker
// credentials, routes, and database transactions (no owner-token substitution).
test("managed board workflow preserves retries, manager authority, and claim leases", { skip: requiresDatabase }, async () => {
  const { default: express } = await import("express");
  const { registerTaskRecordRoutes } = await import("../routes/rooms/tasks/task-record.js");
  const { registerTaskListAndCreateRoutes } = await import("../routes/rooms/tasks/list-and-create.js");
  const { registerRoomBoardRoutes } = await import("../routes/rooms/board.js");
  const { createTaskCoordinationEnforcement } = await import("../tasks/coordination-enforcement.js");
  const { room, session } = await seed();
  const peer = await createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "claude-code",
    actor_label: "Peer | Worker Owner's agent | Agent", agent_key: "WorkerOwner/peer",
    display_name: "Peer", owner_account_id: "acct_bearer_test", owner_label: "Worker Owner", ide_label: "Agent",
  });
  await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: session.session_id, assigned_by: "owner" });
  const enforcement = createTaskCoordinationEnforcement({
    getAgentIdentityByCanonicalKey: async () => { throw new Error("worker claims must use their authenticated identity"); },
    createCoordinationEvent: dbModule!.createCoordinationEvent,
    getActiveTaskLocks: dbModule!.getActiveTaskLocks,
    getTasks: dbModule!.getTasks,
    getFocusRoomsForParent: async () => [],
    getActiveTaskLeases: dbModule!.getActiveTaskLeases,
    updateTaskLeaseWorkflowRefs: dbModule!.updateTaskLeaseWorkflowRefs,
    shouldRequireBoardIntent: async () => false,
    verifyBoardIntentApproval: dbModule!.verifyBoardIntentApproval,
  });
  let failDecisionNotifications = false;
  const decisionNotifications: string[] = [];
  const deps = {
    emitProjectMessage: async (_projectId: string, _sender: string, _text: string, options?: { client_message_id?: string | null }) => {
      if (options?.client_message_id?.endsWith(":proposer_notify")) {
        if (failDecisionNotifications) throw new Error("private transport diagnostic");
        decisionNotifications.push(options.client_message_id);
      }
      return { id: "msg_notification" };
    },
    ...enforcement,
    enforceTaskCreateBoardIntentAdmission: enforcement.enforceTaskAdmissionPreconditions,
    taskEvents: { emit() {} },
    getTaskById: dbModule!.getTaskById, getTaskOwnershipState: dbModule!.getTaskOwnershipState,
    updateTask: dbModule!.updateTask,
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async (id: string) => id === room.id ? room : null,
    requireParticipant, requireAdmin,
    normalizeOptionalString: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" }),
    isTrustedAgentCreator: async () => false,
    emitTaskLifecycleStatusMessage: async () => {},
  };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerTaskListAndCreateRoutes(app, deps as never);
  registerTaskRecordRoutes(app, deps as never);
  registerRoomBoardRoutes(app, deps as never);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const call = async (method: string, suffix: string, body: unknown, bearer = session.worker_bearer!) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/rooms/${encodeURIComponent(room.id)}/${suffix}`, {
      method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const creation = { title: "Due dates", description: "Highlight overdue", source_message_id: "msg_121", client_task_id: "due-dates" };
    const retries = await Promise.all([call("POST", "tasks", creation), call("POST", "tasks", creation)]);
    assert.deepEqual(retries.map((r) => r.status).sort(), [200, 201]);
    const first = retries[0].body;
    assert.equal(first.id, retries[1].body.id);
    assert.equal(first.source_message_id, "msg_121");
    const changed = await call("POST", "tasks", { ...creation, title: "Different request with reused ID" });
    assert.equal(changed.status, 409);
    const second = await call("POST", "tasks", { ...creation, title: "Priorities", client_task_id: "priorities" });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.id, first.id, "one message can describe multiple tasks");
    const separate = await call("POST", "tasks", { ...creation, client_task_id: "another-due-dates-task" });
    assert.equal(separate.status, 201);
    assert.notEqual(separate.body.id, first.id, "explicitly separate tasks may have identical contents");
    const peerTask = await call("POST", "tasks", creation, peer.worker_bearer!);
    assert.equal(peerTask.status, 201);
    assert.notEqual(peerTask.body.id, first.id, "creation IDs are scoped to a worker");

    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "accepted" }, peer.worker_bearer!)).status, 403);
    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "accepted", pr_url: "https://example.com/pr/1" })).status, 403);
    const accepted = await call("PATCH", `tasks/${first.id}`, { status: "accepted" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((await call("PATCH", `tasks/${second.body.id}`, { status: "cancelled" })).status, 200);
    const claimBody = { status: "assigned", assignee: peer.actor_label, assignee_agent_key: peer.agent_key };
    const claimed = await call("PATCH", `tasks/${first.id}`, claimBody, peer.worker_bearer!);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.active_leases.length, 1);
    assert.equal(claimed.body.active_leases[0].agent_session_id, peer.session_id);
    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "in_progress" }, peer.worker_bearer!)).status, 200);
    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "in_review" })).status, 409, "the manager cannot take over the worker's execution");
    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "in_review" }, peer.worker_bearer!)).status, 200);
    assert.equal((await call("PATCH", `tasks/${first.id}`, { status: "merged" })).status, 403, "manager is not an admin");
    await call("PATCH", `tasks/${separate.body.id}`, { status: "accepted" });
    const competing = await Promise.all([
      call("PATCH", `tasks/${separate.body.id}`, claimBody, peer.worker_bearer!),
      call("PATCH", `tasks/${separate.body.id}`, { status: "assigned", assignee: session.actor_label, assignee_agent_key: session.agent_key }),
    ]);
    assert.equal(competing.filter((reply) => reply.status === 200).length, 1, "concurrent claims have exactly one winner");
    const leases = await dbModule!.getActiveTaskLeases(room.id, separate.body.id);
    assert.equal(leases.length, 1);
    const claimedTask = await dbModule!.getTaskById(room.id, separate.body.id);
    assert.equal(claimedTask!.assignee_agent_key, leases[0].agent_key);


    const proposed = await call("POST", "board-intents", {
      action_type: "task_create", payload: { title: "Testing", description: null, source_message_id: "msg_121" },
      actor_label: "Spoofed manager", actor_key: session.agent_key, actor_instance_id: "spoofed-instance",
    }, peer.worker_bearer!);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const intentId = proposed.body.intent.id;
    assert.equal(proposed.body.intent.proposer_actor_label, peer.actor_label);
    assert.equal(proposed.body.intent.proposer_actor_key, peer.agent_key);
    assert.equal(proposed.body.intent.proposer_actor_instance_id, peer.agent_instance_id ?? null);
    assert.equal(proposed.body.intent.proposer_agent_session_id, peer.session_id);
    assert.equal((await call("POST", "board-intents", {
      action_type: "task_create", payload: { title: "Spoofed session" },
      agent_session_id: session.session_id, agent_session_token: session.session_token,
    }, peer.worker_bearer!)).status, 401);
    assert.equal((await call("POST", `board-intents/${intentId}/deny`, {}, peer.worker_bearer!)).status, 403);
    assert.equal((await call("POST", "board-manager", { agent_session_id: peer.session_id }, peer.worker_bearer!)).status, 403);
    assert.equal((await call("POST", `board-intents/${intentId}/approve`, {}, peer.worker_bearer!)).status, 403);
    const approved = await call("POST", `board-intents/${intentId}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.result.kind, "task_created");
    assert.equal(approved.body.result.task.status, "proposed");
    assert.equal((await call("PATCH", `tasks/${approved.body.result.task.id}`, { status: "accepted" })).status, 200);
    const nextIntent = await call("POST", "board-intents", {
      action_type: "task_create", payload: { title: "More testing", source_message_id: "msg_121" },
    }, peer.worker_bearer!);
    const nextApproval = await call("POST", `board-intents/${nextIntent.body.intent.id}/approve`, {});
    assert.equal(nextApproval.status, 200, JSON.stringify(nextApproval.body));
    assert.notEqual(nextApproval.body.result.task.id, approved.body.result.task.id);
    const approvalPayload = { task_id: first.id, status: "in_review" };
    const credentialIntent = await call("POST", "board-intents", {
      action_type: "task_update", task_id: first.id, payload: approvalPayload,
    }, peer.worker_bearer!);
    assert.equal(credentialIntent.status, 201);
    failDecisionNotifications = true;
    const credentialApproval = await call("POST", `board-intents/${credentialIntent.body.intent.id}/approve`, {});
    assert.equal(credentialApproval.status, 200);
    assert.equal(credentialApproval.body.proposer_notification.delivered, false);
    assert.doesNotMatch(JSON.stringify(credentialApproval.body), /private transport diagnostic/);
    failDecisionNotifications = false;
    const replayApproval = await call("POST", `board-intents/${credentialIntent.body.intent.id}/approve`, {});
    assert.equal(replayApproval.status, 200);
    assert.equal(replayApproval.body.proposer_notification.delivered, true);
    assert.equal(replayApproval.body.approval_token, undefined, "approval retry never mints another token");
    assert.equal(replayApproval.body.intent.approval_token_hash, credentialApproval.body.intent.approval_token_hash);
    assert.equal(replayApproval.body.result.requires_follow_up, true);
    await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: peer.session_id, assigned_by: "owner" });
    assert.equal((await call("POST", `board-intents/${credentialIntent.body.intent.id}/approve`, {})).status, 403, "former manager cannot resend a decision");
    await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: session.session_id, assigned_by: "owner" });
    const replayCreation = await call("POST", `board-intents/${intentId}/approve`, {});
    assert.equal(replayCreation.status, 200);
    assert.equal(replayCreation.body.result.task.id, approved.body.result.task.id, "task-create retry returns the existing task");
    const deniedIntent = await call("POST", "board-intents", { action_type: "task_update", task_id: first.id, payload: approvalPayload }, peer.worker_bearer!);
    failDecisionNotifications = true;
    const firstDenial = await call("POST", `board-intents/${deniedIntent.body.intent.id}/deny`, {});
    assert.equal(firstDenial.status, 200);
    assert.equal(firstDenial.body.proposer_notification.delivered, false);
    failDecisionNotifications = false;
    const replayDenial = await call("POST", `board-intents/${deniedIntent.body.intent.id}/deny`, {});
    assert.equal(replayDenial.status, 200);
    assert.equal(replayDenial.body.proposer_notification.delivered, true);
    assert.ok(decisionNotifications.includes(`board_intent:${deniedIntent.body.intent.id}:denied:proposer_notify`));
    // Reassigning the manager replaced the assignment that approved credentialIntent.
    const staleManagerApproval = await dbModule!.verifyBoardIntentApproval({ room_id: room.id, action_type: "task_update",
      payload: approvalPayload, intent_id: credentialIntent.body.intent.id,
      trusted_worker: { agent_session_id: peer.session_id, agent_key: peer.agent_key } });
    assert.equal(staleManagerApproval.kind === "deny" && staleManagerApproval.code, "board_intent_manager_changed");
    const boundIntent = await call("POST", "board-intents", { action_type: "task_update", task_id: first.id, payload: approvalPayload }, peer.worker_bearer!);
    assert.equal((await call("POST", `board-intents/${boundIntent.body.intent.id}/approve`, {})).status, 200);
    const boundApproval = { room_id: room.id, action_type: "task_update" as const,
      payload: approvalPayload, intent_id: boundIntent.body.intent.id as string,
      trusted_worker: { agent_session_id: peer.session_id, agent_key: peer.agent_key } };
    assert.equal((await dbModule!.verifyBoardIntentApproval(boundApproval)).kind, "allow");
    for (const invalid of [
      { ...boundApproval, trusted_worker: undefined },
      { ...boundApproval, trusted_worker: { ...boundApproval.trusted_worker, agent_session_id: session.session_id } },
      { ...boundApproval, trusted_worker: { ...boundApproval.trusted_worker, agent_key: session.agent_key } },
      { ...boundApproval, room_id: "wrong-room" },
      { ...boundApproval, payload: { ...approvalPayload, status: "done" } },
      { ...boundApproval, now: new Date("2099-01-01T00:00:00Z") },
    ]) {
      assert.equal((await dbModule!.verifyBoardIntentApproval(invalid)).kind, "deny");
      assert.equal((await dbModule!.consumeBoardIntentApproval(invalid)).kind, "deny", "transaction repeats the exact authority fence");
    }
    const consumed = await Promise.all([dbModule!.consumeBoardIntentApproval(boundApproval), dbModule!.consumeBoardIntentApproval(boundApproval)]);
    assert.deepEqual(consumed.map((result) => result.kind).sort(), ["allow", "deny"]);
    assert.equal((await dbModule!.consumeBoardIntentApproval(boundApproval)).kind, "deny");
    await db!.update(schemaModule!.board_intents).set({ expires_at: "2000-01-01T00:00:00Z" })
      .where(eq(schemaModule!.board_intents.id, boundApproval.intent_id));
    const usedReplay = await call("POST", `board-intents/${boundApproval.intent_id}/approve`, {});
    assert.equal(usedReplay.status, 200, "used decisions retain historical replay after expiry");
    assert.equal(usedReplay.body.result.requires_follow_up, false);
    const expiringIntent = await call("POST", "board-intents", { action_type: "task_update", task_id: first.id, payload: approvalPayload }, peer.worker_bearer!);
    assert.equal((await call("POST", `board-intents/${expiringIntent.body.intent.id}/approve`, {})).status, 200);
    await db!.update(schemaModule!.board_intents).set({ expires_at: "2000-01-01T00:00:00Z" })
      .where(eq(schemaModule!.board_intents.id, expiringIntent.body.intent.id));
    const notificationCount = decisionNotifications.length;
    const expiredReplay = await call("POST", `board-intents/${expiringIntent.body.intent.id}/approve`, {});
    assert.equal(expiredReplay.status, 404);
    assert.equal(decisionNotifications.length, notificationCount, "expired approval cannot notify the worker to continue");


    const legacy = { title: "Legacy task", source_message_id: "msg_121" };
    const legacyCreate = await call("POST", "tasks", legacy);
    const legacyRetry = await call("POST", "tasks", legacy);
    assert.equal(legacyCreate.status, 201);
    assert.equal(legacyRetry.status, 200);
    assert.equal(legacyRetry.body.id, legacyCreate.body.id, "legacy retries cannot alias explicit-ID tasks from the same message");

  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function startBoardRouteServer(room: { id: string }) {
  const { default: express } = await import("express");
  const { registerTaskRecordRoutes } = await import("../routes/rooms/tasks/task-record.js");
  const { registerRoomBoardRoutes } = await import("../routes/rooms/board.js");
  const { createTaskCoordinationEnforcement } = await import("../tasks/coordination-enforcement.js");
  const enforcement = createTaskCoordinationEnforcement({
    getAgentIdentityByCanonicalKey: dbModule!.getAgentIdentityByCanonicalKey,
    createCoordinationEvent: dbModule!.createCoordinationEvent,
    getActiveTaskLocks: dbModule!.getActiveTaskLocks,
    getTasks: dbModule!.getTasks,
    getFocusRoomsForParent: async () => [],
    getActiveTaskLeases: dbModule!.getActiveTaskLeases,
    updateTaskLeaseWorkflowRefs: dbModule!.updateTaskLeaseWorkflowRefs,
    shouldRequireBoardIntent: dbModule!.shouldRequireBoardIntent,
    verifyBoardIntentApproval: dbModule!.verifyBoardIntentApproval,
    getActiveBoardManager: dbModule!.getActiveBoardManager,
  });
  const deps = {
    ...enforcement,
    emitProjectMessage: async () => ({ id: "msg_notification" }),
    taskEvents: { emit() {} },
    getTaskById: dbModule!.getTaskById, getTaskOwnershipState: dbModule!.getTaskOwnershipState,
    updateTask: dbModule!.updateTask,
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async (id: string) => id === room.id ? room : null,
    requireParticipant, requireAdmin,
    normalizeOptionalString: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" }),
    emitTaskLifecycleStatusMessage: async () => {},
  };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerTaskRecordRoutes(app, deps as never);
  registerTaskLeaseActionRoute(app, deps as never);
  registerRoomBoardRoutes(app, deps as never);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  return {
    async call(method: string, suffix: string, body: unknown, bearer: string | null) {
      const response = await fetch(`http://127.0.0.1:${address.port}/rooms/${encodeURIComponent(room.id)}/${suffix}`, {
        method, body: JSON.stringify(body),
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json" },
      });
      return { status: response.status, body: await response.json() as any };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

// A worker's approved closeout was refused as an "owner or admin action", so
// every task in a Required-mode room waited at merged for a person.
test("an approved board intent authorizes exactly its transition for the proposing worker", { skip: requiresDatabase }, async () => {
  const { room, session: manager } = await seed();
  const workerSession = (name: string) => createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `${name} | Worker Owner's agent | Agent`, agent_key: `WorkerOwner/${name.toLowerCase()}`,
    display_name: name, owner_account_id: "acct_bearer_test", owner_label: "Worker Owner", ide_label: "Agent",
  });
  const worker = await workerSession("Closer");
  const other = await workerSession("Bystander");
  await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: manager.session_id, assigned_by: "owner" });
  await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "intent_required", updated_by: "owner" });
  const { call, close } = await startBoardRouteServer(room);
  const task = await createTask!(room.id, "Render the dots", "owner");
  const register = async (bearer: string, action_type: string, payload: Record<string, unknown>) => {
    const reply = await call("POST", "board-intents", { action_type, task_id: task.id, payload }, bearer);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.intent.id as string;
  };
  const approve = async (intentId: string) => {
    const reply = await call("POST", `board-intents/${intentId}/approve`, {}, manager.worker_bearer!);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body;
  };
  const patch = (body: Record<string, unknown>, bearer = worker.worker_bearer!) =>
    call("PATCH", `tasks/${task.id}`, body, bearer);
  try {
    await dbModule!.updateTask(room.id, task.id, { status: "accepted" });
    const claim = await approve(await register(worker.worker_bearer!, "task_claim", {
      task_id: task.id, status: "assigned", assignee: worker.actor_label, assignee_agent_key: worker.agent_key, pr_url: null,
    }));
    assert.equal(claim.result.kind, "task_claimed");
    assert.equal((await patch({ status: "in_progress" })).status, 200);
    assert.equal((await patch({ status: "in_review" })).status, 200);
    await dbModule!.updateTask(room.id, task.id, { status: "merged" });

    const unapproved = await patch({ status: "done" });
    assert.equal(unapproved.status, 403);
    assert.equal(unapproved.body.error, "Worker bearers cannot perform owner or admin actions.");

    const closePayload = { task_id: task.id, status: "done", assignee: null, assignee_agent_key: null, pr_url: null };
    const closeIntent = await register(worker.worker_bearer!, "task_close", closePayload);
    const pending = await patch({ status: "done", board_intent_id: closeIntent });
    assert.equal(pending.status, 403);
    assert.equal(pending.body.code, "board_intent_not_approved");
    assert.equal((await approve(closeIntent)).result.requires_follow_up, true);

    const borrowed = await patch({ status: "done", board_intent_id: closeIntent }, other.worker_bearer!);
    assert.equal(borrowed.status, 403, "another worker cannot use this worker's approval");
    assert.equal(borrowed.body.code, "board_intent_worker_mismatch");
    const mismatched = await patch({ status: "cancelled", board_intent_id: closeIntent });
    assert.equal(mismatched.status, 403, "the approval covers only its own transition");
    assert.equal(mismatched.body.code, "board_intent_payload_mismatch");
    const broader = await patch({ status: "done", assignee: null, board_intent_id: closeIntent });
    assert.equal(broader.status, 403, "the approval is not a general admin grant");
    assert.equal((await dbModule!.getTaskById(room.id, task.id))!.status, "merged");
    assert.equal((await dbModule!.getBoardIntent({ room_id: room.id, intent_id: closeIntent }))!.status, "approved");

    const closed = await patch({ status: "done", board_intent_id: closeIntent });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "done");
    assert.equal((await dbModule!.getBoardIntent({ room_id: room.id, intent_id: closeIntent }))!.status, "used");
    const replay = await patch({ status: "done", board_intent_id: closeIntent });
    assert.equal(replay.status, 403, "a used approval cannot be replayed");

    const reopenIntent = await register(other.worker_bearer!, "task_override", { ...closePayload, status: "accepted" });
    await approve(reopenIntent);
    const reopened = await patch({ status: "accepted", board_intent_id: reopenIntent }, other.worker_bearer!);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.status, "accepted");

    // A lease release on someone else's work follows the same rule.
    const reclaim = await approve(await register(worker.worker_bearer!, "task_claim", {
      task_id: task.id, status: "assigned", assignee: worker.actor_label, assignee_agent_key: worker.agent_key, pr_url: null,
    }));
    const leaseId = reclaim.result.task.active_leases[0].id as string;
    const release = (body: Record<string, unknown> = {}) =>
      call("POST", `tasks/${task.id}/lease-action`, { action: "release", ...body }, other.worker_bearer!);
    assert.equal((await release()).status, 403, "releasing another worker's lease still needs authority");
    const releaseIntent = await register(other.worker_bearer!, "task_override", {
      task_id: task.id, action: "release", lease_id: leaseId, target_actor_key: null, target_agent_session_id: null,
    });
    const pendingRelease = await release({ board_intent_id: releaseIntent });
    assert.equal(pendingRelease.status, 403);
    assert.equal(pendingRelease.body.code, "board_intent_not_approved");
    await approve(releaseIntent);
    const released = await release({ board_intent_id: releaseIntent });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.task.status, "accepted");
    assert.equal(released.body.released_lease.status, "revoked");
    assert.equal((await dbModule!.getBoardIntent({ room_id: room.id, intent_id: releaseIntent }))!.status, "used");
  } finally {
    await close();
  }
});

test("a manager cannot approve its own changes, and approvals do not outlive the task they were granted for", { skip: requiresDatabase }, async () => {
  const { room, session: manager } = await seed();
  const workerSession = (name: string) => createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `${name} | Worker Owner's agent | Agent`, agent_key: `WorkerOwner/${name.toLowerCase()}`,
    display_name: name, owner_account_id: "acct_bearer_test", owner_label: "Worker Owner", ide_label: "Agent",
  });
  const worker = await workerSession("Builder");
  const other = await workerSession("Other");
  await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: manager.session_id, assigned_by: "owner" });
  await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "intent_required", updated_by: "owner" });
  const { call, close } = await startBoardRouteServer(room);
  const task = await createTask!(room.id, "Colour the weekends", "owner");
  const closePayload = (status: string) => ({ task_id: task.id, status, assignee: null, assignee_agent_key: null, pr_url: null });
  const register = async (bearer: string, action_type: string, payload: Record<string, unknown>) => {
    const reply = await call("POST", "board-intents", { action_type, task_id: task.id, payload }, bearer);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.intent.id as string;
  };
  const approve = (intentId: string) => call("POST", `board-intents/${intentId}/approve`, {}, manager.worker_bearer!);
  const personApproves = async (intentId: string) =>
    assert.ok(await dbModule!.approveBoardIntent({ room_id: room.id, intent_id: intentId, decision_by: "Worker Owner" }));
  const patch = (body: Record<string, unknown>, bearer: string) => call("PATCH", `tasks/${task.id}`, body, bearer);
  const statusOf = async () => (await dbModule!.getTaskById(room.id, task.id))!.status;
  try {
    await dbModule!.updateTask(room.id, task.id, { status: "accepted" });
    const claim = await approve(await register(worker.worker_bearer!, "task_claim", {
      task_id: task.id, status: "assigned", assignee: worker.actor_label, assignee_agent_key: worker.agent_key, pr_url: null,
    }));
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal((await patch({ status: "in_progress" }, worker.worker_bearer!)).status, 200);

    const mismatched = await call("POST", "board-intents",
      { action_type: "task_close", task_id: "task_999", payload: closePayload("done") }, worker.worker_bearer!);
    assert.equal(mismatched.status, 400, "the task column must name the payload's task");
    const padded = await call("POST", "board-intents",
      { action_type: "task_close", payload: { ...closePayload("merged"), task_id: ` ${task.id} ` } }, worker.worker_bearer!);
    assert.equal(padded.status, 201, JSON.stringify(padded.body));
    assert.equal(padded.body.intent.payload.task_id, task.id, "the payload's task id is stored trimmed");
    assert.equal(padded.body.intent.task_id, task.id);

    // The manager cannot close someone else's work by approving its own request.
    assert.equal((await patch({ status: "done" }, manager.worker_bearer!)).status, 403);
    const managerClose = await register(manager.worker_bearer!, "task_close", closePayload("done"));
    const selfApproval = await approve(managerClose);
    assert.equal(selfApproval.status, 403);
    assert.equal(selfApproval.body.code, "board_intent_self_approval");
    await personApproves(managerClose);
    const managerAction = await patch({ status: "done", board_intent_id: managerClose }, manager.worker_bearer!);
    assert.equal(managerAction.status, 403, "the active manager never carries out its own request");
    assert.equal(managerAction.body.code, "board_intent_manager_self_action");
    assert.equal(await statusOf(), "in_progress");
    const managerTask = await approve(await call("POST", "board-intents", {
      action_type: "task_create", payload: { title: "Manager follow-up", description: null, source_message_id: null },
    }, manager.worker_bearer!).then((reply) => reply.body.intent.id as string));
    assert.equal(managerTask.status, 200, "proposing a task is exempt: it only adds a proposed task");
    assert.equal(managerTask.body.result.kind, "task_created");

    // An approval is for the task as it stood: a person closing, reopening and
    // reassigning the task retires it, so it cannot close the new work.
    const workerClose = await register(worker.worker_bearer!, "task_close", closePayload("done"));
    assert.equal((await approve(workerClose)).status, 200);
    const pendingCancel = await register(worker.worker_bearer!, "task_close", closePayload("cancelled"));
    await dbModule!.updateTask(room.id, task.id, { status: "done" });
    await dbModule!.updateTask(room.id, task.id, { status: "accepted" });
    await dbModule!.updateTask(room.id, task.id, { status: "assigned", assignee: other.actor_label, assignee_agent_key: other.agent_key });
    await dbModule!.updateTask(room.id, task.id, { status: "in_progress" });
    const replay = await patch({ status: "done", board_intent_id: workerClose }, worker.worker_bearer!);
    assert.equal(replay.status, 403, JSON.stringify(replay.body));
    assert.equal(replay.body.code, "board_intent_not_approved");
    assert.equal((await dbModule!.getBoardIntent({ room_id: room.id, intent_id: workerClose }))!.status, "superseded");
    assert.equal(await statusOf(), "in_progress");
    const staleDecision = await approve(pendingCancel);
    assert.equal(staleDecision.status, 409);
    assert.equal(staleDecision.body.code, "board_intent_superseded");

    // With manager mode off, a leftover manager decides nothing; a person's
    // approval is still a person's decision, as for handoffs in off mode.
    await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "off", updated_by: "owner" });
    const offClose = await register(other.worker_bearer!, "task_close", closePayload("done"));
    const offApproval = await approve(offClose);
    assert.equal(offApproval.status, 403);
    assert.equal(offApproval.body.code, "board_manager_mode_off");
    await personApproves(offClose);
    const offAction = await patch({ status: "done", board_intent_id: offClose }, other.worker_bearer!);
    assert.equal(offAction.status, 200, JSON.stringify(offAction.body));
    assert.equal(await statusOf(), "done");
  } finally {
    await close();
  }
});

test("approvals end with the task state, mode and manager they were granted under", { skip: requiresDatabase }, async () => {
  const { room, session: manager } = await seed();
  const workerSession = (name: string, agentKey = `WorkerOwner/${name.toLowerCase()}`) => createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `${name} | Worker Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `instance_${name.toLowerCase()}`,
    display_name: name, owner_account_id: "acct_bearer_test", owner_label: "Worker Owner", ide_label: "Agent",
  });
  const worker = await workerSession("Holder");
  const other = await workerSession("Taker");
  const deputy = await workerSession("Deputy");
  const managerTwin = await workerSession("ManagerTwin", manager.agent_key);
  await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: manager.session_id, assigned_by: "owner" });
  await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "intent_required", updated_by: "owner" });
  const { call, close } = await startBoardRouteServer(room);
  const task = await createTask!(room.id, "Mark the solstices", "owner");
  const closePayload = { task_id: task.id, status: "done", assignee: null, assignee_agent_key: null, pr_url: null };
  const register = async (bearer: string, action_type: string, payload: Record<string, unknown>) => {
    const reply = await call("POST", "board-intents", { action_type, task_id: task.id, payload }, bearer);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.intent.id as string;
  };
  const approve = (intentId: string, bearer = manager.worker_bearer!) =>
    call("POST", `board-intents/${intentId}/approve`, {}, bearer);
  const personApproves = async (intentId: string) =>
    assert.ok(await dbModule!.approveBoardIntent({ room_id: room.id, intent_id: intentId, decision_by: "Worker Owner" }));
  const closeWith = (intentId: string) =>
    call("PATCH", `tasks/${task.id}`, { status: "done", board_intent_id: intentId }, worker.worker_bearer!);
  const leaseAction = (body: Record<string, unknown>, bearer: string) =>
    call("POST", `tasks/${task.id}/lease-action`, body, bearer);
  try {
    await dbModule!.updateTask(room.id, task.id, { status: "accepted" });
    const claim = await approve(await register(worker.worker_bearer!, "task_claim", {
      task_id: task.id, status: "assigned", assignee: worker.actor_label, assignee_agent_key: worker.agent_key, pr_url: null,
    }));
    const leaseId = claim.body.result.task.active_leases[0].id as string;
    const leasePayload = (action: "release" | "handoff", target: string | null, targetSessionId: string | null = null) =>
      ({ task_id: task.id, action, lease_id: leaseId, target_actor_key: target, target_agent_session_id: targetSessionId });

    // Another session under the manager's own agent key is still the manager asking.
    const twinSelfApproval = await approve(await register(managerTwin.worker_bearer!, "task_close",
      { ...closePayload, status: "cancelled" }));
    assert.equal(twinSelfApproval.status, 403);
    assert.equal(twinSelfApproval.body.code, "board_intent_self_approval");

    // The manager cannot take or release a worker's lease through its own request.
    // The manager is a real, reachable handoff target, so only the refusal stops this.
    const [managerOwner, managerName] = manager.agent_key.split("/") as [string, string];
    await dbModule!.registerAgentIdentity({ owner_account_id: "acct_bearer_test", owner_login: managerOwner,
      owner_label: "Worker Owner", name: managerName });
    await dbModule!.markRoomAgentDeliveryConnected({
      room_id: room.id, actor_label: manager.actor_label, agent_key: manager.agent_key,
      agent_instance_id: manager.agent_instance_id, agent_session_id: manager.session_id,
      session_kind: "worker", runtime: manager.runtime, display_name: manager.display_name,
      owner_label: manager.owner_label, ide_label: manager.ide_label,
      credential_fence: { kind: "session_token", token_hash: hashToken(manager.session_token) },
      transport: "long_poll",
    });
    const managerHandoff = await register(manager.worker_bearer!, "task_override",
      leasePayload("handoff", manager.agent_key, manager.session_id));
    await personApproves(managerHandoff);
    const takenOver = await leaseAction({ action: "handoff", lease_id: leaseId, target_actor_key: manager.agent_key,
      target_agent_session_id: manager.session_id, board_intent_id: managerHandoff }, manager.worker_bearer!);
    assert.equal(takenOver.status, 403, JSON.stringify(takenOver.body));
    assert.equal(takenOver.body.code, "board_intent_manager_self_action");
    const managerRelease = await register(manager.worker_bearer!, "task_override", leasePayload("release", null));
    await personApproves(managerRelease);
    const released = await leaseAction({ action: "release", lease_id: leaseId, board_intent_id: managerRelease }, manager.worker_bearer!);
    assert.equal(released.status, 403, JSON.stringify(released.body));
    assert.equal(released.body.code, "board_intent_manager_self_action");

    // Switching the mode off and on again does not revive an approval.
    await dbModule!.updateTask(room.id, task.id, { status: "in_progress" });
    await dbModule!.updateTask(room.id, task.id, { status: "in_review" });
    await dbModule!.updateTask(room.id, task.id, { status: "merged" });
    const workerHandoff = await register(worker.worker_bearer!, "task_override", leasePayload("handoff", other.agent_key));
    assert.equal((await approve(workerHandoff)).status, 200);
    const beforeToggle = await register(worker.worker_bearer!, "task_close", closePayload);
    const toggleApproval = await approve(beforeToggle);
    assert.equal(toggleApproval.status, 200, JSON.stringify(toggleApproval.body));
    await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "off", updated_by: "owner" });
    await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "intent_required", updated_by: "owner" });
    const toggled = await closeWith(beforeToggle);
    assert.equal(toggled.status, 403);
    assert.equal(toggled.body.code, "board_intent_not_approved");
    assert.match((await dbModule!.getBoardIntent({ room_id: room.id, intent_id: beforeToggle }))!.decision_reason ?? "",
      /mode changed to off/);
    const staleHandoff = await dbModule!.getBoardIntent({ room_id: room.id, intent_id: workerHandoff });
    assert.equal(staleHandoff!.status, "superseded", "a handoff approved before the switch is retired with it");
    assert.match(staleHandoff!.decision_reason ?? "", /mode changed to off/);

    // An approval from a manager who has since been replaced is refused.
    const beforeTurnover = await register(worker.worker_bearer!, "task_close", closePayload);
    assert.equal((await approve(beforeTurnover)).status, 200);
    await dbModule!.assignBoardManager({ room_id: room.id, agent_session_id: deputy.session_id, assigned_by: "owner" });
    const turnedOver = await closeWith(beforeTurnover);
    assert.equal(turnedOver.status, 403);
    assert.equal(turnedOver.body.code, "board_intent_manager_changed");

    // The approval is checked against the task itself, not only against the
    // write paths that supersede: a change made underneath it still counts.
    const beforeChange = await register(worker.worker_bearer!, "task_close", closePayload);
    assert.equal((await approve(beforeChange, deputy.worker_bearer!)).status, 200);
    await pool!.query("UPDATE tasks SET assignee_agent_key = $1 WHERE room_id = $2 AND number = $3",
      [other.agent_key, room.id, Number(task.id.replace("task_", ""))]);
    const changed = await closeWith(beforeChange);
    assert.equal(changed.status, 403);
    assert.equal(changed.body.code, "board_intent_task_changed");
    await assert.rejects(
      dbModule!.updateTask(room.id, task.id, { status: "done" }, { boardIntentApproval: {
        room_id: room.id, action_type: "task_close", payload: closePayload, intent_id: beforeChange,
        trusted_worker: { agent_session_id: worker.session_id, agent_key: worker.agent_key },
      } }),
      (error: { code?: string }) => error.code === "board_intent_task_changed",
      "the write compares the approval with the task under its row lock",
    );
    assert.equal((await dbModule!.getTaskById(room.id, task.id))!.status, "merged");

    // Proposer fields sent by an unauthenticated caller prove nothing: a worker
    // cannot carry out an intent registered that way, even once approved.
    const spoofed = await call("POST", "board-intents", {
      action_type: "task_close", task_id: task.id, payload: closePayload,
      actor_label: worker.actor_label, actor_key: worker.agent_key, agent_session_id: worker.session_id,
    }, null);
    assert.equal(spoofed.status, 201, JSON.stringify(spoofed.body));
    assert.equal(spoofed.body.intent.proposer_agent_session_id, worker.session_id);
    await pool!.query("UPDATE tasks SET assignee_agent_key = $1 WHERE room_id = $2 AND number = $3",
      [worker.agent_key, room.id, Number(task.id.replace("task_", ""))]);
    await personApproves(spoofed.body.intent.id);
    const unverified = await closeWith(spoofed.body.intent.id);
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.code, "board_intent_worker_unverified");

    // A spoofed registration does not occupy the worker's own request, and two
    // workers asking for the same change each get their own request.
    const squatted = await call("POST", "board-intents", {
      action_type: "task_close", task_id: task.id, payload: { ...closePayload, status: "cancelled" },
      actor_label: worker.actor_label, actor_key: worker.agent_key, agent_session_id: worker.session_id,
    }, null);
    const ownRequest = await register(worker.worker_bearer!, "task_close", { ...closePayload, status: "cancelled" });
    assert.notEqual(ownRequest, squatted.body.intent.id);
    assert.equal(await register(worker.worker_bearer!, "task_close", { ...closePayload, status: "cancelled" }), ownRequest,
      "a retry returns the same proposer's request");
    assert.notEqual(await register(other.worker_bearer!, "task_close", { ...closePayload, status: "cancelled" }), ownRequest);

    // A manager approval that lands just after the mode was switched off
    // (after that switch retired the older ones) still cannot be used.
    const ownClose = await register(worker.worker_bearer!, "task_close", closePayload);
    await dbModule!.setRoomBoardManagerMode({ room_id: room.id, manager_mode: "off", updated_by: "owner" });
    const lateManager = await dbModule!.getActiveBoardManager(room.id);
    assert.ok(await dbModule!.approveBoardIntent({ room_id: room.id, intent_id: ownClose,
      decision_by: deputy.actor_label, manager_assignment_id: lateManager!.id }));
    const lateApproval = await closeWith(ownClose);
    assert.equal(lateApproval.status, 403, JSON.stringify(lateApproval.body));
    assert.equal(lateApproval.body.code, "board_manager_mode_off");
    await assert.rejects(
      dbModule!.updateTask(room.id, task.id, { status: "done" }, { boardIntentApproval: {
        room_id: room.id, action_type: "task_close", payload: closePayload, intent_id: ownClose,
        trusted_worker: { agent_session_id: worker.session_id, agent_key: worker.agent_key },
      } }),
      (error: { code?: string }) => error.code === "board_manager_mode_off",
      "the write refuses it too",
    );
  } finally {
    await close();
  }
});
