import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { DesktopGitRoomInfo, DesktopTaskSummary } from "../ipc-types.js";
import { createElectronTestEnv } from "./harness.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeRequire = createRequire(import.meta.url);

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-desktop-local-chat-",
  paths: ["chatStorage", "localChatDb", "localProfile"],
});

const {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLocalChatMessages,
  getLocalChatMessagesBefore,
  getLocalMessageThread,
  getLocalMessageThreads,
  getSyncedCloudMessageId,
  importLocalChatMessages,
  markLocalChatMessageSynced,
  markLocalMessageThreadRead,
} = await import("../main/rooms/messages/local-store.js");
const {
  readLocalProfileId,
  readChatStorageSettings,
  resolveRoomStorageMode,
  setChatStorageMode,
  setRoomStorageMode,
} = await import("../main/chat-storage/settings.js");
const {
  addLocalTask,
  assertLocalRoomPublishable,
  claimLocalTaskReviewLease,
  claimLocalTasksForPublish,
  cloudRoomIdentifierForStorage,
  createLocalRoom,
  getLocalRoomIncludingArchived,
  getLocalTask,
  importLocalTasks,
  localRoomIdentifierForStorage,
  listLocalRoomEntries,
  listLocalTasks,
  markLocalTaskSynced,
  releaseLocalTaskPublishClaim,
  releaseLocalTaskReviewLease,
  resolveLocalAwareRoomStorageMode,
  setLocalAwareRoomStorageMode,
  setLocalRoomArchived,
  setLocalRoomPinned,
  updateLocalTask,
} = await import("../main/rooms/local-store.js");
const {
  buildLocalRoomArtifactIdentityKey,
  getLocalRoomArtifacts,
  publishLocalRoomArtifact,
  syncLocalRoomArtifactsForTask,
} = await import("../main/rooms/artifacts/local-store.js");
const {
  executeManagedAgentContextRequest,
} = await import("../main/agents/managed-agent-context.js");

test("desktop local chat store persists messages, replies, and sync metadata", async () => {
  const first = await addLocalChatMessage("room_1", {
    sender: "Human",
    text: "first",
    source: "browser",
  });
  const second = await addLocalChatMessage("room_1", {
    sender: "Agent",
    text: "reply",
    reply_to: first.id,
    source: "agent",
  });

  assert.equal(first.id, "msg_1");
  assert.equal(second.id, "msg_2");
  assert.equal(second.reply_to?.id, "msg_1");

  const afterFirst = await getLocalChatMessages("room_1", { after: first.id });
  assert.deepEqual(afterFirst.messages.map((message) => message.id), ["msg_2"]);

  const beforeSecond = await getLocalChatMessagesBefore("room_1", second.id);
  assert.deepEqual(beforeSecond.messages.map((message) => message.id), ["msg_1"]);

  await markLocalChatMessageSynced({
    roomId: "room_1",
    localMessageId: first.id,
    cloudMessageId: "msg_44",
  });
  assert.equal(
    await getSyncedCloudMessageId({
      roomId: "room_1",
      localMessageId: first.id,
    }),
    "msg_44",
  );
});

test("desktop local chat store deduplicates idempotent managed failure messages", async () => {
  const input = {
    sender: "letagents",
    text: "Agent could not reply: quota exhausted",
    source: "managed_agent_failure",
    idempotency_key: "managed_agent_failure:session_1:msg_1:quota_exhausted",
  };
  const first = await addLocalChatMessage("room_failure_dedupe", input);
  const repeated = await addLocalChatMessage("room_failure_dedupe", input);
  const page = await getLocalChatMessages("room_failure_dedupe");

  assert.equal(repeated.id, first.id);
  assert.equal(page.messages.length, 1);
});

test("desktop local chat store rejects thread targets hidden from chat", async () => {
  const hidden = await addLocalChatMessage("room_hidden_thread_target", {
    sender: "Agent",
    text: "",
    agent_prompt_kind: "auto",
    source: "agent",
  });
  const visible = await addLocalChatMessage("room_hidden_thread_target", {
    sender: "Human",
    text: "visible root",
    source: "browser",
  });

  await assert.rejects(
    () => addLocalChatMessage("room_hidden_thread_target", {
      sender: "Human",
      text: "reply to hidden prompt",
      reply_to: hidden.id,
      source: "browser",
    }),
    /reply_to must reference a visible local message/,
  );

  await assert.rejects(
    () => addLocalChatMessage("room_hidden_thread_target", {
      sender: "Human",
      text: "quote hidden prompt",
      reply_to: visible.id,
      thread_root_id: hidden.id,
      source: "browser",
    }),
    /thread_root_id must reference a visible local message/,
  );
});

