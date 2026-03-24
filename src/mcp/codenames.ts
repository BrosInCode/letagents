/**
 * Agent codenames — extracted from server.ts per Emmy's directive.
 *
 * Each agent instance gets a fused one-word codename (e.g. "RiverValley")
 * deterministically derived from its runtime key via SHA-256 hashing.
 */
import { createHash } from "crypto";
import { toTitleCaseCodename } from "../shared/agent-identity.js";

// ---------------------------------------------------------------------------
// Codenames
// ---------------------------------------------------------------------------

export const AGENT_CODENAMES = [
  "amber",
  "anchor",
  "autumn",
  "badger",
  "bay",
  "bear",
  "brook",
  "calm",
  "canyon",
  "cedar",
  "clear",
  "cloud",
  "comet",
  "copper",
  "creek",
  "crisp",
  "crest",
  "dawn",
  "delta",
  "dune",
  "ember",
  "falcon",
  "fern",
  "field",
  "firefly",
  "fjord",
  "forest",
  "fox",
  "garden",
  "glade",
  "golden",
  "granite",
  "grove",
  "harbor",
  "hawk",
  "hollow",
  "indigo",
  "ivory",
  "jade",
  "juniper",
  "lagoon",
  "lake",
  "lantern",
  "leaf",
  "lively",
  "lunar",
  "lynx",
  "maple",
  "marsh",
  "meadow",
  "mesa",
  "misty",
  "moon",
  "morrow",
  "moss",
  "noble",
  "oak",
  "olive",
  "opal",
  "otter",
  "owl",
  "peak",
  "pearl",
  "pine",
  "quiet",
  "raven",
  "reef",
  "ridge",
  "river",
  "rook",
  "sage",
  "scarlet",
  "shore",
  "silver",
  "sky",
  "solar",
  "sparrow",
  "spring",
  "star",
  "stone",
  "storm",
  "summit",
  "sun",
  "sunlit",
  "swift",
  "thicket",
  "tidal",
  "timber",
  "trail",
  "valley",
  "verdant",
  "vista",
  "warm",
  "wave",
  "west",
  "wild",
  "willow",
  "wind",
  "winter",
  "wolf",
  "wood",
  "wren",
] as const;

export const AGENT_CODENAME_SPACE = AGENT_CODENAMES.length * AGENT_CODENAMES.length;

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

export function normalizeSlugSegment(input: string, fallback: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return normalized || fallback;
}

export function normalizeAgentBaseName(input: string): string {
  return normalizeSlugSegment(input, "agent").replace(/-agent$/, "") || "agent";
}

// ---------------------------------------------------------------------------
// Codename derivation
// ---------------------------------------------------------------------------

export function hashStringToIndex(value: string, modulo: number): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) % modulo;
}

export function codenameFromIndex(index: number): { name: string; display_name: string } {
  const normalizedIndex = ((index % AGENT_CODENAME_SPACE) + AGENT_CODENAME_SPACE) % AGENT_CODENAME_SPACE;
  const firstIndex = Math.floor(normalizedIndex / AGENT_CODENAMES.length);
  const secondIndex = normalizedIndex % AGENT_CODENAMES.length;
  const first = AGENT_CODENAMES[firstIndex];
  const second = AGENT_CODENAMES[secondIndex];
  const fusedDisplayName = `${toTitleCaseCodename(first)}${toTitleCaseCodename(second)}`;
  const fusedName = `${first}${second}`;

  return {
    name: normalizeAgentBaseName(fusedName),
    display_name: fusedDisplayName,
  };
}

export function pickLocalCodename(runtimeKey: string, offset = 0): { name: string; display_name: string } {
  const index = hashStringToIndex(runtimeKey, AGENT_CODENAME_SPACE) + offset;
  return codenameFromIndex(index);
}
