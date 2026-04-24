import type { RoomActivityHistoryEntry } from "./room-activity-history.js";
import type { RoomAgentPresence, RoomParticipant } from "./db.js";
import {
  buildRoomActivitySourceFlags,
  deriveRoomAgentActivityState,
} from "../shared/room-agent-activity.js";

function normalizeActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function latestTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestValue = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const parsed = Date.parse(String(value ?? ""));
    if (Number.isFinite(parsed) && parsed > bestValue) {
      bestValue = parsed;
      best = String(value ?? "");
    }
  }

  return best;
}

function buildPresenceIndex(
  presence: readonly RoomAgentPresence[]
): Map<string, RoomAgentPresence> {
  return new Map(
    presence
      .map((entry) => [normalizeActorLabel(entry.actor_label), entry] as const)
      .filter(([actorLabel]) => Boolean(actorLabel))
  );
}

function mergeActivityState(input: {
  hiddenAt: string | null | undefined;
  presenceEntry: RoomAgentPresence | null;
}) {
  const hasDelivery = Boolean(
    input.presenceEntry?.source_flags?.includes("delivery")
  );

  return deriveRoomAgentActivityState({
    hidden: Boolean(input.hiddenAt),
    hasPresence: hasDelivery,
    freshness: hasDelivery ? input.presenceEntry?.freshness ?? null : null,
    status: hasDelivery ? input.presenceEntry?.status ?? null : null,
  });
}

export function decorateRoomParticipantsWithPresence(input: {
  participants: readonly RoomParticipant[];
  presence: readonly RoomAgentPresence[];
}): RoomParticipant[] {
  const presenceByActor = buildPresenceIndex(input.presence);
  return input.participants.map((participant) => {
    if (participant.kind !== "agent") {
      return {
        ...participant,
        last_room_activity_at: participant.last_room_activity_at ?? participant.last_seen_at,
      };
    }

    const actorLabel = normalizeActorLabel(participant.actor_label);
    const presenceEntry = actorLabel ? (presenceByActor.get(actorLabel) ?? null) : null;
    const activityState = mergeActivityState({
      hiddenAt: participant.hidden_at,
      presenceEntry,
    });
    const fallbackSource =
      presenceEntry?.source_flags?.length
        ? []
        : (["messages"] as const);
    const participantSourceFlags = (participant.source_flags ?? []).filter(
      (flag) => flag !== "delivery"
    );

    return {
      ...participant,
      last_room_activity_at: participant.last_room_activity_at ?? participant.last_seen_at,
      last_live_heartbeat_at:
        presenceEntry?.source_flags?.includes("delivery")
          ? presenceEntry.last_heartbeat_at
          : participant.last_live_heartbeat_at,
      activity_state: activityState,
      source_flags: buildRoomActivitySourceFlags([
        ...participantSourceFlags,
        ...(presenceEntry?.source_flags ?? []),
        ...fallbackSource,
      ]),
    };
  });
}

export function decorateRoomActivityHistoryEntriesWithPresence(input: {
  entries: readonly RoomActivityHistoryEntry[];
  presence: readonly RoomAgentPresence[];
}): RoomActivityHistoryEntry[] {
  const presenceByActor = buildPresenceIndex(input.presence);

  return input.entries.map((entry) => {
    if (entry.participant.kind !== "agent") {
      return entry;
    }

    const actorLabel = normalizeActorLabel(entry.participant.actor_label);
    const presenceEntry = actorLabel ? (presenceByActor.get(actorLabel) ?? null) : null;
    const hasTasks =
      entry.current_tasks.length > 0
      || entry.completed_tasks.length > 0
      || entry.created_tasks.length > 0;
    const activityState = mergeActivityState({
      hiddenAt: entry.participant.hidden_at,
      presenceEntry,
    });

    return {
      ...entry,
      participant: {
        ...entry.participant,
        last_live_heartbeat_at:
          presenceEntry?.source_flags?.includes("delivery")
            ? presenceEntry.last_heartbeat_at
            : entry.participant.last_live_heartbeat_at,
        activity_state: activityState,
        source_flags: buildRoomActivitySourceFlags([
          ...(entry.participant.source_flags ?? []),
          ...(presenceEntry?.source_flags ?? []),
          hasTasks ? "tasks" : null,
        ]),
      },
    };
  });
}
