import type {
  DesktopAgentPresence,
  DesktopGitHubRoomEvent,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopRoomMessageThreadSummary,
  DesktopRoomThreadInboxPage,
  DesktopTaskSummary,
} from "../../../../../../electron/ipc-types";
import { presentDesktopGitHubEvent } from "../room-events/presenter";

export type DesktopInboxFilter = "actionable" | "all";

export type DesktopInboxItemKind =
  | "thread"
  | "task_review"
  | "task_blocked"
  | "github_failure"
  | "agent_blocked"
  | "agent_offline";

export type DesktopInboxActivityTone = "new" | "neutral" | "danger" | "success" | "warning";

export interface DesktopInboxActivity {
  id: string;
  label: string;
  description: string | null;
  timestamp: string | null;
  tone: DesktopInboxActivityTone;
}

interface DesktopInboxItemBase {
  id: string;
  kind: DesktopInboxItemKind;
  title: string;
  preview: string | null;
  context: string | null;
  timestamp: string | null;
  firstSeenTimestamp: string | null;
  occurrenceCount: number;
  actionable: boolean;
  activity: DesktopInboxActivity[];
}

export type DesktopInboxItem =
  | (DesktopInboxItemBase & {
      kind: "thread";
      root: DesktopRoomMessage;
      summary: DesktopRoomMessageThreadSummary;
      unreadCount: number;
    })
  | (DesktopInboxItemBase & {
      kind: "task_review" | "task_blocked";
      task: DesktopTaskSummary;
    })
  | (DesktopInboxItemBase & {
      kind: "github_failure";
      event: DesktopGitHubRoomEvent;
      url: string | null;
    })
  | (DesktopInboxItemBase & {
      kind: "agent_blocked";
      session: DesktopReasoningSession;
    })
  | (DesktopInboxItemBase & {
      kind: "agent_offline";
      presence: DesktopAgentPresence;
    });

export interface BuildDesktopInboxItemsInput {
  filter: DesktopInboxFilter;
  threadPage: DesktopRoomThreadInboxPage | null;
  tasks: readonly DesktopTaskSummary[];
  githubEvents: readonly DesktopGitHubRoomEvent[];
  reasoningSessions: readonly DesktopReasoningSession[];
  presence?: readonly DesktopAgentPresence[];
  fallbackRepository?: string | null;
}

export function buildDesktopInboxItems(input: BuildDesktopInboxItemsInput): DesktopInboxItem[] {
  const items: DesktopInboxItem[] = [
    ...threadInboxItems(input.threadPage, input.filter),
    ...taskInboxItems(input.tasks),
    ...githubFailureInboxItems(input.githubEvents, input.fallbackRepository ?? null),
    ...agentBlockedInboxItems(input.reasoningSessions),
    ...agentOfflineInboxItems(input.presence || []),
  ];

  return items
    .filter((item) => input.filter === "all" || item.actionable)
    .sort(compareInboxItems);
}

export function desktopInboxItemFingerprint(item: DesktopInboxItem): string {
  return [
    item.id,
    item.timestamp || "",
    item.preview || "",
    item.context || "",
    String(item.occurrenceCount),
  ].join("\u001f");
}

function threadInboxItems(
  threadPage: DesktopRoomThreadInboxPage | null,
  filter: DesktopInboxFilter,
): DesktopInboxItem[] {
  return (threadPage?.threads || [])
    .filter((item) => filter === "all" || item.summary.unreadCount > 0 || item.summary.hasUnread)
    .map(({ root, summary }) => ({
      id: `thread:${root.id}`,
      kind: "thread" as const,
      title: root.text.trim() || "Thread",
      preview: summary.latestReply?.text?.trim() || null,
      context: summary.latestReply ? `Latest reply from ${summary.latestReply.sender}` : null,
      timestamp: summary.latestReply?.timestamp || root.timestamp || null,
      firstSeenTimestamp: root.timestamp || null,
      occurrenceCount: 1,
      actionable: summary.unreadCount > 0 || summary.hasUnread,
      activity: threadActivity(root, summary),
      root,
      summary,
      unreadCount: summary.unreadCount,
    }));
}

