import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerLegacyProjectMessageRoutes } = await import("../routes/legacy/messages.js");
const { createRoomEventBroker } = await import("../server/room-event-broker.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  const eventSources = {
    messageEvents: new EventEmitter(),
    taskEvents: new EventEmitter(),
    githubRoomEvents: new EventEmitter(),
    reasoningEvents: new EventEmitter(),
    artifactEvents: new EventEmitter(),
    rentalActivityEvents: new EventEmitter(),
    messageInfoEvents: new EventEmitter(),
  };
  return {
    ...eventSources,
    roomEventBroker: createRoomEventBroker(eventSources),
    roomMessageOverlayBatcher: {
      async prepare(input: {
        message: { id?: string };
        targets: Array<{ accountId: string }>;
      }) {
        return new Map(input.targets.map((target) => [target.accountId, {
          account_agent_routing: {
            version: 1 as const,
            authority: "receipts" as const,
            recipient_agent_keys: [],
            recipient_agent_sessions: [],
            control_authorized: false,
          },
        }]));
      },
      async prepareMany(input: {
        messages: Array<{ id: string }>;
        targets: Array<{ accountId: string }>;
      }) {
        return new Map(input.messages.map((message) => [Number(message.id.slice(4)),
          new Map(input.targets.map((target) => [target.accountId, {
            account_agent_routing: {
              version: 1 as const, authority: "receipts" as const,
              recipient_agent_keys: [], recipient_agent_sessions: [], control_authorized: false,
            },
          }]))]));
      },
      close() {},
    },
    resolveRequestProjectRepoAccessRoomName: async (_req: unknown, project: { id: string }) => project.id,
    reauthorizeGitRoomParticipant: async () => true,
    beginRoomAgentDelivery: async () => ({
      identity: {
        actor_label: "Agent",
        agent_key: "owner/agent",
        agent_session_id: "session_1",
        owner_account_id: "account_1",
        session_kind: "worker",
      },
      checkCredential: async () => true,
      end: async () => {},
    }),
    resolveCanonicalRoomRequestId: unused,
    requireParticipant: unused,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: () => null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: unused,
    rememberRoomParticipantFromMessage: unused,
    rememberAccountRoom: async () => undefined,
  };
}

async function openLegacyStream(
  attach: (messages: Array<{ id?: string }>) => Promise<Array<{ id?: string }>>,
) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path, handler);
    },
    post() {},
  };
  const deps = {
    ...createDeps(),
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    attachReceiptAuthorityActivations: async (
      _roomId: string,
      _identity: unknown,
      messages: Array<{ id?: string }>,
    ) => await attach(messages),
    roomMessageOverlayBatcher: {
      async prepare(input: {
        message: { id?: string };
        targets: Array<{ accountId: string }>;
      }) {
        await attach([input.message]);
        return new Map(input.targets.map((target) => [target.accountId, {
          account_agent_routing: {
            version: 1 as const,
            authority: "receipts" as const,
            recipient_agent_keys: ["owner/agent"],
            recipient_agent_sessions: [{
              agent_key: "owner/agent",
              agent_session_id: "session_1",
              activation_reason: "explicit_mention",
            }],
            control_authorized: false,
          },
        }]));
      },
      async prepareMany(input: {
        messages: Array<{ id: string }>;
        targets: Array<{ accountId: string }>;
      }) {
        await attach(input.messages);
        return new Map(input.messages.map((message) => [Number(message.id.slice(4)),
          new Map(input.targets.map((target) => [target.accountId, {
            account_agent_routing: {
              version: 1 as const, authority: "receipts" as const,
              recipient_agent_keys: ["owner/agent"],
              recipient_agent_sessions: [{
                agent_key: "owner/agent", agent_session_id: "session_1",
                activation_reason: "explicit_mention",
              }],
              control_authorized: false,
            },
          }]))]));
      },
      close() {},
    },
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  let closeHandler: (() => void) | null = null;
  const req = {
    params: { id: "room_1" }, query: {}, headers: {},
    get() { return undefined; },
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
      return this;
    },
  };
  const res = {
    writes: [] as string[], writableEnded: false,
    socket: { setKeepAlive() {} },
    setHeader() {}, flushHeaders() {},
    write(chunk: string) { this.writes.push(chunk); return true; },
    status() { return this; }, json() { return this; },
    end() { this.writableEnded = true; },
  };
  const handler = handlers.get("/projects/:id/messages/stream");
  assert.ok(handler);
  await handler(req, res);
  return { deps, res, close: () => closeHandler?.() };
}

