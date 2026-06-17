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

function openSqliteDb() {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
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
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.assignee, "Local Agent");
  assert.equal(updated.pr_url, "https://github.com/BrosInCode/letagents/pull/1");

  const openTasks = await listLocalTasks("board_room");
  assert.deepEqual(openTasks.tasks.map((entry) => entry.id), [task.id]);
  assert.equal((await getLocalTask("board_room", task.id))?.status, "accepted");

  await assert.rejects(
    () => updateLocalTask("board_room", task.id, { status: "done" }),
    /Invalid transition: accepted -> done/,
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
    task: { id: string; status: string; assignee: string | null; assignee_agent_key: string | null };
    released_lease: null;
    new_lease: null;
  }>("lease_room", task.id, "lease-action", {
    action: "handoff",
    target_actor_key: "local/next-agent",
  });

  assert.equal(handoff.action, "handoff");
  assert.equal(handoff.task.status, "assigned");
  assert.equal(handoff.task.assignee, "local/next-agent");
  assert.equal(handoff.task.assignee_agent_key, "local/next-agent");

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
