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
