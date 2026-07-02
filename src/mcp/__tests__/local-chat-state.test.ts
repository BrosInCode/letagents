import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const tempDir = mkdtempSync(join(tmpdir(), "letagents-mcp-local-chat-"));
const settingsPath = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = settingsPath;
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");

const {
  addLocalChatMessage,
  addLocalTask,
  getLocalChatMessages,
  getLocalTask,
  isLocalChatStorageEnabled,
  isLocalRoomStorageEnabled,
  listLocalTasks,
  updateLocalTask,
  waitForLocalChatMessages,
} = await import("../local-state/local-chat.js");
const { resolveWorkerToolIdentity } = await import("../server/runtime/agent-sessions.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const { registerPostReasoningTool } = await import("../server/tools/messages/reasoning-tool.js");
const { registerRoomResources } = await import("../server/resources.js");
const { postCanonicalTaskAction } = await import("../server/tools/tasks/api.js");
const { registerMessageTools } = await import("../server/tools/messages.js");
const { localActivationContext } = await import("../server/tools/messages/wait-tool.js");
const { toAgentReadableMessages } = await import("../server/runtime/messages.js");

type SendToolHandler = (
  input: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }> }>;

function captureSendThreadMessageHandler(): SendToolHandler {
  let handler: SendToolHandler | null = null;
  const server = {
    tool(name: string, _description: string, _schema: Record<string, unknown>, registered: SendToolHandler) {
      if (name === "send_thread_message") handler = registered;
    },
  };
  registerMessageTools(server as never);
  assert.ok(handler, "send_thread_message should be registered");
  return handler;
}

function openSqliteDb() {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        all: (...params: unknown[]) => Record<string, unknown>[];
        get: (...params: unknown[]) => Record<string, unknown> | undefined;
        run: (...params: unknown[]) => unknown;
      };
    };
  };
  const db = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB!);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

test.after(() => {
  delete process.env.LETAGENTS_CHAT_STORAGE;
  delete process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH;
  delete process.env.LETAGENTS_LOCAL_CHAT_DB;
  delete process.env.LETAGENTS_STATE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

test("MCP local chat state follows setting and supports message wait", async () => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ mode: "local" }), "utf8");
  assert.equal(await isLocalChatStorageEnabled(), true);

  const message = await addLocalChatMessage("room_1", {
    sender: "Agent",
    text: "local only",
    source: "agent",
  });
  assert.equal(message.id, "msg_1");

  const page = await getLocalChatMessages("room_1");
  assert.deepEqual(page.messages.map((entry) => entry.text), ["local only"]);

  const emptyPoll = await waitForLocalChatMessages("room_1", {
    after: message.id,
    timeoutMs: 1,
  });
  assert.deepEqual(emptyPoll.messages, []);
});

test("MCP local chat keeps quote-replies top-level and only threads with an explicit thread root", async () => {
  const root = await addLocalChatMessage("thread_room", {
    sender: "Human",
    text: "root",
    source: "browser",
  });
  // A bare reply_to (quote reply) must NOT spawn a thread — it stays top-level,
  // while the reply reference itself is still preserved (the chip).
  const quoteReply = await addLocalChatMessage("thread_room", {
    sender: "Agent",
    text: "quote reply",
    source: "agent",
    reply_to: root.id,
  });
  // An explicit thread_root_id still threads (real thread reply, e.g. send_thread_message).
  const threadReply = await addLocalChatMessage("thread_room", {
    sender: "Agent",
    text: "thread reply",
    source: "agent",
    reply_to: root.id,
    thread_root_id: root.id,
  });

  // Quote reply: its own id is the thread root (i.e. top-level), reply target preserved.
  assert.equal(quoteReply.thread_root_id, quoteReply.id);
  assert.equal(quoteReply.thread_reply_to_id, root.id);
  // Thread reply: belongs to the root's thread.
  assert.equal(threadReply.thread_root_id, root.id);
  assert.equal(threadReply.thread_reply_to_id, root.id);

  const db = openSqliteDb();
  const rows = db
    .prepare(`
      SELECT number, reply_to_number, thread_root_number
      FROM local_chat_messages
      WHERE room_id = ?
      ORDER BY number ASC
    `)
    .all("thread_room");

  assert.deepEqual(rows.map((row) => ({
    number: Number(row.number),
    reply_to_number: row.reply_to_number === null ? null : Number(row.reply_to_number),
    thread_root_number: row.thread_root_number === null ? null : Number(row.thread_root_number),
  })), [
    { number: 1, reply_to_number: null, thread_root_number: null },
    // quote reply: reply reference kept, but NOT threaded
    { number: 2, reply_to_number: 1, thread_root_number: null },
    // explicit thread reply: threaded onto the root
    { number: 3, reply_to_number: 1, thread_root_number: 1 },
  ]);

  // The agent-readable serializer must present the bare quote reply as top-level and
  // the explicit thread reply as a real thread member — linking storage to the read
  // derivation (the whole point of task_5).
  const readable = toAgentReadableMessages(
    (await getLocalChatMessages("thread_room")).messages,
  ) as Array<Record<string, unknown>>;
  const readableQuote = readable.find((entry) => entry.id === quoteReply.id);
  const readableThread = readable.find((entry) => entry.id === threadReply.id);
  assert.equal(Boolean(readableQuote && "thread_root_id" in readableQuote), false);
  assert.equal((readableQuote?.thread as Record<string, unknown>).is_thread_reply, false);
  assert.equal(readableThread?.thread_root_id, root.id);
  assert.equal((readableThread?.thread as Record<string, unknown>).is_thread_reply, true);
});

