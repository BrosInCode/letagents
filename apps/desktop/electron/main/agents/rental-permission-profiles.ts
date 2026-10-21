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

/**
 * An agent given to someone else's room (Ask for an agent) does its code work
 * through LetAgents' tools, so it may also run with no local tools at all.
 * These pairs are for given agents only; the rental marketplace keeps its list.
 */
const GUEST_SAFE_PROFILE_IDS: Partial<
  Record<DesktopAgentProviderId, readonly DesktopManagedAgentPermissionProfileId[]>
> = {
  cursor: ["sandboxed_write"],
  // Read-only with no built-in tools at all: the spawn attestation requires
  // the empty tool list and the adapter refuses to start unless Claude itself
  // reports no tool outside LetAgents'.
  "claude-code": ["read_only"],
  // Read-only with its shell, image, web and app tools switched off
  // (codex-guest-lock.ts); the launch probes this exact Codex's tool list.
  codex: ["read_only"],
};

/** Entries for agents given through Ask for an agent (see asks/give-coordinator.ts). */
export function isGivenAgentEntryId(entryId: string | null | undefined): boolean {
  return Boolean(entryId?.startsWith("supervised_rental_ask_"));
}

function profilesFrom(
  table: typeof RENTAL_SAFE_PROFILE_IDS,
  providerId: DesktopAgentProviderId,
): DesktopManagedAgentPermissionProfile[] {
  const allowed = new Set(table[providerId] ?? []);
  return listManagedAgentPermissionProfiles(providerId)
    // Codex Read-only is listed as gated here only because it needs daemon
    // delivery, and a given agent is always daemon-delivered.
    .filter((profile) => (profile.status === "available"
      || (table === GUEST_SAFE_PROFILE_IDS && providerId === "codex" && profile.id === "read_only"))
      && allowed.has(profile.id));
}

export function listRentalSafePermissionProfiles(
  providerId: DesktopAgentProviderId,
): DesktopManagedAgentPermissionProfile[] {
  return profilesFrom(RENTAL_SAFE_PROFILE_IDS, providerId);
}

export function listGuestSafePermissionProfiles(
  providerId: DesktopAgentProviderId,
): DesktopManagedAgentPermissionProfile[] {
  return profilesFrom(GUEST_SAFE_PROFILE_IDS, providerId);
}

/** The guest-safe check a given agent's install must pass. */
export function assertGuestSafePermissionProfile(
  providerId: DesktopAgentProviderId,
  requestedProfileId: string | null | undefined,
): DesktopManagedAgentPermissionProfile {
  const requested = String(requestedProfileId ?? "").trim();
  const selected = listGuestSafePermissionProfiles(providerId).find((profile) => profile.id === requested);
  if (!selected) throw new Error(`${providerId} can't be given with the '${requested || "default"}' access level.`);
  return selected;
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
