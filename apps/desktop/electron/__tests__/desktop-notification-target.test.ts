import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDesktopNotificationLaunchInfo,
  parseDesktopNotificationTarget,
} from "../main/notification-target.js";

const expectedTarget = {
  notificationId: "notification-123",
  roomIdentifier: "git-room:example",
  messageId: "msg_3",
  threadRootId: "msg_1",
};

test("parses the snake-case APNs target payload", () => {
  assert.deepEqual(parseDesktopNotificationTarget({
    notification_id: "notification-123",
    room_id: "git-room:example",
    message_id: "msg_3",
    thread_root_id: "msg_1",
  }), expectedTarget);
});

test("parses a cold-start UNNotificationResponse launch payload", () => {
  assert.deepEqual(parseDesktopNotificationLaunchInfo({
    actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
    identifier: "notification-123",
    userInfo: {
      aps: { alert: { title: "LetAgents" } },
      letagents: {
        notification_id: "notification-123",
        room_id: "git-room:example",
        message_id: "msg_3",
        thread_root_id: "msg_1",
      },
    },
  }), expectedTarget);
});

test("parses legacy macOS launch userInfo and rejects incomplete payloads", () => {
  assert.deepEqual(parseDesktopNotificationLaunchInfo({
    letagents: {
      notificationId: "notification-123",
      roomIdentifier: "git-room:example",
      messageId: "msg_3",
      threadRootId: "msg_1",
    },
  }), expectedTarget);
  assert.equal(parseDesktopNotificationLaunchInfo({ userInfo: { letagents: { message_id: "msg_3" } } }), null);
});

test("private-message notifications open a conversation and reject ambiguous room targets", () => {
  const input = { notification_id: "dm-1", conversation_id: "chat_123", message_id: "msg_9" };
  assert.deepEqual(parseDesktopNotificationTarget(input), {
    notificationId: "dm-1", conversationId: "chat_123", messageId: "msg_9", threadRootId: null,
  });
  assert.equal(parseDesktopNotificationTarget({ ...input, room_id: "room_1" }), null);
});

test("parses a join-request target, which opens the room's settings instead of a message", () => {
  assert.deepEqual(parseDesktopNotificationTarget({
    notification_id: "lj_device_1a2b",
    room_id: "design-lounge",
    join_request_id: "rjr_42",
  }), { notificationId: "lj_device_1a2b", roomIdentifier: "design-lounge", joinRequestId: "rjr_42" });
  assert.deepEqual(parseDesktopNotificationLaunchInfo({
    identifier: "lj_device_1a2b",
    userInfo: { letagents: { notification_id: "lj_device_1a2b", room_id: "design-lounge", join_request_id: "rjr_42" } },
  }), { notificationId: "lj_device_1a2b", roomIdentifier: "design-lounge", joinRequestId: "rjr_42" });
  // A join request belongs to a room, never to a private conversation or a message.
  assert.equal(parseDesktopNotificationTarget({ notification_id: "x", conversation_id: "c", join_request_id: "rjr_1" }), null);
  assert.equal(parseDesktopNotificationTarget({ notification_id: "x", room_id: "r", message_id: "msg_1", join_request_id: "rjr_1" }), null);
  assert.equal(parseDesktopNotificationTarget({ notification_id: "x", join_request_id: "rjr_1" }), null);
});
