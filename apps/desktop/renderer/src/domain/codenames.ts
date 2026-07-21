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

/** Short, stable, human-safe identity tag; never a routing key or secret. */
export function supervisedAgentShortTag(creationRequestId: string): string {
  return hashSeed(creationRequestId).toString(36).padStart(6, "0").slice(-6);
}

const CANDIDATES = CODENAME_PREFIXES.flatMap((prefix) =>
  CODENAME_SUFFIXES.map((suffix) => `${prefix}${suffix}`),
);

/**
 * Selects a deterministic name from the names that already exist in the
 * room. Durable entry ids resolve the authoritative collision; a compact
 * stable tag keeps simultaneous human-facing labels distinguishable without
 * leaking the full launch UUID.
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
      return `${candidate} · ${supervisedAgentShortTag(creationRequestId)}`;
    }
  }

  return `LumenForge · ${supervisedAgentShortTag(creationRequestId)}`;
}

/** Replace a legacy full UUID suffix with the same entry's compact tag. */
export function supervisedAgentDisplayLabel(displayName: string, entryId?: string | null): string {
  const name = displayName.trim();
  const requestId = entryId?.startsWith("supervised_") ? entryId.slice("supervised_".length) : "";
  const suffix = requestId ? ` · ${requestId}` : "";
  if (!suffix || !name.endsWith(suffix)) return name;
  const base = name.slice(0, -suffix.length).trim() || name;
  return `${base} · ${supervisedAgentShortTag(requestId)}`;
}
