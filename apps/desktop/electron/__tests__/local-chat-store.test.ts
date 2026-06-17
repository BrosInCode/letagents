import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const tempDir = mkdtempSync(join(tmpdir(), "letagents-desktop-local-chat-"));
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");

const {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLocalChatMessages,
  getLocalChatMessagesBefore,
  getSyncedCloudMessageId,
  markLocalChatMessageSynced,
} = await import("../main/rooms/messages/local-store.js");
const {
  readChatStorageSettings,
  resolveRoomStorageMode,
  setChatStorageMode,
  setRoomStorageMode,
} = await import("../main/chat-storage/settings.js");
const {
  addLocalTask,
  claimLocalTaskReviewLease,
  claimLocalTasksForPublish,
  cloudRoomIdentifierForStorage,
  createLocalRoom,
  getLocalTask,
  localRoomIdentifierForStorage,
  listLocalRoomEntries,
  listLocalTasks,
  markLocalTaskSynced,
  releaseLocalTaskPublishClaim,
  releaseLocalTaskReviewLease,
  resolveLocalAwareRoomStorageMode,
  setLocalAwareRoomStorageMode,
  setLocalRoomPinned,
  updateLocalTask,
} = await import("../main/rooms/local-store.js");

test.after(() => {
  delete process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH;
  delete process.env.LETAGENTS_LOCAL_CHAT_DB;
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
