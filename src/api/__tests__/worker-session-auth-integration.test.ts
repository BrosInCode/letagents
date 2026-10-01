import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schemaModule = testDatabaseUrl ? await import("../db/schema.js") : null;
const { registerRoomMessageRoutes } = await import("../routes/rooms/messages/index.js");
const { createRoomEventBroker } = await import("../server/room-event-broker.js");
const { registerRoomPresenceRoutes } = await import("../routes/rooms/presence/index.js");
const { registerRoomReasoningRoutes } = await import("../routes/rooms/reasoning.js");
const { registerRoomTaskRoutes } = await import("../routes/rooms/tasks/index.js");
const { createTaskCoordinationEnforcement } = await import("../tasks/coordination-enforcement.js");
const { buildAgentActorLabel } = await import("../../shared/agent-identity.js");
const { pickLocalCodename } = await import("../../shared/codenames.js");
const { hashToken } = await import("../db/utils.js");
const {
  AGENT_SESSION_ENDED_ADVICE,
  AGENT_SESSION_ENDED_ERROR,
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} = await import("../../shared/request-headers.js");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const accounts = schemaModule?.accounts;
const agents = schemaModule?.agents;
const addMessage = dbModule?.addMessage;
const createProjectWithName = dbModule?.createProjectWithName;
const createFencedRoomAgentSession = dbModule?.createFencedRoomAgentSession;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const createTask = dbModule?.createTask;
const createTaskLease = dbModule?.createTaskLease;
const endRoomAgentSession = dbModule?.endRoomAgentSession;
const getRoomAgentDeliverySessions = dbModule?.getRoomAgentDeliverySessions;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryHeartbeat = dbModule?.markRoomAgentDeliveryHeartbeat;
const pauseDesktopRoomAgentDelivery = dbModule?.pauseDesktopRoomAgentDelivery;
const upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat = dbModule?.upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat;
const updateTask = dbModule?.updateTask;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const ownerAccount = {
  id: "acct_worker_session_test",
  provider: "github",
  provider_user_id: "worker-session-test",
  login: "emmymay",
  display_name: "EmmyMay",
  avatar_url: null,
};
const agentIdentity = {
  id: "agent_worker_session_test",
  canonical_key: "EmmyMay/owlsolar",
  name: "owlsolar",
  display_name: "OwlSolar",
  owner_account_id: ownerAccount.id,
  owner_login: ownerAccount.login,
  owner_label: "EmmyMay",
};

type CreatedSession = {
  session_id: string;
  session_token: string;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
};

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createResponseRecorder>
) => Promise<void>;

type RouteHandlers = ReturnType<typeof createRouteApp>["handlers"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("database did not become ready in time");
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await pool?.end();
  });
}

function createRouteApp() {
  const handlers = {
    delete: new Map<string, Handler>(),
    get: new Map<string, Handler>(),
    patch: new Map<string, Handler>(),
    post: new Map<string, Handler>(),
    put: new Map<string, Handler>(),
  };

  const app = {
    delete(path: RegExp, handler: Handler) {
      handlers.delete.set(path.toString(), handler);
    },
    get(path: RegExp, handler: Handler) {
      handlers.get.set(path.toString(), handler);
    },
    patch(path: RegExp, handler: Handler) {
      handlers.patch.set(path.toString(), handler);
    },
    post(path: RegExp, handler: Handler) {
      handlers.post.set(path.toString(), handler);
    },
    put(path: RegExp, handler: Handler) {
      handlers.put.set(path.toString(), handler);
    },
  };

  return { app, handlers };
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.body = { location };
      return this;
    },
    setHeader() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      return undefined;
    },
  };
}

function createPendingResponseRecorder() {
  let resolveSettled!: (response: ReturnType<typeof createResponseRecorder>) => void;
  const settled = new Promise<ReturnType<typeof createResponseRecorder>>((resolve) => {
    resolveSettled = resolve;
  });
  const response = createResponseRecorder();
  response.json = function json(payload: unknown) {
    this.body = payload;
    resolveSettled(this);
    return this;
  };
  return { response, settled };
}

function ownerTokenRequest(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    body,
    authKind: "owner_token",
    sessionAccount: {
      account_id: ownerAccount.id,
      login: ownerAccount.login,
      display_name: ownerAccount.display_name,
    },
    ...extra,
  };
}

function sessionCredentials(session: CreatedSession): Record<string, string> {
  return {
    agent_session_id: session.session_id,
    agent_session_token: session.session_token,
  };
}

test("durable MCP workers keep identity and name through retries, crashes, and clean reconnects", {
  skip: requiresDatabase,
}, async () => {
  const { room } = await seedHarness();
  const handlers = registerRoutesForRoom(room);
  const register = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
  const disconnect = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/disconnect$/");
  const body = {
    actor_key: agentIdentity.canonical_key, display_name: "Atlas", requested_base_display_name: "Atlas",
    agent_instance_id: `worker_${"a".repeat(32)}`, session_kind: "worker", ide_label: "Agent",
    runtime: "codex", connection_token: "a".repeat(43),
  };
  const joinWorker = (value: Record<string, unknown>) => invoke(register, ownerTokenRequest(value, { params: { 0: room.id } }));
  const first = await joinWorker(body);
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  let current = first.body as CreatedSession;
  const task = await createTask!(room.id, "Durable chat owns its work across reconnects", "Human");
  await updateTask!(room.id, task.id, { status: "accepted" });
  const assigned = await invoke(handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
    ownerTokenRequest({ status: "assigned", assignee: current.actor_label, ...sessionCredentials(current) },
      { params: { 0: room.id, 1: task.id }, query: {} }));
  assert.equal(assigned.statusCode, 200, JSON.stringify(assigned.body));
  await createTaskLease!({ room_id: room.id, task_id: task.id, kind: "work", agent_key: current.agent_key,
    agent_session_id: current.session_id, actor_label: current.actor_label, created_by: "durable_worker_test" });
  const retry = await joinWorker(body);
  assert.equal(retry.statusCode, 201, JSON.stringify(retry.body));
  assert.equal((retry.body as CreatedSession).session_id, current.session_id);
  assert.equal((retry.body as CreatedSession).session_token, current.session_token);

  // A stale heartbeat is never sufficient proof to take over a durable worker.
  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = NOW() - INTERVAL '1 day' WHERE session_id = $1", [current.session_id]);
  assert.equal((await joinWorker({ ...body, connection_token: "b".repeat(43) })).statusCode, 409);
  for (let i = 0; i < 4; i++) {
    const old = current;
    if (i % 2 === 0) {
      const ended = await invoke(disconnect, ownerTokenRequest(sessionCredentials(old), { params: { 0: room.id, 1: old.session_id } }));
      assert.equal(ended.statusCode, 200, JSON.stringify(ended.body));
    }
    const resumed = await joinWorker({ ...body, display_name: "Ignored rename", connection_token: String(i).repeat(43),
      replace_agent_session_id: old.session_id, replace_agent_session_token: old.session_token });
    assert.equal(resumed.statusCode, 201, JSON.stringify(resumed.body));
    current = resumed.body as CreatedSession;
    assert.equal(current.session_id, old.session_id);
    assert.equal(current.agent_key, old.agent_key);
    assert.equal(current.display_name, "Atlas");
    assert.equal(current.actor_label, old.actor_label);
    assert.notEqual(current.session_token, old.session_token);
    // A delayed disconnect authenticated before rotation must not end its successor.
    assert.equal(await endRoomAgentSession!({ session_id: old.session_id, room_id: room.id,
      credential_fence: { kind: "session_token", token_hash: hashToken(old.session_token) } }), null);
    const staleDisconnect = await invoke(disconnect, ownerTokenRequest(sessionCredentials(old), { params: { 0: room.id, 1: old.session_id } }));
    assert.ok([401, 403].includes(staleDisconnect.statusCode), JSON.stringify(staleDisconnect.body));
  }
  const rows = await pool!.query("SELECT * FROM room_agent_sessions WHERE agent_instance_id = $1", [body.agent_instance_id]);
  assert.equal(rows.rowCount, 1, "reconnects do not add historical worker rows");
  assert.equal(rows.rows[0].ended_at, null);
  const continued = await invoke(handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
    ownerTokenRequest({ status: "in_progress", ...sessionCredentials(current) },
      { params: { 0: room.id, 1: task.id }, query: {} }));
  assert.equal(continued.statusCode, 200, JSON.stringify(continued.body));
  const leases = await pool!.query("SELECT agent_session_id FROM task_leases WHERE task_id = $1 AND status = 'active'", [task.id]);
  assert.deepEqual(leases.rows, [{ agent_session_id: current.session_id }]);
});

test("separate durable chats reserve different names even when one is offline", { skip: requiresDatabase }, async () => {
  const { room } = await seedHarness();
  const handlers = registerRoutesForRoom(room);
  const register = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
  const joinWorker = (value: Record<string, unknown>) => invoke(register, ownerTokenRequest(value, { params: { 0: room.id } }));
  const now = new Date().toISOString();
  const secondKey = "EmmyMay/second-chat";
  await db!.insert(agents!).values({ ...agentIdentity, id: "agent_second_chat", canonical_key: secondKey,
    name: "second-chat", created_at: now, updated_at: now });
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas", session_kind: "worker", runtime: "codex", ide_label: "Agent" };
  const first = await joinWorker({ ...common, actor_key: agentIdentity.canonical_key,
    agent_instance_id: `worker_${"a".repeat(32)}`, connection_token: "a".repeat(43) });
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  const one = first.body as CreatedSession;
  await endRoomAgentSession!({ room_id: room.id, session_id: one.session_id });
  const second = await joinWorker({ ...common, actor_key: secondKey,
    agent_instance_id: `worker_${"b".repeat(32)}`, connection_token: "b".repeat(43) });
  assert.equal(second.statusCode, 201, JSON.stringify(second.body));
  const two = second.body as CreatedSession;
  assert.notEqual(two.agent_key, one.agent_key);
  assert.notEqual(two.display_name, one.display_name);
  assert.notEqual(two.session_id, one.session_id);
  const resumed = await joinWorker({ ...common, actor_key: one.agent_key, agent_instance_id: one.agent_instance_id,
    connection_token: "c".repeat(43), replace_agent_session_id: one.session_id, replace_agent_session_token: one.session_token });
  assert.equal(resumed.statusCode, 201, JSON.stringify(resumed.body));
  assert.equal((resumed.body as CreatedSession).display_name, one.display_name);
});

test("concurrent durable registration retries converge on one connection", { skip: requiresDatabase }, async () => {
  const { room } = await seedHarness();
  const handlers = registerRoutesForRoom(room);
  const register = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
  const body = { actor_key: agentIdentity.canonical_key, display_name: "Juniper", session_kind: "worker",
    agent_instance_id: `worker_${"c".repeat(32)}`, connection_token: "c".repeat(43) };
  const replies = await Promise.all(Array.from({ length: 4 }, () => invoke(register, ownerTokenRequest(body, { params: { 0: room.id } }))));
  for (const result of replies) assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  assert.equal(new Set(replies.map((result) => (result.body as CreatedSession).session_id)).size, 1);
  assert.equal(new Set(replies.map((result) => (result.body as CreatedSession).display_name)).size, 1);
});

function requestWithDeliveryHeaders(session: CreatedSession, extra: Record<string, unknown> = {}) {
  const headers = new Map<string, string>([
    [LETAGENTS_AGENT_SESSION_ID_HEADER.toLowerCase(), session.session_id],
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER.toLowerCase(), session.session_token],
  ]);

  return {
    query: {},
    authKind: "owner_token",
    sessionAccount: {
      account_id: ownerAccount.id,
      login: ownerAccount.login,
      display_name: ownerAccount.display_name,
    },
    get(name: string) {
      return headers.get(name.toLowerCase()) ?? "";
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
    ...extra,
  };
}

async function seedHarness() {
  if (
    !db ||
    !accounts ||
    !agents ||
    !createProjectWithName ||
    !createRoomAgentSession
  ) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }

  const now = new Date().toISOString();
  await db.insert(accounts).values({
    ...ownerAccount,
    created_at: now,
    updated_at: now,
  });
  await db.insert(agents).values({
    ...agentIdentity,
    created_at: now,
    updated_at: now,
  });

  const room = await createProjectWithName("github.com/brosincode/letagents");
  const baseSessionInput = {
    room_id: room.id,
    runtime: "codex",
    agent_key: agentIdentity.canonical_key,
    agent_instance_id: "worker-session-test-instance",
    owner_account_id: ownerAccount.id,
    owner_label: agentIdentity.owner_label,
    ide_label: "Codex",
  };

  const ended = await createRoomAgentSession({
    ...baseSessionInput,
    session_kind: "worker",
    display_name: "EndedOwl",
    actor_label: buildAgentActorLabel({
      display_name: "EndedOwl",
      owner_label: agentIdentity.owner_label,
      ide_label: "Codex",
    }),
  });
  if (!endRoomAgentSession) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }
  await endRoomAgentSession({
    session_id: ended.session_id,
    room_id: room.id,
    owner_account_id: ownerAccount.id,
  });

  const worker = await createRoomAgentSession({
    ...baseSessionInput,
    session_kind: "worker",
    display_name: "OwlSolar",
    actor_label: buildAgentActorLabel({
      display_name: "OwlSolar",
      owner_label: agentIdentity.owner_label,
      ide_label: "Codex",
    }),
  });
  const controller = await createRoomAgentSession({
    ...baseSessionInput,
    session_kind: "controller",
    display_name: "ControllerOwl",
    actor_label: buildAgentActorLabel({
      display_name: "ControllerOwl",
      owner_label: agentIdentity.owner_label,
      ide_label: "Codex",
    }),
  });

  return { room, worker, controller, ended };
}

function registerRoutesForRoom(room: { id: string }, options: { realCoordination?: boolean } = {}): RouteHandlers {
  if (!addMessage) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }

  const { app, handlers } = createRouteApp();
  const resolveCanonicalRoomRequestId = async () => room.id;
  const resolveRoomOrReply = async () => room;
  const requireParticipant = async () => true;
  const messageEvents = new EventEmitter();
  const taskEvents = new EventEmitter();
  const reasoningEvents = new EventEmitter();
  const roomEventBroker = createRoomEventBroker({
    messageEvents,
    taskEvents,
    reasoningEvents,
    githubRoomEvents: new EventEmitter(),
    artifactEvents: new EventEmitter(),
    rentalActivityEvents: new EventEmitter(),
    messageInfoEvents: new EventEmitter(),
  });

  registerRoomMessageRoutes(app as never, {
    roomEventBroker,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    reauthorizeGitRoomParticipant: async () => true,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: (value) => typeof value === "string" ? value.trim() || null : null,
    parseOptionalThreadRootMessageId: (value) => typeof value === "string" ? value.trim() || null : null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: async (projectId, sender, text, options) => addMessage(projectId, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind,
      reply_to_message_id: options?.reply_to,
      attachments: options?.attachments,
    }),
    rememberRoomParticipantFromMessage: async () => undefined,
    rememberAccountRoom: async () => undefined,
  } as never);

  registerRoomPresenceRoutes(app as never, {
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin: async () => true,
    requireParticipant,
    rememberAgentRoomParticipant: async () => undefined,
    maybeEmitStaleWorkPrompt: async () => null,
  } as never);

  registerRoomReasoningRoutes(app as never, {
    reasoningEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
  } as never);

  registerRoomTaskRoutes(app as never, {
    taskEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireAdmin: async () => true,
    requireParticipant,
    resolveProjectRole: async () => "participant",
    toRoomResponse: (project) => project as unknown as Record<string, unknown>,
    normalizeOptionalString: (value) => typeof value === "string" ? value.trim() || null : null,
    enforceTaskAdmissionCoordination: async () => ({ kind: "allow" }),
    isTrustedAgentCreator: async () => false,
    emitTaskLifecycleStatusMessage: async () => undefined,
    validateOwnerTokenTaskActorKey: async ({ actorKey }) => ({ actorKey, error: null }),
    getTaskById: dbModule!.getTaskById,
    getTaskOwnershipState: dbModule!.getTaskOwnershipState,
    updateTask: dbModule!.updateTask,
    enforceTaskCoordinationMutation: options.realCoordination
      // The check the server makes, against the leases the store holds.
      ? createTaskCoordinationEnforcement({
          getAgentIdentityByCanonicalKey: dbModule!.getAgentIdentityByCanonicalKey,
          createCoordinationEvent: dbModule!.createCoordinationEvent,
          getActiveTaskLocks: dbModule!.getActiveTaskLocks,
          getTasks: dbModule!.getTasks,
          getFocusRoomsForParent: async () => [],
          getActiveTaskLeases: dbModule!.getActiveTaskLeases,
          updateTaskLeaseWorkflowRefs: dbModule!.updateTaskLeaseWorkflowRefs,
          shouldRequireBoardIntent: async () => false,
          verifyBoardIntentApproval: dbModule!.verifyBoardIntentApproval,
          getActiveBoardManager: dbModule!.getActiveBoardManager,
        } as never).enforceTaskCoordinationMutation
      : async () => ({ kind: "allow" }),
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" }),
    emitProjectMessage: async (projectId, sender, text) => addMessage(projectId, sender, text),
  } as never);

  return handlers;
}

async function invoke(
  handler: Handler | undefined,
  req: Record<string, unknown>
): Promise<ReturnType<typeof createResponseRecorder>> {
  assert.ok(handler, "expected route handler to be registered");
  const res = createResponseRecorder();
  await handler(req, res);
  return res;
}

test(
  "delivery connected writes reject a worker session that already ended",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, ended } = await seedHarness();
    if (!markRoomAgentDeliveryConnected) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    await assert.rejects(
      markRoomAgentDeliveryConnected({
        room_id: room.id,
        actor_label: ended.actor_label,
        agent_key: ended.agent_key,
        agent_instance_id: ended.agent_instance_id,
        agent_session_id: ended.session_id,
        session_kind: "worker",
        runtime: "codex",
        display_name: ended.display_name,
        owner_label: "EmmyMay",
        ide_label: "Codex",
        credential_fence: { kind: "session_token", token_hash: hashToken(ended.session_token) },
        transport: "sse",
      }),
      { name: "InactiveRoomAgentDeliverySessionError" },
    );
  },
);

