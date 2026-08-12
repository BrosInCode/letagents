import {
  mapApiRequest,
  mapApiRequestArray,
  mapApiSession,
  toApiCreateSessionBody,
} from "../api-mapper.js";
import { normalizeStartInput } from "./normalizers.js";
import type { DesktopRentalLaunchConfiguration } from "../../ipc-types/rental.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";
import {
  rentalApiFailure,
  rentalApiUnavailable,
  rentalInvalidResponse,
} from "./types.js";

export function registerSessionHandlers(
  register: RentalIpcRegistrar,
  { apiClient, launchCoordinator }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:create-session", async (_event, input) => {
    const normalized = normalizeStartInput(input);
    if (!apiClient) return rentalApiUnavailable("Rental request");
    const result = await apiClient.createSession(toApiCreateSessionBody(normalized));
    if (!result.ok) return rentalApiFailure("Rental request", result);
    return mapApiSession(result.body) ?? rentalInvalidResponse("Rental request");
  });

  register("desktop:rental:get-session", async (_event, id) => {
    const sessionId = String(id);
    if (!apiClient) return rentalApiUnavailable("Rental session");
    const result = await apiClient.getSession(sessionId);
    if (!result.ok) return rentalApiFailure("Rental session", result);
    return mapApiSession(result.body) ?? rentalInvalidResponse("Rental session");
  });

  register("desktop:rental:cancel-session", async (_event, id) => {
    const sessionId = String(id);
    if (!apiClient) return rentalApiUnavailable("Rental cancellation");
    const result = await apiClient.cancelSession(sessionId);
    if (!result.ok) return rentalApiFailure("Rental cancellation", result);
    await launchCoordinator?.teardown(sessionId);
    return mapApiSession(result.body) ?? rentalInvalidResponse("Rental cancellation");
  });

  register("desktop:rental:list-provider-requests", async () => {
    if (!apiClient) return rentalApiUnavailable("Provider rental requests");
    const result = await apiClient.listProviderRequests();
    if (!result.ok) return rentalApiFailure("Provider rental requests", result);
    return mapApiRequestArray(result.body);
  });

  register("desktop:rental:accept-request", async (_event, id, rawConfiguration) => {
    const sessionId = String(id);
    if (!launchCoordinator) return rentalApiUnavailable("Rental launch");
    const configuration = rawConfiguration && typeof rawConfiguration === "object"
      ? rawConfiguration as DesktopRentalLaunchConfiguration
      : null;
    if (!configuration?.providerId) throw new Error("Choose a local runtime before accepting this rental.");
    return launchCoordinator.acceptAndLaunch(sessionId, configuration);
  });

  register("desktop:rental:decline-request", async (_event, id, rawReason) => {
    const sessionId = String(id);
    if (!apiClient) return rentalApiUnavailable("Rental decline");
    const reason = typeof rawReason === "string" ? rawReason.trim() : null;
    const result = await apiClient.declineRequest(sessionId, reason ? { reason } : {});
    if (!result.ok) return rentalApiFailure("Rental decline", result);
    return mapApiRequest(result.body) ?? rentalInvalidResponse("Rental decline");
  });
}
