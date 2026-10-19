import type { DaemonActivityEvent, DaemonManifestEntryView } from "./types.js";

type DeliveryReceipt = NonNullable<DaemonManifestEntryView["delivery_receipts"]>[number];
type DeliveryReceiptPhase = DeliveryReceipt["timeline"][number]["phase"];

/**
 * The delivery-timeline phases the room-level state channel carries.
 *
 * Every room-level reader of a receipt's timeline looks for one of these and
 * for nothing else:
 * - `turn_started`: when the current turn began (renderer `agent-inspector.ts`
 *   `turnStartedAt`, `managed-agents.ts` `currentRoomTurnStartedAt`; both take
 *   the latest one of the current turn's receipt);
 * - `conversation_restored`: whether a missing conversation was restored, with
 *   its sequence and detail (`agent-inspector.ts` `continuationRecovery`).
 *
 * The full timeline of one message stays on the channels scoped to one agent:
 * `manifest.list` and `supervisor.get_agent_inspector_detail` (the Inspector
 * "Delivery timeline" and the message outcome duration read that detail).
 */
export const STATE_WATCH_RECEIPT_TIMELINE_PHASES: ReadonlySet<DeliveryReceiptPhase> = new Set<DeliveryReceiptPhase>([
  "turn_started",
  "conversation_restored",
]);

/**
 * Keep, in order, only the timeline events of the phases above. The timeline
 * stays an array on every receipt: the desktop client drops a receipt without
 * one.
 */
export function projectStateWatchReceipts(
  receipts: readonly DeliveryReceipt[] | undefined,
): DeliveryReceipt[] | undefined {
  if (!receipts) return undefined;
  return receipts.map((receipt) => ({ ...receipt, timeline: projectStateWatchTimeline(receipt.timeline ?? []) }));
}

/**
 * Trimmed timelines by the frozen timeline they were cut from. The read model
 * hands out the same frozen timeline on every wake that reuses its inbox
 * inputs, so such a wake trims nothing again. A frozen array cannot change, so
 * its trim cannot go stale; the map holds nothing once the timeline is gone.
 */
const trimmedFrozenTimelines = new WeakMap<DeliveryReceipt["timeline"], DeliveryReceipt["timeline"]>();

function projectStateWatchTimeline(timeline: DeliveryReceipt["timeline"]): DeliveryReceipt["timeline"] {
  const frozen = Object.isFrozen(timeline);
  const kept = frozen ? trimmedFrozenTimelines.get(timeline) : undefined;
  if (kept) return kept;
  const trimmed = timeline.filter((event) => STATE_WATCH_RECEIPT_TIMELINE_PHASES.has(event.phase));
  if (frozen) trimmedFrozenTimelines.set(timeline, Object.freeze(trimmed) as DeliveryReceipt["timeline"]);
  return trimmed;
}

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
 * publishes: activity trimmed to summaries, and each delivery receipt's
 * timeline trimmed to the phases above. Every other field, and every other
 * field of a receipt, is carried through unchanged: the launch
 * journey, supervised-launch phases, and Inspector projections derive from
 * `condition`, `last_error`, `ready_reached_at`, `provider_ref`, liveness, and
 * room agent state, none of which this touches.
 */
export function projectStateWatchEntries(
  entries: readonly DaemonManifestEntryView[],
): DaemonManifestEntryView[] {
  return entries.map((entry) => (
    entry.activity === undefined && entry.delivery_receipts === undefined ? entry : {
      ...entry,
      ...(entry.activity === undefined ? {} : { activity: projectStateWatchActivity(entry.activity) }),
      ...(entry.delivery_receipts === undefined ? {} : { delivery_receipts: projectStateWatchReceipts(entry.delivery_receipts) }),
    }
  ));
}
