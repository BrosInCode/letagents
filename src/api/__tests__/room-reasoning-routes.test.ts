import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Project } from "../db.js";
import type { RoomReasoningRouteDeps, RoomReasoningStore } from "../routes/room-reasoning.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomReasoningRoutes } = await import("../routes/room-reasoning.js");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "github.com/brosincode/letagents",
    code: null,
    display_name: "LetAgents",
    name: "github.com/brosincode/letagents",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    concluded_at: null,
    conclusion_summary: null,
    created_at: "2026-04-21 00:00:00+00",
    ...overrides,
  };
}

function createStore(overrides: Partial<RoomReasoningStore> = {}): RoomReasoningStore {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    appendReasoningSessionUpdate: unused as RoomReasoningStore["appendReasoningSessionUpdate"],
    createReasoningSession: unused as RoomReasoningStore["createReasoningSession"],
    getReasoningSessionById: unused as RoomReasoningStore["getReasoningSessionById"],
    getReasoningSessionUpdates: unused as RoomReasoningStore["getReasoningSessionUpdates"],
    getReasoningSessions: (async () => []) as RoomReasoningStore["getReasoningSessions"],
    updateReasoningSession: unused as RoomReasoningStore["updateReasoningSession"],
    ...overrides,
  };
}

function createDeps(overrides: Partial<RoomReasoningRouteDeps> = {}): RoomReasoningRouteDeps {
  return {
    reasoningEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => project(),
    requireParticipant: async () => true,
    reasoningStore: createStore(),
    ...overrides,
  };
}

function createRouteApp() {
  const handlers = {
    get: new Map<string, (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>>(),
    patch: new Map<string, (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>>(),
    post: new Map<string, (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>>(),
  };
  const app = {
    get(path: RegExp, handler: (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>) {
      handlers.get.set(path.toString(), handler);
    },
    patch(path: RegExp, handler: (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>) {
      handlers.patch.set(path.toString(), handler);
    },
    post(path: RegExp, handler: (req: unknown, res: ReturnType<typeof createResponseRecorder>) => Promise<void>) {
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

test("registerRoomReasoningRoutes preserves canonical route order", () => {
  const calls: Array<{ method: "get" | "post" | "patch"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
  };

  registerRoomReasoningRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)\\/updates$/" },
  ]);
});

test("legacy reasoning list route trims filters and defaults to open sessions", async () => {
  const { app, handlers } = createRouteApp();
  const sessions = [{ id: "rsn_1", summary: "auditing coverage" }];
  let listCall: { roomId: string; options: unknown } | null = null;
  const store = createStore({
    getReasoningSessions: async (roomId, options) => {
      listCall = { roomId, options };
      return sessions as never;
    },
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.get.get("/^\\/rooms\\/(.+)\\/reasoning$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/BrosInCode/LetAgents" },
      query: {
        limit: "25",
        actor_label: " LakeAnchor | EmmyMay's agent | Agent ",
        task_id: " task_5 ",
      },
    },
    res
  );

  assert.deepEqual(listCall, {
    roomId: "github.com/brosincode/letagents",
    options: {
      limit: 25,
      open_only: true,
      actor_label: "LakeAnchor | EmmyMay's agent | Agent",
      task_id: "task_5",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    room_id: "github.com/brosincode/letagents",
    sessions,
  });
});

test("reasoning detail route returns the session and forwards update limits", async () => {
  const { app, handlers } = createRouteApp();
  const session = { id: "rsn_42", summary: "checking route registration" };
  const updates = [{ id: "rsu_1", summary: "opened the detail view" }];
  let updatesCall: { roomId: string; sessionId: string; options: unknown } | null = null;
  const store = createStore({
    getReasoningSessionById: async () => session as never,
    getReasoningSessionUpdates: async (roomId, sessionId, options) => {
      updatesCall = { roomId, sessionId, options };
      return updates as never;
    },
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.get.get("/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "rsn_42" },
      query: { limit: "5" },
    },
    res
  );

  assert.deepEqual(updatesCall, {
    roomId: "github.com/brosincode/letagents",
    sessionId: "rsn_42",
    options: { limit: 5 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    room_id: "github.com/brosincode/letagents",
    session,
    updates,
  });
});

test("reasoning creation requires an actor label before touching storage", async () => {
  const { app, handlers } = createRouteApp();
  let createCalled = false;
  const store = createStore({
    createReasoningSession: (async () => {
      createCalled = true;
      throw new Error("not expected");
    }) as RoomReasoningStore["createReasoningSession"],
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/reasoning-sessions$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents" },
      body: { summary: "auditing coverage" },
    },
    res
  );

  assert.equal(createCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "actor_label is required" });
});

test("reasoning creation normalizes optional ids and structured snapshot fields", async () => {
  const { app, handlers } = createRouteApp();
  let createCall: unknown = null;
  const store = createStore({
    createReasoningSession: async (payload) => {
      createCall = payload;
      return {
        session: { id: "rsn_2", summary: "auditing coverage" },
        update: { id: "rsu_2", summary: "auditing coverage" },
      } as never;
    },
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/reasoning-sessions$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents" },
      body: {
        task_id: " task_5 ",
        anchor_message_id: " msg_200 ",
        actor_label: " LakeAnchor | EmmyMay's agent | Agent ",
        agent_key: " EmmyMay/lakeanchor ",
        summary: "auditing coverage",
        goal: "cover reasoning streaming",
        blocker: " ",
        status: "working",
        confidence: "0.6",
      },
    },
    res
  );

  assert.deepEqual(createCall, {
    room_id: "github.com/brosincode/letagents",
    task_id: "task_5",
    anchor_message_id: "msg_200",
    actor_label: "LakeAnchor | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/lakeanchor",
    snapshot: {
      summary: "auditing coverage",
      goal: "cover reasoning streaming",
      blocker: null,
      status: "working",
      confidence: 0.6,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    room_id: "github.com/brosincode/letagents",
    session: { id: "rsn_2", summary: "auditing coverage" },
    update: { id: "rsu_2", summary: "auditing coverage" },
  });
});

test("reasoning patch rejects empty mutations before storage runs", async () => {
  const { app, handlers } = createRouteApp();
  let updateCalled = false;
  const store = createStore({
    updateReasoningSession: (async () => {
      updateCalled = true;
      throw new Error("not expected");
    }) as RoomReasoningStore["updateReasoningSession"],
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.patch.get("/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "rsn_9" },
      body: {},
    },
    res
  );

  assert.equal(updateCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: "task_id, anchor_message_id, or closed_at is required",
  });
});

test("reasoning update route returns 404 when the target session no longer exists", async () => {
  const { app, handlers } = createRouteApp();
  let appendCall: unknown = null;
  const store = createStore({
    appendReasoningSessionUpdate: async (payload) => {
      appendCall = payload;
      return null;
    },
  });

  registerRoomReasoningRoutes(app as never, createDeps({ reasoningStore: store }) as never);
  const handler = handlers.post.get("/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)\\/updates$/");
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler(
    {
      params: { 0: "github.com/brosincode/letagents", 1: "rsn_missing" },
      body: {
        actor_label: "LakeAnchor | EmmyMay's agent | Agent",
        summary: "checking for a missing session",
      },
    },
    res
  );

  assert.deepEqual(appendCall, {
    room_id: "github.com/brosincode/letagents",
    session_id: "rsn_missing",
    actor_label: "LakeAnchor | EmmyMay's agent | Agent",
    snapshot: {
      summary: "checking for a missing session",
    },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Reasoning session not found" });
});
