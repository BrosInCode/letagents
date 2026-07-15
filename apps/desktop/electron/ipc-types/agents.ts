import type { DesktopGitRoomInfo } from "./room.js";
import type { DesktopMcpInstallTargetId } from "./setup.js";

export type DesktopAgentProviderId =
  | "claude-code"
  | "antigravity"
  | "cursor"
  | "codex"
  | "open-model"
  | (string & {});

export type DesktopAgentProviderCapability =
  | "external_mcp"
  | "desktop_managed_runtime"
  | "supervised_runtime"
  | "installable_runtime"
  | "auth_preflight"
  | "turn_control"
  | "reasoning_stream";

export type DesktopAgentProviderStatus =
  | "missing_runtime"
  | "runtime_installed"
  | "auth_required"
  | "bridge_required"
  | "config_required"
  | "repo_required"
  | "branch_mismatch"
  | "ready"
  | "running"
  | "error";

export type DesktopAgentProviderSetupAction =
  | "install_runtime"
  | "install_mcp_bridge";

export interface DesktopAgentProvider {
  id: DesktopAgentProviderId;
  name: string;
  description: string;
  capabilities: DesktopAgentProviderCapability[];
  runtimeCommand: string | null;
  mcpTargetId: DesktopMcpInstallTargetId;
  permissionProfiles: DesktopManagedAgentPermissionProfile[];
  defaultPermissionProfileId: DesktopManagedAgentPermissionProfileId | null;
}

export interface DesktopAgentProviderPreflightInput {
  roomIdentifier?: string | null;
  roomGitRoom?: DesktopGitRoomInfo | null;
  repoRootPath?: string | null;
  permissionProfileId?: DesktopManagedAgentPermissionProfileId | null;
  cursorMcpPolicy?: DesktopCursorMcpPolicy | null;
  model?: string | null;
  modelSource?: DesktopAgentProviderModelSource | null;
  effort?: DesktopManagedAgentEffort | null;
  refreshModels?: boolean | null;
}

export interface DesktopAgentProviderPreflight {
  providerId: DesktopAgentProviderId;
  status: DesktopAgentProviderStatus;
  canStart: boolean;
  message: string;
  detail: string | null;
  nextAction: DesktopAgentProviderSetupAction | "authenticate" | "choose_repo" | "choose_worktree" | null;
  version: string | null;
  mcpStatus: "not_installed" | "installed" | "needs_attention" | null;
  branchMismatch?: {
    expectedBranch: string;
    currentBranch: string | null;
    detached: boolean;
  } | null;
}

export interface DesktopAgentProviderSetupInput {
  action: DesktopAgentProviderSetupAction;
  confirmed?: boolean;
  roomIdentifier?: string | null;
  repoRootPath?: string | null;
}

export interface DesktopAgentProviderSetupResult {
  providerId: DesktopAgentProviderId;
  action: DesktopAgentProviderSetupAction;
  success: boolean;
  message: string;
  detail: string | null;
}

export type DesktopManagedAgentSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "blocked"
  | "interrupted"
  | "failed"
  | "unknown";

export type DesktopManagedAgentFailureCode =
  | "quota_exhausted"
  | "authentication_required"
  | "model_unavailable"
  | "configuration_error"
  | "provider_error";

export interface DesktopManagedAgentFailure {
  code: DesktopManagedAgentFailureCode;
  message: string;
  retryable: boolean;
  eventId: string | null;
  occurredAt: string;
}

export type DesktopManagedAgentDeliveryMode =
  | "mcp_polling"
  | "desktop_events";

export type DesktopManagedAgentEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type DesktopCursorMcpPolicy =
  | "filter_letagents"
  | "normal"
  | "none";

export type DesktopAgentProviderModelSource =
  | "provider"
  | "known"
  | "custom";

export interface DesktopAgentProviderModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  source: DesktopAgentProviderModelSource;
}

export type DesktopAgentProviderModelsStatus =
  | "ready"
  | "unavailable"
  | "error";

export interface DesktopAgentProviderModelsResult {
  providerId: DesktopAgentProviderId;
  status: DesktopAgentProviderModelsStatus;
  models: DesktopAgentProviderModelOption[];
  defaultModel: string | null;
  error: string | null;
}

