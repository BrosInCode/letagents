import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const addMessage = dbModule?.addMessage;
const addMessageWithCreateStatus = dbModule?.addMessageWithCreateStatus;
const createMessageAttachmentUpload = dbModule?.createMessageAttachmentUpload;
const createProjectWithName = dbModule?.createProjectWithName;
const getMessageAttachment = dbModule?.getMessageAttachment;
const getMessageAttachmentUpload = dbModule?.getMessageAttachmentUpload;
const getMessages = dbModule?.getMessages;
const getMessageThread = dbModule?.getMessageThread;
const getMessageThreads = dbModule?.getMessageThreads;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed attachment tests require TEST_DB_URL");
  }

  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

test(
  "messages claim pending attachment uploads and expose metadata",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
  },
  async () => {
    if (
      !addMessage ||
      !createMessageAttachmentUpload ||
      !createProjectWithName ||
      !getMessageAttachment ||
      !getMessageAttachmentUpload ||
      !getMessages
    ) {
      throw new Error("DB-backed attachment tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("attachment-room");
    await createMessageAttachmentUpload({
      upload_id: "upl_1234567890abcdef",
      room_id: room.id,
      filename: "notes.txt",
      content_type: "text/plain",
      byte_size: Buffer.byteLength("attachment contents"),
      storage_provider: "s3",
      bucket: "letagents-test",
      object_key: "rooms/attachment-room/uploads/upl_1234567890abcdef/notes.txt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const message = await addMessage(room.id, "human", "see attached", {
      source: "browser",
      attachments: [{ upload_id: "upl_1234567890abcdef" }],
    });

    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].id, "att_1");
    assert.equal(message.attachments[0].filename, "notes.txt");
    assert.equal(message.attachments[0].download_url, "/rooms/attachment-room/messages/msg_1/attachments/att_1");

    const page = await getMessages(room.id);
    assert.equal(page.messages[0].attachments.length, 1);
    assert.equal(page.messages[0].attachments[0].content_type, "text/plain");

    const attachment = await getMessageAttachment(room.id, message.id, "att_1");
    assert.equal(attachment?.object_key, "rooms/attachment-room/uploads/upl_1234567890abcdef/notes.txt");
    assert.equal(attachment?.bucket, "letagents-test");
    assert.equal(attachment?.byte_size, Buffer.byteLength("attachment contents"));

    const upload = await getMessageAttachmentUpload(room.id, "upl_1234567890abcdef");
    assert.equal(upload?.status, "attached");
    assert.equal(upload?.attached_message_number, 1);
  }
);