test("registerLegacyProjectMessageRoutes preserves legacy message route order", () => {
  const calls: Array<{ method: "get" | "post"; path: string }> = [];
  const app = {
    get(path: string) {
      calls.push({ method: "get", path });
    },
    post(path: string) {
      calls.push({ method: "post", path });
    },
  };

  registerLegacyProjectMessageRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/projects/:id/messages" },
    { method: "get", path: "/projects/:id/messages/:messageId/attachments/:attachmentId" },
    { method: "get", path: "/projects/:id/messages" },
    { method: "get", path: "/projects/:id/messages/stream" },
    { method: "get", path: "/projects/:id/messages/poll" },
  ]);
});

test("legacy worker message surfaces preserve exact publisher and receipt authority", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../routes/legacy/messages.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /publisher_agent_key: workerIdentity\.identity\.agent_key/);
  assert.match(source, /publisher_agent_session_id: workerIdentity\.identity\.agent_session_id/);
  assert.match(source, /workerIdentity\.identity\.owner_account_id/);
  assert.match(source, /hydrateLiveMessageForSubscriber\(/);
  assert.match(source, /messageOverlayTarget/);
  assert.match(source, /while \(!streamClosed\)[\s\S]*subscription\.next\(\)/);
  assert.match(source, /failed to hydrate message[\s\S]*connection\?\.close\(\)/);
});

test("legacy SSE serializes authority hydration in message order", async () => {
  const releases: Array<() => void> = [];
  const calls: string[] = [];
  const stream = await openLegacyStream(async (messages) => {
    calls.push(String(messages[0]?.id));
    await new Promise<void>((resolve) => releases.push(resolve));
    return messages;
  });
  stream.res.writes.length = 0;
  stream.deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_1", text: "first" },
  });
  stream.deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_2", text: "second" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["msg_1"]);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["msg_1", "msg_2"]);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stream.res.writes.join("").indexOf("msg_1") < stream.res.writes.join("").indexOf("msg_2"));
  stream.close();
});

test("legacy SSE closes once and drops pending frames after authority failure", async () => {
  let calls = 0;
  const stream = await openLegacyStream(async (messages) => {
    calls += 1;
    if (calls === 1) throw new Error("injected authority failure");
    return messages;
  });
  stream.res.writes.length = 0;
  stream.deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_1", text: "failed" },
  });
  stream.deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_2", text: "must not write" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(stream.res.writableEnded, true);
  assert.doesNotMatch(stream.res.writes.join(""), /msg_1|msg_2/);
  assert.match(stream.res.writes.join(""), /event: room_sync[\s\S]*"gap":true/);
  stream.close();
});

