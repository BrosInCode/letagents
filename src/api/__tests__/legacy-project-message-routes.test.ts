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
    getMessageStreamCheckpoint: async () => ({ checkpoint: "msg_100", cursorExists: true }),
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
  let rememberedParticipant: { sender: string; agentKey?: string | null } | null = null;
  let emitted: {
    sender: string;
    source?: string | null;
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
    account_id?: string | null;
    attachment_uploader?: { account_id: string | null; agent_session_id: string | null } | null;
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
        attachment_uploader?: { account_id: string | null; agent_session_id: string | null } | null;
      },
    ) => {
      emitted = {
        sender,
        source: options.source,
        publisher_agent_key: options.publisher_agent_key,
        publisher_agent_session_id: options.publisher_agent_session_id,
        account_id: options.account_id,
        attachment_uploader: options.attachment_uploader,
      };
      return {
        id: "msg_1",
        sender,
        text,
        source: options.source,
        timestamp: new Date(0).toISOString(),
      };
    },
    rememberRoomParticipantFromMessage: async (input: { sender: string; agentKey?: string | null }) => {
      rememberedParticipant = { sender: input.sender, agentKey: input.agentKey };
    },
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
  assert.deepEqual(rememberedParticipant, {
    sender: "Maple | Owner's agent | Worker",
    agentKey: "owner/maple",
  }, "the participant is recorded with its sender's key");
  assert.deepEqual(emitted, {
    sender: "Maple | Owner's agent | Worker",
    source: "agent",
    publisher_agent_key: "owner/maple",
    publisher_agent_session_id: "agent_session_worker",
    account_id: "acct_owner",
    // Attachments belong to the worker session, not to its owner's account.
    attachment_uploader: { account_id: null, agent_session_id: "agent_session_worker" },
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
    beginRoomAgentDelivery: async () => null,
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

test("a live event during the first legacy backlog read never makes a person's poll skip older messages", async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void>) {
      handlers.set(path, handler);
    },
    post() {},
  };
  const row = (number: number) => ({
    id: `msg_${number}`, sender: "Human", text: `message ${number}`, source: "browser",
    timestamp: new Date().toISOString(), routing_snapshot_version: 1,
  });
  let reads = 0;
  let releaseFirstRead!: () => void;
  const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  const bodies: Array<{ messages?: Array<{ id?: string }> }> = [];
  const deps = {
    ...createDeps(),
    beginRoomAgentDelivery: async () => null,
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    // The first read began before msg_10 was written: it holds msg_5..msg_9.
    getMessagesAfter: async () => {
      reads += 1;
      if (reads === 1) {
        await firstReadGate;
        return { messages: [5, 6, 7, 8, 9].map(row), has_more: false };
      }
      return { messages: [5, 6, 7, 8, 9, 10].map(row), has_more: false };
    },
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  const handler = handlers.get("/projects/:id/messages/poll");
  assert.ok(handler);
  const events = new EventEmitter();
  const req = {
    params: { id: "room_1" }, query: { after: "msg_4", timeout: "60000" }, headers: {},
    authKind: "session", sessionAccount: { account_id: "acct_1" }, get() { return undefined; },
    on: events.on.bind(events), off: events.off.bind(events),
  };
  const res = {
    headersSent: false,
    status() { return this; },
    json(payload: { messages?: Array<{ id?: string }> }) {
      bodies.push(payload); this.headersSent = true; return this;
    },
  };
  const request = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "the first backlog read is in flight");

  deps.messageEvents.emit("message:created", { projectId: "room_1", message: row(10) });
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  releaseFirstRead();
  await request;
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bodies.length, 1);
  const ids = (bodies[0]!.messages ?? []).map((message) => message.id);
  assert.equal(ids[0], "msg_5", `the response starts right after the cursor, got ${ids.join(", ")}`);
  deps.roomEventBroker.close();
});

