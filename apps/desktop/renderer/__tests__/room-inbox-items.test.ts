import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomThreadInboxPage,
  DesktopTaskSummary,
} from "../../electron/ipc-types";
import {
  buildDesktopInboxItems,
  desktopInboxItemFingerprint,
} from "../src/components/desktop/content/room-inbox/items";

describe("desktop room inbox items", () => {
  it("derives actionable inbox rows from threads, tasks, GitHub failures, and blocked agents", () => {
    const threadPage: DesktopRoomThreadInboxPage = {
      threads: [
        {
          root: roomMessage("msg_1", "Unread root", "2026-06-01T10:00:00.000Z"),
          summary: threadSummary("msg_1", 2, "2026-06-01T10:05:00.000Z"),
        },
        {
          root: roomMessage("msg_4", "Read root", "2026-06-01T09:00:00.000Z"),
          summary: threadSummary("msg_4", 0, "2026-06-01T09:05:00.000Z"),
        },
      ],
      hasMore: false,
      unreadThreadCount: 1,
    };

    const actionable = buildDesktopInboxItems({
      filter: "actionable",
      threadPage,
      tasks: [
        task("task_1", "Review me", "in_review"),
        task("task_2", "Blocked task", "blocked"),
        task("task_3", "Done task", "done"),
      ],
      githubEvents: [
        githubEvent("evt_1", "failure", "2026-06-01T08:20:00.000Z"),
        githubEvent("evt_3", "failure", "2026-06-01T08:25:00.000Z"),
        githubEvent("evt_2", "success"),
      ],
      reasoningSessions: [
        reasoning("reasoning_1", "blocked", "Need repo access"),
        reasoning("reasoning_2", "working", null),
      ],
      fallbackRepository: "BrosInCode/letagents",
    });

    assert.deepEqual(actionable.map((item) => item.kind).sort(), [
      "agent_blocked",
      "github_failure",
      "task_blocked",
      "task_review",
      "thread",
    ]);
    const githubFailure = actionable.find((item) => item.kind === "github_failure");
    assert.ok(githubFailure);
    assert.equal(githubFailure.preview, "Failed check from CI");
    assert.equal(githubFailure.context, "BrosInCode/letagents · task_133 · by github-actions");
    assert.equal(githubFailure.occurrenceCount, 2);
    assert.equal(githubFailure.timestamp, "2026-06-01T08:25:00.000Z");
    assert.equal(githubFailure.firstSeenTimestamp, "2026-06-01T08:20:00.000Z");
    assert.deepEqual(
      githubFailure.activity.map((entry) => [entry.id, entry.timestamp]),
      [
        ["github:evt_3", "2026-06-01T08:25:00.000Z"],
        ["github:evt_1", "2026-06-01T08:20:00.000Z"],
      ],
    );
    assert.notEqual(
      desktopInboxItemFingerprint(githubFailure),
      desktopInboxItemFingerprint({
        ...githubFailure,
        timestamp: "2026-06-01T08:24:00.000Z",
      }),
    );

    const all = buildDesktopInboxItems({
      filter: "all",
      threadPage,
      tasks: [],
      githubEvents: [],
      reasoningSessions: [],
    });
    assert.deepEqual(all.map((item) => item.id).sort(), ["thread:msg_1", "thread:msg_4"]);
  });
});

function roomMessage(id: string, text: string, timestamp: string): DesktopRoomMessage {
  return {
    id,
    sender: "Human",
    text,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp,
    actorLabel: null,
    agentIdentity: null,
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

function threadSummary(rootMessageId: string, unreadCount: number, latestTimestamp: string) {
  return {
    rootMessageId,
    replyCount: 1,
    unreadCount,
    hasUnread: unreadCount > 0,
    latestReply: {
      id: `${rootMessageId}_reply`,
      sender: "Agent",
      text: "Latest reply",
      source: "agent",
      timestamp: latestTimestamp,
    },
    participants: [
      {
        sender: "Human",
        source: "browser",
        messageCount: 1,
        latestMessageId: rootMessageId,
      },
    ],
    lastReadMessageId: unreadCount > 0 ? null : `${rootMessageId}_reply`,
  };
}

function task(id: string, title: string, status: string): DesktopTaskSummary {
  return {
    id,
    title,
    description: null,
    status,
    assignee: null,
    assigneeAgentKey: null,
    createdBy: null,
    prUrl: null,
    workflowArtifacts: [],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-01T08:10:00.000Z",
  };
}

function githubEvent(
  id: string,
  state: string,
  createdAt = "2026-06-01T08:20:00.000Z",
): DesktopGitHubRoomEvent {
  return {
    id,
    eventType: "check_run",
    action: "completed",
    githubObjectId: "77",
    githubObjectUrl: "https://github.com/BrosInCode/letagents/actions/runs/77",
    title: "lint",
    state,
    actorLogin: "github-actions",
    metadata: { app_name: "CI", conclusion: state },
    linkedTaskId: "task_133",
    createdAt,
  };
}

function reasoning(id: string, status: string, blocker: string | null): DesktopReasoningSession {
  return {
    id,
    roomId: "room_1",
    actorLabel: "Agent",
    agentKey: "agent/key",
    taskId: null,
    title: null,
    status,
    summary: null,
    latestPayload: null,
    goal: null,
    checking: null,
    hypothesis: null,
    blocker,
    nextAction: null,
    milestone: null,
    confidence: null,
    closedAt: null,
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-01T08:30:00.000Z",
  };
}