test("desktop local chat store scopes thread reads by reader", async () => {
  const root = await addLocalChatMessage("room_scoped_reads", {
    sender: "Human",
    text: "root",
    source: "browser",
  });
  const firstReply = await addLocalChatMessage("room_scoped_reads", {
    sender: "Agent",
    text: "first reply",
    reply_to: root.id,
    thread_root_id: root.id,
    source: "agent",
  });
  await addLocalChatMessage("room_scoped_reads", {
    sender: "Agent",
    text: "second reply",
    reply_to: firstReply.id,
    thread_root_id: root.id,
    source: "agent",
  });

  const firstReaderInitial = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:first",
  });
  assert.equal(firstReaderInitial?.summary.unread_count, 2);

  await markLocalMessageThreadRead("room_scoped_reads", root.id, firstReply.id, {
    readerKey: "account:first",
  });

  const firstReader = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:first",
  });
  const secondReader = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:second",
  });
  assert.equal(firstReader?.summary.last_read_message_id, firstReply.id);
  assert.equal(firstReader?.summary.unread_count, 1);
  assert.equal(secondReader?.summary.last_read_message_id, null);
  assert.equal(secondReader?.summary.unread_count, 2);
});

test("desktop local chat store lists thread inbox pages with unread filtering", async () => {
  const firstRoot = await addLocalChatMessage("room_thread_inbox", {
    sender: "Human",
    text: "first root",
    source: "browser",
  });
  await addLocalChatMessage("room_thread_inbox", {
    sender: "Agent",
    text: "first reply",
    reply_to: firstRoot.id,
    thread_root_id: firstRoot.id,
    source: "agent",
  });
  const secondRoot = await addLocalChatMessage("room_thread_inbox", {
    sender: "Human",
    text: "second root",
    source: "browser",
  });
  const secondReply = await addLocalChatMessage("room_thread_inbox", {
    sender: "Agent",
    text: "second reply",
    reply_to: secondRoot.id,
    thread_root_id: secondRoot.id,
    source: "agent",
  });

  const allThreads = await getLocalMessageThreads("room_thread_inbox", {
    readerKey: "account:inbox",
  });
  assert.deepEqual(allThreads.threads.map((item) => item.root.id), [secondRoot.id, firstRoot.id]);
  assert.equal(allThreads.unread_thread_count, 2);

  await markLocalMessageThreadRead("room_thread_inbox", secondRoot.id, secondReply.id, {
    readerKey: "account:inbox",
  });
  const unreadThreads = await getLocalMessageThreads("room_thread_inbox", {
    filter: "unread",
    readerKey: "account:inbox",
  });
  assert.deepEqual(unreadThreads.threads.map((item) => item.root.id), [firstRoot.id]);
  assert.equal(unreadThreads.unread_thread_count, 1);
});

