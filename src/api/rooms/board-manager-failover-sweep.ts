import { getAgentPrimaryLabel } from "../../shared/agent-identity.js";
import type { BoardManagerFailoverMode } from "../../shared/board-manager-failover.js";
import type {
  ActiveBoardManagerAssignmentCandidate,
  BoardManagerAssignment,
  BoardManagerCandidate,
  LivenessAnnouncementCandidate,
} from "../db.js";
import {
  getRoomAgentDeliverySessionLastSeenAt,
  isRoomAgentDeliverySessionReachable,
} from "../db/presence/helpers.js";

/**
 * How long the active Board Manager's worker session must be unreachable
 * before the room reacts. Longer than the worker offline-announce threshold
 * so the plain "X appears to be offline" line (which already flags the
 * Board Manager role) lands first.
 */
export const MANAGER_FAILOVER_AFTER_MS = 5 * 60 * 1000;

/**
 * Announce mode posts ONE message per outage epoch — the client_message_id
 * dedupes any replay at the messages table. This in-memory cooldown exists
 * only to space out the redundant deduped re-attempts (a SELECT per sweep),
 * not to re-announce: after a restart the message key still wins.
 */
export const MANAGER_OFFLINE_REATTEMPT_COOLDOWN_MS = 30 * 60 * 1000;

export interface BoardManagerDeathVerdict {
  dead: boolean;
  /** Stable id for the outage: the disconnect epoch or the session end. */
  epoch: string | null;
}

/**
 * A manager is dead when its worker session ended without releasing the role,
 * or when its delivery session has been unreachable past the threshold. A
 * manager with no delivery row at all is treated as alive: there is no
 * evidence either way, and failover on missing data would be guessing.
 */
export function evaluateBoardManagerDeath(input: {
  assignment_created_at: string;
  agent_session_ended_at: string | null;
  delivery: LivenessAnnouncementCandidate | null;
  now?: number;
}): BoardManagerDeathVerdict {
  const now = input.now ?? Date.now();

  if (input.agent_session_ended_at) {
    return { dead: true, epoch: input.agent_session_ended_at };
  }

  const session = input.delivery?.session;
  if (!session) {
    return { dead: false, epoch: null };
  }

  if (isRoomAgentDeliverySessionReachable(session, now)) {
    return { dead: false, epoch: null };
  }

  // Anchor the outage to the assignment: delivery evidence predating the
  // assignment must not count against it, so a freshly assigned manager
  // always gets the full threshold before being deposed.
  const lastSeenAt = Date.parse(getRoomAgentDeliverySessionLastSeenAt(session));
  const assignedAt = Date.parse(input.assignment_created_at);
  const outageAnchor = Number.isFinite(assignedAt)
    ? Math.max(lastSeenAt, assignedAt)
    : lastSeenAt;
  if (!Number.isFinite(outageAnchor) || now - outageAnchor < MANAGER_FAILOVER_AFTER_MS) {
    return { dead: false, epoch: null };
  }

  return { dead: true, epoch: session.last_disconnected_at ?? session.updated_at };
}

export function buildManagerOfflineAnnouncementText(input: {
  assignment: Pick<BoardManagerAssignment, "actor_label">;
  suggested_candidate: Pick<BoardManagerCandidate, "actor_label"> | null;
}): string {
  const label = getAgentPrimaryLabel(input.assignment.actor_label) || input.assignment.actor_label;
  const base = `[status] Board Manager ${label} appears to be offline — intent approvals and agent task creation are stalled. A room admin can approve pending intents or reassign the role.`;
  if (!input.suggested_candidate) {
    return base;
  }

  const candidateLabel =
    getAgentPrimaryLabel(input.suggested_candidate.actor_label) || input.suggested_candidate.actor_label;
  return `${base} ${candidateLabel} is the most recently active worker if a replacement is needed.`;
}

