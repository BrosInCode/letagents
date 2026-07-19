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

const CANDIDATES = CODENAME_PREFIXES.flatMap((prefix) =>
  CODENAME_SUFFIXES.map((suffix) => `${prefix}${suffix}`),
);

/**
 * Selects a deterministic name from the names that already exist in the
 * room. The full request id suffix makes the persisted label globally
 * distinguishable even when two desktop windows read the same stale room list.
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
      return `${candidate} · ${creationRequestId}`;
    }
  }

  // The expanded name is still deterministic and intentionally carries only
  // a short, human-readable slice of the request id. It is a display label,
  // never an identity key.
  return `LumenForge · ${creationRequestId}`;
}
