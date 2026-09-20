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
