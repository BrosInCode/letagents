import { sql } from "drizzle-orm";

import {
  WakeRuleError,
  parseWakeRuleInput,
  type WakeRule,
  type WakeRuleActor,
} from "../../../shared/wake-rules.mjs";
import {
  cancelWakeRule,
  createWakeRule,
  getWakeRule,
  restoreWakeRule,
  roomHasRepository,
  wakeRuleEvaluationDeps,
  type WakeRuleRow,
} from "../db/wake-rules.js";
import { db } from "../db/client.js";
import { queueWakeRuleInvalidation } from "../server/events.js";

const STATUS_WORDS: Record<string, string> = { in_review: "in review", in_progress: "in progress" };

/** A task on this room's board, or on the board of the room it belongs to. */
async function findTask(roomId: string, taskId: string): Promise<{ room_id: string; status: string } | null> {
  const number = Number(taskId.slice("task_".length));
  const result = await db.execute<{ room_id: string; status: string }>(sql`
    SELECT task.room_id, task.status::text AS status
      FROM tasks AS task
     WHERE task.number = ${number}
       AND task.room_id IN (${roomId}, (SELECT parent_room_id FROM rooms WHERE id = ${roomId}))
     ORDER BY task.room_id = ${roomId} DESC
     LIMIT 1
  `);
  return result.rows[0] ?? null;
}

export async function addWakeRuleForAgent(input: {
  roomId: string;
  agent: { agent_key: string; agent_name: string; session_id: string | null };
  body: unknown;
}): Promise<{ rule: WakeRule; created: boolean }> {
  const rule = parseWakeRuleInput(input.body);
  let baseline: WakeRuleRow["baseline"] = null;
  if (rule.event === "task.status_changed") {
    const task = await findTask(input.roomId, rule.arguments.task_id!);
    if (!task) throw new WakeRuleError(`${rule.arguments.task_id} is not on this room's board.`, 404);
    if (rule.arguments.to?.includes(task.status as never)) {
      throw new WakeRuleError(`${rule.arguments.task_id} is already ${STATUS_WORDS[task.status] ?? task.status}. There is nothing to wait for.`, 409);
    }
    baseline = { room_id: task.room_id, status: task.status };
  }
  if (rule.event.startsWith("github.") && !(await roomHasRepository(input.roomId))) {
    throw new WakeRuleError("This room is not connected to a GitHub repository, so GitHub activity cannot wake you here.", 409);
  }
  // A rule on one pull request ends when it merges, so one made after that
  // would end at its first look. A closed one may still be reopened.
  const closed = rule.event.startsWith("github.") && rule.arguments.pr
    ? await wakeRuleEvaluationDeps.pullRequestClosed(input.roomId, rule.arguments.pr)
    : null;
  if (closed?.merged) {
    throw new WakeRuleError(`#${rule.arguments.pr} is already merged. There is nothing to wait for.`, 409);
  }
  const result = await createWakeRule({ roomId: input.roomId, agent: input.agent, rule, baseline });
  if (result.created) queueWakeRuleInvalidation(input.roomId);
  return result;
}

/**
 * Agents may cancel only their own rules. People in the room may cancel any
 * rule; an agent's wait is part of the room's shared plan.
 */
export async function cancelWakeRuleAs(roomId: string, ruleId: string, actor: WakeRuleActor): Promise<WakeRule> {
  const existing = await getWakeRule(roomId, ruleId);
  if (!existing) throw new WakeRuleError("Wake rule not found in this room.", 404);
  if (actor.kind === "agent" && existing.agent_key !== actor.id) {
    throw new WakeRuleError("You can cancel only your own wake rules.", 403);
  }
  const cancelled = await cancelWakeRule(roomId, ruleId, actor);
  if (!cancelled) throw new WakeRuleError("This wake rule already ended.", 409);
  queueWakeRuleInvalidation(roomId);
  return cancelled;
}

export async function restoreWakeRuleAs(roomId: string, ruleId: string, actor: WakeRuleActor): Promise<WakeRule> {
  const existing = await getWakeRule(roomId, ruleId);
  if (!existing) throw new WakeRuleError("Wake rule not found in this room.", 404);
  // Undo belongs to whoever cancelled: an agent cannot revive a wait a person stopped.
  if (existing.cancelled_by && (existing.cancelled_by.kind !== actor.kind || existing.cancelled_by.id !== actor.id)) {
    throw new WakeRuleError(`Only ${existing.cancelled_by.label} can undo this cancel.`, 403);
  }
  const restored = await restoreWakeRule(roomId, ruleId, actor);
  queueWakeRuleInvalidation(roomId);
  return restored;
}
