import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-mcp-local-chat-"));
const settingsPath = join(tempDir, "chat-storage.json");
process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH = settingsPath;
process.env.LETAGENTS_LOCAL_CHAT_DB = join(tempDir, "local-chat.sqlite");

const {
  addLocalChatMessage,
  getLocalChatMessages,
  isLocalChatStorageEnabled,
  waitForLocalChatMessages,
} = await import("../local-state/local-chat.js");

test.after(() => {
  delete process.env.LETAGENTS_CHAT_STORAGE;
  delete process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH;
  delete process.env.LETAGENTS_LOCAL_CHAT_DB;
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
