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

/**
 * The disconnect that started the current outage. A session that died
 * without a socket close never got a fresh last_disconnected_at, so its
 * frozen heartbeat write stands in as the epoch.
 */
function getOutageEpochAt(session: RoomAgentDeliverySession): number | null {
  return parseTime(session.last_disconnected_at) ?? parseTime(session.updated_at);
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
        transitions.push({ kind: "recovered", session, offline_for_ms: 0 });
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

    // One announcement per outage epoch: a marker stamped after the epoch
    // means this outage was already announced, while a newer disconnect (or a
    // fresh post-recovery heartbeat that later froze) starts a new epoch.
    const epochAt = getOutageEpochAt(session);
    const alreadyAnnounced =
      offlineAnnouncedAt !== null && epochAt !== null && offlineAnnouncedAt >= epochAt;
    if (alreadyAnnounced) {
      continue;
    }

    transitions.push({ kind: "offline", session, offline_for_ms: offlineForMs });
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

export interface LivenessAnnouncementInput {
  room_id: string;
  delivery_key: string;
  text: string;
  client_message_id: string;
  announced_at: string;
}

export interface LivenessSweeperDeps {
  listCandidates(options: { withinMs: number }): Promise<LivenessAnnouncementCandidate[]>;
  /** Fresh single-row re-read; transitions are revalidated on it just before emitting. */
  getCandidate(input: {
    room_id: string;
    delivery_key: string;
  }): Promise<LivenessAnnouncementCandidate | null>;
  getSuppressedActorLabels(roomId: string): Promise<ReadonlySet<string>>;
  getActiveBoardManagerSessionId(roomId: string): Promise<string | null>;
  /**
   * Post the announcement AND persist its marker atomically (one DB
   * transaction), deduped on client_message_id. Implementations must
   * guarantee that after any failure ordering either both exist or neither.
   */
  announceOffline(input: LivenessAnnouncementInput): Promise<void>;
  announceRecovery(input: LivenessAnnouncementInput): Promise<void>;
  now?(): number;
  onError?(roomId: string, error: unknown): void;
}

export interface LivenessSweepSummary {
  announced_offline: number;
  announced_recovered: number;
  failed_transitions: number;
  rooms_with_errors: number;
}

/**
 * Each announcement commits its room message and its marker in ONE database
 * transaction (deps.announceOffline/announceRecovery), with a deterministic
 * client_message_id deduping replays at the messages table. Any failure or
 * crash therefore leaves either both or neither — never an orphaned message
 * without a marker, and never a silent marker without a message. The
 * transition is revalidated on a fresh row read right before announcing, so
 * a worker that reconnected (or dropped) since selection is skipped rather
 * than announced with stale state.
 */
export function createLivenessSweeper(deps: LivenessSweeperDeps) {
  async function processTransition(
    roomId: string,
    selected: LivenessTransition,
    suppressedActors: ReadonlySet<string>,
    managerSessionId: string | null,
    now: number,
    summary: LivenessSweepSummary
  ): Promise<void> {
    const fresh = await deps.getCandidate({
      room_id: roomId,
      delivery_key: selected.session.delivery_key,
    });
    if (!fresh) {
      return;
    }

    const [transition] = selectLivenessTransitions({
      candidates: [fresh],
      suppressedActors,
      now,
    });
    if (!transition || transition.kind !== selected.kind) {
      return;
    }

    const session = transition.session;
    const announcedAt = new Date(now).toISOString();

    if (transition.kind === "offline") {
      const epoch = session.last_disconnected_at ?? session.updated_at;
      await deps.announceOffline({
        room_id: roomId,
        delivery_key: session.delivery_key,
        text: buildOfflineAnnouncementText({
          session,
          offline_for_ms: transition.offline_for_ms,
          is_board_manager: Boolean(
            managerSessionId && session.agent_session_id === managerSessionId
          ),
        }),
        client_message_id: `agent_liveness:offline:${session.delivery_key}:${epoch}`,
        announced_at: announcedAt,
      });
      summary.announced_offline += 1;
      return;
    }

    await deps.announceRecovery({
      room_id: roomId,
      delivery_key: session.delivery_key,
      text: buildRecoveryAnnouncementText({ session }),
      client_message_id: `agent_liveness:recovered:${session.delivery_key}:${session.offline_announced_at ?? ""}`,
      announced_at: announcedAt,
    });
    summary.announced_recovered += 1;
  }

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
      try {
        await processTransition(roomId, transition, suppressedActors, managerSessionId, now, summary);
      } catch (error) {
        summary.failed_transitions += 1;
        deps.onError?.(roomId, error);
      }
    }
  }

  async function sweepOnce(): Promise<LivenessSweepSummary> {
    const now = deps.now?.() ?? Date.now();
    const summary: LivenessSweepSummary = {
      announced_offline: 0,
      announced_recovered: 0,
      failed_transitions: 0,
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