test("desktop local chat import seeds thread read state from cloud metadata", async () => {
  await importLocalChatMessages("room_import_read_state", [
    {
      id: "msg_10",
      sender: "Human",
      text: "root",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-01T00:00:00.000Z",
      thread_root_id: "msg_10",
      thread_reply_to_id: null,
      reply_to: null,
      thread: {
        root_message_id: "msg_10",
        reply_count: 1,
        unread_count: 0,
        has_unread: false,
        latest_reply: {
          id: "msg_11",
          sender: "Agent",
          text: "reply",
          source: "agent",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        participants: [],
        last_read_message_id: "msg_11",
      },
    },
    {
      id: "msg_11",
      sender: "Agent",
      text: "reply",
      attachments: [],
      source: "agent",
      timestamp: "2026-01-01T00:00:01.000Z",
      thread_root_id: "msg_10",
      thread_reply_to_id: "msg_10",
      reply_to: {
        id: "msg_10",
        sender: "Human",
        text: "root",
        source: "browser",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      thread: null,
    },
  ], {
    readerKey: "account:seeded",
  });

  const page = await getLocalMessageThread("room_import_read_state", "msg_1", {
    readerKey: "account:seeded",
  });
  assert.equal(page?.summary.last_read_message_id, "msg_2");
  assert.equal(page?.summary.unread_count, 0);

  const otherReaderPage = await getLocalMessageThread("room_import_read_state", "msg_1", {
    readerKey: "account:other",
  });
  assert.equal(otherReaderPage?.summary.last_read_message_id, null);
  assert.equal(otherReaderPage?.summary.unread_count, 1);
});

test("desktop local chat store claims unsynced messages with stable sync keys", async () => {
  const message = await addLocalChatMessage("room_sync", {
    sender: "Human",
    text: "sync me",
    source: "browser",
  });

  const firstClaim = await claimUnsyncedLocalChatMessages("room_sync");
  assert.deepEqual(firstClaim.map((entry) => entry.id), [message.id]);
  assert.equal(firstClaim[0]?.sync_key, "local-chat:room_sync:1");

  const overlappingClaim = await claimUnsyncedLocalChatMessages("room_sync");
  assert.deepEqual(overlappingClaim, []);

  await markLocalChatMessageSynced({
    roomId: "room_sync",
    localMessageId: message.id,
    cloudMessageId: "msg_9",
  });
  assert.deepEqual(await claimUnsyncedLocalChatMessages("room_sync"), []);
});

test("desktop local chat keeps attachment-only messages visible in history, sync, and thread summaries", async () => {
  const attachmentOnly = await addLocalChatMessage("room_visibility_null", {
    sender: "Human",
    text: "",
    source: "browser",
    attachments: [{
      id: "att_only",
      file_name: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 5,
      content_base64: "aGVsbG8=",
    }],
  });
  const hiddenPrompt = await addLocalChatMessage("room_visibility_null", {
    sender: "Agent",
    text: "",
    agent_prompt_kind: "auto",
    source: "agent",
  });
  const attachmentReply = await addLocalChatMessage("room_visibility_null", {
    sender: "Agent",
    text: "",
    reply_to: attachmentOnly.id,
    thread_root_id: attachmentOnly.id,
    source: "agent",
  });

  const history = await getLocalChatMessages("room_visibility_null");
  assert.deepEqual(history.messages.map((message) => message.id), [
    attachmentOnly.id,
    attachmentReply.id,
  ]);
  assert.equal(history.messages[0]?.attachments?.[0]?.id, "att_only");
  assert.equal(history.messages.some((message) => message.id === hiddenPrompt.id), false);

  const syncClaim = await claimUnsyncedLocalChatMessages("room_visibility_null");
  assert.deepEqual(syncClaim.map((message) => message.id), [
    attachmentOnly.id,
    attachmentReply.id,
  ]);

  const thread = await getLocalMessageThread("room_visibility_null", attachmentOnly.id);
  assert.deepEqual(thread?.replies.map((message) => message.id), [attachmentReply.id]);
  assert.equal(thread?.summary.reply_count, 1);
  assert.equal(thread?.summary.latest_reply?.id, attachmentReply.id);

  const inbox = await getLocalMessageThreads("room_visibility_null");
  assert.deepEqual(inbox.threads.map((item) => item.root.id), [attachmentOnly.id]);
  assert.equal(inbox.threads[0]?.summary.latest_reply?.id, attachmentReply.id);
});

test("desktop storage resolver applies app default, room overrides, and local metadata", async () => {
  await setChatStorageMode("cloud");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "cloud");

  await setRoomStorageMode("room_a", "local");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "local");

  await setRoomStorageMode("room_a", "inherit");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "cloud");

  await setChatStorageMode("local");
  assert.equal((await resolveRoomStorageMode("room_b")).effectiveMode, "local");

  await setRoomStorageMode("room_b", "cloud");
  assert.equal((await resolveRoomStorageMode("room_b")).effectiveMode, "cloud");

  await setChatStorageMode("cloud");
  const localOnly = await createLocalRoom({
    roomIdentifier: "local_only",
    displayName: "Local Only",
  });
  assert.equal(localOnly.publishStatus, "local_only");
  assert.equal((await resolveLocalAwareRoomStorageMode("local_only")).effectiveMode, "local");
  assert.equal(
    (await resolveLocalAwareRoomStorageMode("git-room:local:1234567890abcdef:branch:Zm9v")).effectiveMode,
    "local",
  );

  const forked = await createLocalRoom({
    roomIdentifier: "forked_room",
    displayName: "Forked",
    cloudRoomIdentifier: "github.com/BrosInCode/letagents",
  });
  assert.equal(forked.publishStatus, "linked");
  assert.equal((await resolveLocalAwareRoomStorageMode("forked_room")).effectiveMode, "local");

  await setRoomStorageMode("forked_room", "cloud");
  const cloudOverride = await resolveLocalAwareRoomStorageMode("forked_room");
  assert.equal(cloudOverride.effectiveMode, "cloud");
  assert.equal(cloudOverride.localRoom?.cloudRoomIdentifier, "github.com/BrosInCode/letagents");
  assert.equal(
    cloudRoomIdentifierForStorage(cloudOverride, "forked_room"),
    "github.com/BrosInCode/letagents",
  );
  assert.equal(localRoomIdentifierForStorage(cloudOverride, "forked_room"), "forked_room");

  const settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides.forked_room, "cloud");
});

