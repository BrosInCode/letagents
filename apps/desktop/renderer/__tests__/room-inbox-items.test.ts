import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopAgentPresence,
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomThreadInboxPage,
  DesktopTaskSummary,
} from "../../electron/ipc-types";
import type { DesktopSnapshotSourceStates } from "../../electron/ipc-types";
import {
  buildDesktopInboxItems,
  deriveInboxDegradation,
  desktopInboxItemFingerprint,
} from "../src/components/desktop/content/room-inbox/items";

describe("deriveInboxDegradation", () => {
  const ready = () => ({ status: "ready" as const, error: null });
  const readyStates = (): DesktopSnapshotSourceStates => ({
    focusRooms: ready(),
    tasks: ready(),
    participants: ready(),
    presence: ready(),
    reasoning: ready(),
    activityHistory: ready(),
    roomArtifacts: ready(),
    boardSettings: ready(),
    messages: ready(),
    githubEvents: ready(),
  });

  it("reports not degraded when everything is ready and threads loaded", () => {
    assert.deepEqual(deriveInboxDegradation(readyStates(), false), { degraded: false, sources: [] });
    assert.deepEqual(deriveInboxDegradation(null, false), { degraded: false, sources: [] });
  });

  it("flags inbox-relevant source failures with readable labels in order", () => {
    const states: DesktopSnapshotSourceStates = {
      ...readyStates(),
      tasks: { status: "error", error: "500" },
      githubEvents: { status: "error", error: "500" },
      reasoning: { status: "error", error: "500" },
    };
    const result = deriveInboxDegradation(states, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.sources, ["Tasks", "GitHub checks", "Agent sessions"]);
  });

  it("counts a thread-load failure as degraded", () => {
    assert.deepEqual(deriveInboxDegradation(readyStates(), true), { degraded: true, sources: ["Threads"] });
  });

  it("ignores failures in sources the inbox does not use", () => {
    const states: DesktopSnapshotSourceStates = {
      ...readyStates(),
      presence: { status: "error", error: "500" },
      participants: { status: "error", error: "500" },
      boardSettings: { status: "error", error: "500" },
    };
    assert.deepEqual(deriveInboxDegradation(states, false), { degraded: false, sources: [] });
  });
});

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

  it("surfaces offline worker agents and ignores reachable or controller presence", () => {
    const items = buildDesktopInboxItems({
      filter: "actionable",
      threadPage: null,
      tasks: [],
      githubEvents: [],
      reasoningSessions: [],
      presence: [
        presence("FieldSignal | EmmyMay's agent | Codex", "worker", "offline"),
        presence("RiverGrove | EmmyMay's agent | Claude Code", "worker", "active"),
        presence("MistyMorrow | EmmyMay's agent | Agent", "controller", "offline"),
      ],
    });

    assert.deepEqual(items.map((item) => item.kind), ["agent_offline"]);
    const item = items[0];
    assert.ok(item && item.kind === "agent_offline");
    assert.equal(item.id, "agent-offline:FieldSignal | EmmyMay's agent | Codex");
    assert.equal(item.title, "FieldSignal");
    assert.equal(item.actionable, true);
    assert.equal(item.context, "EmmyMay's agent");
    assert.equal(item.activity[0]?.tone, "danger");
  });
});

function presence(
  actorLabel: string,
  sessionKind: "controller" | "worker",
  activityState: "active" | "away" | "offline",
): DesktopAgentPresence {
  return {
    roomId: "room_1",
    actorLabel,
    agentKey: null,
    agentInstanceId: null,
    agentSessionId: null,
    sessionKind,
    runtime: "codex",
    displayName: actorLabel.split(" | ")[0] || actorLabel,
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    repoBranch: null,
    status: "idle",
    statusText: null,
    lastHeartbeatAt: "2026-06-01T08:30:00.000Z",
    freshness: activityState === "offline" ? "stale" : "active",
    activityState,
    sourceFlags: ["delivery"],
    livenessObservation: null,
  };
}

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
