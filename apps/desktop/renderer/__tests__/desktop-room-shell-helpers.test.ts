import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTick, ref } from "vue";

import type {
  DesktopReasoningSession,
  DesktopRoomInfo,
  DesktopRoomMessage,
} from "../../electron/ipc-types";
import {
  compareRoomMessages,
  encodeRoomPathIdentifier,
  isHiddenChatMessage,
  mergeRoomMessages,
} from "../src/components/desktop/content/room-shell/messages";
import {
  readGitHubEventsVisible,
  readLiquidGlassEnabled,
  readNotificationPermission,
  readNotificationsEnabled,
  readSoundEnabled,
  rememberGitHubEventsVisible,
} from "../src/components/desktop/content/room-shell/preferences";
import {
  buildAgentFallbackReasoningSession,
  inferAgentFallbackStatus,
  latestMessageForAgent,
  sanitizeFallbackId,
  stripStatusPrefix,
} from "../src/components/desktop/content/room-shell/reasoningFallback";
import {
  oldestRoomHistoryCursor,
  useDesktopRoomMessages,
} from "../src/components/desktop/content/room-shell/useDesktopRoomMessages";
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

  it("uses hidden low-signal check messages as history pagination cursors", () => {
    const messages = [
      roomMessage({
        id: "msg_15",
        sender: "github",
        source: "github",
        text: 'Check "docker" (GitHub Actions) skipped in BrosInCode/letagents https://example.com/check',
        timestamp: "2026-05-28T00:00:15.000Z",
      }),
      roomMessage({
        id: "msg_16",
        sender: "github",
        source: "github",
        text: 'Check "deploy" (GitHub Actions) skipped in BrosInCode/letagents https://example.com/check',
        timestamp: "2026-05-28T00:00:16.000Z",
      }),
    ];

    assert.equal(oldestRoomHistoryCursor(messages), "msg_15");
  });

  it("filters GitHub chat event messages when room GitHub events are hidden", () => {
    const githubEventsVisible = ref(true);
    const messages = ref([
      roomMessage({ id: "msg_1", text: "hello" }),
      roomMessage({
        id: "msg_2",
        sender: "github",
        source: "github",
        text: "PR #558 opened in BrosInCode/letagents: Polish desktop focus room manager https://github.com/BrosInCode/letagents/pull/558",
      }),
    ]);
    const { hasFilteredRoomActivity, visibleMessages } = useDesktopRoomMessages({
      room: ref(roomInfo()),
      messages,
      githubEventsVisible,
      playRoomSound: () => undefined,
      onMessageSent: () => undefined,
    });

    assert.deepEqual(visibleMessages.value.map((message) => message.id), ["msg_1", "msg_2"]);
    assert.equal(hasFilteredRoomActivity.value, false);

    githubEventsVisible.value = false;
    assert.deepEqual(visibleMessages.value.map((message) => message.id), ["msg_1"]);
    assert.equal(hasFilteredRoomActivity.value, false);
  });

  it("reports filtered room activity instead of leaking hidden GitHub events into chat", () => {
    const githubEventsVisible = ref(false);
    const messages = ref([
      roomMessage({
        id: "msg_1",
        sender: "github",
        source: "github",
        text: "PR #558 opened in BrosInCode/letagents: Polish desktop focus room manager https://github.com/BrosInCode/letagents/pull/558",
      }),
      roomMessage({
        id: "msg_2",
        sender: "github",
        source: "github",
        text: 'Check "deploy" (GitHub Actions) skipped in BrosInCode/letagents linked to task_174 https://github.com/BrosInCode/letagents/actions/runs/1',
      }),
      roomMessage({ id: "msg_3", source: "agent", text: "[status] pushed follow-up changes" }),
    ]);
    const { hasFilteredRoomActivity, visibleMessages } = useDesktopRoomMessages({
      room: ref(roomInfo()),
      messages,
      githubEventsVisible,
      playRoomSound: () => undefined,
      onMessageSent: () => undefined,
    });

    assert.deepEqual(visibleMessages.value.map((message) => message.id), []);
    assert.equal(hasFilteredRoomActivity.value, true);
  });

  it("auto-loads older history when the latest page only has filtered activity", async () => {
    const githubEventsVisible = ref(false);
    const messages = ref([
      roomMessage({
        id: "msg_20",
        sender: "github",
        source: "github",
        text: "PR #558 opened in BrosInCode/letagents: Polish desktop focus room manager https://github.com/BrosInCode/letagents/pull/558",
      }),
      roomMessage({ id: "msg_21", source: "agent", text: "[status] pushed follow-up changes" }),
    ]);
    const calls: Array<{ roomIdentifier: string; beforeMessageId: string; limit: number }> = [];

    await withWindowAsync({
      letagentsDesktop: {
        room: {
          async getMessagesBefore(roomIdentifier: string, beforeMessageId: string, limit: number) {
            calls.push({ roomIdentifier, beforeMessageId, limit });
            return {
              messages: [
                roomMessage({
                  id: "msg_1",
                  text: "older human chat",
                  timestamp: "2026-05-27T23:00:00.000Z",
                }),
              ],
              hasOlder: false,
            };
          },
        },
      },
    }, async () => {
      const { hasFilteredRoomActivity, visibleMessages } = useDesktopRoomMessages({
        room: ref(roomInfo()),
        messages,
        githubEventsVisible,
        playRoomSound: () => undefined,
        onMessageSent: () => undefined,
      });

      await flushPromises();

      assert.deepEqual(calls, [{
        roomIdentifier: "github.com/BrosInCode/letagents",
        beforeMessageId: "msg_20",
        limit: 150,
      }]);
      assert.deepEqual(visibleMessages.value.map((message) => message.id), ["msg_1"]);
      assert.equal(hasFilteredRoomActivity.value, false);
    });
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

  it("matches renamed agents through session and agent keys instead of generated labels", () => {
    const target = {
      actorLabel: null,
      displayName: "MapleRidge",
      ideLabel: "Codex",
      sender: "codex",
      agentKey: "codex/maple-ridge",
      agentSessionId: "session_local_codex",
    };
    const keyedSession = {
      ...reasoningSession("reasoning_keyed", "Different Label", "2026-05-28T02:00:00.000Z"),
      agentKey: "codex/maple-ridge",
    };
    const messages = [
      roomMessage({
        id: "msg_local",
        sender: "Different Label",
        source: "agent",
        text: "[status] building the Codex bridge",
        timestamp: "2026-05-28T03:00:00.000Z",
        agentIdentity: {
          name: "MapleRidge",
          displayName: "MapleRidge",
          ownerLabel: "Local desktop",
          ownerAttribution: "Local desktop's agent",
          ideLabel: "Codex",
          actorLabel: "Different Label",
          agentKey: "codex/maple-ridge",
          agentSessionId: "session_local_codex",
        },
      }),
    ];
    const fallback = buildAgentFallbackReasoningSession(
      target,
      "github.com/BrosInCode/letagents",
      messages,
    );

    assert.equal(latestReasoningSessionForTarget(target, [keyedSession])?.id, "reasoning_keyed");
    assert.equal(latestMessageForAgent(target, messages)?.id, "msg_local");
    assert.equal(fallback.agentKey, "codex/maple-ridge");
    assert.equal(fallback.id, "pending-agent-reasoning:session_local_codex");
    assert.equal(fallback.status, "working");
  });

  it("does not cross-match multiple Codex workers through generic provider keys", () => {
    const target = {
      actorLabel: "MapleRidge",
      displayName: "MapleRidge",
      ideLabel: "Codex",
      sender: "MapleRidge",
      agentKey: "codex",
      agentSessionId: "session_maple",
    };
    const mapleSession = {
      ...reasoningSession("reasoning_maple", "MapleRidge", "2026-05-28T02:00:00.000Z"),
      agentKey: "codex",
    };
    const cedarSession = {
      ...reasoningSession("reasoning_cedar", "CedarVista", "2026-05-28T03:00:00.000Z"),
      agentKey: "codex",
    };
    const messages = [
      roomMessage({
        id: "msg_cedar",
        sender: "CedarVista",
        actorLabel: "CedarVista",
        source: "agent",
        text: "[status] newer but different worker",
        timestamp: "2026-05-28T03:00:00.000Z",
        agentIdentity: {
          name: "CedarVista",
          displayName: "CedarVista",
          ownerLabel: "Local desktop",
          ownerAttribution: "Local desktop's agent",
          ideLabel: "Codex",
          actorLabel: "CedarVista",
          agentKey: "codex",
          agentSessionId: "session_cedar",
        },
      }),
      roomMessage({
        id: "msg_maple",
        sender: "MapleRidge",
        actorLabel: "MapleRidge",
        source: "agent",
        text: "[status] older matching worker",
        timestamp: "2026-05-28T02:00:00.000Z",
        agentIdentity: {
          name: "MapleRidge",
          displayName: "MapleRidge",
          ownerLabel: "Local desktop",
          ownerAttribution: "Local desktop's agent",
          ideLabel: "Codex",
          actorLabel: "MapleRidge",
          agentKey: "codex",
          agentSessionId: "session_maple",
        },
      }),
    ];

    assert.equal(
      latestReasoningSessionForTarget(target, [mapleSession, cedarSession])?.id,
      "reasoning_maple",
    );
    assert.equal(latestMessageForAgent(target, messages)?.id, "msg_maple");
  });
});

