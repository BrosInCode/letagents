import type { RentalHostRuntime } from "../db/schema.js";

export const RENTAL_SAFE_RUNTIME_KIND = "cursor";
export const RENTAL_SAFE_PERMISSION_PROFILE_ID = "sandboxed_write";

export interface RentalRuntimeSelectionLike {
  kind: string;
  permissionProfileId?: string | null;
}

/**
 * Direct rentals execute internet-authored instructions on a provider host.
 * The API therefore owns the admission rule instead of trusting a host's
 * advertised capabilities or a desktop client to enforce it.
 */
export function isRentalRuntimeSelectionSafe(
  runtime: RentalRuntimeSelectionLike | null | undefined,
): boolean {
  return runtime?.kind.trim().toLowerCase() === RENTAL_SAFE_RUNTIME_KIND
    && runtime.permissionProfileId?.trim() === RENTAL_SAFE_PERMISSION_PROFILE_ID;
}

export function assertRentalRuntimeSelectionSafe<T extends RentalRuntimeSelectionLike>(
  runtime: T,
): T & { kind: typeof RENTAL_SAFE_RUNTIME_KIND; permissionProfileId: typeof RENTAL_SAFE_PERMISSION_PROFILE_ID } {
  if (!isRentalRuntimeSelectionSafe(runtime)) {
    throw new Error("unsafe_rental_runtime_profile");
  }
  return {
    ...runtime,
    kind: RENTAL_SAFE_RUNTIME_KIND,
    permissionProfileId: RENTAL_SAFE_PERMISSION_PROFILE_ID,
  };
}

/** Host advertisements are capability hints, not authority. Keep only the
 * exact runtime/profile pair whose workspace containment is independently
 * enforced by the provider adapter and daemon. */
export function assertRentalHostRuntimeSafe(runtime: RentalHostRuntime): RentalHostRuntime {
  const profiles = runtime.permissionProfiles ?? [];
  if (
    runtime.kind.trim().toLowerCase() !== RENTAL_SAFE_RUNTIME_KIND
    || profiles.length !== 1
    || profiles[0]?.trim() !== RENTAL_SAFE_PERMISSION_PROFILE_ID
  ) {
    throw new Error("unsafe_rental_runtime_profile");
  }
  return {
    ...runtime,
    kind: RENTAL_SAFE_RUNTIME_KIND,
    permissionProfiles: [RENTAL_SAFE_PERMISSION_PROFILE_ID],
  };
}