test(
  "rotating a stable worker session id fences the predecessor credential at delivery commit",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    if (!createFencedRoomAgentSession || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryHeartbeat || !getRoomAgentDeliverySessions) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const deliveryInput = {
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker" as const,
      runtime: worker.runtime,
      display_name: worker.display_name,
      owner_label: worker.owner_label,
      ide_label: worker.ide_label,
      transport: "sse" as const,
    };
    await markRoomAgentDeliveryConnected({
      ...deliveryInput,
      delivery_instance_id: "predecessor-instance",
      credential_fence: { kind: "session_token", token_hash: hashToken(worker.session_token) },
    });
    const [rotation, staleReopen] = await Promise.allSettled([
      createFencedRoomAgentSession({
        room_id: room.id,
        session_kind: "worker",
        runtime: worker.runtime,
        actor_label: worker.actor_label,
        agent_key: worker.agent_key,
        agent_instance_id: worker.agent_instance_id,
        display_name: worker.display_name,
        owner_account_id: ownerAccount.id,
        owner_label: worker.owner_label,
        ide_label: worker.ide_label,
      }, {
        session_id: worker.session_id,
        session_token: worker.session_token,
      }),
      markRoomAgentDeliveryConnected({
        ...deliveryInput,
        credential_fence: { kind: "session_token", token_hash: hashToken(worker.session_token) },
      }),
    ]);
    assert.equal(rotation.status, "fulfilled");
    if (rotation.status !== "fulfilled") throw rotation.reason;
    const rotated = rotation.value;
    assert.equal(rotated.session.session_id, worker.session_id);
    assert.ok(
      staleReopen.status === "fulfilled"
      || (staleReopen.reason as { name?: string })?.name === "InactiveRoomAgentDeliverySessionError",
    );
    const afterRotation = await getRoomAgentDeliverySessions(room.id);
    assert.equal(
      afterRotation.find((delivery) => delivery.agent_session_id === worker.session_id)?.active_connection_count,
      0,
      "rotation retires a stale connection even when its reconnect raced on another DB connection",
    );
    const retiredInstances = await pool!.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM room_agent_delivery_instances
      WHERE room_id = $1 AND delivery_key = $2
    `, [room.id, `agent_session:${worker.session_id}`]);
    assert.equal(retiredInstances.rows[0]?.count, 0, "rotation retires predecessor instance tokens atomically");

    await assert.rejects(markRoomAgentDeliveryConnected({
      ...deliveryInput,
      credential_fence: { kind: "session_token", token_hash: hashToken(worker.session_token) },
    }), { name: "InactiveRoomAgentDeliverySessionError" });
    await markRoomAgentDeliveryConnected({
      ...deliveryInput,
      delivery_instance_id: "successor-instance",
      credential_fence: {
        kind: "session_token",
        token_hash: hashToken(rotated.session.session_token),
      },
    });
    assert.equal(await markRoomAgentDeliveryHeartbeat({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_session_id: worker.session_id,
      delivery_instance_id: "successor-instance",
      credential_fence: {
        kind: "session_token",
        token_hash: hashToken(rotated.session.session_token),
      },
    }), true);
    const successorDelivery = await getRoomAgentDeliverySessions(room.id);
    assert.equal(
      successorDelivery.find((delivery) => delivery.agent_session_id === worker.session_id)?.active_connection_count,
      1,
    );
  },
);

test(
  "an inactive credential heartbeat immediately retires only its durable delivery projection",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    if (!markRoomAgentDeliveryConnected || !markRoomAgentDeliveryHeartbeat || !pool) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const credentialFence = {
      kind: "session_token" as const,
      token_hash: hashToken(worker.session_token),
    };
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker",
      runtime: worker.runtime,
      display_name: worker.display_name,
      owner_label: worker.owner_label,
      ide_label: worker.ide_label,
      credential_fence: credentialFence,
      transport: "sse",
    });

    // Model natural expiry/revocation without running the normal retirement
    // helper: the next exact-fingerprint heartbeat is the durable backstop.
    await pool.query(
      "UPDATE room_agent_sessions SET ended_at = NOW() WHERE room_id = $1 AND session_id = $2",
      [room.id, worker.session_id],
    );
    assert.equal(await markRoomAgentDeliveryHeartbeat({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_session_id: worker.session_id,
      credential_fence: credentialFence,
    }), false);

    const projection = await pool.query<{ active_connection_count: number }>(`
      SELECT active_connection_count
      FROM room_agent_delivery_sessions
      WHERE room_id = $1 AND agent_session_id = $2
    `, [room.id, worker.session_id]);
    assert.equal(projection.rows[0]?.active_connection_count, 0);
  },
);

test(
  "new instance accounting survives a summary-only retirement from an older API binary",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    if (!markRoomAgentDeliveryConnected || !markRoomAgentDeliveryHeartbeat || !getRoomAgentDeliverySessions || !pool) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const deliveryInput = {
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker" as const,
      runtime: worker.runtime,
      display_name: worker.display_name,
      owner_label: worker.owner_label,
      ide_label: worker.ide_label,
      transport: "sse" as const,
      credential_fence: { kind: "session_token" as const, token_hash: hashToken(worker.session_token) },
    };
    await markRoomAgentDeliveryConnected({
      ...deliveryInput,
      delivery_instance_id: "mixed-version-predecessor",
    });

    // This is the exact pre-0080 retirement shape: the old binary resets the
    // aggregate projection but cannot know about the new instance table.
    await pool.query(`
      UPDATE room_agent_delivery_sessions
      SET active_connection_count = 0,
          last_disconnected_at = NOW(),
          reconnect_grace_expires_at = NOW(),
          updated_at = NOW()
      WHERE room_id = $1 AND delivery_key = $2
    `, [room.id, `agent_session:${worker.session_id}`]);

    await markRoomAgentDeliveryConnected({
      ...deliveryInput,
      delivery_instance_id: "mixed-version-successor",
    });
    await pool.query(`
      UPDATE room_agent_delivery_instances
      SET updated_at = NOW() - INTERVAL '2 minutes'
      WHERE room_id = $1
        AND delivery_key = $2
        AND instance_id = 'mixed-version-predecessor'
    `, [room.id, `agent_session:${worker.session_id}`]);

    assert.equal(await markRoomAgentDeliveryHeartbeat({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_session_id: worker.session_id,
      delivery_instance_id: "mixed-version-successor",
      credential_fence: deliveryInput.credential_fence,
    }), true);
    const deliveries = await getRoomAgentDeliverySessions(room.id);
    assert.equal(
      deliveries.find((delivery) => delivery.agent_session_id === worker.session_id)?.active_connection_count,
      1,
      "removing the unknown predecessor cannot subtract the live successor below its instance floor",
    );
  },
);

test(
  "desktop presence heartbeat and credential rotation converge atomically",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    if (!createFencedRoomAgentSession || !upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat || !pool) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const oldFence = { kind: "session_token" as const, token_hash: hashToken(worker.session_token) };
    const heartbeatInput = {
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker" as const,
      runtime: worker.runtime,
      display_name: worker.display_name,
      owner_label: worker.owner_label,
      ide_label: worker.ide_label,
      credential_fence: oldFence,
      presence: {
        status: "working" as const,
        status_text: "old credential heartbeat",
      },
    };
    await upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat(heartbeatInput);

    // FOR SHARE credential validation is retained through both delivery and
    // presence writes. Rotation either wins first (old heartbeat rejects) or
    // waits, then retires both projections after the heartbeat commits.
    const [rotation, staleHeartbeat] = await Promise.allSettled([
      createFencedRoomAgentSession({
        room_id: room.id,
        session_kind: "worker",
        runtime: worker.runtime,
        actor_label: worker.actor_label,
        agent_key: worker.agent_key,
        agent_instance_id: worker.agent_instance_id,
        display_name: worker.display_name,
        owner_account_id: ownerAccount.id,
        owner_label: worker.owner_label,
        ide_label: worker.ide_label,
      }, {
        session_id: worker.session_id,
        session_token: worker.session_token,
      }),
      upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat(heartbeatInput),
    ]);
    assert.equal(rotation.status, "fulfilled");
    assert.ok(
      staleHeartbeat.status === "fulfilled"
      || (staleHeartbeat.reason as { name?: string })?.name === "InactiveRoomAgentDeliverySessionError",
    );
    const projections = await pool.query<{
      active_connection_count: number;
      presence_count: number;
    }>(`
      SELECT
        COALESCE(MAX(d.active_connection_count), 0)::int AS active_connection_count,
        (SELECT COUNT(*)::int FROM room_agent_presence p
          WHERE p.room_id = $1 AND p.agent_session_id = $2) AS presence_count
      FROM room_agent_delivery_sessions d
      WHERE d.room_id = $1 AND d.agent_session_id = $2
    `, [room.id, worker.session_id]);
    assert.deepEqual(projections.rows[0], {
      active_connection_count: 0,
      presence_count: 0,
    });
  },
);

test(
  "desktop delivery signal sequence rejects a pause that commits after a newer resume",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    if (!pauseDesktopRoomAgentDelivery || !upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat || !pool) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const credentialFence = {
      kind: "session_token" as const,
      token_hash: hashToken(worker.session_token),
    };
    const delivery = {
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker" as const,
      runtime: worker.runtime,
      display_name: worker.display_name,
      owner_label: worker.owner_label,
      ide_label: worker.ide_label,
      credential_fence: credentialFence,
    };
    await pauseDesktopRoomAgentDelivery({
      ...delivery,
      desktop_signal_sequence: 1,
      presence: {
        ...delivery,
        status: "idle",
        status_text: "room closed",
      },
    });
    await upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat({
      ...delivery,
      desktop_signal_sequence: 2,
      presence: {
        status: "idle",
        status_text: "resumed",
      },
    });
    await assert.rejects(
      pauseDesktopRoomAgentDelivery({
        ...delivery,
        desktop_signal_sequence: 1,
        presence: {
          ...delivery,
          status: "idle",
          status_text: "late stale pause",
        },
      }),
      (error: unknown) => (
        error instanceof Error
        && error.name === "StaleDesktopRoomAgentDeliverySignalError"
        && (error as Error & { currentSequence?: number }).currentSequence === 2
      ),
    );
    const current = await pool.query<{
      active_connection_count: number;
      desktop_signal_sequence: number;
      status_text: string | null;
    }>(`
      SELECT d.active_connection_count, d.desktop_signal_sequence, p.status_text
      FROM room_agent_delivery_sessions d
      LEFT JOIN room_agent_presence p
        ON p.room_id = d.room_id AND p.agent_session_id = d.agent_session_id
      WHERE d.room_id = $1 AND d.agent_session_id = $2
    `, [room.id, worker.session_id]);
    assert.deepEqual(current.rows[0], {
      active_connection_count: 1,
      desktop_signal_sequence: 2,
      status_text: "resumed",
    });
  },
);

test(
  "agent session registration creates independent workers for reused MCP identity",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, worker } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");

    if (!markRoomAgentDeliveryConnected || !getRoomAgentDeliverySessions) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_key: worker.agent_key,
      agent_instance_id: worker.agent_instance_id,
      agent_session_id: worker.session_id,
      session_kind: "worker",
      runtime: "codex",
      display_name: worker.display_name,
      owner_label: "EmmyMay",
      ide_label: "Codex",
      credential_fence: { kind: "session_token", token_hash: hashToken(worker.session_token) },
      transport: "long_poll",
    });
    const registrationBody = {
      actor_key: worker.agent_key,
      actor_label: worker.actor_label,
      display_name: worker.display_name,
      ide_label: "Antigravity",
      session_kind: "worker",
      runtime: "antigravity",
      repo_branch: "codex/git-rooms",
    };
    const [secondRegistration, thirdRegistration] = await Promise.all([
      invoke(
        registerHandler,
        ownerTokenRequest({
          ...registrationBody,
          agent_instance_id: "different-antigravity-instance-2",
        }, { params: { 0: room.id } })
      ),
      invoke(
        registerHandler,
        ownerTokenRequest({
          ...registrationBody,
          agent_instance_id: "different-antigravity-instance-3",
        }, { params: { 0: room.id } })
      ),
    ]);

    assert.equal(secondRegistration.statusCode, 201, JSON.stringify(secondRegistration.body));
    const secondSession = secondRegistration.body as {
      session_id?: string;
      session_token?: string;
      display_name?: string;
      repo_branch?: string | null;
    };
    assert.ok(secondSession.session_id);
    assert.notEqual(secondSession.session_id, worker.session_id);
    assert.equal(secondSession.repo_branch, "codex/git-rooms");

    assert.equal(thirdRegistration.statusCode, 201, JSON.stringify(thirdRegistration.body));
    const thirdSession = thirdRegistration.body as {
      session_id?: string;
      session_token?: string;
      display_name?: string;
      repo_branch?: string | null;
    };
    assert.ok(thirdSession.session_id);
    assert.notEqual(thirdSession.session_id, worker.session_id);
    assert.notEqual(thirdSession.session_id, secondSession.session_id);
    assert.equal(thirdSession.repo_branch, "codex/git-rooms");
    // Concurrent same-name registrations each receive their own codename;
    // a held name is never decorated with a number.
    assert.deepEqual(
      [secondSession.display_name, thirdSession.display_name].sort(),
      [
        pickLocalCodename(`${worker.agent_key}:1`).display_name,
        pickLocalCodename(`${worker.agent_key}:2`).display_name,
      ].sort()
    );
    for (const displayName of [secondSession.display_name, thirdSession.display_name]) {
      assert.match(displayName ?? "", /^[A-Za-z]+$/, "a collision name is one mentionable word");
      assert.notEqual(displayName, worker.display_name);
    }

    const oldDeliverySession = (await getRoomAgentDeliverySessions(room.id))
      .find((session) => session.agent_session_id === worker.session_id);
    assert.equal(oldDeliverySession?.active_connection_count, 1);
    assert.equal(oldDeliverySession?.reconnect_grace_expires_at, null);

    const oldSessionMessage = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest(
        {
          text: "original worker session can still write",
          ...sessionCredentials(worker),
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(oldSessionMessage.statusCode, 201);

    const thirdMessage = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest(
        {
          text: "new worker session can write independently",
          agent_session_id: thirdSession.session_id,
          agent_session_token: thirdSession.session_token,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(thirdMessage.statusCode, 201);

    const thirdPresence = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/presence$/"),
      ownerTokenRequest(
        {
          status: "working",
          status_text: "branch-aware worker session is active",
          agent_session_id: thirdSession.session_id,
          agent_session_token: thirdSession.session_token,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(thirdPresence.statusCode, 200);
    assert.equal((thirdPresence.body as { repo_branch?: string | null }).repo_branch, "codex/git-rooms");
  }
);

test(
  "registered worker sessions can write messages, presence, reasoning, and task updates",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!createTask || !updateTask) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }

    const { room, worker } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const credentials = sessionCredentials(worker);

    const messageRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest(
        {
          text: "worker session message",
          sender: "SpoofedSender",
          ...credentials,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(messageRes.statusCode, 201);
    assert.equal((messageRes.body as { sender?: string }).sender, worker.actor_label);

    const presenceRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/presence$/"),
      ownerTokenRequest(
        {
          status: "working",
          status_text: "valid worker session is active",
          ...credentials,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(presenceRes.statusCode, 200);
    assert.equal((presenceRes.body as { actor_label?: string }).actor_label, worker.actor_label);
    assert.equal((presenceRes.body as { agent_session_id?: string }).agent_session_id, worker.session_id);

    const reasoningRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/reasoning-sessions$/"),
      ownerTokenRequest(
        {
          summary: "valid worker session reasoning",
          status: "working",
          ...credentials,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(reasoningRes.statusCode, 201);
    assert.equal(
      (reasoningRes.body as { session?: { actor_label?: string } }).session?.actor_label,
      worker.actor_label
    );

    const taskCreateRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/tasks$/"),
      ownerTokenRequest(
        {
          title: "Worker session task",
          ...credentials,
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(taskCreateRes.statusCode, 201);
    assert.equal((taskCreateRes.body as { created_by?: string }).created_by, worker.actor_label);

    const proposedClaimTarget = await createTask(room.id, "Worker session claim", "Human");
    const claimTarget = await updateTask(room.id, proposedClaimTarget.id, { status: "accepted" });
    assert.ok(claimTarget);
    const taskPatchRes = await invoke(
      handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
      ownerTokenRequest(
        {
          status: "assigned",
          assignee: worker.actor_label,
          ...credentials,
        },
        { params: { 0: room.id, 1: claimTarget.id }, query: {} }
      )
    );
    assert.equal(taskPatchRes.statusCode, 200, JSON.stringify(taskPatchRes.body));
    assert.equal((taskPatchRes.body as { status?: string }).status, "assigned");
    assert.equal((taskPatchRes.body as { assignee?: string }).assignee, worker.actor_label);
    assert.equal((taskPatchRes.body as { assignee_agent_key?: string }).assignee_agent_key, worker.agent_key);
  }
);

test(
  "controller sessions are rejected for owner-token write routes",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!createTask || !updateTask) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }

    const { room, controller } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const credentials = sessionCredentials(controller);
    const expected = { error: "Worker session is required for agent write actions." };

    const messageRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest({ text: "controller should fail", ...credentials }, { params: { 0: room.id } })
    );
    assert.equal(messageRes.statusCode, 403);
    assert.deepEqual(messageRes.body, expected);

    const presenceRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/presence$/"),
      ownerTokenRequest({ status: "working", ...credentials }, { params: { 0: room.id } })
    );
    assert.equal(presenceRes.statusCode, 403);
    assert.deepEqual(presenceRes.body, expected);

    const reasoningRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/reasoning-sessions$/"),
      ownerTokenRequest({ summary: "controller should fail", ...credentials }, { params: { 0: room.id } })
    );
    assert.equal(reasoningRes.statusCode, 403);
    assert.deepEqual(reasoningRes.body, expected);

    const taskCreateRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/tasks$/"),
      ownerTokenRequest({ title: "Controller task", ...credentials }, { params: { 0: room.id } })
    );
    assert.equal(taskCreateRes.statusCode, 403);
    assert.deepEqual(taskCreateRes.body, expected);

    const proposedTask = await createTask(room.id, "Controller patch target", "Human");
    const task = await updateTask(room.id, proposedTask.id, { status: "accepted" });
    assert.ok(task);
    const taskPatchRes = await invoke(
      handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
      ownerTokenRequest(
        {
          status: "assigned",
          assignee: controller.actor_label,
          ...credentials,
        },
        { params: { 0: room.id, 1: task.id }, query: {} }
      )
    );
    assert.equal(taskPatchRes.statusCode, 403);
    assert.deepEqual(taskPatchRes.body, expected);
  }
);

test(
  "ended worker sessions cannot write or keep a delivery poll alive",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room, ended } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const credentials = sessionCredentials(ended);
    // Its own agent is told that it ended and what to do; the words are for
    // the agent, which reads them even on a client that does not.
    const expected = { error: AGENT_SESSION_ENDED_ADVICE };
    assert.ok(AGENT_SESSION_ENDED_ADVICE.startsWith(AGENT_SESSION_ENDED_ERROR));
    assert.match(AGENT_SESSION_ENDED_ADVICE, /register_agent_session/);

    const messageRes = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest({ text: "ended should fail", ...credentials }, { params: { 0: room.id } })
    );
    assert.equal(messageRes.statusCode, 401);
    assert.deepEqual(messageRes.body, expected);

    const pollRes = await invoke(
      handlers.get.get("/^\\/rooms\\/(.+)\\/messages\\/poll$/"),
      requestWithDeliveryHeaders(ended, {
        params: { 0: room.id },
        query: { timeout: "1000" },
      })
    );
    assert.equal(pollRes.statusCode, 401);
    assert.deepEqual(pollRes.body, expected);
  }
);

test(
  "a reconnecting agent keeps its name against room history and a newer namesake",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!db || !agents || !createRoomAgentSession || !dbModule) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { room, worker } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    const now = new Date().toISOString();
    // A person once seen in the room under another spelling of the name.
    // People are not woken by mentions, so history cannot make one ambiguous.
    await dbModule.upsertRoomParticipant({
      room_id: room.id, participant_key: "human:owl-solar", kind: "human",
      github_login: "owl-solar", display_name: "Owl Solar",
    });
    // A newer agent of another identity that already shares the name.
    const twin = {
      ...agentIdentity,
      id: "agent_worker_session_namesake",
      canonical_key: "EmmyMay/desktop-claude-namesake",
      name: "desktop-claude-namesake",
    };
    await db.insert(agents).values({ ...twin, created_at: now, updated_at: now });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createRoomAgentSession({
      room_id: room.id, runtime: "claude-code", session_kind: "worker",
      agent_key: twin.canonical_key, agent_instance_id: "namesake-instance",
      owner_account_id: ownerAccount.id, owner_label: twin.owner_label, ide_label: "Claude Code",
      display_name: "OwlSolar",
      actor_label: buildAgentActorLabel({ display_name: "OwlSolar", owner_label: twin.owner_label, ide_label: "Claude Code" }),
    });

    const reconnect = await invoke(
      registerHandler,
      ownerTokenRequest({
        actor_key: worker.agent_key,
        actor_label: worker.actor_label,
        display_name: worker.display_name,
        ide_label: "Codex",
        session_kind: "worker",
        runtime: "codex",
        agent_instance_id: worker.agent_instance_id,
        replace_agent_session_id: worker.session_id,
        replace_agent_session_token: worker.session_token,
      }, { params: { 0: room.id } }),
    );
    assert.equal(reconnect.statusCode, 201, JSON.stringify(reconnect.body));
    assert.equal(
      (reconnect.body as { display_name?: string }).display_name,
      "OwlSolar",
      "the older holder keeps the name when it reconnects",
    );

    // A third identity asking for any spelling of the name does not get it.
    const third = { ...agentIdentity, id: "agent_worker_session_third", canonical_key: "EmmyMay/worker-third", name: "worker-third" };
    await db.insert(agents).values({ ...third, created_at: now, updated_at: now });
    const newcomer = await invoke(
      registerHandler,
      ownerTokenRequest({
        actor_key: third.canonical_key,
        display_name: "owlsolar",
        ide_label: "Agent",
        session_kind: "worker",
        runtime: "claude-code",
        agent_instance_id: "third-instance",
      }, { params: { 0: room.id } }),
    );
    assert.equal(newcomer.statusCode, 201, JSON.stringify(newcomer.body));
    const newcomerName = (newcomer.body as { display_name?: string }).display_name ?? "";
    assert.match(newcomerName, /^[A-Za-z]+$/);
    assert.notEqual(newcomerName.toLowerCase(), "owlsolar");
  },
);

test(
  "an agent that registers again keeps its name, however often it has spoken",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!db || !agents || !dbModule) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { createRoomParticipantRecorder } = await import("../rooms/participants.js");
    const { room } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    const recorder = createRoomParticipantRecorder({ upsertRoomParticipant: dbModule.upsertRoomParticipant });
    const now = new Date().toISOString();
    const identity = { ...agentIdentity, id: "agent_mossdawn", canonical_key: "EmmyMay/mossdawn", name: "mossdawn", display_name: "MossDawn" };
    await db.insert(agents).values({ ...identity, created_at: now, updated_at: now });

    let prior: { session_id?: string; session_token?: string } | null = null;
    const sessionIds = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      const registered = await invoke(
        registerHandler,
        ownerTokenRequest({
          actor_key: identity.canonical_key,
          display_name: "MossDawn",
          requested_base_display_name: "MossDawn",
          ide_label: "Agent",
          session_kind: "worker",
          runtime: "antigravity",
          // One process that calls register again, as an agent does whenever
          // it starts a new turn.
          agent_instance_id: "one-process",
          ...(prior ? { replace_agent_session_id: prior.session_id, replace_agent_session_token: prior.session_token } : {}),
        }, { params: { 0: room.id } }),
      );
      assert.equal(registered.statusCode, 201, JSON.stringify(registered.body));
      const session = registered.body as { session_id?: string; session_token?: string; display_name?: string; actor_label?: string };
      assert.equal(session.display_name, "MossDawn", `registration ${round + 1} keeps the name`);
      sessionIds.add(session.session_id!);
      prior = session;

      // Speaking records the sender as a participant. An authenticated send
      // carries the agent key; an older caller does not, and must not erase it.
      await recorder.rememberRoomParticipantFromMessage({
        projectId: room.id, sender: session.actor_label!, source: "agent",
        agentKey: identity.canonical_key, timestamp: new Date().toISOString(),
      });
      await recorder.rememberRoomParticipantFromMessage({
        projectId: room.id, sender: session.actor_label!, source: "agent", timestamp: new Date().toISOString(),
      });
      const [row] = (await dbModule.getRoomParticipants(room.id, { limit: 200 }))
        .filter((participant) => participant.display_name === "MossDawn");
      assert.equal(row?.agent_key, identity.canonical_key, "a participant never loses its recorded owner");
    }
    assert.equal(sessionIds.size, 1, "one process keeps one session");
  },
);

test(
  "an agent that was renamed on earlier reconnects returns to its own name",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!db || !agents || !createRoomAgentSession || !dbModule) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { room } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    const now = new Date().toISOString();
    const identity = { ...agentIdentity, id: "agent_mossdawn", canonical_key: "EmmyMay/mossdawn", name: "mossdawn", display_name: "MossDawn" };
    await db.insert(agents).values({ ...identity, created_at: now, updated_at: now });
    const label = (name: string) => buildAgentActorLabel({ display_name: name, owner_label: identity.owner_label, ide_label: "Agent" });

    // The state the old behaviour leaves a room in. The agent kept ONE
    // session, renamed in place each time, so nothing in its session records
    // the names it had before. It spoke under each name, and each time the
    // participant row was written with no owner.
    const live = await createRoomAgentSession({
      room_id: room.id, runtime: "antigravity", session_kind: "worker", agent_key: identity.canonical_key,
      agent_instance_id: "one-process", owner_account_id: ownerAccount.id, owner_label: identity.owner_label,
      ide_label: "Agent", display_name: "WoodFjord", actor_label: label("WoodFjord"),
    });
    for (const name of ["MossDawn", "MossDawn 1", "MossDawn 2", "WolfRidge", "WoodFjord"]) {
      await dbModule.addMessage(room.id, label(name), `working as ${name}`, {
        source: "agent", publisher_agent_key: identity.canonical_key, publisher_agent_session_id: live.session_id,
      });
      await dbModule.upsertRoomParticipant({
        room_id: room.id, participant_key: `agent:${label(name).toLowerCase()}`, kind: "agent",
        actor_label: label(name), agent_key: null, display_name: name,
        owner_label: identity.owner_label, ide_label: "Agent",
      });
    }
    const register = (body: Record<string, unknown>) => invoke(
      registerHandler,
      ownerTokenRequest({ ide_label: "Agent", session_kind: "worker", ...body }, { params: { 0: room.id } }),
    );

    const registered = await register({
      actor_key: identity.canonical_key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
      runtime: "antigravity", agent_instance_id: "one-process",
      replace_agent_session_id: live.session_id, replace_agent_session_token: live.session_token,
    });
    assert.equal(registered.statusCode, 201, JSON.stringify(registered.body));
    const session = registered.body as { session_id?: string; display_name?: string };
    assert.equal(session.display_name, "MossDawn");
    assert.equal(session.session_id, live.session_id, "it is still the one session");
    const owned = (await dbModule.getRoomParticipants(room.id, { limit: 200 }))
      .find((participant) => participant.display_name === "MossDawn");
    assert.equal(owned?.agent_key, identity.canonical_key, "the proven owner is recorded, so it is proven once");

    // Its history is its own, not everyone's: another agent still cannot
    // take a name this agent is living under.
    const other = { ...agentIdentity, id: "agent_other", canonical_key: "EmmyMay/worker-other", name: "worker-other" };
    await db.insert(agents).values({ ...other, created_at: now, updated_at: now });
    const newcomer = await register({
      actor_key: other.canonical_key, display_name: "MossDawn", runtime: "claude-code", agent_instance_id: "other-process",
    });
    assert.equal(newcomer.statusCode, 201, JSON.stringify(newcomer.body));
    assert.notEqual((newcomer.body as { display_name?: string }).display_name, "MossDawn");
  },
);

test(
  "a name with no owner on record stays taken unless the room's messages prove whose it is",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!db || !agents || !dbModule) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { room } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    const now = new Date().toISOString();
    const mine = { ...agentIdentity, id: "agent_heron_a", canonical_key: "EmmyMay/heron", name: "heron", display_name: "Heron" };
    const theirs = { ...agentIdentity, id: "agent_heron_b", canonical_key: "EmmyMay/worker-heron", name: "worker-heron", display_name: "Heron" };
    await db.insert(agents).values([
      { ...mine, created_at: now, updated_at: now },
      { ...theirs, created_at: now, updated_at: now },
    ]);
    const heron = buildAgentActorLabel({ display_name: "Heron", owner_label: mine.owner_label, ide_label: "Agent" });
    const crane = buildAgentActorLabel({ display_name: "Crane", owner_label: mine.owner_label, ide_label: "Agent" });
    for (const [actorLabel, name] of [[heron, "Heron"], [crane, "Crane"]] as const) {
      await dbModule.upsertRoomParticipant({
        room_id: room.id, participant_key: `agent:${actorLabel.toLowerCase()}`, kind: "agent",
        actor_label: actorLabel, agent_key: null, display_name: name, owner_label: mine.owner_label, ide_label: "Agent",
      });
    }
    // Two agents have spoken as "Heron": the label proves nothing.
    await dbModule.addMessage(room.id, heron, "one", { source: "agent", publisher_agent_key: mine.canonical_key });
    await dbModule.addMessage(room.id, heron, "two", { source: "agent", publisher_agent_key: theirs.canonical_key });
    // Nobody authenticated has spoken as "Crane": nothing to prove it with.
    await dbModule.addMessage(room.id, crane, "three", { source: "agent" });

    for (const requested of ["Heron", "Crane"]) {
      const registered = await invoke(
        registerHandler,
        ownerTokenRequest({
          actor_key: mine.canonical_key, display_name: requested, requested_base_display_name: requested,
          ide_label: "Agent", session_kind: "worker", runtime: "antigravity", agent_instance_id: `process-${requested}`,
        }, { params: { 0: room.id } }),
      );
      assert.equal(registered.statusCode, 201, JSON.stringify(registered.body));
      assert.notEqual((registered.body as { display_name?: string }).display_name, requested,
        `${requested} is not proven to be this agent's`);
    }
    const rows = await dbModule.getRoomParticipants(room.id, { limit: 200 });
    assert.equal(rows.find((row) => row.display_name === "Heron")?.agent_key, null, "an unproven owner is never recorded");
  },
);