describe("desktop room shell preferences", () => {
  it("reads persisted desktop room preferences and defaults", () => {
    withLocalStorage({
      "letagents-desktop:sound": "off",
      "letagents-desktop:notifications": "on",
      "letagents-desktop:liquid-glass": "off",
      "letagents-desktop:github-events-visible": JSON.stringify({
        "github.com/brosincode/letagents": false,
      }),
    }, () => {
      assert.equal(readSoundEnabled(), false);
      assert.equal(readNotificationsEnabled(), true);
      assert.equal(readLiquidGlassEnabled(), false);
      assert.equal(readGitHubEventsVisible("github.com/BrosInCode/letagents"), false);
      assert.equal(readGitHubEventsVisible("github.com/BrosInCode/other"), true);
    });

    withLocalStorage({}, () => {
      assert.equal(readSoundEnabled(), true);
      assert.equal(readNotificationsEnabled(), false);
      assert.equal(readLiquidGlassEnabled(), true);
      assert.equal(readGitHubEventsVisible("github.com/BrosInCode/letagents"), true);
    });
  });

  it("persists GitHub events visibility per normalized room", () => {
    const entries: Record<string, string> = {};
    withMutableLocalStorage(entries, () => {
      rememberGitHubEventsVisible("GitHub.com/BrosInCode/LetAgents", false);
      assert.equal(readGitHubEventsVisible("github.com/brosincode/letagents"), false);
      assert.deepEqual(JSON.parse(entries["letagents-desktop:github-events-visible"]), {
        "github.com/brosincode/letagents": false,
      });

      rememberGitHubEventsVisible("github.com/BrosInCode/letagents", true);
      assert.equal(readGitHubEventsVisible("github.com/BrosInCode/letagents"), true);
    });
  });

  it("falls back when storage or notification APIs are unavailable", () => {
    withThrowingLocalStorage(() => {
      assert.equal(readSoundEnabled(), true);
      assert.equal(readNotificationsEnabled(), false);
      assert.equal(readLiquidGlassEnabled(), true);
      assert.equal(readGitHubEventsVisible("github.com/BrosInCode/letagents"), true);
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

function roomInfo(overrides: Partial<DesktopRoomInfo> = {}): DesktopRoomInfo {
  return {
    identifier: "github.com/BrosInCode/letagents",
    code: "ROOM",
    name: "github.com/BrosInCode/letagents",
    displayName: "letagents",
    role: "Admin",
    authenticated: true,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    focusParentVisibility: null,
    focusActivityScope: null,
    focusGitHubEventRouting: null,
    focusSettings: null,
    focusArchivedAt: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    ...overrides,
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

function withMutableLocalStorage(entries: Record<string, string>, callback: () => void): void {
  withWindow({
    localStorage: {
      getItem(key: string): string | null {
        return entries[key] ?? null;
      },
      setItem(key: string, value: string): void {
        entries[key] = value;
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

async function withWindowAsync(value: object, callback: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  try {
    await callback();
  } finally {
    restoreGlobalProperty("window", previous);
  }
}

async function flushPromises(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
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
