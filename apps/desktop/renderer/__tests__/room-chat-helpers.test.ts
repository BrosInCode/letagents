import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopAgentPresence,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageAttachment,
} from "../../electron/ipc-types";
import { formatBytes } from "../src/components/desktop/content/attachments/formatting";
import {
  attachmentHref,
  attachmentKey,
  attachmentMeta,
  imageAttachmentId,
  isImageAttachment,
} from "../src/components/desktop/content/desktop-chat-message/attachments";
import {
  hasReasoningStreamSurface,
  latestReasoningForAgent,
} from "../src/components/desktop/content/room-chat/useAgentReasoningLauncher";
import { buildThreadSummaries, threadReplies } from "../src/components/desktop/content/room-chat/thread-utils";
import { parseGitHubEvent } from "../src/components/desktop/content/desktop-chat-message/github-event";
import { parseSenderIdentity } from "../src/components/desktop/content/desktop-chat-message/identity";
import { renderMessageText } from "../src/components/desktop/content/desktop-chat-message/message-rendering";

describe("room chat helpers", () => {
  it("builds image attachment ids and data URLs consistently", () => {
    const attachment: DesktopRoomMessageAttachment = {
      id: null,
      name: "screen",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 1536,
      url: null,
      downloadUrl: null,
      dataUrl: null,
      contentBase64: "abc123",
    };

    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(attachmentHref(attachment), "data:image/png;base64,abc123");
    assert.equal(attachmentKey(attachment), "screen.png-1536-image/png");
    assert.equal(attachmentMeta(attachment), "image/png · 1.5 KB");
    assert.equal(imageAttachmentId("msg_1", attachment), "msg_1:screen.png-1536-image/png");
    assert.equal(isImageAttachment(attachment), true);
  });

  it("summarizes reply threads by parent message", () => {
    const messages = [
      roomMessage("msg_1", null),
      roomMessage("msg_2", "msg_1"),
      roomMessage("msg_3", "msg_1"),
      roomMessage("msg_4", "msg_2"),
    ];

    const summaries = buildThreadSummaries(messages);

    assert.equal(summaries.get("msg_1")?.count, 2);
    assert.equal(summaries.get("msg_1")?.latest?.id, "msg_3");
    assert.equal(summaries.get("msg_2")?.count, 1);
    assert.equal(summaries.get("msg_2")?.latest?.id, "msg_4");
  });

  it("filters direct thread replies for a selected parent", () => {
    const messages = [
      roomMessage("msg_1", null),
      roomMessage("msg_2", "msg_1"),
      roomMessage("msg_3", "msg_1"),
      roomMessage("msg_4", "msg_2"),
    ];

    assert.deepEqual(threadReplies(messages, "msg_1").map((message) => message.id), ["msg_2", "msg_3"]);
    assert.deepEqual(threadReplies(messages, null), []);
  });

  it("matches agents to their newest reasoning session and stream fallback", () => {
    const target = {
      actorLabel: "Agent Smith | Codex",
      displayName: "Agent Smith",
      ideLabel: "Codex",
      sender: "agent-smith",
    };
    const oldSession = reasoningSession("reasoning_old", "2026-05-28T01:00:00.000Z");
    const newSession = reasoningSession("reasoning_new", "2026-05-28T02:00:00.000Z");

    assert.equal(latestReasoningForAgent(target, [oldSession, newSession])?.id, "reasoning_new");
    assert.equal(hasReasoningStreamSurface(target, []), true);
    assert.equal(hasReasoningStreamSurface({ ...target, ideLabel: null }, [presenceEntry()]), true);
  });

  it("parses desktop chat sender identity labels", () => {
    assert.deepEqual(parseSenderIdentity({ sender: "Noether | Emmy's agent | codex" }), {
      displayName: "Noether",
      ownerAttribution: "Emmy's agent",
      ideLabel: "Codex",
    });
    assert.deepEqual(parseSenderIdentity({ sender: "Codex Helper" }), {
      displayName: "Codex Helper",
      ownerAttribution: null,
      ideLabel: "Codex",
    });
  });

  it("maps GitHub room messages to desktop event cards", () => {
    const event = parseGitHubEvent({
      ...roomMessage("github_1", null),
      sender: "github",
      source: "github",
      text: "PR #12 opened in BrosInCode/letagents linked to task_1: Split message cards https://github.com/BrosInCode/letagents/pull/12",
    });

    assert.equal(event?.kind, "pull-request");
    assert.equal(event?.kindLabel, "Pull request");
    assert.equal(event?.statusLabel, "opened");
    assert.equal(event?.taskId, "task_1");
    assert.equal(event?.urlLabel, "Open pull request");
  });

  it("renders desktop message text with escaped markup and search highlights", () => {
    assert.equal(
      renderMessageText("Hello <script> @Noether **ship** https://example.com", "ship"),
      'Hello &lt;script&gt; <span class="mention-token">@Noether</span> <strong><mark class="message-search-hit">ship</mark></strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
    );
  });
});

function roomMessage(id: string, replyToId: string | null): DesktopRoomMessage {
  return {
    id,
    sender: "Emmy",
    text: id,
    attachments: [],
    agentPromptKind: null,
    source: "user",
    timestamp: "2026-05-28T00:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    replyTo: replyToId
      ? {
          id: replyToId,
          sender: "Emmy",
          text: replyToId,
          source: "user",
          timestamp: "2026-05-28T00:00:00.000Z",
        }
      : null,
  };
}

function reasoningSession(id: string, updatedAt: string): DesktopReasoningSession {
  return {
    id,
    roomId: "room_1",
    actorLabel: "Agent Smith | Codex",
    agentKey: null,
    taskId: null,
    title: null,
    latestPayload: null,
    summary: null,
    status: "working",
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

function presenceEntry(): DesktopAgentPresence {
  return {
    agentSessionId: "session_1",
    agentInstanceId: null,
    actorLabel: "Agent Smith | Codex",
    displayName: "Agent Smith",
    ownerLabel: null,
    ideLabel: null,
    runtime: "codex",
    sessionKind: "worker",
    sourceFlags: ["delivery"],
    freshness: "active",
    activityState: "active",
    status: "working",
    statusText: "working",
    lastHeartbeatAt: "2026-05-28T02:00:00.000Z",
    roomId: "room_1",
    livenessObservation: null,
  };
}