// ---------------------------------------------------------------------------
// Takeover: a name held by a session whose process is gone passes on.
// ---------------------------------------------------------------------------
async function takeoverHarness(options: { realCoordination?: boolean } = {}) {
  if (!db || !agents || !pool || !dbModule) throw new Error("DB-backed worker session tests require TEST_DB_URL");
  const { room } = await seedHarness();
  const handlers = registerRoutesForRoom(room, options);
  const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
  const now = new Date().toISOString();
  const addIdentity = async (key: string) => {
    await db!.insert(agents!).values({
      ...agentIdentity, id: `agent_${key.replace(/[^a-z0-9]/gi, "_")}`, canonical_key: key,
      name: key.split("/")[1]!, created_at: now, updated_at: now,
    });
    return key;
  };
  const register = async (body: Record<string, unknown>, host = "host_a") => {
    const response = await invoke(
      registerHandler,
      ownerTokenRequest({
        ide_label: "Agent", session_kind: "worker", runtime: "claude-code",
        // One stored host id throughout: the file that holds it can be copied
        // between machines, so it is not what tells machines apart.
        registration_liveness: { host_id: "host_shared_file", host_kind: "macos", liveness_capability: "session_activity" },
        process_host_id: host,
        ...body,
      }, { params: { 0: room.id } }),
    );
    return { status: response.statusCode, session: response.body as CreatedSession & { code?: string } };
  };
  const set = (sessionId: string, assignments: string) => pool!.query(
    `UPDATE room_agent_sessions SET ${assignments} WHERE session_id = $1`, [sessionId],
  );
  const evidence = {
    // The process exited: its connection was seen to close this long ago.
    closed: (sessionId: string, secondsAgo: number) => set(sessionId,
      `process_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', process_disconnected_at = NOW() - INTERVAL '${secondsAgo} seconds', process_connection_id = 'closed-connection', last_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', agent_heard_at = NOW() - INTERVAL '${secondsAgo} seconds'`),
    // Its connection closed this long ago, but the agent has made a room call since.
    heardAfter: (sessionId: string, how: "closed" | "exited", secondsAgo: number, heardSecondsAgo: number) => set(sessionId,
      `process_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', process_disconnected_at = NOW() - INTERVAL '${secondsAgo} seconds', process_connection_id = '${how === "exited" ? "exited" : "closed-connection"}', last_seen_at = NOW() - INTERVAL '${heardSecondsAgo} seconds', agent_heard_at = NOW() - INTERVAL '${heardSecondsAgo} seconds'`),
    // Alive and connected, but the agent has made no room call for this long.
    quiet: (sessionId: string, minutes: number) => set(sessionId,
      `process_seen_at = NOW(), process_disconnected_at = NULL, process_connection_id = 'open-connection', last_seen_at = NOW() - INTERVAL '${minutes} minutes', agent_heard_at = NOW() - INTERVAL '${minutes} minutes'`),
    // Nothing at all from it for this long: no connection, no activity.
    unseen: (sessionId: string, minutes: number) => set(sessionId,
      `process_seen_at = NOW() - INTERVAL '${minutes} minutes', process_disconnected_at = NULL, process_connection_id = 'open-connection', last_seen_at = NOW() - INTERVAL '${minutes} minutes', agent_heard_at = NOW() - INTERVAL '${minutes} minutes'`),
    // The process said it was exiting, this long ago.
    exited: (sessionId: string, secondsAgo: number) => set(sessionId,
      `process_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', process_disconnected_at = NOW() - INTERVAL '${secondsAgo} seconds', process_connection_id = 'exited', last_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', agent_heard_at = NOW() - INTERVAL '${secondsAgo} seconds'`),
    // Its connection closed this long ago and the agent has made no call
    // since. The server has: it closed the agent's delivery lease afterwards.
    closedThenBookkept: (sessionId: string, how: "closed" | "exited", secondsAgo: number) => set(sessionId,
      `process_seen_at = NOW() - INTERVAL '${secondsAgo} seconds', process_disconnected_at = NOW() - INTERVAL '${secondsAgo} seconds', process_connection_id = '${how === "exited" ? "exited" : "closed-connection"}', agent_heard_at = NOW() - INTERVAL '${secondsAgo} seconds', last_seen_at = NOW()`),
    // An older client: it never opens a process connection, and does not
    // say which machine it is on.
    none: (sessionId: string, minutes: number) => set(sessionId,
      `process_seen_at = NULL, process_disconnected_at = NULL, process_connection_id = NULL, process_host_id = NULL, last_seen_at = NOW() - INTERVAL '${minutes} minutes', agent_heard_at = NOW() - INTERVAL '${minutes} minutes'`),
  };
  const stored = async (sessionId: string) => {
    const row = (await pool!.query(
      "SELECT display_name, ended_at FROM room_agent_sessions WHERE session_id = $1", [sessionId],
    )).rows[0] as { display_name: string; ended_at: string | null };
    return { display_name: row.display_name, ended: row.ended_at !== null };
  };
  const liveNamed = async (name: string) => (await pool!.query(
    "SELECT session_id FROM room_agent_sessions WHERE room_id = $1 AND display_name = $2 AND session_kind = 'worker' AND ended_at IS NULL",
    [room.id, name],
  )).rows.map((row) => row.session_id as string);
  const worker = (letter: string) => ({ id: `worker_${letter.repeat(32)}`, token: letter.repeat(43) });
  return { room, handlers, addIdentity, register, evidence, stored, liveNamed, worker };
}

const takeoverTest = { concurrency: false, skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false };

test("a restarted process takes its name back from the session its old process left behind", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string, host?: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  }, host);

  const first = await ask("process-1");
  assert.equal(first.session.display_name, "MossDawn");

  // Its process exited a moment ago and a new one on the same machine
  // registers. They share a network, so had the old one been alive it would
  // have reopened its connection by now.
  await h.evidence.closed(first.session.session_id, 20);
  const restarted = await ask("process-2");
  assert.equal(restarted.status, 201, JSON.stringify(restarted.session));
  assert.equal(restarted.session.display_name, "MossDawn");
  assert.deepEqual(await h.stored(first.session.session_id), { display_name: "MossDawn", ended: true });
  assert.deepEqual(await h.liveNamed("MossDawn"), [restarted.session.session_id]);

  // And on every later restart: the name does not drift and nothing piles up.
  for (const instance of ["process-3", "process-4"]) {
    const holder = (await h.liveNamed("MossDawn"))[0]!;
    await h.evidence.closed(holder, 20);
    const next = await ask(instance);
    assert.equal(next.session.display_name, "MossDawn");
    assert.deepEqual(await h.liveNamed("MossDawn"), [next.session.session_id]);
  }
  const live = await pool!.query(
    "SELECT count(*)::int AS n FROM room_agent_sessions WHERE room_id = $1 AND agent_key = $2 AND ended_at IS NULL",
    [h.room.id, key],
  );
  assert.equal(live.rows[0].n, 1, "each restart ends the session it replaces");
});

test("being quiet is not being gone: a session that shows it is there is never ended", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const holder = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: "process-1" });
  let sibling = 0;
  const refused = async (why: string, host?: string) => {
    sibling += 1;
    const other = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
      agent_instance_id: `sibling-${sibling}` }, host);
    assert.equal(other.status, 201, JSON.stringify(other.session));
    assert.notEqual(other.session.display_name, "MossDawn", why);
    assert.deepEqual(await h.stored(holder.session.session_id), { display_name: "MossDawn", ended: false }, why);
  };

  await h.evidence.quiet(holder.session.session_id, 600);
  await refused("connected, and busy or waiting for ten hours");
  await h.evidence.none(holder.session.session_id, 9);
  await refused("an older client, quiet for nine minutes");
  await h.evidence.closed(holder.session.session_id, 10);
  await refused("its connection dropped ten seconds ago: it may be about to reopen it");
  await h.evidence.closed(holder.session.session_id, 120);
  await refused("seen from another machine, a closed connection may be a laptop asleep", "host_b");
  // Its connection is closed, or even announced as left, and yet the agent
  // has made a room call since. Whatever the connection says, it is there.
  await h.evidence.heardAfter(holder.session.session_id, "closed", 20, 1);
  await refused("its connection closed twenty seconds ago and it was heard from a second ago");
  await h.evidence.heardAfter(holder.session.session_id, "exited", 20, 1);
  await refused("an exit was announced for it, and it was heard from after that");
  // The same, as the room records it when the agent makes a call.
  await h.evidence.closed(holder.session.session_id, 20);
  await dbModule!.touchRoomAgentSession(holder.session.session_id);
  await refused("it made a room call after its connection closed");
  // Its process connection is closed and it has made no call since, but it
  // is waiting for messages on a connection that is open now.
  await h.evidence.closed(holder.session.session_id, 20);
  await markRoomAgentDeliveryConnected!({
    room_id: h.room.id, actor_label: holder.session.actor_label, agent_key: key, agent_instance_id: "process-1",
    agent_session_id: holder.session.session_id, session_kind: "worker", runtime: "claude-code",
    display_name: "MossDawn", owner_label: "EmmyMay", ide_label: "Agent", transport: "long_poll",
    credential_fence: { kind: "session_token", token_hash: hashToken(holder.session.session_token) },
  });
  await refused("it holds a delivery connection open");
  await pool!.query("UPDATE room_agent_delivery_sessions SET active_connection_count = 0 WHERE room_id = $1 AND agent_session_id = $2",
    [h.room.id, holder.session.session_id]);
  await h.evidence.unseen(holder.session.session_id, 9);
  await refused("nothing from it for nine minutes", "host_b");

  await h.evidence.unseen(holder.session.session_id, 11);
  const taker = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-2" }, "host_b");
  assert.equal(taker.session.display_name, "MossDawn", "nothing from it for the whole window");
  assert.deepEqual(await h.stored(holder.session.session_id), { display_name: "MossDawn", ended: true });
});

test("what the server does for a session after its agent has gone is not the agent being there", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string, host: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  }, host);

  // The agent was waiting for messages when its process went. The server
  // closed its delivery lease ten seconds later, and marked the session seen
  // as it did. That is the server's doing, and no sign of the agent.
  const first = await ask("process-1", "host_a");
  await h.evidence.closedThenBookkept(first.session.session_id, "closed", 20);
  const restarted = await ask("process-2", "host_a");
  assert.equal(restarted.session.display_name, "MossDawn");
  assert.deepEqual(await h.stored(first.session.session_id), { display_name: "MossDawn", ended: true });

  await h.evidence.closedThenBookkept(restarted.session.session_id, "exited", 12);
  const elsewhere = await ask("process-3", "host_b");
  assert.equal(elsewhere.session.display_name, "MossDawn");
});

test("a process that said it was exiting passes its name on without the wait", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string, host: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  }, host);
  const first = await ask("process-1", "host_a");

  // A second ago, and asked for from another machine: a connection that had
  // merely closed would hold the name for the whole window.
  await h.evidence.exited(first.session.session_id, 1);
  const next = await ask("process-2", "host_b");
  assert.equal(next.status, 201, JSON.stringify(next.session));
  assert.equal(next.session.display_name, "MossDawn");
  assert.deepEqual(await h.stored(first.session.session_id), { display_name: "MossDawn", ended: true });
});

