import type { EventEmitter } from "node:events";

import {
  WAKE_NOTICE_SOURCE,
  formatWakeNotice,
} from "../../../shared/wake-rules.mjs";
import {
  getActiveGitHubWakeRulesConcerning,
  getActiveTaskWakeRules,
  getDueWakeRules,
  getNextWakeRuleCheckAt,
  recordWakeRuleFiredTx,
  scheduleWakeRuleCheck,
  wakeRuleEvaluationDeps,
  type WakeRuleRow,
} from "../db/wake-rules.js";
import { emitProjectMessage, queueWakeRuleInvalidation } from "../server/events.js";
import { evaluateWakeRule, type WakeRuleEvaluation, type WakeRuleEvaluationDeps } from "./evaluate.js";

/** The longest the scheduler sleeps without looking at the next deadline. */
const MAX_IDLE_MS = 60_000;
/** Never re-arm tighter than this, whatever a clock or a backlog says. */
const MIN_REARM_MS = 1_000;
/** When the database could not be read, look again soon. */
const RETRY_AFTER_FAILURE_MS = 5_000;
/** A rule whose check failed waits this long before the next try. */
const RULE_FAILURE_BACKOFF_MS = 30_000;

class WakeRuleFenceLost extends Error {}

/**
 * Wake the agent: one room message addressed to it, committed together with
 * the rule's new state. Returns false when another instance already did.
 */
export async function deliverWakeRule(
  rule: WakeRuleRow,
  evaluation: Extract<WakeRuleEvaluation, { kind: "fire" | "expire" }>,
  now = new Date(),
): Promise<boolean> {
  const outcome = evaluation.kind === "fire" ? "fired" : "expired";
  const facts = evaluation.kind === "fire" ? evaluation.facts : {};
  const notice = formatWakeNotice({
    rule: { ...rule, expires_at: new Date(rule.expires_at).toISOString() },
    outcome,
    facts,
    agentName: rule.agent_name,
  });
  try {
    await emitProjectMessage(rule.room_id, "letagents", notice.text, {
      source: WAKE_NOTICE_SOURCE,
      display_text: notice.display_text,
      // One message per wake: a second instance racing on the same wake
      // replays this message instead of creating another.
      client_message_id: `wake_rule:${rule.id}:${rule.fire_count + 1}`,
      addressed_to: { agent_key: rule.agent_key, reason: "wake_rule" },
      with_created_message_in_transaction: async (tx, message) => {
        const recorded = await recordWakeRuleFiredTx(tx, rule, {
          outcome,
          messageNumber: message.number,
          cursorAt: evaluation.kind === "fire" ? evaluation.cursorAt : now.toISOString(),
          baseline: evaluation.kind === "fire" ? evaluation.baseline : rule.baseline,
          now: now.toISOString(),
        });
        if (!recorded) throw new WakeRuleFenceLost();
      },
    });
  } catch (error) {
    if (error instanceof WakeRuleFenceLost) return false;
    throw error;
  }
  queueWakeRuleInvalidation(rule.room_id);
  return true;
}

export async function checkWakeRules(
  rules: readonly WakeRuleRow[],
  now = new Date(),
  deps: WakeRuleEvaluationDeps = wakeRuleEvaluationDeps,
): Promise<void> {
  for (const rule of rules) {
    try {
      const evaluation = await evaluateWakeRule(rule, now, deps);
      if (evaluation.kind === "wait") await scheduleWakeRuleCheck(rule, evaluation.nextCheckAt, { cursorAt: evaluation.cursorAt });
      else await deliverWakeRule(rule, evaluation, now);
    } catch (error) {
      console.error(`[wake rules] check failed for ${rule.id}`, error);
      // Push a failing rule back so it neither spins nor crowds out the others.
      await scheduleWakeRuleCheck(rule, new Date(now.getTime() + RULE_FAILURE_BACKOFF_MS).toISOString(), { capAtExpiry: false })
        .catch(() => undefined);
    }
  }
}

export interface WakeRuleSchedulerSources {
  taskEvents: EventEmitter;
  githubRoomEvents: EventEmitter;
  wakeRuleEvents: EventEmitter;
}

/**
 * Checks rules when something they wait on changes: a task update, a GitHub
 * event, or a new rule. Between changes it sleeps until the next deadline
 * (a timer, a settling CI run, an expiry), never longer than a minute, so a
 * rule created on another instance is picked up promptly. A failed pass
 * still re-arms: the loop outlives a database blip.
 */
export function startWakeRuleScheduler(sources: WakeRuleSchedulerSources): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pass: Promise<void> = Promise.resolve();
  let duePending = false;
  const pendingChecks = new Set<string>();

  const runSerially = (work: () => Promise<void>): Promise<void> => {
    pass = pass.then(work).catch((error) => {
      console.error("[wake rules] scheduler pass failed", error);
    });
    return pass;
  };

  /** One queued check per key: a burst of events for a room is one pass. */
  const checkOnce = (key: string, work: () => Promise<void>): void => {
    if (stopped || pendingChecks.has(key)) return;
    pendingChecks.add(key);
    void runSerially(async () => {
      pendingChecks.delete(key);
      await work();
    });
  };

  async function arm(): Promise<void> {
    if (stopped) return;
    clearTimeout(timer);
    let delay = RETRY_AFTER_FAILURE_MS;
    try {
      const next = await getNextWakeRuleCheckAt();
      delay = next ? Math.min(Math.max(Date.parse(next) - Date.now(), MIN_REARM_MS), MAX_IDLE_MS) : MAX_IDLE_MS;
    } catch (error) {
      console.error("[wake rules] could not read the next deadline", error);
    }
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void wake(); }, delay);
    timer.unref?.();
  }

  function wake(): Promise<void> {
    if (duePending) return pass;
    duePending = true;
    return runSerially(async () => {
      duePending = false;
      try {
        const now = new Date();
        await checkWakeRules(await getDueWakeRules(now), now);
      } finally {
        await arm();
      }
    });
  }

  const onTask = (payload: unknown) => {
    const { projectId, task } = payload as { projectId: string; task?: { id?: string } };
    const taskId = task?.id;
    if (!taskId) return;
    checkOnce(`task:${projectId}:${taskId}`, async () => checkWakeRules(await getActiveTaskWakeRules(projectId, taskId)));
  };
  const onGitHub = (payload: unknown) => {
    const { projectId } = payload as { projectId: string };
    checkOnce(`github:${projectId}`, async () => {
      try {
        await checkWakeRules(await getActiveGitHubWakeRulesConcerning(projectId));
      } finally {
        // A settling CI run moved a deadline.
        await arm();
      }
    });
  };
  const onRulesChanged = () => { checkOnce("arm", arm); };

  sources.taskEvents.on("task:updated", onTask);
  sources.githubRoomEvents.on("github_event:updated", onGitHub);
  sources.wakeRuleEvents.on("wake_rules:invalidated", onRulesChanged);
  void wake();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    sources.taskEvents.off("task:updated", onTask);
    sources.githubRoomEvents.off("github_event:updated", onGitHub);
    sources.wakeRuleEvents.off("wake_rules:invalidated", onRulesChanged);
    await pass;
  };
}