export function buildManagerFailoverAnnouncementText(input: {
  assignment: Pick<BoardManagerAssignment, "actor_label">;
  successor: Pick<BoardManagerCandidate, "actor_label">;
}): string {
  const deadLabel = getAgentPrimaryLabel(input.assignment.actor_label) || input.assignment.actor_label;
  const successorLabel = getAgentPrimaryLabel(input.successor.actor_label) || input.successor.actor_label;
  return `[status] Board Manager ${deadLabel} appears to be offline. ${successorLabel} has been promoted to Board Manager automatically so intent approvals and task creation keep moving (room setting manager_failover=auto).`;
}

export function buildPendingIntentsHandoffText(input: {
  successor: Pick<BoardManagerAssignment, "actor_label">;
  pending_count: number;
}): string {
  const successorLabel = getAgentPrimaryLabel(input.successor.actor_label) || input.successor.actor_label;
  const plural = input.pending_count === 1 ? "board intent awaits" : "board intents await";
  return `[status] ${input.pending_count} pending ${plural} review by the new Board Manager ${successorLabel}. ${successorLabel}, please run list_board_intents and decide them.`;
}

export interface BoardManagerFailoverResult {
  released: BoardManagerAssignment;
  promoted: BoardManagerAssignment;
}

export interface BoardManagerFailoverSweeperDeps {
  listActiveManagerAssignments(): Promise<ActiveBoardManagerAssignmentCandidate[]>;
  getManagerFailoverMode(roomId: string): Promise<BoardManagerFailoverMode>;
  getDeliveryCandidate(input: {
    room_id: string;
    delivery_key: string;
  }): Promise<LivenessAnnouncementCandidate | null>;
  listManagerCandidates(
    roomId: string,
    activeManager: BoardManagerAssignment
  ): Promise<BoardManagerCandidate[]>;
  /**
   * "live" = an open connection with a fresh heartbeat; "grace" = reachable
   * only through the reconnect grace window; "none" = unreachable.
   */
  getCandidateConnectionState(
    roomId: string,
    agentSessionId: string
  ): Promise<"live" | "grace" | "none">;
  /** Plain idempotent announcement (announce mode). */
  announceManagerOffline(input: {
    room_id: string;
    text: string;
    client_message_id: string;
  }): Promise<void>;
  /**
   * Post the failover announcement AND perform the fenced release + promotion
   * in the announcement's transaction. Returns null when the fence loses (a
   * concurrent sweeper or a human reassignment got there first) — the message
   * must not exist in that case either.
   */
  announceFailover(input: {
    room_id: string;
    text: string;
    client_message_id: string;
    dead_assignment_id: string;
    successor_agent_session_id: string;
  }): Promise<BoardManagerFailoverResult | null>;
  countPendingIntents(roomId: string): Promise<number>;
  announcePendingIntents(input: {
    room_id: string;
    text: string;
    client_message_id: string;
  }): Promise<void>;
  recordFailoverEvents(input: {
    room_id: string;
    result: BoardManagerFailoverResult;
  }): Promise<void>;
  now?(): number;
  onError?(roomId: string, error: unknown): void;
}

export interface BoardManagerFailoverSweepSummary {
  announced_offline: number;
  failovers: number;
  rooms_with_errors: number;
}

