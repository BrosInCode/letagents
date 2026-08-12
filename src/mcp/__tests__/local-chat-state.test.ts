import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const tempDir = mkdtempSync(join(tmpdir(), "letagents-mcp-local-chat-"));
const settingsPath = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = settingsPath;
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");
process.env.LETAGENTS_STATE_PATH = join(tempDir, "mcp-state.json");

const {
  addLocalChatMessage,
  addLocalTask,
  getLatestLocalChatMessages,
  getLocalChatMessages,
  getLocalChatThreadRoutingMembership,
  ensureLocalThreadRoutingProjection,
  getLocalTask,
  isLocalChatStorageEnabled,
  isLocalRoomStorageEnabled,
  listLocalTasks,
  updateLocalTask,
  waitForLocalChatMessages,
} = await import("../local-state/local-chat.js");
const { resolveWorkerToolIdentity } = await import("../server/runtime/agent-sessions.js");
const {
  endStoredAgentSession,
  getStoredAgentSession,
  saveAgentSession,
} = await import("../local-state/agent-sessions.js");
const { setStoredAuth } = await import("../local-state/auth.js");
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const { registerPostReasoningTool } = await import("../server/tools/messages/reasoning-tool.js");
const { registerRoomResources } = await import("../server/resources.js");
const { postCanonicalTaskAction } = await import("../server/tools/tasks/api.js");
const { registerMessageTools } = await import("../server/tools/messages.js");
const { attachLocalActivationMetadata, localActivationContext } = await import("../server/tools/messages/wait-tool.js");
const { toAgentReadableMessages } = await import("../server/runtime/messages.js");
const {
  ensureLocalThreadRoutingProjectionSchema,
  ensureLocalThreadRoutingProjectionSchemaAsync,
  getLocalThreadRoutingAgentKeysForRoots,
  projectLocalThreadRoutingMessage,
  runLocalSqliteWriteTransactionAsync,
  runLocalThreadRoutingBackfillBatch,
  scheduleLocalThreadRoutingBackfill,
} = await import("../../../shared/sqlite-thread-routing.mjs");

type SendToolHandler = (
  input: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }> }>;

function captureMessageToolHandler(toolName: string): SendToolHandler {
  let handler: SendToolHandler | null = null;
  const server = {
    tool(name: string, _description: string, _schema: Record<string, unknown>, registered: SendToolHandler) {
      if (name === toolName) handler = registered;
    },
  };
  registerMessageTools(server as never);
  assert.ok(handler, `${toolName} should be registered`);
  return handler;
}

