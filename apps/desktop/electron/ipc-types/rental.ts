export type DesktopRentalMode = "scoped" | "trusted_open";
export type DesktopRentalContinuityMode = "smart_handoff" | "full_transcript";
export type DesktopRentalContinuityIngestDepth = "tier_1" | "tier_2";
export type DesktopRentalRoomHistoryAccess = "full" | "filtered";
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
export type DesktopRentalLaunchState = "pending" | "provisioning" | "active" | "launch_failed";
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

export interface DesktopRentalMarketplaceProvider {
  accountId: string;
  displayName: string;
  login: string | null;
  avatarUrl: string | null;
  availability: "available" | "busy" | "offline" | "setup_required";
  availableSlots: number;
  supportsRepository: boolean;
  maxDurationMinutes: number | null;
  offers: DesktopRentalListing[];
}

export interface DesktopRentalMarketplace {
  providers: DesktopRentalMarketplaceProvider[];
  updatedAt: string | null;
}

export type DesktopRentalRuntimeId = "codex" | "claude-code" | "cursor" | "open-model";

export interface DesktopRentalLaunchConfiguration {
  providerId: DesktopRentalRuntimeId;
  model?: string | null;
  permissionProfileId?: string | null;
}

export interface DesktopRentalProviderRuntime {
  providerId: DesktopRentalRuntimeId;
  label: string;
  enabled: boolean;
  authenticated: boolean;
  status: "ready" | "blocked" | "offline" | "checking";
  rentalSandboxStatus: "verified" | "verification_required" | "unsupported";
  detail: string;
  permissionProfileIds: string[];
}

export interface DesktopRentalProviderSettings {
  enabled: boolean;
  maxConcurrentSessions: number;
  defaultTimeLimitMinutes: number;
  defaultLrtLimit: number;
  runtimes: DesktopRentalProviderRuntime[];
  hostId: string;
  daemonState: "online" | "offline" | "starting" | "error";
  blockers: string[];
  updatedAt: string | null;
}

export interface DesktopRentalProviderSettingsInput {
  enabled?: boolean;
  maxConcurrentSessions?: number;
  defaultTimeLimitMinutes?: number;
  defaultLrtLimit?: number;
  runtimes?: Array<Pick<DesktopRentalProviderRuntime, "providerId" | "enabled">>;
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
  maxConcurrentSessions?: number | null;
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
  maxConcurrentSessions?: number | null;
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
  roomHistoryAccess: DesktopRentalRoomHistoryAccess | null;
  continuityIngestDepth: DesktopRentalContinuityIngestDepth;
  continuityPackId: string | null;
  status: DesktopRentalSessionStatus;
  launchState: DesktopRentalLaunchState | null;
  launchErrorCode: string | null;
  launchErrorMessage: string | null;
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
  /** Every nonterminal session that consumes provider capacity. */
  capacitySessions: DesktopRentalSession[];
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
  /**
   * Whether an approval physically delivered the file into the session
   * workspace. Only present on decision responses; null when unknown
   * (list rows) or not applicable (denials).
   */
  materialized: boolean | null;
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

export type DesktopRentalProviderEvent = {
  kind: "request.created" | "request.cancelled" | "session.accepted" | "launch.updated";
  sessionId: string | null;
};

export interface DesktopRentalApi {
  getMarketplace: () => Promise<DesktopRentalMarketplace>;
  getProviderSettings: () => Promise<DesktopRentalProviderSettings>;
  verifyProviderRuntime: (providerId: DesktopRentalRuntimeId) => Promise<DesktopRentalProviderSettings>;
  updateProviderSettings: (input: DesktopRentalProviderSettingsInput) => Promise<DesktopRentalProviderSettings>;
  onProviderEvent: (callback: (event: DesktopRentalProviderEvent) => void) => () => void;
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
  acceptRequest: (id: string, configuration?: DesktopRentalLaunchConfiguration) => Promise<DesktopRentalSession>;
  declineRequest: (id: string, reason?: string) => Promise<DesktopRentalRequest>;
  getActivity: (sessionId: string) => Promise<DesktopRentalActivityEvent[]>;
  getExposures: (sessionId: string) => Promise<DesktopRentalExposure[]>;
  getContextRequests: (sessionId: string) => Promise<DesktopRentalContextApproval[]>;
  getPatches: (sessionId: string) => Promise<DesktopRentalPatch[]>;
  getUsage: (sessionId: string) => Promise<DesktopRentalUsageSnapshot>;
  getOwnQuotaStatus: () => Promise<DesktopRentalOwnQuotaStatus>;
  declareQuotaExhausted: (input?: DesktopRentalManualDeclareInput) => Promise<DesktopRentalRenterTriggerSignal>;
  approvePatch: (sessionId: string, patchId: string) => Promise<DesktopRentalPatch>;
  requestPatchChanges: (sessionId: string, patchId: string, note: string) => Promise<DesktopRentalPatch>;
  approveContextRequest: (sessionId: string, approvalId: string) => Promise<DesktopRentalContextApproval>;
  denyContextRequest: (sessionId: string, approvalId: string) => Promise<DesktopRentalContextApproval>;
}
