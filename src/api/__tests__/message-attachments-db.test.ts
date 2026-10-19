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
const deletePendingMessageAttachmentUpload = dbModule?.deletePendingMessageAttachmentUpload;
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
      uploader: null,
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
      uploader: null,
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
      uploader: null,
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

test("desktop submission retry is immutable across owners, text, thread, and attachments", { skip: requiresDatabase }, async () => {
  const room = await createProjectWithName!("desktop-outbox-replay");
  const root = await addMessage!(room.id, "Human", "Root", { source: "browser" });
  await createMessageAttachmentUpload!({
    upload_id: "upl_desktop_outbox", room_id: room.id, uploader: null, filename: "note.txt", content_type: "text/plain", byte_size: 3,
    storage_provider: "s3", bucket: "letagents-test", object_key: "test/outbox/note.txt",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const options = {
    source: "browser", account_id: "acct_desktop", reply_to_message_id: root.id, thread_root_message_id: root.id,
    client_message_id: "desktop-send:32571cb6-3fe9-48a1-9b3c-28f775bdc724",
    attachments: [{ upload_id: "upl_desktop_outbox" }],
  };
  const first = await addMessageWithCreateStatus!(room.id, "Human", "Instruction", options);
  const replay = await addMessageWithCreateStatus!(room.id, "Human", "Instruction", options);
  assert.equal(replay.created, false);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.message.client_message_id, options.client_message_id);
  await assert.rejects(addMessageWithCreateStatus!(room.id, "Human", "Changed", options), /different content/);
  await assert.rejects(addMessageWithCreateStatus!(room.id, "Human", "Instruction", { ...options, account_id: "other" }), /another writer/);
  await assert.rejects(addMessageWithCreateStatus!(room.id, "Human", "Instruction", { ...options, thread_root_message_id: undefined }), /different content/);
  await assert.rejects(addMessageWithCreateStatus!(room.id, "Human", "Instruction", { ...options, attachments: [] }), /different attachments/);
});

for (const stage of ["attachments", "thread-read", "routing"] as const) {
  test(`${stage} hydration failure rolls back message, attachments and receipts; retry publishes once`, {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
  }, async (t) => {
    if (!pool || !createProjectWithName || !createMessageAttachmentUpload || !getMessageAttachmentUpload) throw new Error("database required");
    const { Client } = await import("pg");
    const { emitProjectMessage, messageEvents } = await import("../server/events.js");
    const room = await createProjectWithName("publication-retry");
    const account = await dbModule!.upsertAccount({ provider: "test", provider_user_id: "publication", login: "publication" });
    await pool.query(`INSERT INTO room_agent_sessions (
      session_id, room_id, token_hash, session_kind, runtime, actor_label,
      agent_key, agent_instance_id, display_name, owner_account_id,
      owner_label, ide_label, created_at, updated_at, last_seen_at
    ) VALUES ('publication_session', $1, 'publication_hash', 'worker', 'test', 'Publication',
      'test/publication', 'publication', 'Publication', $2, 'Human', 'Codex', NOW(), NOW(), NOW())`, [room.id, account.id]);
    const root = await addMessage!(room.id, "human", "root", { source: "browser" });
    await createMessageAttachmentUpload({
      upload_id: "upl_publication_failure", room_id: room.id, uploader: null, filename: "notes.txt", content_type: "text/plain",
      byte_size: 4, storage_provider: "s3", bucket: "test", object_key: "notes", expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const published: unknown[] = [];
    const listener = (event: { projectId: string }) => { if (event.projectId === room.id) published.push(event); };
    messageEvents.on("message:created", listener);
    t.after(() => messageEvents.off("message:created", listener));
    const originalQuery = Client.prototype.query;
    let failHydration = true;
    t.mock.method(Client.prototype, "query", function(this: InstanceType<typeof Client>, ...args: unknown[]) {
      const query = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text ?? "";
      const targetQuery = stage === "attachments"
        ? /^select /i.test(query) && query.includes('from "message_attachments"')
        : stage === "thread-read"
        ? /^select /i.test(query) && query.includes('from "message_thread_reads"')
        : query.includes("WITH requested_account AS");
      if (failHydration && targetQuery) {
        const error = new Error("injected hydration failure");
        const callback = args.at(-1);
        if (typeof callback === "function") { callback(error); return; }
        return Promise.reject(error);
      }
      return (originalQuery as (...args: unknown[]) => unknown).apply(this, args);
    });
    const options = { source: "browser", account_id: account.id, account_agent_routing: true,
      reply_to: root.id, thread_root_id: root.id, client_message_id: "publication-retry-1",
      attachments: [{ upload_id: "upl_publication_failure" }] };
    await assert.rejects(emitProjectMessage(room.id, "human", "@test/publication see attached", options), (error: unknown) => (error as { cause?: Error }).cause?.message === "injected hydration failure");
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM messages WHERE room_id = $1 AND client_message_id IS NOT NULL', [room.id])).rows[0].count, 0);
    assert.equal((await getMessageAttachmentUpload(room.id, "upl_publication_failure"))?.status, "pending");
    assert.equal(published.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM message_agent_receipts WHERE message_room_id = $1', [room.id])).rows[0].count, 0);
    failHydration = false;
    const saved = await emitProjectMessage(room.id, "human", "@test/publication see attached", options);
    const replay = await emitProjectMessage(room.id, "human", "@test/publication see attached", options);
    assert.equal(saved.id, replay.id);
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.reply_to?.id, root.id);
    assert.equal(saved.thread?.reply_count, 1);
    assert.deepEqual(saved.account_agent_routing?.recipient_agent_keys, ["test/publication"]);
    assert.deepEqual(replay.account_agent_routing, saved.account_agent_routing);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM message_agent_receipts WHERE message_room_id = $1', [room.id])).rows[0].count, 1);
    assert.deepEqual(replay.attachments, saved.attachments);
    assert.equal(published.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM messages WHERE room_id = $1 AND client_message_id IS NOT NULL', [room.id])).rows[0].count, 1);
  });
}

function stagedUpload(roomId: string, uploadId: string, overrides: {
  uploader?: { account_id: string | null; agent_session_id: string | null } | null;
  expires_at?: string;
} = {}) {
  return createMessageAttachmentUpload!({
    upload_id: uploadId,
    room_id: roomId,
    uploader: overrides.uploader ?? null,
    filename: "notes.txt",
    content_type: "text/plain",
    byte_size: 5,
    storage_provider: "s3",
    bucket: "letagents-test",
    object_key: `rooms/${roomId}/uploads/${uploadId}/notes.txt`,
    expires_at: overrides.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
  });
}

const accountA = { account_id: "acct_a", agent_session_id: null };
const accountB = { account_id: "acct_b", agent_session_id: null };
const sessionA = { account_id: null, agent_session_id: "sess_a" };
const sessionB = { account_id: null, agent_session_id: "sess_b" };

test("only the uploader can attach its upload; unowned legacy uploads stay open to the room", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const room = await createProjectWithName!("upload-owner-claim");
  await stagedUpload(room.id, "upl_owner_account_a", { uploader: accountA });
  await stagedUpload(room.id, "upl_owner_session_a", { uploader: sessionA });
  await stagedUpload(room.id, "upl_owner_legacy_row");

  const attach = (uploadId: string, uploader: typeof accountA | typeof sessionA | null) =>
    addMessage!(room.id, "sender", "see attached", {
      source: "browser",
      attachments: [{ upload_id: uploadId }],
      attachment_uploader: uploader,
    });

  for (const [uploadId, uploader] of [
    ["upl_owner_account_a", accountB],
    ["upl_owner_account_a", sessionA],
    ["upl_owner_account_a", null],
    ["upl_owner_session_a", sessionB],
    ["upl_owner_session_a", { account_id: "sess_a", agent_session_id: null }],
    ["upl_owner_session_a", null],
  ] as const) {
    await assert.rejects(attach(uploadId, uploader), /attachment upload not found or expired/);
  }
  assert.equal((await getMessageAttachmentUpload!(room.id, "upl_owner_account_a"))?.status, "pending");
  assert.equal((await getMessageAttachmentUpload!(room.id, "upl_owner_session_a"))?.status, "pending");

  assert.equal((await attach("upl_owner_account_a", accountA)).attachments.length, 1);
  assert.equal((await attach("upl_owner_session_a", sessionA)).attachments.length, 1);
  assert.equal((await attach("upl_owner_legacy_row", accountB)).attachments.length, 1);

  const owned = await getMessageAttachmentUpload!(room.id, "upl_owner_session_a");
  assert.equal(owned?.uploader_agent_session_id, "sess_a");
  assert.equal(owned?.uploader_account_id, null);
});

test("a rejected attachment rolls back the whole send, including the uploads it did own", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const room = await createProjectWithName!("upload-owner-mixed");
  await stagedUpload(room.id, "upl_mixed_own_upload", { uploader: accountA });
  await stagedUpload(room.id, "upl_mixed_other_upload", { uploader: accountB });

  await assert.rejects(addMessage!(room.id, "sender", "two files", {
    source: "browser",
    attachments: [{ upload_id: "upl_mixed_own_upload" }, { upload_id: "upl_mixed_other_upload" }],
    attachment_uploader: accountA,
  }), /attachment upload not found or expired/);
  assert.equal((await getMessageAttachmentUpload!(room.id, "upl_mixed_own_upload"))?.status, "pending");
  assert.equal((await getMessages!(room.id)).messages.length, 0);
});

test("only the uploader can discard its pending upload", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const room = await createProjectWithName!("upload-owner-discard");
  await stagedUpload(room.id, "upl_discard_account_a", { uploader: accountA });
  await stagedUpload(room.id, "upl_discard_session_a", { uploader: sessionA });
  await stagedUpload(room.id, "upl_discard_legacy_row");

  assert.equal(await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_account_a", accountB), undefined);
  assert.equal(await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_account_a", null), undefined);
  assert.equal(await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_session_a", sessionB), undefined);
  assert.ok(await getMessageAttachmentUpload!(room.id, "upl_discard_account_a"));
  assert.ok(await getMessageAttachmentUpload!(room.id, "upl_discard_session_a"));

  assert.equal((await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_account_a", accountA))?.upload_id, "upl_discard_account_a");
  assert.equal((await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_session_a", sessionA))?.upload_id, "upl_discard_session_a");
  assert.equal((await deletePendingMessageAttachmentUpload!(room.id, "upl_discard_legacy_row", null))?.upload_id, "upl_discard_legacy_row");
  assert.equal(await getMessageAttachmentUpload!(room.id, "upl_discard_account_a"), undefined);
});

test("an upload row cannot name both an account and an agent session", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const room = await createProjectWithName!("upload-owner-check");
  await stagedUpload(room.id, "upl_check_both_owner", { uploader: accountA });
  await assert.rejects(
    pool!.query(
      "UPDATE message_attachment_uploads SET uploader_agent_session_id = 'sess_a' WHERE upload_id = 'upl_check_both_owner'",
    ),
    /message_attachment_uploads_single_uploader_check/,
  );
});

const cleanupModule = () => import("../server/attachment-upload-cleanup.js");

test("expired pending uploads and their objects are removed; a failed object keeps its row for the next pass", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const { cleanupExpiredAttachmentUploadsOnce, ATTACHMENT_UPLOAD_CLEANUP_BATCH, ATTACHMENT_UPLOAD_CLEANUP_GRACE_MS } =
    await cleanupModule();
  const room = await createProjectWithName!("upload-cleanup");
  const now = Date.now();
  const longExpired = new Date(now - ATTACHMENT_UPLOAD_CLEANUP_GRACE_MS - 60 * 60_000).toISOString();
  const expiredCount = ATTACHMENT_UPLOAD_CLEANUP_BATCH + 5;
  for (let index = 0; index < expiredCount; index++) {
    await stagedUpload(room.id, `upl_cleanup_expired_${String(index).padStart(3, "0")}`, {
      uploader: accountA,
      expires_at: longExpired,
    });
  }
  // Inside the grace window, still live, and already attached: all kept.
  await stagedUpload(room.id, "upl_cleanup_in_grace", {
    expires_at: new Date(now - ATTACHMENT_UPLOAD_CLEANUP_GRACE_MS + 60_000).toISOString(),
  });
  await stagedUpload(room.id, "upl_cleanup_still_live", { uploader: accountA });
  await stagedUpload(room.id, "upl_cleanup_attached", { uploader: accountA });
  await addMessage!(room.id, "sender", "attached", {
    source: "browser",
    attachments: [{ upload_id: "upl_cleanup_attached" }],
    attachment_uploader: accountA,
  });
  await pool!.query(
    "UPDATE message_attachment_uploads SET expires_at = $1 WHERE upload_id = 'upl_cleanup_attached'",
    [longExpired],
  );

  const state = { cursor: null };
  const disabled = await cleanupExpiredAttachmentUploadsOnce({
    now: () => now,
    storageConfigured: () => false,
    deleteObject: async () => assert.fail("no object deletes without storage"),
  }, state);
  assert.deepEqual(disabled, { deleted: 0, object_failures: 0 });

  const deletedKeys: string[] = [];
  const first = await cleanupExpiredAttachmentUploadsOnce({
    now: () => now,
    storageConfigured: () => true,
    deleteObject: async ({ object_key }) => {
      if (object_key.includes("upl_cleanup_expired_003")) throw new Error("storage unavailable");
      deletedKeys.push(object_key);
    },
  }, state);
  assert.deepEqual(first, { deleted: expiredCount - 1, object_failures: 1 });
  assert.equal(deletedKeys.length, expiredCount - 1);
  assert.ok(deletedKeys.every((key) => key.includes("upl_cleanup_expired_")));
  assert.equal(state.cursor, null, "a finished pass starts over next time");

  const remaining = async () => (await pool!.query<{ upload_id: string }>(
    "SELECT upload_id FROM message_attachment_uploads WHERE room_id = $1 ORDER BY upload_id",
    [room.id],
  )).rows.map((row) => row.upload_id);
  assert.deepEqual(await remaining(), [
    "upl_cleanup_attached",
    "upl_cleanup_expired_003",
    "upl_cleanup_in_grace",
    "upl_cleanup_still_live",
  ]);

  const retried = await cleanupExpiredAttachmentUploadsOnce({
    now: () => now,
    storageConfigured: () => true,
    deleteObject: async () => {},
  }, state);
  assert.deepEqual(retried, { deleted: 1, object_failures: 0 });
  assert.deepEqual(await remaining(), ["upl_cleanup_attached", "upl_cleanup_in_grace", "upl_cleanup_still_live"]);
});

test("a cleanup tick stops at its batch cap, and the next tick resumes past rows that keep failing", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const { cleanupExpiredAttachmentUploadsOnce, ATTACHMENT_UPLOAD_CLEANUP_BATCH, MAX_ATTACHMENT_UPLOAD_CLEANUP_BATCHES_PER_TICK } =
    await cleanupModule();
  const room = await createProjectWithName!("upload-cleanup-cap");
  const perTick = ATTACHMENT_UPLOAD_CLEANUP_BATCH * MAX_ATTACHMENT_UPLOAD_CLEANUP_BATCHES_PER_TICK;
  const base = Date.now() - 3 * 60 * 60_000;
  for (let index = 0; index < perTick + 10; index++) {
    await stagedUpload(room.id, `upl_cleanup_cap_${String(index).padStart(3, "0")}`, {
      expires_at: new Date(base + index * 1000).toISOString(),
    });
  }
  // The oldest perTick objects can never be deleted.
  const failing = (key: string) => Number(key.match(/upl_cleanup_cap_(\d+)/)?.[1]) < perTick;
  const state = { cursor: null };
  const deps = {
    now: () => Date.now(),
    storageConfigured: () => true,
    deleteObject: async ({ object_key }: { object_key: string }) => {
      if (failing(object_key)) throw new Error("access denied");
    },
  };

  assert.deepEqual(await cleanupExpiredAttachmentUploadsOnce(deps, state), { deleted: 0, object_failures: perTick });
  assert.equal((state.cursor as { upload_id: string } | null)?.upload_id, `upl_cleanup_cap_${String(perTick - 1).padStart(3, "0")}`);
  assert.deepEqual(await cleanupExpiredAttachmentUploadsOnce(deps, state), { deleted: 10, object_failures: 0 });
  assert.equal(state.cursor, null);
  const { rows } = await pool!.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM message_attachment_uploads WHERE room_id = $1",
    [room.id],
  );
  assert.equal(rows[0].count, perTick);
});

test("cleanup keeps a row a send attached meanwhile, and an aborted tick stops between objects", {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed attachment tests" : false,
}, async () => {
  const { cleanupExpiredAttachmentUploadsOnce } = await cleanupModule();
  const room = await createProjectWithName!("upload-cleanup-race");
  const longExpired = (offset: number) => new Date(Date.now() - 3 * 60 * 60_000 + offset).toISOString();
  await stagedUpload(room.id, "upl_cleanup_race_claimed", { expires_at: longExpired(0) });
  await stagedUpload(room.id, "upl_cleanup_race_second", { expires_at: longExpired(1000) });
  await stagedUpload(room.id, "upl_cleanup_race_third", { expires_at: longExpired(2000) });

  const abort = new AbortController();
  const seen: string[] = [];
  const result = await cleanupExpiredAttachmentUploadsOnce({
    now: () => Date.now(),
    storageConfigured: () => true,
    deleteObject: async ({ object_key }, { signal }) => {
      assert.equal(signal, abort.signal);
      seen.push(object_key);
      if (object_key.includes("upl_cleanup_race_claimed")) {
        // A send with a clock skewed by over an hour claimed the row while its
        // object was being deleted. The row must survive (it now backs a
        // message); its bytes are gone, which the grace window makes unreachable in practice.
        await pool!.query("UPDATE message_attachment_uploads SET status = 'attached' WHERE upload_id = 'upl_cleanup_race_claimed'");
      } else {
        abort.abort();
      }
    },
  }, { cursor: null }, abort.signal);

  assert.deepEqual(result, { deleted: 1, object_failures: 0 });
  assert.equal(seen.length, 2, "the tick stopped once aborted");
  assert.equal((await getMessageAttachmentUpload!(room.id, "upl_cleanup_race_claimed"))?.status, "attached");
  assert.equal(await getMessageAttachmentUpload!(room.id, "upl_cleanup_race_second"), undefined);
  assert.ok(await getMessageAttachmentUpload!(room.id, "upl_cleanup_race_third"));
});
