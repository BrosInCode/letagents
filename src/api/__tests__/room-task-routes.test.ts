import { isHumanAppWrite } from "../request/app-session.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= process.env.TEST_DB_URL || "postgresql://test:test@127.0.0.1:1/test";
const {
  getTaskBoardStalePromptState,
  isCurrentStalePromptAction,
  registerRoomTaskRoutes,
} = await import("../routes/rooms/tasks/index.js");
const { normalizeExpectedHeadSha } = await import("../routes/rooms/tasks/review-verdict.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    taskEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    requireParticipant: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
    normalizeOptionalString: () => null,
    enforceTaskAdmissionCoordination: unused,
    isTrustedAgentCreator: unused,
    emitTaskLifecycleStatusMessage: unused,
    validateOwnerTokenTaskActorKey: unused,
    enforceTaskCoordinationMutation: unused,
    enforceFocusParentBoardWriteIsolation: unused,
    emitProjectMessage: unused,
  };
}

function createRouteApp() {
  const handlers = {
    get: new Map<string, (req: unknown, res: unknown) => Promise<void>>(),
    post: new Map<string, (req: unknown, res: unknown) => Promise<void>>(),
    patch: new Map<string, (req: unknown, res: unknown) => Promise<void>>(),
    delete: new Map<string, (req: unknown, res: unknown) => Promise<void>>(),
  };
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.get.set(path.toString(), handler);
    },
    patch(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.patch.set(path.toString(), handler);
    },
    delete(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.delete.set(path.toString(), handler);
    },
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
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
  };
}

test("registerRoomTaskRoutes preserves canonical task route order", () => {
  const calls: Array<{ method: "delete" | "get" | "patch" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
    delete(path: RegExp) {
      calls.push({ method: "delete", path: path.toString() });
    },
  };

  registerRoomTaskRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/tasks$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/focus-room$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/stale-prompt-mute$/" },
    { method: "delete", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/stale-prompt-mute$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/lease-action$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/review-lease-action$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/review-verdict$/" },
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/tasks\\/github-status$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
  ]);
});

test("review verdict route accepts only an exact 40-hex expected head SHA", () => {
  const expected = "a".repeat(40);
  assert.equal(normalizeExpectedHeadSha(expected.toUpperCase()), expected);
  for (const value of [undefined, "", "a".repeat(39), "a".repeat(41), `${"a".repeat(39)}g`, "HEAD"]) {
    assert.equal(normalizeExpectedHeadSha(value), null);
  }
});

test("review lease action denies parent board writes from hard-isolated Focus Rooms", async () => {
  const { app, handlers } = createRouteApp();
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({
      kind: "deny" as const,
      code: "focus_parent_board_read_only" as const,
      error: "blocked by focus settings",
    }),
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/review-lease-action$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "task_153" },
      body: { action: "assign" },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "blocked by focus settings",
    code: "focus_parent_board_read_only",
  });
});

test("room task creation denies parent board writes from hard-isolated Focus Rooms", async () => {
  const { app, handlers } = createRouteApp();
  let admissionCalled = false;
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({
      kind: "deny" as const,
      code: "focus_parent_board_read_only" as const,
      error: "blocked by focus settings",
    }),
    enforceTaskAdmissionCoordination: async () => {
      admissionCalled = true;
      return { kind: "allow" as const };
    },
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/tasks$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents" },
      body: { title: "Keep work isolated", created_by: "DawnWinter" },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "blocked by focus settings",
    code: "focus_parent_board_read_only",
  });
  assert.equal(admissionCalled, false);
});

test("owner-token task creation requires a registered worker session", async () => {
  const { app, handlers } = createRouteApp();
  let admissionCalled = false;
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" as const }),
    enforceTaskAdmissionCoordination: async () => {
      admissionCalled = true;
      return { kind: "allow" as const };
    },
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/tasks$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents" },
      body: { title: "Close presence gap", created_by: "FakeAgent" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Registered worker session is required for agent write actions.",
  });
  assert.equal(admissionCalled, false);
});

test("human task authority requires an app session, never a client marker", () => {
  assert.equal(isHumanAppWrite({ authKind: "session", sessionAccount: { account_id: "acct_1" } } as never, {}), true);
  for (const authKind of ["owner_token", "agent_session", null]) {
    assert.equal(isHumanAppWrite({ authKind, sessionAccount: { account_id: "acct_1" }, headers: { "x-letagents-desktop-client": "1" } } as never, { desktop_human_client: true }), false);
  }
  assert.equal(isHumanAppWrite({ authKind: "session", sessionAccount: { account_id: "acct_1" } } as never, { agent_session_id: "worker" }), false);
});

test("room task updates deny parent board writes from hard-isolated Focus Rooms before task lookup", async () => {
  const { app, handlers } = createRouteApp();
  let coordinationCalled = false;
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({
      kind: "deny" as const,
      code: "focus_parent_board_read_only" as const,
      error: "blocked by focus settings",
    }),
    enforceTaskCoordinationMutation: async () => {
      coordinationCalled = true;
      return { kind: "allow" as const };
    },
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.patch.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "task_143" },
      body: { status: "in_progress" },
      query: {},
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "blocked by focus settings",
    code: "focus_parent_board_read_only",
  });
  assert.equal(coordinationCalled, false);
});

