import type {
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";
import { listManagedAgentPermissionProfiles } from "./managed-agent-permission-profiles.js";

/**
 * Renting crosses from an internet user's instructions into the provider's
 * local OS account. Only profiles with a verified workspace-rooted execution
 * boundary belong here; a private cwd or read-only tool policy is not enough.
 */
const RENTAL_SAFE_PROFILE_IDS: Partial<
  Record<DesktopAgentProviderId, readonly DesktopManagedAgentPermissionProfileId[]>
> = {
  cursor: ["sandboxed_write"],
};

export function listRentalSafePermissionProfiles(
  providerId: DesktopAgentProviderId,
): DesktopManagedAgentPermissionProfile[] {
  const allowed = new Set(RENTAL_SAFE_PROFILE_IDS[providerId] ?? []);
  return listManagedAgentPermissionProfiles(providerId)
    .filter((profile) => profile.status === "available" && allowed.has(profile.id));
}

export function isRentalSafePermissionProfile(
  providerId: string,
  permissionProfileId: string | null | undefined,
): boolean {
  if (!["codex", "claude-code", "cursor", "open-model"].includes(providerId)) return false;
  const normalized = String(permissionProfileId ?? "").trim();
  return listRentalSafePermissionProfiles(providerId as DesktopAgentProviderId)
    .some((profile) => profile.id === normalized);
}

export function assertRentalSafePermissionProfile(
  providerId: DesktopAgentProviderId,
  requestedProfileId: string | null | undefined,
): DesktopManagedAgentPermissionProfile {
  const profiles = listRentalSafePermissionProfiles(providerId);
  if (!profiles.length) {
    throw new Error(providerId + " does not yet expose a verified workspace-rooted rental profile.");
  }
  const requested = String(requestedProfileId ?? "").trim();
  const selected = profiles.find((profile) => profile.id === requested);
  if (!selected) {
    throw new Error("Choose an explicit rental-safe permission profile for " + providerId + ".");
  }
  return selected;
}
