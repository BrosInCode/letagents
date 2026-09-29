/**
 * Display projection for supervised agent names. The renderer never chooses a
 * name: the background service assigns one when it saves the agent, because
 * only it can see the names already taken in the room.
 */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Legacy compact identity tag. Durable entry ids, not this tag, are the
 * routing identity. Keep this only to recognize names written by older
 * desktop versions.
 */
export function supervisedAgentShortTag(creationRequestId: string): string {
  return hashSeed(creationRequestId).toString(36).padStart(6, "0").slice(-6);
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