function taskInboxItems(tasks: readonly DesktopTaskSummary[]): DesktopInboxItem[] {
  return tasks
    .filter(isTaskInboxStatus)
    .map((task) => ({
      id: `${task.status === "in_review" ? "task-review" : "task-blocked"}:${task.id}`,
      kind: task.status === "in_review" ? "task_review" as const : "task_blocked" as const,
      title: task.title || task.id,
      preview: task.description || (task.status === "in_review" ? "Needs review" : "Blocked task"),
      context: task.createdBy ? `by ${task.createdBy}` : null,
      timestamp: task.updatedAt || task.createdAt,
      firstSeenTimestamp: task.createdAt,
      occurrenceCount: 1,
      actionable: true,
      activity: taskActivity(task),
      task,
    }));
}

function githubFailureInboxItems(
  events: readonly DesktopGitHubRoomEvent[],
  fallbackRepository: string | null,
): DesktopInboxItem[] {
  const groups = new Map<string, Extract<DesktopInboxItem, { kind: "github_failure" }>>();
  for (const event of events) {
    const presented = presentDesktopGitHubEvent(event, fallbackRepository);
    if (presented.kind !== "check" || presented.tone !== "danger") continue;
    const preview = presented.sourceLabel ? `Failed check from ${presented.sourceLabel}` : "Failed check";
    const context = compactGitHubContext(presented);
    const groupKey = [presented.title, preview, context || ""].join("\u001f");
    const existing = groups.get(groupKey);
    const item: Extract<DesktopInboxItem, { kind: "github_failure" }> = {
      id: `github-failure:${hashString(groupKey)}`,
      kind: "github_failure",
      title: presented.title,
      preview,
      context,
      timestamp: presented.createdAt || null,
      firstSeenTimestamp: presented.createdAt || null,
      occurrenceCount: existing ? existing.occurrenceCount + 1 : 1,
      actionable: true,
      activity: [
        {
          id: `github:${event.id}`,
          label: `${presented.title} failed`,
          description: preview,
          timestamp: presented.createdAt || null,
          tone: "danger",
        },
      ],
      event,
      url: presented.url,
    };
    if (!existing) {
      groups.set(groupKey, item);
      continue;
    }
    const existingTime = Date.parse(existing.timestamp || "");
    const nextTime = Date.parse(item.timestamp || "");
    groups.set(groupKey, {
      ...(Number.isFinite(nextTime) && (!Number.isFinite(existingTime) || nextTime > existingTime) ? item : existing),
      firstSeenTimestamp: earlierTimestamp(existing.firstSeenTimestamp, item.firstSeenTimestamp),
      occurrenceCount: item.occurrenceCount,
      activity: sortActivity([...existing.activity, ...item.activity]),
    });
  }
  return [...groups.values()];
}

function agentBlockedInboxItems(
  sessions: readonly DesktopReasoningSession[],
): DesktopInboxItem[] {
  return sessions
    .filter(isBlockedReasoningSession)
    .map((session) => ({
      id: `agent-blocked:${session.id}`,
      kind: "agent_blocked" as const,
      title: session.title || session.actorLabel || "Blocked agent",
      preview: session.blocker || session.latestPayload?.blocker || session.summary || session.latestPayload?.summary || null,
      context: session.actorLabel || null,
      timestamp: session.updatedAt || session.createdAt,
      firstSeenTimestamp: session.createdAt,
      occurrenceCount: 1,
      actionable: true,
      activity: reasoningActivity(session),
      session,
    }));
}

function agentOfflineInboxItems(
  presence: readonly DesktopAgentPresence[],
): DesktopInboxItem[] {
  return presence
    .filter((entry) => entry.sessionKind === "worker" && entry.activityState === "offline")
    .map((entry) => ({
      id: `agent-offline:${entry.actorLabel}`,
      kind: "agent_offline" as const,
      title: entry.displayName || entry.actorLabel,
      preview: entry.statusText?.trim() || "Agent is unreachable and may have crashed",
      context: entry.ownerLabel ? `${entry.ownerLabel}'s agent` : null,
      timestamp: entry.lastHeartbeatAt || null,
      firstSeenTimestamp: entry.lastHeartbeatAt || null,
      occurrenceCount: 1,
      actionable: true,
      activity: [
        {
          id: `agent-offline:${entry.actorLabel}`,
          label: "Agent went offline",
          description: entry.statusText?.trim() || null,
          timestamp: entry.lastHeartbeatAt || null,
          tone: "danger" as const,
        },
      ],
      presence: entry,
    }));
}

