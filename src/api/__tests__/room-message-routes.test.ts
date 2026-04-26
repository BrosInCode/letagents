import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMessageRoutes } = await import("../routes/room-messages.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    messageEvents: new EventEmitter(),
    taskEvents: new EventEmitter(),
    reasoningEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: () => null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: unused,
    rememberRoomParticipantFromMessage: unused,
  };
}

test("registerRoomMessageRoutes preserves canonical message route order", () => {
  const calls: Array<{ method: "delete" | "get" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
    delete(path: RegExp) {
      calls.push({ method: "delete", path: path.toString() });
    },
  };

  registerRoomMessageRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/^\\/rooms\\/(.+)\\/messages$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/([^/]+)\\/attachments\\/([^/]+)$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/attachments\\/uploads$/" },
    { method: "delete", path: "/^\\/rooms\\/(.+)\\/attachments\\/uploads\\/([^/]+)$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/poll$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/stream$/" },
  ]);
});

test("owner-token message writes require a registered worker session", async () => {
  let messageCreated = false;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async () => {
      messageCreated = true;
      return { id: "msg_1", timestamp: new Date().toISOString() };
    },
    rememberRoomParticipantFromMessage: async () => undefined,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages$/");
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1" },
      body: { sender: "FakeAgent", text: "hello" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Registered worker session is required for agent write actions.",
  });
  assert.equal(messageCreated, false);
});

test("agent-shaped message writes require a registered worker session", async () => {
  let messageCreated = false;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async () => {
      messageCreated = true;
      return { id: "msg_1", timestamp: new Date().toISOString() };
    },
    rememberRoomParticipantFromMessage: async () => undefined,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages$/");
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1" },
      body: {
        sender: "BadgerMoon | EmmyMay's agent | Agent",
        text: "[status] in the room and available",
      },
      authKind: null,
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Registered worker session is required for agent write actions.",
  });
  assert.equal(messageCreated, false);
});

test("invalid agent session credentials do not create messages", async () => {
  let messageCreated = false;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async () => {
      messageCreated = true;
      return { id: "msg_1", timestamp: new Date().toISOString() };
    },
    rememberRoomParticipantFromMessage: async () => undefined,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages$/");
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1" },
      body: {
        sender: "BadgerMoon | EmmyMay's agent | Agent",
        text: "[status] in the room and available",
        agent_session_id: "agent_session_bad",
        agent_session_token: "bad-token",
      },
      authKind: null,
      sessionAccount: null,
    },
    res
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    error: "Invalid agent session credentials.",
  });
  assert.equal(messageCreated, false);
});
