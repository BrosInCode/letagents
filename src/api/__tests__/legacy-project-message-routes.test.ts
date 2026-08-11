import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerLegacyProjectMessageRoutes } = await import("../routes/legacy/messages.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    messageEvents: new EventEmitter(),
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
  assert.ok(
    (source.match(/attachActivations\(/g) ?? []).length >= 4,
    "history, stream, existing poll, and live poll must share receipt authority",
  );
  assert.match(source, /let messageWriteQueue = Promise\.resolve\(\)/);
  assert.match(source, /messageWriteQueue = messageWriteQueue[\s\S]*writeMessageCreated/);
  assert.match(source, /if \(streamClosed\) return;[\s\S]*res\.end\(\)/);
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
