import type {
  DesktopRentalContextApproval,
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
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";
import { rentalApiFailure, rentalApiUnavailable, rentalInvalidResponse } from "./types.js";

export function registerActivityHandlers(
  register: RentalIpcRegistrar,
  { apiClient }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:get-activity", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id || !apiClient) return rentalApiUnavailable("Rental activity");
    const result = await apiClient.getSessionActivity(id);
    if (!result.ok) return rentalApiFailure("Rental activity", result);
    return mapApiActivityEventArray(result.body);
  });

  register("desktop:rental:get-exposures", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id || !apiClient) return rentalApiUnavailable("Rental exposures");
    const result = await apiClient.getExposures(id);
    if (!result.ok) return rentalApiFailure("Rental exposures", result);
    return mapApiExposureArray(result.body);
  });

  register("desktop:rental:get-context-requests", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id || !apiClient) return rentalApiUnavailable("Rental access requests");
    const result = await apiClient.getContextRequests(id);
    if (!result.ok) return rentalApiFailure("Rental access requests", result);
    return mapApiContextApprovalArray(result.body);
  });

  register("desktop:rental:get-patches", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id || !apiClient) return rentalApiUnavailable("Rental patches");
    const result = await apiClient.getPatches(id);
    if (!result.ok) return rentalApiFailure("Rental patches", result);
    return mapApiPatchArray(result.body);
  });

  register("desktop:rental:get-usage", async (_event, sessionId) => {
    const id = String(sessionId ?? "");
    if (!id || !apiClient) return rentalApiUnavailable("Rental usage");
    const result = await apiClient.getSessionUsage(id);
    if (!result.ok) return rentalApiFailure("Rental usage", result);
    return mapApiUsageSnapshot(result.body, id);
  });

  register("desktop:rental:approve-patch", async (_event, sessionId, patchId) => {
    const id = String(sessionId ?? "");
    const patch = String(patchId ?? "");
    if (!apiClient || !id || !patch) return rentalApiUnavailable("Patch approval");
    const result = await apiClient.approvePatch(id, patch);
    if (!result.ok) return rentalApiFailure("Patch approval", result);
    return mapApiPatch(result.body) ?? rentalInvalidResponse("Patch approval");
  });

  register("desktop:rental:request-patch-changes", async (
    _event,
    sessionId,
    patchId,
    note,
  ) => {
    const id = String(sessionId ?? "");
    const patch = String(patchId ?? "");
    if (!apiClient || !id || !patch) return rentalApiUnavailable("Patch change request");
    const result = await apiClient.requestPatchChanges(id, patch, {
      note: typeof note === "string" ? note : "",
    });
    if (!result.ok) return rentalApiFailure("Patch change request", result);
    return mapApiPatch(result.body) ?? rentalInvalidResponse("Patch change request");
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
