import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";

export type ActivityState = "active" | "away" | "offline";
export type ParticipantKind = "agent" | "human";
export type ActivityIcon = "radio" | "pulse" | "power" | "user" | "brain" | "clock" | "task";
export type ActivityTone = "reachable" | "signal" | "offline" | "human" | "reasoning" | "history" | "task";

export interface ActivitySummaryCard {
  value: number;
  label: string;
  icon: ActivityIcon;
  tone: ActivityTone;
}

export interface ActivityParticipant {
  key: string;
  kind: ParticipantKind;
  label: string;
  actorLabel: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  runtime: string | null;
  activityState: ActivityState | null;
  status: DesktopAgentPresence["status"] | null;
  statusText: string | null;
  livenessObservation: DesktopAgentPresence["livenessObservation"];
  workState: string | null;
  workLabel: string | null;
  lastSeenAt: string | null;
  messageCount: number;
  reasoningCount: number;
  currentTasks: DesktopTaskSummary[];
  completedTasks: DesktopTaskSummary[];
  activeReasoning: DesktopReasoningSession[];
  latestReasoning: DesktopReasoningSession | null;
  latestReasoningFields: Array<{ label: string; value: string }>;
  sources: string[];
}

export interface RoomActivityViewModelInput {
  recentActivity: DesktopActivityEntry[];
  participants: DesktopParticipantSummary[];
  liveClearedCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
  messages: DesktopRoomMessage[];
  workers: WorkerSnapshot[];
}
