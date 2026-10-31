import type {
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
} from "../../../../../../electron/ipc-types";

/**
 * Access levels from least to most permission. A provider's own levels are
 * shown in this order; "Sandboxed writes" (Cursor's workspace copy) sits
 * between asking before writes and Auto.
 */
const ACCESS_ORDER: readonly DesktopManagedAgentPermissionProfileId[] = [
  "read_only",
  "ask_before_write",
  "sandboxed_write",
  "auto_review",
  "full_access",
];

export interface PersonalAccessLevel {
  id: DesktopManagedAgentPermissionProfileId;
  label: string;
  /** Raising the default to this level asks first. */
  high: boolean;
  /** What the confirmation says the level allows. */
  detail: string;
}

/**
 * The levels a person can choose as the default for agents they start in a
 * room. Labels match daemon/supervised-permission-profiles.ts.
 */
export const PERSONAL_ACCESS_LEVELS: readonly PersonalAccessLevel[] = [
  { id: "read_only", label: "Read-only", high: false,
    detail: "Can read and search files. Cannot change files or run commands." },
  { id: "ask_before_write", label: "Ask before writes", high: false,
    detail: "Asks you before it changes files or runs write-capable commands." },
  { id: "auto_review", label: "Auto", high: true,
    detail: "The agent checks each action itself and runs the ones it judges safe without asking. Anything a room message asks for counts as approved." },
  { id: "full_access", label: "Full access", high: true,
    detail: "Changes files and runs commands without asking. Commands can access files outside your project." },
];

export const DEFAULT_PERSONAL_ACCESS: DesktopManagedAgentPermissionProfileId = "ask_before_write";

export function personalAccessLevel(id: DesktopManagedAgentPermissionProfileId | null | undefined): PersonalAccessLevel {
  return PERSONAL_ACCESS_LEVELS.find((level) => level.id === id)
    ?? PERSONAL_ACCESS_LEVELS.find((level) => level.id === DEFAULT_PERSONAL_ACCESS)!;
}

function accessRank(id: DesktopManagedAgentPermissionProfileId): number {
  const index = ACCESS_ORDER.indexOf(id);
  return index < 0 ? ACCESS_ORDER.length : index;
}

/** Raising the default from `from` to `to` needs a confirmation. */
export function accessChangeNeedsConfirmation(
  from: DesktopManagedAgentPermissionProfileId,
  to: DesktopManagedAgentPermissionProfileId,
): boolean {
  return personalAccessLevel(to).high && accessRank(to) > accessRank(from);
}

/** The levels a provider really offers, from least to most permission. */
export function accessStops(
  profiles: readonly DesktopManagedAgentPermissionProfile[],
): DesktopManagedAgentPermissionProfile[] {
  return profiles
    .filter((profile) => profile.status === "available")
    .sort((a, b) => accessRank(a.id) - accessRank(b.id));
}

/**
 * The level an agent starts with when its person wants `wanted`. A provider
 * without that level falls back to the next safer level it has; only when it
 * has nothing safer does it take the next level up.
 */
export function resolveAccess(
  profiles: readonly DesktopManagedAgentPermissionProfile[],
  wanted: DesktopManagedAgentPermissionProfileId,
): { id: DesktopManagedAgentPermissionProfileId; fellBack: boolean } | null {
  const stops = accessStops(profiles);
  if (!stops.length) return null;
  if (stops.some((profile) => profile.id === wanted)) return { id: wanted, fellBack: false };
  const rank = accessRank(wanted);
  const safer = stops.filter((profile) => accessRank(profile.id) < rank).at(-1);
  return { id: (safer ?? stops[0]).id, fellBack: true };
}

/*
 * The personal default is stored on this Mac, per signed-in person and room.
 * It is never sent to the room and never changes anyone else's agents.
 */
const personalAccessStorageKey = "letagents-desktop:composer-agent-access";

function personalAccessKey(viewerLogin: string | null | undefined, roomIdentifier: string | null | undefined): string | null {
  const room = roomIdentifier?.trim().toLowerCase();
  if (!room) return null;
  return `${viewerLogin?.trim().toLowerCase() || "local"}\u0000${room}`;
}

function readPersonalAccessMap(): Record<string, unknown> {
  const parsed = JSON.parse(window.localStorage.getItem(personalAccessStorageKey) || "{}") as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function readPersonalAccess(
  viewerLogin: string | null | undefined,
  roomIdentifier: string | null | undefined,
): DesktopManagedAgentPermissionProfileId {
  const key = personalAccessKey(viewerLogin, roomIdentifier);
  if (!key) return DEFAULT_PERSONAL_ACCESS;
  try {
    const stored = readPersonalAccessMap()[key];
    return PERSONAL_ACCESS_LEVELS.some((level) => level.id === stored)
      ? stored as DesktopManagedAgentPermissionProfileId
      : DEFAULT_PERSONAL_ACCESS;
  } catch {
    return DEFAULT_PERSONAL_ACCESS;
  }
}

export function rememberPersonalAccess(
  viewerLogin: string | null | undefined,
  roomIdentifier: string | null | undefined,
  id: DesktopManagedAgentPermissionProfileId,
): void {
  const key = personalAccessKey(viewerLogin, roomIdentifier);
  if (!key) return;
  try {
    const preferences = readPersonalAccessMap();
    preferences[key] = id;
    window.localStorage.setItem(personalAccessStorageKey, JSON.stringify(preferences));
  } catch {
    // Local preference persistence is best-effort.
  }
}

/* The coach hint on a new agent chip shows until its person turns it off. */
const coachHintStorageKey = "letagents-desktop:composer-agent-chip-hint";

export function readCoachHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(coachHintStorageKey) === "off";
  } catch {
    return false;
  }
}

export function rememberCoachHintDismissed(): void {
  try {
    window.localStorage.setItem(coachHintStorageKey, "off");
  } catch {
    // Local preference persistence is best-effort.
  }
}
