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


test("deletion removes a reply, repairs thread counts, and prevents replay", { skip: requiresDatabase }, async () => {
  const { deleteRoomMessage } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-thread");
  const root = await addMessageWithCreateStatus!(room.id, "owner", "root", { account_id: "owner" });
  const first = await addMessageWithCreateStatus!(room.id, "owner", "first", { account_id: "owner", thread_root_message_id: root.message.id, client_message_id: "delete-replay" });
  await addMessageWithCreateStatus!(room.id, "other", "second", { account_id: "other", thread_root_message_id: root.message.id });
  await assert.rejects(deleteRoomMessage({ roomId: room.id, messageId: first.message.id, accountId: "other", admin: false }), /own messages/);
  await assert.rejects(deleteRoomMessage({ roomId: room.id, messageId: root.message.id, accountId: "owner", admin: true }), /whole thread/);
  await deleteRoomMessage({ roomId: room.id, messageId: first.message.id, accountId: "owner", admin: false });
  const summary = await pool!.query("SELECT reply_count FROM message_thread_summaries WHERE room_id=$1", [room.id]);
  assert.equal(summary.rows[0].reply_count, 1);
  await assert.rejects(addMessageWithCreateStatus!(room.id, "owner", "first", { account_id: "owner", thread_root_message_id: root.message.id, client_message_id: "delete-replay" }), /permanently deleted/);
  await deleteRoomMessage({ roomId: room.id, messageId: root.message.id, accountId: "owner", admin: true, thread: true });
  assert.equal((await pool!.query("SELECT * FROM messages WHERE room_id=$1", [room.id])).rowCount, 0);
  assert.equal((await pool!.query("SELECT thread_count FROM message_room_thread_stats WHERE room_id=$1", [room.id])).rows[0].thread_count, 0);
});

test("sent attachment deletion queues object cleanup and preserves its message", { skip: requiresDatabase }, async () => {
  const { deleteRoomMessage } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-attachment");
  await createMessageAttachmentUpload!({ upload_id: "upl_delete12345678", room_id: room.id, filename: "notes.txt", content_type: "text/plain", byte_size: 5, storage_provider: "s3", bucket: "test", object_key: "delete-test/notes", expires_at: new Date(Date.now()+60000).toISOString() });
  const result = await addMessageWithCreateStatus!(room.id, "owner", "keep", { account_id: "owner", attachments: [{ upload_id: "upl_delete12345678" }] });
  await deleteRoomMessage({ roomId: room.id, messageId: result.message.id, accountId: "owner", admin: false, attachmentId: "att_1" });
  assert.equal((await pool!.query("SELECT text FROM messages WHERE room_id=$1", [room.id])).rows[0].text, "keep");
  assert.equal((await pool!.query("SELECT * FROM message_attachments WHERE room_id=$1", [room.id])).rowCount, 0);
  assert.equal((await pool!.query("SELECT object_key FROM attachment_deletion_queue")).rows[0].object_key, "delete-test/notes");
});


test("task deletion blocks active work, removes the task and rejects stale recreation and leases", { skip: requiresDatabase }, async () => {
  const { deleteRoomTask } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-task");
  const task = await dbModule!.createTask(room.id, "Delete me", "owner", undefined, undefined, { clientTaskId: "delete-task-key" });
  await pool!.query("UPDATE tasks SET status='in_progress' WHERE room_id=$1", [room.id]);
  await assert.rejects(deleteRoomTask(room.id, task.id), /Cancel the task/);
  await pool!.query("UPDATE tasks SET status='cancelled' WHERE room_id=$1", [room.id]);
  await deleteRoomTask(room.id, task.id);
  assert.equal((await dbModule!.getTasks(room.id)).tasks.length, 0);
  await assert.rejects(dbModule!.createTask(room.id, "Delete me", "owner", undefined, undefined, { clientTaskId: "delete-task-key" }));
  const { createTaskLease } = await import("../db/coordination/task-leases.js");
  await assert.rejects(createTaskLease({ room_id: room.id, task_id: task.id, kind: "review", agent_key: "reviewer", actor_label: "reviewer", created_by: "owner" }), (error: any) => error.cause?.message === "Task no longer exists.");
});