test("an agent that registers afresh takes the name of the registration it lost", takeoverTest, async () => {
  const h = await takeoverHarness();
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const two = h.worker("b");
  const three = h.worker("c");
  const first = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token });
  assert.equal(first.session.display_name, "Atlas");

  // Offline is not gone. A worker that disconnected keeps its name reserved
  // while its process may still be there to reconnect.
  await h.evidence.quiet(first.session.session_id, 0);
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session.session_id });
  const tooSoon = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: two.id, connection_token: two.token });
  assert.equal(tooSoon.status, 201, JSON.stringify(tooSoon.session));
  assert.notEqual(tooSoon.session.display_name, "Atlas");

  await h.evidence.closed(first.session.session_id, 20);
  const fresh = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-three"),
    agent_instance_id: three.id, connection_token: three.token });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.session));
  assert.equal(fresh.session.display_name, "Atlas");

  // The evidence was wrong, or the machine woke up: the first worker returns.
  // It proves who it is, keeps its identity and its session, and is given a
  // name of its own instead of being refused.
  const returned = await h.register({ ...common, actor_key: first.session.agent_key, agent_instance_id: one.id,
    connection_token: "d".repeat(43),
    replace_agent_session_id: first.session.session_id, replace_agent_session_token: first.session.session_token });
  assert.equal(returned.status, 201, JSON.stringify(returned.session));
  assert.equal(returned.session.session_id, first.session.session_id);
  assert.equal(returned.session.agent_key, first.session.agent_key);
  assert.notEqual(returned.session.display_name, "Atlas");
  assert.match(returned.session.display_name, /^[A-Za-z]+$/);
  assert.deepEqual(await h.liveNamed("Atlas"), [fresh.session.session_id]);

  // While the one that has its name is there, it stays as it is, whatever
  // name it sends: a worker does not rename itself.
  await h.evidence.quiet(fresh.session.session_id, 60);
  const still = await h.register({ ...common, display_name: "Borrowed", requested_base_display_name: "Borrowed",
    actor_key: first.session.agent_key, agent_instance_id: one.id, connection_token: "e".repeat(43),
    replace_agent_session_id: returned.session.session_id, replace_agent_session_token: returned.session.session_token });
  assert.equal(still.status, 201, JSON.stringify(still.session));
  assert.equal(still.session.display_name, returned.session.display_name);
  assert.deepEqual(await h.stored(fresh.session.session_id), { display_name: "Atlas", ended: false });

  // It was given another name only because its own was held. Once the
  // holder's process is gone, it takes its own the next time it reconnects,
  // and keeps its identity and its session as it does.
  await h.evidence.closed(fresh.session.session_id, 3600);
  const again = await h.register({ ...common, actor_key: first.session.agent_key, agent_instance_id: one.id,
    connection_token: "f".repeat(43),
    replace_agent_session_id: still.session.session_id, replace_agent_session_token: still.session.session_token });
  assert.equal(again.status, 201, JSON.stringify(again.session));
  assert.equal(again.session.display_name, "Atlas");
  assert.equal(again.session.session_id, first.session.session_id);
  assert.deepEqual(await h.stored(fresh.session.session_id), { display_name: "Atlas", ended: true });
  assert.deepEqual(await h.liveNamed("Atlas"), [first.session.session_id]);
});

test("a connected durable worker whose process is gone is ended, and can still return", takeoverTest, async () => {
  const h = await takeoverHarness();
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const two = h.worker("b");
  const first = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token });
  await h.evidence.closed(first.session.session_id, 20);

  const fresh = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: two.id, connection_token: two.token });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.session));
  assert.equal(fresh.session.display_name, "Atlas");
  assert.deepEqual(await h.stored(first.session.session_id), { display_name: "Atlas", ended: true });

  const returned = await h.register({ ...common, actor_key: first.session.agent_key, agent_instance_id: one.id,
    connection_token: "c".repeat(43),
    replace_agent_session_id: first.session.session_id, replace_agent_session_token: first.session.session_token });
  assert.equal(returned.status, 201, JSON.stringify(returned.session));
  assert.equal(returned.session.session_id, first.session.session_id);
  assert.notEqual(returned.session.display_name, "Atlas");
  assert.equal((await h.stored(first.session.session_id)).ended, false);
});

test("a name is never taken from another owner's agent or from a supervised worker", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!db || !accounts || !createRoomAgentSession || !createFencedRoomAgentSession || !pool) throw new Error("no db");
  const now = new Date().toISOString();
  await db.insert(accounts).values({ ...ownerAccount, id: "acct_someone_else", provider_user_id: "someone-else",
    login: "someone", display_name: "Someone", created_at: now, updated_at: now });
  await db.insert(agents!).values({ ...agentIdentity, id: "agent_theirs", canonical_key: "someone/worker-theirs",
    name: "worker-theirs", owner_account_id: "acct_someone_else", owner_login: "someone", owner_label: "Someone",
    created_at: now, updated_at: now });
  const label = (name: string, owner: string) => buildAgentActorLabel({ display_name: name, owner_label: owner, ide_label: "Agent" });
  const hold = (input: { key: string; name: string; owner?: string; ownerLabel?: string; instance: string }) =>
    createRoomAgentSession!({
      room_id: h.room.id, runtime: "claude-code", session_kind: "worker", agent_key: input.key,
      agent_instance_id: input.instance, owner_account_id: input.owner ?? ownerAccount.id,
      owner_label: input.ownerLabel ?? "EmmyMay", ide_label: "Agent", display_name: input.name,
      actor_label: label(input.name, input.ownerLabel ?? "EmmyMay"),
      registration_liveness: { host_id: "host_a", host_kind: "macos", host_label: null, liveness_capability: null, tool_bridge_id: null },
    });
  const theirs = await hold({ key: "someone/worker-theirs", name: "Heron", owner: "acct_someone_else", ownerLabel: "Someone", instance: "their-process" });
  const supervised = await hold({ key: await h.addIdentity("EmmyMay/desktop-codex-supervised"), name: "Crane", instance: "daemon:supervised" });
  const alive = await hold({ key: await h.addIdentity("EmmyMay/worker-alive"), name: "Wren", instance: "alive-process" });
  // Supervision is recorded on the session; a grant row is not needed to mark it.
  await pool.query("ALTER TABLE room_agent_sessions DISABLE TRIGGER ALL");
  await pool.query("UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_supervised' WHERE session_id = $1", [supervised.session_id]);
  await pool.query("ALTER TABLE room_agent_sessions ENABLE TRIGGER ALL");
  for (const session of [theirs, supervised]) await h.evidence.unseen(session.session_id, 600);
  await h.evidence.quiet(alive.session_id, 600);

  const mine = await h.addIdentity("EmmyMay/worker-mine");
  for (const [name, holder] of [["Heron", theirs], ["Crane", supervised], ["Wren", alive]] as const) {
    const registered = await h.register({ actor_key: mine, display_name: name, requested_base_display_name: name,
      agent_instance_id: `process-${name}` });
    assert.equal(registered.status, 201, JSON.stringify(registered.session));
    assert.notEqual(registered.session.display_name, name, `${name} is not given up`);
    assert.deepEqual(await h.stored(holder.session_id), { display_name: name, ended: false }, `the holder of ${name} is untouched`);

    // The store decides for itself. Asked outright to end the holder, it
    // refuses the registration and leaves the holder as it was.
    await assert.rejects(createFencedRoomAgentSession({
      room_id: h.room.id, runtime: "claude-code", session_kind: "worker", agent_key: mine,
      agent_instance_id: `forced-${name}`, owner_account_id: ownerAccount.id, owner_label: "EmmyMay",
      ide_label: "Agent", display_name: `${name}Forced`, actor_label: label(`${name}Forced`, "EmmyMay"),
      registration_liveness: { host_id: "host_a", host_kind: "macos", host_label: null, liveness_capability: null, tool_bridge_id: null },
    }, null, [holder.session_id]),
    (error: { code?: string }) => error.code === "23505", `${name} cannot be taken by asking`);
    assert.deepEqual(await h.stored(holder.session_id), { display_name: name, ended: false });
  }
});

test("a session given another name takes its own the next time it registers after the holder has gone", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const holder = await h.register({ ...body, agent_instance_id: "process-1" });
  // Its process restarts and registers while the old session still counts.
  const own = await h.register({ ...body, agent_instance_id: "process-2" });
  assert.notEqual(own.session.display_name, "MossDawn");
  const again = (proof: CreatedSession) => h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: proof.session_id, replace_agent_session_token: proof.session_token });

  // While the holder shows it is there, the session stays as it is.
  await h.evidence.quiet(holder.session.session_id, 60);
  const kept = await again(own.session);
  assert.equal(kept.status, 201, JSON.stringify(kept.session));
  assert.equal(kept.session.display_name, own.session.display_name);
  assert.deepEqual(await h.stored(holder.session.session_id), { display_name: "MossDawn", ended: false });

  // The holder's process is gone. The session takes its own name, keeps its
  // session, and the holder is ended.
  await h.evidence.closed(holder.session.session_id, 3600);
  const healed = await again(kept.session);
  assert.equal(healed.status, 201, JSON.stringify(healed.session));
  assert.equal(healed.session.display_name, "MossDawn");
  assert.equal(healed.session.session_id, own.session.session_id);
  assert.deepEqual(await h.stored(holder.session.session_id), { display_name: "MossDawn", ended: true });
  assert.deepEqual(await h.liveNamed("MossDawn"), [own.session.session_id]);
});

