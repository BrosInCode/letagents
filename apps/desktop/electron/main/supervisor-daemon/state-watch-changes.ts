import type { DesktopSupervisorManifestEntry, DesktopSupervisorStateSnapshot } from "../../ipc-types.js";
import type { DesktopSupervisorStateChanges } from "./types.js";

/**
 * The whole state after the changes since the state held: changed entries
 * replace or join the held ones, removed ids leave, and the daemon's order
 * names every entry. Null when the two do not fit together (another daemon
 * generation, an older sequence, an entry in the order that neither side has,
 * or a held entry the order no longer names without a removal): the holder
 * then asks for the whole state again, which is always correct.
 */
export function applySupervisorStateChanges(
  held: DesktopSupervisorStateSnapshot,
  changes: DesktopSupervisorStateChanges,
): DesktopSupervisorStateSnapshot | null {
  if (held.daemonGeneration !== changes.daemonGeneration || changes.sequence < held.sequence) return null;
  const byId = new Map(held.entries.map((entry) => [entry.id, entry]));
  for (const id of changes.removedEntryIds) byId.delete(id);
  for (const entry of changes.changedEntries) byId.set(entry.id, entry);
  const entries: DesktopSupervisorManifestEntry[] = [];
  const named = new Set<string>();
  for (const id of changes.entryOrder) {
    const entry = byId.get(id);
    if (!entry || named.has(id)) return null;
    named.add(id);
    entries.push(entry);
  }
  if (entries.length !== byId.size) return null;
  return { daemonGeneration: changes.daemonGeneration, sequence: changes.sequence, entries };
}
