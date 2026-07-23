import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

export const SUPERVISOR_ACTIVITY_CAP = 200;

export interface SupervisorActivityPush {
  entryId: string;
  event: DesktopSupervisorActivityEvent;
}

function mergeActivity(
  left: readonly DesktopSupervisorActivityEvent[],
  right: readonly DesktopSupervisorActivityEvent[],
  cap = SUPERVISOR_ACTIVITY_CAP,
): DesktopSupervisorActivityEvent[] {
  const bySequence = new Map<number, DesktopSupervisorActivityEvent>();
  for (const event of [...left, ...right]) bySequence.set(event.sequence, event);
  return [...bySequence.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-cap);
}

/** Fold the process-wide activity bridge only into the exact room/entry. */
export function foldSupervisorActivityPush(
  entries: readonly DesktopSupervisorManifestEntry[],
  roomId: string,
  push: SupervisorActivityPush,
  cap = SUPERVISOR_ACTIVITY_CAP,
): DesktopSupervisorManifestEntry[] {
  const index = entries.findIndex((entry) => entry.id === push.entryId && entry.roomId === roomId);
  if (index < 0) return entries as DesktopSupervisorManifestEntry[];
  const entry = entries[index]!;
  if (entry.activity.some((event) => event.sequence === push.event.sequence)) return entries as DesktopSupervisorManifestEntry[];
  const next = [...entries];
  next[index] = { ...entry, activity: mergeActivity(entry.activity, [push.event], cap) };
  return next;
}

/**
 * Polling remains the authoritative entry snapshot, while the push stream is
 * authoritative for activity received after that snapshot began. Merging the
 * ordered event journal prevents an older poll response from erasing newer
 * human-readable progress.
 */
export function mergeSupervisorEntriesPoll(
  current: readonly DesktopSupervisorManifestEntry[],
  polled: readonly DesktopSupervisorManifestEntry[],
  roomId: string,
  cap = SUPERVISOR_ACTIVITY_CAP,
): DesktopSupervisorManifestEntry[] {
  const currentById = new Map(current.filter((entry) => entry.roomId === roomId).map((entry) => [entry.id, entry]));
  return polled.map((entry) => {
    if (entry.roomId !== roomId) return entry;
    const existing = currentById.get(entry.id);
    if (!existing) return { ...entry, activity: mergeActivity([], entry.activity, cap) };
    const pollHighWater = entry.activity.reduce((highest, event) => Math.max(highest, event.sequence), -1);
    const pushedAfterSnapshot = existing.activity.filter((event) => event.sequence > pollHighWater);
    return { ...entry, activity: mergeActivity(entry.activity, pushedAfterSnapshot, cap) };
  });
}