test("desktop linked local rooms keep separate local and cloud identifiers", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Linked Local Room",
    cloudRoomIdentifier,
  });
  assert.notEqual(linked.roomIdentifier, cloudRoomIdentifier);

  await setRoomStorageMode(linked.roomIdentifier, "local");
  const storage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(storage.effectiveMode, "local");
  assert.equal(storage.localRoom?.roomIdentifier, linked.roomIdentifier);
  assert.equal(storage.localRoom?.cloudRoomIdentifier, cloudRoomIdentifier);
  assert.equal(localRoomIdentifierForStorage(storage, cloudRoomIdentifier), linked.roomIdentifier);

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  const cloudStorage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(cloudStorage.effectiveMode, "cloud");
  assert.equal(cloudRoomIdentifierForStorage(cloudStorage, linked.roomIdentifier), cloudRoomIdentifier);
});

test("desktop local Git rooms persist Git metadata for snapshots and account entries", async () => {
  const gitRoom: DesktopGitRoomInfo = {
    provider: "git",
    host: "local",
    repository: {
      id: "local:repo",
      fullName: "FBRF",
      owner: "local",
      name: "FBRF",
    },
    ref: {
      type: "branch",
      name: "feature/player-3d-presentation",
      defaultBranch: "main",
      baseRef: "main",
      headRef: "feature/player-3d-presentation",
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  };

  const room = await createLocalRoom({
    roomIdentifier: "git-room:local:fbrf:branch:feature",
    displayName: "FBRF",
    gitRoom,
  });

  assert.equal(room.gitRoom?.accessMode, "local");
  assert.equal(room.gitRoom?.ref.name, "feature/player-3d-presentation");

  const persisted = await getLocalRoomIncludingArchived(room.roomIdentifier);
  assert.equal(persisted?.gitRoom?.repository.fullName, "FBRF");

  const accountEntry = (await listLocalRoomEntries())
    .find((entry) => entry.roomIdentifier === room.roomIdentifier);
  assert.equal(accountEntry?.gitRoom?.source, "local_git");
  assert.equal(accountEntry?.gitRoom?.accessMode, "local");
  assert.throws(
    () => assertLocalRoomPublishable(room),
    /Local Git Rooms stay local/,
  );
});

test("desktop local room artifacts persist and link to tasks", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "local_artifacts_room",
    displayName: "Local Artifacts",
  });
  assert.equal(
    buildLocalRoomArtifactIdentityKey({
      provider: "git",
      kind: "commit",
      id: "abc123",
    }),
    "git:commit:id:abc123",
  );

  const published = await publishLocalRoomArtifact({
    roomId: room.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Initial local commit",
      ref: "feature/local-artifacts",
      state: "created",
    },
    linkedTaskIds: ["task_1"],
  });
  assert.equal(published.artifact.provider, "git");
  assert.equal(published.artifact.kind, "commit");
  assert.deepEqual(published.artifact.linked_task_ids, ["task_1"]);

  await publishLocalRoomArtifact({
    roomId: room.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Updated local commit",
    },
    taskId: "task_2",
  });

  const artifacts = await getLocalRoomArtifacts(room.roomIdentifier);
  assert.equal(artifacts.artifacts?.length, 1);
  assert.equal(artifacts.artifacts?.[0]?.title, "Updated local commit");
  assert.equal(artifacts.artifacts?.[0]?.ref, "feature/local-artifacts");
  assert.equal(artifacts.artifacts?.[0]?.state, "created");
  assert.deepEqual(artifacts.artifacts?.[0]?.linked_task_ids, ["task_1", "task_2"]);

  const filtered = await getLocalRoomArtifacts(room.roomIdentifier, { taskId: "task_2" });
  assert.equal(filtered.artifacts?.[0]?.identity_key, "git:commit:id:abc123");
  await syncLocalRoomArtifactsForTask({
    roomId: room.roomIdentifier,
    taskId: "task_3",
    artifacts: [{
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Task sync title",
    }],
  });
  const afterTaskSync = await getLocalRoomArtifacts(room.roomIdentifier);
  assert.equal(afterTaskSync.artifacts?.[0]?.title, "Updated local commit");
  assert.equal(afterTaskSync.artifacts?.[0]?.source, "manual");

  await assert.rejects(
    publishLocalRoomArtifact({
      roomId: room.roomIdentifier,
      artifact: { provider: "git", kind: "commit", title: "Missing identity" },
    }),
    /stable identity/,
  );
  await assert.rejects(
    publishLocalRoomArtifact({
      roomId: room.roomIdentifier,
      artifact: { provider: "git", kind: "commit", number: null },
    }),
    /stable identity/,
  );
});

