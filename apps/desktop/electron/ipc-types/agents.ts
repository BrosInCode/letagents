import type { DesktopGitRoomInfo } from "./room.js";
import type { DesktopMcpInstallTargetId } from "./setup.js";
import type { RetainedExecutionDetail } from "../../shared/execution-protocol.js";

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
  | "reasoning_stream"
  /** Each durable entry owns an independently addressable provider runtime. */
  | "concurrent_supervised_agents";

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
  /**
   * Durable room-ingress owner selected when this provider is admitted to the
   * supervisor. Null means the provider is not available through that engine.
   */
  supervisedDeliveryMode?: Extract<DesktopManagedAgentDeliveryMode, "mcp_polling" | "daemon_inbox"> | null;
  runtimeCommand: string | null;
  /** Official user-run install command for an external provider runtime. */
  runtimeInstallCommand?: string | null;
  /** Official provider documentation for installing an external runtime. */
  runtimeInstallUrl?: string | null;
  /** External MCP-install target. Null when the supervised runtime injects its own bridge. */
  mcpTargetId: DesktopMcpInstallTargetId | null;
  permissionProfiles: DesktopManagedAgentPermissionProfile[];
  defaultPermissionProfileId: DesktopManagedAgentPermissionProfileId | null;
}

export interface DesktopAgentProviderPreflightInput {
  roomIdentifier?: string | null;
  roomGitRoom?: DesktopGitRoomInfo | null;
  repoRootPath?: string | null;
  /** The room is genuinely repo-less: skip the "choose a repo" gate and let the
   * agent start in a private, daemon-provisioned scratch workspace. */
  roomOnly?: boolean | null;
  launchMode?: "legacy" | "supervised" | null;
  permissionProfileId?: DesktopManagedAgentPermissionProfileId | null;
  cursorMcpPolicy?: DesktopCursorMcpPolicy | null;
  model?: string | null;
  modelSource?: DesktopAgentProviderModelSource | null;
  effort?: DesktopManagedAgentEffort | null;
  refreshModels?: boolean | null;
  /** Re-import the user's terminal PATH before checking provider commands. */
  refreshEnvironment?: boolean | null;
}