test("a session that reaches for a name it cannot have stays as it is", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!dbModule) throw new Error("no db");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const holder = await h.register({ ...body, agent_instance_id: "process-1" });
  // It lives under a name that is not the one the room would hand out next.
  const own = await h.register({ actor_key: key, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-2" });
  assert.equal(own.session.display_name, "Heron");

  // Gone when the route reads the evidence, back before the registration
  // runs: the holder's process reopens its connection in between. The store
  // refuses the name, and the session keeps the one it has instead of being
  // moved to a third.
  await h.evidence.closed(holder.session.session_id, 3600);
  const held = await pool!.connect();
  try {
    // Hold the registration at its first lock until the holder is back.
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcp_worker_names:${h.room.id}`]);
    const registering = h.register({ ...body, agent_instance_id: "process-2",
      replace_agent_session_id: own.session.session_id, replace_agent_session_token: own.session.session_token });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(await dbModule.openRoomAgentProcessConnection({ session_id: holder.session.session_id, room_id: h.room.id }));
    await held.query("ROLLBACK");
    const result = await registering;
    assert.equal(result.status, 201, JSON.stringify(result.session));
    assert.equal(result.session.display_name, "Heron");
    assert.equal(result.session.session_id, own.session.session_id);
  } finally {
    held.release();
  }
  assert.deepEqual(await h.stored(holder.session.session_id), { display_name: "MossDawn", ended: false });
});

test("a process that comes back before the registration commits keeps its session and its name", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!createFencedRoomAgentSession || !dbModule) throw new Error("no db");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const first = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-1" });
  await h.evidence.closed(first.session.session_id, 20);
  // The route has read it as gone. Before the registration runs, the process
  // reopens its connection.
  assert.ok(await dbModule.openRoomAgentProcessConnection({ session_id: first.session.session_id, room_id: h.room.id }));
  await assert.rejects(createFencedRoomAgentSession({
    room_id: h.room.id, runtime: "claude-code", session_kind: "worker", agent_key: key,
    agent_instance_id: "process-2", owner_account_id: ownerAccount.id, owner_label: "EmmyMay",
    ide_label: "Agent", display_name: "MossDawn", actor_label: first.session.actor_label,
    registration_liveness: { host_id: "host_a", host_kind: "macos", host_label: null, liveness_capability: null, tool_bridge_id: null },
  }, null, [first.session.session_id]), (error: { code?: string }) => error.code === "23505");
  assert.deepEqual(await h.stored(first.session.session_id), { display_name: "MossDawn", ended: false });
});

test("what was addressed to an agent follows it to its restarted process", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!addMessage) throw new Error("no db");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const first = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-1" });
  await addMessage(h.room.id, "Human", "@MossDawn please investigate this");
  await h.evidence.closed(first.session.session_id, 20);
  const restarted = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-2" });
  assert.equal(restarted.session.display_name, "MossDawn");

  const receipts = await pool!.query(
    "SELECT receipt_state, agent_session_id FROM message_agent_receipts WHERE message_room_id = $1", [h.room.id]);
  assert.deepEqual(receipts.rows, [{ receipt_state: "queued", agent_session_id: first.session.session_id }],
    "the message is still waiting for the agent");
  const poll = await invoke(
    h.handlers.get.get("/^\\/rooms\\/(.+)\\/messages\\/poll$/"),
    requestWithDeliveryHeaders(restarted.session, { params: { 0: h.room.id }, query: { timeout: "1000" } }),
  );
  assert.equal(poll.statusCode, 200, JSON.stringify(poll.body));
  const decisions = ((poll.body as { messages?: Array<{ activation?: { for_current_agent?: { decision?: string; reason?: string } } }> }).messages ?? [])
    .map((message) => `${message.activation?.for_current_agent?.decision}:${message.activation?.for_current_agent?.reason}`);
  assert.deepEqual(decisions, ["activate:explicit_mention"]);
});

test("an agent whose name passes to a different agent loses what it had not answered, and its history passes too", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!addMessage || !dbModule) throw new Error("no db");
  const holderKey = await h.addIdentity("EmmyMay/first-agent");
  const takerKey = await h.addIdentity("EmmyMay/cedar");
  const holder = await h.register({ actor_key: holderKey, display_name: "Atlas", requested_base_display_name: "Atlas",
    agent_instance_id: "holder-process" });
  await dbModule.upsertRoomParticipant({
    room_id: h.room.id, participant_key: `agent:${holder.session.actor_label.toLowerCase()}`, kind: "agent",
    actor_label: holder.session.actor_label, agent_key: holderKey, display_name: "Atlas",
    owner_label: "EmmyMay", ide_label: "Agent",
  });
  await addMessage(h.room.id, "Human", "@Atlas please investigate this");
  await h.evidence.closed(holder.session.session_id, 20);

  const ask = (instance: string, extra: Record<string, unknown> = {}) => h.register({
    actor_key: takerKey, display_name: "Atlas", requested_base_display_name: "Atlas", agent_instance_id: instance, ...extra,
  });
  const taker = await ask("process-1");
  assert.equal(taker.session.display_name, "Atlas");
  const receipts = await pool!.query(
    "SELECT receipt_state FROM message_agent_receipts WHERE message_room_id = $1", [h.room.id]);
  assert.deepEqual(receipts.rows, [{ receipt_state: "unavailable" }]);

  // The name stays with the agent that took it: when it registers again, and
  // when its own process restarts.
  const again = await ask("process-1", {
    replace_agent_session_id: taker.session.session_id, replace_agent_session_token: taker.session.session_token,
  });
  assert.equal(again.session.display_name, "Atlas");
  await h.evidence.closed(again.session.session_id, 20);
  const restarted = await ask("process-2");
  assert.equal(restarted.session.display_name, "Atlas");
});

test("registrations racing for one name each get a session, one gets the name, and none fails", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const first = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-1" });
  await h.evidence.closed(first.session.session_id, 20);
  const racers = await Promise.all(Array.from({ length: 5 }, (_, index) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: `racer-${index}`,
  })));
  assert.deepEqual(racers.map((racer) => racer.status), [201, 201, 201, 201, 201], JSON.stringify(racers.map((racer) => racer.session)));
  const names = racers.map((racer) => racer.session.display_name);
  assert.equal(names.filter((name) => name === "MossDawn").length, 1);
  assert.equal(new Set(names).size, 5, "no two share a name");
  assert.equal((await h.stored(first.session.session_id)).ended, true);
});

test("a session that registers again keeps the name it has when the one it asks for is held", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string, extra: Record<string, unknown> = {}) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance, ...extra,
  });
  const first = await ask("process-1");
  const second = await ask("process-2");
  const third = await ask("process-3");
  assert.equal(first.session.display_name, "MossDawn");
  assert.equal(new Set([first, second, third].map((entry) => entry.session.display_name)).size, 3);

  // The second chat leaves, so the name it had is free again. The third
  // asks for "MossDawn" as it always does; that is still held, and it must
  // not be moved to the freed name just because that name now comes first.
  await endRoomAgentSession!({ room_id: h.room.id, session_id: second.session.session_id });
  const again = await ask("process-3", {
    replace_agent_session_id: third.session.session_id, replace_agent_session_token: third.session.session_token,
  });
  assert.equal(again.status, 201, JSON.stringify(again.session));
  assert.equal(again.session.session_id, third.session.session_id);
  assert.equal(again.session.display_name, third.session.display_name);
});

test("a returning durable worker is renamed when a session with no instance id holds its name", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!createRoomAgentSession) throw new Error("no db");
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const first = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token });
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session.session_id });
  await createRoomAgentSession({
    room_id: h.room.id, runtime: "desktop", session_kind: "worker", agent_key: await h.addIdentity("EmmyMay/worker-desktop"),
    agent_instance_id: null, owner_account_id: ownerAccount.id, owner_label: "EmmyMay", ide_label: "Agent",
    display_name: "Atlas", actor_label: first.session.actor_label,
  });
  const returned = await h.register({ ...common, actor_key: first.session.agent_key, agent_instance_id: one.id,
    connection_token: "b".repeat(43),
    replace_agent_session_id: first.session.session_id, replace_agent_session_token: first.session.session_token });
  assert.equal(returned.status, 201, JSON.stringify(returned.session));
  assert.equal(returned.session.session_id, first.session.session_id);
  assert.notEqual(returned.session.display_name, "Atlas");
});

test("a process connection records when the process was there and when it left", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!dbModule) throw new Error("no db");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const session = (await h.register({ actor_key: key, display_name: "MossDawn", agent_instance_id: "process-1" })).session;
  const row = async () => (await pool!.query(
    "SELECT process_seen_at IS NOT NULL AS seen, process_disconnected_at IS NOT NULL AS disconnected FROM room_agent_sessions WHERE session_id = $1",
    [session.session_id],
  )).rows[0] as { seen: boolean; disconnected: boolean };
  assert.deepEqual(await row(), { seen: false, disconnected: false }, "nothing is known until the process connects");

  const dropped = await dbModule.openRoomAgentProcessConnection({ session_id: session.session_id, room_id: h.room.id });
  assert.ok(dropped);
  assert.deepEqual(await row(), { seen: true, disconnected: false });
  // The connection drops and the process reopens it. The old connection's
  // close arrives late, and must not say the process has left.
  const reopened = await dbModule.openRoomAgentProcessConnection({ session_id: session.session_id, room_id: h.room.id });
  assert.ok(reopened);
  await dbModule.closeRoomAgentProcessConnection({ session_id: session.session_id, connection_id: dropped! });
  assert.deepEqual(await row(), { seen: true, disconnected: false });
  assert.equal(await dbModule.refreshRoomAgentProcessConnection({ session_id: session.session_id, connection_id: dropped! }), "replaced");
  assert.equal(await dbModule.refreshRoomAgentProcessConnection({ session_id: session.session_id, connection_id: reopened! }), "current");

  // A process that exits speaks for its own connection. Another process
  // holds the session now, so the exit of the first says nothing about it.
  const exit = (connection_id: string | null) =>
    dbModule!.recordRoomAgentProcessExit({ session_id: session.session_id, room_id: h.room.id, connection_id });
  const exited = async () => (await pool!.query(
    "SELECT process_connection_id = 'exited' AS exited FROM room_agent_sessions WHERE session_id = $1", [session.session_id],
  )).rows[0].exited as boolean;
  assert.equal(await exit(dropped!), false);
  assert.equal(await exit(null), false, "a process with no connection cannot speak over one that has");
  assert.equal(await exited(), false);
  assert.equal(await exit(reopened!), true);
  assert.equal(await exited(), true);
  assert.equal(await dbModule.refreshRoomAgentProcessConnection({ session_id: session.session_id, connection_id: reopened! }), "replaced");
  // The process starts again and connects: it is there.
  const restarted = await dbModule.openRoomAgentProcessConnection({ session_id: session.session_id, room_id: h.room.id });
  assert.equal(await exited(), false);
  assert.deepEqual(await row(), { seen: true, disconnected: false });
  await dbModule.closeRoomAgentProcessConnection({ session_id: session.session_id, connection_id: restarted! });
  assert.equal(await exit(null), true, "its connection had dropped when it exited");
  const last = await dbModule.openRoomAgentProcessConnection({ session_id: session.session_id, room_id: h.room.id });

  await dbModule.closeRoomAgentProcessConnection({ session_id: session.session_id, connection_id: last! });
  assert.deepEqual(await row(), { seen: true, disconnected: true });

  await endRoomAgentSession!({ room_id: h.room.id, session_id: session.session_id });
  assert.equal(await dbModule.openRoomAgentProcessConnection({ session_id: session.session_id, room_id: h.room.id }), null,
    "an ended session accepts no connection");
});

// The routes themselves, driven as a process drives them.
async function processRoutes(h: Awaited<ReturnType<typeof takeoverHarness>>) {
  const { waitForSseCleanupDrain } = await import("../http/sse.js");
  const connections = await import("../rooms/agent-process-connections.js");
  const open = h.handlers.get.get("/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/process$/");
  const exit = h.handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/process\\/exit$/");
  const disconnect = h.handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions\\/([^/]+)\\/disconnect$/");
  const connect = async (
    targetSessionId: string,
    credentials: { session_id: string; session_token: string },
    account: Record<string, unknown> = {},
  ) => {
    const req = Object.assign(new EventEmitter(), ownerTokenRequest({}, {
      ...account,
      params: { 0: h.room.id, 1: targetSessionId },
      headers: {
        [LETAGENTS_AGENT_SESSION_ID_HEADER.toLowerCase()]: credentials.session_id,
        [LETAGENTS_AGENT_SESSION_TOKEN_HEADER.toLowerCase()]: credentials.session_token,
      },
    }));
    const written: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, body: null as unknown, writableEnded: false, destroyed: false,
      writableNeedDrain: false, writableLength: 0, socket: null,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.body = payload; return this; },
      setHeader() { return this; },
      flushHeaders() { return undefined; },
      write(chunk: string) { written.push(chunk); return true; },
      end() { this.writableEnded = true; return this; },
    });
    await open!(req as never, res as never);
    return {
      status: res.statusCode, body: res.body as { code?: string } | null, written,
      get closed() { return res.writableEnded; },
      connectionId: () => /"connection_id":"([^"]+)"/.exec(written.join(""))?.[1] ?? null,
      // The process goes away: its end of the connection closes.
      drop: async () => { req.emit("close"); await waitForSseCleanupDrain(); },
      settle: waitForSseCleanupDrain,
    };
  };
  const evidence = async (sessionId: string) => (await pool!.query(
    `SELECT process_seen_at IS NOT NULL AS seen, process_disconnected_at IS NOT NULL AS disconnected,
            process_connection_id AS connection FROM room_agent_sessions WHERE session_id = $1`, [sessionId],
  )).rows[0] as { seen: boolean; disconnected: boolean; connection: string | null };
  return { connect, exit, disconnect, evidence, connections };
}

test("the process connection is open to a session's own process and to no one else", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const mine = (await h.register({ actor_key: await h.addIdentity("EmmyMay/mossdawn"), display_name: "MossDawn", agent_instance_id: "process-1" })).session;
  const other = (await h.register({ actor_key: await h.addIdentity("EmmyMay/heron"), display_name: "Heron", agent_instance_id: "process-2" })).session;

  // Another session's id and an id that does not exist are refused alike,
  // so the answer says nothing of which sessions exist.
  assert.equal((await routes.connect(other.session_id, mine)).status, 403);
  assert.equal((await routes.connect("agent_session_999999", mine)).status, 403);
  assert.equal((await routes.connect(mine.session_id, { session_id: mine.session_id, session_token: "not-the-token" })).status, 401);
  assert.deepEqual(await routes.evidence(other.session_id), { seen: false, disconnected: false, connection: null });
  assert.deepEqual(await routes.evidence(mine.session_id), { seen: false, disconnected: false, connection: null });

  const connection = await routes.connect(mine.session_id, mine);
  assert.equal(connection.status, 200);
  assert.ok(connection.connectionId(), "the process is told the name of its connection");
  assert.deepEqual(await routes.evidence(mine.session_id), { seen: true, disconnected: false, connection: connection.connectionId() });
  await connection.drop();
  assert.deepEqual(await routes.evidence(mine.session_id), { seen: true, disconnected: true, connection: connection.connectionId() });
  assert.equal(routes.connections.heldAgentProcessConnectionCount(), 0);
});

test("a process whose session ended is told so, connected or not", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  });

  // Connected when its session is ended: told at once, over the connection.
  const first = (await ask("process-1")).session;
  const connection = await routes.connect(first.session_id, first);
  const ended = await invoke(routes.disconnect, ownerTokenRequest(sessionCredentials(first), {
    params: { 0: h.room.id, 1: first.session_id },
  }));
  assert.equal(ended.statusCode, 200, JSON.stringify(ended.body));
  await connection.settle();
  assert.ok(connection.written.join("").includes("event: ended"));
  assert.equal(connection.closed, true);

  // Its name passes on. A connection it still had open, against what the
  // evidence said, is told at once; and it is told again when it next asks.
  // It is refused as a stranger only if it cannot prove the session was its
  // own, or if it is asked after on another owner's account.
  const second = (await ask("process-2")).session;
  const stillOpen = await routes.connect(second.session_id, second);
  await h.evidence.closed(second.session_id, 20);
  const taker = (await ask("process-3")).session;
  assert.equal(taker.display_name, "MossDawn");
  await stillOpen.settle();
  assert.ok(stillOpen.written.join("").includes("event: ended"));
  const returning = await routes.connect(second.session_id, second);
  assert.equal(returning.status, 410);
  assert.equal(returning.body?.code, "agent_session_ended");
  assert.equal((await routes.connect(second.session_id, { session_id: second.session_id, session_token: "not-the-token" })).status, 401);
  assert.equal((await routes.connect(second.session_id, second, {
    sessionAccount: { account_id: "acct_someone_else", login: "someone", display_name: "Someone" },
  })).status, 401);
});

test("a worker that disconnects while its process runs keeps its name for the full window", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const worker = h.worker("a");
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const first = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: worker.id, connection_token: worker.token }, "host_a")).session;
  const connection = await routes.connect(first.session_id, first);
  const left = await invoke(routes.disconnect, ownerTokenRequest(sessionCredentials(first), {
    params: { 0: h.room.id, 1: first.session_id },
  }));
  assert.equal(left.statusCode, 200, JSON.stringify(left.body));
  await connection.settle();
  assert.equal(connection.closed, true);
  // The room closed the connection, not the process: nothing is recorded
  // against the process, which is still running.
  assert.equal((await routes.evidence(first.session_id)).disconnected, false);

  const age = (minutes: number) => pool!.query(
    `UPDATE room_agent_sessions SET process_seen_at = NOW() - INTERVAL '${minutes} minutes',
       last_seen_at = NOW() - INTERVAL '${minutes} minutes', agent_heard_at = NOW() - INTERVAL '${minutes} minutes'
     WHERE session_id = $1`, [first.session_id]);
  let asked = 0;
  const askFor = async () => {
    asked += 1;
    const other = h.worker("bcdef"[asked]!);
    return (await h.register({ ...common, actor_key: await h.addIdentity(`EmmyMay/worker-other-${asked}`),
      agent_instance_id: other.id, connection_token: other.token }, "host_a")).session;
  };
  await age(9);
  assert.notEqual((await askFor()).display_name, "Atlas", "same machine, nine minutes on: still reserved");
  await age(11);
  assert.equal((await askFor()).display_name, "Atlas");
});

test("a server that shuts down lets go of its connections and says nothing about the processes", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const holder = (await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: "process-1" })).session;
  const connection = await routes.connect(holder.session_id, holder);
  assert.equal(routes.connections.heldAgentProcessConnectionCount(), 1);

  routes.connections.releaseAgentProcessConnectionsForShutdown();
  await connection.settle();
  assert.equal(connection.closed, true, "nothing is left open to hold the server up");
  assert.equal(routes.connections.heldAgentProcessConnectionCount(), 0);
  assert.deepEqual(await routes.evidence(holder.session_id), { seen: true, disconnected: false, connection: connection.connectionId() });

  // However long the server is away, the process is not taken for gone on
  // the strength of a connection the server itself closed.
  await pool!.query("UPDATE room_agent_sessions SET process_seen_at = NOW() - INTERVAL '5 minutes', last_seen_at = NOW() - INTERVAL '5 minutes' WHERE session_id = $1", [holder.session_id]);
  const other = await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: "process-2" });
  assert.notEqual(other.session.display_name, "MossDawn");
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "MossDawn", ended: false });

  // A connection that arrives while the server is letting go is let go too.
  try {
    const late = await routes.connect(holder.session_id, holder);
    await late.settle();
    assert.equal(late.closed, true);
    assert.equal(routes.connections.heldAgentProcessConnectionCount(), 0);
    assert.equal((await routes.evidence(holder.session_id)).disconnected, false);
  } finally {
    routes.connections.resumeAgentProcessConnections();
  }
});

test("a session that registers again in place is not told it has ended", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const body = { actor_key: await h.addIdentity("EmmyMay/mossdawn"), display_name: "MossDawn",
    requested_base_display_name: "MossDawn", agent_instance_id: "process-1" };
  const first = (await h.register(body)).session;
  const connection = await routes.connect(first.session_id, first);
  const again = await h.register({ ...body,
    replace_agent_session_id: first.session_id, replace_agent_session_token: first.session_token });
  assert.equal(again.status, 201, JSON.stringify(again.session));
  assert.equal(again.session.session_id, first.session_id);
  await connection.settle();
  assert.equal(connection.written.join("").includes("event: ended"), false);
  await connection.drop();
});

test("a process announces its exit over the route, for its own connection only", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string, host: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  }, host);
  const holder = (await ask("process-1", "host_a")).session;
  const other = (await h.register({ actor_key: await h.addIdentity("EmmyMay/heron"), display_name: "Heron", agent_instance_id: "process-9" })).session;
  const connection = await routes.connect(holder.session_id, holder);
  const announce = (targetSessionId: string, credentials: CreatedSession, connectionId: string | null) => invoke(routes.exit,
    ownerTokenRequest({ ...sessionCredentials(credentials), process_connection_id: connectionId }, {
      params: { 0: h.room.id, 1: targetSessionId },
    }));

  assert.equal((await announce(holder.session_id, other, connection.connectionId())).statusCode, 403, "not for another's session");
  const stale = await announce(holder.session_id, holder, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual(stale.body, { recorded: false }, "not for a connection that is not the one open");
  assert.equal((await routes.evidence(holder.session_id)).connection, connection.connectionId());

  await connection.drop();
  const announced = await announce(holder.session_id, holder, connection.connectionId());
  assert.deepEqual(announced.body, { recorded: true });
  assert.equal((await routes.evidence(holder.session_id)).connection, "exited");

  // The exit is never recorded as earlier than the last thing the agent
  // did, even if the clocks that stamped the two disagree.
  await pool!.query("UPDATE room_agent_sessions SET process_connection_id = 'open-again', process_disconnected_at = NULL, agent_heard_at = NOW() + INTERVAL '2 seconds' WHERE session_id = $1", [holder.session_id]);
  assert.equal(await dbModule!.recordRoomAgentProcessExit({ session_id: holder.session_id, room_id: h.room.id, connection_id: "open-again" }), true);
  const stamps = (await pool!.query("SELECT process_disconnected_at >= agent_heard_at AS ordered FROM room_agent_sessions WHERE session_id = $1", [holder.session_id])).rows[0];
  assert.equal(stamps.ordered, true);

  // The announcement was itself a room call, heard as it was made. It does
  // not count as the agent being heard from after it left.
  const next = await ask("process-2", "host_b");
  assert.equal(next.session.display_name, "MossDawn");
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "MossDawn", ended: true });
});

test("what was known of one process is not held against the next to register", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const worker = h.worker("a");
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const durable = { ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"), agent_instance_id: worker.id, connection_token: worker.token };
  const first = (await h.register(durable, "host_a")).session;
  await h.evidence.exited(first.session_id, 30);

  // Its process starts again and registers. Whether or not this one ever
  // opens a connection, the exit of the last one says nothing about it.
  const again = await h.register({ ...durable, connection_token: "b".repeat(43),
    replace_agent_session_id: first.session_id, replace_agent_session_token: first.session_token }, "host_a");
  assert.equal(again.status, 201, JSON.stringify(again.session));
  assert.equal(again.session.session_id, first.session_id);
  assert.deepEqual(await routes.evidence(first.session_id), { seen: false, disconnected: false, connection: null });

  const other = h.worker("c");
  const asked = await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: other.id, connection_token: other.token }, "host_b");
  assert.notEqual(asked.session.display_name, "Atlas");
  assert.deepEqual(await h.stored(first.session_id), { display_name: "Atlas", ended: false });
});

test("a registration that finds the room busy is asked to come back, and ends nobody", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const ask = (instance: string) => h.register({
    actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: instance,
  });
  const holder = (await ask("process-1")).session;
  await h.evidence.closed(holder.session_id, 20);

  const busy = await pool!.connect();
  try {
    await busy.query("BEGIN");
    await busy.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcp_worker_names:${h.room.id}`]);
    const started = Date.now();
    const refused = await ask("process-2");
    assert.equal(refused.status, 503, JSON.stringify(refused.session));
    assert.ok(Date.now() - started < 8_000, "the wait is bounded");
    assert.deepEqual(await h.stored(holder.session_id), { display_name: "MossDawn", ended: false });
  } finally {
    await busy.query("ROLLBACK");
    busy.release();
  }
  const retried = await ask("process-2");
  assert.equal(retried.status, 201);
  assert.equal(retried.session.display_name, "MossDawn");
});

test("the store refuses a takeover the route should never have asked for", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!createFencedRoomAgentSession) throw new Error("no db");
  const holderKey = await h.addIdentity("EmmyMay/mossdawn");
  const takerKey = await h.addIdentity("EmmyMay/heron");
  const holder = (await h.register({ actor_key: holderKey, display_name: "MossDawn", requested_base_display_name: "MossDawn", agent_instance_id: "process-1" })).session;
  const take = (instance: string, displayName: string, takeover: string[], connectionToken?: string) => createFencedRoomAgentSession({
    room_id: h.room.id, session_kind: "worker", runtime: "claude-code", agent_key: takerKey, agent_instance_id: instance,
    connection_token: connectionToken,
    display_name: displayName, assigned_base_display_name: displayName,
    actor_label: buildAgentActorLabel({ display_name: displayName, owner_label: "EmmyMay", ide_label: "Agent" }),
    owner_account_id: ownerAccount.id, owner_label: "EmmyMay", ide_label: "Agent", process_host_id: "host_a",
  }, null, takeover);
  const conflict = (error: unknown) => (error as { code?: string }).code === "23505";

  // Gone by every sign, but the instance asking is the holder's own.
  await h.evidence.exited(holder.session_id, 30);
  await assert.rejects(take("process-1", "MossDawn", [holder.session_id]), conflict);
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "MossDawn", ended: false });

  // Gone by every sign when the route looked, but waiting for messages on a
  // connection it has opened since.
  await markRoomAgentDeliveryConnected!({
    room_id: h.room.id, actor_label: holder.actor_label, agent_key: holderKey, agent_instance_id: "process-1",
    agent_session_id: holder.session_id, session_kind: "worker", runtime: "claude-code",
    display_name: "MossDawn", owner_label: "EmmyMay", ide_label: "Agent", transport: "long_poll",
    credential_fence: { kind: "session_token", token_hash: hashToken(holder.session_token) },
  });
  await h.evidence.exited(holder.session_id, 30);
  await assert.rejects(take("process-5", "MossDawn", [holder.session_id]), conflict);
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "MossDawn", ended: false });

  // A supervised worker that is offline keeps its name reserved: its
  // lifetime belongs to its supervisor, whatever its process evidence says.
  const supervised = h.worker("d");
  const reserved = (await h.register({ actor_key: await h.addIdentity("EmmyMay/worker-sup"), display_name: "Juniper",
    requested_base_display_name: "Juniper", agent_instance_id: supervised.id, connection_token: supervised.token })).session;
  await endRoomAgentSession!({ room_id: h.room.id, session_id: reserved.session_id });
  await h.evidence.exited(reserved.session_id, 30);
  await pool!.query("ALTER TABLE room_agent_sessions DISABLE TRIGGER ALL");
  try {
    await pool!.query("UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_test' WHERE session_id = $1", [reserved.session_id]);
  } finally {
    await pool!.query("ALTER TABLE room_agent_sessions ENABLE TRIGGER ALL");
  }
  const asking = h.worker("e");
  await assert.rejects(take(asking.id, "Juniper", [], asking.token), conflict);

  // The same worker, unsupervised, has let the name go.
  await pool!.query("ALTER TABLE room_agent_sessions DISABLE TRIGGER ALL");
  try {
    await pool!.query("UPDATE room_agent_sessions SET supervisor_grant_id = NULL WHERE session_id = $1", [reserved.session_id]);
  } finally {
    await pool!.query("ALTER TABLE room_agent_sessions ENABLE TRIGGER ALL");
  }
  const taken = await take(asking.id, "Juniper", [], asking.token);
  assert.equal(taken.session.display_name, "Juniper");
});

// ---------------------------------------------------------------------------
// What an agent had follows it: its leases, and its name without a detour.
// ---------------------------------------------------------------------------
async function leaseHarness(h: Awaited<ReturnType<typeof takeoverHarness>>) {
  const give = async (session: CreatedSession, title: string, kind: "work" | "review" = "work", status?: "assigned") => {
    const task = await createTask!(h.room.id, title, "Human");
    if (status) {
      await updateTask!(h.room.id, task.id, { status: "accepted" });
      await updateTask!(h.room.id, task.id, { status, assignee: session.actor_label, assignee_agent_key: session.agent_key });
    }
    const lease = await createTaskLease!({ room_id: h.room.id, task_id: task.id, kind, agent_key: session.agent_key,
      agent_session_id: session.session_id, agent_instance_id: session.agent_instance_id ?? null,
      actor_label: session.actor_label, created_by: "lease_adoption_test" });
    return { task, lease };
  };
  const held = async (leaseId: string) => (await pool!.query(
    "SELECT agent_session_id, agent_key, actor_label, epoch, status FROM task_leases WHERE id = $1", [leaseId],
  )).rows[0] as { agent_session_id: string; agent_key: string; actor_label: string; epoch: number; status: string };
  const advance = (session: CreatedSession, taskId: string, status: string) => invoke(
    h.handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
    ownerTokenRequest({ status, actor_key: session.agent_key, actor_label: session.actor_label, ...sessionCredentials(session) },
      { params: { 0: h.room.id, 1: taskId }, query: {} }));
  return { give, held, advance };
}

test("an agent that starts again holds the leases its old session held", takeoverTest, async () => {
  const h = await takeoverHarness({ realCoordination: true });
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test", "work", "assigned");
  const review = await leases.give(first, "Review the migration", "review");

  // Its process exits and a new one registers: the name comes back, and with
  // it the work the agent was doing.
  await h.evidence.exited(first.session_id, 5);
  const restarted = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  assert.equal(restarted.display_name, "MossDawn");
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: restarted.session_id, agent_key: key, actor_label: restarted.actor_label, epoch: 1, status: "active",
  });
  assert.equal((await leases.held(review.lease.id)).agent_session_id, restarted.session_id);
  // Which is what lets it go on: the old session is refused, the new one
  // moves the task forward.
  const stale = await leases.advance(first, work.task.id, "in_progress");
  assert.equal(stale.statusCode, 401, JSON.stringify(stale.body));
  const moved = await leases.advance(restarted, work.task.id, "in_progress");
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));

  assert.equal((await pool!.query(
    "SELECT count(*)::int AS n FROM coordination_events WHERE room_id = $1 AND lease_id = $2 AND event_type = 'lease_adopt'",
    [h.room.id, work.lease.id])).rows[0].n, 1, "the move is on record");

  // It disconnects and registers again, in the same process: what it held
  // is still its own.
  await endRoomAgentSession!({ room_id: h.room.id, session_id: restarted.session_id });
  const again = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  assert.notEqual(again.session_id, restarted.session_id);
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: again.session_id, agent_key: key, actor_label: again.actor_label, epoch: 2, status: "active",
  });
  // A review lease has no fence to advance: its epoch stays as it was.
  assert.deepEqual(await leases.held(review.lease.id), {
    agent_session_id: again.session_id, agent_key: key, actor_label: again.actor_label, epoch: 0, status: "active",
  });
});