test("managed agent local context resolves linked local room artifacts", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/context-linked-local-room";
  const linked = await createLocalRoom({
    roomIdentifier: "context_linked_local_room",
    displayName: "Context Linked Local Room",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  await publishLocalRoomArtifact({
    roomId: linked.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "ctx123",
      title: "Context commit",
    },
  });

  const result = await executeManagedAgentContextRequest({
    session_id: "context_session",
    room_id: cloudRoomIdentifier,
    room_identifier: cloudRoomIdentifier,
    joined_via: "join_room",
    cwd: tempDir,
    stop_phrase: "stop",
    max_minutes: 30,
    token: "token",
    thread_id: "thread",
    turn_id: "turn",
    server_url: "http://127.0.0.1",
    launched_server: false,
    codex_bin: "codex",
    status: "completed",
    started_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
  } as any, {
    tool: "get_room_context_summary",
    arguments: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "local");
  assert.equal(result.roomIdentifier, linked.roomIdentifier);
  assert.equal((result.artifacts as any[])?.[0]?.identityKey, "git:commit:id:ctx123");
});

test("desktop linked local rooms use the cloud room as the visible account identity", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/visible-linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Visible Linked Local Room",
    cloudRoomIdentifier,
  });

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  await setRoomStorageMode(cloudRoomIdentifier, "local");
  const storage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(storage.effectiveMode, "local");
  assert.equal(storage.localRoom?.roomIdentifier, linked.roomIdentifier);
  assert.equal(storage.overrideMode, "local");

  const localEntries = await listLocalRoomEntries({ linkedIdentity: "local" });
  assert.equal(
    localEntries.find((entry) => entry.roomIdentifier === linked.roomIdentifier)?.displayName,
    "Visible Linked Local Room",
  );

  const visibleEntries = await listLocalRoomEntries({ linkedIdentity: "cloud" });
  assert.equal(
    visibleEntries.find((entry) => entry.roomIdentifier === cloudRoomIdentifier)?.displayName,
    "Visible Linked Local Room",
  );
  assert.equal(
    visibleEntries.some((entry) => entry.roomIdentifier === linked.roomIdentifier),
    false,
  );
});

test("desktop room storage changes clear stale linked-room alias overrides", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/toggle-linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Toggle Linked Local Room",
    cloudRoomIdentifier,
  });

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  const localStorage = await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  assert.equal(localStorage.effectiveMode, "local");
  assert.equal(localStorage.localRoom?.roomIdentifier, linked.roomIdentifier);

  let settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides[cloudRoomIdentifier], "local");
  assert.equal(settings.roomOverrides[linked.roomIdentifier], undefined);

  const cloudStorage = await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "cloud");
  assert.equal(cloudStorage.effectiveMode, "cloud");
  assert.equal(cloudStorage.localRoom?.roomIdentifier, linked.roomIdentifier);

  settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides[cloudRoomIdentifier], "cloud");
  assert.equal(settings.roomOverrides[linked.roomIdentifier], undefined);
});

test("desktop local room pinning persists in local account room entries", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "pin_room",
    displayName: "Pin Room",
  });
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, false);

  await setLocalRoomPinned(room.roomIdentifier, true);
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, true);

  await setLocalRoomPinned(room.roomIdentifier, false);
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, false);
});

test("desktop archived local rooms can be restored from archived-aware lookup", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "restore_local_room",
    displayName: "Restore Local Room",
  });

  await setLocalRoomArchived(room.roomIdentifier, true);
  assert.equal(
    (await listLocalRoomEntries()).some((entry) => entry.roomIdentifier === room.roomIdentifier),
    false,
  );
  assert.equal(
    (await getLocalRoomIncludingArchived(room.roomIdentifier))?.displayName,
    "Restore Local Room",
  );

  await setLocalRoomArchived(room.roomIdentifier, false);
  assert.equal(
    (await listLocalRoomEntries()).some((entry) => entry.roomIdentifier === room.roomIdentifier),
    true,
  );
});