test("MCP local chat state resolves per-room overrides", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      local_room: "local",
      cloud_room: "cloud",
    },
  }), "utf8");

  assert.equal(await isLocalRoomStorageEnabled("local_room"), true);
  assert.equal(await isLocalRoomStorageEnabled("cloud_room"), false);
  assert.equal(await isLocalRoomStorageEnabled("inherited_room"), false);

  writeFileSync(settingsPath, JSON.stringify({
    mode: "local",
    defaultMode: "local",
    roomOverrides: {
      cloud_room: "cloud",
    },
  }), "utf8");

  assert.equal(await isLocalRoomStorageEnabled("inherited_room"), true);
  assert.equal(await isLocalRoomStorageEnabled("cloud_room"), false);
});

test("MCP local chat state lets explicit cloud overrides beat linked local metadata", async () => {
  await isLocalRoomStorageEnabled("schema_bootstrap");
  const db = openSqliteDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO local_rooms (room_id, display_name, cloud_room_id, created_at, updated_at, published_at, archived_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `).run("linked_local", "Linked local", "github.com/BrosInCode/letagents", now, now);
  db.prepare(`
    INSERT INTO local_rooms (room_id, display_name, cloud_room_id, created_at, updated_at, published_at, archived_at)
    VALUES (?, ?, NULL, ?, ?, NULL, NULL)
  `).run("local_only_room", "Local only", now, now);

  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      linked_local: "cloud",
      local_only_room: "cloud",
    },
  }), "utf8");

  assert.equal(await isLocalRoomStorageEnabled("linked_local"), false);
  assert.equal(await isLocalRoomStorageEnabled("github.com/BrosInCode/letagents"), false);
  assert.equal(await isLocalRoomStorageEnabled("local_only_room"), true);

  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      linked_local: "cloud",
      "github.com/BrosInCode/letagents": "local",
    },
  }), "utf8");

  assert.equal(await isLocalRoomStorageEnabled("github.com/BrosInCode/letagents"), true);
});

test("MCP local room writes synthesize a local worker session without hosted registration", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      identity_room: "local",
    },
  }), "utf8");

  const { identity, agentSession } = await resolveWorkerToolIdentity({
    roomId: "identity_room",
  });

  assert.equal(agentSession.room_id, "identity_room");
  assert.equal(agentSession.session_kind, "worker");
  assert.match(agentSession.session_id, /^local_/);
  assert.equal(identity.actor_label, agentSession.actor_label);
});

test("MCP register_agent_session succeeds locally without hosted registration", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      register_room: "local",
    },
  }), "utf8");

  let handler: ((input: {
    room_id?: string;
    session_kind?: "worker" | "controller";
    runtime?: string;
    display_name?: string;
  }) => Promise<{ content: Array<{ text: string }> }>) | null = null;
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      registeredHandler: typeof handler,
    ) {
      if (name === "register_agent_session") handler = registeredHandler;
    },
  };
  registerAgentSessionTools(server as never);

  assert.ok(handler);
  const response = await handler({
    room_id: "register_room",
    session_kind: "worker",
    runtime: "codex",
    display_name: "Local Codex",
  });
  const parsed = JSON.parse(response.content[0]?.text || "{}") as {
    success?: boolean;
    local?: boolean;
    agent_session_id?: string;
    agent_session?: { room_id?: string; display_name?: string };
  };
  assert.equal(parsed.success, true);
  assert.equal(parsed.local, true);
  assert.match(parsed.agent_session_id || "", /^local_/);
  assert.equal(parsed.agent_session?.room_id, "register_room");
  assert.equal(parsed.agent_session?.display_name, "Local Codex");
});

test("MCP local chat reads desktop-stored local attachments", async () => {
  const message = await addLocalChatMessage("attachment_room", {
    sender: "Human",
    text: "see file",
    source: "browser",
  });
  const db = openSqliteDb();
  db.prepare(`
    INSERT INTO local_chat_attachments (
      room_id, message_number, attachment_id, file_name, mime_type, size_bytes,
      url, download_url, data_url, content_base64, created_at
    )
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "attachment_room",
    "local:file-1",
    "note.txt",
    "text/plain",
    12,
    "file:///tmp/note.txt",
    "file:///tmp/note.txt",
    null,
    "aGVsbG8=",
    new Date().toISOString(),
  );

  const page = await getLocalChatMessages("attachment_room");
  const hydrated = page.messages.find((entry) => entry.id === message.id);
  assert.equal(hydrated?.attachments.length, 1);
  assert.equal(hydrated?.attachments[0]?.file_name, "note.txt");
  assert.equal(hydrated?.attachments[0]?.content_base64, "aGVsbG8=");
});