test("work is not taken from an agent that was only silent, or that only disconnected", takeoverTest, async () => {
  const h = await takeoverHarness({ realCoordination: true });
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const untouched = async (lease: { id: string }, holder: CreatedSession, why: string) => assert.deepEqual(
    await leases.held(lease.id),
    { agent_session_id: holder.session_id, agent_key: key, actor_label: holder.actor_label, epoch: 0, status: "active" }, why);

  // Two processes under one identity, both there. One disconnects, and the
  // other registers again. The first may register again too: its work is
  // not the other's to take.
  const first = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const sibling = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  const work = await leases.give(first, "Fix the flaky test", "work", "assigned");
  await h.evidence.quiet(first.session_id, 0);
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  const siblingAgain = (await h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: sibling.session_id, replace_agent_session_token: sibling.session_token })).session;
  await untouched(work.lease, first, "its holder disconnected; nothing says its process exited");
  const firstAgain = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  assert.equal((await leases.held(work.lease.id)).agent_session_id, firstAgain.session_id);

  // An agent silent for long enough loses its name to a sibling that asks
  // for it. It does not lose its work: silence is not an exit.
  const quiet = (await h.register({ ...body, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-3" })).session;
  assert.equal(quiet.display_name, "Heron");
  const held = await leases.give(quiet, "Write the release notes", "work", "assigned");
  await h.evidence.none(quiet.session_id, 61);
  const taker = (await h.register({ ...body, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-2",
    replace_agent_session_id: siblingAgain.session_id, replace_agent_session_token: siblingAgain.session_token })).session;
  assert.equal(taker.display_name, "Heron");
  assert.deepEqual(await h.stored(quiet.session_id), { display_name: "Heron", ended: true });
  await untouched(held.lease, quiet, "its holder was silent; nothing says its process exited");
  // It was there after all. It registers again, under another name, and
  // its work is still its own.
  const back = (await h.register({ ...body, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-3" })).session;
  assert.notEqual(back.display_name, "Heron");
  assert.equal((await leases.held(held.lease.id)).agent_session_id, back.session_id);
  const moved = await leases.advance(back, held.task.id, "in_progress");
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
});

test("an agent that carries a name on carries its work, under whatever identity it returns", takeoverTest, async () => {
  const h = await takeoverHarness({ realCoordination: true });
  const leases = await leaseHarness(h);
  // Without a durable handle an agent is given a new identity by every
  // process it runs in. Its name is all that says it is the same agent.
  const before = await h.addIdentity("EmmyMay/mossdawn");
  const after = await h.addIdentity("EmmyMay/dunemarsh");
  const asks = { display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...asks, actor_key: before, agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test", "work", "assigned");
  const review = await leases.give(first, "Review the migration", "review");

  await h.evidence.exited(first.session_id, 5);
  const restarted = (await h.register({ ...asks, actor_key: after, agent_instance_id: "process-2" })).session;
  assert.equal(restarted.display_name, "MossDawn");
  assert.equal(restarted.agent_key, after);
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: restarted.session_id, agent_key: after, actor_label: restarted.actor_label, epoch: 1, status: "active",
  });
  // A review is asked for by each identity in its own right, and stays.
  assert.equal((await leases.held(review.lease.id)).agent_session_id, first.session_id);
  const assigned = (await pool!.query("SELECT assignee, assignee_agent_key FROM tasks WHERE room_id = $1 AND number = $2",
    [h.room.id, Number(work.task.id.replace("task_", ""))])).rows[0];
  assert.deepEqual(assigned, { assignee: restarted.actor_label, assignee_agent_key: after });
  const moved = await leases.advance(restarted, work.task.id, "in_progress");
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
});

test("nothing passes from an identity that is still in the room", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  // An identity whose key is not its name: a name that is also a key
  // cannot pass on at all while that identity has a session.
  const theirs = await h.addIdentity("EmmyMay/reefwave");
  const mine = await h.addIdentity("EmmyMay/dunemarsh");
  const asks = { display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  // One identity, two processes. The one called MossDawn holds the work.
  const named = (await h.register({ ...asks, actor_key: theirs, agent_instance_id: "process-1" })).session;
  const sibling = (await h.register({ ...asks, actor_key: theirs, agent_instance_id: "process-2" })).session;
  assert.notEqual(sibling.display_name, "MossDawn");
  const work = await leases.give(named, "Fix the flaky test", "work", "assigned");

  // Its process goes, and another agent is given the name. The identity
  // that had the work is still here, in its other process: the work is its.
  await h.evidence.exited(named.session_id, 5);
  await h.evidence.quiet(sibling.session_id, 1);
  const other = (await h.register({ ...asks, actor_key: mine, agent_instance_id: "process-3" })).session;
  assert.equal(other.display_name, "MossDawn");
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: named.session_id, agent_key: theirs, actor_label: named.actor_label, epoch: 0, status: "active",
  });
  const again = (await h.register({ actor_key: theirs, display_name: sibling.display_name,
    requested_base_display_name: sibling.display_name, agent_instance_id: "process-2",
    replace_agent_session_id: sibling.session_id, replace_agent_session_token: sibling.session_token })).session;
  assert.equal(again.session_id, sibling.session_id);
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: sibling.session_id, agent_key: theirs, actor_label: again.actor_label, epoch: 1, status: "active",
  });
});

test("a durable worker's name may pass on while it is away; its work waits for it", takeoverTest, async () => {
  const h = await takeoverHarness({ realCoordination: true });
  const leases = await leaseHarness(h);
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const two = h.worker("b");
  const first = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token })).session;
  const work = await leases.give(first, "Write the release notes", "work", "assigned");
  const reviewing = await leases.give(first, "Review the migration", "review");

  // Its chat is closed for the night: the process says it is exiting. Another
  // durable worker of the same owner asks for its name and is given it. The
  // identity that held the work comes back to its own row, so the work is
  // not the other's to take.
  await h.evidence.exited(first.session_id, 5);
  const other = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: two.id, connection_token: two.token })).session;
  assert.equal(other.display_name, "Atlas");
  assert.equal((await leases.held(work.lease.id)).agent_session_id, first.session_id);
  assert.equal((await leases.held(reviewing.lease.id)).agent_session_id, first.session_id);
  assert.equal("adopted_task_leases" in (other as object), false);

  const returning = await h.register({ ...common, actor_key: first.agent_key, agent_instance_id: one.id,
    connection_token: "d".repeat(43),
    replace_agent_session_id: first.session_id, replace_agent_session_token: first.session_token });
  assert.equal(returning.status, 201, JSON.stringify(returning.session));
  const returned = returning.session;
  assert.notEqual(returned.display_name, "Atlas");
  assert.equal(returned.session_id, first.session_id);
  assert.equal((await leases.held(work.lease.id)).agent_session_id, returned.session_id);
  // It works under its new label, and the board says so: "Atlas" is
  // someone else now.
  assert.equal((await leases.held(work.lease.id)).actor_label, returned.actor_label);
  const assigned = (await pool!.query("SELECT assignee, assignee_agent_key FROM tasks WHERE room_id = $1 AND number = $2",
    [h.room.id, Number(work.task.id.replace("task_", ""))])).rows[0];
  assert.deepEqual(assigned, { assignee: returned.actor_label, assignee_agent_key: returned.agent_key });
  const moved = await leases.advance(returned, work.task.id, "in_progress");
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
  const refused = await leases.advance(other, work.task.id, "in_review");
  assert.notEqual(refused.statusCode, 200);
});

test("a connection let go of after the session ended is not a process that exited", takeoverTest, async () => {
  const h = await takeoverHarness();
  const routes = await processRoutes(h);
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...body, agent_instance_id: "process-1" }, "host_a")).session;
  const sibling = (await h.register({ ...body, agent_instance_id: "process-2" }, "host_a")).session;
  const work = await leases.give(first, "Fix the flaky test");

  // The session ends on one server while another holds its connection. The
  // process then lets the connection go, and that server records the close.
  const connection = await routes.connect(first.session_id, first);
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  await dbModule!.closeRoomAgentProcessConnection({ session_id: first.session_id, connection_id: connection.connectionId()! });
  assert.equal((await routes.evidence(first.session_id)).disconnected, false, "nothing is recorded on an ended session");

  // Even were it recorded, a close after the end is no exit.
  await pool!.query(`UPDATE room_agent_sessions SET process_disconnected_at = ended_at + INTERVAL '2 seconds',
    process_seen_at = ended_at + INTERVAL '2 seconds', agent_heard_at = ended_at - INTERVAL '1 second',
    last_seen_at = ended_at - INTERVAL '1 second' WHERE session_id = $1`, [first.session_id]);
  await pool!.query("UPDATE room_agent_sessions SET ended_at = ended_at - INTERVAL '20 seconds', process_disconnected_at = process_disconnected_at - INTERVAL '20 seconds', process_seen_at = process_seen_at - INTERVAL '20 seconds', agent_heard_at = agent_heard_at - INTERVAL '20 seconds', last_seen_at = last_seen_at - INTERVAL '20 seconds' WHERE session_id = $1", [first.session_id]);
  const again = (await h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: sibling.session_id, replace_agent_session_token: sibling.session_token }, "host_a")).session;
  assert.equal(again.session_id, sibling.session_id);
  assert.equal((await leases.held(work.lease.id)).agent_session_id, first.session_id);
  await connection.drop();
});

test("of two durable workers under one name, the older keeps it when it reconnects", takeoverTest, async () => {
  const h = await takeoverHarness();
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const two = h.worker("b");
  const senior = (await h.register({ ...common, ide_label: "Agent", actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token })).session;
  // A namesake under another label, as the store once allowed.
  const junior = (await h.register({ display_name: "Heron", requested_base_display_name: "Heron", ide_label: "Codex",
    actor_key: await h.addIdentity("EmmyMay/worker-two"), agent_instance_id: two.id, connection_token: two.token })).session;
  await pool!.query("UPDATE room_agent_sessions SET display_name = 'Atlas', actor_label = $2 WHERE session_id = $1",
    [junior.session_id, buildAgentActorLabel({ display_name: "Atlas", owner_label: "EmmyMay", ide_label: "Codex" })]);
  await h.evidence.quiet(junior.session_id, 1);

  const reconnecting = await h.register({ ...common, ide_label: "Agent", actor_key: senior.agent_key, agent_instance_id: one.id,
    connection_token: "c".repeat(43),
    replace_agent_session_id: senior.session_id, replace_agent_session_token: senior.session_token });
  assert.equal(reconnecting.status, 201, JSON.stringify(reconnecting.session));
  const reconnected = reconnecting.session;
  assert.equal(reconnected.display_name, "Atlas");
  assert.equal(reconnected.session_id, senior.session_id);
});

test("leases are not adopted from a live session, a supervised one, or another owner's", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const live = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const supervised = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  const theirs = (await h.register({ ...body, agent_instance_id: "process-3" })).session;
  const expired = (await h.register({ ...body, agent_instance_id: "process-4" })).session;
  const fromLive = await leases.give(live, "Held by a session that is there");
  const fromSupervised = await leases.give(supervised, "Held under a supervisor");
  const fromTheirs = await leases.give(theirs, "Held by another owner's session");
  const fromExpired = await leases.give(expired, "Held by a lease that ran out");
  for (const session of [supervised, theirs, expired]) {
    await endRoomAgentSession!({ room_id: h.room.id, session_id: session.session_id });
  }
  await pool!.query("ALTER TABLE room_agent_sessions DISABLE TRIGGER ALL");
  try {
    await pool!.query("UPDATE room_agent_sessions SET supervisor_grant_id = 'grant_test' WHERE session_id = $1", [supervised.session_id]);
    await pool!.query("UPDATE room_agent_sessions SET owner_account_id = 'acct_someone_else' WHERE session_id = $1", [theirs.session_id]);
  } finally {
    await pool!.query("ALTER TABLE room_agent_sessions ENABLE TRIGGER ALL");
  }
  // Another agent of the same owner, under another name, whose process has
  // exited and which has left the room: its work is not this agent's.
  const stranger = (await h.register({ actor_key: await h.addIdentity("EmmyMay/cedarpeak"), display_name: "CedarPeak",
    requested_base_display_name: "CedarPeak", agent_instance_id: "process-6" })).session;
  const fromStranger = await leases.give(stranger, "Held by another agent");
  await endRoomAgentSession!({ room_id: h.room.id, session_id: stranger.session_id });
  // Every one of their processes is known to have exited. That alone moves
  // nothing: the live one's session has not ended, and may yet be resumed.
  for (const session of [live, supervised, theirs, expired, stranger]) await h.evidence.exited(session.session_id, 30);
  await pool!.query("UPDATE task_leases SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [fromExpired.lease.id]);

  // It asks for a name nobody holds, so that it takes nothing over.
  const next = (await h.register({ ...body, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-5" })).session;
  assert.equal(next.display_name, "Heron");
  assert.deepEqual(await h.stored(live.session_id), { display_name: "MossDawn", ended: false });
  assert.equal((await pool!.query("SELECT status FROM task_leases WHERE id = $1", [fromExpired.lease.id])).rows[0].status, "active");
  assert.equal((await leases.held(fromStranger.lease.id)).agent_session_id, stranger.session_id);
  assert.equal((await leases.held(fromLive.lease.id)).agent_session_id, live.session_id);
  assert.equal((await leases.held(fromSupervised.lease.id)).agent_session_id, supervised.session_id);
  assert.equal((await leases.held(fromTheirs.lease.id)).agent_session_id, theirs.session_id);
  assert.equal((await leases.held(fromExpired.lease.id)).agent_session_id, expired.session_id);
  assert.notEqual(next.session_id, live.session_id);
});

test("a lease that something is writing to is left for the next registration", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test");
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  await h.evidence.exited(first.session_id, 5);

  const writing = await pool!.connect();
  let second: CreatedSession;
  try {
    await writing.query("BEGIN");
    await writing.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${work.lease.id}`]);
    const started = Date.now();
    second = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
    assert.ok(Date.now() - started < 3_000, "the registration does not wait for the lease");
    assert.equal((await leases.held(work.lease.id)).agent_session_id, first.session_id);
  } finally {
    await writing.query("ROLLBACK");
    writing.release();
  }
  const again = (await h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: second.session_id, replace_agent_session_token: second.session_token })).session;
  assert.equal((await leases.held(work.lease.id)).agent_session_id, again.session_id);
});

test("a process that restarts at once is given its name, not another to keep", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...body, agent_instance_id: "process-1" }, "host_a")).session;

  // Its process was killed thirteen seconds ago and the new one registers
  // now. In two seconds the old one will be taken for gone: the room waits
  // for that, instead of answering at once with another name.
  await h.evidence.closed(first.session_id, 13);
  const started = Date.now();
  const restarted = (await h.register({ ...body, agent_instance_id: "process-2" }, "host_a")).session;
  const waited = Date.now() - started;
  assert.equal(restarted.display_name, "MossDawn");
  assert.ok(waited >= 1_500 && waited < 6_000, `waited ${waited} ms`);
  assert.deepEqual(await h.stored(first.session_id), { display_name: "MossDawn", ended: true });

  // Nothing is waited for when waiting would not help: seen from another
  // machine, only a long silence would show that the process is gone.
  await h.evidence.closed(restarted.session_id, 13);
  const before = Date.now();
  const elsewhere = (await h.register({ ...body, agent_instance_id: "process-3" }, "host_b")).session;
  assert.ok(Date.now() - before < 1_000);
  assert.notEqual(elsewhere.display_name, "MossDawn");
});

test("an older client gives up its name only after a long silence, and is told when it has", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const old = (await h.register({ ...body, agent_instance_id: "process-1" })).session;

  // Its process restarted onto a client that knows of process connections.
  // The session it left behind offers no evidence, only silence.
  await h.evidence.none(old.session_id, 2);
  const restarted = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  assert.notEqual(restarted.display_name, "MossDawn");
  // Ten minutes of silence is an agent at work: it is heard only when it
  // writes to the room.
  await h.evidence.none(old.session_id, 59);
  const waiting = (await h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: restarted.session_id, replace_agent_session_token: restarted.session_token })).session;
  assert.equal(waiting.display_name, restarted.display_name);
  assert.deepEqual(await h.stored(old.session_id), { display_name: "MossDawn", ended: false });
  await h.evidence.none(old.session_id, 61);
  const healed = (await h.register({ ...body, agent_instance_id: "process-2",
    replace_agent_session_id: waiting.session_id, replace_agent_session_token: waiting.session_token })).session;
  assert.equal(healed.display_name, "MossDawn");
  assert.deepEqual(await h.stored(old.session_id), { display_name: "MossDawn", ended: true });

  // Had the old process been there after all, its next call is answered
  // with what happened and what to do, in words its agent can act on.
  const refused = await invoke(h.handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
    ownerTokenRequest({ text: "still here", ...sessionCredentials(old) }, { params: { 0: h.room.id } }));
  assert.equal(refused.statusCode, 401);
  assert.deepEqual(refused.body, { error: AGENT_SESSION_ENDED_ADVICE });
  // Nobody else learns from the answer that there was such a session.
  const stranger = await invoke(h.handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
    ownerTokenRequest({ text: "whose is this", ...sessionCredentials(old) }, {
      params: { 0: h.room.id },
      sessionAccount: { account_id: "acct_someone_else", login: "someone", display_name: "Someone" },
    }));
  assert.equal(stranger.statusCode, 401);
  assert.deepEqual(stranger.body, { error: "Invalid agent session credentials." });
});

test("an older worker that could not start again is never taken over", takeoverTest, async () => {
  const h = await takeoverHarness();
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const old = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token })).session;
  let asked = 0;
  const askFor = async () => {
    asked += 1;
    const other = h.worker("bcdef"[asked]!);
    return (await h.register({ ...common, actor_key: await h.addIdentity(`EmmyMay/worker-other-${asked}`),
      agent_instance_id: other.id, connection_token: other.token })).session;
  };

  // It answers from the session it holds until its process is restarted. A
  // name is not worth leaving it unable to work, however long it is silent.
  await h.evidence.none(old.session_id, 61);
  assert.notEqual((await askFor()).display_name, "Atlas", "an hour of silence");
  await h.evidence.none(old.session_id, 60 * 24 * 30);
  assert.notEqual((await askFor()).display_name, "Atlas", "a month");
  assert.deepEqual(await h.stored(old.session_id), { display_name: "Atlas", ended: false });

  // Once it has disconnected there is nothing to end, and its reservation
  // lapses like any other.
  await endRoomAgentSession!({ room_id: h.room.id, session_id: old.session_id });
  await h.evidence.none(old.session_id, 11);
  assert.equal((await askFor()).display_name, "Atlas");
});

test("two workers under one name cannot both be there, whatever their labels", takeoverTest, async () => {
  const h = await takeoverHarness();
  const common = { display_name: "Juniper", requested_base_display_name: "Juniper" };
  const one = h.worker("a");
  const two = h.worker("b");
  const first = (await h.register({ ...common, ide_label: "Agent", actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token })).session;
  await h.evidence.exited(first.session_id, 5);
  // A label carries the IDE, so this worker's label differs from the first's.
  const other = (await h.register({ ...common, ide_label: "Codex", actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: two.id, connection_token: two.token })).session;
  assert.equal(other.display_name, "Juniper");
  assert.notEqual(other.actor_label, first.actor_label);

  await h.evidence.quiet(other.session_id, 1);
  const returned = (await h.register({ ...common, ide_label: "Agent", actor_key: first.agent_key, agent_instance_id: one.id,
    connection_token: "d".repeat(43),
    replace_agent_session_id: first.session_id, replace_agent_session_token: first.session_token })).session;
  assert.notEqual(returned.display_name, "Juniper");
  assert.deepEqual(await h.liveNamed("Juniper"), [other.session_id]);
});

test("a registration locks the sessions it replaces and the ones it takes from in one order", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const holder = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const own = (await h.register({ ...body, agent_instance_id: "process-2" })).session;
  assert.ok(holder.session_id < own.session_id, "the holder sorts first");
  await h.evidence.closed(holder.session_id, 3600);

  // Another writer locks both sessions in the order every writer must: the
  // holder, then the registrant. The registration asks for the holder first
  // too, so it waits holding nothing, and the writer is not kept from the
  // registrant's row.
  const writer = await pool!.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout = '2s'");
    await writer.query("SELECT 1 FROM room_agent_sessions WHERE session_id = $1 FOR SHARE", [holder.session_id]);
    const registering = h.register({ ...body, agent_instance_id: "process-2",
      replace_agent_session_id: own.session_id, replace_agent_session_token: own.session_token });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writer.query("SELECT 1 FROM room_agent_sessions WHERE session_id = $1 FOR SHARE", [own.session_id]);
    await writer.query("COMMIT");
    const result = await registering;
    assert.equal(result.status, 201, JSON.stringify(result.session));
    assert.equal(result.session.display_name, "MossDawn");
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
  }
});

test("an agent is told which of its work it holds again, and the board names it", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const first = (await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test", "work", "assigned");
  const before = (await pool!.query("SELECT last_heartbeat_at FROM task_leases WHERE id = $1", [work.lease.id])).rows[0];
  await pool!.query("UPDATE task_leases SET last_heartbeat_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [work.lease.id]);

  // It returns under another name: the one it had is asked for by nobody.
  await h.evidence.exited(first.session_id, 5);
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  await h.evidence.exited(first.session_id, 5);
  const restarted = await h.register({ actor_key: key, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-2" });
  assert.equal(restarted.session.display_name, "Heron");
  assert.deepEqual((restarted.session as unknown as { adopted_task_leases: unknown }).adopted_task_leases,
    [{ lease_id: work.lease.id, task_id: work.task.id, kind: "work" }]);
  assert.equal((await leases.held(work.lease.id)).actor_label, restarted.session.actor_label);
  const after = (await pool!.query(
    "SELECT last_heartbeat_at > NOW() - INTERVAL '1 minute' AS fresh FROM task_leases WHERE id = $1", [work.lease.id])).rows[0];
  assert.ok(before && after.fresh, "a lease that moved is a lease that is held");
  const assigned = (await pool!.query("SELECT assignee, assignee_agent_key FROM tasks WHERE room_id = $1 AND number = $2",
    [h.room.id, Number(work.task.id.replace("task_", ""))])).rows[0];
  assert.deepEqual(assigned, { assignee: restarted.session.actor_label, assignee_agent_key: key });

  // Nothing is said when there is nothing to say.
  const again = await h.register({ actor_key: key, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-2",
    replace_agent_session_id: restarted.session.session_id, replace_agent_session_token: restarted.session.session_token });
  assert.equal("adopted_task_leases" in (again.session as object), false);
});

test("a lease that moved while it was being adopted is left where it went", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  if (!db) throw new Error("no db");
  const { adoptTaskLeasesFromEndedSessionsTx } = await import("../db/coordination/lease-adoption.js");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const body = { actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn" };
  const first = (await h.register({ ...body, agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test");
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  await h.evidence.exited(first.session_id, 5);
  // A successor that has adopted the lease already; the lease is then put
  // back, so that the adoption under test finds it to adopt.
  const successor = (await h.register({ ...body, display_name: "Heron", requested_base_display_name: "Heron",
    agent_instance_id: "process-9" })).session;
  await pool!.query("UPDATE task_leases SET agent_session_id = $2, actor_label = $3, epoch = 0 WHERE id = $1",
    [work.lease.id, first.session_id, first.actor_label]);

  // Between reading the lease and writing it, something else advanced it.
  const adopted = await db.transaction(async (tx) => {
    const original = tx.update.bind(tx);
    let advanced = false;
    const racing = Object.assign(Object.create(tx), {
      update: (table: unknown) => {
        const builder = original(table as never);
        if (advanced) return builder;
        advanced = true;
        return { set: (values: unknown) => ({ where: (condition: unknown) => ({ returning: async (fields: unknown) => {
          await pool!.query("UPDATE task_leases SET epoch = epoch + 1 WHERE id = $1", [work.lease.id]);
          return (builder.set(values as never).where(condition as never) as never as {
            returning: (f: unknown) => Promise<unknown[]> }).returning(fields);
        } }) }) };
      },
    });
    return adoptTaskLeasesFromEndedSessionsTx(racing, {
      room_id: h.room.id, agent_key: key, owner_account_id: ownerAccount.id,
      successor: { session_id: successor.session_id, agent_instance_id: "process-9",
        actor_label: successor.actor_label, display_name: successor.display_name, process_host_id: "host_a" },
      now: new Date().toISOString(),
    });
  });
  assert.deepEqual(adopted, []);
  assert.deepEqual(await leases.held(work.lease.id), {
    agent_session_id: first.session_id, agent_key: key, actor_label: first.actor_label, epoch: 1, status: "active",
  });
});

test("a supervised worker adopts nothing: its leases move on its supervisor's word", takeoverTest, async () => {
  const h = await takeoverHarness();
  const leases = await leaseHarness(h);
  if (!createFencedRoomAgentSession) throw new Error("no db");
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const first = (await h.register({ actor_key: key, display_name: "MossDawn", requested_base_display_name: "MossDawn",
    agent_instance_id: "process-1" })).session;
  const work = await leases.give(first, "Fix the flaky test");
  await h.evidence.exited(first.session_id, 5);
  await endRoomAgentSession!({ room_id: h.room.id, session_id: first.session_id });
  await h.evidence.exited(first.session_id, 5);
  await pool!.query("ALTER TABLE room_agent_sessions DISABLE TRIGGER ALL");
  try {
    const created = await createFencedRoomAgentSession({
      room_id: h.room.id, session_kind: "worker", runtime: "codex", agent_key: key, agent_instance_id: "daemon:process-2",
      display_name: "MossDawn", assigned_base_display_name: "MossDawn",
      actor_label: buildAgentActorLabel({ display_name: "MossDawn", owner_label: "EmmyMay", ide_label: "Agent" }),
      owner_account_id: ownerAccount.id, owner_label: "EmmyMay", ide_label: "Agent", process_host_id: "host_a",
      supervisor_grant_id: "grant_test",
    }, null, []);
    assert.deepEqual(created.adopted_task_leases, []);
  } finally {
    await pool!.query("ALTER TABLE room_agent_sessions ENABLE TRIGGER ALL");
  }
  assert.equal((await leases.held(work.lease.id)).agent_session_id, first.session_id);
});

test("a durable worker reaches for the name it first asked for, and stays as it is if it cannot have it", takeoverTest, async () => {
  const h = await takeoverHarness();
  if (!dbModule) throw new Error("no db");
  const common = { display_name: "Atlas", requested_base_display_name: "Atlas" };
  const one = h.worker("a");
  const two = h.worker("b");
  const holder = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-one"),
    agent_instance_id: one.id, connection_token: one.token })).session;
  await h.evidence.quiet(holder.session_id, 1);
  // It asked for "Atlas" and was given another name, because Atlas was held.
  const second = (await h.register({ ...common, actor_key: await h.addIdentity("EmmyMay/worker-two"),
    agent_instance_id: two.id, connection_token: two.token })).session;
  assert.notEqual(second.display_name, "Atlas");
  const reconnect = (proof: CreatedSession, token: string) => h.register({ ...common, actor_key: second.agent_key,
    agent_instance_id: two.id, connection_token: token,
    replace_agent_session_id: proof.session_id, replace_agent_session_token: proof.session_token });

  // The holder is still live, and its process is gone: the worker takes the
  // name, and the holder is ended.
  await h.evidence.closed(holder.session_id, 3600);
  const held = await pool!.connect();
  let kept: CreatedSession;
  try {
    // First, a holder that comes back before the registration runs.
    await held.query("BEGIN");
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcp_worker_names:${h.room.id}`]);
    const registering = reconnect(second, "c".repeat(43));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(await dbModule.openRoomAgentProcessConnection({ session_id: holder.session_id, room_id: h.room.id }));
    await held.query("ROLLBACK");
    const result = await registering;
    assert.equal(result.status, 201, JSON.stringify(result.session));
    assert.equal(result.session.display_name, second.display_name, "it stays as it is, not moved to a third name");
    kept = result.session;
  } finally {
    held.release();
  }
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "Atlas", ended: false });

  // Whatever name it sends now: it is the one it first asked for that it
  // reaches for, and the holder of that one that is released.
  await h.evidence.closed(holder.session_id, 3600);
  const taken = await h.register({ display_name: "Borrowed", requested_base_display_name: "Borrowed",
    actor_key: second.agent_key, agent_instance_id: two.id, connection_token: "d".repeat(43),
    replace_agent_session_id: kept.session_id, replace_agent_session_token: kept.session_token });
  assert.equal(taken.status, 201, JSON.stringify(taken.session));
  assert.equal(taken.session.display_name, "Atlas");
  assert.equal(taken.session.session_id, second.session_id);
  assert.deepEqual(await h.stored(holder.session_id), { display_name: "Atlas", ended: true });
});

