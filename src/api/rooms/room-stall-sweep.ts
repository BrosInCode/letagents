import { getAgentPrimaryLabel } from "../../shared/agent-identity.js";
import type { StalledRoomCandidate } from "../db/coordination/room-stall.js";

/**
 * A board that had work must sit at zero open tasks this long before the
 * room hears about it. Long enough for the natural next-task cadence
 * (review, merge, plan the next slice) to play out on its own.
 */
export const ROOM_STALL_AFTER_MS = 30 * 60 * 1000;

export interface RoomStallVerdict {
  stalled: boolean;
  /** The drain epoch the nudge is fenced on. */
  epoch: string | null;
}

/**
 * One nudge per drain epoch: a board that empties, refills, and empties
 * again gets a fresh epoch (a later last_closed_at) and re-arms. A room
 * with a reachable Board Manager is never nudged — next-task creation is
 * that manager's job, and Phase B replaces it if it dies.
 */
export function evaluateRoomStall(input: {
  candidate: Pick<StalledRoomCandidate, "last_closed_at" | "stall_nudged_at">;
  manager_reachable: boolean;
  live_worker_count: number;
  now?: number;
}): RoomStallVerdict {
  if (input.manager_reachable) {
    return { stalled: false, epoch: null };
  }

  // Nobody to nudge: without a live worker the room needs a human anyway,
  // and the alert would just scroll past an empty audience.
  if (input.live_worker_count === 0) {
    return { stalled: false, epoch: null };
  }

  const lastClosedAt = Date.parse(input.candidate.last_closed_at);
  if (!Number.isFinite(lastClosedAt)) {
    return { stalled: false, epoch: null };
  }

  const now = input.now ?? Date.now();
  if (now - lastClosedAt < ROOM_STALL_AFTER_MS) {
    return { stalled: false, epoch: null };
  }

  const nudgedAt = Date.parse(input.candidate.stall_nudged_at ?? "");
  if (Number.isFinite(nudgedAt) && nudgedAt >= lastClosedAt) {
    return { stalled: false, epoch: null };
  }

  return { stalled: true, epoch: input.candidate.last_closed_at };
}

export function buildRoomStallNudgeText(input: {
  stalled_for_ms: number;
  live_worker_labels: readonly string[];
}): string {
  const minutes = Math.max(1, Math.floor(input.stalled_for_ms / 60_000));
  const names = input.live_worker_labels
    .slice(0, 2)
    .map((label) => getAgentPrimaryLabel(label) || label)
    .join(" and ");
  const audience = names || "any available agent";
  return `[status] The board has been empty for ${minutes}m after active work, and no Board Manager is reachable. ${audience}: if the plan has remaining phases, create the next tasks with register_task_create_intent (they auto-approve when no manager responds within 10m). If the work is genuinely finished, a human should confirm and close the room out.`;
}

export interface RoomStallSweeperDeps {
  listStalledRooms(input: { stalledForMs: number }): Promise<StalledRoomCandidate[]>;
  /** True when the room has an active Board Manager whose session is currently reachable. */
  hasReachableManager(roomId: string): Promise<boolean>;
  /** Actor labels of currently reachable worker agents in the room. */
  listLiveWorkerLabels(roomId: string): Promise<string[]>;
  /** Post the nudge AND the stall fence in one transaction, deduped on client_message_id. */
  announceStall(input: {
    room_id: string;
    epoch: string;
    text: string;
    client_message_id: string;
  }): Promise<boolean>;
  now?(): number;
  onError?(roomId: string, error: unknown): void;
}

export interface RoomStallSweepSummary {
  nudged: number;
  rooms_with_errors: number;
}

export function createRoomStallSweeper(deps: RoomStallSweeperDeps) {
  async function sweepRoom(
    candidate: StalledRoomCandidate,
    now: number,
    summary: RoomStallSweepSummary
  ): Promise<void> {
    const roomId = candidate.room_id;
    const managerReachable = await deps.hasReachableManager(roomId);
    if (managerReachable) {
      return;
    }

    const liveWorkers = await deps.listLiveWorkerLabels(roomId);
    const verdict = evaluateRoomStall({
      candidate,
      manager_reachable: managerReachable,
      live_worker_count: liveWorkers.length,
      now,
    });
    if (!verdict.stalled || !verdict.epoch) {
      return;
    }

    const nudged = await deps.announceStall({
      room_id: roomId,
      epoch: verdict.epoch,
      text: buildRoomStallNudgeText({
        stalled_for_ms: now - Date.parse(verdict.epoch),
        live_worker_labels: liveWorkers,
      }),
      client_message_id: `room_stall:${roomId}:${verdict.epoch}`,
    });
    if (nudged) {
      summary.nudged += 1;
    }
  }

  async function sweepOnce(): Promise<RoomStallSweepSummary> {
    const now = deps.now?.() ?? Date.now();
    const summary: RoomStallSweepSummary = { nudged: 0, rooms_with_errors: 0 };

    const candidates = await deps.listStalledRooms({ stalledForMs: ROOM_STALL_AFTER_MS });
    for (const candidate of candidates) {
      try {
        await sweepRoom(candidate, now, summary);
      } catch (error) {
        summary.rooms_with_errors += 1;
        deps.onError?.(candidate.room_id, error);
      }
    }

    return summary;
  }

  return { sweepOnce };
}
