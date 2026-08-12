export type DesktopBoardManagerMode = "off" | "manager_optional" | "intent_required";

export type DesktopBoardManagerRuntimeSource =
  | "desktop_managed"
  | "open_model"
  | "external"
  | "unknown";

export interface DesktopBoardManagerCandidate {
  agentSessionId: string;
  agentKey: string;
  actorLabel: string;
  displayName: string;
  runtime: string;
  runtimeSource: DesktopBoardManagerRuntimeSource;
  lastSeenAt: string;
  isActiveManager: boolean;
}

export interface DesktopBoardGovernanceActiveManager {
  assignmentId: string;
  agentSessionId: string;
  agentKey: string;
  actorLabel: string;
  runtimeSource: DesktopBoardManagerRuntimeSource;
  assignedBy: string;
  lastHeartbeatAt: string | null;
}

export interface DesktopBoardIntentSummary {
  id: string;
  taskId: string | null;
  actionType: string;
  status: string;
  proposerActorLabel: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
}

export type DesktopBoardGovernanceAuditKind =
  | "coordination_event"
  | "manager_assignment"
  | "board_intent_decision";

export interface DesktopBoardGovernanceAuditEntry {
  id: string;
  kind: DesktopBoardGovernanceAuditKind;
  eventType: string;
  actorLabel: string | null;
  reason: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface DesktopBoardGovernanceWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface DesktopBoardGovernanceCapabilities {
  canViewGovernance: boolean;
  canAssignManager: boolean;
  canReleaseManager: boolean;
  canSetManagerMode: boolean;
  canDecideIntents: boolean;
}

export interface DesktopBoardGovernanceSnapshot {
  roomId: string;
  managerMode: DesktopBoardManagerMode;
  activeManager: DesktopBoardGovernanceActiveManager | null;
  candidates: DesktopBoardManagerCandidate[];
  pendingIntents: DesktopBoardIntentSummary[];
  pendingIntentCount: number;
  audit: DesktopBoardGovernanceAuditEntry[];
  warnings: DesktopBoardGovernanceWarning[];
  capabilities: DesktopBoardGovernanceCapabilities;
}

export interface DesktopBoardGovernanceAssignManagerInput {
  agentSessionId: string;
  runtimeSource?: DesktopBoardManagerRuntimeSource | null;
}

export interface DesktopBoardGovernanceReleaseManagerInput {
  reason?: string | null;
}

export interface DesktopBoardGovernanceSetModeInput {
  managerMode: DesktopBoardManagerMode;
}

export interface DesktopBoardIntentDecisionInput {
  decision: "approve" | "deny";
  reason?: string | null;
}

export interface DesktopBoardGovernanceMutationResult {
  governance: DesktopBoardGovernanceSnapshot;
}

export type DesktopBoardGovernanceSection =
  | "overview"
  | "manager"
  | "pending"
  | "audit";
