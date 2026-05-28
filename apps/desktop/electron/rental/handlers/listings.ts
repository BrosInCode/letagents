import {
  mapApiListing,
  mapApiListingArray,
  mapApiProviderReadiness,
  mapApiRequestArray,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "../api-mapper.js";
import {
  normalizeListingInput,
  normalizeListingPatch,
} from "./normalizers.js";
import {
  buildEmptyProviderDashboard,
  buildEmptyQuotaSnapshot,
  buildPreflightResult,
  buildStubListing,
  now,
} from "./stubs.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";

export function registerListingHandlers(
  register: RentalIpcRegistrar,
  { apiClient }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:list-listings", async () => {
    if (apiClient) {
      const result = await apiClient.publicListings();
      if (result.ok) return mapApiListingArray(result.body);
    }
    return [];
  });

  register("desktop:rental:get-provider-dashboard", async () => {
    if (!apiClient) return buildEmptyProviderDashboard();
    const [listingsResult, requestsResult, readinessResult] = await Promise.all([
      apiClient.listProviderListings(),
      apiClient.listProviderRequests(),
      apiClient.getProviderReadiness(),
    ]);
    const empty = buildEmptyProviderDashboard();
    return {
      ...empty,
      listings: listingsResult.ok
        ? mapApiListingArray(listingsResult.body)
        : empty.listings,
      pendingRequests: requestsResult.ok
        ? mapApiRequestArray(requestsResult.body)
        : empty.pendingRequests,
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
      const result = await apiClient.updateListing(
        listingId,
        toApiListingPatchBody(normalized),
      );
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

  register("desktop:rental:refresh-quota", (_event, id) =>
    buildEmptyQuotaSnapshot(String(id)),
  );

  register("desktop:rental:run-preflight", (_event, id) =>
    buildPreflightResult(typeof id === "string" ? id : null),
  );
}
