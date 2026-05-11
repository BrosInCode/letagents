import type { IpcMain } from "electron";

import type {
  DesktopRentalActivityEvent,
  DesktopRentalContextApproval,
  DesktopRentalExposure,
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
} from "./ipc-types.js";

export type DisabledRentalResult = {
  enabled: false;
};

type RentalIpcMain = Pick<IpcMain, "handle">;
type RentalIpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

export interface DesktopRentalHandlerOptions {
  enabled?: boolean;
}

const disabledRentalResult: DisabledRentalResult = Object.freeze({ enabled: false });

export function isRentEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LETAGENTS_RENT_ENABLED?.trim() ?? "");
}

export function registerDesktopRentalIpcHandlers(
  ipcMain: RentalIpcMain,
  options: DesktopRentalHandlerOptions = {}
): void {
  const enabled = options.enabled ?? isRentEnabled();
  const register = (channel: string, handler: RentalIpcHandler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!enabled) return disabledRentalResult;
      return handler(event, ...args);
    });
  };

  register("desktop:rental:list-listings", () => []);
  register("desktop:rental:get-provider-dashboard", () => buildEmptyProviderDashboard());
  register("desktop:rental:create-listing", (_event, input) =>
    buildStubListing("listing_stub", normalizeListingInput(input))
  );
  register("desktop:rental:update-listing", (_event, id, input) =>
    buildStubListing(String(id), normalizeListingPatch(input))
  );
  register("desktop:rental:pause-listing", (_event, id) =>
    buildStubListing(String(id), { status: "paused" })
  );
  register("desktop:rental:resume-listing", (_event, id) =>
    buildStubListing(String(id), { status: "active" })
  );
  register("desktop:rental:refresh-quota", (_event, id) => buildEmptyQuotaSnapshot(String(id)));
  register("desktop:rental:run-preflight", (_event, id) => buildPreflightResult(typeof id === "string" ? id : null));
  register("desktop:rental:create-session", (_event, input) => buildStubSession("session_stub", normalizeStartInput(input)));
  register("desktop:rental:get-session", (_event, id) => buildStubSession(String(id)));
  register("desktop:rental:cancel-session", (_event, id) => buildStubSession(String(id), undefined, "cancelled"));
  register("desktop:rental:list-provider-requests", () => []);
  register("desktop:rental:accept-request", (_event, id) => buildStubSession(String(id), undefined, "accepted"));
  register("desktop:rental:decline-request", (_event, id) => buildStubRequest(String(id), "declined"));
  register("desktop:rental:get-activity", () => [] satisfies DesktopRentalActivityEvent[]);
  register("desktop:rental:get-exposures", () => [] satisfies DesktopRentalExposure[]);
  register("desktop:rental:get-patches", () => [] satisfies DesktopRentalPatch[]);
  register("desktop:rental:get-usage", (_event, sessionId) => buildEmptyUsageSnapshot(String(sessionId)));
  register("desktop:rental:approve-patch", (_event, sessionId, patchId) =>
    buildStubPatch(String(sessionId), String(patchId), "passed")
  );
  register("desktop:rental:request-patch-changes", (_event, sessionId, patchId) =>
    buildStubPatch(String(sessionId), String(patchId), "needs_revision")
  );
  register("desktop:rental:approve-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "approved")
  );
  register("desktop:rental:deny-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "denied")
  );
}

function normalizeListingInput(input: unknown): Partial<DesktopRentalListingInput> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalListingInput> : {};
}

function normalizeListingPatch(input: unknown): Partial<DesktopRentalListingPatch> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalListingPatch> : {};
}

function normalizeStartInput(input: unknown): Partial<DesktopRentalStartInput> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalStartInput> : {};
}

function now(): string {
  return new Date().toISOString();
}

function buildReadiness(status: DesktopRentalProviderReadiness["status"] = "unknown"): DesktopRentalProviderReadiness {
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

function buildEmptyQuotaSnapshot(id: string | null = null): DesktopRentalQuotaSnapshot {
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

function buildStubListing(id: string, input: Partial<DesktopRentalListingInput & DesktopRentalListingPatch> = {}): DesktopRentalListing {
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

function buildEmptyProviderDashboard(): DesktopRentalProviderDashboard {
  return {
    listings: [],
    activeSessions: [],
    pendingRequests: [],
    readiness: buildReadiness("unknown"),
    quotaSnapshots: [],
    updatedAt: now(),
  };
}

function buildPreflightResult(listingId: string | null): DesktopRentalPreflightResult {
  return {
    listingId,
    provider: "unknown",
    readiness: buildReadiness("blocked"),
    quotaSnapshot: buildEmptyQuotaSnapshot(listingId),
    canPublish: false,
    ranAt: now(),
  };
}

function buildStubSession(
  id: string,
  input: Partial<DesktopRentalStartInput> = {},
  status: DesktopRentalSession["status"] = "requested"
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
    approvedScope: input.approvedScope ?? { includePaths: [], excludePaths: [], protectedPaths: [], notes: null },
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
    renterLaneExhaustedAt: null,
    renterLaneProvider: null,
    renterLaneModel: null,
    renterLaneRefreshEta: null,
    renterQuotaSignal: input.renterQuotaSignal ?? null,
    renterLaneRecoveredAt: null,
    startedAt: null,
    endedAt: status === "cancelled" ? now() : null,
    createdAt: null,
    updatedAt: now(),
  };
}

function buildStubRequest(id: string, status: DesktopRentalRequest["status"] = "pending"): DesktopRentalRequest {
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

function buildEmptyUsageSnapshot(sessionId: string): DesktopRentalUsageSnapshot {
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

function buildStubPatch(
  sessionId: string,
  id: string,
  gateStatus: DesktopRentalPatch["gateStatus"]
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

function buildStubContextApproval(
  sessionId: string,
  id: string,
  status: DesktopRentalContextApproval["status"]
): DesktopRentalContextApproval {
  return {
    id,
    sessionId,
    requestType: "read_file",
    status,
    path: null,
    reason: null,
    redactionCount: 0,
    requestedBy: null,
    decidedBy: null,
    createdAt: null,
    decidedAt: status === "pending" ? null : now(),
  };
}
