import { getOrCreateDesktopHostId } from "../../main/agents/state.js";
import { rentalProviderInstallationId } from "../provider-host-manager.js";
import {
  mapApiListing,
  mapApiListingArray,
  mapApiProviderReadiness,
  mapApiRequestArray,
  mapApiSessionArray,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "../api-mapper.js";
import {
  normalizeListingInput,
  normalizeListingPatch,
} from "./normalizers.js";
import { now } from "./stubs.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";
import { rentalApiFailure, rentalApiUnavailable, rentalInvalidResponse } from "./types.js";

export function registerListingHandlers(
  register: RentalIpcRegistrar,
  { apiClient }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:list-listings", async () => {
    if (!apiClient) return rentalApiUnavailable("Rental listings");
    const result = await apiClient.publicListings();
    if (!result.ok) return rentalApiFailure("Rental listings", result);
    return mapApiListingArray(result.body);
  });

  register("desktop:rental:get-provider-dashboard", async () => {
    if (!apiClient) return rentalApiUnavailable("Rental provider dashboard");
    const hostId = getOrCreateDesktopHostId();
    const [listingsResult, sessionsResult, requestsResult, readinessResult] = await Promise.all([
      apiClient.listProviderListings(),
      apiClient.listProviderSessions(hostId, rentalProviderInstallationId(hostId)),
      apiClient.listProviderRequests(),
      apiClient.getProviderReadiness(),
    ]);
    const failure = [listingsResult, sessionsResult, requestsResult, readinessResult].find((result) => !result.ok);
    if (failure && !failure.ok) return rentalApiFailure("Rental provider dashboard", failure);
    return {
      listings: mapApiListingArray(listingsResult.body),
      capacitySessions: mapApiSessionArray(sessionsResult.body),
      pendingRequests: mapApiRequestArray(requestsResult.body),
      readiness: mapApiProviderReadiness(readinessResult.body),
      quotaSnapshots: [],
      updatedAt: now(),
    };
  });

  register("desktop:rental:create-listing", async (_event, input) => {
    const normalized = normalizeListingInput(input);
    if (!apiClient) return rentalApiUnavailable("Rental listing creation");
    const result = await apiClient.createListing(toApiListingCreateBody(normalized));
    if (!result.ok) return rentalApiFailure("Rental listing creation", result);
    return mapApiListing(result.body) ?? rentalInvalidResponse("Rental listing creation");
  });

  register("desktop:rental:update-listing", async (_event, id, input) => {
    const listingId = String(id);
    const normalized = normalizeListingPatch(input);
    if (!apiClient) return rentalApiUnavailable("Rental listing update");
    const result = await apiClient.updateListing(listingId, toApiListingPatchBody(normalized));
    if (!result.ok) return rentalApiFailure("Rental listing update", result);
    return mapApiListing(result.body) ?? rentalInvalidResponse("Rental listing update");
  });

  register("desktop:rental:pause-listing", async (_event, id) => {
    const listingId = String(id);
    if (!apiClient) return rentalApiUnavailable("Rental listing pause");
    const result = await apiClient.pauseListing(listingId);
    if (!result.ok) return rentalApiFailure("Rental listing pause", result);
    return mapApiListing(result.body) ?? rentalInvalidResponse("Rental listing pause");
  });

  register("desktop:rental:resume-listing", async (_event, id) => {
    const listingId = String(id);
    if (!apiClient) return rentalApiUnavailable("Rental listing resume");
    const result = await apiClient.resumeListing(listingId);
    if (!result.ok) return rentalApiFailure("Rental listing resume", result);
    return mapApiListing(result.body) ?? rentalInvalidResponse("Rental listing resume");
  });

  register("desktop:rental:refresh-quota", () => rentalApiUnavailable("Rental quota refresh"));

  register("desktop:rental:run-preflight", async (_event, id) => {
    const listingId = typeof id === "string" ? id : null;
    if (!apiClient) return rentalApiUnavailable("Rental provider preflight");
    const result = await apiClient.getProviderReadiness();
    if (!result.ok) return rentalApiFailure("Rental provider preflight", result);
    const readiness = mapApiProviderReadiness(result.body);
    return {
      listingId,
      provider: "unknown",
      readiness,
      quotaSnapshot: null,
      canPublish: readiness.status === "ready" || readiness.status === "degraded",
      ranAt: now(),
    };
  });
}
