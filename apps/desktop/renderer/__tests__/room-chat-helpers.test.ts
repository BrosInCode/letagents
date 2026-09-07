import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { ref } from "vue";

import type {
  DesktopAgentPresence,
  DesktopManagedAgentChangeSummary,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageAttachment,
} from "../../electron/ipc-types";
import {
  isMentionableRoomParticipant,
  roomMentionCandidates,
  sortMentionableRoomParticipants,
} from "../src/domain/participants";
import { isIdleReasoningSession } from "../src/domain/reasoning";
import {
  decodeManagedAgentChangeSummaryAttachment,
  isManagedAgentChangeSummaryAttachment,
  MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME,
  managedAgentChangedFileStateLabel,
  managedAgentChangeSummarySubtitle,
  managedAgentChangeSummaryTitle,
  visibleManagedAgentChangedFiles,
} from "../src/domain/managed-agent-changes";
import { formatBytes } from "../src/components/desktop/content/attachments/formatting";
import {
  attachmentHref,
  attachmentKey,
  attachmentMeta,
  imageAttachmentId,
  isImageAttachment,
} from "../src/components/desktop/content/desktop-chat-message/attachments";
import {
  agentTargetWithPresenceSession,
  hasReasoningStreamSurface,
  latestReasoningForAgent,
  useAgentReasoningLauncher,
} from "../src/components/desktop/content/room-chat/useAgentReasoningLauncher";
import {
  applyThreadQuoteToDraft,
  buildThreadIndicatorSummary,
  buildThreadSummaries,
  scrollThreadMessageIntoView,
  resolveThreadParent,
  roomTimelineMessages,
  threadQuotePreview,
  threadReadState,
  threadReplies,
} from "../src/components/desktop/content/room-chat/thread-utils";
import { buildMessageTimelineEntries } from "../src/components/desktop/content/room-chat/timeline";
import { getAppendedMessageIds } from "../src/components/desktop/content/room-chat/message-arrival";
import {
  applySelectedTextQuoteToDraft,
  selectedTextQuoteBlock,
} from "../src/components/desktop/content/room-chat/message-format";
import {
  isLowSignalGitHubCheckMessage,
  parseGitHubEvent,
} from "../src/components/desktop/content/desktop-chat-message/github-event";
import {
  parseSenderIdentity,
  resolveOwnerAttribution,
} from "../src/components/desktop/content/desktop-chat-message/identity";
import {
  isAmbientSystemMessage,
  renderMessageText,
  stripStatusPrefix,
} from "../src/components/desktop/content/desktop-chat-message/message-rendering";
import { renderDesktopMarkdown } from "../src/components/desktop/content/formatting/markdown";
import { useDesktopRoomSearch } from "../src/components/desktop/content/room-shell/useDesktopRoomSearch";