function legacyHeldReadStore() {
  const committed: number[] = [];
  const pending: Array<() => void> = [];
  let calls = 0;
  const row = (number: number) => ({
    id: `msg_${number}`, sender: "Human", text: `message ${number}`, source: "browser",
    timestamp: new Date().toISOString(), routing_snapshot_version: 1,
  });
  return {
    row,
    commit(number: number) { committed.push(number); },
    calls: () => calls,
    async getMessagesAfter(_roomId: string, after?: string) {
      calls += 1;
      const cursor = Number(after?.slice(4) ?? 0);
      const snapshot = committed.filter((number) => number > cursor).map(row);
      await new Promise<void>((resolve) => pending.push(resolve));
      return { messages: snapshot, has_more: false };
    },
    async releaseReads() {
      for (let round = 0; round < 10; round += 1) {
        while (pending.length) pending.shift()!();
        for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function legacyPollHarness(store: ReturnType<typeof legacyHeldReadStore>) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string, handler: (req: unknown, res: unknown) => Promise<void>) { handlers.set(path, handler); },
    post() {},
  };
  const deps = {
    ...createDeps(),
    beginRoomAgentDelivery: async () => null,
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    getMessagesAfter: store.getMessagesAfter,
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  const handler = handlers.get("/projects/:id/messages/poll")!;
  const open = (after: string) => {
    const events = new EventEmitter();
    const startedAt = Date.now();
    let resolveBody!: (body: { messages?: Array<{ id?: string }>; at: number }) => void;
    const body = new Promise<{ messages?: Array<{ id?: string }>; at: number }>((resolve) => { resolveBody = resolve; });
    const req = {
      params: { id: "room_1" }, query: { after, timeout: "1000" }, headers: {},
      authKind: "session", sessionAccount: { account_id: "acct_1" }, get() { return undefined; },
      on: events.on.bind(events), off: events.off.bind(events),
    };
    const res = {
      headersSent: false,
      status() { return this; },
      json(payload: { messages?: Array<{ id?: string }> }) {
        this.headersSent = true; resolveBody({ ...payload, at: Date.now() - startedAt }); return this;
      },
    };
    return { request: handler(req, res), body };
  };
  return { deps, open };
}

const ticks = async (count: number) => {
  for (let tick = 0; tick < count; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a message that arrives while two legacy polls read their backlog reaches both without waiting for the timeout", async () => {
  const store = legacyHeldReadStore();
  const { deps, open } = legacyPollHarness(store);
  // P1 reads from msg_4 and sees a routed update of msg_4 meanwhile.
  const first = open("msg_4");
  await ticks(1);
  deps.messageEvents.emit("message:routed", { projectId: "room_1", message: store.row(4) });
  await ticks(10);
  // P2 opens at msg_4; msg_5 is written and announced during P2's first read.
  const second = open("msg_4");
  await ticks(10);
  store.commit(5);
  deps.messageEvents.emit("message:created", { projectId: "room_1", message: store.row(5) });
  await ticks(10);
  await store.releaseReads();

  const [firstBody, secondBody] = await Promise.all([first.body, second.body]);
  await Promise.all([first.request, second.request]);
  assert.deepEqual((secondBody.messages ?? []).map((message) => message.id), ["msg_5"]);
  assert.ok(secondBody.at < 500, `P2 answered after ${secondBody.at} ms`);
  assert.deepEqual((firstBody.messages ?? []).map((message) => message.id), ["msg_5"]);
  deps.roomEventBroker.close();
});

test("a routed update of a row at the cursor during the legacy backlog read is still answered", async () => {
  const store = legacyHeldReadStore();
  const { deps, open } = legacyPollHarness(store);
  const poll = open("msg_4");
  await ticks(1);
  deps.messageEvents.emit("message:routed", { projectId: "room_1", message: store.row(4) });
  await store.releaseReads();
  const body = await poll.body;
  await poll.request;
  assert.deepEqual((body.messages ?? []).map((message) => message.id), ["msg_4"]);
  assert.ok(body.at < 500, `answered after ${body.at} ms`);
  deps.roomEventBroker.close();
});

test("legacy polls at one cursor that see the same event during their backlog read share one extra read", async () => {
  const store = legacyHeldReadStore();
  const { deps, open } = legacyPollHarness(store);
  const polls = Array.from({ length: 50 }, () => open("msg_4"));
  await ticks(10);
  const initialReads = store.calls();
  store.commit(5);
  deps.messageEvents.emit("message:created", { projectId: "room_1", message: store.row(5) });
  await ticks(10);
  await store.releaseReads();
  const bodies = await Promise.all(polls.map((poll) => poll.body));
  await Promise.all(polls.map((poll) => poll.request));
  assert.ok(bodies.every((body) => (body.messages ?? []).map((message) => message.id).join() === "msg_5"));
  assert.equal(store.calls(), initialReads + 1, "one shared read after the event, not one per poll");
  deps.roomEventBroker.close();
});

// --- Characterization of the legacy wire shapes (worker and delivery paths) ---

const { InvalidRoomAgentDeliverySessionError } = await import("../rooms/agent-delivery.js");

function legacyRouteHarness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(routePath: string, handler: (req: unknown, res: unknown) => Promise<void>) { handlers.set(routePath, handler); },
    post(routePath: string, handler: (req: unknown, res: unknown) => Promise<void>) { handlers.set(`POST ${routePath}`, handler); },
  };
  let disconnectSession: (() => void) | null = null;
  const deps = {
    ...createDeps(),
    getProjectById: async () => ({ id: "room_1", display_name: "Room" }),
    resolveCanonicalRoomRequestId: async () => "room_1",
    requireParticipant: async () => true,
    beginRoomAgentDelivery: async (input: { onSessionDisconnected: () => void }) => {
      disconnectSession = input.onSessionDisconnected;
      return {
        identity: {
          actor_label: "Agent", agent_key: "owner/agent", agent_session_id: "session_1",
          owner_account_id: "account_1", session_kind: "worker",
        },
        checkCredential: async () => true,
        end: async () => {},
      };
    },
    ...overrides,
  };
  registerLegacyProjectMessageRoutes(app as never, deps as never);
  const request = (query: Record<string, string> = {}) => {
    const events = new EventEmitter();
    return {
      params: { id: "room_1" }, query, headers: {}, authKind: "owner_token",
      sessionAccount: { account_id: "account_1" },
      get() { return undefined; },
      on: events.on.bind(events), off: events.off.bind(events), emit: events.emit.bind(events),
    };
  };
  const sseResponse = () => ({
    writes: [] as string[], writableEnded: false, headersSent: false, statusCode: 200, body: undefined as unknown,
    socket: { setKeepAlive() {} },
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    on() { return this; }, off() { return this; },
    write(chunk: string) { this.writes.push(chunk); return true; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; this.headersSent = true; return this; },
    end() { this.writableEnded = true; },
  });
  return { deps, handlers, request, sseResponse, disconnect: () => disconnectSession?.() };
}

