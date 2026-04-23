import type { Message, RoomAgentPresence, RoomParticipant } from "./db.js";
import { parseAgentActorLabel } from "../shared/agent-identity.js";
import {
  buildAgentRoomParticipantKey,
  buildHumanRoomParticipantKey,
} from "../shared/room-participant.js";
import {
  buildRoomActivitySourceFlags,
  deriveRoomAgentActivityState,
} from "../shared/room-agent-activity.js";

function normalizeValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function getOwnerLabel(ownerAttribution: string | null | undefined): string | null {
  const normalized = normalizeValue(ownerAttribution);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(.+?)(?:'s|s')?\s+agent$/i);
  return match?.[1]?.trim() || normalized;
}

function isAgentIdentityValue(value: string | null | undefined): boolean {
  const parsed = parseAgentActorLabel(value);
  return Boolean(parsed && (parsed.structured || parsed.owner_attribution || parsed.ide_label));
}

function isHumanMessage(message: Message): boolean {
  const normalizedSource = normalizeValue(message.source).toLowerCase();
  if (normalizedSource === "browser") {
    return true;
  }
  if (normalizedSource === "agent") {
    return false;
  }

  const normalizedSender = normalizeValue(message.sender).toLowerCase();
  if (!normalizedSender || normalizedSender === "letagents" || normalizedSender === "system") {
    return false;
  }

  return !isAgentIdentityValue(message.sender);
}

function compareParticipants(left: RoomParticipant, right: RoomParticipant): number {
  const timeDelta = Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at);
  if (Number.isFinite(timeDelta) && timeDelta !== 0) {
    return timeDelta;
  }

  return left.display_name.localeCompare(right.display_name);
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > bestMs) {
      bestMs = parsed;
      best = value;
    }
  }

  return best;
}

function mergeParticipantActivityState(
  primary: RoomParticipant,
  secondary: RoomParticipant
): RoomParticipant["activity_state"] {
  if (primary.kind !== "agent") {
    return primary.activity_state ?? secondary.activity_state ?? null;
  }

  const hidden = Boolean(primary.hidden_at || secondary.hidden_at);
  if (hidden) {
    return "archived";
  }

  if (primary.activity_state === "active" || secondary.activity_state === "active") {
    return "active";
  }

  if (primary.activity_state === "away" || secondary.activity_state === "away") {
    return "away";
  }

  const hasPresence = Boolean(
    primary.last_live_heartbeat_at
      || secondary.last_live_heartbeat_at
      || primary.source_flags?.includes("presence")
      || secondary.source_flags?.includes("presence")
  );

  return deriveRoomAgentActivityState({
    hidden: false,
    hasPresence,
    freshness: hasPresence ? "stale" : null,
    status: null,
  });
}

export function buildFallbackRoomParticipants(input: {
  roomId: string;
  messages: readonly Message[];
  presence: readonly RoomAgentPresence[];
}): RoomParticipant[] {
  const participants = new Map<string, RoomParticipant>();

  const upsertParticipant = (next: RoomParticipant) => {
    const existing = participants.get(next.participant_key);
    if (!existing) {
      participants.set(next.participant_key, next);
      return;
    }

    const existingSeenAt = Date.parse(existing.last_seen_at);
    const nextSeenAt = Date.parse(next.last_seen_at);
    const useNextAsPrimary = Number.isFinite(nextSeenAt) && nextSeenAt >= existingSeenAt;
    const primary = useNextAsPrimary ? next : existing;
    const secondary = useNextAsPrimary ? existing : next;

    participants.set(next.participant_key, {
      ...secondary,
      ...primary,
      actor_label: primary.actor_label ?? secondary.actor_label,
      agent_key: primary.agent_key ?? secondary.agent_key,
      github_login: primary.github_login ?? secondary.github_login,
      owner_label: primary.owner_label ?? secondary.owner_label,
      ide_label: primary.ide_label ?? secondary.ide_label,
      last_room_activity_at: latestTimestamp(
        primary.last_room_activity_at,
        secondary.last_room_activity_at,
        primary.last_seen_at,
        secondary.last_seen_at
      ),
      last_live_heartbeat_at: latestTimestamp(
        primary.last_live_heartbeat_at,
        secondary.last_live_heartbeat_at
      ),
      activity_state: mergeParticipantActivityState(primary, secondary),
      source_flags: buildRoomActivitySourceFlags([
        ...(secondary.source_flags ?? []),
        ...(primary.source_flags ?? []),
      ]),
      created_at: existing.created_at,
      updated_at: primary.updated_at,
      last_seen_at: primary.last_seen_at,
    });
  };

  for (const entry of input.presence) {
    const participantKey = buildAgentRoomParticipantKey(entry.actor_label);
    if (!participantKey) {
      continue;
    }

    upsertParticipant({
      room_id: input.roomId,
      participant_key: participantKey,
      kind: "agent",
      actor_label: entry.actor_label,
      agent_key: entry.agent_key,
      github_login: null,
      display_name: entry.display_name,
      owner_label: entry.owner_label,
      ide_label: entry.ide_label,
      hidden_at: null,
      hidden_by: null,
      last_seen_at: entry.last_heartbeat_at,
      last_room_activity_at: entry.last_heartbeat_at,
      last_live_heartbeat_at: entry.activity_state === "offline" ? null : entry.last_heartbeat_at,
      activity_state: entry.activity_state,
      source_flags: buildRoomActivitySourceFlags(entry.source_flags),
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    });
  }

  for (const message of input.messages) {
    const sender = normalizeValue(message.sender);
    if (!sender) {
      continue;
    }

    if (isHumanMessage(message)) {
      const participantKey = buildHumanRoomParticipantKey({
        github_login: sender,
        display_name: sender,
      });
      if (!participantKey) {
        continue;
      }

      upsertParticipant({
        room_id: input.roomId,
        participant_key: participantKey,
        kind: "human",
        actor_label: null,
        agent_key: null,
        github_login: sender,
        display_name: sender,
        owner_label: null,
        ide_label: null,
        hidden_at: null,
        hidden_by: null,
        last_seen_at: message.timestamp,
        last_room_activity_at: message.timestamp,
        last_live_heartbeat_at: null,
        activity_state: null,
        source_flags: buildRoomActivitySourceFlags(["messages"]),
        created_at: message.timestamp,
        updated_at: message.timestamp,
      });
      continue;
    }

    if (!isAgentIdentityValue(sender)) {
      continue;
    }

    const participantKey = buildAgentRoomParticipantKey(sender);
    if (!participantKey) {
      continue;
    }

    const parsed = parseAgentActorLabel(sender);
    upsertParticipant({
      room_id: input.roomId,
      participant_key: participantKey,
      kind: "agent",
      actor_label: sender,
      agent_key: null,
      github_login: null,
      display_name: parsed?.display_name || sender,
      owner_label: getOwnerLabel(parsed?.owner_attribution),
      ide_label: parsed?.ide_label ?? null,
      hidden_at: null,
      hidden_by: null,
      last_seen_at: message.timestamp,
      last_room_activity_at: message.timestamp,
      last_live_heartbeat_at: null,
      activity_state: deriveRoomAgentActivityState({
        hidden: false,
        hasPresence: false,
        freshness: null,
        status: null,
      }),
      source_flags: buildRoomActivitySourceFlags(["messages"]),
      created_at: message.timestamp,
      updated_at: message.timestamp,
    });
  }

  return Array.from(participants.values()).sort(compareParticipants);
}
