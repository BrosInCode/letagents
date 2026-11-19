import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createElectronTestEnv, installTestSecretStorage, testEncryptedToken } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "desktop-chat-send-crash-recovery-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;
installTestSecretStorage();
mock.module("electron", {
  defaultExport: {
    app: { getPath: () => env.tempDir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
  },
});

const {
  handleAttachmentProtocolRequest,
  pruneOrphanedLocalStagedAttachments,
  stageDroppedDesktopAttachmentContents,
} = await import("../main/attachments.js");
const { clearLocalStagedAttachmentsMemoryForTest } = await import("../main/attachments/local-store.js");
const { resetStoredAuthCacheForTest, signOutDesktopAuth } = await import("../main/auth.js");
const { localFilesPath, setChatStorageMode } = await import("../main/chat-storage/settings.js");
const { getLocalChatDatabase } = await import("../main/rooms/local-db.js");
const {
  addLocalChatMessage,
  getLocalChatMessages,
  getLocalMessageThread,
} = await import("../main/rooms/messages/local-store.js");
const { sendDesktopRoomMessage } = await import("../main/rooms/messages.js");
const {
  deleteDesktopOutgoingMessage,
  INTERRUPTED_DELIVERY_ERROR,
  listDesktopOutgoingMessages,
  rotateDesktopOutboxBootIdForTest,
  saveDesktopOutgoingMessage,
  updateDesktopOutgoingMessage,
} = await import("../main/rooms/outbox-store.js");

const PNG_BYTES = Buffer.from("\x89PNG\r\n\x1a\ncrash-recovery-image-payload", "latin1");
const PNG_BASE64 = PNG_BYTES.toString("base64");

const authStorePath = join(env.tempDir, "letagents-desktop-auth.json");

function setAccountAuth(account: { id: string; login: string; displayName: string } | null): void {
  if (!account) {
    rmSync(authStorePath, { force: true });
  } else {
    writeFileSync(
      authStorePath,
      `${JSON.stringify({
        version: 2,
        ownerTokenId: null,
        oauthTokenExpiresAt: null,
        encryptedToken: testEncryptedToken(`token-${account.id}`),
        account: {
          id: account.id,
          login: account.login,
          displayName: account.displayName,
          avatarUrl: null,
          provider: "github",
          providerUserId: account.id,
        },
        pendingDeviceAuth: null,
        savedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
  }
  resetStoredAuthCacheForTest();
}

function simulateProcessRestart(): void {
  clearLocalStagedAttachmentsMemoryForTest();
  rotateDesktopOutboxBootIdForTest();
}

test("local room thread reply with attachment: crash just before storage restores uncertain send and retry commits exactly one message, one row and one attachment", async () => {
  setAccountAuth({ id: "acct_local_1", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const room = "crash-local-before-storage";
  const namespace = `${room}:local:cloud`;
  const root = await addLocalChatMessage(room, { sender: "Alice", text: "Thread root", source: "browser" });

  const [staged] = await stageDroppedDesktopAttachmentContents(room, [{
    fileName: "evidence.png",
    mimeType: "image/png",
    sizeBytes: PNG_BYTES.byteLength,
    contentBase64: PNG_BASE64,
  }]);
  assert.ok(staged);

  const clientMessageId = "desktop-send:11111111-1111-4111-8111-111111111111";
  const saved = await saveDesktopOutgoingMessage({
    clientMessageId,
    roomIdentifier: room,
    messageNamespace: namespace,
    text: "Thread reply with attachment before storage",
    replyTo: root.id,
    threadRootId: root.id,
    attachments: [{
      upload_id: staged.uploadId,
      fileName: staged.fileName,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
    }],
    replyPreview: {
      id: root.id,
      sender: root.sender,
      text: root.text,
      source: root.source ?? null,
      timestamp: root.timestamp,
      agentIdentity: null,
    },
    timestamp: "2026-11-19T02:00:00.000Z",
  });
  assert.equal(saved.status, "pending");
  assert.equal(saved.accountScope, "account:acct_local_1");
  assert.equal(saved.storageMode, "local");

  // Crash just before storage: no local_chat_messages reply exists yet, memory is wiped.
  simulateProcessRestart();
  assert.equal((await getLocalMessageThread(room, root.id))?.replies.length, 0);

  // Reopen: outbox restores the interrupted send as uncertain with full payload & attachment metadata.
  const restored = await listDesktopOutgoingMessages();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.clientMessageId, clientMessageId);
  assert.equal(restored[0]!.status, "uncertain");
  assert.equal(restored[0]!.error, INTERRUPTED_DELIVERY_ERROR);
  assert.equal(restored[0]!.roomIdentifier, room);
  assert.equal(restored[0]!.messageNamespace, namespace);
  assert.equal(restored[0]!.threadRootId, root.id);
  assert.equal(restored[0]!.replyTo, root.id);
  assert.equal(restored[0]!.attachments.length, 1);
  assert.equal(restored[0]!.attachments[0]!.fileName, "evidence.png");

  // Retry after crash uses persisted local_staged_attachments metadata & file on disk.
  const retried = await sendDesktopRoomMessage(
    restored[0]!.roomIdentifier,
    restored[0]!.text,
    restored[0]!.replyTo,
    restored[0]!.attachments,
    restored[0]!.threadRootId,
    restored[0]!.clientMessageId,
    restored[0]!.messageNamespace,
  );
  await deleteDesktopOutgoingMessage(clientMessageId);

  assert.equal(retried.message.clientMessageId, clientMessageId);
  assert.equal(retried.message.threadRootId, root.id);
  assert.equal(retried.message.threadReplyToId, root.id);
  assert.equal(retried.message.attachments.length, 1);
  assert.equal(retried.message.attachments[0]!.fileName, "evidence.png");

  const thread = await getLocalMessageThread(room, root.id);
  assert.equal(thread?.replies.length, 1);
  assert.equal(thread?.replies[0]!.id, retried.message.id);
  assert.equal(thread?.replies[0]!.attachments?.length, 1);

  // Exactly one file on disk, readable via the attachment protocol, and zero leftover outbox/staged rows.
  const files = await readdir(join(localFilesPath, room));
  assert.equal(files.length, 1);
  const served = await handleAttachmentProtocolRequest(new Request(retried.message.attachments[0]!.href!));
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), PNG_BASE64);

  assert.equal((await listDesktopOutgoingMessages()).length, 0);
  const db = await getLocalChatDatabase();
  const stagedRemaining = db.prepare("SELECT COUNT(*) AS count FROM local_staged_attachments WHERE room_id = ?").get(room);
  assert.equal(Number(stagedRemaining?.count), 0);
});

test("local room thread reply with attachment: crash just after storage before ack reconciles cleanly via retry and passive cleanup to one message and one attachment", async () => {
  setAccountAuth({ id: "acct_local_2", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const room = "crash-local-after-storage";
  const namespace = `${room}:local:cloud`;
  const root = await addLocalChatMessage(room, { sender: "Alice", text: "Root message", source: "browser" });

  const [staged] = await stageDroppedDesktopAttachmentContents(room, [{
    fileName: "trace.png",
    mimeType: "image/png",
    sizeBytes: PNG_BYTES.byteLength,
    contentBase64: PNG_BASE64,
  }]);
  assert.ok(staged);

  const clientMessageId = "desktop-send:22222222-2222-4222-8222-222222222222";
  await saveDesktopOutgoingMessage({
    clientMessageId,
    roomIdentifier: room,
    messageNamespace: namespace,
    text: "Committed before crash",
    replyTo: root.id,
    threadRootId: root.id,
    attachments: [{
      upload_id: staged.uploadId,
      fileName: staged.fileName,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
    }],
    replyPreview: null,
    timestamp: "2026-11-19T02:01:00.000Z",
  });

  // Storage commits, but crash happens BEFORE acknowledgement (outbox row remains on disk).
  const committed = await sendDesktopRoomMessage(
    room,
    "Committed before crash",
    root.id,
    [{ upload_id: staged.uploadId }],
    root.id,
    clientMessageId,
    namespace,
  );
  // Also simulate crash before releaseLocalStagedAttachments finished by re-inserting staged row.
  const db = await getLocalChatDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO local_staged_attachments (upload_id, room_id, file_name, mime_type, size_bytes, file_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    staged.uploadId,
    room,
    staged.fileName,
    staged.mimeType,
    staged.sizeBytes,
    join(localFilesPath, room, (await readdir(join(localFilesPath, room)))[0]!),
    "2026-11-19T02:01:00.000Z",
  );

  simulateProcessRestart();

  const restored = await listDesktopOutgoingMessages();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.status, "uncertain");

  // Retrying after restart must hit the existing row by clientMessageId and NOT duplicate message or attachment.
  const replayed = await sendDesktopRoomMessage(
    restored[0]!.roomIdentifier,
    restored[0]!.text,
    restored[0]!.replyTo,
    restored[0]!.attachments,
    restored[0]!.threadRootId,
    restored[0]!.clientMessageId,
    restored[0]!.messageNamespace,
  );
  assert.equal(replayed.message.id, committed.message.id);
  assert.equal(replayed.message.clientMessageId, clientMessageId);
  assert.equal(replayed.message.attachments.length, 1);

  await deleteDesktopOutgoingMessage(clientMessageId);

  const page = await getLocalChatMessages(room);
  const replies = page.messages.filter((m) => m.thread_root_id === root.id && m.id !== root.id);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.attachments?.length, 1);
  assert.equal((await readdir(join(localFilesPath, room))).length, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM local_staged_attachments WHERE room_id = ?").get(room)?.count), 0);
  assert.equal((await listDesktopOutgoingMessages()).length, 0);
});

test("cloud room thread reply with attachment: crash just before storage and crash just after storage before ack both reconcile to one stored message and one attachment", async () => {
  setAccountAuth({ id: "acct_cloud_1", login: "alice", displayName: "Alice" });
  await setChatStorageMode("cloud");
  const room = "github.com/brosincode/letagents";
  const namespace = `${room}:cloud:cloud`;

  const pendingUploads = new Map<string, { upload_id: string; filename: string; content_type: string; byte_size: number; attached: boolean }>([
    ["upl_before_storage_0001", { upload_id: "upl_before_storage_0001", filename: "before.png", content_type: "image/png", byte_size: 42, attached: false }],
    ["upl_after_storage_0002", { upload_id: "upl_after_storage_0002", filename: "after.png", content_type: "image/png", byte_size: 84, attached: false }],
  ]);
  const storedCloudMessages: Array<{
    id: string;
    client_message_id: string;
    sender: string;
    text: string;
    reply_to: { id: string; sender: string; text: string; timestamp: string } | null;
    thread_root_id: string;
    thread_reply_to_id: string | null;
    attachments: Array<{ id: string; upload_id: string; filename: string; content_type: string; byte_size: number; download_url: string }>;
    timestamp: string;
  }> = [];
  let dropResponseAfterCommit = false;
  let postCount = 0;

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    postCount += 1;
    const body = JSON.parse(String(init?.body)) as {
      sender: string;
      text: string;
      reply_to: string | null;
      thread_root_id: string | null;
      attachments: Array<{ upload_id: string }>;
      client_message_id: string;
    };
    const existing = storedCloudMessages.find((item) => item.client_message_id === body.client_message_id);
    if (existing) {
      assert.deepEqual(
        existing.attachments.map((item) => item.upload_id),
        body.attachments.map((item) => item.upload_id),
      );
      return Response.json(existing, { status: 201 });
    }
    const claimed = body.attachments.map(({ upload_id }, index) => {
      const upload = pendingUploads.get(upload_id);
      if (!upload || upload.attached) {
        throw new Error(`Upload ${upload_id} is not claimable`);
      }
      upload.attached = true;
      return {
        id: `att_${storedCloudMessages.length + 1}_${index + 1}`,
        upload_id,
        filename: upload.filename,
        content_type: upload.content_type,
        byte_size: upload.byte_size,
        download_url: `/rooms/${encodeURIComponent(room)}/messages/msg_${storedCloudMessages.length + 2}/attachments/att_1`,
      };
    });
    const created = {
      id: `msg_${storedCloudMessages.length + 2}`,
      client_message_id: body.client_message_id,
      sender: body.sender,
      text: body.text,
      reply_to: body.reply_to ? { id: body.reply_to, sender: "Alice", text: "Root", timestamp: "2026-11-19T01:00:00.000Z" } : null,
      thread_root_id: body.thread_root_id || `msg_${storedCloudMessages.length + 2}`,
      thread_reply_to_id: body.reply_to,
      attachments: claimed,
      timestamp: "2026-11-19T02:02:00.000Z",
    };
    storedCloudMessages.push(created);
    if (dropResponseAfterCommit) {
      throw new Error("Simulated crash after cloud storage commit before acknowledgement");
    }
    return Response.json(created, { status: 201 });
  }) as typeof fetch;

  try {
    // 1. Crash just BEFORE cloud storage
    const beforeId = "desktop-send:33333333-3333-4333-8333-333333333333";
    await saveDesktopOutgoingMessage({
      clientMessageId: beforeId,
      roomIdentifier: room,
      messageNamespace: namespace,
      text: "Cloud thread reply before storage",
      replyTo: "msg_1",
      threadRootId: "msg_1",
      attachments: [{ upload_id: "upl_before_storage_0001", fileName: "before.png", mimeType: "image/png", sizeBytes: 42 }],
      replyPreview: null,
      timestamp: "2026-11-19T02:02:00.000Z",
    });

    simulateProcessRestart();
    assert.equal(postCount, 0);
    assert.equal(storedCloudMessages.length, 0);

    const restoredBefore = await listDesktopOutgoingMessages();
    assert.equal(restoredBefore.length, 1);
    assert.equal(restoredBefore[0]!.status, "uncertain");
    assert.equal(restoredBefore[0]!.storageMode, "cloud");

    const sentBefore = await sendDesktopRoomMessage(
      restoredBefore[0]!.roomIdentifier,
      restoredBefore[0]!.text,
      restoredBefore[0]!.replyTo,
      restoredBefore[0]!.attachments,
      restoredBefore[0]!.threadRootId,
      restoredBefore[0]!.clientMessageId,
      restoredBefore[0]!.messageNamespace,
    );
    await deleteDesktopOutgoingMessage(beforeId);
    assert.equal(storedCloudMessages.length, 1);
    assert.equal(sentBefore.message.id, "msg_2");
    assert.equal(sentBefore.message.attachments.length, 1);
    assert.equal(sentBefore.message.threadRootId, "msg_1");

    // 2. Crash just AFTER cloud storage commit, BEFORE acknowledgement
    const afterId = "desktop-send:44444444-4444-4444-8444-444444444444";
    await saveDesktopOutgoingMessage({
      clientMessageId: afterId,
      roomIdentifier: room,
      messageNamespace: namespace,
      text: "Cloud thread reply after storage",
      replyTo: "msg_1",
      threadRootId: "msg_1",
      attachments: [{ upload_id: "upl_after_storage_0002", fileName: "after.png", mimeType: "image/png", sizeBytes: 84 }],
      replyPreview: null,
      timestamp: "2026-11-19T02:03:00.000Z",
    });

    dropResponseAfterCommit = true;
    await assert.rejects(
      sendDesktopRoomMessage(room, "Cloud thread reply after storage", "msg_1", [{ upload_id: "upl_after_storage_0002" }], "msg_1", afterId, namespace),
      /before acknowledgement/,
    );
    assert.equal(storedCloudMessages.length, 2, "cloud storage already committed the message");

    // Process dies and restarts before ack reached renderer.
    dropResponseAfterCommit = false;
    simulateProcessRestart();

    const restoredAfter = await listDesktopOutgoingMessages();
    assert.equal(restoredAfter.length, 1);
    assert.equal(restoredAfter[0]!.clientMessageId, afterId);
    assert.equal(restoredAfter[0]!.status, "uncertain");

    const replayedAfter = await sendDesktopRoomMessage(
      restoredAfter[0]!.roomIdentifier,
      restoredAfter[0]!.text,
      restoredAfter[0]!.replyTo,
      restoredAfter[0]!.attachments,
      restoredAfter[0]!.threadRootId,
      restoredAfter[0]!.clientMessageId,
      restoredAfter[0]!.messageNamespace,
    );
    await deleteDesktopOutgoingMessage(afterId);

    assert.equal(storedCloudMessages.length, 2, "replay must not insert a duplicate cloud message");
    assert.equal(replayedAfter.message.id, "msg_3");
    assert.equal(replayedAfter.message.attachments.length, 1);
    assert.equal(replayedAfter.message.attachments[0]!.fileName, "after.png");
    assert.equal((await listDesktopOutgoingMessages()).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("outbox entries stay strictly isolated by account, room, thread and storage mode across crash and reopen", async () => {
  setAccountAuth({ id: "acct_alice", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const room = "crash-isolation-room";
  const namespace = `${room}:local:cloud`;
  const root = await addLocalChatMessage(room, { sender: "Alice", text: "Root", source: "browser" });

  const clientMessageId = "desktop-send:55555555-5555-4555-8555-555555555555";
  await saveDesktopOutgoingMessage({
    clientMessageId,
    roomIdentifier: room,
    messageNamespace: namespace,
    text: "Alice private thread send",
    replyTo: root.id,
    threadRootId: root.id,
    attachments: [],
    replyPreview: null,
    timestamp: "2026-11-19T02:04:00.000Z",
  });

  simulateProcessRestart();

  // Switching to Account B hides Account A's outbox and rejects cross-account retry & delete.
  setAccountAuth({ id: "acct_bob", login: "bob", displayName: "Bob" });
  assert.deepEqual(await listDesktopOutgoingMessages(), []);
  await assert.rejects(
    sendDesktopRoomMessage(room, "Alice private thread send", root.id, [], root.id, clientMessageId, namespace),
    /different account/,
  );
  await deleteDesktopOutgoingMessage(clientMessageId);

  // Switching back to Account A still preserves Account A's exact outbox entry.
  setAccountAuth({ id: "acct_alice", login: "alice", displayName: "Alice" });
  const restoredAlice = await listDesktopOutgoingMessages();
  assert.equal(restoredAlice.length, 1);
  assert.equal(restoredAlice[0]!.clientMessageId, clientMessageId);

  // Wrong room, wrong thread, and wrong storage mode are all rejected.
  await assert.rejects(
    sendDesktopRoomMessage("other-room", "Alice private thread send", root.id, [], root.id, clientMessageId, "other-room:local:cloud"),
    /different room/,
  );
  await assert.rejects(
    sendDesktopRoomMessage(room, "Alice private thread send", null, [], null, clientMessageId, namespace),
    /different thread/,
  );
  await setChatStorageMode("cloud");
  await assert.rejects(
    sendDesktopRoomMessage(room, "Alice private thread send", root.id, [], root.id, clientMessageId, `${room}:cloud:cloud`),
    /original mode/,
  );

  // Clean up under original mode & account.
  await setChatStorageMode("local");
  await deleteDesktopOutgoingMessage(clientMessageId);
  assert.deepEqual(await listDesktopOutgoingMessages(), []);
});

test("real OS SIGKILL crash after composer persistence preserves local thread reply and attachment on reopen", async () => {
  setAccountAuth({ id: "acct_sigkill", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const room = "crash-sigkill-local";
  const namespace = `${room}:local:cloud`;
  const root = await addLocalChatMessage(room, { sender: "Alice", text: "SIGKILL root", source: "browser" });
  const clientMessageId = "desktop-send:66666666-6666-4666-8666-666666666666";

  const childScript = `
    import { Buffer } from "node:buffer";
    import { mock } from "node:test";
    mock.module("electron", {
      defaultExport: {
        app: { getPath: () => process.env.LETAGENTS_DESKTOP_USER_DATA_DIR },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (v) => Buffer.from(v),
          decryptString: (v) => v.toString(),
        },
      },
    });
    const { stageDroppedDesktopAttachmentContents } = await import("./electron/main/attachments.js");
    const { saveDesktopOutgoingMessage } = await import("./electron/main/rooms/outbox-store.js");
    const [staged] = await stageDroppedDesktopAttachmentContents(${JSON.stringify(room)}, [{
      fileName: "sigkill-shot.png",
      mimeType: "image/png",
      sizeBytes: ${PNG_BYTES.byteLength},
      contentBase64: ${JSON.stringify(PNG_BASE64)},
    }]);
    await saveDesktopOutgoingMessage({
      clientMessageId: ${JSON.stringify(clientMessageId)},
      roomIdentifier: ${JSON.stringify(room)},
      messageNamespace: ${JSON.stringify(namespace)},
      text: "Survived SIGKILL",
      replyTo: ${JSON.stringify(root.id)},
      threadRootId: ${JSON.stringify(root.id)},
      attachments: [{
        upload_id: staged.uploadId,
        fileName: staged.fileName,
        mimeType: staged.mimeType,
        sizeBytes: staged.sizeBytes,
      }],
      replyPreview: null,
      timestamp: "2026-11-19T02:05:00.000Z",
    });
    process.kill(process.pid, "SIGKILL");
  `;

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--experimental-test-module-mocks", "--input-type=module", "-e", childScript],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    },
  );
  if (process.platform === "win32") {
    assert.ok(
      child.signal === "SIGKILL" || (child.status !== null && child.status !== 0),
      `expected abnormal termination on Windows, status=${child.status}, signal=${child.signal}, stderr=${child.stderr}`,
    );
  } else {
    assert.equal(child.signal, "SIGKILL", `expected SIGKILL, stderr=${child.stderr}`);
  }

  // Parent process (different bootId, fresh in-memory staged cache) recovers cleanly from SQLite + local-files.
  clearLocalStagedAttachmentsMemoryForTest();
  const restored = await listDesktopOutgoingMessages();
  const entry = restored.find((item) => item.clientMessageId === clientMessageId);
  assert.ok(entry, "SIGKILL-interrupted outbox entry must survive in SQLite");
  assert.equal(entry.status, "uncertain");
  assert.equal(entry.text, "Survived SIGKILL");
  assert.equal(entry.threadRootId, root.id);
  assert.equal(entry.attachments.length, 1);
  assert.equal(entry.attachments[0]!.fileName, "sigkill-shot.png");

  const delivered = await sendDesktopRoomMessage(
    entry.roomIdentifier,
    entry.text,
    entry.replyTo,
    entry.attachments,
    entry.threadRootId,
    entry.clientMessageId,
    entry.messageNamespace,
  );
  await deleteDesktopOutgoingMessage(clientMessageId);

  assert.equal(delivered.message.threadRootId, root.id);
  assert.equal(delivered.message.attachments.length, 1);
  const served = await handleAttachmentProtocolRequest(new Request(delivered.message.attachments[0]!.href!));
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), PNG_BASE64);
});

test("renderer-only restart while Electron main process stays alive (same boot_id) recovers saved local thread send as uncertain and retryable through real SQLite and renderer outbox", async () => {
  setAccountAuth({ id: "acct_renderer_reload", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const roomIdentifier = "crash-local-renderer-only-restart";
  const messageNamespace = `${roomIdentifier}:local:cloud`;

  const root = await addLocalChatMessage(roomIdentifier, {
    sender: "Alice",
    text: "Root before renderer reload",
    source: "browser",
  });
  const [staged] = await stageDroppedDesktopAttachmentContents(roomIdentifier, [{
    fileName: "renderer-reload.png",
    mimeType: "image/png",
    sizeBytes: PNG_BYTES.byteLength,
    contentBase64: PNG_BASE64,
  }]);
  assert.ok(staged);

  const clientMessageId = "desktop-send:77777777-7777-4777-8777-777777777777";
  const saved = await saveDesktopOutgoingMessage({
    clientMessageId,
    roomIdentifier,
    messageNamespace,
    text: "Saved before renderer died without main-process restart",
    replyTo: root.id,
    threadRootId: root.id,
    attachments: [{
      upload_id: staged.uploadId,
      fileName: staged.fileName,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
    }],
    replyPreview: {
      id: root.id,
      sender: root.sender,
      text: root.text,
      source: root.source ?? null,
      timestamp: root.timestamp,
      agentIdentity: null,
    },
    timestamp: "2026-11-19T02:30:00.000Z",
  });
  assert.equal(saved.status, "pending");

  // Main process stays alive (do NOT rotate boot_id): raw SQLite still sees status='pending'.
  const rawRows = await listDesktopOutgoingMessages();
  assert.equal(rawRows.length, 1);
  assert.equal(rawRows[0]!.status, "pending");

  // Load real renderer outbox module and wire window.letagentsDesktop.room to the real Electron store functions.
  const outboxUrl = new URL("../../renderer/src/domain/message-outbox.ts", import.meta.url).href;
  const outbox = await import(outboxUrl) as {
    clearDesktopMessageOutbox: () => void;
    desktopMessageOutbox: { value: Array<{ clientMessageId: string; inFlight: boolean; message: { outgoing?: { status: string; error: string | null } } }> };
    hydrateDesktopMessageOutbox: () => Promise<void>;
    registerDesktopOutboxConfirmationListener: (
      room: string,
      ns: string | null,
      listener: (event: { message: { id: string; clientMessageId: string | null; threadRootId: string | null; attachments: Array<{ fileName: string; href: string | null }> } }) => void,
    ) => () => void;
    retryDesktopOutgoingMessage: (id: string) => Promise<void>;
  };

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    letagentsDesktop: {
      room: {
        saveOutgoingMessage: saveDesktopOutgoingMessage,
        updateOutgoingMessage: updateDesktopOutgoingMessage,
        deleteOutgoingMessage: deleteDesktopOutgoingMessage,
        listOutgoingMessages: listDesktopOutgoingMessages,
        sendMessage: sendDesktopRoomMessage,
      },
    },
  };
  const confirmedMessages: Array<{ id: string; clientMessageId: string | null; threadRootId: string | null; attachments: Array<{ fileName: string; href: string | null }> }> = [];
  const unregisterListener = outbox.registerDesktopOutboxConfirmationListener(
    roomIdentifier,
    messageNamespace,
    (event) => {
      confirmedMessages.push(event.message);
    },
  );
  try {
    // New renderer starts empty and hydrates against live main-process SQLite.
    outbox.clearDesktopMessageOutbox();
    await outbox.hydrateDesktopMessageOutbox();

    assert.equal(outbox.desktopMessageOutbox.value.length, 1);
    const recovered = outbox.desktopMessageOutbox.value[0]!;
    assert.equal(recovered.clientMessageId, clientMessageId);
    assert.equal(recovered.inFlight, false);
    assert.equal(recovered.message.outgoing?.status, "uncertain");
    assert.equal(recovered.message.outgoing?.error, INTERRUPTED_DELIVERY_ERROR);

    // Give the async SQLite status persistence a tick and verify SQLite updated to uncertain.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const persistedAfterHydrate = await listDesktopOutgoingMessages();
    assert.equal(persistedAfterHydrate[0]!.status, "uncertain");

    // Retry safely dispatches once and commits exactly one local thread reply + one attachment.
    await outbox.retryDesktopOutgoingMessage(clientMessageId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal((await listDesktopOutgoingMessages()).length, 0);
    assert.equal(confirmedMessages.length, 1, "room confirmation listener must receive the retried message");
    const confirmedMessage = confirmedMessages[0]!;
    assert.equal(confirmedMessage.clientMessageId, clientMessageId);
    assert.equal(confirmedMessage.threadRootId, root.id);
    assert.equal(confirmedMessage.attachments.length, 1);
    assert.equal(confirmedMessage.attachments[0]!.fileName, "renderer-reload.png");

    const thread = await getLocalMessageThread(roomIdentifier, root.id);
    assert.ok(thread);
    const replies = thread.replies.filter((m) => m.client_message_id === clientMessageId);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.thread_root_id, root.id);
    assert.equal(replies[0]!.attachments?.length, 1);
    assert.equal(replies[0]!.attachments?.[0]?.file_name, "renderer-reload.png");

    const served = await handleAttachmentProtocolRequest(new Request(confirmedMessage.attachments[0]!.href!));
    assert.equal(served.status, 200);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), PNG_BASE64);
  } finally {
    unregisterListener();
    outbox.clearDesktopMessageOutbox();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("definite pre-commit refusals persist as refused and discard safely, while ambiguous errors stay uncertain", async () => {
  setAccountAuth({ id: "acct_refusal", login: "alice", displayName: "Alice" });
  await setChatStorageMode("cloud");
  const roomIdentifier = "crash-cloud-refusal";
  const namespace = `${roomIdentifier}:cloud:cloud`;

  const refusedId = "desktop-send:12121212-1212-4121-8121-121212121212";
  const uncertainId = "desktop-send:34343434-3434-4343-8343-343434343434";
  await saveDesktopOutgoingMessage({
    clientMessageId: refusedId,
    roomIdentifier,
    messageNamespace: namespace,
    text: "Will be refused with 403",
    replyTo: null,
    threadRootId: null,
    attachments: [],
    replyPreview: null,
    timestamp: "2026-11-19T03:00:00.000Z",
  });
  await saveDesktopOutgoingMessage({
    clientMessageId: uncertainId,
    roomIdentifier,
    messageNamespace: namespace,
    text: "Will hit 503 ambiguous error",
    replyTo: null,
    threadRootId: null,
    attachments: [],
    replyPreview: null,
    timestamp: "2026-11-19T03:00:01.000Z",
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { client_message_id?: string };
    if (body.client_message_id === refusedId) {
      return Response.json({ error: "You were removed from this room." }, { status: 403 });
    }
    return Response.json({ error: "Upstream unavailable" }, { status: 503 });
  };

  try {
    await assert.rejects(
      sendDesktopRoomMessage(roomIdentifier, "Will be refused with 403", null, [], null, refusedId, namespace),
      /precommit_refusal:.*removed from this room/,
    );
    await assert.rejects(
      sendDesktopRoomMessage(roomIdentifier, "Will hit 503 ambiguous error", null, [], null, uncertainId, namespace),
      (error: unknown) => error instanceof Error && !error.message.includes("precommit_refusal:"),
    );

    // Persisting refused status survives process restart as refused (never silently converted to pending/uncertain).
    await updateDesktopOutgoingMessage(refusedId, {
      status: "refused",
      error: "You were removed from this room.",
    });
    simulateProcessRestart();
    const afterRestart = await listDesktopOutgoingMessages();
    assert.equal(afterRestart.find((r) => r.clientMessageId === refusedId)?.status, "refused");
    assert.equal(afterRestart.find((r) => r.clientMessageId === uncertainId)?.status, "uncertain");

    // Clean up test rows.
    await deleteDesktopOutgoingMessage(refusedId, { discardAttachments: true });
    await deleteDesktopOutgoingMessage(uncertainId);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prunes abandoned staged local attachments without touching outbox-referenced files, and clears cloud outbox on explicit sign-out", async () => {
  const { existsSync } = await import("node:fs");
  setAccountAuth({ id: "acct_cleanup", login: "alice", displayName: "Alice" });
  await setChatStorageMode("local");
  const localRoom = "crash-local-cleanup";
  const localNamespace = `${localRoom}:local:cloud`;

  const [keptStaged, abandonedStaged] = await stageDroppedDesktopAttachmentContents(localRoom, [
    { fileName: "kept.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, contentBase64: PNG_BASE64 },
    { fileName: "abandoned.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, contentBase64: PNG_BASE64 },
  ]);
  assert.ok(keptStaged && abandonedStaged);

  const localOutboxId = "desktop-send:56565656-5656-4565-8565-565656565656";
  await saveDesktopOutgoingMessage({
    clientMessageId: localOutboxId,
    roomIdentifier: localRoom,
    messageNamespace: localNamespace,
    text: "Still queued with local attachment",
    replyTo: null,
    threadRootId: null,
    attachments: [{
      upload_id: keptStaged.uploadId,
      fileName: keptStaged.fileName,
      mimeType: keptStaged.mimeType,
      sizeBytes: keptStaged.sizeBytes,
    }],
    replyPreview: null,
    timestamp: "2026-11-19T03:05:00.000Z",
  });

  const db = await getLocalChatDatabase();
  const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE local_staged_attachments SET created_at = ?").run(oldIso);
  const abandonedRow = db
    .prepare("SELECT file_path FROM local_staged_attachments WHERE upload_id = ?")
    .get(abandonedStaged.uploadId) as { file_path: string } | undefined;
  const keptRow = db
    .prepare("SELECT file_path FROM local_staged_attachments WHERE upload_id = ?")
    .get(keptStaged.uploadId) as { file_path: string } | undefined;
  assert.ok(abandonedRow && existsSync(abandonedRow.file_path));
  assert.ok(keptRow && existsSync(keptRow.file_path));

  const pruned = await pruneOrphanedLocalStagedAttachments();
  assert.equal(pruned, 1);
  assert.equal(existsSync(abandonedRow.file_path), false, "abandoned unsent draft file must be deleted");
  assert.equal(existsSync(keptRow.file_path), true, "outbox-referenced attachment must be preserved");

  // Discarding the refused outbox entry deletes its staged attachment file cleanly.
  await deleteDesktopOutgoingMessage(localOutboxId, { discardAttachments: true });
  assert.equal(existsSync(keptRow.file_path), false, "discarding refused outbox entry must unlink uncommitted staged file");

  // Sign-out clears cloud outbox rows for the signed-out account while preserving local-profile rows.
  await setChatStorageMode("cloud");
  const cloudOutboxId = "desktop-send:78787878-7878-4787-8787-787878787878";
  await saveDesktopOutgoingMessage({
    clientMessageId: cloudOutboxId,
    roomIdentifier: "cloud-room-signout",
    messageNamespace: "cloud-room-signout:cloud:cloud",
    text: "Private cloud message removed on sign-out",
    replyTo: null,
    threadRootId: null,
    attachments: [],
    replyPreview: null,
    timestamp: "2026-11-19T03:06:00.000Z",
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await signOutDesktopAuth();
  } finally {
    globalThis.fetch = previousFetch;
  }
  const remainingCloud = db
    .prepare("SELECT client_message_id FROM desktop_message_outbox WHERE client_message_id = ?")
    .get(cloudOutboxId);
  assert.equal(remainingCloud, undefined, "explicit sign-out must clear cloud outbox rows for the signed-out account");
});
