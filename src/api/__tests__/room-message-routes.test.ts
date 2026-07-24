import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMessageRoutes } = await import("../routes/rooms/messages/index.js");

test("account-hydrated room stream messages do not disclose publisher idempotency identity", () => {
  const streamSource = readFileSync(
    fileURLToPath(new URL("../routes/rooms/messages/stream.ts", import.meta.url)),
    "utf8",
  );
  assert.match(streamSource, /client_message_id:\s*null/);
  assert.doesNotMatch(streamSource, /client_message_id:\s*message\.client_message_id/);
});

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    messageEvents: new EventEmitter(),
    taskEvents: new EventEmitter(),
    githubRoomEvents: new EventEmitter(),
    reasoningEvents: new EventEmitter(),
    artifactEvents: new EventEmitter(),
    rentalActivityEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    parseOptionalThreadRootMessageId: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: unused,
    rememberRoomParticipantFromMessage: unused,
    rememberAccountRoom: async () => undefined,
  };
}

function responseRecorder() {
  return {
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
}

test("registerRoomMessageRoutes preserves canonical message route order", () => {
  const calls: Array<{ method: "delete" | "get" | "post" | "put"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
    put(path: RegExp) {
      calls.push({ method: "put", path: path.toString() });
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
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/(msg_\\d+)$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/poll$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/threads$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/(msg_\\d+)\\/thread$/" },
    { method: "put", path: "/^\\/rooms\\/(.+)\\/messages\\/(msg_\\d+)\\/thread\\/read$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/stream$/" },
  ]);
});

test("message history rejects malformed cursors before querying messages", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = responseRecorder();
  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages$/");
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1" },
      query: { after: "message_1" },
      sessionAccount: { account_id: "acct_1" },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "message cursor must be a valid message id" });
});

test("thread inbox rejects invalid filters", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = responseRecorder();
  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/threads$/");
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1" },
      query: { filter: "mentions" },
      sessionAccount: { account_id: "acct_1" },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "filter must be all or unread" });
});

test("thread read rejects non-string message ids", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post() {},
    put(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  const res = responseRecorder();
  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/(msg_\\d+)\\/thread\\/read$/")
  assert.ok(handler);
  await handler(
    {
      params: { 0: "room_1", 1: "msg_1" },
      body: { message_id: 123 },
      sessionAccount: { account_id: "acct_1" },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "message_id must be a valid message id" });
});

