import type {
  DesktopRentalMarketplace,
  DesktopRentalMarketplaceProvider,
  DesktopRentalProviderSettingsInput,
} from "../../ipc-types/rental.js";
import { mapApiListingArray } from "../api-mapper.js";
import {
  rentalApiFailure,
  rentalApiUnavailable,
  type RentalIpcRegistrar,
  type RentalIpcRegistrationContext,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mapMarketplaceProviders(value: unknown): DesktopRentalMarketplaceProvider[] {
  const root = record(value);
  const rows = Array.isArray(root.providers) ? root.providers : Array.isArray(value) ? value : [];
  return rows.flatMap((row) => {
    const item = record(row);
    // Public provider discovery deliberately uses a stable public alias, not
    // an internal account/host/installation id.
    const accountId = text(item.providerKey ?? item.provider_key ?? item.accountId ?? item.account_id);
    const displayName = text(item.displayName ?? item.display_name ?? item.providerDisplayName ?? item.provider_display_name);
    if (!accountId || !displayName) return [];
    const rawAvailability = item.available === true ? "available" : text(item.availability);
    const availability: DesktopRentalMarketplaceProvider["availability"] = ["available", "busy", "offline", "setup_required"].includes(rawAvailability ?? "")
      ? rawAvailability as DesktopRentalMarketplaceProvider["availability"]
      : "offline";
    return [{
      accountId,
      displayName,
      login: text(item.login),
      avatarUrl: text(item.avatarUrl ?? item.avatar_url),
      availability,
      availableSlots: Number.isSafeInteger(item.availableSlots ?? item.available_slots) ? Math.max(0, Number(item.availableSlots ?? item.available_slots)) : 0,
      // Repository rentals remain hidden until the server returns a real
      // scoped workspace capability; local provider paths are never inferred.
      supportsRepository: item.supportsRepository === true || item.supports_repository === true,
      maxDurationMinutes: Number.isFinite(item.maxDurationMinutes ?? item.max_duration_minutes) ? Number(item.maxDurationMinutes ?? item.max_duration_minutes) : null,
      offers: mapApiListingArray(item.offers ?? item.listings ?? []),
    }];
  });
}

export function registerMarketplaceHandlers(
  register: RentalIpcRegistrar,
  { apiClient, providerHostManager }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:get-marketplace", async (): Promise<DesktopRentalMarketplace> => {
    if (!apiClient) return rentalApiUnavailable("Rental marketplace");
    const result = await apiClient.marketplace();
    if (!result.ok) return rentalApiFailure("Rental marketplace", result);
    return {
      providers: mapMarketplaceProviders(result.body),
      updatedAt: text(record(result.body).updatedAt ?? record(result.body).updated_at),
    };
  });

  register("desktop:rental:get-provider-settings", async () => {
    if (!providerHostManager) return rentalApiUnavailable("Rental provider settings");
    return providerHostManager.getSettings();
  });

  register("desktop:rental:update-provider-settings", async (_event, rawInput) => {
    if (!providerHostManager) return rentalApiUnavailable("Rental provider settings");
    const input = record(rawInput) as DesktopRentalProviderSettingsInput;
    return providerHostManager.updateSettings(input);
  });
}