test("desktop local profile id is stable across concurrent first reads", async () => {
  const ids = await Promise.all(Array.from({ length: 8 }, () => readLocalProfileId()));
  assert.equal(new Set(ids).size, 1);
});

test("desktop local room task store supports board create and lifecycle updates", async () => {
  await createLocalRoom({
    roomIdentifier: "task_room",
    displayName: "Task Room",
  });

  const task = await addLocalTask("task_room", {
    title: "Draft local task",
    description: "Only on this machine",
    createdBy: "Emmy",
  });
  assert.equal(task.id, "task_1");
  assert.equal(task.status, "proposed");
  assert.equal(task.createdBy, "Emmy");

  const updated = await updateLocalTask("task_room", task.id, {
    status: "accepted",
    assignee: "Local Agent",
    assigneeAgentKey: "local/agent",
    prUrl: "https://github.com/BrosInCode/letagents/pull/1",
    workflowArtifacts: [{
      provider: "git",
      kind: "commit",
      id: "def456",
      number: null,
      title: "Local task commit",
      url: null,
      ref: null,
      state: null,
    }],
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.assignee, "Local Agent");
  assert.equal(updated.assigneeAgentKey, "local/agent");
  assert.equal(updated.prUrl, "https://github.com/BrosInCode/letagents/pull/1");
  assert.equal(updated.workflowArtifacts?.[0]?.provider, "git");
  assert.equal(
    (await getLocalRoomArtifacts("task_room", { taskId: task.id })).artifacts?.[0]?.identity_key,
    "git:commit:id:def456",
  );

  await updateLocalTask("task_room", task.id, {
    workflowArtifacts: [],
  });
  assert.deepEqual((await getLocalRoomArtifacts("task_room", { taskId: task.id })).artifacts, []);
  await assert.rejects(
    () => updateLocalTask("task_room", task.id, {
      workflowArtifacts: [{
        provider: "git",
        kind: "invalid",
        id: "bad",
      } as any],
    }),
    /artifact.kind is invalid/,
  );
  assert.deepEqual((await getLocalTask("task_room", task.id))?.workflowArtifacts, []);

  assert.deepEqual((await listLocalTasks("task_room")).map((entry) => entry.id), [task.id]);
  assert.equal((await getLocalTask("task_room", task.id))?.status, "accepted");

  await assert.rejects(
    () => updateLocalTask("task_room", task.id, { status: "done" }),
    /Invalid transition: accepted -> done/,
  );
});

test("desktop local task import syncs workflow artifacts into shared artifacts", async () => {
  await createLocalRoom({
    roomIdentifier: "task_import_artifact_room",
    displayName: "Task Import Artifact Room",
  });
  await importLocalTasks("task_import_artifact_room", [{
    id: "task_9",
    title: "Imported task",
    description: null,
    status: "accepted",
    assignee: null,
    assigneeAgentKey: null,
    createdBy: "GitHub",
    prUrl: null,
    workflowArtifacts: [{
      provider: "git",
      kind: "commit",
      id: "import123",
      number: null,
      title: "Imported commit",
      url: null,
      ref: "feature/imported",
      state: null,
    }],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  } satisfies DesktopTaskSummary]);

  const artifacts = await getLocalRoomArtifacts("task_import_artifact_room", { taskId: "task_9" });
  assert.equal(artifacts.artifacts?.[0]?.identity_key, "git:commit:id:import123");
  assert.deepEqual(artifacts.artifacts?.[0]?.linked_task_ids, ["task_9"]);
});

test("desktop local task reassignment clears stale agent session owner metadata", async () => {
  await createLocalRoom({
    roomIdentifier: "task_owner_handoff_room",
    displayName: "Task Owner Handoff Room",
  });
  const task = await addLocalTask("task_owner_handoff_room", {
    title: "Hand off local task",
  });
  await updateLocalTask("task_owner_handoff_room", task.id, { status: "accepted" });
  await updateLocalTask("task_owner_handoff_room", task.id, {
    status: "assigned",
    assignee: "Old Agent",
    assigneeAgentKey: "old/agent",
  });

  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      close: () => void;
      prepare: (sql: string) => {
        get: (...params: unknown[]) => Record<string, unknown> | undefined;
        run: (...params: unknown[]) => unknown;
      };
    };
  };
  const raw = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB || "");
  try {
    raw
      .prepare(`
        UPDATE local_tasks
        SET assignee_agent_instance_id = ?,
            assignee_agent_session_id = ?
        WHERE room_id = ? AND task_id = ?
      `)
      .run("old_instance", "old_session", "task_owner_handoff_room", task.id);

    await updateLocalTask("task_owner_handoff_room", task.id, {
      status: "in_progress",
    });
    const progressed = raw
      .prepare(`
        SELECT assignee_agent_instance_id, assignee_agent_session_id
        FROM local_tasks
        WHERE room_id = ? AND task_id = ?
      `)
      .get("task_owner_handoff_room", task.id);
    assert.equal(progressed?.assignee_agent_instance_id, "old_instance");
    assert.equal(progressed?.assignee_agent_session_id, "old_session");

    await updateLocalTask("task_owner_handoff_room", task.id, {
      assignee: "New Agent",
      assigneeAgentKey: "new/agent",
    });
    const reassigned = raw
      .prepare(`
        SELECT assignee_agent_key, assignee_agent_instance_id, assignee_agent_session_id
        FROM local_tasks
        WHERE room_id = ? AND task_id = ?
      `)
      .get("task_owner_handoff_room", task.id);
    assert.equal(reassigned?.assignee_agent_key, "new/agent");
    assert.equal(reassigned?.assignee_agent_instance_id, null);
    assert.equal(reassigned?.assignee_agent_session_id, null);
  } finally {
    raw.close();
  }
});

