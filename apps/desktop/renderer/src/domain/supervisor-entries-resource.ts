import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

export const SUPERVISOR_ACTIVITY_CAP = 200;
export const SUPERVISOR_STATE_SUBSCRIPTION_STALE_MS = 60_000;

/**
 * Event delivery is an optimization, not the only repair path. Registration
 * proves that preload exposed a callback; only a recent snapshot proves that
 * the Electron-to-renderer subscription is still carrying state.
 */
export function supervisorStateSubscriptionNeedsRepair(input: {
  active: boolean;
  lastSnapshotAtMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}): boolean {
  if (!input.active || input.lastSnapshotAtMs === null) return true;
  const staleAfterMs = Math.max(1, input.staleAfterMs ?? SUPERVISOR_STATE_SUBSCRIPTION_STALE_MS);
  return input.nowMs - input.lastSnapshotAtMs >= staleAfterMs;
}

/**
 * Schedule one repair at the next missing-push deadline. A completed repair is
 * also evidence for scheduling purposes, so an unavailable/legacy daemon does
 * not turn a stale snapshot into a zero-delay retry loop.
 */
export function supervisorStateRepairDelayMs(input: {
  lastRepairAtMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}): number {
  const staleAfterMs = Math.max(1, input.staleAfterMs ?? SUPERVISOR_STATE_SUBSCRIPTION_STALE_MS);
  if (input.lastRepairAtMs === null) return staleAfterMs;
  return Math.max(0, staleAfterMs - Math.max(0, input.nowMs - input.lastRepairAtMs));
}

/**
 * Electron can coalesce a renderer status read onto an older daemon-start
 * operation. Compare the response that actually settled with the generation
 * required by the push stream and allow at most one trailing negotiation for
 * each newly required generation.
 */
export function supervisorStatusTrailingRefreshGeneration(input: {
  ownerActive: boolean;
  settledGeneration: number;
  requiredGeneration: number;
  lastAttemptedGeneration: number;
}): number | null {
  if (!input.ownerActive) return null;
  if (input.settledGeneration >= input.requiredGeneration) return null;
  if (input.lastAttemptedGeneration >= input.requiredGeneration) return null;
  return input.requiredGeneration;
}

/**
 * Refreshing with retained data is not a loss of authority. First-load and
 * transport-error states still fail closed because they have no current proof.
 */
export function supervisorEntriesResourceFreshness(
  state: "loading" | "refreshing" | "ready" | "error",
): "fresh" | "stale" {
  return state === "refreshing" || state === "ready" ? "fresh" : "stale";
}

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
 * Activity events are immutable facts keyed by sequence, and the room-level
 * state channel carries only a bounded, payload-free summary tail of them. So
 * a state snapshot must never replace an event this renderer already holds:
 * the richer copy (from `manifest.list` or the activity bridge) wins, and
 * older events outside the snapshot's tail are retained rather than dropped.
 */
function mergeActivityRetainingDetail(
  held: readonly DesktopSupervisorActivityEvent[],
  snapshot: readonly DesktopSupervisorActivityEvent[],
  cap: number,
): DesktopSupervisorActivityEvent[] {
  const bySequence = new Map<number, DesktopSupervisorActivityEvent>();
  for (const event of snapshot) bySequence.set(event.sequence, event);
  for (const event of held) bySequence.set(event.sequence, event);
  return [...bySequence.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-cap);
}

/**
 * A change signature that ignores activity payloads. Everything a room-level
 * view renders is either a non-activity entry field or an activity event
 * identified by its sequence, so two entries with the same signature are
 * interchangeable for rendering.
 */
function supervisorEntrySignature(entry: DesktopSupervisorManifestEntry): string {
  const { activity, ...rest } = entry;
  return `${JSON.stringify(rest)}|${activity.map((event) => event.sequence).join(",")}`;
}

/**
 * Fold a pushed state snapshot into the retained entries.
 *
 * Returns the *same array* when nothing a view renders changed, and reuses the
 * retained object for every unchanged entry. A binding republication from one
 * agent must not invalidate the whole supervised list; the snapshot arrives
 * several times a minute per running agent, so an unconditional reassignment
 * is a full reactivity pass each time.
 */
export function mergeSupervisorStateSnapshotEntries(
  current: readonly DesktopSupervisorManifestEntry[],
  snapshot: readonly DesktopSupervisorManifestEntry[],
  roomId: string,
  cap = SUPERVISOR_ACTIVITY_CAP,
): DesktopSupervisorManifestEntry[] {
  const retainedById = new Map(
    current.filter((entry) => entry.roomId === roomId).map((entry) => [entry.id, entry]),
  );
  const next = snapshot.map((entry) => {
    const retained = entry.roomId === roomId ? retainedById.get(entry.id) : undefined;
    if (!retained) return { ...entry, activity: mergeActivityRetainingDetail([], entry.activity, cap) };
    const candidate = {
      ...entry,
      activity: mergeActivityRetainingDetail(retained.activity, entry.activity, cap),
    };
    return supervisorEntrySignature(candidate) === supervisorEntrySignature(retained) ? retained : candidate;
  });
  const unchanged = next.length === current.length
    && next.every((entry, index) => entry === current[index]);
  return unchanged ? (current as DesktopSupervisorManifestEntry[]) : next;
}

/**
 * State snapshots are normally push-maintained; this merge also fences the
 * exceptional repair read so a response that began before a newer activity
 * push cannot erase human-readable progress.
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
