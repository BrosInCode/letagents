import { createHash, randomUUID } from "node:crypto";

import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "./client.js";
import { task_leases, workflow_effects } from "./schema.js";
import type { WorkflowEffect, WorkflowEffectKind, WorkflowEffectRow, WorkflowEffectState } from "./types.js";

export class WorkflowEffectIdempotencyConflictError extends Error {
  readonly code = "workflow_effect_idempotency_conflict";

  constructor(key: string) {
    super(`Idempotency key '${key}' is already bound to a different workflow effect request.`);
    this.name = "WorkflowEffectIdempotencyConflictError";
  }
}

export class WorkflowEffectLeaseStaleError extends Error {
  readonly code = "workflow_effect_review_lease_stale";

  constructor() {
    super("The active review lease changed before the workflow effect could be reserved.");
    this.name = "WorkflowEffectLeaseStaleError";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workflowEffectRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function workflowEffectCorrelationKey(input: {
  room_id: string;
  kind: WorkflowEffectKind;
  idempotency_key: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.room_id}\0${input.kind}\0${input.idempotency_key}`)
    .digest("hex")
    .slice(0, 32);
  return `lae_${digest}`;
}

function toWorkflowEffect(row: typeof workflow_effects.$inferSelect): WorkflowEffect {
  return row as WorkflowEffectRow;
}

export interface ReserveWorkflowEffectInput {
  room_id: string;
  task_id: string;
  lease_id: string;
  lease_epoch: number;
  agent_key: string;
  agent_session_id: string;
  kind: WorkflowEffectKind;
  provider: "github";
  idempotency_key: string;
  request_payload: Record<string, unknown>;
  created_by: string;
  quarantine_reason?: string | null;
  max_attempts?: number;
  now?: Date;
  /** Deterministic transaction barrier for PostgreSQL race tests only. */
  on_lease_locked_for_test?: () => Promise<void>;
}

export async function reserveWorkflowEffect(
  input: ReserveWorkflowEffectInput,
): Promise<{ effect: WorkflowEffect; claimed: boolean; processing_token: string | null }> {
  const now = (input.now ?? new Date()).toISOString();
  const requestFingerprint = workflowEffectRequestFingerprint(input.request_payload);
  const correlationKey = workflowEffectCorrelationKey(input);
  const quarantined = Boolean(input.quarantine_reason);
  const processingToken = quarantined ? null : randomUUID();

  return db.transaction(async (tx) => {
    // Serialize authority and reservation on the exact non-rebindable review
    // lease. Releasing the lease races on this row lock; exactly one ordering
    // wins, so no effect is enqueued from a stale reviewer observation.
    const [lease] = await tx
      .select()
      .from(task_leases)
      .where(and(
        eq(task_leases.id, input.lease_id),
        eq(task_leases.room_id, input.room_id),
        eq(task_leases.task_id, input.task_id),
        eq(task_leases.kind, "review"),
        eq(task_leases.status, "active"),
        or(isNull(task_leases.expires_at), gt(task_leases.expires_at, now)),
        eq(task_leases.epoch, input.lease_epoch),
        eq(task_leases.agent_key, input.agent_key),
        eq(task_leases.agent_session_id, input.agent_session_id),
      ))
      .for("update")
      .limit(1);
    if (!lease) throw new WorkflowEffectLeaseStaleError();
    await input.on_lease_locked_for_test?.();

    const [inserted] = await tx
      .insert(workflow_effects)
      .values({
        id: `effect_${randomUUID()}`,
        room_id: input.room_id,
        task_id: input.task_id,
        lease_id: input.lease_id,
        kind: input.kind,
        provider: input.provider,
        idempotency_key: input.idempotency_key,
        correlation_key: correlationKey,
        request_fingerprint: requestFingerprint,
        request_payload: input.request_payload,
        state: "pending",
        attempt_count: quarantined ? 0 : 1,
        max_attempts: input.max_attempts ?? 3,
        processing_token: processingToken,
        processing_started_at: processingToken ? now : null,
        next_attempt_at: null,
        external_id: null,
        external_url: null,
        response_payload: null,
        last_error: null,
        quarantined_at: quarantined ? now : null,
        quarantine_reason: input.quarantine_reason ?? null,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflictDoNothing({
        target: [workflow_effects.room_id, workflow_effects.idempotency_key],
      })
      .returning();

    if (inserted) {
      return {
        effect: toWorkflowEffect(inserted),
        claimed: Boolean(processingToken),
        processing_token: processingToken,
      };
    }

    const [existing] = await tx
      .select()
      .from(workflow_effects)
      .where(and(
        eq(workflow_effects.room_id, input.room_id),
        eq(workflow_effects.idempotency_key, input.idempotency_key),
      ))
      .limit(1);
    if (!existing) throw new Error("Workflow effect conflict row could not be loaded.");
    if (
      existing.request_fingerprint !== requestFingerprint
      || existing.task_id !== input.task_id
      || existing.kind !== input.kind
      || existing.provider !== input.provider
    ) {
      throw new WorkflowEffectIdempotencyConflictError(input.idempotency_key);
    }
    return { effect: toWorkflowEffect(existing), claimed: false, processing_token: null };
  });
}

export async function getWorkflowEffect(id: string): Promise<WorkflowEffect | null> {
  const [row] = await db.select().from(workflow_effects).where(eq(workflow_effects.id, id)).limit(1);
  return row ? toWorkflowEffect(row) : null;
}

export async function claimFailedWorkflowEffect(
  id: string,
  now = new Date(),
): Promise<{ effect: WorkflowEffect; processing_token: string } | null> {
  const token = randomUUID();
  const at = now.toISOString();
  const [row] = await db
    .update(workflow_effects)
    .set({
      state: "pending",
      attempt_count: sql`${workflow_effects.attempt_count} + 1`,
      processing_token: token,
      processing_started_at: at,
      next_attempt_at: null,
      updated_at: at,
    })
    .where(and(
      eq(workflow_effects.id, id),
      eq(workflow_effects.state, "failed"),
      isNull(workflow_effects.processing_token),
      sql`${workflow_effects.attempt_count} < ${workflow_effects.max_attempts}`,
      or(isNull(workflow_effects.next_attempt_at), lte(workflow_effects.next_attempt_at, at)),
    ))
    .returning();
  return row ? { effect: toWorkflowEffect(row), processing_token: token } : null;
}

export async function claimAmbiguousWorkflowEffect(
  id: string,
  now = new Date(),
  staleBefore = new Date(now.getTime() - 2 * 60_000),
): Promise<{ effect: WorkflowEffect; processing_token: string } | null> {
  const token = randomUUID();
  const at = now.toISOString();
  const [row] = await db
    .update(workflow_effects)
    .set({ processing_token: token, processing_started_at: at, updated_at: at })
    .where(and(
      eq(workflow_effects.id, id),
      eq(workflow_effects.state, "ambiguous"),
      isNull(workflow_effects.quarantined_at),
      or(
        and(
          isNull(workflow_effects.processing_token),
          or(isNull(workflow_effects.next_attempt_at), lte(workflow_effects.next_attempt_at, at)),
        ),
        and(
          isNotNull(workflow_effects.processing_token),
          lte(workflow_effects.processing_started_at, staleBefore.toISOString()),
        ),
      ),
    ))
    .returning();
  return row ? { effect: toWorkflowEffect(row), processing_token: token } : null;
}

export async function markStalePendingWorkflowEffectAmbiguous(
  id: string,
  staleBefore: Date,
  now = new Date(),
): Promise<WorkflowEffect | null> {
  const at = now.toISOString();
  const [row] = await db
    .update(workflow_effects)
    .set({
      state: "ambiguous",
      processing_token: null,
      processing_started_at: null,
      last_error: "Processing ownership expired before the provider result was persisted; lookup required.",
      updated_at: at,
    })
    .where(and(
      eq(workflow_effects.id, id),
      eq(workflow_effects.state, "pending"),
      lte(workflow_effects.processing_started_at, staleBefore.toISOString()),
      isNull(workflow_effects.quarantined_at),
    ))
    .returning();
  return row ? toWorkflowEffect(row) : null;
}

async function finishWithToken(input: {
  id: string;
  token: string;
  state: WorkflowEffectState;
  now?: Date;
  values: Partial<typeof workflow_effects.$inferInsert>;
}): Promise<WorkflowEffect | null> {
  const at = (input.now ?? new Date()).toISOString();
  const [row] = await db
    .update(workflow_effects)
    .set({
      ...input.values,
      state: input.state,
      processing_token: null,
      processing_started_at: null,
      updated_at: at,
    })
    .where(and(
      eq(workflow_effects.id, input.id),
      eq(workflow_effects.processing_token, input.token),
    ))
    .returning();
  return row ? toWorkflowEffect(row) : null;
}

export function markWorkflowEffectSucceeded(input: {
  id: string;
  processing_token: string;
  external_id: string;
  external_url?: string | null;
  response_payload?: Record<string, unknown> | null;
  now?: Date;
}): Promise<WorkflowEffect | null> {
  const at = (input.now ?? new Date()).toISOString();
  return finishWithToken({
    id: input.id,
    token: input.processing_token,
    state: "succeeded",
    now: input.now,
    values: {
      external_id: input.external_id,
      external_url: input.external_url ?? null,
      response_payload: input.response_payload ?? null,
      last_error: null,
      next_attempt_at: null,
      completed_at: at,
    },
  });
}

export function markWorkflowEffectFailed(input: {
  id: string;
  processing_token: string;
  error: string;
  next_attempt_at: Date | null;
  now?: Date;
}): Promise<WorkflowEffect | null> {
  return finishWithToken({
    id: input.id,
    token: input.processing_token,
    state: "failed",
    now: input.now,
    values: {
      last_error: input.error,
      next_attempt_at: input.next_attempt_at?.toISOString() ?? null,
      completed_at: null,
    },
  });
}

export function markWorkflowEffectAmbiguous(input: {
  id: string;
  processing_token: string;
  error: string;
  now?: Date;
}): Promise<WorkflowEffect | null> {
  return finishWithToken({
    id: input.id,
    token: input.processing_token,
    state: "ambiguous",
    now: input.now,
    values: { last_error: input.error, next_attempt_at: null, completed_at: null },
  });
}

export function releaseWorkflowEffectLookup(input: {
  id: string;
  processing_token: string;
  error: string;
  next_attempt_at: Date;
  now?: Date;
}): Promise<WorkflowEffect | null> {
  return finishWithToken({
    id: input.id,
    token: input.processing_token,
    state: "ambiguous",
    now: input.now,
    values: {
      last_error: input.error,
      next_attempt_at: input.next_attempt_at.toISOString(),
      completed_at: null,
    },
  });
}

export async function listReconcilableWorkflowEffects(input: {
  stale_before: Date;
  now?: Date;
  limit?: number;
}): Promise<WorkflowEffect[]> {
  const now = (input.now ?? new Date()).toISOString();
  const rows = await db
    .select()
    .from(workflow_effects)
    .where(and(
      isNull(workflow_effects.quarantined_at),
      or(
        and(
          eq(workflow_effects.state, "ambiguous"),
          or(
            and(
              isNull(workflow_effects.processing_token),
              or(isNull(workflow_effects.next_attempt_at), lte(workflow_effects.next_attempt_at, now)),
            ),
            and(
              isNotNull(workflow_effects.processing_token),
              lte(workflow_effects.processing_started_at, input.stale_before.toISOString()),
            ),
          ),
        ),
        and(eq(workflow_effects.state, "pending"), lte(workflow_effects.processing_started_at, input.stale_before.toISOString())),
        and(
          eq(workflow_effects.state, "failed"),
          isNull(workflow_effects.processing_token),
          sql`${workflow_effects.attempt_count} < ${workflow_effects.max_attempts}`,
          or(isNull(workflow_effects.next_attempt_at), lte(workflow_effects.next_attempt_at, now)),
        ),
      ),
    ))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map(toWorkflowEffect);
}

export async function pruneSettledWorkflowEffects(input: {
  settled_before: Date;
  limit?: number;
}): Promise<number> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  const result = await db.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT ${workflow_effects.id}
      FROM ${workflow_effects}
      WHERE ${workflow_effects.updated_at} <= ${input.settled_before.toISOString()}
        AND (
          ${workflow_effects.state} = 'succeeded'
          OR (${workflow_effects.state} = 'failed' AND ${workflow_effects.attempt_count} >= ${workflow_effects.max_attempts})
          OR ${workflow_effects.quarantined_at} IS NOT NULL
        )
      ORDER BY ${workflow_effects.updated_at} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${workflow_effects}
    USING candidates
    WHERE ${workflow_effects.id} = candidates.id
    RETURNING ${workflow_effects.id}
  `);
  return result.rows.length;
}
