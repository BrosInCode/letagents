import { and, asc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";

import { db } from "../client.js";
import { toGitHubWebhookDelivery } from "../mappers.js";
import { github_webhook_deliveries } from "../schema.js";
import type { GitHubWebhookDelivery, GitHubWebhookDeliveryStatus } from "../types.js";

export async function recordGitHubWebhookDelivery(input: {
  delivery_id: string;
  event_name: string;
  action?: string | null;
  installation_id?: string | null;
  github_repo_id?: string | null;
  room_id?: string | null;
}): Promise<{ delivery: GitHubWebhookDelivery; duplicate: boolean }> {
  const received_at = new Date().toISOString();
  const [created] = await db
    .insert(github_webhook_deliveries)
    .values({
      delivery_id: input.delivery_id,
      event_name: input.event_name,
      action: input.action ?? null,
      installation_id: input.installation_id ?? null,
      github_repo_id: input.github_repo_id ?? null,
      room_id: input.room_id ?? null,
      status: "received",
      error: null,
      received_at,
      processed_at: null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      delivery: toGitHubWebhookDelivery(created),
      duplicate: false,
    };
  }

  const [existing] = await db
    .select()
    .from(github_webhook_deliveries)
    .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
    .limit(1);

  if (!existing) {
    throw new Error(`Webhook delivery '${input.delivery_id}' could not be recorded`);
  }

  return {
    delivery: toGitHubWebhookDelivery(existing),
    duplicate: true,
  };
}

/**
 * A delivery still 'received' this long after processing started was left by a
 * process that stopped mid-processing; a redelivery or the liveness sweep may
 * process it again. Inline processing normally ends within seconds.
 */
export const GITHUB_WEBHOOK_DELIVERY_STALE_MS = 5 * 60_000;
/** The sweep gives up on a delivery after this many processing starts. */
export const GITHUB_WEBHOOK_DELIVERY_MAX_ATTEMPTS = 5;

export type GitHubWebhookDeliveryClaim =
  | { claimed: false; delivery: GitHubWebhookDelivery }
  /**
   * retry: an earlier attempt failed or stopped, so earlier side effects may
   * exist. attempt: this claim's number; pass it to the final mark so a
   * runner whose claim was taken over writes nothing.
   */
  | { claimed: true; retry: boolean; attempt: number; delivery: GitHubWebhookDelivery };

/**
 * Record a delivery and claim it for processing, under the row lock: a new
 * delivery, a failed one, or one left 'received' past the stale age. Two
 * concurrent redeliveries of one delivery never both claim it.
 */
export async function claimGitHubWebhookDelivery(input: {
  delivery_id: string;
  event_name: string;
  action?: string | null;
  installation_id?: string | null;
  github_repo_id?: string | null;
  room_id?: string | null;
  payload: unknown;
  now?: Date;
}): Promise<GitHubWebhookDeliveryClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(github_webhook_deliveries)
      .values({
        delivery_id: input.delivery_id,
        event_name: input.event_name,
        action: input.action ?? null,
        installation_id: input.installation_id ?? null,
        github_repo_id: input.github_repo_id ?? null,
        room_id: input.room_id ?? null,
        status: "received",
        error: null,
        received_at: nowIso,
        processed_at: null,
        payload: input.payload,
        claimed_at: nowIso,
        attempts: 1,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return { claimed: true, retry: false, attempt: created.attempts, delivery: toGitHubWebhookDelivery(created) };
    }

    const [existing] = await tx
      .select()
      .from(github_webhook_deliveries)
      .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
      .limit(1)
      .for("update");
    if (!existing) {
      throw new Error(`Webhook delivery '${input.delivery_id}' could not be recorded`);
    }
    const startedAt = Date.parse(existing.claimed_at ?? existing.received_at);
    const stale = existing.status === "received"
      && !(startedAt > now.getTime() - GITHUB_WEBHOOK_DELIVERY_STALE_MS);
    if (existing.status !== "failed" && !stale) {
      return { claimed: false, delivery: toGitHubWebhookDelivery(existing) };
    }

    const [claimed] = await tx
      .update(github_webhook_deliveries)
      .set({
        status: "received",
        error: null,
        processed_at: null,
        payload: input.payload,
        claimed_at: nowIso,
        attempts: existing.attempts + 1,
      })
      .where(eq(github_webhook_deliveries.delivery_id, input.delivery_id))
      .returning();
    return { claimed: true, retry: true, attempt: claimed!.attempts, delivery: toGitHubWebhookDelivery(claimed!) };
  });
}

