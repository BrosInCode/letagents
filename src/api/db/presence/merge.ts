import {
  getAgentPresenceFreshnessFromReachability,
} from "../../../shared/agent-presence.js";
import {
  buildRoomActivitySourceFlags,
  deriveRoomAgentActivityState,
  isWithinRecentlyOfflineWindow,
  RECENTLY_OFFLINE_MAX_AGENTS,
  RECENTLY_OFFLINE_WINDOW_MS,
} from "../../../shared/room-agent-activity.js";
import type {
  RoomAgentDeliverySession,
  RoomAgentLivenessObservation,
  RoomAgentPresence,
} from "../types.js";
import {
  getRoomAgentDeliverySessionLastSeenAt,
  isRoomAgentDeliverySessionReachable,
  normalizeRoomActorLabel,
} from "./helpers.js";

export function mergeRoomAgentPresenceRecords(input: {
  roomId: string;
  statusEntries: readonly RoomAgentPresence[];
  deliverySessions: readonly RoomAgentDeliverySession[];
  livenessObservations?: readonly RoomAgentLivenessObservation[];
  now?: number;
}): RoomAgentPresence[] {
  const now = input.now ?? Date.now();
  const statusByActor = new Map(input.statusEntries.map((entry) => [entry.actor_label, entry]));
  const livenessBySession = new Map<string, RoomAgentLivenessObservation>();
  for (const entry of input.livenessObservations ?? []) {
    const existing = livenessBySession.get(entry.agent_session_id);
    if (!existing || Date.parse(entry.last_observed_at) > Date.parse(existing.last_observed_at)) {
      livenessBySession.set(entry.agent_session_id, entry);
    }
  }
  const statusActorsWithDelivery = new Set<string>();

  const buildEntry = (
    actorLabel: string,
    statusEntry: RoomAgentPresence | null,
    deliverySession: RoomAgentDeliverySession | null
  ): RoomAgentPresence => {
    const isReachable = deliverySession
      ? isRoomAgentDeliverySessionReachable(deliverySession, now)
      : false;
    const status = statusEntry?.status ?? "idle";
    const agentSessionId = deliverySession?.agent_session_id ?? statusEntry?.agent_session_id ?? null;
    const lastSeenAt = deliverySession
      ? getRoomAgentDeliverySessionLastSeenAt(deliverySession)
      : statusEntry?.last_heartbeat_at ?? new Date(0).toISOString();

    return {
      room_id: input.roomId,
      actor_label: actorLabel,
      agent_key: deliverySession?.agent_key ?? statusEntry?.agent_key ?? null,
      agent_instance_id: deliverySession?.agent_instance_id ?? statusEntry?.agent_instance_id ?? null,
      agent_session_id: agentSessionId,
      session_kind: deliverySession?.session_kind ?? statusEntry?.session_kind ?? "controller",
      runtime: deliverySession?.runtime ?? statusEntry?.runtime ?? "unknown",
      display_name: deliverySession?.display_name ?? statusEntry?.display_name ?? actorLabel,
      owner_label: deliverySession?.owner_label ?? statusEntry?.owner_label ?? null,
      ide_label: deliverySession?.ide_label ?? statusEntry?.ide_label ?? null,
      status,
      status_text: statusEntry?.status_text ?? null,
      last_heartbeat_at: lastSeenAt,
      created_at: statusEntry?.created_at ?? deliverySession?.created_at ?? lastSeenAt,
      updated_at: deliverySession?.updated_at ?? statusEntry?.updated_at ?? lastSeenAt,
      freshness: getAgentPresenceFreshnessFromReachability(isReachable),
      activity_state: deriveRoomAgentActivityState({
        hidden: false,
        hasPresence: Boolean(statusEntry || deliverySession),
        freshness: getAgentPresenceFreshnessFromReachability(isReachable),
        status: deliverySession ? status : "idle",
      }),
      source_flags: buildRoomActivitySourceFlags([
        deliverySession ? "delivery" : null,
        statusEntry ? "presence" : null,
      ]),
      liveness_observation: agentSessionId ? livenessBySession.get(agentSessionId) ?? null : null,
    } satisfies RoomAgentPresence;
  };

  const merged: RoomAgentPresence[] = [];
  for (const deliverySession of input.deliverySessions) {
    const actorLabel = deliverySession.actor_label;
    statusActorsWithDelivery.add(actorLabel);
    merged.push(buildEntry(actorLabel, statusByActor.get(actorLabel) ?? null, deliverySession));
  }
  for (const statusEntry of input.statusEntries) {
    if (statusActorsWithDelivery.has(statusEntry.actor_label)) {
      continue;
    }
    merged.push(buildEntry(statusEntry.actor_label, statusEntry, null));
  }

  return merged.sort((left, right) => {
    if (left.freshness !== right.freshness) {
      return left.freshness === "active" ? -1 : 1;
    }

    const leftSeenAt = Date.parse(left.last_heartbeat_at);
    const rightSeenAt = Date.parse(right.last_heartbeat_at);
    if (Number.isFinite(leftSeenAt) && Number.isFinite(rightSeenAt) && leftSeenAt !== rightSeenAt) {
      return rightSeenAt - leftSeenAt;
    }

    return left.display_name.localeCompare(right.display_name);
  });
}

export function filterRoomAgentPresenceForLiveRoster(input: {
  presence: readonly RoomAgentPresence[];
  suppressedActors?: ReadonlySet<string>;
  limit: number;
  staleLimit?: number;
  staleWithinMs?: number;
  now?: number;
}): RoomAgentPresence[] {
  const now = input.now ?? Date.now();
  const staleLimit = Math.max(0, Math.min(input.staleLimit ?? RECENTLY_OFFLINE_MAX_AGENTS, input.limit));
  const staleWithinMs = input.staleWithinMs ?? RECENTLY_OFFLINE_WINDOW_MS;
  const active: RoomAgentPresence[] = [];
  const stale: RoomAgentPresence[] = [];

  for (const entry of input.presence) {
    if (entry.session_kind !== "worker") {
      continue;
    }

    if (entry.freshness === "active") {
      active.push(entry);
      continue;
    }

    const actorLabel = normalizeRoomActorLabel(entry.actor_label);
    if (actorLabel && input.suppressedActors?.has(actorLabel)) {
      continue;
    }

    if (!isWithinRecentlyOfflineWindow(entry.last_heartbeat_at, now, staleWithinMs)) {
      continue;
    }

    if (!entry.source_flags.includes("delivery")) {
      continue;
    }

    stale.push(entry);
  }

  const boundedActive = active.slice(0, input.limit);
  const remaining = Math.max(input.limit - boundedActive.length, 0);
  return [
    ...boundedActive,
    ...stale.slice(0, Math.min(staleLimit, remaining)),
  ];
}