function captureSendThreadMessageHandler(): SendToolHandler {
  return captureMessageToolHandler("send_thread_message");
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

test("MCP local wait exposes bounded truncation for tail and explicit cursor pages", async () => {
  writeFileSync(settingsPath, JSON.stringify({ mode: "local" }), "utf8");
  const roomId = "mcp_local_wait_truncation";
  for (let index = 0; index < 105; index += 1) {
    await addLocalChatMessage(roomId, {
      sender: "Human",
      text: `message ${index}`,
      source: "browser",
    });
  }
  const waitForMessages = captureMessageToolHandler("wait_for_messages");
  const tailResponse = await waitForMessages({ room_id: roomId, timeout: 1 });
  const tail = JSON.parse(tailResponse.content[0]!.text) as {
    messages: Array<{ id: string }>;
    truncated?: boolean;
  };
  assert.equal(tail.messages.length, 100);
  assert.equal(tail.messages[0]?.id, "msg_6");
  assert.equal(tail.messages.at(-1)?.id, "msg_105");
  assert.equal(tail.truncated, true);

  const cursorResponse = await waitForMessages({
    room_id: roomId,
    after_message_id: "msg_1",
    timeout: 1,
  });
  const cursor = JSON.parse(cursorResponse.content[0]!.text) as {
    messages: Array<{ id: string }>;
    last_observed_message_id?: string;
    truncated?: boolean;
  };
  assert.equal(cursor.messages.length, 100);
  assert.equal(cursor.messages[0]?.id, "msg_2");
  assert.equal(cursor.messages.at(-1)?.id, "msg_101");
  assert.equal(cursor.last_observed_message_id, "msg_101");
  assert.equal(cursor.truncated, true);
});

test("MCP local messages enforce canonical ids and shared sender bounds", async () => {
  const root = await addLocalChatMessage("mcp_contract_room", {
    sender: "😀".repeat(512),
    text: "boundary",
  });
  assert.equal(root.id, "msg_1");
  await assert.rejects(
    addLocalChatMessage("mcp_contract_room", { sender: "x".repeat(513), text: "too many characters" }),
    /must not exceed 512 characters or 2048 UTF-8 bytes/,
  );
  await assert.rejects(
    addLocalChatMessage("mcp_contract_room", { sender: "😀".repeat(513), text: "too many bytes" }),
    /must not exceed 512 characters or 2048 UTF-8 bytes/,
  );
  for (const malformed of ["msg_01", "msg_2147483648", "msg_9007199254740993"]) {
    await assert.rejects(
      addLocalChatMessage("mcp_contract_room", { sender: "Agent", text: "bad id", reply_to: malformed }),
      /reply_to must be a valid local message id/,
    );
  }
  const database = openSqliteDb();
  database.prepare(`
    INSERT INTO local_chat_room_sequences (room_id, next_number)
    VALUES ('mcp_sequence_overflow', 2147483648)
  `).run();
  await assert.rejects(
    addLocalChatMessage("mcp_sequence_overflow", { sender: "Agent", text: "overflow" }),
    /sequence could not be allocated/,
  );
});

test("MCP local chat serves the most recent messages without walking history", async () => {
  for (let index = 1; index <= 4; index += 1) {
    await addLocalChatMessage("recent_room", {
      sender: "Agent",
      text: `message ${index}`,
      source: "agent",
    });
  }

  const page = await getLatestLocalChatMessages("recent_room", { limit: 2 });
  assert.deepEqual(page.messages.map((entry) => entry.text), ["message 3", "message 4"]);
  assert.equal(page.has_more, true);

  const fullPage = await getLatestLocalChatMessages("recent_room", { limit: 10 });
  assert.equal(fullPage.messages.length, 4);
  assert.equal(fullPage.has_more, false);
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

test("MCP local activation uses indexed membership beyond display and for prompt-only members", async () => {
  const room = "local_activation_projection";
  const oldSender = "Old member | Test owner | Codex";
  const promptSender = "Prompt member | Test owner | Codex";
  const root = await addLocalChatMessage(room, {
    sender: oldSender,
    text: "root",
    source: "agent",
  });
  let latest = root;
  for (let index = 0; index < 55; index += 1) {
    latest = await addLocalChatMessage(room, {
      sender: `Agent ${index}`,
      text: `reply ${index}`,
      source: "agent",
      reply_to: latest.id,
      thread_root_id: root.id,
    });
  }
  await addLocalChatMessage(room, {
    sender: promptSender,
    text: "",
    source: "agent",
    agent_prompt_kind: "auto",
    reply_to: latest.id,
    thread_root_id: root.id,
  });
  await addLocalChatMessage(room, {
    sender: "A B",
    text: "",
    source: "agent",
    agent_prompt_kind: "auto",
    reply_to: latest.id,
    thread_root_id: root.id,
  });
  const continuation = await addLocalChatMessage(room, {
    sender: "Human",
    text: "continuing",
    source: "browser",
    reply_to: latest.id,
    thread_root_id: root.id,
  });

  const oldIdentity = {
    actor_label: oldSender,
    agent_key: "test/old",
    agent_instance_id: "old-instance",
    agent_session_id: "old-session",
    display_name: "Old member",
    session_kind: "worker",
  };
  const promptIdentity = {
    actor_label: promptSender,
    agent_key: "test/prompt",
    agent_instance_id: "prompt-instance",
    agent_session_id: "prompt-session",
    display_name: "Prompt member",
    session_kind: "worker",
  };
  assert.deepEqual(
    [...await getLocalChatThreadRoutingMembership(room, [root.id], oldIdentity)],
    [root.id],
  );
  assert.deepEqual(
    [...await getLocalChatThreadRoutingMembership(room, [root.id], promptIdentity)],
    [root.id],
  );
  assert.deepEqual(
    [...await getLocalChatThreadRoutingMembership(room, [root.id], {
      actor_label: "ab",
      agent_key: "test/ab",
      agent_instance_id: "ab-instance",
      agent_session_id: "ab-session",
      display_name: "ab",
      session_kind: "worker",
    })],
    [],
    "local projection must preserve the pure router's sender-vs-handle distinction",
  );

  for (const identity of [oldIdentity, promptIdentity]) {
    const [attached] = await attachLocalActivationMetadata(
      room,
      [continuation],
      {
        session_id: identity.agent_session_id,
        room_id: room,
        actor_label: identity.actor_label,
        agent_key: identity.agent_key,
        agent_instance_id: identity.agent_instance_id,
        display_name: identity.display_name,
        session_kind: "worker",
      } as never,
      { includeTaskOwnerLeases: false },
    );
    assert.deepEqual((attached as Record<string, unknown>).activation, {
      for_current_agent: {
        decision: "activate",
        reason: "thread_participant",
        addressed: true,
      },
    });
  }

  const ghostIdentity = {
    actor_label: "Display-only ghost",
    agent_key: "test/display-only-ghost",
    agent_instance_id: null,
    agent_session_id: "agent_session_display_only_ghost",
    display_name: "Display-only ghost",
    session_kind: "worker",
  };
  const [displayOnlyNegative] = await attachLocalActivationMetadata(
    room,
    [{
      ...continuation,
      thread: {
        ...((continuation as { thread?: Record<string, unknown> }).thread ?? {}),
        participants: [{ sender: ghostIdentity.actor_label }],
      },
    }],
    {
      session_id: ghostIdentity.agent_session_id,
      room_id: room,
      ...ghostIdentity,
    } as never,
    { includeTaskOwnerLeases: false },
  );
  assert.deepEqual((displayOnlyNegative as Record<string, unknown>).activation, {
    for_current_agent: {
      decision: "silent",
      reason: "unaddressed",
      addressed: false,
    },
  });

  const database = openSqliteDb();
  const plan = database
    .prepare(`
      EXPLAIN QUERY PLAN
      SELECT alias_text FROM local_chat_thread_routing_aliases_v2
      WHERE room_id = ? AND thread_root_number = ? AND alias_hash = ?
    `)
    .all(room, Number(root.id.slice(4)), "00000000000000000000000000000000");
  assert.match(plan.map((row) => String(row.detail || "")).join("\n"), /local_chat_thread_routing_alias_root_lookup_v2_idx/);
});

test("MCP local legacy activation resolves aliases against the complete active population", async () => {
  const room = "local_global_routing_authority";
  const timestamp = new Date().toISOString();
  const session = (
    sessionId: string,
    agentKey: string,
    actorLabel: string,
    ownerLabel: string,
  ) => ({
    session_id: sessionId,
    session_token: `${sessionId}-token`,
    room_id: room,
    session_kind: "worker" as const,
    runtime: "test",
    actor_label: actorLabel,
    agent_key: agentKey,
    agent_instance_id: `${sessionId}-instance`,
    display_name: "Oak",
    owner_label: ownerLabel,
    ide_label: "Agent",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  const alice = saveAgentSession(session(
    "local_global_alice",
    "alice/oak",
    "Oak | Alice | Codex",
    "Alice",
  ));
  const bob = saveAgentSession(session(
    "local_global_bob",
    "bob/oak",
    "Oak | Bob | Cursor",
    "Bob",
  ), false);
  const aliceSuccessor = saveAgentSession(session(
    "local_global_alice_next",
    "alice/oak",
    "New Oak | Alice | Codex",
    "Alice",
  ), false);
  const sameLabelOtherKey = saveAgentSession({
    ...session(
      "local_global_same_label_other_key",
      "charlie/not-alice",
      "New Oak | Alice | Codex",
      "Charlie",
    ),
    display_name: "New Oak",
  }, false);
  const root = await addLocalChatMessage(room, {
    sender: alice.actor_label,
    text: "root",
    source: "agent",
  });
  const quoteReply = await addLocalChatMessage(room, {
    sender: "Human",
    text: "direct reply",
    source: "browser",
    reply_to: root.id,
  });
  const [aliceQuoteReply, bobQuoteReply] = await Promise.all([
    attachLocalActivationMetadata(room, [quoteReply], alice, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [quoteReply], bob, { includeTaskOwnerLeases: false }),
  ]);
  assert.equal((aliceQuoteReply[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((bobQuoteReply[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "a top-level quote reply retains its globally resolved direct recipient");
  const continuation = await addLocalChatMessage(room, {
    sender: "Human",
    text: "continue",
    source: "browser",
    reply_to: root.id,
    thread_root_id: root.id,
  });
  const [aliceThread, bobThread, successorThread] = await Promise.all([
    attachLocalActivationMetadata(room, [continuation], alice, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [continuation], bob, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [continuation], aliceSuccessor, { includeTaskOwnerLeases: false }),
  ]);
  assert.equal((aliceThread[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((bobThread[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "the unique full label wins before the ambiguous Oak segment");
  assert.notEqual((successorThread[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "a same-key overlap has one deterministic legacy recipient");

  const ambiguous = await addLocalChatMessage(room, {
    sender: "Human",
    text: "@Oak inspect",
    source: "browser",
  });
  const [aliceMention, bobMention] = await Promise.all([
    attachLocalActivationMetadata(room, [ambiguous], alice, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [ambiguous], bob, { includeTaskOwnerLeases: false }),
  ]);
  for (const routed of [aliceMention[0], bobMention[0]]) {
    assert.notEqual((routed as { activation?: { for_current_agent?: { decision?: string } } })
      .activation?.for_current_agent?.decision, "activate",
    "separate local worker reads share one ambiguity authority");
  }

  const broadcast = await addLocalChatMessage(room, {
    sender: "Human",
    text: "@everyone continue",
    source: "browser",
  });
  const [aliceBroadcast, bobBroadcast, successorBroadcast] = await Promise.all([
    attachLocalActivationMetadata(room, [broadcast], alice, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [broadcast], bob, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [broadcast], aliceSuccessor, { includeTaskOwnerLeases: false }),
  ]);
  assert.equal((aliceBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.equal((bobBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((successorBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "a local broadcast activates one representative per durable key, not every rotation overlap");

  const exactTask = await addLocalTask(room, {
    title: "Exact rotation owner",
    created_by: "Human",
  });
  await updateLocalTask(room, exactTask.id, { status: "accepted" });
  await updateLocalTask(room, exactTask.id, {
    status: "assigned",
    assignee: aliceSuccessor.actor_label,
    assignee_agent_key: aliceSuccessor.agent_key,
    agent_session_id: aliceSuccessor.session_id,
  });
  const taskFollowUp = await addLocalChatMessage(room, {
    sender: "Human",
    text: "continue",
    source: "browser",
  });
  const [oldTaskOwner, exactTaskOwner] = await Promise.all([
    attachLocalActivationMetadata(room, [taskFollowUp], alice),
    attachLocalActivationMetadata(room, [taskFollowUp], aliceSuccessor),
  ]);
  assert.notEqual((oldTaskOwner[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "the durable-key representative cannot override an exact task lease session");
  assert.equal((exactTaskOwner[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");

  const successorSelfBroadcast = await addLocalChatMessage(room, {
    sender: aliceSuccessor.actor_label,
    text: "@everyone update",
    source: "agent",
    publisher_agent_key: aliceSuccessor.agent_key,
  });
  const [aliceSelfBroadcast, bobSelfBroadcast, successorOwnBroadcast, sameLabelOtherBroadcast] = await Promise.all([
    attachLocalActivationMetadata(room, [successorSelfBroadcast], alice, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [successorSelfBroadcast], bob, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [successorSelfBroadcast], aliceSuccessor, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [successorSelfBroadcast], sameLabelOtherKey, { includeTaskOwnerLeases: false }),
  ]);
  assert.notEqual((aliceSelfBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "another live rotation of the same durable key cannot wake on its own publication");
  assert.equal((bobSelfBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((successorOwnBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.equal((sameLabelOtherBroadcast[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "an exact durable publisher key prevents same-label workers from being misclassified as self");
});

test("MCP local reads preserve imported receipt authority and its account audience", async () => {
  const room = "local_imported_receipt_authority";
  const timestamp = new Date().toISOString();
  const current = saveAgentSession({
    session_id: "local_imported_current",
    session_token: "local-imported-token",
    room_id: room,
    session_kind: "worker",
    runtime: "test",
    actor_label: "Oak | Owner | Codex",
    agent_key: "owner/oak",
    agent_instance_id: "local-imported-instance",
    display_name: "Oak",
    owner_label: "Owner",
    ide_label: "Codex",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  setStoredAuth({
    token: "owner-token",
    account: { id: "owner", login: "owner" },
    stored_at: timestamp,
    source: "device_flow",
  });
  const database = openSqliteDb();
  database.prepare(`
    INSERT INTO local_chat_messages (
      room_id, number, sender, text, source, account_agent_routing_json,
      account_agent_routing_reader_key, control_authorized, timestamp
    ) VALUES (?, 1, 'Human', '@everyone imported', 'browser', ?, 'account:owner', 0, ?)
  `).run(room, JSON.stringify({
    version: 1,
    authority: "receipts",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  }), timestamp);

  const decision = async () => {
    const page = await getLocalChatMessages(room);
    const [message] = await attachLocalActivationMetadata(
      room,
      page.messages,
      current,
      { includeTaskOwnerLeases: false },
    );
    return (message as { activation?: { for_current_agent?: { decision?: string } } })
      .activation?.for_current_agent?.decision;
  };
  assert.equal(await decision(), "silent", "an empty immutable receipt snapshot cannot become a broadcast");

  database.prepare(`
    UPDATE local_chat_messages SET account_agent_routing_json = ?
    WHERE room_id = ? AND number = 1
  `).run(JSON.stringify({
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["owner/oak"],
    recipient_agent_sessions: [{
      agent_key: "owner/oak",
      agent_session_id: current.session_id,
    }],
    control_authorized: false,
  }), room);
  assert.equal(await decision(), "activate", "the exact captured receipt session activates");

  database.prepare(`
    UPDATE local_chat_messages SET account_agent_routing_json = ?
    WHERE room_id = ? AND number = 1
  `).run(JSON.stringify({
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["owner/oak"],
    recipient_agent_sessions: [{
      agent_key: "owner/oak",
      agent_session_id: "ended-captured-session",
      successor_agent_session_id: current.session_id,
    }],
    control_authorized: false,
  }), room);
  assert.equal(await decision(), "activate", "a server-authorized successor session activates");

  setStoredAuth({
    token: "other-token",
    account: { id: "other", login: "other" },
    stored_at: timestamp,
    source: "device_flow",
  });
  assert.equal(await decision(), "silent", "a receipt wrapper never crosses its importing account audience");

  setStoredAuth({
    token: "owner-token",
    account: { id: "owner", login: "owner" },
    stored_at: timestamp,
    source: "device_flow",
  });
  database.prepare(`
    UPDATE local_chat_messages SET account_agent_routing_json = '{malformed'
    WHERE room_id = ? AND number = 1
  `).run(room);
  assert.equal(await decision(), "silent", "present malformed imported authority fails closed");
});

test("MCP local routing fails closed when the shared state snapshot is unreadable", async () => {
  const room = "local_incomplete_state_authority";
  writeFileSync(settingsPath, JSON.stringify({ mode: "local" }), "utf8");
  const timestamp = new Date().toISOString();
  const current = saveAgentSession({
    session_id: "local_incomplete_alice",
    session_token: "alice-token",
    room_id: room,
    session_kind: "worker",
    runtime: "test",
    actor_label: "Oak | Alice | Codex",
    agent_key: "alice/oak",
    agent_instance_id: "alice-instance",
    display_name: "Oak",
    owner_label: "Alice",
    ide_label: "Codex",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  saveAgentSession({
    ...current,
    session_id: "local_incomplete_bob",
    session_token: "bob-token",
    agent_key: "bob/oak",
    agent_instance_id: "bob-instance",
    actor_label: "Oak | Bob | Cursor",
    owner_label: "Bob",
    ide_label: "Cursor",
  }, false);
  const statePath = process.env.LETAGENTS_STATE_PATH!;
  const originalState = readFileSync(statePath, "utf8");
  try {
    writeFileSync(statePath, "{broken", "utf8");
    const [routed] = await attachLocalActivationMetadata(room, [{
      id: "msg_9001",
      sender: "Human",
      text: "@Oak inspect",
      source: "browser",
    }], current, { includeTaskOwnerLeases: false });
    assert.equal(
      (routed as { activation?: { for_current_agent?: { decision?: string } } })
        .activation?.for_current_agent?.decision,
      "silent",
    );
    const readMessages = captureMessageToolHandler("read_messages");
    const waitForMessages = captureMessageToolHandler("wait_for_messages");
    await assert.rejects(
      () => readMessages({ room_id: room }),
      /Local agent routing state is unavailable/,
      "the registered read tool must fail before returning unannotated local rows",
    );
    await assert.rejects(
      () => waitForMessages({ room_id: room, timeout: 1 }),
      /Local agent routing state is unavailable/,
      "worker/controller ambiguity must not make the registered wait tool fail open",
    );

    writeFileSync(settingsPath, JSON.stringify({ mode: "cloud" }), "utf8");
    let remoteReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      remoteReads += 1;
      return new Response(JSON.stringify({ room_id: room, messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => readMessages({ room_id: room }),
        /Local agent routing state is unavailable/,
        "the registered remote read must not omit worker delivery authority on corrupt state",
      );
      assert.equal(remoteReads, 0, "corrupt authority is rejected before an unscoped remote read");

      const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
      const previousApiUrl = process.env.LETAGENTS_API_URL;
      const previousOwnerToken = process.env.LETAGENTS_TOKEN;
      try {
        process.env.LETAGENTS_AGENT_SESSION_BEARER = "worker-bearer";
        process.env.LETAGENTS_API_URL = "https://letagents.test";
        delete process.env.LETAGENTS_TOKEN;
        await readMessages({ room_id: room });
        assert.equal(
          remoteReads,
          1,
          "worker-bearer reads use their server credential without depending on unrelated owner state",
        );
      } finally {
        if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
        else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
        if (previousApiUrl === undefined) delete process.env.LETAGENTS_API_URL;
        else process.env.LETAGENTS_API_URL = previousApiUrl;
        if (previousOwnerToken === undefined) delete process.env.LETAGENTS_TOKEN;
        else process.env.LETAGENTS_TOKEN = previousOwnerToken;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    writeFileSync(statePath, originalState, "utf8");
    writeFileSync(settingsPath, JSON.stringify({ mode: "local" }), "utf8");
  }
});

test("MCP linked-local routing resolves ambiguity against the canonical cloud population", async () => {
  const localRoom = "linked_local_routing_room";
  const cloudRoom = "github.com/example/repo/focus/linked-routing";
  const timestamp = new Date().toISOString();
  const makeSession = (sessionId: string, agentKey: string, owner: string) => ({
    session_id: sessionId,
    session_token: `${sessionId}-token`,
    room_id: cloudRoom,
    session_kind: "worker" as const,
    runtime: "test",
    actor_label: `Oak | ${owner} | Codex`,
    agent_key: agentKey,
    agent_instance_id: `${sessionId}-instance`,
    display_name: "Oak",
    owner_label: owner,
    ide_label: "Codex",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  const alice = saveAgentSession(makeSession("linked_local_alice", "alice/oak", "Alice"));
  const bob = saveAgentSession(makeSession("linked_local_bob", "bob/oak", "Bob"), false);
  const message = {
    id: "msg_1",
    sender: "Human",
    text: "@Oak inspect",
    source: "browser",
  };

  const [aliceMessages, bobMessages] = await Promise.all([
    attachLocalActivationMetadata(localRoom, [message], alice, {
      includeTaskOwnerLeases: false,
      activeSessionRoomId: cloudRoom,
    }),
    attachLocalActivationMetadata(localRoom, [message], bob, {
      includeTaskOwnerLeases: false,
      activeSessionRoomId: cloudRoom,
    }),
  ]);
  for (const routed of [aliceMessages[0], bobMessages[0]]) {
    assert.equal((routed as { activation?: { for_current_agent?: { decision?: string } } })
      .activation?.for_current_agent?.decision, "silent");
  }
});

test("MCP local quote routing prefers an exact overlapping publisher session and ignores human aliases", async () => {
  const room = "local_exact_quote_routing";
  const timestamp = new Date().toISOString();
  const oldSession = saveAgentSession({
    session_id: "local_quote_old",
    session_token: "local-quote-old-token",
    room_id: room,
    session_kind: "worker",
    runtime: "test",
    actor_label: "Oak | Owner | Codex",
    agent_key: "owner/oak",
    agent_instance_id: "local-quote-old-instance",
    display_name: "Oak",
    owner_label: "Owner",
    ide_label: "Codex",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  const exactSession = saveAgentSession({
    ...oldSession,
    session_id: "local_quote_new",
    session_token: "local-quote-new-token",
    agent_instance_id: "local-quote-new-instance",
    created_at: new Date(Date.now() + 1).toISOString(),
    updated_at: new Date(Date.now() + 1).toISOString(),
    last_seen_at: new Date(Date.now() + 1).toISOString(),
  }, false);
  const exactReply = {
    id: "msg_2",
    sender: "Human",
    text: "following up",
    source: "browser",
    reply_to: {
      id: "msg_1",
      sender: exactSession.actor_label,
      source: "agent",
      agent_identity: {
        agent_key: exactSession.agent_key,
        agent_session_id: exactSession.session_id,
      },
    },
  };
  const [oldResult, exactResult] = await Promise.all([
    attachLocalActivationMetadata(room, [exactReply], oldSession, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [exactReply], exactSession, { includeTaskOwnerLeases: false }),
  ]);
  assert.equal((oldResult[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "silent");
  assert.equal((exactResult[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");

  const humanReply = {
    ...exactReply,
    id: "msg_3",
    reply_to: {
      id: "msg_human",
      sender: oldSession.actor_label,
      source: "browser",
    },
  };
  for (const result of await Promise.all([
    attachLocalActivationMetadata(room, [humanReply], oldSession, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [humanReply], exactSession, { includeTaskOwnerLeases: false }),
  ])) {
    assert.equal((result[0] as { activation?: { for_current_agent?: { decision?: string } } })
      .activation?.for_current_agent?.decision, "silent");
  }
});

test("MCP local thread routing preserves a durable publisher across a label rename", async () => {
  const room = "local_durable_publisher_membership";
  const timestamp = new Date().toISOString();
  const oldSession = saveAgentSession({
    session_id: "local_durable_old",
    session_token: "local-durable-old-token",
    room_id: room,
    session_kind: "worker",
    runtime: "test",
    actor_label: "Old Unshared Label",
    agent_key: "local/stable-key",
    agent_instance_id: "local-durable-old-instance",
    display_name: "OldName",
    owner_label: "Owner",
    ide_label: "Codex",
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: timestamp,
  });
  const root = await addLocalChatMessage(room, {
    sender: oldSession.actor_label,
    text: "root",
    source: "agent",
    publisher_agent_key: oldSession.agent_key,
    publisher_agent_session_id: oldSession.session_id,
  });
  assert.equal(root.agent_identity?.agent_session_id, oldSession.session_id);
  endStoredAgentSession(oldSession.session_id);
  const successor = saveAgentSession({
    ...oldSession,
    session_id: "local_durable_new",
    session_token: "local-durable-new-token",
    agent_instance_id: "local-durable-new-instance",
    actor_label: "New Unshared Label",
    display_name: "NewName",
    created_at: new Date(Date.now() + 1).toISOString(),
    updated_at: new Date(Date.now() + 1).toISOString(),
    last_seen_at: new Date(Date.now() + 1).toISOString(),
    ended_at: null,
  });
  const impostor = saveAgentSession({
    ...successor,
    session_id: "local_durable_impostor",
    session_token: "local-durable-impostor-token",
    agent_key: "local/impostor",
    agent_instance_id: "local-durable-impostor-instance",
    actor_label: oldSession.actor_label,
    display_name: oldSession.display_name,
  }, false);
  const continuation = await addLocalChatMessage(room, {
    sender: "Human",
    text: "continue",
    source: "browser",
    reply_to: root.id,
    thread_root_id: root.id,
  });
  const [successorMessages, impostorMessages] = await Promise.all([
    attachLocalActivationMetadata(room, [continuation], successor, { includeTaskOwnerLeases: false }),
    attachLocalActivationMetadata(room, [continuation], impostor, { includeTaskOwnerLeases: false }),
  ]);
  assert.equal((successorMessages[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((impostorMessages[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "a historical display label cannot inherit a participant with durable authority");
});

test("local routing never promotes browser or source-null senders into worker aliases", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER,
      sender TEXT NOT NULL, source TEXT, publisher_agent_key TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
    INSERT INTO local_chat_messages VALUES
      ('source_authority_room', 1, NULL, 'Oak', 'browser', NULL),
      ('source_authority_room', 2, 1, 'Oak', NULL, NULL);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  const identity = [{ agentKey: "owner/oak", display_name: "Oak" }];
  const before = await getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "source_authority_room",
    [1],
    identity,
    { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
  );
  assert.deepEqual([...(before.get(1) ?? [])], []);

  database.prepare(`
    INSERT INTO local_chat_messages VALUES
      ('source_authority_room', 3, 1, 'Oak', 'agent', NULL)
  `).run();
  projectLocalThreadRoutingMessage(database as never, {
    room_id: "source_authority_room",
    number: 3,
    thread_root_number: 1,
    sender: "Oak",
    source: "agent",
  });
  const after = await getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "source_authority_room",
    [1],
    identity,
    { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
  );
  assert.deepEqual([...(after.get(1) ?? [])], ["owner/oak"]);
  database.close();
});

test("MCP local routing projection backfills an existing database idempotently", async () => {
  const room = "local_routing_legacy_backfill";
  const database = openSqliteDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO local_chat_messages (
        room_id, number, reply_to_number, thread_root_number, sender, text,
        agent_prompt_kind, source, timestamp
      ) VALUES (?, 1, NULL, NULL, ?, 'root', NULL, 'agent', ?)
    `).run(room, "Legacy old member | Test owner | Codex", new Date().toISOString());
    database.prepare(`
      INSERT INTO local_chat_messages (
        room_id, number, reply_to_number, thread_root_number, sender, text,
        agent_prompt_kind, source, timestamp
      ) VALUES (?, 2, 1, 1, 'Human', 'continuing', NULL, 'browser', ?)
    `).run(room, new Date().toISOString());
    database.prepare(`
      UPDATE local_chat_thread_routing_projection_state_v2
      SET room_cursor = '', message_cursor = 0, completed = 0
      WHERE singleton = 1
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  await ensureLocalThreadRoutingProjection(database as never);
  await ensureLocalThreadRoutingProjection(database as never);
  const membership = await getLocalChatThreadRoutingMembership(room, ["msg_1"], {
    actor_label: "Legacy old member | Test owner | Codex",
    agent_key: "test/legacy-old",
    agent_instance_id: null,
    agent_session_id: null,
    display_name: "Legacy old member",
    session_kind: "worker",
  });
  assert.deepEqual([...membership], ["msg_1"]);
  const duplicates = database.prepare(`
    SELECT COUNT(*) AS count, COUNT(DISTINCT alias_hash || ':' || alias_text) AS distinct_count
    FROM local_chat_thread_routing_aliases_v2
    WHERE room_id = ? AND thread_root_number = 1
  `).get(room);
  assert.equal(Number(duplicates?.count), Number(duplicates?.distinct_count));
});

test("lazy local routing repairs writes from an old process after rollout completed", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const room = "local_routing_staggered_writer";
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO local_chat_messages (room_id, number, thread_root_number, sender, source)
      VALUES (?, 1, NULL, 'Human', 'browser')
    `).run(room);
    database.prepare(`
      INSERT INTO local_chat_messages (room_id, number, thread_root_number, sender, source)
      VALUES (?, 2, 1, ?, 'agent')
    `).run(room, "Late legacy member | Test owner | Codex");
    database.prepare(`
      UPDATE local_chat_thread_routing_projection_state_v2
      SET completed = 1 WHERE singleton = 1
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const membership = await getLocalThreadRoutingAgentKeysForRoots(database as never, room, [1], [{
    actor_label: "Late legacy member | Test owner | Codex",
    agentKey: "test/late-legacy",
    agent_instance_id: null,
    agent_session_id: null,
    display_name: "Late legacy member",
    session_kind: "worker",
  }]);
  assert.deepEqual([...membership.get(1) ?? []], ["test/late-legacy"]);
  assert.equal(Number(database.prepare(`
    SELECT through_message_number
    FROM local_chat_thread_routing_root_state_v2
    WHERE room_id = ? AND thread_root_number = 1
  `).get(room)?.through_message_number), 2);
  database.close();
});

test("a new writer cannot advance local routing past an older unprojected reply", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const room = "local_routing_staggered_gap";
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  database.exec("BEGIN IMMEDIATE");
  database.exec(`
    INSERT INTO local_chat_messages VALUES ('${room}', 1, NULL, 'Human', 'browser');
    INSERT INTO local_chat_messages VALUES ('${room}', 2, 1, 'Old legacy worker', 'agent');
    INSERT INTO local_chat_messages VALUES ('${room}', 3, 1, 'New projected worker', 'agent');
  `);
  projectLocalThreadRoutingMessage(database as never, {
    room_id: room,
    number: 3,
    thread_root_number: 1,
    sender: "New projected worker",
    source: "agent",
  });
  database.prepare(`
    UPDATE local_chat_thread_routing_projection_state_v2
    SET completed = 1 WHERE singleton = 1
  `).run();
  database.exec("COMMIT");

  assert.equal(Number(database.prepare(`
    SELECT through_message_number
    FROM local_chat_thread_routing_root_state_v2
    WHERE room_id = ? AND thread_root_number = 1
  `).get(room)?.through_message_number), 1, "live projection advanced across a legacy gap");
  const membership = await getLocalThreadRoutingAgentKeysForRoots(database as never, room, [1], [
    { agentKey: "test/old", display_name: "Old legacy worker" },
    { agentKey: "test/new", display_name: "New projected worker" },
  ]);
  assert.deepEqual([...membership.get(1) ?? []].sort(), ["test/new", "test/old"]);
  assert.equal(Number(database.prepare(`
    SELECT through_message_number
    FROM local_chat_thread_routing_root_state_v2
    WHERE room_id = ? AND thread_root_number = 1
  `).get(room)?.through_message_number), 3);
  database.close();
});

test("lazy local routing yields and returns fail-closed within a foreground budget", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  database.exec("BEGIN IMMEDIATE");
  database.exec(`
    INSERT INTO local_chat_messages VALUES ('large_lazy_root', 1, NULL, 'Human', 'browser');
    WITH RECURSIVE participants(number) AS (
      SELECT 2 UNION ALL SELECT number + 1 FROM participants WHERE number <= 50000
    )
    INSERT INTO local_chat_messages
    SELECT 'large_lazy_root', number, 1, 'Agent ' || (number - 1), 'agent' FROM participants;
  `);
  database.prepare(`
    UPDATE local_chat_thread_routing_projection_state_v2
    SET completed = 1 WHERE singleton = 1
  `).run();
  database.exec("COMMIT");

  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const startedAt = performance.now();
  const lookup = getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "large_lazy_root",
    [1],
    [{ agentKey: "test/last", display_name: "Agent 50000" }],
    { foregroundTimeBudgetMs: 75, scheduleOnTimeout: false },
  );
  await assert.rejects(lookup, { name: "LocalThreadRoutingProjectionUnavailableError" });
  assert.equal(timerFired, true, "foreground projection repair must yield to timers");
  assert.ok(
    performance.now() - startedAt < 750,
    "a large stale root must return fail-closed instead of blocking until fully replayed",
  );
  database.close();
});

test("lazy local routing returns fail-closed behind a held writer within its foreground budget", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `routing-foreground-contention-${Date.now()}.sqlite`);
  const writer = new DatabaseSync(databasePath);
  const reader = new DatabaseSync(databasePath);
  writer.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
    INSERT INTO local_chat_messages VALUES ('busy_lazy_room', 1, NULL, 'Human', 'browser');
    INSERT INTO local_chat_messages VALUES ('busy_lazy_room', 2, 1, 'Agent', 'agent');
  `);
  ensureLocalThreadRoutingProjectionSchema(reader as never);
  writer.exec("BEGIN IMMEDIATE");
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const startedAt = performance.now();
  try {
    await assert.rejects(
      getLocalThreadRoutingAgentKeysForRoots(
        reader as never,
        "busy_lazy_room",
        [1],
        [{ agentKey: "test/agent", display_name: "Agent" }],
        { foregroundTimeBudgetMs: 75, scheduleOnTimeout: false },
      ),
      { name: "LocalThreadRoutingProjectionUnavailableError" },
    );
    assert.equal(timerFired, true);
    assert.ok(performance.now() - startedAt < 400, "foreground lookup exceeded its lock deadline");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    reader.close();
  }
});

test("lazy local routing shares its yield budget across many small stale roots", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  database.exec("BEGIN IMMEDIATE");
  database.exec(`
    WITH RECURSIVE roots(number) AS (
      SELECT 1 UNION ALL SELECT number + 1 FROM roots WHERE number < 500
    )
    INSERT INTO local_chat_messages
    SELECT 'many_small_roots', number, NULL, 'Human ' || number, 'browser' FROM roots;
    WITH RECURSIVE replies(root_number) AS (
      SELECT 1 UNION ALL SELECT root_number + 1 FROM replies WHERE root_number < 500
    )
    INSERT INTO local_chat_messages
    SELECT 'many_small_roots', 500 + root_number, root_number, 'Agent ' || root_number, 'agent' FROM replies;
  `);
  database.prepare(`
    UPDATE local_chat_thread_routing_projection_state_v2
    SET completed = 1 WHERE singleton = 1
  `).run();
  database.exec("COMMIT");

  const roots = Array.from({ length: 500 }, (_, index) => index + 1);
  const lookup = getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "many_small_roots",
    roots,
    [{ agentKey: "test/last", display_name: "Agent 500" }],
    { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const midRepair = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM local_chat_thread_routing_root_state_v2
    WHERE room_id = 'many_small_roots'
  `).get()?.count ?? 0);
  assert.ok(midRepair > 0 && midRepair < 500, `cross-root repair did not yield at ${midRepair}`);
  assert.deepEqual([...(await lookup).get(500) ?? []], ["test/last"]);
  database.close();
});

test("local routing batches 500-root readiness and reuses one lookup statement for 1,004 identities", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  database.exec(`
    WITH RECURSIVE roots(number) AS (
      SELECT 1 UNION ALL SELECT number + 1 FROM roots WHERE number < 500
    )
    INSERT INTO local_chat_messages
    SELECT 'set_lookup_room', number, NULL, 'Human', 'browser' FROM roots;
    WITH RECURSIVE replies(root_number) AS (
      SELECT 1 UNION ALL SELECT root_number + 1 FROM replies WHERE root_number < 500
    )
    INSERT INTO local_chat_messages
    SELECT 'set_lookup_room', 500 + root_number, root_number, 'Agent ' || root_number, 'agent' FROM replies;
  `);

  let prepareCount = 0;
  const counted = {
    exec: database.exec.bind(database),
    prepare(sql: string) {
      prepareCount += 1;
      return database.prepare(sql);
    },
  };
  const roots = Array.from({ length: 500 }, (_, index) => index + 1);
  const identities = Array.from({ length: 1_004 }, (_, index) => ({
    agentKey: `test/agent-${index + 1}`,
    display_name: `Agent ${index + 1}`,
  }));
  const membership = await getLocalThreadRoutingAgentKeysForRoots(
    counted as never,
    "set_lookup_room",
    roots,
    identities,
    { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
  );

  assert.deepEqual([...membership.get(1) ?? []], ["test/agent-1"]);
  assert.deepEqual([...membership.get(500) ?? []], ["test/agent-500"]);
  assert.ok(
    prepareCount <= 32,
    `500 roots x 1,004 identities prepared ${prepareCount} statements`,
  );
  let secondLookupCompleted = false;
  const secondLookup = getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "set_lookup_room",
    roots,
    identities,
    { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
  ).then((value) => {
    secondLookupCompleted = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    secondLookupCompleted,
    false,
    "the durable-key lookup yields between fixed-size identity-hash batches",
  );
  await secondLookup;
  database.close();
});

test("completed local routing fails closed before high-cardinality alias or durable rows escape bounds", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (room_id, number)
    );
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  const oakHash = createHash("md5").update("oak").digest("hex");
  database.prepare(`
    WITH RECURSIVE participant(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM participant WHERE value < 50000
    )
    INSERT INTO local_chat_thread_routing_aliases_v2 (
      room_id, thread_root_number, participant_hash, participant_text,
      alias_hash, alias_text, is_full
    )
    SELECT 'bounded_completed_alias', 1, printf('%032x', value),
           'Oak ' || value, ?, 'oak', 0
      FROM participant
  `).run(oakHash);

  let startedAt = performance.now();
  await assert.rejects(
    getLocalThreadRoutingAgentKeysForRoots(
      database as never,
      "bounded_completed_alias",
      [1],
      [{ agentKey: "test/oak", display_name: "Oak" }],
      { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
    ),
    { name: "LocalThreadRoutingProjectionUnavailableError" },
  );
  assert.ok(performance.now() - startedAt < 1_000, "legacy result cap did not bound completed lookup work");

  const stableHash = createHash("md5").update("test/stable").digest("hex");
  database.prepare(`
    WITH RECURSIVE participant(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM participant WHERE value < 50000
    )
    INSERT INTO local_chat_thread_routing_agents_v2 (
      room_id, thread_root_number, participant_hash, participant_text,
      agent_key_hash, agent_key
    )
    SELECT 'bounded_completed_durable', 2, printf('%032x', value),
           'Stable ' || value, ?, 'test/stable'
      FROM participant
  `).run(stableHash);

  startedAt = performance.now();
  await assert.rejects(
    getLocalThreadRoutingAgentKeysForRoots(
      database as never,
      "bounded_completed_durable",
      [2],
      [{ agentKey: "test/stable", display_name: "Stable" }],
      { foregroundTimeBudgetMs: Number.POSITIVE_INFINITY },
    ),
    { name: "LocalThreadRoutingProjectionUnavailableError" },
  );
  assert.ok(performance.now() - startedAt < 1_000, "durable result cap did not bound completed lookup work");
  database.close();
});

test("local participant lookup remains exact across a normalization and digest collision", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  projectLocalThreadRoutingMessage(database as never, {
    room_id: "collision_room",
    number: 2,
    thread_root_number: 1,
    sender: "COLLISION TARGET",
    source: "agent",
  });
  const targetHash = createHash("md5").update("Collision Target").digest("hex");
  database.prepare(`
    UPDATE local_chat_thread_routing_aliases_v2
       SET participant_hash = ?
     WHERE room_id = 'collision_room' AND thread_root_number = 1
  `).run(targetHash);
  projectLocalThreadRoutingMessage(database as never, {
    room_id: "collision_room",
    number: 3,
    thread_root_number: 1,
    sender: "Collision Target",
    source: "agent",
  });

  const participants = database.prepare(`
    SELECT COUNT(DISTINCT participant_text) AS count
      FROM local_chat_thread_routing_aliases_v2
     WHERE room_id = 'collision_room' AND thread_root_number = 1
       AND participant_hash = ?
  `).get(targetHash);
  assert.equal(Number(participants?.count), 2, "raw participant text separates hash collisions");
  const plan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT 1 FROM local_chat_thread_routing_aliases_v2
     WHERE room_id = ? AND thread_root_number = ?
       AND participant_hash = ? AND participant_text = ?
     LIMIT 1
  `).all("collision_room", 1, targetHash, "Collision Target");
  assert.ok(
    plan.some((row) => String(row.detail).includes("local_chat_thread_routing_participant_lookup_v2_idx")),
    "participant existence checks use the collision-safe lookup index",
  );
  const membership = await getLocalThreadRoutingAgentKeysForRoots(
    database as never,
    "collision_room",
    [1],
    [
      { agentKey: "test/upper", display_name: "COLLISION TARGET" },
      { agentKey: "test/title", display_name: "Collision Target" },
    ],
  );
  assert.equal(membership.has(1), false, "a normalized alias collision stays ambiguous");
  database.close();
});

test("local routing lock retries back off and stop at a bounded deadline", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `routing-lock-backoff-${Date.now()}.sqlite`);
  const writer = new DatabaseSync(databasePath);
  const contender = new DatabaseSync(databasePath);
  writer.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
  `);
  contender.exec("PRAGMA busy_timeout = 5000");
  let attempts = 0;
  const wrapped = {
    prepare: contender.prepare.bind(contender),
    exec(sql: string) {
      if (/^BEGIN IMMEDIATE$/i.test(sql.trim())) attempts += 1;
      contender.exec(sql);
    },
  };
  writer.exec("BEGIN IMMEDIATE");
  const startedAt = performance.now();
  try {
    await assert.rejects(
      ensureLocalThreadRoutingProjectionSchemaAsync(wrapped as never, {
        maxWaitMs: 300,
        random: () => 0,
      }),
      /database (?:is )?locked/i,
    );
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed >= 250 && elapsed < 600, `lock retry deadline was ${elapsed.toFixed(1)}ms`);
    assert.ok(attempts >= 3 && attempts <= 8, `lock retry attempted ${attempts} times`);
    assert.equal(Number(contender.prepare("PRAGMA busy_timeout").get()?.timeout), 5_000);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    contender.close();
  }
});

test("baseline SQLite schema writes yield the event loop while another process owns the writer", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `schema-write-contention-${Date.now()}.sqlite`);
  const writer = new DatabaseSync(databasePath);
  const contender = new DatabaseSync(databasePath);
  writer.exec("CREATE TABLE seed (id INTEGER PRIMARY KEY)");
  contender.exec("PRAGMA busy_timeout = 5000");
  writer.exec("BEGIN IMMEDIATE");
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  const startedAt = performance.now();
  try {
    await assert.rejects(
      runLocalSqliteWriteTransactionAsync(
        contender,
        () => contender.exec("CREATE TABLE baseline_upgrade (id INTEGER PRIMARY KEY)"),
        { maxWaitMs: 150, random: () => 0 },
      ),
      /database (?:is )?locked/i,
    );
    const elapsed = performance.now() - startedAt;
    assert.equal(timerFired, true, "lock backoff must yield to timers");
    assert.ok(elapsed >= 100 && elapsed < 400, `schema lock deadline was ${elapsed.toFixed(1)}ms`);
    assert.equal(Number(contender.prepare("PRAGMA busy_timeout").get()?.timeout), 5_000);
  } finally {
    clearTimeout(timer);
    writer.exec("ROLLBACK");
    writer.close();
    contender.close();
  }
});

test("background local routing does not inherit the foreground busy timeout", () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `routing-contention-${Date.now()}.sqlite`);
  const writer = new DatabaseSync(databasePath);
  const backfill = new DatabaseSync(databasePath);
  backfill.exec("PRAGMA busy_timeout = 5000");
  writer.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
    INSERT INTO local_chat_messages VALUES ('busy_room', 1, NULL, 'Human');
    INSERT INTO local_chat_messages VALUES ('busy_room', 2, 1, 'Agent');
  `);
  ensureLocalThreadRoutingProjectionSchema(backfill as never);
  backfill.prepare(`
    UPDATE local_chat_thread_routing_projection_state_v2
    SET completed = 0 WHERE singleton = 1
  `).run();
  writer.exec("BEGIN IMMEDIATE");
  try {
    const startedAt = performance.now();
    assert.throws(() => runLocalThreadRoutingBackfillBatch(backfill as never), /database (?:is )?locked/i);
    assert.ok(performance.now() - startedAt < 100, "maintenance waited on the five-second foreground timeout");
    assert.equal(Number(backfill.prepare("PRAGMA busy_timeout").get()?.timeout), 5_000);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    backfill.close();
  }
});

test("local routing schema startup is history-independent and bounded backfill resumes", () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      thread_root_number INTEGER,
      sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
    CREATE INDEX local_chat_messages_thread_root_idx
      ON local_chat_messages (room_id, thread_root_number);
    INSERT INTO local_chat_messages VALUES ('large_room', 1, NULL, 'Root');
    WITH RECURSIVE values_50k(value) AS (
      SELECT 2 UNION ALL SELECT value + 1 FROM values_50k WHERE value <= 50000
    )
    INSERT INTO local_chat_messages
    SELECT 'large_room', value, 1, 'Agent ' || value FROM values_50k;
  `);

  const startedAt = performance.now();
  ensureLocalThreadRoutingProjectionSchema(database as never);
  const startupMs = performance.now() - startedAt;
  assert.ok(startupMs < 500, `schema-only startup took ${startupMs.toFixed(1)}ms`);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM local_chat_thread_routing_aliases_v2").get()?.count), 0);

  const first = runLocalThreadRoutingBackfillBatch(database as never);
  assert.ok(first.processed > 0 && first.processed <= 100);
  assert.equal(first.completed, false);
  const firstCursor = Number(database.prepare(`
    SELECT message_cursor FROM local_chat_thread_routing_projection_state_v2 WHERE singleton = 1
  `).get()?.message_cursor);
  assert.equal(firstCursor, first.processed + 1);

  // Re-running schema setup models a process restart. The persisted keyset
  // cursor advances; it never restarts the 50k-row history scan.
  ensureLocalThreadRoutingProjectionSchema(database as never);
  const second = runLocalThreadRoutingBackfillBatch(database as never);
  assert.ok(second.processed > 0 && second.processed <= 100);
  assert.equal(second.completed, false);
  assert.equal(Number(database.prepare(`
    SELECT message_cursor FROM local_chat_thread_routing_projection_state_v2 WHERE singleton = 1
  `).get()?.message_cursor), firstCursor + second.processed);
  database.close();
});

test("local routing schema upgrade is race-idempotent across processes", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `routing-upgrade-${Date.now()}.sqlite`);
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
    CREATE TABLE local_chat_thread_routing_aliases (
      alias_id INTEGER PRIMARY KEY, room_id TEXT NOT NULL, thread_root_number INTEGER NOT NULL,
      alias_hash TEXT NOT NULL, alias_text TEXT NOT NULL
    );
    WITH RECURSIVE legacy_alias(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM legacy_alias WHERE value < 50000
    )
    INSERT INTO local_chat_thread_routing_aliases
    SELECT value, 'legacy_room', 1, 'legacy-hash', 'Legacy ' || value FROM legacy_alias;
  `);
  seed.close();

  const workerCount = 4;
  const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const gate = new Int32Array(start);
  const moduleUrl = new URL("../../../shared/sqlite-thread-routing.mjs", import.meta.url).href;
  const workers = Array.from({ length: workerCount }, () => new Worker(`
    import { workerData, parentPort } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";
    const projection = await import(workerData.moduleUrl);
    const db = new DatabaseSync(workerData.databasePath);
    parentPort.postMessage("ready");
    Atomics.wait(new Int32Array(workerData.start), 0, 0);
    await projection.ensureLocalThreadRoutingProjectionSchemaAsync(db);
    db.close();
  `, {
    eval: true,
    type: "module",
    workerData: { databasePath, moduleUrl, start },
  }));
  await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  })));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0, workerCount);
  await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`upgrade worker exited ${code}`)));
    worker.once("error", reject);
  })));

  const verified = new DatabaseSync(databasePath);
  const columns = new Set(verified.prepare("PRAGMA table_info(local_chat_thread_routing_aliases_v2)")
    .all().map((row) => String(row.name)));
  assert.ok(columns.has("participant_hash"));
  assert.ok(columns.has("participant_text"));
  assert.ok(columns.has("is_full"));
  assert.equal(Number(verified.prepare(
    "SELECT COUNT(*) AS count FROM local_chat_thread_routing_aliases",
  ).get()?.count), 50_000);
  assert.equal(Number(verified.prepare(
    "SELECT COUNT(*) AS count FROM local_chat_thread_routing_aliases_v2",
  ).get()?.count), 0);
  verified.close();
});

test("local routing schema cutover rolls back atomically after interruption", () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
  `);
  let interruptOnce = true;
  const wrapped = {
    prepare: database.prepare.bind(database),
    exec(sql: string) {
      database.exec(sql);
      if (interruptOnce && sql.includes("CREATE TABLE IF NOT EXISTS local_chat_thread_routing_aliases_v2")) {
        interruptOnce = false;
        throw new Error("synthetic process interruption");
      }
    },
  };
  assert.throws(
    () => ensureLocalThreadRoutingProjectionSchema(wrapped as never),
    /synthetic process interruption/,
  );
  assert.equal(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'local_chat_thread_routing_aliases_v2'
  `).get(), undefined);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  assert.ok(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'local_chat_thread_routing_aliases_v2'
  `).get());
  database.close();
});

test("MCP local database initialization is single-flight and retries after schema failure", async () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const databasePath = join(tempDir, `routing-init-retry-${Date.now()}.sqlite`);
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE VIEW local_chat_thread_routing_aliases_v2 AS
    SELECT 1 AS alias_id;
  `);
  seed.close();

  const moduleUrl = new URL("../local-state/local-chat.ts", import.meta.url).href;
  const script = `
    import { DatabaseSync } from "node:sqlite";
    process.env.LETAGENTS_LOCAL_CHAT_DB = ${JSON.stringify(databasePath)};
    process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = ${JSON.stringify(join(tempDir, "init-retry-settings.json"))};
    const localChat = await import(${JSON.stringify(moduleUrl)});
    let databaseInitializations = 0;
    let schemaInitializations = 0;
    localChat.setLocalChatInitializationObserversForTest({
      database: () => { databaseInitializations += 1; },
      schema: () => { schemaInitializations += 1; },
    });
    const first = await Promise.allSettled(Array.from({ length: 12 }, () =>
      localChat.getLatestLocalChatMessages("init_retry_room")));
    if (first.some((result) => result.status !== "rejected")) {
      throw new Error("concurrent callers did not share the failed initialization");
    }
    if (databaseInitializations !== 1 || schemaInitializations !== 1) {
      throw new Error(
        \`failed single-flight opened \${databaseInitializations} databases and ran \${schemaInitializations} schemas\`,
      );
    }
    const repair = new DatabaseSync(${JSON.stringify(databasePath)});
    repair.exec("DROP VIEW local_chat_thread_routing_aliases_v2");
    repair.close();
    const recovered = await Promise.all(Array.from({ length: 12 }, () =>
      localChat.getLatestLocalChatMessages("init_retry_room")));
    if (recovered.some((page) => page.messages.length !== 0)) {
      throw new Error("recovered empty database returned messages");
    }
    if (databaseInitializations !== 2 || schemaInitializations !== 2) {
      throw new Error(
        \`retry single-flight opened \${databaseInitializations} databases and ran \${schemaInitializations} schemas\`,
      );
    }
    const verify = new DatabaseSync(${JSON.stringify(databasePath)});
    const installed = verify.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_chat_thread_routing_aliases_v2'"
    ).get();
    verify.close();
    if (!installed) throw new Error("schema initialization did not recover");
    localChat.setLocalChatInitializationObserversForTest(null);
  `;
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
  });
});

test("transient local routing I/O failures retry with bounded unref'ed backoff", () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
    INSERT INTO local_chat_messages VALUES ('retry_room', 1, NULL, 'Root');
    INSERT INTO local_chat_messages VALUES ('retry_room', 2, 1, 'Agent');
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  let failOnce = true;
  const wrapped = {
    prepare: database.prepare.bind(database),
    exec(sql: string) {
      if (failOnce && sql === "BEGIN IMMEDIATE") {
        failOnce = false;
        throw Object.assign(new Error("synthetic disk I/O error"), { code: "SQLITE_IOERR" });
      }
      database.exec(sql);
    },
  };
  const immediateCallbacks: Array<() => void> = [];
  const timeoutCallbacks: Array<() => void> = [];
  const delays: number[] = [];
  const errors: unknown[] = [];
  let unrefCount = 0;
  const handle = { unref() { unrefCount += 1; } };
  scheduleLocalThreadRoutingBackfill(wrapped as never, {
    onError: (error: unknown) => errors.push(error),
    setImmediate: (callback: () => void) => { immediateCallbacks.push(callback); return handle; },
    setTimeout: (callback: () => void, delayMs: number) => {
      timeoutCallbacks.push(callback);
      delays.push(delayMs);
      return handle;
    },
  });
  immediateCallbacks.shift()?.();
  assert.equal(errors.length, 1);
  assert.deepEqual(delays, [25]);
  timeoutCallbacks.shift()?.();
  assert.equal(Number(database.prepare(`
    SELECT completed FROM local_chat_thread_routing_projection_state_v2 WHERE singleton = 1
  `).get()?.completed), 1);
  assert.ok(unrefCount >= 2);
  database.close();
});

test("permanent local routing failures park after one diagnostic", () => {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => ReturnType<typeof openSqliteDb> & { close(): void };
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE local_chat_messages (
      room_id TEXT NOT NULL, number INTEGER NOT NULL, thread_root_number INTEGER, sender TEXT NOT NULL,
      PRIMARY KEY (room_id, number)
    );
    INSERT INTO local_chat_messages VALUES ('park_room', 1, NULL, 'Root');
    INSERT INTO local_chat_messages VALUES ('park_room', 2, 1, 'Agent');
  `);
  ensureLocalThreadRoutingProjectionSchema(database as never);
  const wrapped = {
    prepare: database.prepare.bind(database),
    exec(sql: string) {
      if (sql === "BEGIN IMMEDIATE") throw new Error("synthetic schema defect");
      database.exec(sql);
    },
  };
  const immediateCallbacks: Array<() => void> = [];
  const timeoutCallbacks: Array<() => void> = [];
  const diagnostics: Array<{ error: unknown; delayMs: number | null }> = [];
  const handle = { unref() {} };
  const options = {
    onError: (error: unknown, delayMs: number | null) => diagnostics.push({ error, delayMs }),
    setImmediate: (callback: () => void) => { immediateCallbacks.push(callback); return handle; },
    setTimeout: (callback: () => void) => { timeoutCallbacks.push(callback); return handle; },
  };
  scheduleLocalThreadRoutingBackfill(wrapped as never, options);
  immediateCallbacks.shift()?.();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.delayMs, null);
  assert.equal(timeoutCallbacks.length, 0);
  scheduleLocalThreadRoutingBackfill(wrapped as never, options);
  assert.equal(immediateCallbacks.length, 0, "parked database was scheduled again");
  database.close();
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

  const replacement = await resolveWorkerToolIdentity({ roomId: "identity_room" });
  assert.notEqual(replacement.agentSession.session_id, agentSession.session_id);
  assert.ok(
    getStoredAgentSession(agentSession.session_id)?.ended_at,
    "a restarted local generation atomically retires the stale durable-key representative",
  );
  assert.equal(getStoredAgentSession(replacement.agentSession.session_id)?.ended_at ?? null, null);

  const sendMessage = captureMessageToolHandler("send_message");
  await sendMessage({
    room_id: "identity_room",
    text: "persist my exact local generation",
    agent_session_id: replacement.agentSession.session_id,
  });
  const page = await getLatestLocalChatMessages("identity_room", { limit: 10 });
  const authored = page.messages.find((message) =>
    message.text === "persist my exact local generation");
  assert.equal(authored?.agent_identity?.agent_key, replacement.agentSession.agent_key);
  assert.equal(
    authored?.agent_identity?.agent_session_id,
    replacement.agentSession.session_id,
    "the official MCP local send path preserves exact syncable publisher authority",
  );
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

test("MCP local chat keeps attachment-only messages visible when prompt kind is NULL", async () => {
  const message = await addLocalChatMessage("attachment_only_room", {
    sender: "Human",
    text: "",
    source: "browser",
  });
  await addLocalChatMessage("attachment_only_room", {
    sender: "Agent",
    text: "",
    agent_prompt_kind: "auto",
    source: "agent",
  });
  const db = openSqliteDb();
  db.prepare(`
    INSERT INTO local_chat_attachments (
      room_id, message_number, attachment_id, file_name, mime_type, size_bytes,
      url, download_url, data_url, content_base64, created_at
    )
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "attachment_only_room",
    "att_only",
    "notes.txt",
    "text/plain",
    5,
    null,
    null,
    null,
    "aGVsbG8=",
    new Date().toISOString(),
  );

  const page = await getLocalChatMessages("attachment_only_room");
  assert.deepEqual(page.messages.map((entry) => entry.id), [message.id]);
  assert.equal(page.messages[0]?.attachments[0]?.id, "att_only");
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
