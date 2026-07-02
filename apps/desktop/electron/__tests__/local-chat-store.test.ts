import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { DesktopGitRoomInfo } from "../ipc-types.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeRequire = createRequire(import.meta.url);

const tempDir = mkdtempSync(join(tmpdir(), "letagents-desktop-local-chat-"));
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");
process.env.LETAGENTS_LOCAL_PROFILE_PATH = join(tempDir, "local-profile.json");

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

test.after(() => {
  delete process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH;
  delete process.env.LETAGENTS_LOCAL_CHAT_DB;
  delete process.env.LETAGENTS_LOCAL_PROFILE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

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
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.assignee, "Local Agent");
  assert.equal(updated.assigneeAgentKey, "local/agent");
  assert.equal(updated.prUrl, "https://github.com/BrosInCode/letagents/pull/1");

  assert.deepEqual((await listLocalTasks("task_room")).map((entry) => entry.id), [task.id]);
  assert.equal((await getLocalTask("task_room", task.id))?.status, "accepted");

  await assert.rejects(
    () => updateLocalTask("task_room", task.id, { status: "done" }),
    /Invalid transition: accepted -> done/,
  );
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
    assignee: "Local Worker",
    assigneeAgentKey: "local/worker",
  });

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
