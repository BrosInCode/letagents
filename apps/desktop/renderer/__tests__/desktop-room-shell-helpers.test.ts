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
