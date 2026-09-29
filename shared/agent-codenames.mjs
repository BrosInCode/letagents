import { createHash } from "node:crypto";

import { normalizeRoutingHandle, normalizeRoutingSender } from "./routing-aliases.mjs";

/**
 * The one pool of generated agent names. Every runtime that names an agent
 * (the API, MCP, the desktop app and its daemon) draws from this list, so a
 * name means the same thing wherever it was assigned.
 *
 * The order is part of the contract: a legacy MCP identity with no saved name
 * re-derives its name, and therefore its key, from an index into this list.
 * Append new words; never reorder or remove.
 */
export const AGENT_CODENAMES = Object.freeze([
  "amber", "anchor", "autumn", "badger", "bay", "bear", "brook", "calm",
  "canyon", "cedar", "clear", "cloud", "comet", "copper", "creek", "crisp",
  "crest", "dawn", "delta", "dune", "ember", "falcon", "fern", "field",
  "firefly", "fjord", "forest", "fox", "garden", "glade", "golden", "granite",
  "grove", "harbor", "hawk", "hollow", "indigo", "ivory", "jade", "juniper",
  "lagoon", "lake", "lantern", "leaf", "lively", "lunar", "lynx", "maple",
  "marsh", "meadow", "mesa", "misty", "moon", "morrow", "moss", "noble",
  "oak", "olive", "opal", "otter", "owl", "peak", "pearl", "pine",
  "quiet", "raven", "reef", "ridge", "river", "rook", "sage", "scarlet",
  "shore", "silver", "sky", "solar", "sparrow", "spring", "star", "stone",
  "storm", "summit", "sun", "sunlit", "swift", "thicket", "tidal", "timber",
  "trail", "valley", "verdant", "vista", "warm", "wave", "west", "wild",
  "willow", "wind", "winter", "wolf", "wood", "wren",
]);

export const AGENT_CODENAME_SPACE = AGENT_CODENAMES.length * AGENT_CODENAMES.length;

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Fused two-word codename at `index`, e.g. "RiverValley". Any integer wraps into the pool. */
export function agentCodenameAt(index) {
  const normalized = ((index % AGENT_CODENAME_SPACE) + AGENT_CODENAME_SPACE) % AGENT_CODENAME_SPACE;
  const first = AGENT_CODENAMES[Math.floor(normalized / AGENT_CODENAMES.length)];
  const second = AGENT_CODENAMES[normalized % AGENT_CODENAMES.length];
  return `${titleCase(first)}${titleCase(second)}`;
}

export function agentCodenameSeedIndex(seed) {
  return createHash("sha256").update(String(seed)).digest().readUInt32BE(0) % AGENT_CODENAME_SPACE;
}

/**
 * The form in which two display names are the same name to a room. A display
 * name is what people and agents type after "@", so names are compared the way
 * mention routing compares them: "FieldMeadow", "fieldmeadow" and
 * "Field Meadow" all answer to "@FieldMeadow" and cannot coexist.
 */
export function agentDisplayNameKey(displayName) {
  return normalizeRoutingHandle(displayName) || normalizeRoutingSender(displayName);
}

/**
 * A codename no listed name already answers to. The seed fixes where the scan
 * starts, so one agent is offered the same name whenever the same names are
 * held. Returns null only when the whole pool is held.
 */
export function suggestFreeAgentCodename(heldDisplayNames, seed) {
  const held = new Set();
  for (const name of heldDisplayNames ?? []) {
    const key = agentDisplayNameKey(typeof name === "string" ? name : "");
    if (key) held.add(key);
  }
  const start = agentCodenameSeedIndex(seed);
  for (let offset = 0; offset < AGENT_CODENAME_SPACE; offset += 1) {
    const candidate = agentCodenameAt(start + offset);
    if (!held.has(agentDisplayNameKey(candidate))) return candidate;
  }
  return null;
}

const PLACEHOLDER_SUFFIX = " supervised agent";
const PLACEHOLDER_PROVIDERS = new Set([
  "codex", "claude", "claude-code", "claude code", "antigravity", "cursor",
  "open-model", "open_model", "open model",
]);

/**
 * Whether a name is what was written when no name was chosen: nothing,
 * "Supervised agent", or a provider followed by "supervised agent". Only
 * known providers count, so a name a person chose that happens to end the
 * same way is left alone.
 */
export function isPlaceholderAgentDisplayName(displayName, provider) {
  const name = String(displayName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name || name === PLACEHOLDER_SUFFIX.trim()) return true;
  if (!name.endsWith(PLACEHOLDER_SUFFIX)) return false;
  const label = name.slice(0, -PLACEHOLDER_SUFFIX.length);
  return PLACEHOLDER_PROVIDERS.has(label)
    || label === String(provider ?? "").trim().toLowerCase();
}
