import type {
  DesktopRentalIdeKind,
  DesktopRentalListingInput,
  DesktopRentalMode,
} from "../../../../../electron/ipc-types";

/**
 * Pure helpers for the listing create/edit form — extracted from the
 * modal so validation and payload shaping are testable without Vue.
 */

export const LISTING_IDE_KINDS: readonly DesktopRentalIdeKind[] = [
  "claude_code",
  "codex",
  "cursor",
];

/**
 * Sanity cap on concurrent rentals per listing. The quota-lease layer
 * admits up to the listing's max_concurrent_sessions active leases per
 * lane, but only when the meter attributes usage per session
 * (official_exact / local_exact); estimated and percent-window meters
 * run one rental at a time regardless of this setting.
 */
export const MAX_CONCURRENT_SESSIONS_CAP = 4;

const IDE_KIND_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

export function ideKindLabel(kind: DesktopRentalIdeKind): string {
  return IDE_KIND_LABELS[kind] ?? kind;
}

export interface ListingFormValues {
  displayName: string;
  ideKind: DesktopRentalIdeKind;
  modelLabel: string;
  supportsScoped: boolean;
  supportsTrustedOpen: boolean;
  defaultLrtLimit: number | "";
  defaultTimeLimitMinutes: number | "";
  maxConcurrentSessions: number | "";
  manualAcceptRequired: boolean;
}

export type ListingFormResult =
  | { input: DesktopRentalListingInput }
  | { error: string };

/**
 * Validate and shape the form values into the IPC listing input.
 * Empty number fields become null (no default); numbers must be
 * positive integers.
 */
export function buildListingFormInput(values: ListingFormValues): ListingFormResult {
  const displayName = values.displayName.trim();
  if (!displayName) return { error: "Display name is required." };

  const supportedModes: DesktopRentalMode[] = [];
  if (values.supportsScoped) supportedModes.push("scoped");
  if (values.supportsTrustedOpen) supportedModes.push("trusted_open");
  if (supportedModes.length === 0) {
    return { error: "Pick at least one access level renters can request." };
  }

  const lrtLimit = normalizePositiveInt(values.defaultLrtLimit);
  if (lrtLimit === undefined) {
    return { error: "Default budget must be a positive whole number." };
  }
  const timeLimit = normalizePositiveInt(values.defaultTimeLimitMinutes);
  if (timeLimit === undefined) {
    return { error: "Default time limit must be a positive whole number." };
  }
  const maxConcurrent = normalizePositiveInt(values.maxConcurrentSessions);
  if (maxConcurrent === undefined || maxConcurrent === null) {
    return { error: "Max concurrent rentals must be a positive whole number." };
  }
  if (maxConcurrent > MAX_CONCURRENT_SESSIONS_CAP) {
    return {
      error: `Concurrent rentals are limited to ${MAX_CONCURRENT_SESSIONS_CAP} per listing.`,
    };
  }

  return {
    input: {
      displayName,
      ideKind: values.ideKind,
      modelLabel: values.modelLabel.trim() || null,
      supportedModes,
      defaultLrtLimit: lrtLimit,
      defaultTimeLimitMinutes: timeLimit,
      maxConcurrentSessions: maxConcurrent,
      manualAcceptRequired: values.manualAcceptRequired,
    },
  };
}

/** "" → null (unset); valid positive int → the int; anything else → undefined (error). */
function normalizePositiveInt(value: number | ""): number | null | undefined {
  if (value === "" || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Listing action availability (dashboard buttons)
// ---------------------------------------------------------------------------

export function canPauseListing(status: string): boolean {
  return status === "active";
}

/**
 * setup_required is where createListing leaves new rows — "Activate" is
 * the same resume endpoint, which sets status to active.
 */
export function canResumeListing(status: string): boolean {
  return status === "paused" || status === "setup_required";
}

export function resumeListingLabel(status: string): string {
  return status === "setup_required" ? "Activate" : "Resume";
}
