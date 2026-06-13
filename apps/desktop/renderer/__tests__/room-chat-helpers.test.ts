import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";

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
import {
  buildThreadSummaries,
  recentThreadActivities,
  resolveThreadParent,
  roomTimelineMessages,
  threadReplies,
} from "../src/components/desktop/content/room-chat/thread-utils";
import {
  isLowSignalGitHubCheckMessage,
  parseGitHubEvent,
} from "../src/components/desktop/content/desktop-chat-message/github-event";
import { parseSenderIdentity } from "../src/components/desktop/content/desktop-chat-message/identity";
import { renderMessageText } from "../src/components/desktop/content/desktop-chat-message/message-rendering";
import { renderDesktopMarkdown } from "../src/components/desktop/content/formatting/markdown";
import { useDesktopRoomSearch } from "../src/components/desktop/content/room-shell/useDesktopRoomSearch";

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
    assert.deepEqual(roomTimelineMessages(messages).map((message) => message.id), ["msg_1"]);
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

  it("resolves thread parents from reply snapshots and ranks recent thread activity", () => {
    const messages = [
      roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z"),
      roomMessage("msg_4", "msg_3", "2026-05-28T00:04:00.000Z"),
      roomMessage("msg_5", "msg_1", "2026-05-28T00:05:00.000Z"),
    ];

    assert.deepEqual(resolveThreadParent(messages, "msg_1")?.text, "msg_1");
    assert.equal(resolveThreadParent(messages, "missing"), null);

    const activities = recentThreadActivities(messages);

    assert.deepEqual(activities.map((activity) => activity.parent.id), ["msg_1", "msg_3"]);
    assert.deepEqual(activities.map((activity) => activity.latest.id), ["msg_5", "msg_4"]);
    assert.equal(activities[0]?.count, 2);
  });

  it("searches thread replies even when they are hidden from the room timeline", () => {
    const messages = [
      roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z"),
    ];
    const search = useDesktopRoomSearch(ref(messages));

    search.searchQuery.value = "msg_2";

    assert.equal(search.searchResults.value.length, 1);
    assert.equal(search.activeSearchMessageId.value, "msg_2");
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

  it("identifies low-signal GitHub check messages for chat suppression", () => {
    assert.equal(
      isLowSignalGitHubCheckMessage({
        ...roomMessage("github_skipped", null),
        sender: "github",
        source: "github",
        text: 'Check "docker" (GitHub Actions) skipped in BrosInCode/letagents https://example.com/check',
      }),
      true
    );
    assert.equal(
      isLowSignalGitHubCheckMessage({
        ...roomMessage("github_failure", null),
        sender: "github",
        source: "github",
        text: 'Check "integration-tests" (GitHub Actions) failure in BrosInCode/letagents https://example.com/check',
      }),
      false
    );
    assert.equal(isLowSignalGitHubCheckMessage(roomMessage("msg_1", null)), false);
  });

  it("renders desktop message text with escaped markup and search highlights", () => {
    assert.equal(
      renderMessageText("Hello <script> @Noether **ship** https://example.com", "ship"),
      'Hello &lt;script&gt; <span class="mention-token">@Noether</span> <strong><mark class="message-search-hit">ship</mark></strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
    );
  });

  it("renders reusable block markdown for GitHub event bodies", () => {
    assert.equal(
      renderDesktopMarkdown('## Summary\n- **Ship** `events`\n- See https://example.com/?q=a&b=c\n\n<script>', {
        block: true,
        mentions: false,
      }),
      '<h2>Summary</h2><ul><li><strong>Ship</strong> <code>events</code></li><li>See <a href="https://example.com/?q=a&amp;b=c" target="_blank" rel="noopener noreferrer">https://example.com/?q=a&amp;b=c</a></li></ul><p>&lt;script&gt;</p>',
    );
  });
});

function roomMessage(
  id: string,
  replyToId: string | null,
  timestamp = "2026-05-28T00:00:00.000Z",
): DesktopRoomMessage {
  return {
    id,
    sender: "Emmy",
    text: id,
    attachments: [],
    agentPromptKind: null,
    source: "user",
    timestamp,
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
