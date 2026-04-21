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
const createMessageAttachmentUpload = dbModule?.createMessageAttachmentUpload;
const createProjectWithName = dbModule?.createProjectWithName;
const getMessageAttachment = dbModule?.getMessageAttachment;
const getMessageAttachmentUpload = dbModule?.getMessageAttachmentUpload;
const getMessages = dbModule?.getMessages;

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
