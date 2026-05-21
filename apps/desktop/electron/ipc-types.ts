export interface DesktopAppInfo {
  appName: string;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  workspaceRoot: string;
  apiUrl: string | null;
}

export interface RepoWorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isCurrent: boolean;
}

export interface RepoStatus {
  rootPath: string;
  branch: string | null;
  worktrees: RepoWorktreeEntry[];
}

export interface WorkerSnapshot {
  id: string;
  runtime: string;
  state: "not_started" | "starting" | "connected" | "away" | "offline" | "failed";
  roomId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  agentSessionId: string | null;
  detail: string;
}

export interface DiagnosticsSnapshot {
  apiUrl: string | null;
  localMode: "disabled";
  notes: string[];
}

export type DesktopMcpInstallTargetId = "claude-code" | "antigravity" | "cursor" | "codex";

export interface DesktopMcpInstallTarget {
  id: DesktopMcpInstallTargetId;
  name: string;
  description: string;
  configPath: string;
  status: "not_installed" | "installed" | "needs_attention";
  lastInstalledAt: string | null;
  restartHint: string;
}

export interface DesktopMcpInstallState {
  completed: boolean;
  completedAt: string | null;
  selectedTargetId: DesktopMcpInstallTargetId | null;
  targets: DesktopMcpInstallTarget[];
}

export interface DesktopMcpInstallResult {
  success: boolean;
  target: DesktopMcpInstallTarget;
  installState: DesktopMcpInstallState;
  message: string;
}

export interface DesktopMcpInstallManyResult {
  success: boolean;
  targets: DesktopMcpInstallTarget[];
  installState: DesktopMcpInstallState;
  message: string;
}

