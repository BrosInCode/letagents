import type { IpcMain } from "electron";

import type {
  DesktopRentalActivityEvent,
  DesktopRentalContextApproval,
  DesktopRentalExposure,
  DesktopRentalIdeKind,
  DesktopRentalListing,
  DesktopRentalListingInput,
  DesktopRentalListingPatch,
  DesktopRentalManualDeclareInput,
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
import { RenterTriggerRuntime } from "./rental/renter-trigger.js";
import type { RentalApiClient } from "./rental/api-client.js";
import {
  mapApiActivityEventArray,
  mapApiListing,
  mapApiListingArray,
  mapApiRequest,
  mapApiRequestArray,
  mapApiSession,
  toApiCreateSessionBody,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "./rental/api-mapper.js";

export type DisabledRentalResult = {
  enabled: false;
};

type RentalIpcMain = Pick<IpcMain, "handle">;
type RentalIpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

export interface DesktopRentalHandlerOptions {
  enabled?: boolean;
  renterTriggerRuntime?: RenterTriggerRuntime;
  /**
   * Optional live API client. When provided, the IPC channels for
   * listings discovery, provider requests, and session lifecycle
   * call the server and surface the mapped DesktopRental* shape.
   * When omitted (e.g. offline desktop, missing auth) the channels
   * fall back to the stub responses so the UI stays renderable.
   *
   * Wiring lands here in p1.8c on top of the p1.8a client (#392)
   * and p1.8b mapper (#393).
   */
  apiClient?: RentalApiClient | null;
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
  const renterTriggerRuntime = options.renterTriggerRuntime ?? new RenterTriggerRuntime();
  const apiClient = options.apiClient ?? null;
  const register = (channel: string, handler: RentalIpcHandler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!enabled) return disabledRentalResult;
      return handler(event, ...args);
    });
  };

  register("desktop:rental:list-listings", async () => {
    if (apiClient) {
      const result = await apiClient.publicListings();
      if (result.ok) return mapApiListingArray(result.body);
    }
    return [];
  });
  register("desktop:rental:get-provider-dashboard", async () => {
    if (!apiClient) return buildEmptyProviderDashboard();
    // Compose the dashboard from two live API calls. We don't fail
    // the whole dashboard if one side errors — the renderer can
    // still show partial state. listings + pendingRequests is the
    // minimum useful payload; activeSessions / quotaSnapshots /
    // readiness fall through to the empty-dashboard shape until
    // they get their own endpoints in a polish slice.
    const [listingsResult, requestsResult] = await Promise.all([
      apiClient.listProviderListings(),
      apiClient.listProviderRequests(),
    ]);
    const empty = buildEmptyProviderDashboard();
    return {
      ...empty,
      listings: listingsResult.ok ? mapApiListingArray(listingsResult.body) : empty.listings,
      pendingRequests: requestsResult.ok ? mapApiRequestArray(requestsResult.body) : empty.pendingRequests,
      updatedAt: now(),
    };
  });
  register("desktop:rental:create-listing", async (_event, input) => {
    const normalized = normalizeListingInput(input);
    if (apiClient) {
      const result = await apiClient.createListing(toApiListingCreateBody(normalized));
      if (result.ok) {
        const mapped = mapApiListing(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubListing("listing_stub", normalized);
  });
  register("desktop:rental:update-listing", async (_event, id, input) => {
    const listingId = String(id);
    const normalized = normalizeListingPatch(input);
    if (apiClient) {
      const result = await apiClient.updateListing(listingId, toApiListingPatchBody(normalized));
      if (result.ok) {
        const mapped = mapApiListing(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubListing(listingId, normalized);
  });
  register("desktop:rental:pause-listing", async (_event, id) => {
    const listingId = String(id);
    if (apiClient) {
      const result = await apiClient.pauseListing(listingId);
      if (result.ok) {
        const mapped = mapApiListing(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubListing(listingId, { status: "paused" });
  });
  register("desktop:rental:resume-listing", async (_event, id) => {
    const listingId = String(id);
    if (apiClient) {
      const result = await apiClient.resumeListing(listingId);
      if (result.ok) {
        const mapped = mapApiListing(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubListing(listingId, { status: "active" });
  });
  register("desktop:rental:refresh-quota", (_event, id) => buildEmptyQuotaSnapshot(String(id)));
  register("desktop:rental:run-preflight", (_event, id) => buildPreflightResult(typeof id === "string" ? id : null));
  register("desktop:rental:create-session", async (_event, input) => {
    const normalized = normalizeStartInput(input);
    if (apiClient) {
      const result = await apiClient.createSession(toApiCreateSessionBody(normalized));
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession("session_stub", normalized);
  });
  register("desktop:rental:get-session", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.getSession(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId);
  });
  register("desktop:rental:cancel-session", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.cancelSession(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId, undefined, "cancelled");
  });
  register("desktop:rental:list-provider-requests", async () => {
    if (apiClient) {
      const result = await apiClient.listProviderRequests();
      if (result.ok) return mapApiRequestArray(result.body);
    }
    return [];
  });
  register("desktop:rental:accept-request", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.acceptRequest(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId, undefined, "accepted");
  });
  register("desktop:rental:decline-request", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.declineRequest(sessionId);
      if (result.ok) {
        const mapped = mapApiRequest(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubRequest(sessionId, "declined");
  });
  register("desktop:rental:get-activity", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return [] satisfies DesktopRentalActivityEvent[];
    if (apiClient) {
      const result = await apiClient.getSessionActivity(id);
      if (result.ok) return mapApiActivityEventArray(result.body);
    }
    return [] satisfies DesktopRentalActivityEvent[];
  });
  register("desktop:rental:get-exposures", () => [] satisfies DesktopRentalExposure[]);
  register("desktop:rental:get-patches", () => [] satisfies DesktopRentalPatch[]);
  register("desktop:rental:get-usage", (_event, sessionId) => buildEmptyUsageSnapshot(String(sessionId)));
  register("desktop:rental:get-own-quota-status", () => renterTriggerRuntime.getOwnQuotaStatus());
  register("desktop:rental:declare-quota-exhausted", (_event, input) =>
    renterTriggerRuntime.declareManual(normalizeManualDeclareInput(input))
  );
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

function normalizeManualDeclareInput(input: unknown): DesktopRentalManualDeclareInput {
  return input && typeof input === "object" ? input as DesktopRentalManualDeclareInput : {};
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