test("owner-token message writes require a registered worker session", async () => {
  let messageCreated = false;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
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

test("worker message writes persist server-authenticated publisher identity", async () => {
  let createdOptions: {
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
  } | null = null;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async (
      _projectId: string,
      sender: string,
      text: string,
      options?: {
        source?: string;
        publisher_agent_key?: string | null;
        publisher_agent_session_id?: string | null;
      },
    ) => {
      createdOptions = options ?? null;
      return {
        id: "msg_1",
        client_message_id: null,
        agent_identity: {
          actor_label: sender,
          agent_key: options?.publisher_agent_key || "",
          agent_session_id: options?.publisher_agent_session_id || null,
        },
        sender,
        text,
        source: options?.source,
        timestamp: new Date().toISOString(),
      };
    },
    rememberRoomParticipantFromMessage: async () => undefined,
  };

  registerRoomMessageRoutes(app as never, deps as never);
  const res = responseRecorder();
  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages$/");
  assert.ok(handler);
  await handler({
    params: { 0: "room_1" },
    body: { sender: "forged", text: "hello" },
    authKind: "agent_session",
    agentSession: {
      bearer_id: "bearer_1",
      bearer_generation: 1,
      capabilities: [],
      room_id: "room_1",
      agent_session_id: "agent_session_497",
      actor_label: "MapleRidge | EmmyMay's agent | Supervisor Worker",
      agent_key: "owner/maple-ridge",
      agent_instance_id: null,
      session_kind: "worker",
      runtime: "codex",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Supervisor Worker",
      repo_branch: null,
      expires_at: "2026-07-23T20:00:00.000Z",
    },
    sessionAccount: null,
  }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(createdOptions && {
    publisher_agent_key: createdOptions.publisher_agent_key,
    publisher_agent_session_id: createdOptions.publisher_agent_session_id,
  }, {
    publisher_agent_key: "owner/maple-ridge",
    publisher_agent_session_id: "agent_session_497",
  });
  assert.equal(
    (res.body as { sender?: string }).sender,
    "MapleRidge | EmmyMay's agent | Supervisor Worker",
  );
});

test("desktop owner-token human messages can post as browser activity", async () => {
  let createdMessage: { sender: string; text: string; options?: { source?: string; account_id?: string | null } } | null = null;
  let rememberedSource: string | null | undefined;
  let rememberedAccountRoom:
    | { accountId: string; roomId: string; displayName?: string | null; source?: string | null }
    | null = null;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async (_projectId: string, sender: string, text: string, options?: { source?: string; account_id?: string | null }) => {
      createdMessage = { sender, text, options };
      return { id: "msg_1", sender, text, source: options?.source, timestamp: new Date().toISOString() };
    },
    rememberRoomParticipantFromMessage: async (input: { source?: string | null }) => {
      rememberedSource = input.source;
    },
    rememberAccountRoom: async (input: {
      accountId: string;
      roomId: string;
      displayName?: string | null;
      source?: string | null;
    }) => {
      rememberedAccountRoom = input;
    },
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
      body: { sender: "EmmyMay", text: "hello from desktop" },
      headers: { "x-letagents-desktop-client": "1" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(createdMessage, {
    sender: "EmmyMay",
    text: "hello from desktop",
    options: { source: "browser", agent_prompt_kind: null, reply_to: null, thread_root_id: null, attachments: [], account_id: "acct_1" },
  });
  assert.equal(rememberedSource, "browser");
  assert.deepEqual(rememberedAccountRoom, {
    accountId: "acct_1",
    roomId: "room_1",
    displayName: undefined,
    source: "open_room",
  });
});

test("desktop owner-token messages ignore agent-shaped display labels", async () => {
  let createdMessage: { sender: string; text: string; options?: { source?: string; account_id?: string | null } } | null = null;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async (_projectId: string, sender: string, text: string, options?: { source?: string; account_id?: string | null }) => {
      createdMessage = { sender, text, options };
      return { id: "msg_1", sender, text, source: options?.source, timestamp: new Date().toISOString() };
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
      body: { sender: "BadgerMoon | EmmyMay's agent | Agent", text: "hello from desktop" },
      headers: { "x-letagents-desktop-client": "1" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(createdMessage, {
    sender: "BadgerMoon | EmmyMay's agent | Agent",
    text: "hello from desktop",
    options: { source: "browser", agent_prompt_kind: null, reply_to: null, thread_root_id: null, attachments: [], account_id: "acct_1" },
  });
});

test("desktop local sync forwards client message idempotency key", async () => {
  let createdMessage: {
    sender: string;
    text: string;
    options?: { source?: string; client_message_id?: string | null; account_id?: string | null };
  } | null = null;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async (
      _projectId: string,
      sender: string,
      text: string,
      options?: { source?: string; client_message_id?: string | null; account_id?: string | null },
    ) => {
      createdMessage = { sender, text, options };
      return { id: "msg_1", sender, text, source: options?.source, timestamp: new Date().toISOString() };
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
        sender: "EmmyMay",
        text: "synced local message",
        client_message_id: "local-chat:room_1:1",
      },
      headers: { "x-letagents-desktop-client": "1" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(createdMessage, {
    sender: "EmmyMay",
    text: "synced local message",
    options: {
      source: "browser",
      agent_prompt_kind: null,
      reply_to: null,
      thread_root_id: null,
      attachments: [],
      client_message_id: "local-chat:room_1:1",
      account_id: "acct_1",
    },
  });
});

test("desktop thread replies forward root and quoted reply targets separately", async () => {
  let createdOptions:
    | { reply_to?: string | null; thread_root_id?: string | null }
    | null = null;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    emitProjectMessage: async (
      _projectId: string,
      sender: string,
      text: string,
      options?: { reply_to?: string | null; thread_root_id?: string | null },
    ) => {
      createdOptions = options ?? null;
      return { id: "msg_9", sender, text, timestamp: new Date().toISOString() };
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
        sender: "EmmyMay",
        text: "quoted reply",
        reply_to: "msg_7",
        thread_root_id: "msg_1",
      },
      headers: { "x-letagents-desktop-client": "1" },
      authKind: "owner_token",
      sessionAccount: { account_id: "acct_1" },
    },
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(createdOptions?.reply_to, "msg_7");
  assert.equal(createdOptions?.thread_root_id, "msg_1");
});

test("desktop owner-token streams do not require worker delivery credentials", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  let closeHandler: (() => void) | null = null;
  const req = {
    params: { 0: "room_1" },
    headers: { "x-letagents-desktop-client": "1" },
    authKind: "owner_token",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    statusCode: 200,
    headers: new Map<string, string>(),
    writes: [] as string[],
    writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.writes.push(JSON.stringify(body));
      return this;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/stream$/");
  assert.ok(handler);
  await handler(req, res);
  closeHandler?.();

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.match(res.writes.join(""), /: connected/);
});

test("room streams forward rental activity and patch frames", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  let closeHandler: (() => void) | null = null;
  const req = {
    params: { 0: "room_1" },
    headers: { "x-letagents-desktop-client": "1" },
    authKind: "owner_token",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    statusCode: 200,
    headers: new Map<string, string>(),
    writes: [] as string[],
    writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.writes.push(JSON.stringify(body));
      return this;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/stream$/");
  assert.ok(handler);
  await handler(req, res);
  deps.rentalActivityEvents.emit("activity:created", {
    activity: {
      id: "rev_1",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "patch.proposed",
      source: "patch_gate",
      verified: true,
      visibility: "rental_visible",
      payload: { patch_id: "rpatch_1" },
      created_at: new Date("2026-05-12T10:00:00.000Z"),
    },
  });
  closeHandler?.();

  const output = res.writes.join("");
  assert.match(output, /event: rental_activity/);
  assert.match(output, /event: rental_patch/);
  assert.match(output, /"patch_id":"rpatch_1"/);
  assert.doesNotMatch(output, /event: rental_usage/);
});

test("room streams forward artifact update invalidations", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  let closeHandler: (() => void) | null = null;
  const req = {
    params: { 0: "room_1" },
    headers: { "x-letagents-desktop-client": "1" },
    authKind: "owner_token",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    statusCode: 200,
    headers: new Map<string, string>(),
    writes: [] as string[],
    writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.writes.push(JSON.stringify(body));
      return this;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/stream$/");
  assert.ok(handler);
  await handler(req, res);
  deps.artifactEvents.emit("artifact:updated", {
    projectId: "room_1",
    artifact: {
      identity_key: "github:branch:ref:codex/git-rooms",
    },
  });
  closeHandler?.();

  const output = res.writes.join("");
  assert.match(output, /event: artifact_update/);
  assert.match(output, /"artifact_identity_key":"github:branch:ref:codex\/git-rooms"/);
});

test("room streams forward redacted GitHub event updates", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  let closeHandler: (() => void) | null = null;
  const req = {
    params: { 0: "room_1" },
    headers: { "x-letagents-desktop-client": "1" },
    authKind: "owner_token",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    statusCode: 200,
    headers: new Map<string, string>(),
    writes: [] as string[],
    writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.writes.push(JSON.stringify(body));
      return this;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/stream$/");
  assert.ok(handler);
  await handler(req, res);
  deps.githubRoomEvents.emit("github_event:updated", {
    projectId: "room_1",
    event: {
      id: "gre_1",
      room_id: "room_1",
      delivery_id: "delivery_1",
      event_type: "pull_request",
      action: "opened",
      idempotency_key: "delivery_1:pull_request",
      semantic_id: "pull_request:42",
      github_object_id: "42",
      github_object_url: "https://github.com/BrosInCode/letagents/pull/42",
      title: "Track Git Room artifacts",
      state: "open",
      actor_login: "EmmyMay",
      provider_event_at: "2026-06-28T10:00:00.000Z",
      provider_object_updated_at: "2026-06-28T10:00:00.000Z",
      event_order_at: "2026-06-28T10:00:00.000Z",
      ref: "codex/git-rooms",
      base_ref: "main",
      head_ref: "codex/git-rooms",
      head_sha: "abc123",
      metadata: { body: "private body", draft: false },
      linked_task_id: "task_7",
      created_at: "2026-06-28T10:00:01.000Z",
    },
  });
  closeHandler?.();

  const output = res.writes.join("");
  assert.match(output, /event: github_event/);
  assert.match(output, /"event_type":"pull_request"/);
  assert.match(output, /"room_id":"room_1"/);
  assert.match(output, /"body":null/);
  assert.match(output, /"body_redacted":true/);
  assert.doesNotMatch(output, /private body/);
});

test("room stream does NOT forward internal/provider_only/renter_only rental activity events", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    post() {},
    put() {},
    delete() {},
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
  };

  registerRoomMessageRoutes(app as never, deps as never);

  let closeHandler: (() => void) | null = null;
  const req = {
    params: { 0: "room_1" },
    headers: { "x-letagents-desktop-client": "1" },
    authKind: "owner_token",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    statusCode: 200,
    headers: new Map<string, string>(),
    writes: [] as string[],
    writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.writes.push(JSON.stringify(body));
      return this;
    },
    end() {
      this.writableEnded = true;
    },
  };

  const handler = handlers.get("/^\\/rooms\\/(.+)\\/messages\\/stream$/");
  assert.ok(handler);
  await handler(req, res);

  // Emit internal event (budget.meter_stale) — should NOT appear on generic stream
  deps.rentalActivityEvents.emit("activity:created", {
    activity: {
      id: "rev_internal",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "budget.meter_stale",
      source: "system",
      verified: true,
      visibility: "internal",
      payload: {},
      created_at: new Date("2026-05-12T10:00:00.000Z"),
    },
  });

  // Emit provider_only event (agent.note) — should NOT appear on generic stream
  deps.rentalActivityEvents.emit("activity:created", {
    activity: {
      id: "rev_provider",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "agent.note",
      source: "agent",
      verified: false,
      visibility: "provider_only",
      payload: { note: "thinking..." },
      created_at: new Date("2026-05-12T10:01:00.000Z"),
    },
  });

  // Emit renter_only event — should NOT appear on generic stream
  deps.rentalActivityEvents.emit("activity:created", {
    activity: {
      id: "rev_renter",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "session.silence_nudge_sent",
      source: "system",
      verified: true,
      visibility: "renter_only",
      payload: {},
      created_at: new Date("2026-05-12T10:02:00.000Z"),
    },
  });

  // Emit rental_visible event (session.started) — SHOULD appear on generic stream
  deps.rentalActivityEvents.emit("activity:created", {
    activity: {
      id: "rev_visible",
      session_id: "rsess_1",
      room_id: "room_1",
      event_type: "session.started",
      source: "system",
      verified: true,
      visibility: "rental_visible",
      payload: { session_id: "rsess_1" },
      created_at: new Date("2026-05-12T10:03:00.000Z"),
    },
  });

  closeHandler?.();

  const output = res.writes.join("");

  // Only rental_visible event should produce frames
  assert.match(output, /event: rental_activity/, "rental_visible event should produce a rental_activity frame");
  assert.match(output, /rev_visible/, "rental_visible event payload should be present");

  // Internal, provider_only, renter_only must NOT produce any frames
  assert.doesNotMatch(output, /rev_internal/, "internal event must not leak to generic stream");
  assert.doesNotMatch(output, /rev_provider/, "provider_only event must not leak to generic stream");
  assert.doesNotMatch(output, /rev_renter/, "renter_only event must not leak to generic stream");
  assert.doesNotMatch(output, /budget\.meter_stale/, "budget.meter_stale must not produce SSE frame");
});

test("agent-shaped message writes require a registered worker session", async () => {
  let messageCreated = false;
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get() {},
    post(path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path.toString(), handler);
    },
    put() {},
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
    put() {},
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
