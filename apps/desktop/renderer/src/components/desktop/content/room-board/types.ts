import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";

export type TaskAction = {
  id: string;
  label: string;
  tone: "primary" | "neutral" | "danger";
  targetStatus?: string;
  run: (task: DesktopTaskSummary) => Promise<DesktopTaskSummary>;
};

export type TaskLease = DesktopTaskSummary["activeLeases"][number];

export interface TaskGroup {
  status: string;
  label: string;
  tasks: DesktopTaskSummary[];
}

export interface AuthorityPanelState {
  state: "held" | "mismatch" | "missing";
  label: string;
  badge: string;
  detail: string;
}

export interface ReviewPanelState {
  state: "assigned" | "missing" | "conflict" | "idle";
  label: string;
  badge: string;
  detail: string;
}

export interface ReviewCandidateSelection {
  agentKey: string;
  agentInstanceId: string | null;
  agentSessionId: string;
}