const settle = async () => {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("legacy SSE writes the legacy room_sync frame and bare message frames only", async () => {
  const harness = legacyRouteHarness();
  const res = harness.sseResponse();
  await harness.handlers.get("/projects/:id/messages/stream")!(harness.request(), res);
  await settle();
  const frames = () => res.writes.filter((chunk) => !chunk.startsWith(":"));
  assert.deepEqual(frames(), [
    `event: room_sync\ndata: ${JSON.stringify({ project_id: "room_1", event_cursor: null, gap: false })}\n\n`,
  ]);

  harness.deps.messageEvents.emit("message:created", {
    projectId: "room_1", message: { id: "msg_1", sender: "Human", text: "hello", source: "browser" },
  });
  await settle();
  harness.deps.messageEvents.emit("message:routed", {
    projectId: "room_1", message: { id: "msg_1", sender: "Human", text: "hello", source: "browser" },
  });
  await settle();
  harness.deps.taskEvents.emit("task:updated", { projectId: "room_1", task: { id: "task_1", title: "T" } });
  harness.deps.taskEvents.emit("task:removed", { projectId: "room_1", taskId: "task_1" });
  await settle();

  const written = frames().slice(1);
  assert.equal(written.length, 2, "only the two message events reach the legacy stream");
  for (const frame of written) {
    assert.match(frame, /^id: \S+\ndata: \{.*\}\n\n$/);
    const data = JSON.parse(frame.split("\n")[1]!.slice(6)) as Record<string, unknown>;
    assert.equal(data.id, "msg_1");
    assert.equal("room_id" in data, false);
    assert.equal("routing_pass" in data, false);
  }

  harness.disconnect();
  await settle();
  assert.equal(frames().at(-1), `event: session_disconnect\ndata: ${JSON.stringify({ project_id: "room_1" })}\n\n`);
  assert.equal(res.writableEnded, true);
  harness.deps.roomEventBroker.close();
});

test("legacy SSE and poll answer an invalid delivery session with 401", async () => {
  const harness = legacyRouteHarness({
    beginRoomAgentDelivery: async () => { throw new InvalidRoomAgentDeliverySessionError(); },
  });
  for (const route of ["/projects/:id/messages/stream", "/projects/:id/messages/poll"]) {
    const res = harness.sseResponse();
    await harness.handlers.get(route)!(harness.request({ timeout: "10" }), res);
    assert.equal(res.statusCode, 401, route);
    assert.deepEqual(res.body, { error: "Invalid agent session credentials." }, route);
  }
  harness.deps.roomEventBroker.close();
});

test("a legacy poll whose delivery session ends answers an empty legacy page", async () => {
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const harness = legacyRouteHarness({
    getMessagesAfter: async () => { await readGate; return { messages: [], has_more: false }; },
  });
  const res = harness.sseResponse();
  const request = harness.handlers.get("/projects/:id/messages/poll")!(harness.request({ after: "msg_3", timeout: "60000" }), res);
  await settle();
  harness.disconnect();
  await settle();
  assert.deepEqual(res.body, { project_id: "room_1", messages: [], has_more: false });
  releaseRead();
  await request;
  harness.deps.roomEventBroker.close();
});

test("a legacy poll answers a routed update of the cursor row with the legacy body", async () => {
  const store = legacyHeldReadStore();
  const { deps, open } = legacyPollHarness(store);
  const poll = open("msg_4");
  await ticks(1);
  deps.messageEvents.emit("message:routed", { projectId: "room_1", message: store.row(4) });
  await store.releaseReads();
  const { at: _at, ...body } = await poll.body as { at: number } & Record<string, unknown>;
  await poll.request;
  assert.deepEqual(Object.keys(body), ["project_id", "messages", "has_more"]);
  assert.equal(body.project_id, "room_1");
  deps.roomEventBroker.close();
});

test("a legacy poll opened after a message joins an older shared first read and misses it", async () => {
  const store = legacyHeldReadStore();
  const { deps, open } = legacyPollHarness(store);
  // A's first read starts before msg_5 is written.
  const first = open("msg_4");
  await ticks(10);
  store.commit(5);
  deps.messageEvents.emit("message:created", { projectId: "room_1", message: store.row(5) });
  await ticks(10);
  // B subscribes after the msg_5 event, so only its first read can find msg_5.
  const second = open("msg_4");
  await ticks(10);
  await store.releaseReads();
  const [firstBody, secondBody] = await Promise.all([first.body, second.body]);
  await Promise.all([first.request, second.request]);
  assert.deepEqual((firstBody.messages ?? []).map((message) => message.id), ["msg_5"]);
  assert.deepEqual((secondBody.messages ?? []).map((message) => message.id), [],
    "B's first read was A's read, which began before msg_5");
  assert.ok(secondBody.at >= 900, `B waited for its timeout, answered after ${secondBody.at} ms`);
  deps.roomEventBroker.close();
});