test("room deletion removes child rooms and all content, queues pending files and prevents auto recreation", { skip: requiresDatabase }, async () => {
  const { deleteRoomData } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-room");
  await pool!.query("INSERT INTO rooms(id,display_name,kind,parent_room_id,focus_key,focus_status,created_at) VALUES ('focus_999','Child','focus',$1,'delete-child','active',now())", [room.id]);
  const root = await addMessage!(room.id, "owner", "root");
  await addMessage!(room.id, "owner", "reply", { thread_root_message_id: root.id });
  await addMessage!("focus_999", "owner", "child");
  await createMessageAttachmentUpload!({ upload_id: "upl_room_delete", room_id: "focus_999", filename: "notes.txt", content_type: "text/plain", byte_size: 5, storage_provider: "s3", bucket: "test", object_key: "delete-room/pending", expires_at: new Date(Date.now()+60000).toISOString() });
  await deleteRoomData(room.id);
  assert.equal((await pool!.query("SELECT * FROM rooms")).rowCount, 0);
  assert.equal((await pool!.query("SELECT * FROM messages")).rowCount, 0);
  assert.equal((await pool!.query("SELECT * FROM message_thread_summaries")).rowCount, 0);
  assert.equal((await pool!.query("SELECT * FROM attachment_deletion_queue")).rows[0].object_key, "delete-room/pending");
  await assert.rejects(createProjectWithName!("delete-room"));
});


test("message deletion rejects active agent work and releases after acknowledgement", { skip: requiresDatabase }, async () => {
  const { deleteRoomMessage } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-busy-message");
  const message = await addMessage!(room.id, "owner", "working");
  await pool!.query(`INSERT INTO message_agent_receipts(id,message_room_id,message_number,room_id,agent_session_id,agent_key,actor_label,activation_reason,receipt_state,created_at,updated_at) VALUES ('busy-receipt',$1,1,$1,'busy-session','busy-agent','Agent','mention','responding',now(),now())`, [room.id]);
  await assert.rejects(deleteRoomMessage({ roomId: room.id, messageId: message.id, accountId: "owner", admin: true }), /Stop the agents/);
  await pool!.query("UPDATE message_agent_receipts SET receipt_state='replied' WHERE id='busy-receipt'");
  await deleteRoomMessage({ roomId: room.id, messageId: message.id, accountId: "owner", admin: true });
  assert.equal((await pool!.query("SELECT * FROM message_agent_receipts")).rowCount, 0);
});


test("message deletion revokes summaries and pending notifications before rebuilding history", { skip: requiresDatabase }, async () => {
  const { deleteRoomMessage } = await import("../db/content-deletion.js");
  const history = await import("../history-summary/store.js");
  const room = await createProjectWithName!("delete-derived-history");
  const message = await addMessage!(room.id, "owner", "private text to remove");
  await history.startOrWakeRoomHistory(room.id);
  const [claim] = await history.claimRoomHistoryRooms(1);
  await history.ingestRoomHistoryMessages(claim);
  assert.ok((await pool!.query("SELECT * FROM room_history_summary_nodes WHERE room_id=$1", [room.id])).rowCount);
  await pool!.query(`INSERT INTO agent_wake_rules (id,room_id,agent_key,agent_name,event,arguments,identity_key,cursor_at,created_at,updated_at,delivery_kind,delivery_target)
    VALUES ('delete-rule',$1,'agent','Agent','room.message','{}','delete-rule',now(),now(),now(),'webhook','{"sealed":"unused"}')`, [room.id]);
  await pool!.query(`INSERT INTO wake_webhook_deliveries (id,rule_id,room_id,message_number,sender,text_preview,state,scheduled_at,next_attempt_at,created_at,updated_at)
    VALUES ('delete-delivery','delete-rule',$1,1,'owner','private text to remove','processing',now(),now(),now(),now())`, [room.id]);
  await assert.rejects(deleteRoomMessage({ roomId: room.id, messageId: message.id, accountId: "owner", admin: true }), /notification/);
  await pool!.query("UPDATE wake_webhook_deliveries SET state='retry' WHERE id='delete-delivery'");
  await deleteRoomMessage({ roomId: room.id, messageId: message.id, accountId: "owner", admin: true });
  assert.equal((await pool!.query("SELECT * FROM room_history_summary_nodes WHERE room_id=$1", [room.id])).rowCount, 0);
  assert.equal((await pool!.query("SELECT * FROM wake_webhook_deliveries WHERE room_id=$1", [room.id])).rowCount, 0);
  assert.equal(await history.writeRoomHistoryLine(claim, 0, 0, "private text to remove"), false);
  const state = (await pool!.query("SELECT claim_token,next_number,leaf_count FROM room_history_summary_state WHERE room_id=$1", [room.id])).rows[0];
  assert.deepEqual(state, { claim_token: null, next_number: 2, leaf_count: 0 });
});

