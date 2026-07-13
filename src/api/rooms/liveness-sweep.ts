import { getAgentPrimaryLabel } from "../../shared/agent-identity.js";
import type { LivenessAnnouncementCandidate } from "../db.js";
import type { RoomAgentDeliverySession } from "../db.js";
import {
  getRoomAgentDeliverySessionLastSeenAt,
  isRoomAgentDeliverySessionReachable,
  normalizeRoomActorLabel,
} from "../db/presence/helpers.js";

/**
 * A worker must be unreachable for this long before the room hears about it.
 * Longer than the 90s delivery freshness window plus the 10s reconnect grace,
 * so ordinary poll rollover never announces.
 */
export const OFFLINE_ANNOUNCE_AFTER_MS = 2 * 60 * 1000;

/**
 * Never announce sessions whose last activity is older than this. Bounds
 * first-deploy noise (pre-existing dead rows) and server downtime backlogs.
 */
export const OFFLINE_ANNOUNCE_MAX_AGE_MS = 60 * 60 * 1000;

export const LIVENESS_SWEEP_INTERVAL_MS = 60 * 1000;

export interface LivenessTransition {
  kind: "offline" | "recovered";
  session: RoomAgentDeliverySession;
  offline_for_ms: number;
  /** Marker value read at selection time; the guarded UPDATE compares against it. */
  expected_marker: string | null;
}

function parseTime(value: string | null | undefined): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatOfflineDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function selectLivenessTransitions(input: {
  candidates: readonly LivenessAnnouncementCandidate[];
  suppressedActors?: ReadonlySet<string>;
  now?: number;
}): LivenessTransition[] {
  const now = input.now ?? Date.now();
  const transitions: LivenessTransition[] = [];

  for (const candidate of input.candidates) {
    const session = candidate.session;
    if (session.session_kind !== "worker") {
      continue;
    }

    // A deliberately ended session is a clean exit, not a death.
    if (candidate.agent_session_ended_at) {
      continue;
    }

    const actorLabel = normalizeRoomActorLabel(session.actor_label);
    if (actorLabel && input.suppressedActors?.has(actorLabel)) {
      continue;
    }

    const reachable = isRoomAgentDeliverySessionReachable(session, now);
    const offlineAnnouncedAt = parseTime(session.offline_announced_at);

    if (reachable) {
      const recoveryAnnouncedAt = parseTime(session.recovery_announced_at);
      const needsRecovery =
        offlineAnnouncedAt !== null &&
        (recoveryAnnouncedAt === null || recoveryAnnouncedAt < offlineAnnouncedAt);
      if (needsRecovery) {
        transitions.push({
          kind: "recovered",
          session,
          offline_for_ms: 0,
          expected_marker: session.recovery_announced_at,
        });
      }
      continue;
    }

    const lastSeenAt = parseTime(getRoomAgentDeliverySessionLastSeenAt(session));
    if (lastSeenAt === null) {
      continue;
    }

    const offlineForMs = now - lastSeenAt;
    if (offlineForMs < OFFLINE_ANNOUNCE_AFTER_MS || offlineForMs > OFFLINE_ANNOUNCE_MAX_AGE_MS) {
      continue;
    }

    // One announcement per disconnect epoch. The epoch is the disconnect that
    // started this outage; a session that died without a socket close falls
    // back to its last heartbeat write.
    const epochAt = parseTime(session.last_disconnected_at) ?? parseTime(session.updated_at);
    const alreadyAnnounced =
      offlineAnnouncedAt !== null && epochAt !== null && offlineAnnouncedAt >= epochAt;
    if (alreadyAnnounced) {
      continue;
    }

    transitions.push({
      kind: "offline",
      session,
      offline_for_ms: offlineForMs,
      expected_marker: session.offline_announced_at,
    });
  }

  return transitions;
}

export function buildOfflineAnnouncementText(input: {
  session: Pick<RoomAgentDeliverySession, "actor_label" | "display_name">;
  offline_for_ms: number;
  is_board_manager: boolean;
}): string {
  const label = getAgentPrimaryLabel(input.session.actor_label) || input.session.display_name;
  const offlineFor = formatOfflineDuration(input.offline_for_ms);
  const base = `[status] ${label} appears to be offline — no active connection for ${offlineFor}. If ${label} owned in-flight work, another agent or a human should pick it up.`;
  if (!input.is_board_manager) {
    return base;
  }

  return `${base} ${label} holds the Board Manager role, so intent approvals and task creation are stalled until it returns or the role is reassigned.`;
}

