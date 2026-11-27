/**
 * Agent names without Node built-ins, so the desktop window can use them:
 * how "@" compares two names, and the one pool of generated names.
 * routing-aliases.mjs and agent-codenames.mjs re-export these.
 */

/**
 * Stable cross-engine fold: ASCII A-Z only. Unicode case conversion varies by
 * JS/ICU/PostgreSQL version and locale, so non-ASCII aliases are deliberately
 * case-sensitive while exact non-ASCII labels still match everywhere.
 */
function foldRoutingText(value) {
  return String(value ?? "").replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32));
}

export function normalizeRoutingSender(value) {
  return foldRoutingText(typeof value === "string" ? value.trim() : "")
    .replace(/\s+/g, " ");
}

export function normalizeRoutingHandle(value) {
  return foldRoutingText(typeof value === "string" ? value.trim() : "")
    .replace(/[^a-z0-9_.:/-]+/g, "");
}

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
 * A codename no listed name already answers to, scanning the pool from
 * `start`. Returns null only when the whole pool is held.
 */
export function suggestFreeAgentCodenameFrom(heldDisplayNames, start) {
  const held = new Set();
  for (const name of heldDisplayNames ?? []) {
    const key = agentDisplayNameKey(typeof name === "string" ? name : "");
    if (key) held.add(key);
  }
  for (let offset = 0; offset < AGENT_CODENAME_SPACE; offset += 1) {
    const candidate = agentCodenameAt(start + offset);
    if (!held.has(agentDisplayNameKey(candidate))) return candidate;
  }
  return null;
}

/** Short names the Add agent dialog offers first, in order, before a codename. */
export const FRIENDLY_AGENT_NAMES = Object.freeze(["Atlas", "Scout", "Nova", "Milo", "Echo", "Sage", "Reviewer", "Builder"]);