export function createBoardManagerFailoverSweeper(deps: BoardManagerFailoverSweeperDeps) {
  const offlineAnnouncementTimestamps = new Map<string, number>();

  function pruneAnnouncementTimestamps(now: number): void {
    for (const [key, timestamp] of offlineAnnouncementTimestamps) {
      if (now - timestamp > MANAGER_OFFLINE_REATTEMPT_COOLDOWN_MS) {
        offlineAnnouncementTimestamps.delete(key);
      }
    }
  }

  async function pickSuccessor(
    roomId: string,
    assignment: BoardManagerAssignment
  ): Promise<BoardManagerCandidate | null> {
    // Prefer candidates with a live connection; fall back to grace-window
    // ones only when nobody is solidly online, so a worker that dropped
    // seconds ago does not outrank a stably connected peer and cause an
    // immediate second failover.
    const candidates = await deps.listManagerCandidates(roomId, assignment);
    let graceFallback: BoardManagerCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.agent_session_id === assignment.agent_session_id) {
        continue;
      }
      const state = await deps.getCandidateConnectionState(roomId, candidate.agent_session_id);
      if (state === "live") {
        return candidate;
      }
      if (state === "grace" && !graceFallback) {
        graceFallback = candidate;
      }
    }
    return graceFallback;
  }

  async function announceOfflineOnly(
    roomId: string,
    assignment: BoardManagerAssignment,
    epoch: string | null,
    suggestedCandidate: BoardManagerCandidate | null,
    now: number,
    summary: BoardManagerFailoverSweepSummary
  ): Promise<void> {
    pruneAnnouncementTimestamps(now);
    const cooldownKey = `${roomId}:${assignment.id}:${epoch ?? ""}`;
    const lastAnnouncedAt = offlineAnnouncementTimestamps.get(cooldownKey);
    if (lastAnnouncedAt && now - lastAnnouncedAt < MANAGER_OFFLINE_REATTEMPT_COOLDOWN_MS) {
      return;
    }

    await deps.announceManagerOffline({
      room_id: roomId,
      text: buildManagerOfflineAnnouncementText({
        assignment,
        suggested_candidate: suggestedCandidate,
      }),
      client_message_id: `board_manager_offline:${assignment.id}:${epoch ?? ""}`,
    });
    offlineAnnouncementTimestamps.set(cooldownKey, now);
    summary.announced_offline += 1;
  }

  async function sweepAssignment(
    entry: ActiveBoardManagerAssignmentCandidate,
    now: number,
    summary: BoardManagerFailoverSweepSummary
  ): Promise<void> {
    const assignment = entry.assignment;
    const roomId = assignment.room_id;

    const mode = await deps.getManagerFailoverMode(roomId);
    if (mode === "off") {
      return;
    }

    const delivery = await deps.getDeliveryCandidate({
      room_id: roomId,
      delivery_key: `agent_session:${assignment.agent_session_id}`,
    });
    const verdict = evaluateBoardManagerDeath({
      assignment_created_at: assignment.created_at,
      agent_session_ended_at: entry.agent_session_ended_at,
      delivery,
      now,
    });
    if (!verdict.dead) {
      return;
    }

    const successor = await pickSuccessor(roomId, assignment);

    if (mode === "announce" || !successor) {
      // Auto mode with nobody reachable degrades to announcing, so the room
      // still hears about the vacancy instead of silently waiting.
      await announceOfflineOnly(roomId, assignment, verdict.epoch, successor, now, summary);
      return;
    }

    const result = await deps.announceFailover({
      room_id: roomId,
      text: buildManagerFailoverAnnouncementText({ assignment, successor }),
      client_message_id: `board_manager_failover:${assignment.id}`,
      dead_assignment_id: assignment.id,
      successor_agent_session_id: successor.agent_session_id,
    });
    if (!result) {
      return;
    }

    summary.failovers += 1;
    await deps.recordFailoverEvents({ room_id: roomId, result });

    const pendingCount = await deps.countPendingIntents(roomId);
    if (pendingCount > 0) {
      await deps.announcePendingIntents({
        room_id: roomId,
        text: buildPendingIntentsHandoffText({
          successor: result.promoted,
          pending_count: pendingCount,
        }),
        client_message_id: `board_manager_failover:${assignment.id}:intents`,
      });
    }
  }

  async function sweepOnce(): Promise<BoardManagerFailoverSweepSummary> {
    const now = deps.now?.() ?? Date.now();
    const summary: BoardManagerFailoverSweepSummary = {
      announced_offline: 0,
      failovers: 0,
      rooms_with_errors: 0,
    };

    const assignments = await deps.listActiveManagerAssignments();
    for (const entry of assignments) {
      try {
        await sweepAssignment(entry, now, summary);
      } catch (error) {
        summary.rooms_with_errors += 1;
        deps.onError?.(entry.assignment.room_id, error);
      }
    }

    return summary;
  }

  return { sweepOnce };
}
