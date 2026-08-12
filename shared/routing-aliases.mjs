import { createHash } from "node:crypto";

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

function routingIdentityAliasInputs(identity) {
  const agentKey = typeof identity?.agentKey === "string"
    ? identity.agentKey
    : typeof identity?.agent_key === "string"
      ? identity.agent_key
      : "";
  return Array.from(new Set([
    identity?.actorLabel ?? identity?.actor_label,
    identity?.displayName ?? identity?.display_name,
    agentKey,
    agentKey.split("/").pop(),
  ].map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)));
}

export function routingIdentityAliases(identity) {
  const aliases = new Set();
  for (const value of routingIdentityAliasInputs(identity)) {
    const senderAlias = normalizeRoutingSender(value);
    if (senderAlias) aliases.add(senderAlias);
    const handleAlias = normalizeRoutingHandle(value);
    if (handleAlias) aliases.add(handleAlias);
  }
  return aliases;
}

export function routingSenderAliasRows(sender, segmentLimit = 16) {
  const raw = typeof sender === "string" ? sender : "";
  const fullAlias = normalizeRoutingSender(raw);
  const byAlias = new Map();
  if (fullAlias) byAlias.set(fullAlias, true);
  for (const segment of raw.split("|").slice(0, Math.max(0, segmentLimit))) {
    const alias = normalizeRoutingSender(segment);
    if (alias && !byAlias.has(alias)) byAlias.set(alias, false);
  }
  return [...byAlias].map(([alias, isFull]) => ({ alias, isFull }));
}

export function routingSenderAliases(sender, segmentLimit = 16) {
  return new Set(routingSenderAliasRows(sender, segmentLimit).map(({ alias }) => alias));
}

export function routingAliasHash(alias) {
  return createHash("md5").update(alias).digest("hex");
}
