import type {
  DesktopRentalActivityEvent,
  DesktopRentalExposure,
  DesktopRentalPatch,
} from "../../ipc-types.js";
import { RenterTriggerRuntime } from "../renter-trigger.js";
import {
  mapApiActivityEventArray,
  mapApiListing,
  mapApiListingArray,
  mapApiPatch,
  mapApiPatchArray,
  mapApiProviderReadiness,
  mapApiRequest,
  mapApiRequestArray,
  mapApiSession,
  mapApiUsageSnapshot,
  toApiCreateSessionBody,
  toApiDeclareQuotaBody,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "../api-mapper.js";
import {
  normalizeListingInput,
  normalizeListingPatch,
  normalizeManualDeclareInput,
  normalizeStartInput,
} from "./normalizers.js";
import {
  buildEmptyProviderDashboard,
  buildEmptyQuotaSnapshot,
  buildEmptyUsageSnapshot,
  buildPreflightResult,
  buildStubContextApproval,
  buildStubListing,
  buildStubPatch,
  buildStubRequest,
  buildStubSession,
  now,
} from "./stubs.js";
import type {
  DesktopRentalHandlerOptions,
  DisabledRentalResult,
  RentalIpcHandler,
  RentalIpcMain,
} from "./types.js";

export type { DesktopRentalHandlerOptions, DisabledRentalResult } from "./types.js";

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
    // Compose the dashboard from three live API calls. We don't fail
    // the whole dashboard if one side errors — the renderer can
    // still show partial state. listings + pendingRequests is the
    // minimum useful payload; activeSessions / quotaSnapshots
    // still fall through to the empty-dashboard shape until they
    // get their own endpoints. p2.15 wires the third pane —
    // `/api/rental/provider/readiness` — into the existing rollup.
    const [listingsResult, requestsResult, readinessResult] = await Promise.all([
      apiClient.listProviderListings(),
      apiClient.listProviderRequests(),
      apiClient.getProviderReadiness(),
    ]);
    const empty = buildEmptyProviderDashboard();
    return {
      ...empty,
      listings: listingsResult.ok ? mapApiListingArray(listingsResult.body) : empty.listings,
      pendingRequests: requestsResult.ok ? mapApiRequestArray(requestsResult.body) : empty.pendingRequests,
      readiness: readinessResult.ok
        ? mapApiProviderReadiness(readinessResult.body)
        : empty.readiness,
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
  register("desktop:rental:get-patches", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return [] satisfies DesktopRentalPatch[];
    if (apiClient) {
      const result = await apiClient.getPatches(id);
      if (result.ok) return mapApiPatchArray(result.body);
    }
    return [] satisfies DesktopRentalPatch[];
  });
  register("desktop:rental:get-usage", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return buildEmptyUsageSnapshot(id);
    if (apiClient) {
      const result = await apiClient.getSessionUsage(id);
      if (result.ok) return mapApiUsageSnapshot(result.body, id);
    }
    return buildEmptyUsageSnapshot(id);
  });
  register("desktop:rental:get-own-quota-status", () => renterTriggerRuntime.getOwnQuotaStatus());
  register("desktop:rental:declare-quota-exhausted", (_event, input) => {
    const signal = renterTriggerRuntime.declareManual(normalizeManualDeclareInput(input));
    if (apiClient) {
      const body = toApiDeclareQuotaBody(signal);
      if (body) {
        void apiClient.declareQuotaExhausted(body).catch(() => {});
      }
    }
    return signal;
  });
  register("desktop:rental:approve-patch", async (_event, sessionId, patchId) => {
    const id = String(sessionId ?? "");
    const patch = String(patchId ?? "");
    if (apiClient && id && patch) {
      const result = await apiClient.approvePatch(id, patch);
      if (result.ok) {
        const mapped = mapApiPatch(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubPatch(id, patch, "passed");
  });
  register("desktop:rental:request-patch-changes", async (_event, sessionId, patchId, note) => {
    const id = String(sessionId ?? "");
    const patch = String(patchId ?? "");
    if (apiClient && id && patch) {
      const result = await apiClient.requestPatchChanges(id, patch, {
        note: typeof note === "string" ? note : "",
      });
      if (result.ok) {
        const mapped = mapApiPatch(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubPatch(id, patch, "needs_revision");
  });
  register("desktop:rental:approve-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "approved")
  );
  register("desktop:rental:deny-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "denied")
  );
}
