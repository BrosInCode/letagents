import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopReasoningSession,
  DesktopRoomMessage,
} from "../../electron/ipc-types";
import {
  compareRoomMessages,
  encodeRoomPathIdentifier,
  isHiddenChatMessage,
  mergeRoomMessages,
} from "../src/components/desktop/content/room-shell/messages";
import {
  readLiquidGlassEnabled,
  readNotificationPermission,
  readNotificationsEnabled,
  readSoundEnabled,
} from "../src/components/desktop/content/room-shell/preferences";
import {
  buildAgentFallbackReasoningSession,
  inferAgentFallbackStatus,
  latestMessageForAgent,
  sanitizeFallbackId,
  stripStatusPrefix,
} from "../src/components/desktop/content/room-shell/reasoningFallback";
import { latestReasoningSessionForTarget } from "../src/domain/reasoning";

describe("desktop room shell helpers", () => {
  it("merges visible messages, removes shell-only status noise, and preserves path room ids", () => {
    const merged = mergeRoomMessages(
      [
        roomMessage({ id: "msg_10", text: "old ten" }),
        roomMessage({ id: "msg_2", text: "two" }),
        roomMessage({ id: "status", source: "agent", text: "[status] working" }),
        roomMessage({ id: "empty-auto", agentPromptKind: "auto", text: "" }),
      ],
      [
        roomMessage({ id: "msg_10", text: "new ten" }),
        roomMessage({ id: "local_1", text: "local" }),
      ],
    );

    assert.deepEqual(merged.map((message) => [message.id, message.text]), [
      ["msg_2", "two"],
      ["msg_10", "new ten"],
      ["local_1", "local"],
    ]);
    assert.equal(isHiddenChatMessage(roomMessage({ id: "status", source: "agent", text: "[status] working" })), true);
    assert.equal(isHiddenChatMessage(roomMessage({ id: "visible-agent", source: "agent", text: "working" })), false);
    assert.equal(encodeRoomPathIdentifier("github.com/BrosInCode/let agents"), "github.com/BrosInCode/let%20agents");
  });

  it("orders numbered server messages by id and uses timestamps for local messages", () => {
    const messages = [
      roomMessage({ id: "local_2", timestamp: "2026-05-28T00:00:01.000Z" }),
      roomMessage({ id: "msg_12", timestamp: "2026-05-28T00:00:03.000Z" }),
      roomMessage({ id: "msg_4", timestamp: "2026-05-28T00:00:02.000Z" }),
      roomMessage({ id: "local_1", timestamp: "2026-05-28T00:00:00.000Z" }),
    ].sort(compareRoomMessages);

    assert.deepEqual(messages.map((message) => message.id), ["local_1", "local_2", "msg_4", "msg_12"]);

    const sameTime = [
      roomMessage({ id: "local_1", timestamp: "2026-05-28T00:00:00.000Z" }),
      roomMessage({ id: "msg_4", timestamp: "2026-05-28T00:00:00.000Z" }),
    ].sort(compareRoomMessages);

    assert.deepEqual(sameTime.map((message) => message.id), ["msg_4", "local_1"]);
  });

  it("matches reasoning fallback targets and builds pending sessions from latest agent activity", () => {
    const target = {
      actorLabel: "Agent Smith | Codex",
      displayName: "Agent Smith",
      ideLabel: "Codex",
      sender: "agent-smith",
    };
    const oldSession = reasoningSession("reasoning_old", "Agent Smith | Codex", "2026-05-28T01:00:00.000Z");
    const newSession = reasoningSession("reasoning_new", "Agent Smith | Codex", "2026-05-28T02:00:00.000Z");
    const messages = [
      roomMessage({
        id: "msg_1",
        sender: "Human",
        source: "user",
        text: "please review",
        timestamp: "2026-05-28T02:00:00.000Z",
      }),
      roomMessage({
        id: "msg_2",
        sender: "Agent Smith | Codex",
        actorLabel: "Agent Smith | Codex",
        source: "agent",
        text: "[status] reviewing PR #473",
        timestamp: "2026-05-28T03:00:00.000Z",
      }),
    ];
    const fallback = buildAgentFallbackReasoningSession(
      target,
      "github.com/BrosInCode/letagents",
      messages,
    );

    assert.equal(latestReasoningSessionForTarget(target, [oldSession, newSession])?.id, "reasoning_new");
    assert.equal(latestMessageForAgent(target, messages)?.id, "msg_2");
    assert.equal(fallback.status, "reviewing");
    assert.equal(fallback.createdAt, "2026-05-28T03:00:00.000Z");
    assert.equal(fallback.latestPayload?.summary.includes("reviewing PR #473"), true);
    assert.equal(sanitizeFallbackId("Agent Smith | Codex"), "Agent-Smith-Codex");
    assert.equal(stripStatusPrefix("[status] checking integration"), "checking integration");
    assert.equal(inferAgentFallbackStatus("blocked waiting for tests"), "blocked");
  });
});

