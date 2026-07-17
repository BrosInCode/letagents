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
const { registerRoomPresenceRoutes } = await import("../routes/rooms/presence/index.js");
const { registerRoomReasoningRoutes } = await import("../routes/rooms/reasoning.js");
const { registerRoomTaskRoutes } = await import("../routes/rooms/tasks/index.js");
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
      repo_branch: "codex/git-rooms",
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

    // A DIFFERENT instance while the name is actively held still gets a
    // numbered variant — the live-collision path is unchanged.
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
    assert.equal(thirdSession.display_name, "MistyMorrow 1");

    // If the base holder ends while a suffixed sibling remains active, the
    // base is free. A restarted worker must reclaim it instead of treating
    // the sibling's suffix as proof that the base itself is occupied.
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
    if (!markRoomAgentDeliveryConnected || !getRoomAgentDeliverySessions || !pool) {
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
    assert.notEqual(resumedSession.session_id, firstSession.session_id);

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
    assert.equal(afterResume.rows.length, 2);
    assert.ok(afterResume.rows.find((row) => row.session_id === firstSession.session_id)?.ended_at);
    assert.equal(afterResume.rows.find((row) => row.session_id === resumedSession.session_id)?.ended_at, null);
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