test("isCurrentStalePromptAction only allows prompts from the current task version", () => {
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: "2026-04-21T11:05:00.000Z",
    }),
    true
  );
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: "2026-04-21T10:59:59.000Z",
    }),
    false
  );
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: null,
    }),
    false
  );
});

test("getTaskBoardStalePromptState does not override active mutes", () => {
  const task = {
    id: "task_244",
    room_id: "github.com/brosincode/letagents",
    title: "Muted board prompt",
    description: null,
    status: "accepted",
    assignee: null,
    assignee_agent_key: null,
    created_by: "Human",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-07-03T11:00:00.000Z",
    updated_at: "2026-07-03T11:00:00.000Z",
  };

  const state = getTaskBoardStalePromptState({
    task: task as never,
    leases: [
      {
        id: "lease_1",
        task_id: "task_244",
        kind: "work",
        updated_at: "2026-07-03T11:10:00.000Z",
      },
    ] as never,
    mute: {
      task_id: "task_244",
      task_updated_at: task.updated_at,
      muted_by: "Emmy",
      created_at: "2026-07-03T11:15:00.000Z",
      updated_at: "2026-07-03T11:15:00.000Z",
    } as never,
  });

  assert.equal(state.muted, true);
  assert.equal(state.is_stale, false);
  assert.equal(state.reason, null);
});

test("stale prompt mute denies parent board writes from hard-isolated Focus Rooms", async () => {
  const { app, handlers } = createRouteApp();
  let coordinationCalled = false;
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({
      kind: "deny" as const,
      code: "focus_parent_board_read_only" as const,
      error: "blocked by focus settings",
    }),
    enforceTaskCoordinationMutation: async () => {
      coordinationCalled = true;
      return { kind: "allow" as const };
    },
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/stale-prompt-mute$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "task_153" },
      body: {},
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "blocked by focus settings",
    code: "focus_parent_board_read_only",
  });
  assert.equal(coordinationCalled, false);
});

test("lease action denies parent board writes from hard-isolated Focus Rooms", async () => {
  const { app, handlers } = createRouteApp();
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => ({ id: "github.com/brosincode/letagents" }),
    requireParticipant: async () => true,
    enforceFocusParentBoardWriteIsolation: async () => ({
      kind: "deny" as const,
      code: "focus_parent_board_read_only" as const,
      error: "blocked by focus settings",
    }),
  };

  registerRoomTaskRoutes(app as never, deps as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/lease-action$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "task_153" },
      body: { action: "release" },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: "blocked by focus settings",
    code: "focus_parent_board_read_only",
  });
});

test('recent task reads reject incompatible board cursors after access checks', async () => {
  const { app, handlers } = createRouteApp();
  let checked = 0;
  registerRoomTaskRoutes(app as never, { ...createDeps(), resolveCanonicalRoomRequestId: async (id: string) => id, resolveRoomOrReply: async () => ({ id: 'room' }), requireParticipant: async () => { checked++; return true; } } as never);
  const handler = handlers.get.get('/^\\/rooms\\/(.+)\\/tasks$/')!;
  for (const query of [{ order: 'recent', after: 'task_1' }, { order: 'recent', open: 'true' }]) {
    const response = createResponseRecorder();
    await handler({ params: { 0: 'room' }, query }, response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(checked, 2);
});

test('recent completed tasks include new work beyond the first 200 and recently finished old tasks', { skip: !process.env.TEST_DB_URL }, async () => {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { db, pool } = await import('../db/client.js');
  const { createProjectWithName, getTasks } = await import('../db.js');
  await migrate(db, { migrationsFolder: 'drizzle' });
  const room = await createProjectWithName(`inbox-recency-${Date.now()}`);
  try {
    await pool.query(`INSERT INTO tasks (room_id, number, title, status, created_by, created_at, updated_at)
      SELECT $1, i, 'Completed ' || i, 'done', 'test', NOW() - INTERVAL '1 day',
        CASE WHEN i = 1 THEN NOW() ELSE NOW() - (206 - i) * INTERVAL '1 minute' END
      FROM generate_series(1, 205) i`, [room.id]);
    const recent = await getTasks(room.id, 'done', { limit: 2, order: 'recent' });
    assert.deepEqual(recent.tasks.map(task => task.id), ['task_1', 'task_205']);
    assert.equal(recent.has_more, true);
    assert.ok(recent.tasks.every(task => !task.assignee));
    const original = await getTasks(room.id, 'done', { limit: 2 });
    assert.deepEqual(original.tasks.map(task => task.id), ['task_1', 'task_2'], 'existing board order stays stable');
  } finally { await pool.query('DELETE FROM rooms WHERE id = $1', [room.id]); await pool.end(); }
});
