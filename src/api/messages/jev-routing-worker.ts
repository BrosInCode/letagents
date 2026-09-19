import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { jev_routing_jobs } from "../db/schema.js";
import { getMessageById } from "../db/messages/history.js";
import {
  applyDeferredJevReceipts,
  logJevConversationRouting,
  resolveJevConversationRoutingHint,
  type DeferredJevRoutingPlan,
  type JevConversationRoutingHint,
} from "../db/messages/jev-routing-hint.js";
import { messageEvents } from "../server/events.js";
import { queueMessageInfoInvalidation } from "../server/message-info-events.js";

export interface ClaimedJevRoutingJob {
  room_id: string;
  message_number: number;
  plan: DeferredJevRoutingPlan;
  claim_token: string;
  attempts: number;
}

/** A bounded lease lets another API process recover abandoned work. */
export async function claimJevRoutingJobs(): Promise<ClaimedJevRoutingJob[]> {
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT room_id, message_number FROM ${jev_routing_jobs}
       WHERE state <> 'completed' AND available_at <= now()
       ORDER BY available_at LIMIT 8 FOR UPDATE SKIP LOCKED
    )
    UPDATE ${jev_routing_jobs} j
       SET state = 'processing', claim_token = ${randomUUID()},
           available_at = now() + interval '45 seconds', attempts = j.attempts + 1
      FROM candidates c
     WHERE j.room_id = c.room_id AND j.message_number = c.message_number
     RETURNING j.*
  `);
  return result.rows as unknown as ClaimedJevRoutingJob[];
}

export async function completeJevRoutingJob(
  job: ClaimedJevRoutingJob,
  hint: JevConversationRoutingHint | null,
): Promise<void> {
  const plan = job.plan;
  let didComplete = false;
  const targets = await db.transaction(async (tx) => {
    // Fence a stale worker and commit completion with receipt insertion. A
    // replay can never run a second election after the first committed.
    const completed = await tx.update(jev_routing_jobs).set({ state: "completed", claim_token: null })
      .where(and(
        eq(jev_routing_jobs.room_id, job.room_id),
        eq(jev_routing_jobs.message_number, job.message_number),
        eq(jev_routing_jobs.state, "processing"),
        eq(jev_routing_jobs.claim_token, job.claim_token),
      )).returning({ room_id: jev_routing_jobs.room_id });
    if (completed.length === 0) return [];
    didComplete = true;
    const decision = plan.mode !== "active" ? null
      : hint ? { reason: "jev_routed", agentKeys: hint.elected } : plan.heuristic;
    return decision ? applyDeferredJevReceipts(tx, plan, decision) : [];
  });
  if (!didComplete) return;
  if (hint) logJevConversationRouting(hint, {
    roomId: plan.roomId, messageNumber: plan.message.number,
    heuristicReason: plan.heuristic?.reason ?? null,
    heuristicAgentKeys: plan.heuristic?.agentKeys ?? [],
    appliedAgentKeys: targets.map((target) => target.agent_key),
  });
  const message = await getMessageById(plan.roomId, `msg_${plan.message.number}`);
  if (message) messageEvents.emit("message:routed", {
    projectId: plan.roomId, message, recipientAgentTargets: targets,
  });
  // A lost wake is recovered by the next ordered poll. The worker cursor
  // could not pass this message before completion.
  queueMessageInfoInvalidation(plan.roomId, null);
}

export function startJevRoutingWorker(): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  async function tick(): Promise<void> {
    try {
      const jobs = await claimJevRoutingJobs();
      await Promise.all(jobs.map(async (job) => {
        try {
          // Repeated process crashes must not indefinitely defer delivery.
          const hint = job.attempts > 3 ? null : await resolveJevConversationRoutingHint(job.plan);
          await completeJevRoutingJob(job, hint);
        } catch (error) {
          console.error(`[jev routing] job failed ${job.room_id}/msg_${job.message_number}`, error);
        }
      }));
    } catch (error) {
      console.error("[jev routing] queue unavailable", error);
    } finally {
      if (!stopped) timer = setTimeout(() => { running = tick(); }, 250);
    }
  }
  running = tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
