import type {
  DesktopAccountRoomActionResult,
  DesktopGitRoomInfo,
} from "./room.js";

export type DesktopAppAgentFeedbackState =
  | "configuration_required"
  | "success"
  | "choices"
  | "confirmation_required"
  | "error"
  | "info";

export type DesktopAppAgentActionRisk = "low" | "medium" | "destructive";

export type DesktopAppAgentRefreshTarget =
  | "rooms"
  | "settings"
  | "active_room"
  | "foreground";

export type DesktopAppAgentTraceStatus = "info" | "success" | "error";

export interface DesktopAppAgentSettingsStatus {
  configured: boolean;
  hasApiKey: boolean;
  model: string;
  savedAt: string | null;
  settingsPath: string;
  error: string | null;
}

export interface DesktopAppAgentSaveSettingsInput {
  openRouterApiKey?: string | null;
  model: string;
}

export interface DesktopAppAgentRunInput {
  prompt: string;
  activeRoomIdentifier?: string | null;
  activeRoomDisplayName?: string | null;
  activeRoomPinned?: boolean | null;
  activeRoomGitRoom?: DesktopGitRoomInfo | null;
  selectedAction?: DesktopAppAgentActionReference | null;
  confirmedAction?: DesktopAppAgentActionReference | null;
  confirmedPlan?: DesktopAppAgentActionPlan | null;
  /** @deprecated Use selectedAction. Kept only for compatibility with older renderer payloads. */
  selectedRoomIdentifier?: string | null;
  /** @deprecated Use selectedAction. Kept only for compatibility with older renderer payloads. */
  selectedPinned?: boolean | null;
}

export interface DesktopAppAgentActionReference {
  actionId: string;
  input: Record<string, unknown>;
  label: string;
  description?: string | null;
  risk: DesktopAppAgentActionRisk;
  refreshTargets?: DesktopAppAgentRefreshTarget[];
}

export interface DesktopAppAgentActionMetadata {
  id: string;
  toolName: string;
  displayName: string;
  capabilityName: string;
  description: string;
  displayDescription: string;
  category: "rooms" | "settings";
  risk: DesktopAppAgentActionRisk;
  requiresConfirmation: boolean;
  refreshTargets: DesktopAppAgentRefreshTarget[];
}

export interface DesktopAppAgentActionChoice {
  choiceId: string;
  label: string;
  description: string;
  actionId: string;
  input: Record<string, unknown>;
  risk: DesktopAppAgentActionRisk;
}

export interface DesktopAppAgentPendingAction {
  confirmationId: string;
  label: string;
  description: string;
  actionId: string;
  input: Record<string, unknown>;
  risk: DesktopAppAgentActionRisk;
  confirmLabel: string;
  cancelLabel: string;
}

export interface DesktopAppAgentActionPlan {
  planId: string;
  title: string;
  description: string;
  actions: DesktopAppAgentActionReference[];
  risk: DesktopAppAgentActionRisk;
  confirmLabel: string;
  cancelLabel: string;
  refreshTargets: DesktopAppAgentRefreshTarget[];
}

export type DesktopAppAgentActionExecutionStatus =
  | "success"
  | "error"
  | "skipped";

export interface DesktopAppAgentActionExecutionSummary {
  actionId: string;
  label: string;
  description?: string | null;
  status: DesktopAppAgentActionExecutionStatus;
  message: string;
  roomIdentifier?: string | null;
  displayName?: string | null;
}

export interface DesktopAppAgentTraceEntry {
  id: string;
  label: string;
  status: DesktopAppAgentTraceStatus;
  detail?: string | null;
  actionId?: string | null;
}

export interface DesktopAppAgentRunResult {
  state: DesktopAppAgentFeedbackState;
  message: string;
  roomIdentifier?: string | null;
  displayName?: string | null;
  pinned?: boolean | null;
  archived?: boolean | null;
  choices?: DesktopAppAgentActionChoice[];
  pendingAction?: DesktopAppAgentPendingAction | null;
  pendingPlan?: DesktopAppAgentActionPlan | null;
  executedActions?: DesktopAppAgentActionExecutionSummary[];
  trace?: DesktopAppAgentTraceEntry[];
  refreshTargets?: DesktopAppAgentRefreshTarget[];
  openRoomIdentifier?: string | null;
  settingsStatus?: DesktopAppAgentSettingsStatus;
  actionResult?: (DesktopAccountRoomActionResult & Record<string, unknown>) | Record<string, unknown> | null;
}
