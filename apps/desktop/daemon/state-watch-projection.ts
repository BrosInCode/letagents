import type { DaemonActivityEvent, DaemonManifestEntryView } from "./types.js";

/**
 * How many activity summaries the room-level state channel carries per entry.
 *
 * `manifest.watch_state` is a high-frequency push: every running agent
 * re-publishes its worker binding roughly every 30 s, so one sequence change
 * per publication makes each subscriber re-read the whole manifest. Full
 * activity history dominated that payload (measured 15.2 MB of a 16.3 MB
 * snapshot across 157 entries, two thirds of them long-stopped agents still
 * shipping 200 events each) and no room-level view needs it.
 *
 * Room-level consumers only read the newest human-visible summary: the chat
 * activity echo, the Inspector "Now" line, and the supervised-recovery detail
 * fallback all scan newest-first for one matching event. The limit is a small
 * multiple of one event so those scans can still skip the interleaved
 * usage/provider bookkeeping events that they filter out.
 *
 * Full history and raw payloads stay on the channels that are already scoped
 * to one agent: `manifest.list` (initial load and stale-subscription repair),
 * `supervisor.watch_agent_stream`, and `supervisor.get_agent_inspector_detail`.
 */
export const STATE_WATCH_ACTIVITY_SUMMARY_LIMIT = 16;

/**
 * Keep the newest events by sequence and drop their payloads. Payloads are the
 * unbounded part of an activity event (up to 8 KiB each after redaction);
 * everything a room-level view renders is in the summary fields.
 */
export function projectStateWatchActivity(
  activity: readonly DaemonActivityEvent[] | undefined,
): DaemonActivityEvent[] {
  if (!activity || activity.length === 0) return [];
  return [...activity]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-STATE_WATCH_ACTIVITY_SUMMARY_LIMIT)
    .map((event) => ({ ...event, payload: null }));
}

/**
 * Project a manifest read model into the shape the room-level state channel
 * publishes. Every other entry field is carried through unchanged: the launch
 * journey, supervised-launch phases, and Inspector projections derive from
 * `condition`, `last_error`, `ready_reached_at`, `provider_ref`, liveness, and
 * room agent state, none of which this touches.
 */
export function projectStateWatchEntries(
  entries: readonly DaemonManifestEntryView[],
): DaemonManifestEntryView[] {
  return entries.map((entry) => (
    entry.activity === undefined ? entry : { ...entry, activity: projectStateWatchActivity(entry.activity) }
  ));
}
