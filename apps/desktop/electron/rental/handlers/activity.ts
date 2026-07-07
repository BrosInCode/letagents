import type {
  DesktopRentalActivityEvent,
  DesktopRentalContextApproval,
  DesktopRentalExposure,
  DesktopRentalPatch,
} from "../../ipc-types.js";
import {
  mapApiActivityEventArray,
  mapApiContextApproval,
  mapApiContextApprovalArray,
  mapApiExposureArray,
  mapApiPatch,
  mapApiPatchArray,
  mapApiUsageSnapshot,
} from "../api-mapper.js";
import {
  buildEmptyUsageSnapshot,
  buildStubPatch,
} from "./stubs.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";

export function registerActivityHandlers(
  register: RentalIpcRegistrar,
  { apiClient }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:get-activity", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return [] satisfies DesktopRentalActivityEvent[];
    if (apiClient) {
      const result = await apiClient.getSessionActivity(id);
      if (result.ok) return mapApiActivityEventArray(result.body);
    }
    return [] satisfies DesktopRentalActivityEvent[];
  });

  register("desktop:rental:get-exposures", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return [] satisfies DesktopRentalExposure[];
    if (apiClient) {
      const result = await apiClient.getExposures(id);
      if (result.ok) return mapApiExposureArray(result.body);
    }
    return [] satisfies DesktopRentalExposure[];
  });

  register("desktop:rental:get-context-requests", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id) return [] satisfies DesktopRentalContextApproval[];
    if (apiClient) {
      const result = await apiClient.getContextRequests(id);
      if (result.ok) return mapApiContextApprovalArray(result.body);
    }
    return [] satisfies DesktopRentalContextApproval[];
  });

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

  register("desktop:rental:request-patch-changes", async (
    _event,
    sessionId,
    patchId,
    note,
  ) => {
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

  // Context request decisions must never pretend to succeed — a failed
  // API call throws so the renderer surfaces the error instead of
  // rendering a fabricated decision.
  register("desktop:rental:approve-context-request", (
    _event,
    sessionId,
    approvalId,
  ) => decideContextRequest(apiClient, sessionId, approvalId, "approve"));

  register("desktop:rental:deny-context-request", (
    _event,
    sessionId,
    approvalId,
  ) => decideContextRequest(apiClient, sessionId, approvalId, "deny"));
}

async function decideContextRequest(
  apiClient: RentalIpcRegistrationContext["apiClient"],
  sessionId: unknown,
  approvalId: unknown,
  decision: "approve" | "deny",
): Promise<DesktopRentalContextApproval> {
  const id = String(sessionId ?? "");
  const requestId = String(approvalId ?? "");
  if (!apiClient || !id || !requestId) {
    throw new Error(`Could not ${decision} the access request: rental API unavailable.`);
  }
  const result =
    decision === "approve"
      ? await apiClient.approveContextRequest(id, requestId)
      : await apiClient.denyContextRequest(id, requestId);
  if (!result.ok) {
    throw new Error(
      `Could not ${decision} the access request: ${result.error}`,
    );
  }
  const mapped = mapApiContextApproval(result.body);
  if (!mapped) {
    throw new Error(`Could not ${decision} the access request: bad API response.`);
  }
  return mapped;
}
