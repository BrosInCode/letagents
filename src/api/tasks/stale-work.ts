import type { StaleTaskPromptMute, Task } from "../db.js";

/**
 * Stale-task state shown on boards. The automatic "[status] Stale work
 * detected" room prompts that used to ask an idle agent to pick up unassigned,
 * in-review, or blocked tasks were removed: agents act on work assigned to
 * them and on messages addressed to them, so the server no longer nudges
 * them toward open tasks. Mutes stay honored for the state badges.
 */
export type StaleTaskReason =
  | "accepted_unclaimed"
  | "in_review_no_follow_up"
  | "blocked_no_follow_up";

export const STALE_TASK_THRESHOLD_MS: Record<StaleTaskReason, number> = {
  accepted_unclaimed: 15 * 60 * 1000,
  in_review_no_follow_up: 30 * 60 * 1000,
  blocked_no_follow_up: 30 * 60 * 1000,
};

function getStaleTaskReason(task: Task, now: number): { reason: StaleTaskReason; stale_for_ms: number } | null {
  const updatedAt = Date.parse(task.updated_at);
  if (!Number.isFinite(updatedAt)) {
    return null;
  }

  const staleForMs = now - updatedAt;
  if (staleForMs < 0) {
    return null;
  }

  if (task.status === "accepted" && !task.assignee) {
    return staleForMs >= STALE_TASK_THRESHOLD_MS.accepted_unclaimed
      ? { reason: "accepted_unclaimed", stale_for_ms: staleForMs }
      : null;
  }

  if (task.status === "in_review") {
    return staleForMs >= STALE_TASK_THRESHOLD_MS.in_review_no_follow_up
      ? { reason: "in_review_no_follow_up", stale_for_ms: staleForMs }
      : null;
  }

  if (task.status === "blocked") {
    return staleForMs >= STALE_TASK_THRESHOLD_MS.blocked_no_follow_up
      ? { reason: "blocked_no_follow_up", stale_for_ms: staleForMs }
      : null;
  }

  return null;
}

export function isStaleTaskPromptMuted(
  task: Pick<Task, "updated_at">,
  mute: Pick<StaleTaskPromptMute, "task_updated_at"> | null | undefined
): boolean {
  return Boolean(mute && mute.task_updated_at === task.updated_at);
}

export function getTaskStalePromptState(input: {
  task: Task;
  mute?: StaleTaskPromptMute | null;
  now?: number;
}): NonNullable<Task["stale_prompt_state"]> {
  const stale = getStaleTaskReason(input.task, input.now ?? Date.now());
  const muted = isStaleTaskPromptMuted(input.task, input.mute);

  return {
    is_stale: Boolean(stale),
    reason: stale?.reason ?? null,
    stale_for_ms: stale?.stale_for_ms ?? null,
    muted,
    muted_by: muted ? input.mute?.muted_by ?? null : null,
    muted_at: muted ? input.mute?.updated_at ?? input.mute?.created_at ?? null : null,
  };
}