describe("desktop room shell preferences", () => {
  it("reads persisted desktop room preferences and defaults", () => {
    withLocalStorage({
      "letagents-desktop:sound": "off",
      "letagents-desktop:notifications": "on",
      "letagents-desktop:liquid-glass": "off",
    }, () => {
      assert.equal(readSoundEnabled(), false);
      assert.equal(readNotificationsEnabled(), true);
      assert.equal(readLiquidGlassEnabled(), false);
    });

    withLocalStorage({ "letagents-desktop:liquid-glass": "on" }, () => {
      assert.equal(readLiquidGlassEnabled(), true);
    });

    withLocalStorage({}, () => {
      assert.equal(readSoundEnabled(), true);
      assert.equal(readNotificationsEnabled(), false);
      assert.equal(readLiquidGlassEnabled(), false);
    });
  });

  it("falls back when storage or notification APIs are unavailable", () => {
    withThrowingLocalStorage(() => {
      assert.equal(readSoundEnabled(), true);
      assert.equal(readNotificationsEnabled(), false);
      assert.equal(readLiquidGlassEnabled(), false);
    });

    withNotificationPermission("denied", () => {
      assert.equal(readNotificationPermission(), "denied");
    });
    withNotificationPermission(null, () => {
      assert.equal(readNotificationPermission(), "unsupported");
    });
  });
});

function roomMessage(overrides: Partial<DesktopRoomMessage>): DesktopRoomMessage {
  return {
    id: "msg_1",
    sender: "Emmy",
    text: "hello",
    attachments: [],
    agentPromptKind: null,
    source: "user",
    timestamp: "2026-05-28T00:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    replyTo: null,
    ...overrides,
  };
}

function reasoningSession(id: string, actorLabel: string, updatedAt: string): DesktopReasoningSession {
  return {
    id,
    roomId: "room_1",
    actorLabel,
    agentKey: null,
    taskId: null,
    title: null,
    status: "working",
    summary: null,
    latestPayload: null,
    goal: null,
    checking: null,
    hypothesis: null,
    blocker: null,
    nextAction: null,
    milestone: null,
    confidence: null,
    closedAt: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt,
  };
}

function withLocalStorage(entries: Record<string, string>, callback: () => void): void {
  withWindow({
    localStorage: {
      getItem(key: string): string | null {
        return entries[key] ?? null;
      },
    },
  }, callback);
}

function withThrowingLocalStorage(callback: () => void): void {
  withWindow({
    localStorage: {
      getItem(): string | null {
        throw new Error("storage unavailable");
      },
    },
  }, callback);
}

function withWindow(value: object, callback: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  try {
    callback();
  } finally {
    restoreGlobalProperty("window", previous);
  }
}

function withNotificationPermission(permission: NotificationPermission | null, callback: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  if (permission) {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission },
    });
  } else {
    delete (globalThis as { Notification?: unknown }).Notification;
  }
  try {
    callback();
  } finally {
    restoreGlobalProperty("Notification", previous);
  }
}

function restoreGlobalProperty(key: "Notification" | "window", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    delete (globalThis as Record<typeof key, unknown>)[key];
  }
}
