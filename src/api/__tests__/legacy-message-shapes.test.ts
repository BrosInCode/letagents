import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  LEGACY_PROJECT_STREAM_FRAMES,
  toLegacyCreatedMessageBody,
  toLegacyMessagePage,
  toLegacyPollBody,
} = await import("../routes/legacy/message-shapes.js");
const { ROOM_MESSAGE_STREAM_FRAMES } = await import("../routes/rooms/messages/stream.js");

const message = { id: "msg_7", sender: "Ann", text: "hi", source: "browser", timestamp: "2026-11-10T00:00:00.000Z" } as never;

test("the legacy list page names the room project_id and keeps has_older", () => {
  const page = toLegacyMessagePage("room_1", { kind: "page", messages: [message], has_more: true, has_older: true });
  assert.deepEqual(Object.keys(page), ["project_id", "messages", "has_more", "has_older"]);
  assert.equal(JSON.stringify(page), JSON.stringify({ project_id: "room_1", messages: [message], has_more: true, has_older: true }));
  // has_older is undefined without `before`, so the JSON body has no such key.
  const forward = toLegacyMessagePage("room_1", { kind: "page", messages: [], has_more: false, has_older: undefined });
  assert.equal(JSON.stringify(forward), JSON.stringify({ project_id: "room_1", messages: [], has_more: false }));
});

test("the legacy poll body renames room_id and passes the cursor field through only when present", () => {
  assert.equal(
    JSON.stringify(toLegacyPollBody({ room_id: "room_1", messages: [], has_more: false })),
    JSON.stringify({ project_id: "room_1", messages: [], has_more: false }),
  );
  assert.equal(
    JSON.stringify(toLegacyPollBody({ room_id: "room_1", messages: [message], has_more: true, last_observed_message_id: "msg_9" })),
    JSON.stringify({ project_id: "room_1", messages: [message], has_more: true, last_observed_message_id: "msg_9" }),
  );
  assert.equal(
    JSON.stringify(toLegacyPollBody({ room_id: "room_1", messages: [], has_more: false, last_observed_message_id: null })),
    JSON.stringify({ project_id: "room_1", messages: [], has_more: false, last_observed_message_id: null }),
  );
  assert.equal("room_id" in toLegacyPollBody({ room_id: "room_1", messages: [], has_more: false }), false);
});

test("the legacy created message is the message without room_id or account routing", () => {
  const body = toLegacyCreatedMessageBody({
    ...(message as object),
    mention_notices: [],
    account_agent_routing: { version: 1, authority: "receipts", recipient_agent_keys: [] },
    room_id: "room_1",
  } as never);
  assert.equal("room_id" in body, false);
  assert.equal("account_agent_routing" in body, false);
  assert.deepEqual(body, { ...(message as object), mention_notices: [] });
});

test("legacy stream frames: room_sync without checkpoint fields, bare messages, project_id disconnect", () => {
  const sync = LEGACY_PROJECT_STREAM_FRAMES.roomSync({
    room_id: "room_1", checkpoint: "msg_9", requested_cursor: "msg_3", event_cursor: "c:4", gap: true,
  });
  assert.equal(JSON.stringify(sync), JSON.stringify({ project_id: "room_1", event_cursor: "c:4", gap: true }));
  const created = LEGACY_PROJECT_STREAM_FRAMES.message(message, "room_1", false);
  const routed = LEGACY_PROJECT_STREAM_FRAMES.message(message, "room_1", true);
  assert.deepEqual(created, message);
  assert.deepEqual(routed, message, "a routed re-publish has no routing_pass marker on the legacy stream");
  assert.deepEqual(LEGACY_PROJECT_STREAM_FRAMES.sessionDisconnect("room_1"), { project_id: "room_1" });
});

test("the room stream frames keep the room shape", () => {
  const payload = { room_id: "room_1", checkpoint: "msg_9", requested_cursor: null, event_cursor: "c:4", gap: false };
  assert.equal(JSON.stringify(ROOM_MESSAGE_STREAM_FRAMES.roomSync(payload)), JSON.stringify(payload));
  assert.deepEqual(ROOM_MESSAGE_STREAM_FRAMES.message(message, "room_1", true), {
    ...(message as object), room_id: "room_1", routing_pass: 2,
  });
  assert.deepEqual(ROOM_MESSAGE_STREAM_FRAMES.sessionDisconnect("room_1"), { room_id: "room_1" });
});
