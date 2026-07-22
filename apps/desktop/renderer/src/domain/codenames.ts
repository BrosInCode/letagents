/**
 * Browser-safe codename selection for a newly requested supervised Codex
 * agent. The daemon owns identity; this only supplies a friendly, mutable
 * display name before the durable create claim is made.
 */
const CODENAME_PREFIXES = [
  "Maple", "Cedar", "Dawn", "Garden", "Silver", "North", "Copper", "Quartz",
  "Lumen", "River", "Stone", "Bright", "Cloud", "Field", "Harbor", "Summit",
] as const;

const CODENAME_SUFFIXES = [
  "Ridge", "Vista", "Winter", "Fern", "Harbor", "Signal", "Vale", "River",
  "Haven", "Cove", "Field", "Grove", "Point", "Forge", "Meadow", "Peak",
] as const;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Legacy compact identity tag. Durable entry ids, not this tag, are the
 * routing identity. Keep this only to recognize names written by older
 * desktop versions.
 */
export function supervisedAgentShortTag(creationRequestId: string): string {
  return hashSeed(creationRequestId).toString(36).padStart(6, "0").slice(-6);
}

const CANDIDATES = CODENAME_PREFIXES.flatMap((prefix) =>
  CODENAME_SUFFIXES.map((suffix) => `${prefix}${suffix}`),
);

/**
 * Selects a deterministic name from the names that already exist in the
 * room. Durable entry ids resolve the authoritative collision, so the normal
 * product label remains the friendly codename alone.
 */
export function suggestSupervisedCodexCodename(
  existingNames: Iterable<string | null | undefined>,
  creationRequestId: string,
): string {
  const usedNames = new Set(
    Array.from(existingNames)
      .map((name) => normalizeName(String(name ?? "")))
      .filter(Boolean),
  );
  const startIndex = hashSeed(creationRequestId) % CANDIDATES.length;
  for (let offset = 0; offset < CANDIDATES.length; offset += 1) {
    const candidate = CANDIDATES[(startIndex + offset) % CANDIDATES.length]!;
    if (!usedNames.has(normalizeName(candidate))) {
      return candidate;
    }
  }

  return "LumenForge";
}

/**
 * Project a supervised entry's durable name for product UI without changing
 * its stored identity. Older desktop versions persisted either the full entry
 * request id or its compact hash after the friendly codename. Strip only the
 * suffix derived from this exact entry, so an intentional human name with
 * punctuation remains untouched.
 */
export function supervisedAgentDisplayLabel(displayName: string, entryId?: string | null): string {
  const name = displayName.trim();
  const requestId = entryId?.startsWith("supervised_") ? entryId.slice("supervised_".length) : "";
  if (!requestId) return name;
  const suffixes = [` · ${requestId}`, ` · ${supervisedAgentShortTag(requestId)}`];
  const suffix = suffixes.find((candidate) => name.endsWith(candidate));
  if (!suffix) return name;
  return name.slice(0, -suffix.length).trim() || name;
}
