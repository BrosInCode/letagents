import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  isCurrentStalePromptAction,
  registerRoomTaskRoutes,
} = await import("../routes/room-tasks.js");

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
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/tasks\\/github-status$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
  ]);
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