export interface DesktopManagedAgentActiveWork {
  kind: "message" | "task_update";
  eventId: string | null;
  startedAt: string;
  summary: string | null;
}

export type DesktopManagedAgentPermissionProfileId =
  | "read_only"
  | "ask_before_write"
  | "sandboxed_write"
  | "full_access"
  | (string & {});

export type DesktopManagedAgentPermissionProfileStatus =
  | "available"
  | "gated"
  | "unsupported";

export type DesktopManagedAgentPermissionProfileRisk =
  | "low"
  | "medium"
  | "high";

export interface DesktopManagedAgentPermissionProfile {
  id: DesktopManagedAgentPermissionProfileId;
  label: string;
  description: string;
  status: DesktopManagedAgentPermissionProfileStatus;
  risk: DesktopManagedAgentPermissionProfileRisk;
  detail: string | null;
  isDefault: boolean;
}

export type DesktopManagedAgentPermissionDecisionBehavior = "allow" | "deny";

export interface DesktopManagedAgentPermissionRequest {
  id: string;
  providerId: DesktopAgentProviderId;
  sessionId: string;
  toolName: string;
  toolUseId: string | null;
  title: string;
  description: string | null;
  inputSummary: string | null;
  decisionReason: string | null;
  roomMessageId: string | null;
  requestedAt: string;
}

export interface DesktopManagedAgentPermissionDecisionInput {
  requestId: string;
  sessionId?: string | null;
  behavior: DesktopManagedAgentPermissionDecisionBehavior;
  message?: string | null;
}

export interface DesktopManagedAgentPermissionDecisionResult {
  requestId: string;
  accepted: boolean;
  message: string;
  session: DesktopManagedAgentSession | null;
}

export type DesktopManagedAgentChangeFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "unknown";