describe("room chat helpers", () => {
  it("only animates genuinely appended messages", () => {
    assert.deepEqual(getAppendedMessageIds([], ["msg_1"]), []);
    assert.deepEqual(getAppendedMessageIds(["msg_2"], ["msg_1", "msg_2"]), []);
    assert.deepEqual(getAppendedMessageIds(["msg_1"], ["msg_1", "msg_2", "msg_3"]), ["msg_2", "msg_3"]);
    assert.deepEqual(getAppendedMessageIds(["msg_1"], ["msg_9", "msg_10"]), []);
  });

  it("keeps routine status annotations quiet without muting failures", () => {
    assert.equal(isAmbientSystemMessage("LetAgents", "[status] task_1 is in review"), true);
    assert.equal(isAmbientSystemMessage("system", "[STATUS] worker connected"), true);
    assert.equal(isAmbientSystemMessage("LetAgents", "[status] task_1 is blocked"), false);
    assert.equal(isAmbientSystemMessage("agent", "[status] reviewing PR"), false);
    assert.equal(stripStatusPrefix("[status] task_1 is done"), "task_1 is done");
  });

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

  it("decodes managed agent change summary attachments", () => {
    const { sessionId: _sessionId, repoRootPath: _repoRootPath, ...summary } = managedAgentChangeSummary();
    const attachment: DesktopRoomMessageAttachment = {
      id: "managed-agent-change-summary",
      name: "Agent changes",
      fileName: "agent-changes.json",
      mimeType: MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME,
      sizeBytes: 120,
      url: null,
      downloadUrl: null,
      dataUrl: null,
      contentBase64: Buffer.from(JSON.stringify({
        kind: "managed_agent_change_summary",
        version: 1,
        summary: {
          ...summary,
          changeScope: "working_tree",
        },
      }), "utf8").toString("base64"),
    };

    const decoded = decodeManagedAgentChangeSummaryAttachment(attachment);

    assert.equal(isManagedAgentChangeSummaryAttachment(attachment), true);
    assert.equal("repoRootPath" in (decoded ?? {}), false);
    assert.equal(decoded?.changedFileCount, 2);
    assert.equal(managedAgentChangeSummaryTitle(decoded), "Working tree changes: 2 files");
    assert.equal(managedAgentChangeSummarySubtitle(decoded), "tracked +8  tracked -1  1 untracked");
    assert.equal(
      managedAgentChangeSummaryTitle(null, false, { unavailable: true }),
      "Change summary unavailable",
    );
    assert.equal(
      managedAgentChangeSummarySubtitle(null, false, { unavailable: true }),
      "Attachment could not be loaded.",
    );
    assert.deepEqual(visibleManagedAgentChangedFiles(decoded, false).map((file) => file.path), [
      "apps/desktop/App.vue",
      "notes.md",
    ]);
    assert.equal(managedAgentChangedFileStateLabel(decoded!.files[1]!), "untracked");
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

  it("keeps quote replies in the room timeline when no explicit thread root is present", () => {
    const messages = [
      roomMessage("msg_1", null),
      roomMessage("msg_2", "msg_1", "2026-05-28T00:02:00.000Z", { threadRootId: "msg_2" }),
      roomMessage("msg_3", "msg_1", "2026-05-28T00:03:00.000Z"),
    ];

    const summaries = buildThreadSummaries(messages);

    assert.deepEqual(roomTimelineMessages(messages).map((message) => message.id), ["msg_1", "msg_2"]);
    assert.deepEqual(threadReplies(messages, "msg_1").map((message) => message.id), ["msg_3"]);
    assert.equal(summaries.get("msg_1")?.count, 1);
    assert.equal(summaries.get("msg_1")?.latest?.id, "msg_3");
  });

  it("adds date breaks and compacts short same-sender bursts", () => {
    const messages = [
      roomMessage("msg_1", null, "2026-05-28T12:00:00.000Z"),
      roomMessage("msg_2", null, "2026-05-28T12:01:00.000Z"),
      roomMessage("msg_3", null, "2026-05-29T12:00:00.000Z"),
    ];

    const entries = buildMessageTimelineEntries(messages);

    assert.deepEqual(entries.map((entry) => entry.type), ["date", "message", "message", "date", "message"]);
    assert.equal(entries[2]?.type === "message" ? entries[2].compactWithPrevious : false, true);
    assert.equal(entries[4]?.type === "message" ? entries[4].compactWithPrevious : true, false);
  });

  it("does not compact messages across replies, attachments, or noisy senders", () => {
    const second = roomMessage("msg_2", null, "2026-05-28T00:01:00.000Z");
    second.attachments = [{
      id: null,
      name: "screen",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 1,
      url: null,
      downloadUrl: null,
      dataUrl: null,
      contentBase64: null,
    }];
    const github = {
      ...roomMessage("msg_3", null, "2026-05-28T00:02:00.000Z"),
      sender: "github",
      source: "github",
    };

    const entries = buildMessageTimelineEntries([
      roomMessage("msg_1", null, "2026-05-28T00:00:00.000Z"),
      second,
      github,
    ]);
    const messageEntries = entries.filter((entry) => entry.type === "message");

    assert.deepEqual(messageEntries.map((entry) => entry.compactWithPrevious), [false, false, false]);
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

  it("searches and quotes readable board approval copy", () => {
    const approval = roomMessage("msg_approval", null, "2026-09-07T00:00:00Z");
    approval.text = "@agent:owner/lumen Board intent bi_123 was approved.";
    approval.displayText = "@LumenRiver — Your request to claim task_19: Tests and CI was approved.";
    const search = useDesktopRoomSearch(ref([approval]));
    search.searchQuery.value = "Tests and CI";
    assert.equal(search.searchResults.value[0]?.id, approval.id);
    assert.equal(threadQuotePreview(approval), approval.displayText);
    search.searchQuery.value = "bi_123";
    assert.equal(search.searchResults.value.length, 0);
    assert.match(approval.text, /bi_123/);
  });

  it("finds and scrolls the requested thread message through its shared DOM contract", () => {
    const calls: ScrollIntoViewOptions[] = [];
    const elements = ["msg_root", "msg_reply"].map((messageId) => ({
      dataset: { threadMessageId: messageId },
      scrollIntoView: (options: ScrollIntoViewOptions) => calls.push(options),
    })) as unknown as HTMLElement[];
    const root = {
      querySelectorAll: () => elements,
    } as unknown as Pick<ParentNode, "querySelectorAll">;

    const target = scrollThreadMessageIntoView(root, "msg_reply", "smooth");

    assert.equal(target, elements[1]);
    assert.deepEqual(calls, [{ behavior: "smooth", block: "center" }]);
    assert.equal(scrollThreadMessageIntoView(root, "msg_missing"), null);
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

  it("keeps Inspector identity raw while retaining presence enrichment for legacy reasoning", () => {
    const target = {
      actorLabel: "DawnHarbor | EmmyMay's agent | Codex",
      displayName: "DawnHarbor",
      ownerAttribution: "EmmyMay's agent",
      ideLabel: "Codex",
      sender: "DawnHarbor | EmmyMay's agent | Codex",
      agentKey: null,
      agentSessionId: null,
    };
    const dawn = presenceEntry({
      actorLabel: target.actorLabel,
      displayName: "DawnHarbor",
      agentSessionId: "agent_session_403",
    });
    const sameProviderPeer = presenceEntry({
      actorLabel: "SilverCove | EmmyMay's agent | Codex",
      displayName: "DawnHarbor",
      agentSessionId: "agent_session_402",
    });
    let openedTarget = null as typeof target | null;
    const launcher = useAgentReasoningLauncher({
      presence: () => [sameProviderPeer, dawn],
      reasoningSessions: () => [],
      openReasoning: () => assert.fail("detail route should not open reasoning"),
      openFallback: () => assert.fail("detail route should not open fallback"),
      openAgentDetail: (resolved) => { openedTarget = resolved; },
    });

    launcher.openAgentModal(target);

    assert.equal(openedTarget?.agentSessionId, null, "Inspector resolution must bypass actor-label presence inference");
    assert.equal(agentTargetWithPresenceSession(target, [sameProviderPeer, dawn]).agentSessionId, "agent_session_403");
  });

  it("fails closed when a clicked message identity maps to multiple room sessions", () => {
    const target = {
      actorLabel: "SharedActor | EmmyMay's agent | Codex",
      displayName: "SharedActor",
      ownerAttribution: "EmmyMay's agent",
      ideLabel: "Codex",
      sender: "SharedActor | EmmyMay's agent | Codex",
      agentKey: "EmmyMay/sharedactor",
      agentSessionId: null,
    };
    const first = presenceEntry({
      actorLabel: target.actorLabel,
      agentKey: target.agentKey,
      agentSessionId: "agent_session_first",
    });
    const second = presenceEntry({
      actorLabel: target.actorLabel,
      agentKey: target.agentKey,
      agentSessionId: "agent_session_second",
    });

    assert.equal(agentTargetWithPresenceSession(target, [first, second]).agentSessionId, null);
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

  it("recovers desktop message ownership from partial structured identity", () => {
    assert.equal(resolveOwnerAttribution({ ownerLabel: "EmmyMay" }), "EmmyMay's agent");
    assert.equal(
      resolveOwnerAttribution({ actorLabel: "Oak | EmmyMay's agent | Codex" }),
      "EmmyMay's agent",
    );
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

  it("prioritizes reachable delivery agents before applying the mention cap", () => {
    const existingHumans = Array.from({ length: 7 }, (_, index) =>
      participant({
        participantKey: `human:${index}`,
        displayName: `Human${index}`,
        githubLogin: `human${index}`,
      })
    );
    const reachableAgent = participant({
      participantKey: "agent-presence:lumenvale",
      kind: "agent",
      displayName: "LumenVale",
      actorLabel: "LumenVale",
      agentKey: "cursor/lumenvale",
      githubLogin: null,
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
    });

    const cappedCandidates = sortMentionableRoomParticipants([
      ...existingHumans,
      reachableAgent,
    ].filter(isMentionableRoomParticipant)).slice(0, 6);

    assert.equal(cappedCandidates.length, 6);
    assert.equal(cappedCandidates[0].displayName, "LumenVale");
    assert.equal(cappedCandidates.some((candidate) => candidate.displayName === "Human6"), false);
  });

  it("adds @everyone as the first room mention candidate", () => {
    const candidates = roomMentionCandidates([
      participant({
        participantKey: "human:emmy",
        displayName: "EmmyMay",
        githubLogin: "emmymay",
      }),
      participant({
        participantKey: "agent-presence:lumenvale",
        kind: "agent",
        displayName: "LumenVale",
        actorLabel: "LumenVale",
        agentKey: "cursor/lumenvale",
        githubLogin: null,
        ownerLabel: "EmmyMay",
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
    ], "");

    assert.equal(candidates[0]?.participantKey, "room:everyone");
    assert.equal(candidates[0]?.displayName, "everyone");
    assert.equal(candidates[0]?.insertText, "everyone");
    assert.equal(candidates[0]?.label, "Everyone");
    assert.equal(candidates[1]?.displayName, "LumenVale");
    assert.equal(candidates[1]?.label, "EmmyMay's agent");
    assert.equal(roomMentionCandidates([participant({
      participantKey: "agent-presence:lumenvale",
      kind: "agent",
      displayName: "LumenVale",
      githubLogin: null,
      ownerLabel: "EmmyMay",
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
    })], "emmy")[0]?.displayName, "LumenVale");
  });

  it("filters the @everyone mention candidate by query", () => {
    assert.equal(roomMentionCandidates([], "eve")[0]?.insertText, "everyone");
    assert.equal(roomMentionCandidates([], "lumen").length, 0);
  });

  it("recovers mention ownership from actor labels and disambiguates duplicate agent names", () => {
    const candidates = roomMentionCandidates([
      participant({
        participantKey: "agent:alice/oak",
        kind: "agent",
        displayName: "Oak",
        actorLabel: "Oak | Alice's agent | Codex",
        agentKey: "local/Alice/codex/oak",
        githubLogin: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
      participant({
        participantKey: "agent:bob/oak",
        kind: "agent",
        displayName: "Oak",
        actorLabel: "Oak | Bob's agent | Codex",
        agentKey: "local/Bob/codex/oak",
        githubLogin: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
    ], "bob");

    assert.equal(candidates[0]?.label, "Bob's agent");
    assert.equal(candidates[0]?.insertText, "agent:local/Bob/codex/oak");
  });

  it("excludes duplicate agent names when no stable agent key can disambiguate them", () => {
    const candidates = roomMentionCandidates([
      participant({
        participantKey: "agent:alice/oak",
        kind: "agent",
        displayName: "Oak",
        actorLabel: "Oak | Alice's agent | Codex",
        agentKey: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
      participant({
        participantKey: "agent:bob/oak",
        kind: "agent",
        displayName: "Oak",
        actorLabel: "Oak | Bob's agent | Codex",
        agentKey: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
    ], "oak");

    assert.deepEqual(candidates, []);
  });

  it("uses canonical handles for supervised names the desktop parser cannot address", () => {
    const stable = roomMentionCandidates([participant({
      participantKey: "agent:local/alice/codex/agent-smith",
      kind: "agent",
      displayName: "Agent Smith",
      actorLabel: "Agent Smith | Alice's agent | Codex",
      agentKey: "local/Alice/codex/agent-smith",
      githubLogin: null,
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
    })], "smith");
    const unaddressable = roomMentionCandidates([participant({
      participantKey: "agent:legacy-agent-smith",
      kind: "agent",
      displayName: "Agent Smith",
      actorLabel: "Agent Smith | Alice's agent | Codex",
      agentKey: null,
      githubLogin: null,
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
    })], "smith");

    assert.equal(stable[0]?.insertText, "agent:local/Alice/codex/agent-smith");
    assert.deepEqual(unaddressable, [], "the UI never inserts a label the activation parser would truncate");
  });

  it("shows and inserts a unique friendly Open Model codename", () => {
    const candidates = roomMentionCandidates([participant({
      participantKey: "desktop-supervisor-agent:supervised_1",
      kind: "agent",
      displayName: "GardenWinter",
      actorLabel: "GardenWinter | EmmyMay's agent | Open Model",
      agentKey: "EmmyMay/desktop-open-model-4d8fe3",
      githubLogin: null,
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
    })], "garden");

    assert.equal(candidates[0]?.displayName, "GardenWinter");
    assert.equal(candidates[0]?.insertText, "GardenWinter");
  });

  it("falls back to exact durable handles when friendly supervised names collide", () => {
    const candidates = roomMentionCandidates([
      participant({
        participantKey: "desktop-supervisor-agent:supervised_1",
        kind: "agent",
        displayName: "GardenWinter",
        actorLabel: "GardenWinter | EmmyMay's agent | Open Model",
        agentKey: "EmmyMay/desktop-open-model-first",
        githubLogin: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
      participant({
        participantKey: "desktop-supervisor-agent:supervised_2",
        kind: "agent",
        displayName: "GardenWinter",
        actorLabel: "GardenWinter | EmmyMay's agent | Open Model",
        agentKey: "EmmyMay/desktop-open-model-second",
        githubLogin: null,
        activityState: "active",
        sourceFlags: ["delivery", "presence"],
      }),
    ], "garden");

    assert.deepEqual(
      candidates.map((candidate) => candidate.insertText),
      [
        "agent:EmmyMay/desktop-open-model-first",
        "agent:EmmyMay/desktop-open-model-second",
      ],
    );
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
      '<p>Hello &lt;script&gt; <span class="mention-token">@Noether</span> <strong><mark class="message-search-hit">ship</mark></strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a></p>',
    );
  });

  it("links loaded message id references in desktop message text", () => {
    assert.equal(
      renderMessageText("See msg_6's note, not msg_99.", "", new Set(["msg_6"])),
      '<p>See <button class="message-reference-link" type="button" data-message-reference-id="msg_6" title="Jump to msg_6">msg_6</button>\'s note, not msg_99.</p>',
    );
  });

  it("does not link message id references inside code or URLs", () => {
    assert.equal(
      renderMessageText("Use `msg_6` or https://example.com/msg_6 before msg_7", "", new Set(["msg_6", "msg_7"])),
      '<p>Use <code>msg_6</code> or <a href="https://example.com/msg_6" target="_blank" rel="noopener noreferrer">https://example.com/msg_6</a> before <button class="message-reference-link" type="button" data-message-reference-id="msg_7" title="Jump to msg_7">msg_7</button></p>',
    );
  });

  it("links loaded task references to the Board", () => {
    assert.equal(
      renderMessageText(
        "Continue task_42, then task_99.",
        "",
        undefined,
        new Set(["task_42"]),
      ),
      '<p>Continue <button class="message-reference-link task-reference-link" type="button" data-task-reference-id="task_42" title="Open task_42 on the Board">task_42</button>, then task_99.</p>',
    );
  });

  it("keeps task references linked when search highlights only part of the id", () => {
    assert.equal(
      renderMessageText(
        "Continue task_42.",
        "42",
        undefined,
        new Set(["task_42"]),
      ),
      '<p>Continue <button class="message-reference-link task-reference-link" type="button" data-task-reference-id="task_42" title="Open task_42 on the Board">task_<mark class="message-search-hit">42</mark></button>.</p>',
    );
  });

  it("highlights escaped HTML characters without breaking encoded message text", () => {
    assert.equal(
      renderMessageText('Say "quote" & <tag>.', '"quote"'),
      '<p>Say <mark class="message-search-hit">&quot;quote&quot;</mark> &amp; &lt;tag&gt;.</p>',
    );
    assert.equal(
      renderMessageText('Say "quote" & <tag>.', "&"),
      '<p>Say &quot;quote&quot; <mark class="message-search-hit">&amp;</mark> &lt;tag&gt;.</p>',
    );
    assert.equal(
      renderMessageText('Say "quote" & <tag>.', "<tag>"),
      '<p>Say &quot;quote&quot; &amp; <mark class="message-search-hit">&lt;tag&gt;</mark>.</p>',
    );
  });

  it("does not link task references inside code or existing links", () => {
    assert.equal(
      renderMessageText(
        "Use `task_42` or https://example.com/task_42 before task_7",
        "",
        undefined,
        new Set(["task_42", "task_7"]),
      ),
      '<p>Use <code>task_42</code> or <a href="https://example.com/task_42" target="_blank" rel="noopener noreferrer">https://example.com/task_42</a> before <button class="message-reference-link task-reference-link" type="button" data-task-reference-id="task_7" title="Open task_7 on the Board">task_7</button></p>',
    );
  });

  it("formats selected-text quotes as the message target with optional source context", () => {
    assert.equal(
      selectedTextQuoteBlock("first line\n\nsecond line", "msg_42"),
      "> first line\n>\n> second line\n\nSource message: msg_42",
    );
    assert.equal(
      applySelectedTextQuoteToDraft("Adding context here", "target chunk", "msg_42"),
      "> target chunk\n\nSource message: msg_42\n\nAdding context here",
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

  it("renders safe block markdown in desktop message bubbles", () => {
    assert.equal(
      renderMessageText([
        "## Review",
        "",
        "- **Approved**",
        "- [x] Tests pass",
        "",
        "> Use `npm test`",
        "",
        "1. Ship",
        "2. Monitor",
        "",
        "```ts",
        'const safe = "<ok>"',
        "```",
      ].join("\n"), ""),
      '<h2>Review</h2><ul><li><strong>Approved</strong></li><li><input class="markdown-task-checkbox" type="checkbox" disabled checked>Tests pass</li></ul><blockquote><p>Use <code>npm test</code></p></blockquote><ol><li>Ship</li><li>Monitor</li></ol><pre><code class="language-ts">const safe = &quot;&lt;ok&gt;&quot;</code></pre>',
    );
  });

  it("bounds adversarial blockquote nesting in desktop messages", () => {
    const html = renderMessageText(`${">".repeat(5_000)} safe`, "");
    assert.match(html, /safe/);
    assert.ok((html.match(/<blockquote>/g) || []).length <= 9);
  });
});

function roomMessage(
  id: string,
  replyToId: string | null,
  timestamp = "2026-05-28T00:00:00.000Z",
  options: { threadRootId?: string } = {},
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
    threadRootId: options.threadRootId || replyToId || id,
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

function managedAgentChangeSummary(): DesktopManagedAgentChangeSummary {
  return {
    sessionId: "local_session_1",
    providerId: "codex",
    repoRootPath: "/tmp/repo",
    repoBranch: "main",
    changedFileCount: 2,
    stagedFileCount: 0,
    unstagedFileCount: 1,
    untrackedFileCount: 1,
    additions: 8,
    deletions: 1,
    files: [
      {
        path: "apps/desktop/App.vue",
        previousPath: null,
        status: "modified",
        additions: 8,
        deletions: 1,
        binary: false,
        staged: false,
        unstaged: true,
        untracked: false,
      },
      {
        path: "notes.md",
        previousPath: null,
        status: "untracked",
        additions: 0,
        deletions: 0,
        binary: false,
        staged: false,
        unstaged: false,
        untracked: true,
      },
    ],
    hiddenFileCount: 0,
    isGitRepo: true,
    updatedAt: "2026-07-02T00:00:00.000Z",
    error: null,
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

function presenceEntry(overrides: Partial<DesktopAgentPresence> = {}): DesktopAgentPresence {
  return {
    agentKey: null,
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
    ...overrides,
  };
}
