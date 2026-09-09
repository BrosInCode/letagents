import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "desktop-message-outbox-", paths: ["chatStorage", "localChatDb", "localProfile"],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;
mock.module("electron", { defaultExport: { app: { getPath: () => env.tempDir } } });
const { stageDroppedDesktopAttachmentContents, readLocalStagedAttachments } = await import("../main/attachments.js");
const { sendDesktopRoomMessage } = await import("../main/rooms/messages.js");
const { setChatStorageMode } = await import("../main/chat-storage/settings.js");
const { getLocalChatMessages } = await import("../main/rooms/messages/local-store.js");

test("local attachment survives rejected send and identical retry returns one persisted message", async () => {
  await setChatStorageMode("local");
  const room = "outbox-local-room";
  const [attachment] = await stageDroppedDesktopAttachmentContents(room, [{ fileName: "note.txt", mimeType: "text/plain", sizeBytes: 3, contentBase64: "YWJj" }]);
  const refs = [{ upload_id: attachment!.uploadId }];
  const id = "desktop-send:32571cb6-3fe9-48a1-9b3c-28f775bdc724";
  await assert.rejects(sendDesktopRoomMessage(room, "", "pending:invalid", refs, null, id), /valid local message/);
  assert.equal(readLocalStagedAttachments(room, refs).length, 1);
  const first = await sendDesktopRoomMessage(room, "", null, refs, null, id);
  const retried = await sendDesktopRoomMessage(room, "", null, refs, null, id);
  assert.equal(first.message.id, retried.message.id);
  assert.equal(retried.message.clientMessageId, id);
  assert.equal(retried.message.attachments.length, 1);
  assert.equal((await getLocalChatMessages(room)).messages.length, 1);
  assert.throws(() => readLocalStagedAttachments(room, refs), /no longer available/);
});

test("cloud retry forwards the same logical ID and exact attachment/thread payload", async () => {
  await setChatStorageMode("cloud");
  const previousFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  const id = "desktop-send:32571cb6-3fe9-48a1-9b3c-28f775bdc725";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) throw new Error("Response lost after commit");
    return Response.json({ id: "msg_4", client_message_id: body.client_message_id, sender: "Desktop", text: body.text, timestamp: new Date().toISOString() });
  };
  try {
    const args = ["outbox-cloud-room", "Instruction", "msg_1", [{ upload_id: "upload" }], "msg_1", id] as const;
    await assert.rejects(sendDesktopRoomMessage(...args), /Response lost/);
    const retried = await sendDesktopRoomMessage(...args);
    assert.equal(retried.message.clientMessageId, id);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal((bodies[0] as { client_message_id: string }).client_message_id, id);
  } finally { globalThis.fetch = previousFetch; }
});