test("a name that is no name of its own is not waited for", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  // "Agent" is what a client sends when it has no name: the room gives it a
  // codename, and there is nothing of its own for it to wait to come free.
  const first = (await h.register({ actor_key: key, display_name: "Agent", agent_instance_id: "process-1" }, "host_a")).session;
  await h.evidence.closed(first.session_id, 13);
  const started = Date.now();
  const second = await h.register({ actor_key: key, display_name: "Agent", agent_instance_id: "process-2" }, "host_a");
  assert.equal(second.status, 201, JSON.stringify(second.session));
  assert.ok(Date.now() - started < 1_000);
});

test("only the session's own agent, on its owner's account, is told that it ended", takeoverTest, async () => {
  const h = await takeoverHarness();
  const key = await h.addIdentity("EmmyMay/mossdawn");
  const session = (await h.register({ actor_key: key, display_name: "MossDawn", agent_instance_id: "process-1" })).session;
  await endRoomAgentSession!({ room_id: h.room.id, session_id: session.session_id });
  const send = (extra: Record<string, unknown>) => invoke(h.handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
    { ...ownerTokenRequest({ text: "still here", ...sessionCredentials(session) }, { params: { 0: h.room.id } }), ...extra });

  assert.deepEqual((await send({})).body, { error: AGENT_SESSION_ENDED_ADVICE });
  // A bearer speaks for one session. A request made with one is not the
  // owner asking after a session, and learns nothing about this one.
  const bearer = await send({ authKind: "agent_session", agentSession: null });
  assert.equal(bearer.statusCode, 401);
  assert.notDeepEqual(bearer.body, { error: AGENT_SESSION_ENDED_ADVICE });
  // The same holds wherever the refusal is worded, as on the message poll.
  const { describeRefusedAgentSession } = await import("../request/agent-identity.js");
  const describe = (req: Record<string, unknown>) => describeRefusedAgentSession({
    req: req as never, agent_session_id: session.session_id, agent_session_token: session.session_token, room_id: h.room.id,
  });
  assert.equal(await describe(ownerTokenRequest({})), AGENT_SESSION_ENDED_ADVICE);
  assert.equal(await describe({ ...ownerTokenRequest({}), authKind: "agent_session" }), "Invalid agent session credentials.");
  assert.equal(await describe({ ...ownerTokenRequest({}), authKind: "session" }), "Invalid agent session credentials.");
});

test(
  "a mention that names two live agents tells the sender it reached neither",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!db || !agents || !createRoomAgentSession || !dbModule) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { room, worker } = await seedHarness();
    const now = new Date().toISOString();
    const twin = {
      ...agentIdentity,
      id: "agent_worker_session_twin",
      canonical_key: "EmmyMay/desktop-claude-twin",
      name: "desktop-claude-twin",
    };
    await db.insert(agents).values({ ...twin, created_at: now, updated_at: now });
    await createRoomAgentSession({
      room_id: room.id,
      runtime: "claude-code",
      session_kind: "worker",
      agent_key: twin.canonical_key,
      agent_instance_id: "worker-session-twin-instance",
      owner_account_id: ownerAccount.id,
      owner_label: twin.owner_label,
      ide_label: "Claude Code",
      display_name: "OwlSolar",
      actor_label: buildAgentActorLabel({
        display_name: "OwlSolar",
        owner_label: twin.owner_label,
        ide_label: "Claude Code",
      }),
    });

    const ambiguous = await dbModule.addMessageWithCreateStatus(room.id, "Human", "@OwlSolar please investigate this");
    assert.deepEqual([...ambiguous.recipientAgentKeys], [], "an ambiguous mention wakes nobody");
    assert.equal(ambiguous.message.mention_notices?.length, 1);
    const [notice] = ambiguous.message.mention_notices!;
    assert.equal(notice!.reason, "ambiguous");
    assert.equal(notice!.handle, "OwlSolar");
    assert.deepEqual(
      notice!.candidates.map((candidate) => candidate.mention).sort(),
      [`@agent:${twin.canonical_key}`, `@agent:${worker.agent_key}`].sort(),
    );
    assert.equal(
      ambiguous.canonical_message.mention_notices,
      undefined,
      "the notice is for the sender, never part of the shared message",
    );

    // The mention the notice offers reaches exactly the agent it names.
    const exact = await dbModule.addMessageWithCreateStatus(
      room.id,
      "Human",
      `@agent:${twin.canonical_key} please investigate this`,
    );
    assert.deepEqual([...exact.recipientAgentKeys], [twin.canonical_key]);
    assert.equal(exact.message.mention_notices, undefined);
  },
);

// ---------------------------------------------------------------------------
// One agent, several live sessions: which session is asked?
// ---------------------------------------------------------------------------
async function restartedAgentHarness(leftLastSeen = "1 hour") {
  if (!addMessage || !createRoomAgentSession || !pool || !markRoomAgentDeliveryConnected) {
    throw new Error("DB-backed worker session tests require TEST_DB_URL");
  }
  const { room, worker } = await seedHarness();
  const handlers = registerRoutesForRoom(room);
  // The process restarted. Nothing ended the session it left behind, so the
  // agent now has two live sessions under one key, the older one dead.
  await pool.query(
    `UPDATE room_agent_sessions SET last_seen_at = NOW() - INTERVAL '${leftLastSeen}', created_at = NOW() - INTERVAL '2 hours' WHERE session_id = $1`,
    [worker.session_id],
  );
  const restarted = await createRoomAgentSession({
    room_id: room.id, runtime: "codex", session_kind: "worker", agent_key: worker.agent_key,
    agent_instance_id: "worker-session-test-instance-restarted", owner_account_id: ownerAccount.id,
    owner_label: agentIdentity.owner_label, ide_label: "Codex", display_name: "OwlSolarAgain",
    actor_label: buildAgentActorLabel({ display_name: "OwlSolarAgain", owner_label: agentIdentity.owner_label, ide_label: "Codex" }),
  });
  const connect = (session: CreatedSession) => markRoomAgentDeliveryConnected!({
    room_id: room.id, actor_label: session.actor_label, agent_key: session.agent_key,
    agent_instance_id: session.agent_instance_id, agent_session_id: session.session_id,
    session_kind: "worker", runtime: "codex", display_name: session.display_name,
    owner_label: "EmmyMay", ide_label: "Codex", transport: "long_poll",
    credential_fence: { kind: "session_token", token_hash: hashToken(session.session_token) },
  });
  const say = (session: CreatedSession, text: string) => addMessage!(room.id, session.actor_label, text, {
    source: "agent", publisher_agent_key: session.agent_key, publisher_agent_session_id: session.session_id,
    account_id: ownerAccount.id,
  });
  const receipts = async () => (await pool!.query(
    "SELECT agent_session_id, activation_reason FROM message_agent_receipts WHERE message_room_id = $1 ORDER BY message_number",
    [room.id],
  )).rows as Array<{ agent_session_id: string; activation_reason: string }>;
  const decisions = async (session: CreatedSession) => {
    const response = await invoke(
      handlers.get.get("/^\\/rooms\\/(.+)\\/messages\\/poll$/"),
      requestWithDeliveryHeaders(session, { params: { 0: room.id }, query: { timeout: "1000" } }),
    );
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    return ((response.body as { messages?: Array<{ text?: string; activation?: { for_current_agent?: { decision?: string; reason?: string } } }> }).messages ?? [])
      .map((message) => `${message.activation?.for_current_agent?.decision}:${message.activation?.for_current_agent?.reason}`);
  };
  return { room, left: worker, restarted: restarted as CreatedSession, connect, say, receipts, decisions };
}

const answeringTest = {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
};

test("a restarted agent receives the messages addressed to it, not the session it left behind", answeringTest, async () => {
  const h = await restartedAgentHarness();
  await addMessage!(h.room.id, "Human", "@OwlSolarAgain please investigate this");
  await addMessage!(h.room.id, "Human", "@everyone please confirm receipt");
  assert.deepEqual(await h.receipts(), [
    { agent_session_id: h.restarted.session_id, activation_reason: "explicit_mention" },
    { agent_session_id: h.restarted.session_id, activation_reason: "broadcast" },
  ], "the agent is asked once, through the session that is there to answer");
  assert.deepEqual(await h.decisions(h.restarted), ["activate:explicit_mention", "activate:broadcast"]);
});

test("a process that died a moment ago does not take the messages meant for its replacement", answeringTest, async () => {
  const h = await restartedAgentHarness("20 seconds");
  if (!dbModule) throw new Error("no db");
  // The old process was connected until it died. Its closing connection
  // marks the session seen and leaves it within its reconnect grace, while
  // its replacement has registered and not polled yet.
  await h.connect(h.left);
  await dbModule.markRoomAgentDeliveryDisconnected({
    room_id: h.room.id, actor_label: h.left.actor_label, agent_session_id: h.left.session_id,
    credential_fence: { kind: "session_token", token_hash: hashToken(h.left.session_token) },
  });
  await addMessage!(h.room.id, "Human", "@everyone please confirm receipt");
  assert.deepEqual(await h.receipts(), [{ agent_session_id: h.restarted.session_id, activation_reason: "broadcast" }]);
});

test("a reply to what the agent said before it restarted reaches the restarted agent", answeringTest, async () => {
  // Five minutes: long before anything would call the old session stale.
  const h = await restartedAgentHarness("5 minutes");
  const said = await h.say(h.left, "I will look into it.");
  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = NOW() - INTERVAL '5 minutes' WHERE session_id = $1", [h.left.session_id]);
  await addMessage!(h.room.id, "Human", "Thanks, any update?", { reply_to_message_id: said.id });
  assert.deepEqual(await h.receipts(), [{ agent_session_id: h.restarted.session_id, activation_reason: "reply_target" }]);
});

test("two chats that share an identity: the connected one answers, and each keeps the replies to what it said", answeringTest, async () => {
  const h = await restartedAgentHarness("20 seconds");
  // Not a restart after all: the older chat is alive and holding a
  // connection open, and the newer one was merely seen more recently.
  await h.connect(h.left);
  await addMessage!(h.room.id, "Human", "@everyone please confirm receipt");

  // The newer chat says something, then goes quiet for a long time while it
  // works. The reply is still its own: its sibling was running all along, so
  // it is another chat and not a restart.
  const said = await h.say(h.restarted, "I will look into it.");
  await pool!.query("UPDATE room_agent_sessions SET last_seen_at = NOW() - INTERVAL '45 minutes' WHERE session_id = $1", [h.restarted.session_id]);
  await addMessage!(h.room.id, "Human", "Thanks, any update?", { reply_to_message_id: said.id });

  assert.deepEqual(await h.receipts(), [
    { agent_session_id: h.left.session_id, activation_reason: "broadcast" },
    { agent_session_id: h.restarted.session_id, activation_reason: "reply_target" },
  ]);
});

