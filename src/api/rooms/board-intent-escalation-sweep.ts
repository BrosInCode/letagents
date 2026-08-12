import { getAgentPrimaryLabel } from "../../shared/agent-identity.js";
import type { BoardIntent, BoardManagerMode, Task } from "../db.js";
import type { EscalationCandidateBoardIntent } from "../db/coordination/board-intents.js";

/** How long an intent may sit pending with no reachable manager before the room reacts. */
export const INTENT_ESCALATION_AFTER_MS = 10 * 60 * 1000;

/** Auto-approvals granted to one proposer per room in this trailing window. */
export const INTENT_AUTO_APPROVE_WINDOW_MS = 60 * 60 * 1000;
export const INTENT_AUTO_APPROVE_MAX_PER_WINDOW = 5;

export type IntentEscalationAction = "auto_approve" | "notify_humans";

/**
 * Only task_create in manager_optional mode may self-approve: created tasks
 * still need a claim, a review, and a merge gate, so the blast radius is a
 * board entry. Closures, lease actions, overrides, and anything in
 * intent_required (an explicit human gate) always go to humans.
 */
export function selectIntentEscalationAction(input: {
  intent: Pick<BoardIntent, "action_type">;
  manager_mode: BoardManagerMode;
  auto_approvals_in_window: number;
}): IntentEscalationAction {
  if (input.manager_mode !== "manager_optional") {
    return "notify_humans";
  }
  if (input.intent.action_type !== "task_create") {
    return "notify_humans";
  }
  if (input.auto_approvals_in_window >= INTENT_AUTO_APPROVE_MAX_PER_WINDOW) {
    return "notify_humans";
  }
  return "auto_approve";
}

function proposerLabel(intent: Pick<BoardIntent, "proposer_actor_label">): string {
  return intent.proposer_actor_label
    ? getAgentPrimaryLabel(intent.proposer_actor_label) || intent.proposer_actor_label
    : "an agent";
}

