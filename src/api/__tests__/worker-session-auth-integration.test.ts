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
const { registerRoomMessageRoutes } = await import("../routes/room-messages.js");
const { registerRoomPresenceRoutes } = await import("../routes/room-presence.js");
const { registerRoomReasoningRoutes } = await import("../routes/room-reasoning.js");
const { registerRoomTaskRoutes } = await import("../routes/room-tasks.js");
const { buildAgentActorLabel } = await import("../../shared/agent-identity.js");
const {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} = await import("../../shared/request-headers.js");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const accounts = schemaModule?.accounts;
const agents = schemaModule?.agents;
const addMessage = dbModule?.addMessage;
const createProjectWithName = dbModule?.createProjectWithName;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const createTask = dbModule?.createTask;
const endRoomAgentSession = dbModule?.endRoomAgentSession;
const getRoomAgentDeliverySessions = dbModule?.getRoomAgentDeliverySessions;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
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
    write() {
      return true;
    },
    end() {
      return undefined;
    },
  };
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

function registerRoutesForRoom(room: { id: string }): RouteHandlers {
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

  registerRoomMessageRoutes(app as never, {
    messageEvents,
    taskEvents,
    reasoningEvents,
    resolveCanonicalRoomRequestId,
    resolveRoomOrReply,
    requireParticipant,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: (value) => typeof value === "string" ? value.trim() || null : null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: async (projectId, sender, text, options) => addMessage(projectId, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind,
      reply_to_message_id: options?.reply_to,
      attachments: options?.attachments,
    }),
    rememberRoomParticipantFromMessage: async () => undefined,
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
    enforceTaskCoordinationMutation: async () => ({ kind: "allow" }),
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
      transport: "long_poll",
    });

    const registrationBody = {
      actor_key: worker.agent_key,
      actor_label: worker.actor_label,
      display_name: worker.display_name,
      ide_label: "Antigravity",
      agent_instance_id: "different-antigravity-instance",
      session_kind: "worker",
      runtime: "antigravity",
    };
    const [secondRegistration, thirdRegistration] = await Promise.all([
      invoke(
        registerHandler,
        ownerTokenRequest(registrationBody, { params: { 0: room.id } })
      ),
      invoke(
        registerHandler,
        ownerTokenRequest(registrationBody, { params: { 0: room.id } })
      ),
    ]);

    assert.equal(secondRegistration.statusCode, 201, JSON.stringify(secondRegistration.body));
    const secondSession = secondRegistration.body as {
      session_id?: string;
      session_token?: string;
      display_name?: string;
    };
    assert.ok(secondSession.session_id);
    assert.notEqual(secondSession.session_id, worker.session_id);

    assert.equal(thirdRegistration.statusCode, 201, JSON.stringify(thirdRegistration.body));
    const thirdSession = thirdRegistration.body as {
      session_id?: string;
      session_token?: string;
      display_name?: string;
    };
    assert.ok(thirdSession.session_id);
    assert.notEqual(thirdSession.session_id, worker.session_id);
    assert.notEqual(thirdSession.session_id, secondSession.session_id);
    assert.deepEqual(
      [secondSession.display_name, thirdSession.display_name].sort(),
      ["OwlSolar 1", "OwlSolar 2"]
    );

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
    const expected = { error: "Invalid agent session credentials." };

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
