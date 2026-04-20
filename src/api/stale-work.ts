import type { Message, RoomAgentPresence, Task } from "./db.js";
import { getAgentPrimaryLabel } from "../shared/agent-identity.js";

export type StaleTaskReason =
  | "accepted_unclaimed"
  | "in_review_no_follow_up"
  | "blocked_no_follow_up";

export interface StaleTaskAutoPrompt {
  task: Task;
  idle_agent: RoomAgentPresence;
  reason: StaleTaskReason;
  stale_for_ms: number;
  prompt_text: string;
  cache_key: string;
}

export const STALE_TASK_THRESHOLD_MS: Record<StaleTaskReason, number> = {
  accepted_unclaimed: 15 * 60 * 1000,
  in_review_no_follow_up: 30 * 60 * 1000,
  blocked_no_follow_up: 30 * 60 * 1000,
};

export const STALE_WORK_PROMPT_COOLDOWN_MS = 15 * 60 * 1000;

export interface StaleWorkPromptEmitterDeps {
  getOpenTasks(
    projectId: string,
    options: { limit: number }
  ): Promise<{ tasks: Task[] }>;
  getRoomAgentPresence(
    projectId: string,
    options: { limit: number }
  ): Promise<RoomAgentPresence[]>;
  emitTaskAnchoredMessage(
    projectId: string,
    sender: string,
    text: string,
    task: { id: string; title: string },
    options: {
      agent_prompt_kind: "auto";
      parent_activity: string;
      parent_event_kind: "all_activity";
    }
  ): Promise<Message>;
  now?(): number;
}

function formatStaleDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

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

function getReasonPriority(reason: StaleTaskReason): number {
  switch (reason) {
    case "accepted_unclaimed":
      return 0;
    case "in_review_no_follow_up":
      return 1;
    case "blocked_no_follow_up":
      return 2;
  }
}

function buildPromptText(
  task: Task,
  idleAgent: RoomAgentPresence,
  reason: StaleTaskReason,
  staleForMs: number
): string {
  const idleAgentLabel = getAgentPrimaryLabel(idleAgent.actor_label);
  const staleFor = formatStaleDuration(staleForMs);

  switch (reason) {
    case "accepted_unclaimed":
      return `[status] Stale work detected on ${task.id}: ${task.title}. It has been accepted and unclaimed for ${staleFor}. ${idleAgentLabel}, please pick it up if you're available.`;
    case "in_review_no_follow_up":
      return `[status] Stale review detected on ${task.id}: ${task.title}. It has been in review for ${staleFor} with no follow-up. ${idleAgentLabel}, please review it or move it forward if you're available.`;
    case "blocked_no_follow_up":
      return `[status] Stale blocked task detected on ${task.id}: ${task.title}. It has been blocked for ${staleFor} with no follow-up. ${idleAgentLabel}, please help unblock it if you're available.`;
  }
}

function buildPromptCacheKey(task: Task, reason: StaleTaskReason): string {
  return JSON.stringify([task.id, reason, task.updated_at]);
}

export function selectStaleTaskAutoPrompt(input: {
  tasks: Task[];
  presence: RoomAgentPresence[];
  now?: number;
}): StaleTaskAutoPrompt | null {
  const idleAgent = input.presence.find(
    (entry) => entry.freshness === "active" && entry.status === "idle"
  );
  if (!idleAgent) {
    return null;
  }

  const now = input.now ?? Date.now();
  const staleTasks = input.tasks
    .map((task) => {
      const stale = getStaleTaskReason(task, now);
      return stale ? { task, ...stale } : null;
    })
    .filter((value): value is { task: Task; reason: StaleTaskReason; stale_for_ms: number } => Boolean(value))
    .sort((left, right) => {
      const priorityDelta = getReasonPriority(left.reason) - getReasonPriority(right.reason);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return right.stale_for_ms - left.stale_for_ms;
    });

  const selected = staleTasks[0];
  if (!selected) {
    return null;
  }

  return {
    ...selected,
    idle_agent: idleAgent,
    prompt_text: buildPromptText(selected.task, idleAgent, selected.reason, selected.stale_for_ms),
    cache_key: buildPromptCacheKey(selected.task, selected.reason),
  };
}

export function createStaleWorkPromptEmitter(deps: StaleWorkPromptEmitterDeps) {
  const staleWorkPromptTimestamps = new Map<string, number>();

  function pruneStaleWorkPromptTimestamps(now: number): void {
    for (const [key, timestamp] of staleWorkPromptTimestamps) {
      if (now - timestamp > STALE_WORK_PROMPT_COOLDOWN_MS) {
        staleWorkPromptTimestamps.delete(key);
      }
    }
  }

  async function maybeEmitStaleWorkPrompt(projectId: string): Promise<Message | null> {
    const [taskResult, presence] = await Promise.all([
      deps.getOpenTasks(projectId, { limit: 200 }),
      deps.getRoomAgentPresence(projectId, { limit: 50 }),
    ]);

    const now = deps.now?.() ?? Date.now();
    const prompt = selectStaleTaskAutoPrompt({
      tasks: taskResult.tasks,
      presence,
      now,
    });
    if (!prompt) {
      return null;
    }

    pruneStaleWorkPromptTimestamps(now);

    const cacheKey = `${projectId}:${prompt.cache_key}`;
    const lastPromptAt = staleWorkPromptTimestamps.get(cacheKey);
    if (lastPromptAt && now - lastPromptAt < STALE_WORK_PROMPT_COOLDOWN_MS) {
      return null;
    }

    const message = await deps.emitTaskAnchoredMessage(
      projectId,
      "letagents",
      prompt.prompt_text,
      prompt.task,
      {
        agent_prompt_kind: "auto",
        parent_activity: "Stale-work prompt",
        parent_event_kind: "all_activity",
      }
    );
    staleWorkPromptTimestamps.set(cacheKey, now);
    return message;
  }

  return {
    maybeEmitStaleWorkPrompt,
  };
}