function intentTitle(intent: Pick<BoardIntent, "payload">): string | null {
  const title = (intent.payload as { title?: unknown } | null)?.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

export function buildAutoApproveAnnouncementText(input: {
  intent: Pick<BoardIntent, "proposer_actor_label" | "payload">;
  waited_for_ms: number;
}): string {
  const minutes = Math.max(1, Math.floor(input.waited_for_ms / 60_000));
  const title = intentTitle(input.intent);
  const titled = title ? ` "${title}"` : " it";
  return `[status] No Board Manager responded for ${minutes}m — auto-approving the task-create intent from ${proposerLabel(input.intent)}:${titled} is now an accepted task on the board and needs a claimant.`;
}

export function buildHumanEscalationText(input: {
  intent: Pick<BoardIntent, "proposer_actor_label" | "action_type" | "payload">;
  manager_mode: BoardManagerMode;
  waited_for_ms: number;
  rate_capped: boolean;
}): string {
  const minutes = Math.max(1, Math.floor(input.waited_for_ms / 60_000));
  const title = intentTitle(input.intent);
  const titled = title ? ` ("${title}")` : "";
  const base = `[status] A ${input.intent.action_type} board intent from ${proposerLabel(input.intent)}${titled} has waited ${minutes}m with no Board Manager available. A room admin needs to approve or deny it under Board Manager > Intents.`;
  if (input.rate_capped) {
    return `${base} Auto-approval is paused for this agent (rate cap reached).`;
  }
  if (input.manager_mode === "intent_required") {
    return `${base} This room requires intent approval, so nothing proceeds until a human decides.`;
  }
  return base;
}

export interface IntentEscalationSweeperDeps {
  listCandidates(input: { now?: number; limit?: number }): Promise<EscalationCandidateBoardIntent[]>;
  rescheduleCandidate?(input: { intent_id: string; claimed_check_at: string; next_check_at: string | null }): Promise<void>;
  /** True when the room has an active Board Manager whose session is currently reachable. */
  hasReachableManager(roomId: string): Promise<boolean>;
  getReachableManagerRoomIds?(roomIds: readonly string[]): Promise<ReadonlySet<string>>;
  countRecentAutoApprovals(input: {
    room_id: string;
    proposer_actor_key: string;
    windowMs: number;
  }): Promise<number>;
  /**
   * Post the auto-approval announcement AND (escalation fence + intent
   * approval + task creation) in one transaction, deduped on
   * client_message_id. Null when the fence loses or approval no longer
   * applies — the message must not exist in that case either.
   */
  autoApproveIntent(input: {
    room_id: string;
    intent_id: string;
    proposer_actor_key: string;
    text: string;
    client_message_id: string;
  }): Promise<Task | null>;
  /** Post the human-escalation announcement AND the escalation fence in one transaction. */
  notifyHumans(input: {
    room_id: string;
    intent_id: string;
    text: string;
    client_message_id: string;
  }): Promise<boolean>;
  now?(): number;
  onError?(roomId: string, error: unknown): void;
}

export interface IntentEscalationSweepSummary {
  auto_approved: number;
  notified: number;
  rooms_with_errors: number;
}

export function createIntentEscalationSweeper(deps: IntentEscalationSweeperDeps) {
  async function sweepIntent(
    entry: EscalationCandidateBoardIntent,
    now: number,
    managerReachableByRoom: Map<string, boolean>,
    summary: IntentEscalationSweepSummary
  ): Promise<void> {
    const intent = entry.intent;
    const roomId = intent.room_id;

    let managerReachable = managerReachableByRoom.get(roomId);
    if (managerReachable === undefined) {
      managerReachable = await deps.hasReachableManager(roomId);
      managerReachableByRoom.set(roomId, managerReachable);
    }
    if (managerReachable) {
      // A live manager owns the decision; escalation is only for vacancies.
      if (entry.claimed_check_at) await deps.rescheduleCandidate?.({
        intent_id: intent.id,
        claimed_check_at: entry.claimed_check_at,
        next_check_at: new Date(now + INTENT_ESCALATION_AFTER_MS).toISOString(),
      });
      return;
    }

    const createdAt = Date.parse(intent.created_at);
    const waitedForMs = Number.isFinite(createdAt) ? now - createdAt : INTENT_ESCALATION_AFTER_MS;

    const autoApprovalsInWindow = intent.proposer_actor_key
      ? await deps.countRecentAutoApprovals({
        room_id: roomId,
        proposer_actor_key: intent.proposer_actor_key,
        windowMs: INTENT_AUTO_APPROVE_WINDOW_MS,
      })
      : INTENT_AUTO_APPROVE_MAX_PER_WINDOW; // anonymous proposers never self-approve

    const action = selectIntentEscalationAction({
      intent,
      manager_mode: entry.manager_mode,
      auto_approvals_in_window: autoApprovalsInWindow,
    });

    if (action === "auto_approve") {
      const task = await deps.autoApproveIntent({
        room_id: roomId,
        intent_id: intent.id,
        // The anonymous-proposer gate above guarantees this is set.
        proposer_actor_key: intent.proposer_actor_key ?? "",
        text: buildAutoApproveAnnouncementText({ intent, waited_for_ms: waitedForMs }),
        client_message_id: `board_intent_escalation:${intent.id}`,
      });
      if (task) {
        summary.auto_approved += 1;
      }
      return;
    }

    const notified = await deps.notifyHumans({
      room_id: roomId,
      intent_id: intent.id,
      text: buildHumanEscalationText({
        intent,
        manager_mode: entry.manager_mode,
        waited_for_ms: waitedForMs,
        rate_capped:
          entry.manager_mode === "manager_optional"
          && intent.action_type === "task_create"
          && autoApprovalsInWindow >= INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
      }),
      client_message_id: `board_intent_escalation:${intent.id}`,
    });
    if (notified) {
      summary.notified += 1;
    }
  }

  async function sweepOnce(): Promise<IntentEscalationSweepSummary> {
    const now = deps.now?.() ?? Date.now();
    const summary: IntentEscalationSweepSummary = {
      auto_approved: 0,
      notified: 0,
      rooms_with_errors: 0,
    };

    const candidates = await deps.listCandidates({
      now,
      limit: 100,
    });
    const candidateRoomIds = [...new Set(candidates.map((entry) => entry.intent.room_id))];
    const reachableManagerRooms = deps.getReachableManagerRoomIds
      ? await deps.getReachableManagerRoomIds(candidateRoomIds)
      : null;
    const managerReachableByRoom = new Map<string, boolean>();
    if (reachableManagerRooms) {
      for (const roomId of candidateRoomIds) managerReachableByRoom.set(roomId, reachableManagerRooms.has(roomId));
    }
    const roomsWithErrors = new Set<string>();
    for (const entry of candidates) {
      try {
        await sweepIntent(entry, now, managerReachableByRoom, summary);
      } catch (error) {
        roomsWithErrors.add(entry.intent.room_id);
        deps.onError?.(entry.intent.room_id, error);
      }
    }
    summary.rooms_with_errors = roomsWithErrors.size;

    return summary;
  }

  return { sweepOnce };
}