test("MCP room_messages resource reads local storage for local rooms", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      resource_room: "local",
    },
  }), "utf8");
  await addLocalChatMessage("resource_room", {
    sender: "Agent",
    text: "resource-local",
    source: "agent",
  });

  let handler: ((uri: { href: string }, params: { room_id: string }) => Promise<{
    contents: Array<{ text: string }>;
  }>) | null = null;
  const server = {
    resource(_name: string, _template: unknown, registeredHandler: typeof handler) {
      handler = registeredHandler;
    },
  };
  registerRoomResources(server as never);

  assert.ok(handler);
  const result = await handler(
    { href: "letagents://rooms/resource_room/messages" },
    { room_id: "resource_room" },
  );
  const parsed = JSON.parse(result.contents[0]?.text || "{}") as {
    messages?: Array<{ text?: string }>;
  };
  assert.deepEqual(parsed.messages?.map((message) => message.text), ["resource-local"]);
});

test("MCP post_reasoning stores milestones locally for local rooms", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      reasoning_room: "local",
    },
  }), "utf8");

  let handler: ((input: {
    summary: string;
    milestone?: string;
    room_id?: string;
  }) => Promise<{ content: Array<{ text: string }> }>) | null = null;
  const server = {
    tool(_name: string, _description: string, _schema: Record<string, unknown>, registeredHandler: typeof handler) {
      handler = registeredHandler;
    },
  };
  registerPostReasoningTool(server as never);

  assert.ok(handler);
  const response = await handler({
    room_id: "reasoning_room",
    summary: "checking local reasoning",
    milestone: "local milestone",
  });
  const parsed = JSON.parse(response.content[0]?.text || "{}") as {
    success?: boolean;
    local?: boolean;
    milestone_message_id?: string;
  };
  assert.equal(parsed.success, true);
  assert.equal(parsed.local, true);
  assert.equal(parsed.milestone_message_id, "msg_1");

  const page = await getLocalChatMessages("reasoning_room");
  assert.deepEqual(page.messages.map((message) => message.text), ["local milestone"]);
});

