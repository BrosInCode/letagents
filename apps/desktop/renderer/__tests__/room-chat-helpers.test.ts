import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ref } from "vue";

import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageAttachment,
} from "../../electron/ipc-types";
import { isMentionableRoomParticipant } from "../src/domain/participants";
import { isIdleReasoningSession } from "../src/domain/reasoning";
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
  applyThreadQuoteToDraft,
  buildThreadIndicatorSummary,
  buildThreadSummaries,
  resolveThreadParent,
  roomTimelineMessages,
  threadQuotePreview,
  threadReadState,
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

  it("merges thread summary metadata into timeline indicators", () => {
    const parent = {
      ...roomMessage("msg_1", null),
      thread: {
        rootMessageId: "msg_1",
        replyCount: 5,
        unreadCount: 2,
        hasUnread: true,
        latestReply: {
          id: "msg_4",
          sender: "Grace Hopper | Codex",
          text: "backend supplied preview",
          source: "agent",
          timestamp: "2026-05-28T00:04:00.000Z",
        },
        participants: [
          { sender: "Ada Lovelace | Codex", source: "agent", messageCount: 3, latestMessageId: "msg_4" },
          { sender: "Grace Hopper", source: "user", messageCount: 2, latestMessageId: "msg_3" },
        ],
        lastReadMessageId: null,
      },
    };

    const indicator = buildThreadIndicatorSummary(parent, {
      count: 1,
      latest: roomMessage("msg_3", "msg_1", "2026-05-28T00:03:00.000Z"),
      replies: [],
    });

    assert.equal(indicator.count, 5);
    assert.equal(indicator.unreadCount, 2);
    assert.equal(indicator.latest?.id, "msg_4");
    assert.equal(indicator.latestPreview, "backend supplied preview");
    assert.equal(indicator.latestTimestamp, "2026-05-28T00:04:00.000Z");
    assert.deepEqual(indicator.participants.map((participant) => participant.displayName), [
      "Ada Lovelace",
      "Grace Hopper",
    ]);
  });

  it("lets newer live thread replies refresh stale timeline indicators", () => {
    const oldReply = roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z");
    const newReply = roomMessage("msg_3", "msg_1", "2026-05-28T00:03:00.000Z");
    newReply.text = "new live reply";
    const parent = {
      ...roomMessage("msg_1", null),
      thread: {
        rootMessageId: "msg_1",
        replyCount: 1,
        unreadCount: 0,
        hasUnread: false,
        latestReply: oldReply,
        participants: [],
        lastReadMessageId: "msg_2",
      },
    };

    const indicator = buildThreadIndicatorSummary(parent, {
      count: 2,
      latest: newReply,
      replies: [oldReply, newReply],
    });

    assert.equal(indicator.count, 2);
    assert.equal(indicator.unreadCount, 1);
    assert.equal(indicator.latest?.id, "msg_3");
    assert.equal(indicator.latestPreview, "new live reply");
    assert.equal(indicator.latestTimestamp, "2026-05-28T00:03:00.000Z");
  });

  it("computes the first unread reply from read state", () => {
    const replies = [
      roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z"),
      roomMessage("msg_3", "msg_1", "2026-05-28T00:03:00.000Z"),
      roomMessage("msg_4", "msg_1", "2026-05-28T00:04:00.000Z"),
    ];
    const parent = {
      ...roomMessage("msg_1", null),
      thread: {
        rootMessageId: "msg_1",
        replyCount: 3,
        unreadCount: 2,
        hasUnread: true,
        latestReply: null,
        participants: [],
        lastReadMessageId: "msg_2",
      },
    };

    assert.deepEqual(threadReadState(parent, replies), {
      unreadCount: 2,
      firstUnreadReplyId: "msg_3",
    });
  });

  it("places the unread divider at the first loaded reply when the read cursor is outside the page", () => {
    const replies = [
      roomMessage("msg_5", "msg_1", "2026-05-28T00:05:00.000Z"),
      roomMessage("msg_6", "msg_1", "2026-05-28T00:06:00.000Z"),
    ];
    const parent = {
      ...roomMessage("msg_1", null),
      thread: {
        rootMessageId: "msg_1",
        replyCount: 6,
        unreadCount: 2,
        hasUnread: true,
        latestReply: null,
        participants: [],
        lastReadMessageId: "msg_2",
      },
    };

    assert.deepEqual(threadReadState(parent, replies), {
      unreadCount: 2,
      firstUnreadReplyId: "msg_5",
    });
  });

  it("builds quote text for replies inside a thread", () => {
    const quoted = {
      ...roomMessage("msg_2", "msg_1"),
      sender: "Noether | Emmy's agent | codex",
      text: "This is the context to carry forward.",
      agentIdentity: {
        name: "noether",
        displayName: "Noether",
        ownerLabel: "Emmy",
        ownerAttribution: "Emmy's agent",
        ideLabel: "Codex",
        actorLabel: "Noether | Emmy's agent | Codex",
        agentKey: "Emmy/noether",
        agentSessionId: "session_1",
      },
    };

    assert.equal(threadQuotePreview(quoted), "This is the context to carry forward.");
    assert.equal(
      applyThreadQuoteToDraft("Following up", quoted),
      "> Noether: This is the context to carry forward.\n\nFollowing up",
    );
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

  it("resolves thread parents from reply snapshots", () => {
    const messages = [
      roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z"),
      roomMessage("msg_5", "msg_1", "2026-05-28T00:05:00.000Z"),
    ];

    assert.deepEqual(resolveThreadParent(messages, "msg_1")?.text, "msg_1");
    assert.equal(resolveThreadParent(messages, "missing"), null);
  });

  it("does not use a nested reply quote as the thread root fallback", () => {
    const nestedReply = roomMessage("msg_3", "msg_2", "2026-05-28T00:03:00.000Z");
    nestedReply.threadRootId = "msg_1";

    assert.equal(resolveThreadParent([nestedReply], "msg_1"), null);
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

  it("detects idle reasoning sessions before offering turn stops", () => {
    assert.equal(isIdleReasoningSession(reasoningSession("reasoning_working", "2026-05-28T02:00:00.000Z")), false);
    assert.equal(isIdleReasoningSession({
      ...reasoningSession("reasoning_idle", "2026-05-28T02:01:00.000Z"),
      status: "idle",
    }), true);
    assert.equal(isIdleReasoningSession({
      ...reasoningSession("reasoning_payload_idle", "2026-05-28T02:02:00.000Z"),
      latestPayload: {
        summary: "Waiting for the next room event.",
        status: "idle",
      },
    }), true);
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

  it("keeps anonymous and misclassified runtime names out of mention candidates", () => {
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "human",
      displayName: "anonymous",
      githubLogin: "anonymous",
    })), false);
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "human",
      displayName: "AntigravityPair",
      githubLogin: "AntigravityPair",
    })), false);
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "agent",
      displayName: "AntigravityPair",
      githubLogin: null,
      activityState: "active",
    })), true);
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "human",
      displayName: "kdnofound",
      githubLogin: "kdnofound",
    })), true);
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "human",
      displayName: "codexter",
      githubLogin: "codexter",
    })), true);
    assert.equal(isMentionableRoomParticipant(participant({
      kind: "agent",
      displayName: "OfflineAgent",
      githubLogin: null,
      activityState: "offline",
    })), false);
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
    threadRootId: replyToId || id,
    threadReplyToId: replyToId,
    thread: null,
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

function participant(overrides: Partial<DesktopParticipantSummary> = {}): DesktopParticipantSummary {
  return {
    participantKey: "human:login:emmymay",
    kind: "human",
    displayName: "EmmyMay",
    actorLabel: null,
    agentKey: null,
    githubLogin: "EmmyMay",
    ownerLabel: null,
    ideLabel: null,
    hiddenAt: null,
    activityState: null,
    lastSeenAt: "2026-05-28T00:00:00.000Z",
    lastRoomActivityAt: "2026-05-28T00:00:00.000Z",
    lastLiveHeartbeatAt: null,
    sourceFlags: ["messages"],
    ...overrides,
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
    repoBranch: null,
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