export interface DesktopAuthAccount {
  id: string;
  provider: string;
  providerUserId: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface DesktopPendingDeviceAuth {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  roomIdentifier: string | null;
  startedAt: string;
}

export interface DesktopAuthStatus {
  authenticated: boolean;
  account: DesktopAuthAccount | null;
  pendingDeviceAuth: DesktopPendingDeviceAuth | null;
  apiUrl: string | null;
  tokenStored: boolean;
  error: string | null;
}

export interface DesktopAuthStartResult {
  pendingDeviceAuth: DesktopPendingDeviceAuth;
  authStatus: DesktopAuthStatus;
}

export interface DesktopAuthPollResult {
  status: "pending" | "slow_down" | "authorized" | "denied" | "expired" | "unknown";
  intervalSeconds: number | null;
  expiresInSeconds: number | null;
  authStatus: DesktopAuthStatus;
  error: string | null;
}

export interface DesktopRoomAccess {
  status: "ready" | "missing_room" | "auth_required" | "forbidden" | "unavailable";
  title: string;
  message: string;
  roomIdentifier: string | null;
  deviceFlowUrl: string | null;
  code: string | null;
  httpStatus: number | null;
}

export interface DesktopRoomInfo {
  identifier: string;
  code: string;
  name: string;
  displayName: string;
  role: string;
  authenticated: boolean;
  kind: "main" | "focus";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
}

export interface DesktopFocusRoomInfo {
  roomId: string;
  identifier: string;
  displayName: string;
  code: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  createdAt: string;
}

export interface DesktopTaskSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assigneeAgentKey: string | null;
  createdBy: string | null;
  prUrl: string | null;
  workflowArtifacts: Array<{
    provider: string;
    kind: string;
    id: string | null;
    number: number | null;
    title: string | null;
    url: string | null;
    ref: string | null;
    state: string | null;
  }>;
  workflowRefs: Array<{
    provider: string;
    kind: string;
    label: string;
    url: string;
  }>;
  activeLeases: Array<{
    id: string;
    kind: "work" | "review" | string;
    holderLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
    status: string;
    updatedAt: string | null;
  }>;
  activeLocks: Array<{
    id: string;
    scope: "room" | "task" | string;
    reason: string | null;
    message: string | null;
    createdBy: string | null;
  }>;
  stalePromptState: {
    isStale: boolean;
    reason: string | null;
    staleForMs: number | null;
    muted: boolean;
    mutedBy: string | null;
    mutedAt: string | null;
  } | null;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopTaskMutationResult {
  task: DesktopTaskSummary;
}

export interface DesktopTaskLeaseActionInput {
  action: "release" | "handoff";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskReviewLeaseActionInput {
  action: "assign" | "claim" | "release";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskWorkerActionInput {
  action: "claim" | "start" | "block" | "resume" | "submit_review";
  reason?: string | null;
}

export interface DesktopTaskReviewWorkerActionInput {
  action: "claim" | "release";
  lease_id?: string | null;
  reason?: string | null;
}

export type DesktopRentalMode = "scoped" | "trusted_open";
export type DesktopRentalContinuityMode = "smart_handoff" | "full_transcript";
export type DesktopRentalContinuityIngestDepth = "tier_1" | "tier_2";
/** Launch IDEs plus future adapter keys once a provider proves quota reporting. */
export type DesktopRentalIdeKind = "claude_code" | "codex" | "antigravity" | "cursor" | (string & {});
export type DesktopRentalListingStatus = "active" | "paused" | "disabled" | "setup_required";
export type DesktopRentalVerificationStatus = "verified" | "partially_verified" | "experimental" | "unreachable";
export type DesktopRentalMeterConfidence =
  | "official_exact"
  | "local_exact"
  | "derived"
  | "calibrated"
  | "estimated"
  | "weak_estimate"
  | "unknown";
export type DesktopRentalNativeQuotaUnit =
  | "tokens"
  | "credits"
  | "usd"
  | "requests"
  | "percent_window"
  | "time"
  | "unknown";
export type DesktopRentalReadinessStatus = "ready" | "degraded" | "blocked" | "unknown";
export type DesktopRentalSessionStatus =
  | "requested"
  | "accepted"
  | "provisioning"
  | "active"
  | "blocked"
  | "patch_review"
  | "pr_opened"
  | "budget_exhausted"
  | "stale"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";
export type DesktopRentalStartTrigger = "quota_exhausted" | "user_initiated" | "scheduled" | "task_handoff";
export type DesktopRentalTriggerConfidence = "exact" | "inferred" | "manual";
export type DesktopRentalTriggerReason =
  | "structured_event"
  | "percent_window_exhausted"
  | "consecutive_failures"
  | "user_declared"
  | "no_trigger";
export type DesktopRentalActivitySource = "agent" | "tool" | "patch_gate" | "system" | "renter" | "provider";
export type DesktopRentalActivityVisibility = "renter" | "provider" | "both" | "internal" | "rental_visible";
export type DesktopRentalExposureType = "file" | "search_result" | "directory_listing" | "command_output";
export type DesktopRentalSecretScanStatus = "passed" | "redacted" | "blocked";
export type DesktopRentalPatchSource = "signed_change_journal" | "explicit_patch" | "raw_diff";
export type DesktopRentalPatchGateStatus =
  | "pending"
  | "passed"
  | "passed_with_warnings"
  | "needs_renter_approval"
  | "rejected"
  | "needs_revision"
  | "timed_out";
export type DesktopRentalContextApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface DesktopRentalQuotaSnapshot {
  id: string | null;
  provider: DesktopRentalIdeKind;
  modelLabel: string | null;
  quotaLaneId: string | null;
  quotaLaneLabel: string | null;
  nativeUnit: DesktopRentalNativeQuotaUnit;
  nativeUsed: number | null;
  nativeRemaining: number | null;
  nativeLimit: number | null;
  nativeResetAt: string | null;
  nativeExpiresAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
  lrtEstimate: number | null;
  lrtRemaining: number | null;
  confidence: DesktopRentalMeterConfidence;
  source: string | null;
  observedAt: string | null;
  stale: boolean;
  raw: Record<string, unknown> | null;
}

export interface DesktopRentalUsageSnapshot {
  sessionId: string;
  lrtLimit: number | null;
  lrtReserved: number;
  lrtUsed: number;
  lrtRemaining: number | null;
  budgetStopThreshold: number | null;
  timeLimitMinutes: number | null;
  startedAt: string | null;
  endsAt: string | null;
  quotaSnapshot: DesktopRentalQuotaSnapshot | null;
  updatedAt: string | null;
}

export interface DesktopRentalRenterTriggerSignal {
  triggered: boolean;
  confidence: DesktopRentalTriggerConfidence | null;
  reason: DesktopRentalTriggerReason;
  provider: string | null;
  model: string | null;
  observedAt: string | null;
  laneResetAt: string | null;
  rawSignal: Record<string, unknown> | null;
}

export interface DesktopRentalQuotaFailureInput {
  provider: string;
  model?: string | null;
  occurredAt?: string | null;
  detail?: Record<string, unknown>;
}

export interface DesktopRentalManualDeclareInput {
  provider?: string | null;
  model?: string | null;
  note?: string | null;
  occurredAt?: string | null;
}

export interface DesktopRentalOwnQuotaStatus {
  triggered: boolean;
  lastSignal: DesktopRentalRenterTriggerSignal | null;
  lastSnapshot: DesktopRentalQuotaSnapshot | null;
  provider: string | null;
  model: string | null;
  failureCount: number;
  updatedAt: string | null;
}

export interface DesktopRentalProviderReadinessCheck {
  id: string;
  label: string;
  status: "passed" | "warning" | "failed" | "unknown";
  detail: string | null;
}

export interface DesktopRentalProviderReadiness {
  status: DesktopRentalReadinessStatus;
  summary: string | null;
  blockers: string[];
  warnings: string[];
  badges: string[];
  checks: DesktopRentalProviderReadinessCheck[];
  lastCheckedAt: string | null;
}

export interface DesktopRentalPreflightResult {
  listingId: string | null;
  provider: DesktopRentalIdeKind;
  readiness: DesktopRentalProviderReadiness;
  quotaSnapshot: DesktopRentalQuotaSnapshot | null;
  canPublish: boolean;
  ranAt: string;
}

export interface DesktopRentalListing {
  id: string;
  providerAccountId: string | null;
  providerDisplayName: string | null;
  displayName: string;
  status: DesktopRentalListingStatus;
  verificationStatus: DesktopRentalVerificationStatus;
  readinessBadges: string[];
  readiness: DesktopRentalProviderReadiness | null;
  ideKind: DesktopRentalIdeKind;
  modelLabel: string | null;
  quotaLaneId: string | null;
  quotaLaneLabel: string | null;
  meterConfidence: DesktopRentalMeterConfidence;
  nativeQuotaUnit: DesktopRentalNativeQuotaUnit;
  lastNativeQuotaSnapshot: DesktopRentalQuotaSnapshot | null;
  lastLrtEstimate: number | null;
  lastQuotaResetAt: string | null;
  verifiedAgentFingerprintId: string | null;
  supportedModes: DesktopRentalMode[];
  maxConcurrentSessions: number;
  activeSessionCount: number;
  defaultLrtLimit: number | null;
  defaultTimeLimitMinutes: number | null;
  manualAcceptRequired: boolean;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopRentalListingQuery {
  roomIdentifier?: string | null;
  ideKind?: DesktopRentalIdeKind | null;
  mode?: DesktopRentalMode | null;
  includeUnavailable?: boolean;
}

export interface DesktopRentalListingInput {
  displayName: string;
  ideKind: DesktopRentalIdeKind;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: DesktopRentalMode[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
}

export interface DesktopRentalListingPatch {
  displayName?: string;
  status?: DesktopRentalListingStatus;
  modelLabel?: string | null;
  quotaLaneId?: string | null;
  quotaLaneLabel?: string | null;
  supportedModes?: DesktopRentalMode[];
  defaultLrtLimit?: number | null;
  defaultTimeLimitMinutes?: number | null;
  manualAcceptRequired?: boolean;
}

export interface DesktopRentalAgentAvailability {
  actorLabel: string | null;
  agentKey: string | null;
  agentSessionId: string | null;
  displayName: string;
  listingId: string | null;
  listingStatus: DesktopRentalListingStatus | null;
  availability: "available" | "rented" | "offline" | "setup_required" | "not_listed";
  ideKind: DesktopRentalIdeKind | null;
  modelLabel: string | null;
  activeSessionId: string | null;
  lrtRemaining: number | null;
  quotaResetAt: string | null;
  meterConfidence: DesktopRentalMeterConfidence | null;
  badges: string[];
}

export interface DesktopRentalScope {
  includePaths: string[];
  excludePaths: string[];
  protectedPaths: string[];
  notes: string | null;
}

export interface DesktopRentalPolicy {
  maxLrt: number | null;
  maxDurationMinutes: number | null;
  maxPatchBytes: number | null;
  allowCommands: boolean;
  allowNetwork: boolean;
  requirePatchGate: boolean;
}

export interface DesktopRentalQuotaLease {
  id: string;
  laneId: string | null;
  lrtLimit: number | null;
  lrtReserved: number;
  lrtUsed: number;
  expiresAt: string | null;
  updatedAt: string | null;
}

export interface DesktopRentalStartInput {
  listingId: string;
  roomIdentifier: string;
  taskTitle: string;
  taskPrompt: string;
  repoProvider?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
  mode: DesktopRentalMode;
  continuityMode: DesktopRentalContinuityMode;
  continuityIngestDepth?: DesktopRentalContinuityIngestDepth;
  approvedScope: DesktopRentalScope;
  policy: DesktopRentalPolicy;
  startTrigger?: DesktopRentalStartTrigger;
  triggerConfidence?: DesktopRentalTriggerConfidence;
  renterLaneProvider?: string | null;
  renterLaneModel?: string | null;
  renterLaneExhaustedAt?: string | null;
  renterLaneRefreshEta?: string | null;
  renterQuotaSignal?: Record<string, unknown> | null;
}

export interface DesktopRentalSession {
  id: string;
  listingId: string;
  renterAccountId: string | null;
  providerAccountId: string | null;
  roomIdentifier: string | null;
  repoProvider: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  workBranch: string | null;
  taskTitle: string;
  taskPrompt: string;
  mode: DesktopRentalMode;
  continuityMode: DesktopRentalContinuityMode;
  continuityIngestDepth: DesktopRentalContinuityIngestDepth;
  continuityPackId: string | null;
  status: DesktopRentalSessionStatus;
  approvedScope: DesktopRentalScope;
  policy: DesktopRentalPolicy;
  quotaLease: DesktopRentalQuotaLease | null;
  nativeQuotaUnit: DesktopRentalNativeQuotaUnit | null;
  nativeQuotaStartSnapshot: DesktopRentalQuotaSnapshot | null;
  nativeQuotaLatestSnapshot: DesktopRentalQuotaSnapshot | null;
  meterConfidence: DesktopRentalMeterConfidence | null;
  lrtLimit: number | null;
  lrtReserved: number;
  lrtUsed: number;
  lrtRemaining: number | null;
  budgetStopThreshold: number | null;
  timeLimitMinutes: number | null;
  startTrigger: DesktopRentalStartTrigger | null;
  triggerConfidence: DesktopRentalTriggerConfidence | null;
  renterLaneExhaustedAt: string | null;
  renterLaneProvider: string | null;
  renterLaneModel: string | null;
  renterLaneRefreshEta: string | null;
  renterQuotaSignal: Record<string, unknown> | null;
  renterLaneRecoveredAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopRentalRequest {
  id: string;
  sessionId: string;
  listingId: string;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  renterDisplayName: string | null;
  providerDisplayName: string | null;
  taskTitle: string;
  taskPrompt: string;
  mode: DesktopRentalMode;
  continuityMode: DesktopRentalContinuityMode;
  requestedLrtLimit: number | null;
  requestedTimeLimitMinutes: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface DesktopRentalProviderDashboard {
  listings: DesktopRentalListing[];
  activeSessions: DesktopRentalSession[];
  pendingRequests: DesktopRentalRequest[];
  readiness: DesktopRentalProviderReadiness;
  quotaSnapshots: DesktopRentalQuotaSnapshot[];
  updatedAt: string | null;
}

export interface DesktopRentalActivityEvent {
  id: string;
  sessionId: string;
  roomIdentifier: string | null;
  eventType: string;
  source: DesktopRentalActivitySource;
  verified: boolean;
  visibility: DesktopRentalActivityVisibility;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DesktopRentalExposure {
  id: string;
  sessionId: string;
  path: string;
  exposureType: DesktopRentalExposureType;
  reason: string | null;
  redactionCount: number;
  secretScanStatus: DesktopRentalSecretScanStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  scopeId: string | null;
  createdAt: string;
}

export interface DesktopRentalPatchCheckResult {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "warning" | "failed" | "skipped";
  detail: string | null;
  completedAt: string | null;
}

export interface DesktopRentalPatch {
  id: string;
  sessionId: string;
  source: DesktopRentalPatchSource;
  summary: string | null;
  diffRef: string | null;
  diffPreview: string | null;
  gateStatus: DesktopRentalPatchGateStatus;
  riskScore: number | null;
  warnings: string[];
  checkResults: DesktopRentalPatchCheckResult[];
  prUrl: string | null;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopRentalContextApproval {
  id: string;
  sessionId: string;
  requestType: "read_file" | "search" | "directory_listing" | "command_output" | (string & {});
  status: DesktopRentalContextApprovalStatus;
  path: string | null;
  reason: string | null;
  redactionCount: number;
  requestedBy: string | null;
  decidedBy: string | null;
  createdAt: string | null;
  decidedAt: string | null;
}

export interface DesktopRentalContinuityReceiptSource {
  kind: "room_state" | "worktree" | "adapter_log" | "tool_hook" | "rate_limit_sidecar" | (string & {});
  label: string;
  itemCount: number;
  redactionCount: number;
  cap: number | null;
  preview: string | null;
}

export interface DesktopRentalContinuityReceipt {
  id: string;
  sessionId: string;
  mode: DesktopRentalContinuityMode;
  ingestDepth: DesktopRentalContinuityIngestDepth;
  approved: boolean;
  sources: DesktopRentalContinuityReceiptSource[];
  createdAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

export interface DesktopRentalApi {
  listListings: (input?: DesktopRentalListingQuery) => Promise<DesktopRentalListing[]>;
  getProviderDashboard: () => Promise<DesktopRentalProviderDashboard>;
  createListing: (input: DesktopRentalListingInput) => Promise<DesktopRentalListing>;
  updateListing: (id: string, input: DesktopRentalListingPatch) => Promise<DesktopRentalListing>;
  pauseListing: (id: string) => Promise<DesktopRentalListing>;
  resumeListing: (id: string) => Promise<DesktopRentalListing>;
  refreshQuota: (id: string) => Promise<DesktopRentalQuotaSnapshot>;
  runPreflight: (id?: string) => Promise<DesktopRentalPreflightResult>;
  createSession: (input: DesktopRentalStartInput) => Promise<DesktopRentalSession>;
  getSession: (id: string) => Promise<DesktopRentalSession>;
  cancelSession: (id: string) => Promise<DesktopRentalSession>;
  listProviderRequests: () => Promise<DesktopRentalRequest[]>;
  acceptRequest: (id: string) => Promise<DesktopRentalSession>;
  declineRequest: (id: string, reason?: string) => Promise<DesktopRentalRequest>;
  getActivity: (sessionId: string) => Promise<DesktopRentalActivityEvent[]>;
  getExposures: (sessionId: string) => Promise<DesktopRentalExposure[]>;
  getPatches: (sessionId: string) => Promise<DesktopRentalPatch[]>;
  getUsage: (sessionId: string) => Promise<DesktopRentalUsageSnapshot>;
  getOwnQuotaStatus: () => Promise<DesktopRentalOwnQuotaStatus>;
  declareQuotaExhausted: (input?: DesktopRentalManualDeclareInput) => Promise<DesktopRentalRenterTriggerSignal>;
  approvePatch: (sessionId: string, patchId: string) => Promise<DesktopRentalPatch>;
  requestPatchChanges: (sessionId: string, patchId: string, note: string) => Promise<DesktopRentalPatch>;
  approveContextRequest: (sessionId: string, approvalId: string) => Promise<DesktopRentalContextApproval>;
  denyContextRequest: (sessionId: string, approvalId: string) => Promise<DesktopRentalContextApproval>;
}

export interface DesktopParticipantSummary {
  participantKey: string;
  kind: "human" | "agent";
  displayName: string;
  actorLabel: string | null;
  agentKey: string | null;
  githubLogin: string | null;
  ownerLabel: string | null;
  ideLabel: string | null;
  hiddenAt: string | null;
  activityState: "active" | "away" | "offline" | null;
  lastSeenAt: string;
  lastRoomActivityAt: string | null;
  lastLiveHeartbeatAt: string | null;
  sourceFlags: Array<"delivery" | "presence" | "messages" | "tasks">;
}

export interface DesktopAgentPresence {
  roomId: string;
  actorLabel: string;
  agentKey: string | null;
  agentInstanceId: string | null;
  agentSessionId: string | null;
  sessionKind: "controller" | "worker";
  runtime: string;
  displayName: string;
  ownerLabel: string | null;
  ideLabel: string | null;
  status: "idle" | "working" | "reviewing" | "blocked";
  statusText: string | null;
  lastHeartbeatAt: string;
  freshness: "active" | "stale";
  activityState: "active" | "away" | "offline";
  sourceFlags: Array<"delivery" | "presence" | "messages" | "tasks">;
  livenessObservation: {
    roomId: string;
    agentSessionId: string;
    source: string;
    hostId: string | null;
    hostKind: string | null;
    hostLabel: string | null;
    livenessCapability: string;
    toolBridgeId: string | null;
    lastObservedAt: string;
    lastToolCallAt: string | null;
    detail: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export interface DesktopReasoningSnapshot {
  summary: string;
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  next_action?: string | null;
  milestone?: string | null;
  status?: string | null;
  confidence?: number | null;
}

export interface DesktopReasoningSession {
  id: string;
  roomId: string | null;
  actorLabel: string | null;
  agentKey: string | null;
  taskId: string | null;
  title: string | null;
  status: string | null;
  summary: string | null;
  latestPayload: DesktopReasoningSnapshot | null;
  goal: string | null;
  checking: string | null;
  hypothesis: string | null;
  blocker: string | null;
  nextAction: string | null;
  milestone: string | null;
  confidence: number | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DesktopReasoningUpdate {
  id: string;
  roomId: string | null;
  sessionId: string | null;
  actorLabel: string | null;
  status: string | null;
  summary: string | null;
  milestone: string | null;
  payload: DesktopReasoningSnapshot | null;
  createdAt: string | null;
}

export interface DesktopReasoningSessionDetail {
  session: DesktopReasoningSession;
  updates: DesktopReasoningUpdate[];
}

export interface DesktopActivityEntry {
  id: string;
  room: {
    id: string;
    displayName: string;
    kind: "main" | "focus";
    focusStatus: "active" | "concluded" | null;
    sourceTaskId: string | null;
  } | null;
  participantDisplayName: string;
  participantKind: "human" | "agent";
  participantActorLabel: string | null;
  participantOwnerLabel: string | null;
  participantIdeLabel: string | null;
  activityState: "active" | "away" | "offline" | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRoomActivityAt: string;
  messageCount: number;
  reasoningSessionCount: number;
  currentTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
  completedTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
  createdTasks: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string | null;
    workflowRefs: Array<{
      provider: string;
      kind: string;
      label: string;
      url: string;
    }>;
  }>;
}

export interface DesktopRoomMessageReply {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
}

export interface DesktopRoomMessageAttachment {
  id: string | null;
  name: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  downloadUrl: string | null;
  dataUrl: string | null;
  contentBase64: string | null;
}

export interface DesktopRoomMessage {
  id: string;
  sender: string;
  text: string;
  attachments: DesktopRoomMessageAttachment[];
  agentPromptKind: string | null;
  source: string | null;
  timestamp: string;
  actorLabel: string | null;
  agentIdentity: {
    name: string | null;
    displayName: string | null;
    ownerLabel: string | null;
    ownerAttribution: string | null;
    ideLabel: string | null;
    actorLabel: string | null;
  } | null;
  replyTo: DesktopRoomMessageReply | null;
}

export interface DesktopGitHubIntegrationStatus {
  roomId: string;
  accessRoomId: string | null;
  configured: boolean;
  setupManifestAvailable: boolean;
  connected: boolean;
  installUrlAvailable: boolean;
  repository: { fullName: string } | null;
}

export interface DesktopGitHubIntegrationActionResult {
  opened: boolean;
  message: string;
}

export interface DesktopRoomSnapshot {
  roomIdentifier: string | null;
  access: DesktopRoomAccess;
  room: DesktopRoomInfo | null;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  messages: DesktopRoomMessage[];
}

export interface DesktopSendRoomMessageResult {
  message: DesktopRoomMessage;
}

export interface DesktopRoomMessagesPage {
  messages: DesktopRoomMessage[];
  hasOlder: boolean;
}

export type DesktopRoomStreamEvent =
  | {
      type: "open";
      roomIdentifier: string;
    }
  | {
      type: "message";
      roomIdentifier: string;
      message: DesktopRoomMessage;
    }
  | {
      type: "task_update";
      roomIdentifier: string;
      task: DesktopTaskSummary;
    }
  | {
      type: "reasoning_update";
      roomIdentifier: string;
      session: DesktopReasoningSession;
    }
  | {
      type: "reasoning_remove";
      roomIdentifier: string;
      sessionId: string;
    }
  | {
      type: "rental_activity";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent;
    }
  | {
      type: "rental_patch";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent | null;
      patchId: string | null;
    }
  | {
      type: "rental_usage";
      roomIdentifier: string;
      activity: DesktopRentalActivityEvent | null;
      sessionId: string | null;
    }
  | {
      type: "rental_quota_exhausted";
      roomIdentifier: string;
      signal: DesktopRentalRenterTriggerSignal;
      status: DesktopRentalOwnQuotaStatus;
    }
  | {
      type: "session_disconnect" | "error";
      roomIdentifier: string;
      message: string | null;
    };

export interface DesktopStagedAttachment {
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewDataUrl: string | null;
}

export interface DesktopDroppedAttachmentContent {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
}

export interface DesktopRepoRoomSelection {
  canceled: boolean;
  repoPath: string | null;
  roomIdentifier: string | null;
  source: "configured" | "git_remote" | "local_fallback" | null;
  snapshot: DesktopRoomSnapshot | null;
  error: string | null;
  warning: string | null;
}

export interface DesktopInviteRoomCreation {
  roomIdentifier: string;
  code: string;
  snapshot: DesktopRoomSnapshot;
}

export interface DesktopAccountFocusRoomEntry {
  roomIdentifier: string;
  displayName: string;
  name: string;
  kind: "focus";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  role: "admin" | "participant";
  source: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
}

export interface DesktopAccountRoomEntry {
  roomIdentifier: string;
  displayName: string;
  name: string;
  kind: "main";
  parentRoomId: string | null;
  focusKey: string | null;
  sourceTaskId: string | null;
  focusStatus: "active" | "concluded" | null;
  role: "admin" | "participant";
  source: string | null;
  pinned: boolean;
  archived: boolean;
  canLeave: boolean;
  canDelete: boolean;
  deleteReason: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  focusRooms: DesktopAccountFocusRoomEntry[];
}

export interface DesktopAccountRoomActionResult {
  roomIdentifier: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
}

export interface DesktopAccountRoomListOptions {
  includeArchived?: boolean;
  limit?: number;
}

export interface DesktopApi {
  app: {
    getInfo: () => Promise<DesktopAppInfo>;
  };
  room: {
    listAccountRooms: (options?: DesktopAccountRoomListOptions) => Promise<DesktopAccountRoomEntry[]>;
    updateAccountRoom: (
      roomIdentifier: string,
      updates: { pinned?: boolean; archived?: boolean }
    ) => Promise<DesktopAccountRoomActionResult>;
    leaveAccountRoom: (roomIdentifier: string) => Promise<DesktopAccountRoomActionResult>;
    deleteAccountRoom: (roomIdentifier: string) => Promise<DesktopAccountRoomActionResult>;
    getSnapshot: (roomIdentifier?: string | null) => Promise<DesktopRoomSnapshot>;
    getMessagesBefore: (roomIdentifier: string, beforeMessageId: string, limit?: number) => Promise<DesktopRoomMessagesPage>;
    getReasoningSession: (roomIdentifier: string, sessionId: string) => Promise<DesktopReasoningSessionDetail>;
    pickAttachments: (roomIdentifier: string) => Promise<DesktopStagedAttachment[]>;
    stageDroppedAttachmentContents?: (
      roomIdentifier: string,
      files: DesktopDroppedAttachmentContent[]
    ) => Promise<DesktopStagedAttachment[]>;
    discardAttachment: (roomIdentifier: string, uploadId: string) => Promise<void>;
    startStream: (roomIdentifier: string, afterMessageId?: string | null) => Promise<void>;
    stopStream: (roomIdentifier?: string | null) => Promise<void>;
    onStreamEvent: (callback: (event: DesktopRoomStreamEvent) => void) => () => void;
    sendMessage: (
      roomIdentifier: string,
      text: string,
      replyTo?: string | null,
      attachments?: Array<{ upload_id: string }>
    ) => Promise<DesktopSendRoomMessageResult>;
    addTask: (roomIdentifier: string, title: string) => Promise<DesktopTaskMutationResult>;
    updateTask: (
      roomIdentifier: string,
      taskId: string,
      updates: { status?: string; assignee?: string | null; pr_url?: string | null }
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    updateTaskReviewLease: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewLeaseActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    runTaskReviewWorkerAction: (
      roomIdentifier: string,
      taskId: string,
      input: DesktopTaskReviewWorkerActionInput
    ) => Promise<DesktopTaskMutationResult>;
    rename: (roomIdentifier: string, displayName: string) => Promise<DesktopRoomInfo>;
    createInviteRoom: () => Promise<DesktopInviteRoomCreation>;
    getGitHubIntegrationStatus: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationStatus>;
    openGitHubInstall: (roomIdentifier: string) => Promise<DesktopGitHubIntegrationActionResult>;
  };
  rental?: DesktopRentalApi;
  auth: {
    getStatus: () => Promise<DesktopAuthStatus>;
    startDeviceFlow: (roomIdentifier?: string | null) => Promise<DesktopAuthStartResult>;
    pollDeviceFlow: (requestId?: string | null) => Promise<DesktopAuthPollResult>;
    openVerification: (url: string) => Promise<void>;
    signOut: () => Promise<DesktopAuthStatus>;
  };
  setup: {
    getMcpInstallState: () => Promise<DesktopMcpInstallState>;
    installMcpServer: (targetId: DesktopMcpInstallTargetId) => Promise<DesktopMcpInstallResult>;
    installMcpServers: (targetIds: DesktopMcpInstallTargetId[]) => Promise<DesktopMcpInstallManyResult>;
    completeMcpOnboarding: () => Promise<DesktopMcpInstallState>;
  };
  repos: {
    getStatus: () => Promise<RepoStatus>;
    pickRoom: () => Promise<DesktopRepoRoomSelection>;
  };
  workers: {
    list: () => Promise<WorkerSnapshot[]>;
  };
  diagnostics: {
    getSnapshot: () => Promise<DiagnosticsSnapshot>;
  };
}