export interface DesktopManagedAgentChangedFile {
  path: string;
  previousPath: string | null;
  status: DesktopManagedAgentChangeFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export const MANAGED_AGENT_CHANGE_SUMMARY_ATTACHMENT_MIME =
  "application/vnd.letagents.managed-agent-change-summary+json";

export interface DesktopManagedAgentChangeSummary {
  sessionId: string;
  providerId: DesktopAgentProviderId;
  repoRootPath: string;
  repoBranch: string | null;
  changedFileCount: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  additions: number;
  deletions: number;
  files: DesktopManagedAgentChangedFile[];
  hiddenFileCount: number;
  isGitRepo: boolean;
  updatedAt: string;
  error: string | null;
}

export interface DesktopManagedAgentPublicChangeSummary {
  providerId: DesktopAgentProviderId;
  repoBranch: string | null;
  changeScope: "working_tree";
  changedFileCount: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  additions: number;
  deletions: number;
  files: DesktopManagedAgentChangedFile[];
  hiddenFileCount: number;
  isGitRepo: boolean;
  updatedAt: string;
  error: string | null;
}

export interface DesktopManagedAgentSession {
  id: string;
  providerId: DesktopAgentProviderId;
  runtime: string;
  roomIdentifier: string;
  roomDisplayName: string | null;
  repoRootPath: string;
  repoBranch: string | null;
  status: DesktopManagedAgentSessionStatus;
  deliveryMode: DesktopManagedAgentDeliveryMode;
  permissionProfileId: DesktopManagedAgentPermissionProfileId;
  permissionProfile: DesktopManagedAgentPermissionProfile;
  cursorMcpPolicy?: DesktopCursorMcpPolicy | null;
  model?: string | null;
  effort?: DesktopManagedAgentEffort | null;
  canStop: boolean;
  agentSessionId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  displayName: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  reasoningSessionId: string | null;
  activeWork: DesktopManagedAgentActiveWork | null;
  pendingPermissionRequests: DesktopManagedAgentPermissionRequest[];
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
  failure?: DesktopManagedAgentFailure | null;
  /** Daemon manifest owner. Presence disables legacy lifecycle controls. */
  supervisorEntryId?: string | null;
}

export interface DesktopManagedAgentStartInput {
  providerId: DesktopAgentProviderId;
  roomIdentifier: string;
  roomGitRoom?: DesktopGitRoomInfo | null;
  roomDisplayName?: string | null;
  repoRootPath: string;
  deliveryMode?: DesktopManagedAgentDeliveryMode;
  permissionProfileId?: DesktopManagedAgentPermissionProfileId | null;
  cursorMcpPolicy?: DesktopCursorMcpPolicy | null;
  model?: string | null;
  modelSource?: DesktopAgentProviderModelSource | null;
  effort?: DesktopManagedAgentEffort | null;
  stopPhrase?: string | null;
  maxMinutes?: number | null;
  /** Internal desktop bridge field; renderer legacy starts leave this absent. */
  supervisorEntryId?: string | null;
}

export interface DesktopManagedAgentRetryInput {
  sessionId: string;
}

export interface DesktopManagedAgentStartResult {
  session: DesktopManagedAgentSession;
  reused: boolean;
  message: string;
}

export interface DesktopManagedAgentStopInput {
  sessionId?: string | null;
  roomIdentifier?: string | null;
  stopMode?: "turn" | "worker";
  shutdownServer?: boolean;
}

export interface DesktopManagedAgentInspectResult {
  session: DesktopManagedAgentSession;
  serverReachable: boolean;
  recentItems: Array<Record<string, unknown>>;
}

export type DesktopSupervisorDesiredState = "running" | "paused" | "stopped";
export type DesktopSupervisorObservedState = "absent" | "starting" | "idle" | "working" | "checkpointing" | "pausing" | "paused" | "recovering" | "stopping" | "stopped" | "failed";
export type DesktopSupervisorCondition = "none" | "quarantined" | "coordination_blocked" | "auth_blocked" | "budget_blocked" | "security_blocked";

export interface DesktopSupervisorDaemonStatus {
  healthy: boolean;
  protocolVersion: number;
  implementationVersion: string;
  generation: number;
  pid: number;
  startedAt: string;
}

export interface DesktopSupervisorLivenessAxis {
  state: string;
  observedAt: string | null;
  detail: string | null;
}

export interface DesktopSupervisorActivityEvent {
  observedAt: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: "idle" | "working" | "reviewing" | "blocked";
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
  durablePayloadRef: string | null;
}

export interface DesktopSupervisorManifestEntry {
  id: string;
  roomId: string;
  displayName: string;
  provider: string;
  model: string | null;
  charter: string;
  desiredState: DesktopSupervisorDesiredState;
  observedState: DesktopSupervisorObservedState;
  condition: DesktopSupervisorCondition;
  /** Latest actionable daemon lifecycle failure, when one is retained. */
  lastError?: string | null;
  permissionProfileId: string | null;
  createdBy: string;
  createdAt: string;
  workspacePath: string | null;
  workAttemptId: string | null;
  workplaceLiveness: DesktopSupervisorLivenessAxis;
  nativeLiveness: DesktopSupervisorLivenessAxis;
  restartCount: number;
  lastTerminal: Record<string, unknown> | null;
  activity: DesktopSupervisorActivityEvent[];
}

export interface DesktopSupervisorCreateInput {
  /** Stable across retries of one Start action; a new intentional agent gets a new id. */
  creationRequestId?: string | null;
  roomIdentifier: string;
  displayName: string;
  providerId: DesktopAgentProviderId;
  model?: string | null;
  charter: string;
  permissionProfileId?: DesktopManagedAgentPermissionProfileId | null;
  repoRootPath: string;
}

export interface DesktopSupervisorAttemptDetail {
  entryId: string;
  workAttemptId: string | null;
  workspacePath: string | null;
  lastTerminal: Record<string, unknown> | null;
  restartCount: number;
  activity: DesktopSupervisorActivityEvent[];
}

export interface DesktopOpenModelSettingsStatus {
  configured: boolean;
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  savedAt: string | null;
  settingsPath: string;
  error: string | null;
}

export interface DesktopOpenModelSaveSettingsInput {
  baseUrl?: string | null;
  model?: string | null;
  /** A string saves a new key, null clears the saved key, undefined keeps the current key. */
  apiKey?: string | null;
}
