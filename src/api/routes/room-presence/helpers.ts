import type {
  getMessages,
  RoomAgentPresence,
  RoomParticipant,
} from "../../db.js";
import { buildFallbackRoomParticipants } from "../../rooms/participant-fallback.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { isWithinRecentlyOfflineWindow } from "../../../shared/room-agent-activity.js";
import type { RoomActivityHistoryKind } from "../../rooms/activity-history.js";

export function toPublicRoomAgentPresence(presence: RoomAgentPresence): RoomAgentPresence {
  return {
    ...presence,
  };
}

export function toPublicRoomParticipant(participant: RoomParticipant): RoomParticipant {
  return {
    ...participant,
  };
}

export function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeHistoryKind(value: unknown): RoomActivityHistoryKind {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "agent" || normalized === "human" ? normalized : "all";
}

export function normalizeHistoryRoomId(value: unknown): string | null {
  const normalized = normalizeRoomId(String(value ?? "").trim());
  return normalized || null;
}

export function normalizeActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function normalizeRuntime(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || "unknown";
}

export function normalizeOptionalText(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function normalizeRegistrationLiveness(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Record<string, unknown>;
  return {
    host_id: normalizeOptionalText(input.host_id),
    host_kind: normalizeOptionalText(input.host_kind),
    host_label: normalizeOptionalText(input.host_label),
    liveness_capability: normalizeOptionalText(input.liveness_capability),
    tool_bridge_id: normalizeOptionalText(input.tool_bridge_id),
  };
}

export function isActiveWorkerActorLabelConflict(error: unknown): boolean {
  const cause = typeof error === "object" && error !== null && "cause" in error
    ? (error as { cause?: unknown }).cause
    : error;
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? (cause as { code?: unknown }).code
    : null;
  const constraint = typeof cause === "object" && cause !== null && "constraint" in cause
    ? (cause as { constraint?: unknown }).constraint
    : null;

  return code === "23505" && constraint === "room_agent_sessions_active_worker_actor_label_idx";
}

export function buildRoomActivityHistoryParticipants(input: {
  roomId: string;
  storedParticipants: readonly RoomParticipant[];
  presence: readonly RoomAgentPresence[];
  fallbackMessages?: Awaited<ReturnType<typeof getMessages>>["messages"];
}): RoomParticipant[] {
  const participantsByKey = new Map<string, RoomParticipant>();
  for (const participant of input.storedParticipants) {
    participantsByKey.set(participant.participant_key, participant);
  }

  const fallbackParticipants = buildFallbackRoomParticipants({
    roomId: input.roomId,
    messages: input.fallbackMessages ?? [],
    presence: input.presence,
  });
  for (const participant of fallbackParticipants) {
    if (!participantsByKey.has(participant.participant_key)) {
      participantsByKey.set(participant.participant_key, participant);
    }
  }

  return Array.from(participantsByKey.values());
}

export function isSuppressibleDisconnectedPresence(
  entry: RoomAgentPresence,
  now = Date.now()
): boolean {
  return entry.session_kind === "worker"
    && entry.source_flags.includes("delivery")
    && entry.freshness !== "active"
    && isWithinRecentlyOfflineWindow(entry.last_heartbeat_at, now);
}