test("MCP local task state supports board create, list, and update", async () => {
  const task = await addLocalTask("board_room", {
    title: "Local board task",
    description: "Stored in SQLite",
    created_by: "Agent",
  });

  assert.equal(task.id, "task_1");
  assert.equal(task.status, "proposed");
  assert.equal(task.created_by, "Agent");

  const updated = await updateLocalTask("board_room", task.id, {
    status: "accepted",
    assignee: "Local Agent",
    assignee_agent_key: "local/agent",
    pr_url: "https://github.com/BrosInCode/letagents/pull/1",
    workflow_artifacts: [{
      provider: "github",
      kind: "pull_request",
      url: "https://github.com/BrosInCode/letagents/pull/1",
      status: "open",
    }],
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.assignee, "Local Agent");
  assert.equal(updated.pr_url, "https://github.com/BrosInCode/letagents/pull/1");
  assert.deepEqual(updated.workflow_artifacts, [{
    provider: "github",
    kind: "pull_request",
    url: "https://github.com/BrosInCode/letagents/pull/1",
    status: "open",
  }]);

  const claimed = await updateLocalTask("board_room", task.id, {
    status: "assigned",
    assignee: "Local Agent",
    assignee_agent_key: "local/agent",
    actor_instance_id: "local_instance_1",
    agent_session_id: "local_session_1",
  });
  assert.equal(claimed.assignee_agent_instance_id, "local_instance_1");
  assert.equal(claimed.assignee_agent_session_id, "local_session_1");

  const progressed = await updateLocalTask("board_room", task.id, {
    status: "in_progress",
  });
  assert.equal(progressed.assignee_agent_instance_id, "local_instance_1");
  assert.equal(progressed.assignee_agent_session_id, "local_session_1");

  const openTasks = await listLocalTasks("board_room");
  assert.deepEqual(openTasks.tasks.map((entry) => entry.id), [task.id]);
  assert.equal((await getLocalTask("board_room", task.id))?.status, "in_progress");

  await assert.rejects(
    () => updateLocalTask("board_room", task.id, { status: "accepted" }),
    /Invalid transition: in_progress -> accepted/,
  );
});

test("MCP local task lease actions stay local", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: {
      lease_room: "local",
    },
  }), "utf8");

  const task = await addLocalTask("lease_room", {
    title: "Handoff locally",
    created_by: "Agent",
  });
  await updateLocalTask("lease_room", task.id, { status: "accepted" });

  const handoff = await postCanonicalTaskAction<{
    action: string;
    task: {
      id: string;
      status: string;
      assignee: string | null;
      assignee_agent_key: string | null;
      assignee_agent_instance_id: string | null;
      assignee_agent_session_id: string | null;
    };
    released_lease: null;
    new_lease: null;
  }>("lease_room", task.id, "lease-action", {
    action: "handoff",
    target_actor_key: "local/next-agent",
    target_actor_instance_id: "local_next_instance_1",
    target_agent_session_id: "local_next_session_1",
  });

  assert.equal(handoff.action, "handoff");
  assert.equal(handoff.task.status, "assigned");
  assert.equal(handoff.task.assignee, "local/next-agent");
  assert.equal(handoff.task.assignee_agent_key, "local/next-agent");
  assert.equal(handoff.task.assignee_agent_instance_id, "local_next_instance_1");
  assert.equal(handoff.task.assignee_agent_session_id, "local_next_session_1");

  await updateLocalTask("lease_room", task.id, { status: "in_progress" });
  const inProgressHandoff = await postCanonicalTaskAction<{
    action: string;
    task: {
      id: string;
      status: string;
      assignee: string | null;
      assignee_agent_key: string | null;
      assignee_agent_instance_id: string | null;
      assignee_agent_session_id: string | null;
    };
    released_lease: null;
    new_lease: null;
  }>("lease_room", task.id, "lease-action", {
    action: "handoff",
    target_actor_key: "local/another-agent",
    target_actor_instance_id: "local_next_instance_2",
    target_agent_session_id: "local_next_session_2",
  });
  assert.equal(inProgressHandoff.task.status, "in_progress");
  assert.equal(inProgressHandoff.task.assignee, "local/another-agent");
  assert.equal(inProgressHandoff.task.assignee_agent_key, "local/another-agent");
  assert.equal(inProgressHandoff.task.assignee_agent_instance_id, "local_next_instance_2");
  assert.equal(inProgressHandoff.task.assignee_agent_session_id, "local_next_session_2");

  const review = await postCanonicalTaskAction<{
    action: string;
    task: {
      id: string;
      active_leases?: Array<{
        id: string;
        kind: string;
        agent_key: string | null;
      }>;
    };
    lease: { id: string; kind: string; agent_key: string | null };
  }>("lease_room", task.id, "review-lease-action", {
    action: "claim",
    actor_key: "local/reviewer",
    actor_label: "Local Reviewer",
    agent_session_id: "local_session_1",
  });
  assert.equal(review.action, "claim");
  assert.equal(review.task.id, task.id);
  assert.equal(review.lease.kind, "review");
  assert.equal(review.lease.agent_key, "local/reviewer");
  assert.equal(review.task.active_leases?.length, 1);

  const reviewRelease = await postCanonicalTaskAction<{
    action: string;
    task: { id: string; active_leases?: unknown[] };
    released_lease: { id: string; status: string } | null;
  }>("lease_room", task.id, "review-lease-action", {
    action: "release",
    lease_id: review.lease.id,
  });
  assert.equal(reviewRelease.action, "release");
  assert.equal(reviewRelease.released_lease?.status, "released");
  assert.deepEqual(reviewRelease.task.active_leases, []);

  const release = await postCanonicalTaskAction<{
    action: string;
    task: { id: string; status: string; assignee: string | null; assignee_agent_key: string | null };
    released_lease: null;
  }>("lease_room", task.id, "lease-action", {
    action: "release",
  });
  assert.equal(release.action, "release");
  assert.equal(release.task.status, "accepted");
  assert.equal(release.task.assignee, null);
  assert.equal(release.task.assignee_agent_key, null);
});