test("task deletion removes only its planning entry and advances the edit revision", { skip: requiresDatabase }, async () => {
  const { deleteRoomTask } = await import("../db/content-deletion.js");
  const { defaultBoardPlanning } = await import("../../../shared/board-planning.mjs");
  const room = await createProjectWithName!("delete-planned-task");
  const task = await dbModule!.createTask(room.id, "Delete planned task", "owner");
  await pool!.query("UPDATE tasks SET external_ref='jira:DELETED-1' WHERE room_id=$1 AND number=$2", [room.id, Number(task.id.slice(5))]);
  const document = { ...defaultBoardPlanning(), tasks: { [task.id]: { points: 3 }, task_999: { points: 5 } } };
  await pool!.query("INSERT INTO room_board_planning(room_id,document,updated_by,revision) VALUES ($1,$2,'owner',7)", [room.id, document]);
  await deleteRoomTask(room.id, task.id);
  const result = (await pool!.query("SELECT document,revision FROM room_board_planning WHERE room_id=$1", [room.id])).rows[0];
  const replay = await pool!.query("INSERT INTO tasks(room_id,number,title,created_by,external_ref,created_at,updated_at) VALUES ($1,99,'replayed','import','jira:DELETED-1',now(),now()) RETURNING number", [room.id]);
  assert.equal(replay.rowCount, 0);
  assert.equal(result.revision, 8);
  assert.deepEqual(result.document, { ...document, tasks: { task_999: { points: 5 } } });
});


test("room removal requires closing agent requests and removes their retained records", { skip: requiresDatabase }, async () => {
  const { deleteRoomData } = await import("../db/content-deletion.js");
  const room = await createProjectWithName!("delete-asked-room");
  const account = await dbModule!.upsertAccount({ provider: "github", provider_user_id: "delete-owner", login: "owner" });
  await pool!.query(`INSERT INTO agent_asks(id,link_token_hash,room_id,asker_account_id,provider_id,model_label,expires_at)
    VALUES ('delete-ask','delete-token',$1,$2,'claude-code','Claude',now()+interval '1 day')`, [room.id, account.id]);
  await assert.rejects(deleteRoomData(room.id), /agent requests/);
  assert.equal((await pool!.query("SELECT id FROM rooms WHERE id=$1", [room.id])).rowCount, 1);
  await pool!.query("UPDATE agent_asks SET state='cancelled',ended_at=now() WHERE id='delete-ask'");
  await pool!.query("INSERT INTO agent_ask_reads(id,ask_id,kind,target) VALUES ('deleted-read','delete-ask','file','README.md')");
  await deleteRoomData(room.id);
  assert.equal((await pool!.query("SELECT id FROM agent_asks")).rowCount, 0);
  assert.equal((await pool!.query("SELECT id FROM agent_ask_reads")).rowCount, 0);
});


test("room deletion fences external actions and returns gone to stale clients", { skip: requiresDatabase }, async () => {
  const { deleteRoomData } = await import("../db/content-deletion.js");
  const { resolveRoomOrReply } = await import("../rooms/resolution.js");
  const room = await createProjectWithName!("delete-effect-room");
  await pool!.query(`INSERT INTO workflow_effects(id,room_id,task_id,kind,provider,idempotency_key,correlation_key,request_fingerprint,request_payload,
    processing_token,processing_started_at,created_by,created_at,updated_at) VALUES ('deleting-effect',$1,'task_1','tracker_comment','jira','retry','correlation','fingerprint','{}','active',now(),'owner',now(),now())`, [room.id]);
  await assert.rejects(deleteRoomData(room.id), /external actions/);
  await pool!.query("UPDATE workflow_effects SET processing_token=NULL,processing_started_at=NULL WHERE id='deleting-effect'");
  await deleteRoomData(room.id);
  const response = { code: 200, body: null as any, status(code: number) { this.code=code; return this; }, json(body: any) { this.body=body; return this; } };
  assert.equal(await resolveRoomOrReply(room.id, response as never, { allowCreate: true }), null);
  assert.equal(response.code, 410);
  assert.equal(response.body.code, "ROOM_DELETED");
  assert.equal((await pool!.query("SELECT * FROM workflow_effects")).rowCount, 0);
});