test(
  "idempotent message retries return hydrated attachments and thread metadata",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
  },
  async () => {
    if (
      !addMessage ||
      !addMessageWithCreateStatus ||
      !createMessageAttachmentUpload ||
      !createProjectWithName
    ) {
      throw new Error("DB-backed attachment tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("idempotent-thread-room");
    const root = await addMessage(room.id, "human", "root", { source: "browser" });
    await createMessageAttachmentUpload({
      upload_id: "upl_idempotent_retry",
      room_id: room.id,
      filename: "diagram.png",
      content_type: "image/png",
      byte_size: 42,
      storage_provider: "s3",
      bucket: "letagents-test",
      object_key: "rooms/idempotent-thread-room/uploads/upl_idempotent_retry/diagram.png",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const created = await addMessageWithCreateStatus(room.id, "human", "reply", {
      source: "browser",
      reply_to_message_id: root.id,
      thread_root_message_id: root.id,
      attachments: [{ upload_id: "upl_idempotent_retry" }],
      client_message_id: "client-thread-retry",
      account_id: "acct_1",
    });
    const retried = await addMessageWithCreateStatus(room.id, "human", "reply", {
      source: "browser",
      client_message_id: "client-thread-retry",
      account_id: "acct_1",
    });

    assert.equal(created.created, true);
    assert.equal(retried.created, false);
    assert.equal(retried.message.id, created.message.id);
    assert.equal(retried.message.reply_to?.id, root.id);
    assert.equal(retried.message.attachments.length, 1);
    assert.equal(retried.message.attachments[0].filename, "diagram.png");
    assert.equal(retried.message.thread?.root_message_id, root.id);
    assert.equal(retried.message.thread?.reply_count, 1);
    assert.equal(retried.message.thread?.latest_reply?.id, created.message.id);
  }
);

test(
  "attachment-only messages with NULL prompt kind survive history and thread summaries",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
  },
  async () => {
    if (
      !addMessage ||
      !createMessageAttachmentUpload ||
      !createProjectWithName ||
      !getMessages ||
      !getMessageThread ||
      !getMessageThreads
    ) {
      throw new Error("DB-backed attachment tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("attachment-only-visibility-room");
    await createMessageAttachmentUpload({
      upload_id: "upl_attachment_only_visibility",
      room_id: room.id,
      filename: "notes.txt",
      content_type: "text/plain",
      byte_size: 5,
      storage_provider: "s3",
      bucket: "letagents-test",
      object_key: "rooms/attachment-only-visibility-room/notes.txt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const attachmentOnly = await addMessage(room.id, "human", "", {
      source: "browser",
      attachments: [{ upload_id: "upl_attachment_only_visibility" }],
    });
    const attachmentReply = await addMessage(room.id, "agent", "", {
      source: "agent",
      reply_to_message_id: attachmentOnly.id,
      thread_root_message_id: attachmentOnly.id,
    });
    const hiddenPrompt = await addMessage(room.id, "agent", "", {
      source: "agent",
      agent_prompt_kind: "auto",
    });

    const history = await getMessages(room.id);
    assert.deepEqual(history.messages.map((message) => message.id), [
      attachmentOnly.id,
      attachmentReply.id,
    ]);
    assert.equal(history.messages[0]?.attachments[0]?.filename, "notes.txt");
    assert.equal(history.messages.some((message) => message.id === hiddenPrompt.id), false);

    const thread = await getMessageThread(room.id, attachmentOnly.id);
    assert.deepEqual(thread?.replies.map((message) => message.id), [attachmentReply.id]);
    assert.equal(thread?.summary.reply_count, 1);
    assert.equal(thread?.summary.latest_reply?.id, attachmentReply.id);

    const inbox = await getMessageThreads(room.id);
    assert.deepEqual(inbox.threads.map((item) => item.root.id), [attachmentOnly.id]);
    assert.equal(inbox.threads[0]?.summary.latest_reply?.id, attachmentReply.id);
  },
);

test("system display copy survives storage, retries, history, and quoted replies without changing agent text", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed message tests" : false,
}, async () => {
  if (!addMessageWithCreateStatus || !addMessage || !createProjectWithName || !getMessages || !getMessageThread) {
    throw new Error("DB-backed message tests require TEST_DB_URL");
  }
  const room = await createProjectWithName("board-notification-display-room");
  const text = "@agent:owner/lumen Board intent bi_123 was approved. Continue with board_intent_id.";
  const display_text = "@LumenRiver — Your request to claim task_19: “Tests and CI” was approved. You can continue.";
  const first = await addMessageWithCreateStatus(room.id, "letagents", text, {
    source: "system", display_text, client_message_id: "board_intent:bi_123:approved:proposer_notify",
  });
  assert.equal(first.message.text, text);
  assert.equal(first.message.display_text, display_text);
  assert.equal(first.canonical_message.display_text, display_text);
  const replay = await addMessageWithCreateStatus(room.id, "letagents", text, {
    source: "system", display_text: "Changed during retry", client_message_id: "board_intent:bi_123:approved:proposer_notify",
  });
  assert.equal(replay.created, false);
  assert.equal(replay.message.display_text, display_text);
  const reply = await addMessage(room.id, "EmmyMay", "Thanks", {
    source: "browser", reply_to_message_id: first.message.id, thread_root_message_id: first.message.id,
  });
  assert.equal(reply.reply_to?.text, text);
  assert.equal(reply.reply_to?.display_text, display_text);
  const history = await getMessages(room.id);
  assert.equal(history.messages.find((message) => message.id === first.message.id)?.display_text, display_text);
  assert.equal(history.messages.find((message) => message.id === reply.id)?.reply_to?.display_text, display_text);
  // Public message writes cannot use presentation copy to hide their real text.
  const ordinary = await addMessage(room.id, "EmmyMay", "Original", { source: "browser", display_text: "Hidden replacement" });
  assert.equal(ordinary.display_text, undefined);
});
