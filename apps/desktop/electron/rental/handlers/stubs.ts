import type {
  DesktopRentalIdeKind,
  DesktopRentalListing,
  DesktopRentalListingInput,
  DesktopRentalListingPatch,
  DesktopRentalPatch,
  DesktopRentalPreflightResult,
  DesktopRentalProviderDashboard,
  DesktopRentalProviderReadiness,
  DesktopRentalQuotaSnapshot,
  DesktopRentalRequest,
  DesktopRentalSession,
  DesktopRentalStartInput,
  DesktopRentalUsageSnapshot,
} from "../../ipc-types.js";

export function now(): string {
  return new Date().toISOString();
}

export function buildReadiness(
  status: DesktopRentalProviderReadiness["status"] = "unknown",
): DesktopRentalProviderReadiness {
  return {
    status,
    summary: null,
    blockers: status === "blocked" ? ["Rent an Agent is not fully wired yet."] : [],
    warnings: [],
    badges: [],
    checks: [],
    lastCheckedAt: now(),
  };
}

export function buildEmptyQuotaSnapshot(
  id: string | null = null,
): DesktopRentalQuotaSnapshot {
  return {
    id,
    provider: "unknown",
    modelLabel: null,
    quotaLaneId: null,
    quotaLaneLabel: null,
    nativeUnit: "unknown",
    nativeUsed: null,
    nativeRemaining: null,
    nativeLimit: null,
    nativeResetAt: null,
    nativeExpiresAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    reasoningTokens: null,
    lrtEstimate: null,
    lrtRemaining: null,
    confidence: "unknown",
    source: null,
    observedAt: now(),
    stale: true,
    raw: null,
  };
}

export function buildStubListing(
  id: string,
  input: Partial<DesktopRentalListingInput & DesktopRentalListingPatch> = {},
): DesktopRentalListing {
  const ideKind = (input.ideKind ?? "unknown") as DesktopRentalIdeKind;
  return {
    id,
    providerAccountId: null,
    providerDisplayName: null,
    displayName: input.displayName ?? "Rental listing",
    status: input.status ?? "setup_required",
    verificationStatus: "experimental",
    readinessBadges: [],
    readiness: buildReadiness("blocked"),
    ideKind,
    modelLabel: input.modelLabel ?? null,
    quotaLaneId: input.quotaLaneId ?? null,
    quotaLaneLabel: input.quotaLaneLabel ?? null,
    meterConfidence: "unknown",
    nativeQuotaUnit: "unknown",
    lastNativeQuotaSnapshot: buildEmptyQuotaSnapshot(id),
    lastLrtEstimate: null,
    lastQuotaResetAt: null,
    verifiedAgentFingerprintId: null,
    supportedModes: input.supportedModes ?? ["scoped"],
    maxConcurrentSessions: 1,
    activeSessionCount: 0,
    defaultLrtLimit: input.defaultLrtLimit ?? null,
    defaultTimeLimitMinutes: input.defaultTimeLimitMinutes ?? null,
    manualAcceptRequired: input.manualAcceptRequired ?? true,
    createdAt: null,
    updatedAt: now(),
  };
}

export function buildEmptyProviderDashboard(): DesktopRentalProviderDashboard {
  return {
    listings: [],
    activeSessions: [],
    pendingRequests: [],
    readiness: buildReadiness("unknown"),
    quotaSnapshots: [],
    updatedAt: now(),
  };
}

export function buildPreflightResult(
  listingId: string | null,
): DesktopRentalPreflightResult {
  return {
    listingId,
    provider: "unknown",
    readiness: buildReadiness("blocked"),
    quotaSnapshot: buildEmptyQuotaSnapshot(listingId),
    canPublish: false,
    ranAt: now(),
  };
}

export function buildStubSession(
  id: string,
  input: Partial<DesktopRentalStartInput> = {},
  status: DesktopRentalSession["status"] = "requested",
): DesktopRentalSession {
  return {
    id,
    listingId: input.listingId ?? "listing_stub",
    renterAccountId: null,
    providerAccountId: null,
    roomIdentifier: input.roomIdentifier ?? null,
    repoProvider: input.repoProvider ?? null,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    baseBranch: input.baseBranch ?? null,
    workBranch: null,
    taskTitle: input.taskTitle ?? "Rental session",
    taskPrompt: input.taskPrompt ?? "",
    mode: input.mode ?? "scoped",
    continuityMode: input.continuityMode ?? "smart_handoff",
    continuityIngestDepth: input.continuityIngestDepth ?? "tier_1",
    continuityPackId: null,
    status,
    approvedScope: input.approvedScope ?? {
      includePaths: [],
      excludePaths: [],
      protectedPaths: [],
      notes: null,
    },
    policy: input.policy ?? {
      maxLrt: null,
      maxDurationMinutes: null,
      maxPatchBytes: null,
      allowCommands: false,
      allowNetwork: false,
      requirePatchGate: true,
    },
    quotaLease: null,
    nativeQuotaUnit: null,
    nativeQuotaStartSnapshot: null,
    nativeQuotaLatestSnapshot: buildEmptyQuotaSnapshot(id),
    meterConfidence: "unknown",
    lrtLimit: input.policy?.maxLrt ?? null,
    lrtReserved: 0,
    lrtUsed: 0,
    lrtRemaining: input.policy?.maxLrt ?? null,
    budgetStopThreshold: null,
    timeLimitMinutes: input.policy?.maxDurationMinutes ?? null,
    startTrigger: input.startTrigger ?? null,
    triggerConfidence: input.triggerConfidence ?? null,
    renterLaneExhaustedAt: input.renterLaneExhaustedAt ?? null,
    renterLaneProvider: input.renterLaneProvider ?? null,
    renterLaneModel: input.renterLaneModel ?? null,
    renterLaneRefreshEta: input.renterLaneRefreshEta ?? null,
    renterQuotaSignal: input.renterQuotaSignal ?? null,
    renterLaneRecoveredAt: null,
    startedAt: null,
    endedAt: status === "cancelled" ? now() : null,
    createdAt: null,
    updatedAt: now(),
  };
}

export function buildStubRequest(
  id: string,
  status: DesktopRentalRequest["status"] = "pending",
): DesktopRentalRequest {
  return {
    id,
    sessionId: id,
    listingId: "listing_stub",
    status,
    renterDisplayName: null,
    providerDisplayName: null,
    taskTitle: "Rental request",
    taskPrompt: "",
    mode: "scoped",
    continuityMode: "smart_handoff",
    requestedLrtLimit: null,
    requestedTimeLimitMinutes: null,
    createdAt: null,
    expiresAt: null,
    updatedAt: now(),
  };
}

export function buildEmptyUsageSnapshot(
  sessionId: string,
): DesktopRentalUsageSnapshot {
  return {
    sessionId,
    lrtLimit: null,
    lrtReserved: 0,
    lrtUsed: 0,
    lrtRemaining: null,
    budgetStopThreshold: null,
    timeLimitMinutes: null,
    startedAt: null,
    endsAt: null,
    quotaSnapshot: buildEmptyQuotaSnapshot(sessionId),
    updatedAt: now(),
  };
}

export function buildStubPatch(
  sessionId: string,
  id: string,
  gateStatus: DesktopRentalPatch["gateStatus"],
): DesktopRentalPatch {
  return {
    id,
    sessionId,
    source: "explicit_patch",
    summary: null,
    diffRef: null,
    diffPreview: null,
    gateStatus,
    riskScore: null,
    warnings: [],
    checkResults: [],
    prUrl: null,
    createdAt: null,
    updatedAt: now(),
  };
}
