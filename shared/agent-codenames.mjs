import { createHash } from "node:crypto";

import {
  AGENT_CODENAME_SPACE,
  suggestFreeAgentCodenameFrom,
} from "./agent-names.mjs";

export {
  AGENT_CODENAMES,
  AGENT_CODENAME_SPACE,
  agentCodenameAt,
  agentDisplayNameKey,
} from "./agent-names.mjs";

export function agentCodenameSeedIndex(seed) {
  return createHash("sha256").update(String(seed)).digest().readUInt32BE(0) % AGENT_CODENAME_SPACE;
}

/**
 * A codename no listed name already answers to. The seed fixes where the scan
 * starts, so one agent is offered the same name whenever the same names are
 * held. Returns null only when the whole pool is held.
 */
export function suggestFreeAgentCodename(heldDisplayNames, seed) {
  return suggestFreeAgentCodenameFrom(heldDisplayNames, agentCodenameSeedIndex(seed));
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