test("a follow-up on a task stays with the session that holds its lease", answeringTest, async () => {
  const h = await restartedAgentHarness();
  if (!createTask || !createTaskLease || !updateTask) throw new Error("no db");
  await h.connect(h.restarted);
  const task = await createTask(h.room.id, "Investigate the failure", "Human");
  await updateTask(h.room.id, task.id, { status: "accepted" });
  await updateTask(h.room.id, task.id, { status: "assigned", assignee: h.left.actor_label });
  await createTaskLease({ room_id: h.room.id, task_id: task.id, kind: "work", agent_key: h.left.agent_key,
    agent_session_id: h.left.session_id, actor_label: h.left.actor_label, created_by: "answering_session_test" });
  await addMessage!(h.room.id, "Human", "continue");
  // Only the lease holder may act on the task, so a sibling told it owns the
  // task could do nothing with it.
  assert.deepEqual(await h.receipts(), [{ agent_session_id: h.left.session_id, activation_reason: "task_owner" }]);
});

test(
  "worker-authenticated message polls attach activation metadata for direct and broadcast delivery",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    if (!addMessage) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }
    const { room, worker } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    await addMessage(room.id, "Human", "@OwlSolar please investigate this");
    await addMessage(room.id, "Human", "@everyone please confirm receipt");

    const response = await invoke(
      handlers.get.get("/^\\/rooms\\/(.+)\\/messages\\/poll$/"),
      requestWithDeliveryHeaders(worker, {
        params: { 0: room.id },
        query: { timeout: "1000" },
      }),
    );

    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    const messages = (response.body as {
      messages?: Array<{ text?: string; activation?: { for_current_agent?: { decision?: string; reason?: string } } }>;
    }).messages ?? [];
    assert.deepEqual(
      messages.map((message) => message.activation?.for_current_agent),
      [
        { decision: "activate", reason: "explicit_mention", addressed: true },
        { decision: "activate", reason: "broadcast", addressed: true },
      ],
    );
  },
);

test(
  "a re-registering agent instance resumes its previous display name",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    const { endRoomAgentSession } = dbModule!;

    const registrationBody = {
      actor_key: agentIdentity.canonical_key,
      display_name: "MistyMorrow",
      ide_label: "Agent",
      agent_instance_id: "burst-instance-1",
      session_kind: "worker",
      runtime: "claude-code",
    };

    const first = await invoke(
      registerHandler,
      ownerTokenRequest(registrationBody, { params: { 0: room.id } })
    );
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    const firstSession = first.body as { session_id?: string; display_name?: string };
    assert.equal(firstSession.display_name, "MistyMorrow");

    // Clean end, then the SAME instance re-registers: it must resume its
    // name instead of minting "MistyMorrow 1" (the persistent participant
    // record used to keep the old name occupied forever).
    await endRoomAgentSession!({ session_id: firstSession.session_id! });
    const second = await invoke(
      registerHandler,
      ownerTokenRequest(registrationBody, { params: { 0: room.id } })
    );
    assert.equal(second.statusCode, 201, JSON.stringify(second.body));
    const secondSession = second.body as { session_id?: string; display_name?: string };
    assert.equal(
      secondSession.display_name,
      "MistyMorrow",
      "the same instance resumes its prior name after a clean end"
    );
    assert.notEqual(secondSession.session_id, firstSession.session_id);

    // A daemon restart may use a new runtime instance id and may replay the
    // server-assigned, already-decorated label from an older collision. An
    // updated client sends its stable base as `requested_base_display_name`;
    // the server reduces the compounded label to that trusted base only —
    // never by guessing from numeric shape — so the suffix cannot compound.
    await endRoomAgentSession!({ session_id: secondSession.session_id! });
    const restarted = await invoke(
      registerHandler,
      ownerTokenRequest(
        {
          ...registrationBody,
          agent_instance_id: "burst-instance-after-restart",
          display_name: "MistyMorrow 2 1 1 1",
          requested_base_display_name: "MistyMorrow",
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(restarted.statusCode, 201, JSON.stringify(restarted.body));
    const restartedSession = restarted.body as { session_id?: string; display_name?: string };
    assert.equal(
      restartedSession.display_name,
      "MistyMorrow",
      "restart with a trusted base signal converges the compounded label to the base"
    );

    // A DIFFERENT instance while the name is actively held receives its own
    // codename, never a numbered variant of the held name.
    const third = await invoke(
      registerHandler,
      ownerTokenRequest(
        { ...registrationBody, agent_instance_id: "burst-instance-2" },
        { params: { 0: room.id } }
      )
    );
    assert.equal(third.statusCode, 201, JSON.stringify(third.body));
    const thirdSession = third.body as { display_name?: string };
    assert.notEqual(thirdSession.display_name, "MistyMorrow");
    assert.equal(
      thirdSession.display_name,
      pickLocalCodename(`${agentIdentity.canonical_key}:1`).display_name
    );
    assert.match(thirdSession.display_name ?? "", /^[A-Za-z]+$/, "a collision name is one mentionable word");

    // If the base holder ends while a renamed sibling remains active, the
    // base is free. A restarted worker must reclaim it instead of treating
    // the sibling as proof that the base itself is occupied.
    await endRoomAgentSession!({ session_id: restartedSession.session_id! });
    const overlapRestart = await invoke(
      registerHandler,
      ownerTokenRequest(
        {
          ...registrationBody,
          agent_instance_id: "burst-instance-overlap-restart",
          display_name: "MistyMorrow 2 1 1",
          requested_base_display_name: "MistyMorrow",
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(overlapRestart.statusCode, 201, JSON.stringify(overlapRestart.body));
    const overlapRestartSession = overlapRestart.body as { session_id?: string; display_name?: string };
    assert.equal(overlapRestartSession.display_name, "MistyMorrow");

    // An explicit DIFFERENT name is a deliberate rename: resumption must not
    // overwrite it.
    await endRoomAgentSession!({ session_id: overlapRestartSession.session_id! });
    const renamed = await invoke(
      registerHandler,
      ownerTokenRequest(
        { ...registrationBody, display_name: "MorningGlory" },
        { params: { 0: room.id } }
      )
    );
    assert.equal(renamed.statusCode, 201, JSON.stringify(renamed.body));
    const renamedSession = renamed.body as { session_id?: string; display_name?: string };
    assert.equal(
      renamedSession.display_name,
      "MorningGlory",
      "an explicit new name wins over resuming the old one"
    );

    // And an explicit request for the SAME prior name resumes it cleanly.
    await endRoomAgentSession!({ session_id: renamedSession.session_id! });
    const explicitSame = await invoke(
      registerHandler,
      ownerTokenRequest(
        { ...registrationBody, display_name: "MorningGlory" },
        { params: { 0: room.id } }
      )
    );
    assert.equal(explicitSame.statusCode, 201, JSON.stringify(explicitSame.body));
    assert.equal(
      (explicitSame.body as { display_name?: string }).display_name,
      "MorningGlory",
      "an explicit same-name request resumes without numbering"
    );

    // A first-ever DELIBERATE numeric-ending rename, declared as its own base,
    // is preserved even though the identity currently holds bare "MorningGlory"
    // — the server never treats a client-declared base as a collision suffix.
    const deliberateRename = await invoke(
      registerHandler,
      ownerTokenRequest(
        {
          ...registrationBody,
          agent_instance_id: "burst-instance-deliberate-47",
          display_name: "MorningGlory 47",
          requested_base_display_name: "MorningGlory 47",
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(deliberateRename.statusCode, 201, JSON.stringify(deliberateRename.body));
    assert.equal(
      (deliberateRename.body as { display_name?: string }).display_name,
      "MorningGlory 47",
      "a deliberate numeric-ending rename declared as its own base is not demoted to the bare base"
    );

    // A decorated replay WITHOUT a trusted base signal fails closed: the label
    // is preserved verbatim, never guessed back to a base from numeric shape.
    const noSignalReplay = await invoke(
      registerHandler,
      ownerTokenRequest(
        {
          ...registrationBody,
          agent_instance_id: "burst-instance-no-signal",
          display_name: "MorningGlory 9 9",
        },
        { params: { 0: room.id } }
      )
    );
    assert.equal(noSignalReplay.statusCode, 201, JSON.stringify(noSignalReplay.body));
    assert.equal(
      (noSignalReplay.body as { display_name?: string }).display_name,
      "MorningGlory 9 9",
      "no trusted signal -> preserve the requested label (fail closed, no shape inference)"
    );
  }
);

test(
  "same-instance registration rotates with exact prior credentials or stale expiry",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed worker session auth tests" : false,
  },
  async () => {
    const { room } = await seedHarness();
    const handlers = registerRoutesForRoom(room);
    const registerHandler = handlers.post.get("/^\\/rooms\\/(.+)\\/agent-sessions$/");
    if (!markRoomAgentDeliveryConnected || !getRoomAgentDeliverySessions || !pool || !createTask || !createTaskLease || !updateTask || !addMessage) {
      throw new Error("DB-backed worker session tests require TEST_DB_URL");
    }

    const registrationBody = {
      actor_key: agentIdentity.canonical_key,
      display_name: "SwiftCrest",
      requested_base_display_name: "SwiftCrest",
      ide_label: "Agent",
      agent_instance_id: "same-instance-reconnect",
      session_kind: "worker",
      runtime: "codex",
      registration_liveness: {
        host_id: "host_swiftcrest",
        liveness_capability: "codex_app_server_runtime_stream",
        tool_bridge_id: "bridge_swiftcrest",
      },
    };

    const first = await invoke(
      registerHandler,
      ownerTokenRequest(registrationBody, { params: { 0: room.id } })
    );
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    const firstSession = first.body as CreatedSession;
    assert.equal(firstSession.display_name, "SwiftCrest");
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: firstSession.actor_label,
      agent_key: firstSession.agent_key,
      agent_instance_id: firstSession.agent_instance_id,
      agent_session_id: firstSession.session_id,
      session_kind: "worker",
      runtime: "codex",
      display_name: firstSession.display_name,
      owner_label: agentIdentity.owner_label,
      ide_label: "Agent",
      credential_fence: { kind: "session_token", token_hash: hashToken(firstSession.session_token) },
      transport: "long_poll",
    });
    const firstPresence = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/presence$/"),
      ownerTokenRequest({
        status: "working",
        status_text: "first SwiftCrest transport",
        ...sessionCredentials(firstSession),
      }, { params: { 0: room.id } }),
    );
    assert.equal(firstPresence.statusCode, 200, JSON.stringify(firstPresence.body));
    const proposedContinuityTask = await createTask(room.id, "SwiftCrest continuity", "Human");
    const continuityTask = await updateTask(room.id, proposedContinuityTask.id, { status: "accepted" });
    assert.ok(continuityTask);
    const assignedContinuityTask = await invoke(
      handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
      ownerTokenRequest({
        status: "assigned",
        assignee: firstSession.actor_label,
        ...sessionCredentials(firstSession),
      }, { params: { 0: room.id, 1: continuityTask.id }, query: {} }),
    );
    assert.equal(assignedContinuityTask.statusCode, 200, JSON.stringify(assignedContinuityTask.body));
    await createTaskLease({
      room_id: room.id,
      task_id: continuityTask.id,
      kind: "work",
      agent_key: firstSession.agent_key,
      agent_session_id: firstSession.session_id,
      actor_label: firstSession.actor_label,
      created_by: "task_85_test",
    });
    const assignmentNow = new Date().toISOString();
    await pool.query(
      `INSERT INTO board_manager_assignments
        (id, room_id, agent_session_id, agent_key, actor_label, runtime_source,
         assigned_by, status, last_heartbeat_at, released_by, release_reason,
         released_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'external', 'task_85_test', 'active',
         $6, NULL, NULL, NULL, $6, $6)`,
      [
        "board_manager_task85_continuity",
        room.id,
        firstSession.session_id,
        firstSession.agent_key,
        firstSession.actor_label,
        assignmentNow,
      ],
    );
    const baselineMessage = await addMessage(room.id, "Human", "task_85 pending-poll baseline");
    const predecessorPollHandler = handlers.get.get("/^\\/rooms\\/(.+)\\/messages\\/poll$/");
    assert.ok(predecessorPollHandler, "expected long-poll route handler to be registered");
    const predecessorPollRecorder = createPendingResponseRecorder();
    await predecessorPollHandler(
      requestWithDeliveryHeaders(firstSession, {
        params: { 0: room.id },
        query: { after: baselineMessage.id, timeout: "5000" },
      }),
      predecessorPollRecorder.response,
    );
    const pollBeforeRotation = await Promise.race([
      predecessorPollRecorder.settled.then(() => "settled" as const),
      sleep(50).then(() => "pending" as const),
    ]);
    assert.equal(pollBeforeRotation, "pending", "predecessor poll is live before rotation");

    // The exact prior credential is the reconnect proof. It rotates behind
    // the instance fence and keeps the base display name.
    const resumed = await invoke(
      registerHandler,
      ownerTokenRequest({
        ...registrationBody,
        replace_agent_session_id: firstSession.session_id,
        replace_agent_session_token: firstSession.session_token,
      }, { params: { 0: room.id } })
    );
    assert.equal(resumed.statusCode, 201, JSON.stringify(resumed.body));
    const resumedSession = resumed.body as CreatedSession;
    assert.equal(resumedSession.display_name, "SwiftCrest");
    assert.equal(
      resumedSession.session_id,
      firstSession.session_id,
      "credential rotation preserves every session-bound authority reference",
    );
    assert.notEqual(resumedSession.session_token, firstSession.session_token);
    const disconnectedPredecessorPoll = await Promise.race([
      predecessorPollRecorder.settled,
      sleep(1_000).then(() => null),
    ]);
    assert.ok(disconnectedPredecessorPoll, "rotation wakes the already-authenticated predecessor poll");
    assert.equal(disconnectedPredecessorPoll.statusCode, 200);
    assert.deepEqual(
      (disconnectedPredecessorPoll.body as { messages?: unknown[] }).messages,
      [],
      "the predecessor transport closes without consuming a successor message",
    );

    const afterResume = await pool.query<{
      session_id: string;
      ended_at: string | null;
    }>(
      `SELECT session_id, ended_at
         FROM room_agent_sessions
        WHERE room_id = $1 AND agent_key = $2 AND agent_instance_id = $3
        ORDER BY created_at`,
      [room.id, agentIdentity.canonical_key, registrationBody.agent_instance_id],
    );
    assert.equal(afterResume.rows.length, 1);
    assert.equal(afterResume.rows[0]?.session_id, firstSession.session_id);
    assert.equal(afterResume.rows[0]?.ended_at, null);
    assert.equal(afterResume.rows.filter((row) => row.ended_at === null).length, 1);
    const deliveries = await getRoomAgentDeliverySessions(room.id);
    assert.equal(
      deliveries.find((delivery) => delivery.agent_session_id === firstSession.session_id)?.active_connection_count,
      0,
      "the replaced session cannot keep a duplicate delivery channel",
    );
    const resumedPresence = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/presence$/"),
      ownerTokenRequest({
        status: "working",
        status_text: "resumed SwiftCrest transport",
        ...sessionCredentials(resumedSession),
      }, { params: { 0: room.id } }),
    );
    assert.equal(resumedPresence.statusCode, 200, JSON.stringify(resumedPresence.body));
    assert.equal(
      (resumedPresence.body as { agent_session_id?: string }).agent_session_id,
      resumedSession.session_id,
      "the replacement owns the single current presence projection",
    );
    const rejectedPredecessorWrite = await invoke(
      handlers.post.get("/^\\/rooms\\/(.+)\\/messages$/"),
      ownerTokenRequest({
        text: "old SwiftCrest credential must be fenced",
        ...sessionCredentials(firstSession),
      }, { params: { 0: room.id } }),
    );
    assert.equal(rejectedPredecessorWrite.statusCode, 401, JSON.stringify(rejectedPredecessorWrite.body));
    const resumedTaskUpdate = await invoke(
      handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/"),
      ownerTokenRequest({
        status: "in_progress",
        ...sessionCredentials(resumedSession),
      }, { params: { 0: room.id, 1: continuityTask.id }, query: {} }),
    );
    assert.equal(resumedTaskUpdate.statusCode, 200, JSON.stringify(resumedTaskUpdate.body));
    assert.equal((resumedTaskUpdate.body as { status?: string }).status, "in_progress");
    const continuityAuthority = await pool.query<{
      active_leases: string;
      lease_session_id: string | null;
      manager_session_id: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM task_leases WHERE task_id = $1 AND status = 'active') AS active_leases,
         (SELECT agent_session_id FROM task_leases WHERE task_id = $1 AND status = 'active' LIMIT 1) AS lease_session_id,
         (SELECT agent_session_id FROM board_manager_assignments WHERE room_id = $2 AND status = 'active' LIMIT 1) AS manager_session_id`,
      [continuityTask.id, room.id],
    );
    assert.deepEqual(continuityAuthority.rows[0], {
      active_leases: "1",
      lease_session_id: resumedSession.session_id,
      manager_session_id: resumedSession.session_id,
    });

    // A separate live transport cannot steal the instance with a public
    // session id and a forged credential, even if it copies the bridge label.
    const foreignFresh = await invoke(
      registerHandler,
      ownerTokenRequest({
        ...registrationBody,
        replace_agent_session_id: resumedSession.session_id,
        replace_agent_session_token: "forged-session-secret",
      }, { params: { 0: room.id } })
    );
    assert.equal(foreignFresh.statusCode, 409, JSON.stringify(foreignFresh.body));
    assert.equal(
      (foreignFresh.body as { code?: string }).code,
      "agent_instance_already_active",
    );
    const currentAfterConflict = await pool.query<{ ended_at: string | null }>(
      "SELECT ended_at FROM room_agent_sessions WHERE session_id = $1",
      [resumedSession.session_id],
    );
    assert.equal(currentAfterConflict.rows[0]?.ended_at, null);

    const partialProof = await invoke(
      registerHandler,
      ownerTokenRequest({
        ...registrationBody,
        replace_agent_session_id: resumedSession.session_id,
      }, { params: { 0: room.id } })
    );
    assert.equal(partialProof.statusCode, 400, JSON.stringify(partialProof.body));
    assert.equal(
      (partialProof.body as { code?: string }).code,
      "invalid_agent_session_replacement_proof",
    );

    // Once heartbeat freshness expires, a successor without the old secret
    // may reclaim the crashed instance. This covers missed disconnect/restart
    // recovery without weakening the fresh-session fence.
    await pool.query(
      "UPDATE room_agent_sessions SET last_seen_at = NOW() - INTERVAL '3 minutes' WHERE session_id = $1",
      [resumedSession.session_id],
    );
    const staleReplacement = await invoke(
      registerHandler,
      ownerTokenRequest({
        ...registrationBody,
        registration_liveness: {
          ...registrationBody.registration_liveness,
          tool_bridge_id: "bridge_successor_after_crash",
        },
      }, { params: { 0: room.id } })
    );
    assert.equal(staleReplacement.statusCode, 201, JSON.stringify(staleReplacement.body));
    assert.equal((staleReplacement.body as CreatedSession).display_name, "SwiftCrest");

    // Simultaneous first registration from two distinct transports is
    // serialized by the instance fence: exactly one wins and one fails.
    const concurrentBase = {
      ...registrationBody,
      display_name: "CedarRun",
      requested_base_display_name: "CedarRun",
      agent_instance_id: "concurrent-same-instance",
    };
    const concurrentResults = await Promise.all([
      invoke(registerHandler, ownerTokenRequest({
        ...concurrentBase,
        registration_liveness: {
          ...registrationBody.registration_liveness,
          tool_bridge_id: "bridge_concurrent_a",
        },
      }, { params: { 0: room.id } })),
      invoke(registerHandler, ownerTokenRequest({
        ...concurrentBase,
        registration_liveness: {
          ...registrationBody.registration_liveness,
          tool_bridge_id: "bridge_concurrent_b",
        },
      }, { params: { 0: room.id } })),
    ]);
    assert.deepEqual(
      concurrentResults.map((result) => result.statusCode).sort(),
      [201, 409],
    );
    const concurrentActive = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM room_agent_sessions
        WHERE room_id = $1 AND agent_key = $2 AND agent_instance_id = $3 AND ended_at IS NULL`,
      [room.id, agentIdentity.canonical_key, concurrentBase.agent_instance_id],
    );
    assert.equal(concurrentActive.rows[0]?.count, "1");
  }
);
