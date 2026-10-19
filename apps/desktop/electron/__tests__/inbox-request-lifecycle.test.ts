import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "inbox-request-lifecycle-", paths: ["state", "chatStorage", "localChatDb", "localProfile"] }).resetState({});

const { createKnowledgeRecord } = await import("../../../../shared/room-knowledge.mjs");
const { saveLocalKnowledge } = await import("../../../../shared/local-room-knowledge.mjs");
const { getLocalChatDatabase } = await import("../main/rooms/local-db.js");
const { createLocalRoom } = await import("../main/rooms/local-store.js");
const { getLocalChatMessages } = await import("../main/rooms/messages/local-store.js");
const { getDesktopKnowledge, reviseDesktopKnowledge } = await import("../main/rooms/knowledge.js");

test("a local agent request shows once in the room chat, and closing it tells the agent there", async () => {
  const room = "local_requests";
  await createLocalRoom({ roomIdentifier: room, displayName: "Local requests" });
  const agent = { id: "owner/harbor", label: "HarborMarsh", kind: "agent" as const };
  // An agent's MCP server saves the request in the shared local database.
  saveLocalKnowledge(await getLocalChatDatabase(), createKnowledgeRecord(room, "attention",
    { client_id: "request-local-01", category: "question", title: "Which port?", body: "Pick 80 or 443." }, agent));
  await getDesktopKnowledge(room, "attention");
  await getDesktopKnowledge(room, "attention");
  let messages = (await getLocalChatMessages(room)).messages;
  assert.equal(messages.length, 1, "the desktop posts the notice once");
  assert.equal(messages[0].text, "Needs you · Question: Which port?\n\nPick 80 or 443.\n\nWaiting for an answer in Inbox (request-local-01).");
  assert.equal(messages[0].sender, agent.label);
  assert.equal(messages[0].source, "agent");

  const closed = await reviseDesktopKnowledge(room, "attention", "request-local-01", { expected_version: 1, close: true, response: "A draft is not sent." });
  assert.equal(closed.response?.closed, true);
  assert.equal(closed.response?.body, "Closed without an answer.");
  assert.equal((await reviseDesktopKnowledge(room, "attention", "request-local-01", { expected_version: 1, close: true })).version, 2, "a retry is harmless");
  messages = (await getLocalChatMessages(room)).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, "@agent:owner/harbor\n\nHuman response (request-local-01):\n\nClosed without an answer.");
  await assert.rejects(reviseDesktopKnowledge(room, "attention", "request-local-01", { expected_version: 2, response: "Late answer" }), /already been closed/);
});
