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
const createProjectWithName = dbModule?.createProjectWithName;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const endRoomAgentSession = dbModule?.endRoomAgentSession;
const revokeRoomAgentSessionBearer = dbModule?.revokeRoomAgentSessionBearer;
const rotateRoomAgentSessionBearer = dbModule?.rotateRoomAgentSessionBearer;
const createTask = dbModule?.createTask;
const createTaskLease = dbModule?.createTaskLease;

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
    actor_label: "BearerWorker | Worker Owner's agent | Agent",
    agent_key: "WorkerOwner/bearerworker",
    agent_instance_id: "instance_bearer",
    display_name: "BearerWorker",
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
    ["PATCH", "/rooms/room_1/reasoning-sessions/session_1", "coordination.self_write"],
    ["POST", "/rooms/room_1/agent-sessions/agent_session_1/disconnect", "coordination.self_write"],
  ];
  for (const [method, route, capability] of allowed) assert.equal(requiredAgentSessionRouteCapability(method, route), capability);
  for (const [method, route] of [
    ["POST", "/rooms/room_1/board-intents"], ["POST", "/rooms/room_1/tasks/task_1/stale-prompt-mute"],
    ["POST", "/rooms/room_1/tasks/task_1/focus-room"], ["POST", "/rooms/room_1/participants/clear-disconnected"],
    ["PATCH", "/rooms/room_1"], ["POST", "/rooms/room_1/artifacts/future-action"],
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
  registerRoomReasoningRoutes({ get() {}, post(path: RegExp, handler: any) { reasoningHandlers.set(path.source, handler); }, patch(path: RegExp, handler: any) { reasoningHandlers.set(path.source, handler); } } as never, {
    reasoningEvents: { emit() {} }, resolveCanonicalRoomRequestId: async () => "room_1", resolveRoomOrReply: async () => ({ id: "room_1" }), requireParticipant: async () => true,
    reasoningStore: { getReasoningSessionById: async () => ({ actor_label: "Other" }) },
  } as never);
  const reasoningRes = responseRecorder();
  await [...reasoningHandlers.values()].find((handler, index) => index === 2)!({ params: { 0: "room_1", 1: "reasoning_1" }, body: {}, authKind: "agent_session", agentSession: principal }, reasoningRes);
  assert.equal(reasoningRes.statusCode, 403);

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
    requireWorkerRequestAgentIdentity, getRoomSharedArtifacts: async () => [], getRoomSharedArtifactByIdentityKey: async () => null,
    upsertRoomSharedArtifact: async () => ({ identity_key: "artifact" }), linkRoomSharedArtifactToTask: async () => {},
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

test("bearer cannot hand off or release another worker's lease", { skip: requiresDatabase }, async () => {
  const { room, session } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const task = await createTask!(room.id, "leased", "Other");
  await createTaskLease!({ room_id: room.id, task_id: task.id, kind: "work", agent_key: "owner/other", agent_session_id: "agent_session_other", actor_label: "Other", created_by: "Other" });
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