test("legacy agent-session bearer writes cannot impersonate an ordinary sender", async () => {
  let postHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  let emitted: {
    sender: string;
    source?: string | null;
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
    account_id?: string | null;
  } | null = null;
  const app = {
    get() {},
    post(_path: string, handler: (req: unknown, res: unknown) => Promise<void>) {
      postHandler = handler;
    },
  };
  const deps = {
    ...createDeps(),
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    emitProjectMessage: async (
      _roomId: string,
      sender: string,
      text: string,
      options: {
        source?: string | null;
        publisher_agent_key?: string | null;
        publisher_agent_session_id?: string | null;
        account_id?: string | null;
      },
    ) => {
      emitted = {
        sender,
        source: options.source,
        publisher_agent_key: options.publisher_agent_key,
        publisher_agent_session_id: options.publisher_agent_session_id,
        account_id: options.account_id,
      };
      return {
        id: "msg_1",
        sender,
        text,
        source: options.source,
        timestamp: new Date(0).toISOString(),
      };
    },
    rememberRoomParticipantFromMessage: async () => undefined,
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  assert.ok(postHandler);

  const response = {
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
  await postHandler({
    params: { id: "room_1" },
    body: { sender: "Human", text: "hello" },
    authKind: "agent_session",
    sessionAccount: null,
    agentSession: {
      room_id: "room_1",
      agent_session_id: "agent_session_worker",
      actor_label: "Maple | Owner's agent | Worker",
      agent_key: "owner/maple",
      owner_account_id: "acct_owner",
      agent_instance_id: null,
      session_kind: "worker",
      runtime: "codex",
      display_name: "Maple",
      owner_label: "Owner",
      ide_label: "Worker",
      repo_branch: null,
    },
  }, response);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(emitted, {
    sender: "Maple | Owner's agent | Worker",
    source: "agent",
    publisher_agent_key: "owner/maple",
    publisher_agent_session_id: "agent_session_worker",
    account_id: "acct_owner",
  });
});

test("one legacy broker gap coalesces a thousand poll catch-ups", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path, handler);
    },
    post() {},
  };
  let historyReads = 0;
  let gapPhase = false;
  let releaseGap!: () => void;
  const gapGate = new Promise<void>((resolve) => { releaseGap = resolve; });
  const deps = {
    ...createDeps(),
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    getMessagesAfter: async () => {
      historyReads += 1;
      if (gapPhase) {
        await gapGate;
        return {
            messages: [{
              id: "msg_7", sender: "System", text: "", source: "system",
              agent_prompt_kind: "auto", timestamp: new Date().toISOString(),
              routing_snapshot_version: 1,
            }],
            has_more: false,
          };
      }
      return { messages: [], has_more: false };
    },
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  const handler = handlers.get("/projects/:id/messages/poll");
  assert.ok(handler);

  const responses = Array.from({ length: 1_000 }, () => {
    const requestEvents = new EventEmitter();
    let resolveBody!: (body: {
      messages: Array<{ id?: string }>;
      last_observed_message_id?: string | null;
    }) => void;
    const body = new Promise<{
      messages: Array<{ id?: string }>;
      last_observed_message_id?: string | null;
    }>((resolve) => {
      resolveBody = resolve;
    });
    const req = {
      params: { id: "room_1" }, query: { after: "msg_6", timeout: "60000" },
      headers: {}, authKind: "session", sessionAccount: { account_id: "acct_1" },
      get() { return undefined; },
      on: requestEvents.on.bind(requestEvents),
      off: requestEvents.off.bind(requestEvents),
    };
    const res = {
      headersSent: false,
      status() { return this; },
      json(payload: { messages: Array<{ id?: string }> }) {
        this.headersSent = true;
        resolveBody(payload);
        return this;
      },
    };
    return { request: handler(req, res), body };
  });
  await Promise.all(responses.map(({ request }) => request));
  const initialHistoryReads = historyReads;
  assert.ok(initialHistoryReads > 0);

  gapPhase = true;
  deps.roomEventBroker.markGap("room_1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyReads, initialHistoryReads + 1, "legacy gap waiters share one canonical durable read");
  releaseGap();
  const bodies = await Promise.all(responses.map(({ body }) => body));
  assert.ok(bodies.every((body) => (
    body.messages.length === 0 && body.last_observed_message_id === "msg_7"
  )), "legacy silent prompt rows advance every worker cursor without exposing the body");
  deps.roomEventBroker.close();
});

test("legacy poll timeout cannot overtake an in-flight canonical hydration", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path, handler);
    },
    post() {},
  };
  let releaseOverlay!: () => void;
  const overlayGate = new Promise<void>((resolve) => { releaseOverlay = resolve; });
  let responseCount = 0;
  let responseBody: { messages?: Array<{ id?: string }> } | null = null;
  const deps = {
    ...createDeps(),
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    getMessagesAfter: async () => ({ messages: [], has_more: false }),
    roomMessageOverlayBatcher: {
      async prepare(input: { message: { id: string }; targets: Array<{ accountId: string }> }) {
        await overlayGate;
        return new Map(input.targets.map((target) => [target.accountId, {
          account_agent_routing: {
            version: 1 as const, authority: "receipts" as const,
            recipient_agent_keys: [], recipient_agent_sessions: [], control_authorized: false,
          },
        }]));
      },
      async prepareMany() { return new Map(); },
      close() {},
    },
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  const handler = handlers.get("/projects/:id/messages/poll");
  assert.ok(handler);
  const events = new EventEmitter();
  const req = {
    params: { id: "room_1" }, query: { after: "msg_6", timeout: "5" }, headers: {},
    authKind: "session", sessionAccount: { account_id: "acct_1" }, get() { return undefined; },
    on: events.on.bind(events), off: events.off.bind(events),
  };
  const res = {
    headersSent: false,
    status() { return this; },
    json(payload: { messages?: Array<{ id?: string }> }) {
      responseCount += 1; responseBody = payload; this.headersSent = true; return this;
    },
  };
  await handler(req, res);
  deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_7", sender: "Human", text: "hello" },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(responseCount, 0, "timeout defers while canonical authority owns settlement");
  releaseOverlay();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responseCount, 1);
  assert.equal(responseBody?.messages?.[0]?.id, "msg_7");
  deps.roomEventBroker.close();
});
