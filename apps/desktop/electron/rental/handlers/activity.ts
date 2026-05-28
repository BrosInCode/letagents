import type {
  DesktopRentalActivityEvent,
  DesktopRentalExposure,
  DesktopRentalPatch,
} from "../../ipc-types.js";
import {
  mapApiActivityEventArray,
  mapApiPatch,
  mapApiPatchArray,
  mapApiUsageSnapshot,
} from "../api-mapper.js";
import {
  buildEmptyUsageSnapshot,
  buildStubContextApproval,
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

  register("desktop:rental:get-exposures", () =>
    [] satisfies DesktopRentalExposure[],
  );

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

  register("desktop:rental:approve-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "approved"),
  );

  register("desktop:rental:deny-context-request", (_event, sessionId, approvalId) =>
    buildStubContextApproval(String(sessionId), String(approvalId), "denied"),
  );
}