test("MCP local activation context ignores bare human assignees", async () => {
  const bareTask = await addLocalTask("bare_assignee_room", {
    title: "Bare human assignment",
    created_by: "Agent",
  });
  await updateLocalTask("bare_assignee_room", bareTask.id, { status: "accepted" });
  await updateLocalTask("bare_assignee_room", bareTask.id, {
    status: "assigned",
    assignee: "EmmyMay",
  });

  assert.deepEqual(await localActivationContext("bare_assignee_room"), {
    activeTaskLeases: [],
  });

  const agentTask = await addLocalTask("agent_assignee_room", {
    title: "Agent assignment",
    created_by: "Agent",
  });
  await updateLocalTask("agent_assignee_room", agentTask.id, { status: "accepted" });
  await updateLocalTask("agent_assignee_room", agentTask.id, {
    status: "assigned",
    assignee: "Local Agent",
    assignee_agent_key: "local/agent",
    agent_session_id: "local_session_1",
  });

  assert.deepEqual(await localActivationContext("agent_assignee_room"), {
    activeTaskLeases: [{
      kind: "work",
      status: "active",
      actor_label: "Local Agent",
      agent_key: "local/agent",
      agent_instance_id: null,
      agent_session_id: "local_session_1",
    }],
  });
});

test("send_thread_message roots a reply at a top-level quote-reply, not the quoted message", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: { send_thread_quote_room: "local" },
  }), "utf8");

  const root = await addLocalChatMessage("send_thread_quote_room", {
    sender: "Human",
    text: "root",
    source: "browser",
  });
  // A bare quote-reply is top-level (thread_root_id === its own id).
  const quoteReply = await addLocalChatMessage("send_thread_quote_room", {
    sender: "Agent",
    text: "quote of root",
    source: "agent",
    reply_to: root.id,
  });
  assert.equal(quoteReply.thread_root_id, quoteReply.id);

  const sendThreadMessage = captureSendThreadMessageHandler();
  const response = await sendThreadMessage({
    room_id: "send_thread_quote_room",
    text: "reply into the quote",
    thread_parent_id: quoteReply.id,
  });
  const created = JSON.parse(response.content[0]?.text || "{}") as Record<string, unknown>;

  // Must root at the quote-reply itself — NOT walk reply_to up to the quoted root.
  assert.equal(created.thread_root_id, quoteReply.id);
  assert.notEqual(created.thread_root_id, root.id);
  assert.equal(created.thread_reply_to_id, quoteReply.id);
});

test("send_thread_message targeting an in-thread message resolves to the real thread root", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    mode: "cloud",
    defaultMode: "cloud",
    roomOverrides: { send_thread_root_room: "local" },
  }), "utf8");

  const root = await addLocalChatMessage("send_thread_root_room", {
    sender: "Human",
    text: "root",
    source: "browser",
  });
  const threadReply = await addLocalChatMessage("send_thread_root_room", {
    sender: "Agent",
    text: "in-thread reply",
    source: "agent",
    reply_to: root.id,
    thread_root_id: root.id,
  });
  assert.equal(threadReply.thread_root_id, root.id);

  const sendThreadMessage = captureSendThreadMessageHandler();
  const response = await sendThreadMessage({
    room_id: "send_thread_root_room",
    text: "another thread reply",
    thread_parent_id: threadReply.id,
  });
  const created = JSON.parse(response.content[0]?.text || "{}") as Record<string, unknown>;

  // The thread root resolves to the real root; the chip points at the literal target.
  assert.equal(created.thread_root_id, root.id);
  assert.equal(created.thread_reply_to_id, threadReply.id);
});