test("desktop local task publish claims prevent duplicate concurrent sync", async () => {
  await createLocalRoom({
    roomIdentifier: "publish_lock_room",
    displayName: "Publish Lock Room",
  });
  const task = await addLocalTask("publish_lock_room", {
    title: "Publish once",
  });

  const firstClaim = await claimLocalTasksForPublish("publish_lock_room");
  assert.deepEqual(firstClaim.map((entry) => entry.id), [task.id]);
  assert.deepEqual(await claimLocalTasksForPublish("publish_lock_room"), []);

  await releaseLocalTaskPublishClaim({
    roomId: "publish_lock_room",
    taskId: task.id,
  });
  assert.deepEqual(
    (await claimLocalTasksForPublish("publish_lock_room")).map((entry) => entry.id),
    [task.id],
  );

  await markLocalTaskSynced({
    roomId: "publish_lock_room",
    taskId: task.id,
    cloudTaskId: "task_99",
  });
  assert.deepEqual(await claimLocalTasksForPublish("publish_lock_room"), []);
});

test("desktop local task review leases are claimed and released locally", async () => {
  await createLocalRoom({
    roomIdentifier: "review_room",
    displayName: "Review Room",
  });
  const task = await addLocalTask("review_room", {
    title: "Review locally",
  });
  await updateLocalTask("review_room", task.id, { status: "accepted" });
  await updateLocalTask("review_room", task.id, {
    status: "assigned",
    assignee: "Local Worker",
    assigneeAgentKey: "local/worker",
  });
  await updateLocalTask("review_room", task.id, { status: "in_review" });

  const claimed = await claimLocalTaskReviewLease("review_room", task.id, {
    holderLabel: "Local Reviewer",
    agentKey: "local/reviewer",
    agentSessionId: "local_session_1",
  });
  assert.equal(claimed.lease.kind, "review");
  assert.equal(claimed.lease.holderLabel, "Local Reviewer");
  assert.equal(claimed.task.activeLeases.length, 1);

  const released = await releaseLocalTaskReviewLease("review_room", task.id, {
    leaseId: claimed.lease.id,
  });
  assert.equal(released.releasedLease?.status, "released");
  assert.deepEqual(released.task.activeLeases, []);
});

test("desktop local task review leases reject tasks outside review states", async () => {
  await createLocalRoom({
    roomIdentifier: "review_status_room",
    displayName: "Review Status Room",
  });
  const task = await addLocalTask("review_status_room", {
    title: "Not ready for review",
  });

  await assert.rejects(
    () => claimLocalTaskReviewLease("review_status_room", task.id, {
      holderLabel: "Local Reviewer",
      agentKey: "local/reviewer",
      agentSessionId: "local_session_status",
    }),
    /Cannot assign review authority while task is proposed/,
  );
});

test("desktop local task review leases reject the assigned worker", async () => {
  await createLocalRoom({
    roomIdentifier: "review_assignee_room",
    displayName: "Review Assignee Room",
  });
  const task = await addLocalTask("review_assignee_room", {
    title: "Review by someone else",
  });
  await updateLocalTask("review_assignee_room", task.id, {
    status: "accepted",
  });
  await updateLocalTask("review_assignee_room", task.id, {
    status: "assigned",
    assignee: "Local Worker",
    assigneeAgentKey: "local/worker",
  });
  await updateLocalTask("review_assignee_room", task.id, { status: "in_review" });

  await assert.rejects(
    () => claimLocalTaskReviewLease("review_assignee_room", task.id, {
      holderLabel: "Local Worker",
      agentKey: "local/worker",
      agentSessionId: "local_session_2",
    }),
    /cannot also claim review authority/,
  );
});

