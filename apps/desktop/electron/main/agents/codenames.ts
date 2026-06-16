import { randomUUID } from "node:crypto";

export const LETAGENTS_CODENAME_EXAMPLES = [
  "MapleRidge",
  "CedarVista",
  "DawnWinter",
  "GardenFern",
  "SilverHarbor",
] as const;

const CODENAME_PREFIXES = [
  "Maple",
  "Cedar",
  "Dawn",
  "Garden",
  "Silver",
  "North",
  "Copper",
  "Quartz",
  "Lumen",
  "River",
  "Stone",
  "Bright",
  "Cloud",
  "Field",
  "Harbor",
  "Summit",
] as const;

const CODENAME_SUFFIXES = [
  "Ridge",
  "Vista",
  "Winter",
  "Fern",
  "Harbor",
  "Signal",
  "Vale",
  "River",
  "Haven",
  "Cove",
  "Field",
  "Grove",
  "Point",
  "Forge",
  "Meadow",
  "Peak",
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
  return value.trim().toLowerCase();
}

function firstUnusedCandidate(
  candidates: string[],
  usedNames: Set<string>,
  seed: string,
): string | null {
  if (!candidates.length) {
    return null;
  }

  const startIndex = hashSeed(seed) % candidates.length;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(startIndex + offset) % candidates.length];
    if (candidate && !usedNames.has(normalizeName(candidate))) {
      return candidate;
    }
  }

  return null;
}

function expandedCodenameCandidates(): string[] {
  const candidates: string[] = [];
  for (const prefix of CODENAME_PREFIXES) {
    for (const suffix of CODENAME_SUFFIXES) {
      for (const extraSuffix of CODENAME_SUFFIXES) {
        candidates.push(`${prefix}${suffix}${extraSuffix}`);
      }
    }
  }
  return candidates;
}

export function suggestLetAgentsCodename(
  existingNames: Iterable<string | null | undefined> = [],
  seed: string = randomUUID(),
): string {
  const usedNames = new Set(
    Array.from(existingNames)
      .map((name) => normalizeName(String(name ?? "")))
      .filter(Boolean),
  );
  const candidates = [
    ...LETAGENTS_CODENAME_EXAMPLES,
    ...CODENAME_PREFIXES.flatMap((prefix) =>
      CODENAME_SUFFIXES.map((suffix) => `${prefix}${suffix}`)
    ),
  ];
  const uniqueCandidates = Array.from(new Set(candidates));
  const preferred = firstUnusedCandidate(uniqueCandidates, usedNames, seed);
  if (preferred) return preferred;

  const expanded = firstUnusedCandidate(
    Array.from(new Set(expandedCodenameCandidates())),
    usedNames,
    `${seed}:expanded`,
  );
  if (expanded) return expanded;

  return `LumenForge${randomUUID().replace(/[^a-f]/g, "").slice(0, 6) || "Signal"}`;
}