/**
 * Claim the oldest delivery left 'received' past the stale age that still
 * holds its payload. Skips rows another replica holds, and moves claimed_at
 * and attempts so no other sweep takes it during this attempt. A delivery
 * that already used every attempt is marked failed instead, and logged.
 */
export async function claimStaleGitHubWebhookDelivery(input: {
  now?: Date;
} = {}): Promise<{ delivery_id: string; event_name: string; payload: unknown; attempt: number } | null> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - GITHUB_WEBHOOK_DELIVERY_STALE_MS).toISOString();
  const stale = and(
    eq(github_webhook_deliveries.status, "received"),
    isNotNull(github_webhook_deliveries.payload),
    lte(github_webhook_deliveries.claimed_at, cutoff),
  );
  return db.transaction(async (tx) => {
    const exhausted = await tx
      .update(github_webhook_deliveries)
      .set({
        status: "failed",
        error: `Gave up after ${GITHUB_WEBHOOK_DELIVERY_MAX_ATTEMPTS} attempts; the process stopped each time.`,
        payload: null,
        processed_at: nowIso,
      })
      .where(and(stale, gte(github_webhook_deliveries.attempts, GITHUB_WEBHOOK_DELIVERY_MAX_ATTEMPTS)))
      .returning({ delivery_id: github_webhook_deliveries.delivery_id });
    for (const row of exhausted) {
      console.error(
        `[github webhook redrive] gave up on delivery ${row.delivery_id} after ${GITHUB_WEBHOOK_DELIVERY_MAX_ATTEMPTS} attempts`,
      );
    }

    const [candidate] = await tx
      .select({ delivery_id: github_webhook_deliveries.delivery_id })
      .from(github_webhook_deliveries)
      .where(and(stale, lt(github_webhook_deliveries.attempts, GITHUB_WEBHOOK_DELIVERY_MAX_ATTEMPTS)))
      .orderBy(asc(github_webhook_deliveries.claimed_at))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(github_webhook_deliveries)
      .set({
        claimed_at: nowIso,
        attempts: sql`${github_webhook_deliveries.attempts} + 1`,
      })
      .where(eq(github_webhook_deliveries.delivery_id, candidate.delivery_id))
      .returning({
        delivery_id: github_webhook_deliveries.delivery_id,
        event_name: github_webhook_deliveries.event_name,
        payload: github_webhook_deliveries.payload,
        attempt: github_webhook_deliveries.attempts,
      });
    return claimed ?? null;
  });
}

export async function markGitHubWebhookDeliveryProcessed(
  deliveryId: string,
  input: {
    status: Exclude<GitHubWebhookDeliveryStatus, "received">;
    error?: string | null;
    installation_id?: string | null;
    github_repo_id?: string | null;
    room_id?: string | null;
    /**
     * The attempt number of the claim this runner took. The mark applies only
     * while that claim is still the latest, so a runner whose claim was
     * taken over does not overwrite the newer runner's result.
     */
    attempt?: number;
  }
): Promise<boolean> {
  const update: Partial<typeof github_webhook_deliveries.$inferInsert> = {
    status: input.status,
    processed_at: new Date().toISOString(),
    // The body is needed only to process the delivery again.
    payload: null,
  };

  if (input.error !== undefined) {
    update.error = input.error;
  }
  if (input.installation_id !== undefined) {
    update.installation_id = input.installation_id;
  }
  if (input.github_repo_id !== undefined) {
    update.github_repo_id = input.github_repo_id;
  }
  if (input.room_id !== undefined) {
    update.room_id = input.room_id;
  }

  const marked = await db
    .update(github_webhook_deliveries)
    .set(update)
    .where(and(
      eq(github_webhook_deliveries.delivery_id, deliveryId),
      input.attempt === undefined ? undefined : eq(github_webhook_deliveries.attempts, input.attempt),
    ))
    .returning({ delivery_id: github_webhook_deliveries.delivery_id });
  if (marked.length === 0 && input.attempt !== undefined) {
    console.warn(`[github webhook] delivery ${deliveryId} attempt ${input.attempt} was taken over; its result is not recorded`);
  }
  return marked.length > 0;
}