function threadActivity(
  root: DesktopRoomMessage,
  summary: DesktopRoomMessageThreadSummary,
): DesktopInboxActivity[] {
  return sortActivity([
    summary.latestReply
      ? {
          id: `thread-reply:${summary.latestReply.id}`,
          label: `Latest reply from ${summary.latestReply.sender}`,
          description: summary.latestReply.text?.trim() || null,
          timestamp: summary.latestReply.timestamp,
          tone: summary.unreadCount > 0 || summary.hasUnread ? "new" : "neutral",
        }
      : null,
    {
      id: `thread-root:${root.id}`,
      label: `Thread started by ${root.sender}`,
      description: root.text.trim() || null,
      timestamp: root.timestamp || null,
      tone: "neutral",
    },
  ]);
}

function taskActivity(task: DesktopTaskSummary): DesktopInboxActivity[] {
  const blocked = task.status === "blocked";
  return sortActivity([
    {
      id: `task-status:${task.id}`,
      label: blocked ? "Task is blocked" : "Task is ready for review",
      description: task.description || null,
      timestamp: task.updatedAt || task.createdAt,
      tone: blocked ? "warning" : "success",
    },
    task.createdAt
      ? {
          id: `task-created:${task.id}`,
          label: task.createdBy ? `Created by ${task.createdBy}` : "Task created",
          description: null,
          timestamp: task.createdAt,
          tone: "neutral",
        }
      : null,
  ]);
}

function reasoningActivity(session: DesktopReasoningSession): DesktopInboxActivity[] {
  return sortActivity([
    {
      id: `reasoning-blocked:${session.id}`,
      label: "Agent is blocked",
      description: session.blocker || session.latestPayload?.blocker || session.summary || session.latestPayload?.summary || null,
      timestamp: session.updatedAt || session.createdAt,
      tone: "warning",
    },
    session.createdAt
      ? {
          id: `reasoning-created:${session.id}`,
          label: session.actorLabel ? `${session.actorLabel} started work` : "Agent session started",
          description: session.goal || null,
          timestamp: session.createdAt,
          tone: "neutral",
        }
      : null,
  ]);
}

function sortActivity(
  entries: Array<DesktopInboxActivity | null | undefined>,
): DesktopInboxActivity[] {
  return entries
    .filter((entry): entry is DesktopInboxActivity => Boolean(entry))
    .sort((left, right) => compareTimestamps(right.timestamp, left.timestamp));
}

function compactGitHubContext(
  presented: ReturnType<typeof presentDesktopGitHubEvent>,
): string | null {
  const parts = [
    presented.repository,
    presented.linkedTaskId,
    presented.actor ? `by ${presented.actor}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function isTaskInboxStatus(task: DesktopTaskSummary): boolean {
  return task.status === "in_review" || task.status === "blocked";
}

function isBlockedReasoningSession(session: DesktopReasoningSession): boolean {
  return session.status === "blocked"
    || Boolean(session.blocker?.trim())
    || Boolean(session.latestPayload?.blocker?.trim());
}

function compareInboxItems(left: DesktopInboxItem, right: DesktopInboxItem): number {
  const leftActionable = left.actionable ? 1 : 0;
  const rightActionable = right.actionable ? 1 : 0;
  if (leftActionable !== rightActionable) return rightActionable - leftActionable;

  const leftTime = Date.parse(left.timestamp || "");
  const rightTime = Date.parse(right.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(rightTime) ? 1 : -1;
  }
  return left.id.localeCompare(right.id);
}

function compareTimestamps(left: string | null, right: string | null): number {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? 1 : -1;
  }
  return 0;
}

function earlierTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime <= rightTime ? left : right;
  }
  if (Number.isFinite(leftTime)) return left;
  if (Number.isFinite(rightTime)) return right;
  return left;
}