export interface DesktopAgentProviderPreflight {
  providerId: DesktopAgentProviderId;
  status: DesktopAgentProviderStatus;
  canStart: boolean;
  message: string;
  detail: string | null;
  nextAction: DesktopAgentProviderSetupAction | "install_external_runtime" | "authenticate" | "choose_repo" | "choose_worktree" | null;
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
  | "desktop_events"
  | "daemon_inbox";

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
export type DesktopLifecycleProjectionProvider = "codex" | "claude-code" | "cursor";
export interface DesktopLifecycleProjectionDiagnostics {
  available: boolean;
  providers: Record<DesktopLifecycleProjectionProvider, {
    comparedSegments: number;
    matched: number;
    missingInTyped: number;
    missingInLegacy: number;
    pairedButDifferent: number;
    conflicts: number;
    observationUnavailable: number;
  }>;
}

export interface DesktopSupervisorDaemonStatus {
  healthy: boolean;
  protocolVersion: number;
  implementationVersion: string;
  generation: number;
  pid: number;
  startedAt: string;
  recoveryDiagnostics: {
    daemonInboxWaitEvidenceDependency: number;
    lifecycleProjection: DesktopLifecycleProjectionDiagnostics;
    lifecycleLocalConformanceEligible: Record<DesktopLifecycleProjectionProvider, boolean>;
  } | null;
  capabilities: {
    roomDeliveryRetry: boolean;
    providerContinuationRepair: boolean;
    roomDeliverySkip: boolean;
    agentInspectorDetail: boolean;
    agentInspectorSettings: boolean;
    agentRoomMove: boolean;
    agentLifecycle: boolean;
    agentRuntimeRecovery?: boolean;
    agentStateSubscription: boolean;
    agentActivityStream?: boolean;
  };
}

/** Coalesced authoritative daemon state, ordered within one singleton generation. */
export interface DesktopSupervisorStateSnapshot {
  daemonGeneration: number;
  sequence: number;
  entries: DesktopSupervisorManifestEntry[];
}

/** One human retirement request. The renderer supplies the stable operation
 * id before dispatch so a completion event cannot race ahead of correlation. */
export interface DesktopSupervisorRetirementInput {
  operationId: string;
  entryId: string;
  daemonGeneration: number;
}

/** Submission acknowledges only that Electron accepted responsibility for
 * completing the durable retirement; it does not pretend cleanup is done. */
export interface DesktopSupervisorRetirementReceipt {
  operationId: string;
  entryId: string;
  daemonGeneration: number;
  status: "accepted";
}

/** Explicit completion signal for the cross-process retirement operation. */
export interface DesktopSupervisorRetirementEvent {
  operationId: string;
  entryId: string;
  daemonGeneration: number;
  status: "completed" | "failed";
  error: string | null;
  occurredAt: string;
}

/** Restart/missed-event fallback derived from the daemon's durable lifecycle
 * and Electron's encrypted grant registry. */
export interface DesktopSupervisorRetirementStatus {
  entryId: string;
  daemonGeneration: number;
  status: "pending" | "completed";
}

/** Revisioned, daemon-owned Inspector configuration. Provider never changes after creation. */
export interface DesktopSupervisorAgentConfiguration {
  entryId: string;
  daemonGeneration: number;
  provider: string;
  model: string | null;
  reasoningEffort: DesktopManagedAgentEffort | null;
  charter: string;
  permissionProfileId: DesktopManagedAgentPermissionProfileId | null;
  /** Exact permission availability for this background supervised runtime. */
  supervisedPermissionProfiles: DesktopManagedAgentPermissionProfile[];
  providerLaunchPolicy: unknown;
  configRevision: number;
  runtimeConfigurationRevision: number;
}

export interface DesktopSupervisorAgentConfigurationUpdateInput {
  entryId: string;
  daemonGeneration: number;
  expectedRevision: number;
  /** User-editable values only. Native provider policy is daemon-owned. */
  configuration: Pick<DesktopSupervisorAgentConfiguration, "model" | "reasoningEffort" | "charter" | "permissionProfileId">;
}
export type DesktopSupervisorAgentConfigurationUpdateResult =
  | { outcome: "updated"; configuration: DesktopSupervisorAgentConfiguration }
  | { outcome: "conflict"; configuration: DesktopSupervisorAgentConfiguration }
  | { outcome: "invalid"; error: string };

export type DesktopSupervisorRoomMovePhase = "prepared" | "waiting_for_current_turn" | "joining_destination" | "membership_committed" | "rotating_credentials" | "bootstrapping_destination_tail" | "active" | "failed" | "rollback_required";
export interface DesktopSupervisorRoomMove {
  operationId: string;
  requestId: string;
  entryId: string;
  sourceRoomId: string;
  destinationRoomId: string;
  daemonGeneration: number;
  workAttemptId: string | null;
  executionGenerationId: string | null;
  agentSessionId: string | null;
  phase: DesktopSupervisorRoomMovePhase;
  remoteRoomId: string | null;
  destinationCursor: string | null;
  sourceCredentialsRevoked: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DesktopSupervisorRoomMovePrepareInput { entryId: string; destinationRoomId: string; requestId: string; daemonGeneration: number }
export interface DesktopSupervisorRoomMoveOperationInput { operationId: string; entryId: string; daemonGeneration: number }
export interface DesktopSupervisorCurrentRoomMoveInput { entryId: string; daemonGeneration: number }

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

/** One event on an agent's ephemeral live feed (reasoning/text deltas + tool calls). */
export interface DesktopAgentStreamEvent {
  sequence: number;
  observedAt: string;
  kind: string;
  method: string;
  summary: string | null;
  payload: unknown;
}

/** A batch pushed for the focused agent, with `ended` once its runtime closes. */
export interface DesktopAgentStreamBatch {
  entryId: string;
  events: DesktopAgentStreamEvent[];
  ended: boolean;
  /** True when the daemon started a new provider/turn display generation. */
  reset: boolean;
  /** Events omitted because the bounded in-memory replay buffer overflowed. */
  droppedEvents: number;
}

export type DesktopRoomAgentConnectionState = "connected" | "reconnecting" | "disconnected";
export type DesktopRoomAgentIngressState = "starting" | "observing" | "backoff" | "blocked" | "stopped";
export type DesktopRoomAgentInboxState = "empty" | "queued" | "blocked" | "restoring_conversation" | "waiting_for_desktop_credentials";
export type DesktopRoomAgentTurnState = "idle" | "dispatching" | "responding" | "publishing" | "retrying" | "failed";
export type DesktopRoomAgentTaskState = "none" | "assigned" | "working" | "blocked";
export type DesktopRoomAgentReceiptState =
  | "pending"
  | "dispatching"
  | "awaiting_result"
  | "result_recovery"
  | "publishing"
  | "acknowledged"
  | "acknowledged_no_reply"
  | "acknowledged_failed"
  | "retryable"
  | "blocked"
  | "restoring_conversation"
  | "cancelled_by_room_move"
  | "cancelled_by_user"
  | "queued_behind_blocked";

export interface DesktopRoomAgentCausalEvent {
  sequence: number;
  phase: "received" | "queued" | "turn_started" | "turn_finished" | "result_unreadable" | "publish_started" | "published" | "no_reply" | "retry_scheduled" | "blocked" | "room_move_cancelled" | "conversation_restoring" | "conversation_restored" | "user_cancelled";
  observedAt: string;
  detail: string | null;
}

export interface DesktopRoomAgentDeliveryReceipt {
  inboxItemId: string;
  sourceMessageId: string;
  /** Durable order of this receipt within the agent's inbox. */
  fifoSequence: number;
  /** Deterministic daemon publication identity for this exact reply. */
  replyClientMessageId: string;
  /** Exact room message created by this supervised reply, when one exists. */
  canonicalMessageId: string | null;
  state: DesktopRoomAgentReceiptState;
  attemptCount: number;
  providerTurnId: string | null;
  blockedByMessageId: string | null;
  error: string | null;
  failureCode: "provider_continuation_missing" | null;
  terminalReason: "upgrade_authority_unavailable" | null;
  updatedAt: string;
  timeline: DesktopRoomAgentCausalEvent[];
}

/** Four independent truths; no field is inferred from another. */
export interface DesktopRoomAgentStateProjection {
  connection: {
    state: DesktopRoomAgentConnectionState;
    observedAt: string | null;
    detail: string | null;
  };
  ingress: {
    state: DesktopRoomAgentIngressState;
    observedAt: string | null;
    detail: string | null;
  };
  inbox: {
    state: DesktopRoomAgentInboxState;
    pendingCount: number;
    blockedByMessageId: string | null;
    detail: string | null;
  };
  turn: {
    state: DesktopRoomAgentTurnState;
    inboxItemId: string | null;
    sourceMessageId: string | null;
    providerTurnId: string | null;
    detail: string | null;
  };
  task: {
    state: DesktopRoomAgentTaskState;
    taskId: string | null;
    title: string | null;
  };
}

export interface DesktopSupervisorManifestEntry {
  id: string;
  roomId: string;
  displayName: string;
  /** Canonical server-owned room identity. This is routing metadata, never a credential. */
  agentKey?: string | null;
  provider: string;
  model: string | null;
  charter: string;
  desiredState: DesktopSupervisorDesiredState;
  observedState: DesktopSupervisorObservedState;
  condition: DesktopSupervisorCondition;
  /** Latest actionable daemon lifecycle failure, when one is retained. */
  lastError?: string | null;
  permissionProfileId: string | null;
  /** Durable room-ingress owner for this supervised provider. */
  deliveryMode: DesktopManagedAgentDeliveryMode;
  /** Read-only daemon-owned custody; selecting delivery mode cannot enable it. */
  pollingContract?: "custodial_polling_v1" | null;
  createdBy: string;
  createdAt: string;
  /** User-selected source checkout. Distinct from the daemon's private work-attempt workspace. */
  sourceRepoPath?: string | null;
  workspacePath: string | null;
  workAttemptId: string | null;
  /** Exact current or last-verified room worker used for control routing. */
  agentSessionId: string | null;
  agentSessionBindingState: "active" | "historical" | "none";
  bindingUpdatedAt: string | null;
  executionGenerationId: string | null;
  providerContinuationId: string | null;
  providerPid: number | null;
  workplaceLiveness: DesktopSupervisorLivenessAxis;
  nativeLiveness: DesktopSupervisorLivenessAxis;
  /** First time this entry reached ready (bound + reachable + running +
   * unblocked); set once, never cleared. Null/absent if it never reached ready. */
  readyReachedAt?: string | null;
  restartCount: number;
  lastTerminal: Record<string, unknown> | null;
  activity: DesktopSupervisorActivityEvent[];
  /** Exact-next replay watermark for bounded human turn controls. */
  lastTurnControlSequence: number;
  /** Additive causal projection for daemon-owned bounded room delivery. */
  roomAgentState?: DesktopRoomAgentStateProjection | null;
  deliveryReceipts?: DesktopRoomAgentDeliveryReceipt[];
  turnControl: {
    actionId: string;
    actionSequence: number;
    workAttemptId: string;
    executionGenerationId: string;
    targetRoomId: string | null;
    targetSourceMessageId: string | null;
    targetProviderContinuationId: string | null;
    inboxItemId: string | null;
    providerTurnId: string | null;
    /** Whether the durable action was a correction rather than a stop. */
    hasCorrection?: boolean;
    /** Bounded human-authored payload retained solely to retry this exact action. */
    correctionText?: string | null;
    status: "prepared" | "dispatching" | "completed" | "retryable" | "uncertain";
    capability: "native_interrupt" | "restart_resume" | "unsupported";
    interrupted: boolean | null;
    resumed: boolean | null;
    state: "idle" | "working" | null;
    stages: DesktopSupervisorTurnControlResult["stages"];
    error: string | null;
    recordedAt: string;
    updatedAt: string;
  } | null;
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
  /** Opaque, provider-native CLI/app-server options. The daemon forwards this unchanged. */
  launchPolicy?: unknown;
  /** Null creates an isolated, non-Git room-only work attempt. */
  repoRootPath: string | null;
}

export interface DesktopSupervisorTurnControlInput {
  entryId: string;
  /** Renderer-observed daemon and room-turn authority. The daemon validates
   * these again in the same transaction that admits the native effect. */
  daemonGeneration: number;
  roomId: string;
  workAttemptId: string;
  executionGenerationId: string;
  providerContinuationId: string;
  providerTurnId: string;
  inboxItemId: string;
  sourceMessageId: string;
  /** Stable for one click/retry; a distinct human action gets a new id. */
  actionId: string;
  /** Must be the exact next durable value, or the journal value for retry. */
  actionSequence: number;
  /** Null/blank is the non-destructive Stop-turn primitive. */
  correction?: string | null;
}

/** Renderer-safe exact identity tuple for retrying one blocked room receipt. */
export interface DesktopSupervisorRoomDeliveryRetryInput {
  entryId: string;
  roomId: string;
  sourceMessageId: string;
  workAttemptId: string;
  executionGenerationId: string;
  agentSessionId: string;
}
export type DesktopSupervisorConversationRestoreInput = DesktopSupervisorRoomDeliveryRetryInput;
export type DesktopSupervisorRoomDeliverySkipInput = DesktopSupervisorRoomDeliveryRetryInput;

/** Reinstall Electron-held credentials without touching the provider runtime. */
export interface DesktopSupervisorReconnectInput {
  entryId: string;
}

/** Replace only a provider runtime that the daemon has durably proved absent. */
export interface DesktopSupervisorRuntimeRecoveryInput {
  entryId: string;
}

export interface DesktopSupervisorTurnControlResult {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  capability: "native_interrupt" | "restart_resume" | "unsupported";
  interrupted: boolean;
  resumed: boolean;
  state: "idle" | "working";
  duplicate: boolean;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
}

export interface DesktopSupervisorTurnControlResolutionInput {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  resolution: "not_applied" | "applied";
}

export interface DesktopSupervisorAttemptDetail {
  entryId: string;
  workAttemptId: string | null;
  workspacePath: string | null;
  lastTerminal: Record<string, unknown> | null;
  restartCount: number;
  activity: DesktopSupervisorActivityEvent[];
}
export interface DesktopSupervisorAgentInspectorDetailInput { entryId: string; roomId: string; sourceMessageId?: string | null; }
export interface DesktopSupervisorAgentInspectorHistoryBoundary { earliest_retained_observed_message_id: string | null; earliest_retained_inbox_message_id: string | null; earliest_retained_receipt_sequence: number | null; pruned_before_message_id: string | null; pruned_at: string | null; }
export interface DesktopSupervisorAgentInspectorItem { source_message_id: string; inbox_item_id: string; state: Exclude<DesktopRoomAgentReceiptState, "queued_behind_blocked" | "restoring_conversation">; attempt_count: number; updated_at: string; sender: string | null; text_preview: string | null; created_at: string | null; outcome: { kind?: string; text?: string | null; evidence?: string } | null; provider_turn_id: string | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; terminal_reason: "upgrade_authority_unavailable" | null; canonical_message_id: string | null; }
export interface DesktopSupervisorUncertainEffect { effect_id: string; tool_name: string; mcp_request_id: string; error: string; created_at: string; updated_at: string; }
export interface DesktopSupervisorContinuationRepair {
  repair_id: string; agent_id: string; room_id: string; inbox_item_id: string;
  daemon_generation: number; execution_generation_id: string; work_attempt_id: string;
  expected_pid: number; expected_process_identity: string;
  missing_continuation: string; replacement_continuation: string | null;
  phase: "probing" | "replacement_created" | "committed" | "failed";
  attempt_count: number; last_error: string | null; created_at: string; updated_at: string;
}
export interface DesktopSupervisorAgentInspectorDetail {
  availability: "available" | "pruned" | "not_loaded";
  /** Optional for older supervisors; recorded evidence, never live authority. */
  recorded_execution?: RetainedExecutionDetail;
  entry_id: string; room_id: string; requested_source_message_id: string | null; inbox_item_id: string | null;
  source_message: { id: string; room_id: string; sender: string | null; text: string | null; created_at: string | null; reply_to: string | null; thread_root_id: string | null; activation: Record<string, unknown> | null } | null;
  receipt: { state: DesktopRoomAgentReceiptState; attempt_count: number; provider_turn_id: string | null; outcome: { kind?: string; text?: string | null; evidence?: string } | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; terminal_reason: "upgrade_authority_unavailable" | null; blocked_by_inbox_item_id: string | null; next_attempt_at_ms: number | null } | null;
  terminal: { outcome: string; normalized_text: string | null; evidence_source: string; observed_at: string } | null;
  publication: { client_message_id: string; canonical_message_id: string | null; room_id: string | null } | null;
  continuation_repair: DesktopSupervisorContinuationRepair | null;
  timeline: DesktopRoomAgentCausalEvent[]; items: DesktopSupervisorAgentInspectorItem[]; uncertain_effects: DesktopSupervisorUncertainEffect[]; history_boundary: DesktopSupervisorAgentInspectorHistoryBoundary | null;
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