export function buildRecoveryAnnouncementText(input: {
  session: Pick<RoomAgentDeliverySession, "actor_label" | "display_name">;
}): string {
  const label = getAgentPrimaryLabel(input.session.actor_label) || input.session.display_name;
  return `[status] ${label} is back online and reachable again.`;
}

export interface LivenessSweeperDeps {
  listCandidates(options: { withinMs: number }): Promise<LivenessAnnouncementCandidate[]>;
  getSuppressedActorLabels(roomId: string): Promise<ReadonlySet<string>>;
  getActiveBoardManagerSessionId(roomId: string): Promise<string | null>;
  markAgentOfflineAnnounced(input: {
    room_id: string;
    delivery_key: string;
    expected_offline_announced_at: string | null;
  }): Promise<boolean>;
  markAgentRecoveryAnnounced(input: {
    room_id: string;
    delivery_key: string;
    expected_recovery_announced_at: string | null;
  }): Promise<boolean>;
  emitProjectMessage(
    projectId: string,
    sender: string,
    text: string,
    options?: {
      source?: string;
      agent_prompt_kind?: "auto";
      client_message_id?: string | null;
    }
  ): Promise<unknown>;
  now?(): number;
  onError?(roomId: string, error: unknown): void;
}

export interface LivenessSweepSummary {
  announced_offline: number;
  announced_recovered: number;
  rooms_with_errors: number;
}

export function createLivenessSweeper(deps: LivenessSweeperDeps) {
  async function sweepRoom(
    roomId: string,
    candidates: readonly LivenessAnnouncementCandidate[],
    now: number,
    summary: LivenessSweepSummary
  ): Promise<void> {
    const suppressedActors = await deps.getSuppressedActorLabels(roomId);
    const transitions = selectLivenessTransitions({ candidates, suppressedActors, now });
    if (transitions.length === 0) {
      return;
    }

    const managerSessionId = await deps.getActiveBoardManagerSessionId(roomId);
    for (const transition of transitions) {
      const session = transition.session;
      if (transition.kind === "offline") {
        const claimed = await deps.markAgentOfflineAnnounced({
          room_id: roomId,
          delivery_key: session.delivery_key,
          expected_offline_announced_at: transition.expected_marker,
        });
        if (!claimed) {
          continue;
        }

        await deps.emitProjectMessage(
          roomId,
          "letagents",
          buildOfflineAnnouncementText({
            session,
            offline_for_ms: transition.offline_for_ms,
            is_board_manager: Boolean(
              managerSessionId && session.agent_session_id === managerSessionId
            ),
          }),
          {
            source: "agent_liveness",
            agent_prompt_kind: "auto",
            client_message_id: `agent_liveness:offline:${session.delivery_key}:${session.last_disconnected_at ?? session.updated_at}`,
          }
        );
        summary.announced_offline += 1;
        continue;
      }

      const claimed = await deps.markAgentRecoveryAnnounced({
        room_id: roomId,
        delivery_key: session.delivery_key,
        expected_recovery_announced_at: transition.expected_marker,
      });
      if (!claimed) {
        continue;
      }

      await deps.emitProjectMessage(
        roomId,
        "letagents",
        buildRecoveryAnnouncementText({ session }),
        {
          source: "agent_liveness",
          client_message_id: `agent_liveness:recovered:${session.delivery_key}:${session.offline_announced_at ?? ""}`,
        }
      );
      summary.announced_recovered += 1;
    }
  }

  async function sweepOnce(): Promise<LivenessSweepSummary> {
    const now = deps.now?.() ?? Date.now();
    const summary: LivenessSweepSummary = {
      announced_offline: 0,
      announced_recovered: 0,
      rooms_with_errors: 0,
    };

    const candidates = await deps.listCandidates({ withinMs: OFFLINE_ANNOUNCE_MAX_AGE_MS });
    const candidatesByRoom = new Map<string, LivenessAnnouncementCandidate[]>();
    for (const candidate of candidates) {
      const roomId = candidate.session.room_id;
      const entries = candidatesByRoom.get(roomId);
      if (entries) {
        entries.push(candidate);
      } else {
        candidatesByRoom.set(roomId, [candidate]);
      }
    }

    for (const [roomId, roomCandidates] of candidatesByRoom) {
      try {
        await sweepRoom(roomId, roomCandidates, now, summary);
      } catch (error) {
        summary.rooms_with_errors += 1;
        deps.onError?.(roomId, error);
      }
    }

    return summary;
  }

  return { sweepOnce };
}
