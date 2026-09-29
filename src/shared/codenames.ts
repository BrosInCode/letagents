/**
 * Agent codenames — extracted from server.ts per Emmy's directive.
 *
 * Each agent instance gets a fused one-word codename (e.g. "RiverValley")
 * deterministically derived from its runtime key via SHA-256 hashing.
 */
import { createHash } from "crypto";
import { AGENT_CODENAMES as SHARED_AGENT_CODENAMES } from "../../shared/agent-codenames.mjs";
import { toTitleCaseCodename } from "../shared/agent-identity.js";

// ---------------------------------------------------------------------------
// Codenames
// ---------------------------------------------------------------------------

export const AGENT_CODENAMES = SHARED_AGENT_CODENAMES;

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
