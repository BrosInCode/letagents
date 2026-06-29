import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import { displayNameFromActor, ideFromActor, ownerFromActor } from "../../../../domain/agents";
import { reasoningFieldRows } from "../../../../domain/reasoning";
import { sortTasksByUpdated } from "../../../../domain/tasks";
import { latestTimestamp, timestampValue } from "../../../../domain/time";
import {
  COMPLETED_TASK_STATUSES,
  INACTIVE_REASONING_STATUSES,
  OPEN_TASK_STATUSES,
} from "./constants";
import {
  isHumanMessage,
  latestStatusMessage,
  participantMatchesActor,
  participantMatchesHuman,
  sessionMatchesAgent,
} from "./matching";
import {
  activityTasksToDesktopTasks,
  mergeTasks,
} from "./taskMapping";
import {
  resolveActivityState,
  workSignalFrom,
} from "./signals";
import type { ActivityParticipant } from "./types";

interface BuildAgentParticipantInput {
  key: string;
  actorLabel: string;
  participant: DesktopParticipantSummary | null;
  presence: DesktopAgentPresence | null;
  messages: DesktopRoomMessage[];
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
  workers: WorkerSnapshot[];
  activityEntry: DesktopActivityEntry | null;
}

export function buildAgentParticipant(input: BuildAgentParticipantInput): ActivityParticipant {
  const {
    activityEntry,
    actorLabel,
    key,
    messages,
    participant,
    presence,
    reasoningSessions,
    tasks,
    workers,
  } = input;
  const activeReasoning = reasoningSessions
    .filter((session) => sessionMatchesAgent(actorLabel, participant?.displayName || presence?.displayName || actorLabel, session))
    .filter(isActiveReasoningSession)
    .sort((left, right) => timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt));
  const assignedTasks = tasks.filter((task) => participantMatchesActor(actorLabel, participant?.displayName, task.assignee));
  const currentTasks = mergeTasks(
    activityTasksToDesktopTasks(activityEntry?.currentTasks || []),
    sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status))),
  );
  const completedTasks = mergeTasks(
    activityTasksToDesktopTasks(activityEntry?.completedTasks || []),
    sortTasksByUpdated(assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))),
  ).slice(0, 6);
  const statusText = presence?.statusText || latestStatusMessage(messages) || null;
  const activityState = resolveActivityState(participant, presence);
  const workSignal = workSignalFrom(presence, statusText, currentTasks.length, activeReasoning.length);
  const messageCount = Math.max(messages.length, activityEntry?.messageCount || 0);
  const reasoningCount = Math.max(activeReasoning.length, activityEntry?.reasoningSessionCount || 0);

  return {
    key,
    kind: "agent",
    label: participant?.displayName || presence?.displayName || displayNameFromActor(actorLabel),
    actorLabel,
    agentKey: presence?.agentKey || participant?.agentKey || null,
    agentSessionId: presence?.agentSessionId || null,
    ownerLabel: participant?.ownerLabel || presence?.ownerLabel || ownerFromActor(actorLabel),
    ideLabel: participant?.ideLabel || presence?.ideLabel || ideFromActor(actorLabel),
    runtime: presence?.runtime || null,
    repoBranch: presence?.repoBranch || null,
    activityState,
    status: presence?.status || null,
    statusText,
    livenessObservation: presence?.livenessObservation || null,
    workState: workSignal?.state || null,
    workLabel: workSignal?.label || null,
    lastSeenAt: latestTimestamp(
      participant?.lastLiveHeartbeatAt,
      presence?.lastHeartbeatAt,
      presence?.livenessObservation?.lastObservedAt,
      participant?.lastRoomActivityAt,
      participant?.lastSeenAt,
      messages.at(-1)?.timestamp,
      activeReasoning[0]?.updatedAt,
      currentTasks[0]?.updatedAt,
    ),
    messageCount,
    reasoningCount,
    currentTasks,
    completedTasks,
    activeReasoning,
    latestReasoning: activeReasoning[0] || null,
    latestReasoningFields: activeReasoning[0] ? reasoningFieldRows(activeReasoning[0]) : [],
    sources: [
      ...(presence?.sourceFlags || []),
      ...(participant?.sourceFlags || []),
      messageCount > 0 ? "messages" : null,
      currentTasks.length || completedTasks.length ? "tasks" : null,
      presence?.livenessObservation ? "session liveness" : null,
      presence?.sourceFlags.includes("delivery") ? "desktop delivery" : null,
      workers.some((worker) => worker.roomId && worker.roomId === presence?.roomId) ? "local worker" : null,
    ].filter((source): source is string => Boolean(source)),
  };
}

export function buildHumanParticipant(
  participant: DesktopParticipantSummary,
  messages: DesktopRoomMessage[],
  tasks: DesktopTaskSummary[],
): ActivityParticipant {
  const humanMessages = messages.filter((message) => isHumanMessage(message) && participantMatchesHuman(participant, message.sender));
  const assignedTasks = tasks.filter((task) => participantMatchesHuman(participant, task.assignee));
  return {
    key: `human:${participant.participantKey}`,
    kind: "human",
    label: participant.displayName || participant.githubLogin || "Human",
    actorLabel: participant.githubLogin || participant.displayName,
    agentKey: null,
    agentSessionId: null,
    ownerLabel: null,
    ideLabel: null,
    runtime: null,
    repoBranch: null,
    activityState: participant.activityState,
    status: null,
    statusText: humanMessages.at(-1)?.text || null,
    livenessObservation: null,
    workState: null,
    workLabel: null,
    lastSeenAt: latestTimestamp(participant.lastRoomActivityAt, participant.lastSeenAt, humanMessages.at(-1)?.timestamp),
    messageCount: humanMessages.length,
    reasoningCount: 0,
    currentTasks: sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status))),
    completedTasks: sortTasksByUpdated(assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))).slice(0, 6),
    activeReasoning: [],
    latestReasoning: null,
    latestReasoningFields: [],
    sources: participant.sourceFlags,
  };
}

export function activityEntryForAgent(
  actorLabel: string,
  displayName: string | null,
  activityEntriesByActor: Map<string, DesktopActivityEntry>,
  normalizeAgentKey: (value: string | null | undefined) => string,
): DesktopActivityEntry | null {
  for (const key of [actorLabel, displayName].map(normalizeAgentKey)) {
    const entry = activityEntriesByActor.get(key);
    if (entry) return entry;
  }
  return null;
}

function isActiveReasoningSession(session: DesktopReasoningSession): boolean {
  if (session.closedAt) return false;
  return !INACTIVE_REASONING_STATUSES.has(String(session.status || "").toLowerCase());
}