test("desktop and MCP local chat writers allocate unique ids across processes", async () => {
  const writers = Array.from({ length: 8 }, (_, index) => {
    const modulePath = pathToFileURL(
      join(
        repoRoot,
        index % 2 === 0
          ? "apps/desktop/electron/main/rooms/messages/local-store.ts"
          : "src/mcp/local-state/local-chat.ts",
      ),
    ).href;
    const code = `
      const { addLocalChatMessage } = await import(${JSON.stringify(modulePath)});
      const message = await addLocalChatMessage("room_race", {
        sender: "writer_${index}",
        text: "message_${index}",
        source: "agent"
      });
      console.log(message.id);
    `;
    return execFileAsync(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: join(tempDir, `chat-storage-${index}.json`),
        LETAGENTS_LOCAL_CHAT_DB: process.env.LETAGENTS_LOCAL_CHAT_DB,
      },
    });
  });
  const results = await Promise.all(writers);
  const ids = results.map((result) => result.stdout.trim()).sort((left, right) => {
    return Number(left.replace("msg_", "")) - Number(right.replace("msg_", ""));
  });
  assert.deepEqual(ids, ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"]);
});

test("local chat stores keep quote-replies top-level across a process restart", async () => {
  // Regression guard for the removed thread-root backfill: a bare quote-reply
  // (reply_to only, no explicit thread root) must stay top-level even after the
  // store is reopened in a fresh process — the backfill used to re-thread it on
  // init, undoing the quote-reply fix on local rooms across every restart.
  const stores = [
    { name: "desktop", module: "apps/desktop/electron/main/rooms/messages/local-store.ts" },
    { name: "mcp", module: "src/mcp/local-state/local-chat.ts" },
  ];

  for (const store of stores) {
    const moduleUrl = pathToFileURL(join(repoRoot, store.module)).href;
    const childEnv = {
      ...process.env,
      LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: join(tempDir, `restart-${store.name}-storage.json`),
      LETAGENTS_LOCAL_CHAT_DB: join(tempDir, `restart-${store.name}.sqlite`),
    };

    // Process 1: root, a bare quote-reply, and an explicit thread reply.
    const writeCode = `
      const { addLocalChatMessage } = await import(${JSON.stringify(moduleUrl)});
      const root = await addLocalChatMessage("restart_room", {
        sender: "Human", text: "root", source: "browser",
      });
      await addLocalChatMessage("restart_room", {
        sender: "Agent", text: "quote reply", source: "agent", reply_to: root.id,
      });
      await addLocalChatMessage("restart_room", {
        sender: "Agent", text: "thread reply", source: "agent",
        reply_to: root.id, thread_root_id: root.id,
      });
      console.log("written");
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "-e", writeCode], {
      cwd: process.cwd(),
      env: childEnv,
    });

    // Process 2 (a fresh process == an app/server restart): opening the store
    // runs schema init, then we read the raw thread roots straight from SQLite.
    const readCode = `
      const { getLocalChatMessages } = await import(${JSON.stringify(moduleUrl)});
      await getLocalChatMessages("restart_room");
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB);
      const rows = raw
        .prepare("SELECT number, reply_to_number, thread_root_number FROM local_chat_messages WHERE room_id = ? ORDER BY number ASC")
        .all("restart_room");
      console.log(JSON.stringify(rows.map((row) => ({
        number: Number(row.number),
        reply_to_number: row.reply_to_number == null ? null : Number(row.reply_to_number),
        thread_root_number: row.thread_root_number == null ? null : Number(row.thread_root_number),
      }))));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", readCode], {
      cwd: process.cwd(),
      env: childEnv,
    });

    assert.deepEqual(
      JSON.parse(stdout.trim()),
      [
        { number: 1, reply_to_number: null, thread_root_number: null },
        // quote reply: reply reference kept, NOT threaded — and it stays that
        // way after the restart (no backfill re-threads it).
        { number: 2, reply_to_number: 1, thread_root_number: null },
        // explicit thread reply: remains threaded onto the root.
        { number: 3, reply_to_number: 1, thread_root_number: 1 },
      ],
      `store ${store.name} must not re-thread a quote-reply across restart`,
    );
  }
});
