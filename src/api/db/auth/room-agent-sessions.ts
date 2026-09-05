import crypto, { randomUUID } from "node:crypto";
import { isMcpWorkerId, isMcpConnectionToken } from "../../../shared/mcp-worker.js";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "../client.js";
import {
  message_agent_receipt_events,
  message_agent_receipts,
  room_agent_delivery_instances,
  room_agent_delivery_sessions,
  room_agent_presence,
  room_agent_session_bearers,
  room_agent_sessions,
  supervisor_host_grants,
} from "../schema.js";
import { hashToken, nextPrefixedId } from "../utils.js";
import { toRoomAgentSession } from "../mappers.js";
import type {
  CreatedRoomAgentSession,
  RoomAgentRegistrationLiveness,
  RoomAgentSession,
  RoomAgentSessionBearer,
  RoomAgentSessionRow,
} from "../types.js";
import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ROOM_AGENT_RECONNECT_GRACE_MS,
  type RoomAgentSessionKind,
  type RoomAgentDeliveryCredentialFence,
} from "../../../shared/agent-presence.js";
import {
  DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES,
  getAgentSessionBearerTtlMs,
  isAgentSessionBearerFeatureEnabled,
  type AgentSessionBearerCapability,
} from "../../../shared/agent-session-bearer.js";
import {
  bearerDeliveryCredentialFingerprint,
  emitRoomAgentCredentialInvalidationLocal,
  queueRoomAgentCredentialInvalidationsTx,
  sessionTokenDeliveryCredentialFingerprint,
  type RoomAgentCredentialInvalidation,
} from "../../rooms/agent-credential-events.js";
import {
  assertSupervisorGrantFenceTx,
  SupervisorGrantFenceStaleError,
  type SupervisorGrantFence,
} from "./supervisor-grants.js";

const MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION = 128;

async function collectSessionCredentialFingerprintsTx(
  tx: any,
  sessions: readonly Pick<RoomAgentSessionRow, "session_id" | "token_hash">[],
): Promise<Map<string, string[]>> {
  const bySession = new Map<string, string[]>();
  if (sessions.length === 0) return bySession;
  if (sessions.length > MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION) {
    throw new Error("Too many active agent sessions to retire atomically.");
  }
  for (const session of sessions) {
    bySession.set(session.session_id, [sessionTokenDeliveryCredentialFingerprint(session.token_hash)]);
  }
  const bearerRows = await tx
    .select({
      session_id: room_agent_session_bearers.session_id,
      bearer_id: room_agent_session_bearers.bearer_id,
      generation: room_agent_session_bearers.generation,
    })
    .from(room_agent_session_bearers)
    .where(and(
      inArray(room_agent_session_bearers.session_id, sessions.map((session) => session.session_id)),
      isNull(room_agent_session_bearers.revoked_at),
    ))
    .orderBy(desc(room_agent_session_bearers.generation))
    .limit(MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION + 1);
  if (bearerRows.length > MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION) {
    throw new Error("Too many active agent credentials to retire atomically.");
  }
  for (const bearer of bearerRows) {
    bySession.get(bearer.session_id)?.push(
      bearerDeliveryCredentialFingerprint(bearer.bearer_id, bearer.generation),
    );
  }
  return bySession;
}

async function retireRoomAgentDeliveryTx(
  tx: any,
  sessionIds: readonly string[],
  now: string,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const deliveryKeys = sessionIds.map((sessionId) => `agent_session:${sessionId}`).sort();
  const lockKeysJson = JSON.stringify(deliveryKeys);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(concat(delivery.room_id, chr(31), delivery.delivery_key), 0)
    )
    FROM room_agent_delivery_sessions AS delivery
    INNER JOIN jsonb_array_elements_text(${lockKeysJson}::jsonb) AS key(value)
      ON key.value = delivery.delivery_key
    ORDER BY delivery.room_id, delivery.delivery_key
  `);
  // Instance rows are the idempotency authority for aggregate decrements.
  // Delete them in the same credential-retirement transaction as the summary
  // reset; otherwise a successor can later subtract a retired predecessor a
  // second time when the predecessor crosses the stale-heartbeat cutoff.
  await tx.delete(room_agent_delivery_instances)
    .where(inArray(
      room_agent_delivery_instances.delivery_key,
      deliveryKeys,
    ));
  await tx.update(room_agent_delivery_sessions)
    .set({
      active_connection_count: 0,
      desktop_signal_sequence: 0,
      last_disconnected_at: now,
      reconnect_grace_expires_at: now,
      updated_at: now,
    })
    .where(inArray(room_agent_delivery_sessions.agent_session_id, [...sessionIds]));
  await tx.delete(room_agent_presence)
    .where(inArray(room_agent_presence.agent_session_id, [...sessionIds]));
}

function emitCommittedCredentialInvalidations(
  invalidations: readonly RoomAgentCredentialInvalidation[],
): void {
  for (const invalidation of invalidations) emitRoomAgentCredentialInvalidationLocal(invalidation);
}


export function makeAgentSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function makeAgentSessionBearerToken(): string {
  return `lasb_${crypto.randomBytes(32).toString("base64url")}`;
}


function toRoomAgentSessionBearer(row: typeof room_agent_session_bearers.$inferSelect): RoomAgentSessionBearer {
  return {
    bearer_id: row.bearer_id,
    session_id: row.session_id,
    room_id: row.room_id,
    generation: row.generation,
    capabilities: row.capabilities,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    rotated_from_bearer_id: row.rotated_from_bearer_id,
    supervisor_grant_id: row.supervisor_grant_id,
  };
}

function newBearerExpiry(now: Date): string {
  return new Date(now.getTime() + getAgentSessionBearerTtlMs()).toISOString();
}

export interface CreateRoomAgentSessionInput {
  room_id: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  registration_liveness?: RoomAgentRegistrationLiveness | null;
  repo_branch?: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id?: string | null;
  display_name: string;
  assigned_base_display_name?: string | null;
  owner_account_id: string;
  owner_label: string;
  ide_label: string;
  supervisor_grant_id?: string | null;
  worker_bearer_expires_at?: string | null;
  supervisor_grant_fence?: SupervisorGrantFence;
  /** Prepared and persisted by the MCP client before registration; never public. */
  connection_token?: string;
}

export const SAME_INSTANCE_RECLAIM_STALE_AFTER_MS =
  ACTIVE_AGENT_DELIVERY_WINDOW_MS + ROOM_AGENT_RECONNECT_GRACE_MS;

export class ActiveAgentInstanceConflictError extends Error {
  readonly code = "agent_instance_already_active";

  constructor(readonly active_session_id: string) {
    super("This exact agent instance is already active on another live transport.");
    this.name = "ActiveAgentInstanceConflictError";
  }
}

export function isActiveAgentInstanceConflictError(
  error: unknown,
): error is ActiveAgentInstanceConflictError {
  return error instanceof ActiveAgentInstanceConflictError;
}

export function isActiveRoomAgentSessionStaleForRegistration(input: {
  active_session: Pick<RoomAgentSession, "last_seen_at">;
  now_ms?: number;
}): boolean {
  const lastSeenMs = Date.parse(input.active_session.last_seen_at);
  const nowMs = input.now_ms ?? Date.now();
  return Number.isFinite(lastSeenMs)
    && nowMs - lastSeenMs >= SAME_INSTANCE_RECLAIM_STALE_AFTER_MS;
}

export interface RoomAgentSessionReplacementProof {
  session_id: string;
  session_token: string;
}

function replacementProofMatches(
  activeSession: Pick<RoomAgentSessionRow, "session_id" | "token_hash">,
  proof: RoomAgentSessionReplacementProof | null | undefined,
): boolean {
  if (!proof || proof.session_id !== activeSession.session_id) return false;
  const expected = Buffer.from(activeSession.token_hash, "hex");
  const actual = Buffer.from(hashToken(proof.session_token), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function insertRoomAgentSessionTx(
  tx: any,
  input: CreateRoomAgentSessionInput,
): Promise<CreatedRoomAgentSession> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const sessionToken = input.connection_token ?? makeAgentSessionToken();
  const workerBearer = input.session_kind === "worker" && isAgentSessionBearerFeatureEnabled()
    ? makeAgentSessionBearerToken()
    : null;
  const session = {
    session_id: await nextPrefixedId("room_agent_sessions", "agent_session", tx),
    room_id: input.room_id,
    token_hash: hashToken(sessionToken),
    session_kind: input.session_kind,
    runtime: input.runtime || "unknown",
    host_id: input.registration_liveness?.host_id ?? null,
    host_kind: input.registration_liveness?.host_kind ?? null,
    host_label: input.registration_liveness?.host_label ?? null,
    liveness_capability: input.registration_liveness?.liveness_capability ?? null,
    tool_bridge_id: input.registration_liveness?.tool_bridge_id ?? null,
    repo_branch: input.repo_branch ?? null,
    actor_label: input.actor_label,
    agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id ?? null,
    display_name: input.display_name,
    assigned_base_display_name: input.assigned_base_display_name ?? null,
    owner_account_id: input.owner_account_id,
    supervisor_grant_id: input.supervisor_grant_id ?? null,
    owner_label: input.owner_label,
    ide_label: input.ide_label,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  };

  const [created] = await tx.insert(room_agent_sessions).values(session).returning();
  if (workerBearer) await tx.insert(room_agent_session_bearers).values({
      bearer_id: await nextPrefixedId("room_agent_session_bearers", "agent_bearer", tx),
      session_id: session.session_id,
      room_id: session.room_id,
      supervisor_grant_id: input.supervisor_grant_id ?? null,
      token_hash: hashToken(workerBearer),
      generation: 1,
      capabilities: DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES,
      issued_at: now,
      expires_at: input.worker_bearer_expires_at ?? newBearerExpiry(nowDate),
      revoked_at: null,
      rotated_from_bearer_id: null,
      created_at: now,
    });
  return { ...toRoomAgentSession(created as RoomAgentSessionRow), session_token: sessionToken, worker_bearer: workerBearer };
}

async function rotateRoomAgentSessionTx(
  tx: any,
  current: RoomAgentSessionRow,
  input: CreateRoomAgentSessionInput,
): Promise<CreatedRoomAgentSession> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const sessionToken = input.connection_token ?? makeAgentSessionToken();
  const workerBearer = isAgentSessionBearerFeatureEnabled()
    ? makeAgentSessionBearerToken()
    : null;
  const [latestBearer] = await tx.select()
    .from(room_agent_session_bearers)
    .where(eq(room_agent_session_bearers.session_id, current.session_id))
    .orderBy(desc(room_agent_session_bearers.generation))
    .limit(1);

  const [updated] = await tx.update(room_agent_sessions).set({
    token_hash: hashToken(sessionToken),
    session_kind: "worker" as RoomAgentSessionKind,
    runtime: input.runtime || "unknown",
    host_id: input.registration_liveness?.host_id ?? null,
    host_kind: input.registration_liveness?.host_kind ?? null,
    host_label: input.registration_liveness?.host_label ?? null,
    liveness_capability: input.registration_liveness?.liveness_capability ?? null,
    tool_bridge_id: input.registration_liveness?.tool_bridge_id ?? null,
    repo_branch: input.repo_branch ?? null,
    actor_label: input.actor_label,
    agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id ?? null,
    display_name: input.display_name,
    assigned_base_display_name: input.assigned_base_display_name ?? null,
    owner_account_id: input.owner_account_id,
    supervisor_grant_id: input.supervisor_grant_id ?? null,
    owner_label: input.owner_label,
    ide_label: input.ide_label,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  }).where(and(
    eq(room_agent_sessions.session_id, current.session_id),
    ...(isMcpWorkerId(input.agent_instance_id) ? [] : [isNull(room_agent_sessions.ended_at)]),
  )).returning();
  if (!updated) throw new Error("Agent session replacement target disappeared.");

  if (workerBearer) {
    // A supervisor restart replaces the worker credential on the same durable
    // session.  Do not leave the predecessor usable alongside the retry.
    await tx.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(and(
        eq(room_agent_session_bearers.session_id, current.session_id),
        isNull(room_agent_session_bearers.revoked_at),
      ));
    await tx.insert(room_agent_session_bearers).values({
      bearer_id: await nextPrefixedId("room_agent_session_bearers", "agent_bearer", tx),
      session_id: current.session_id,
      room_id: input.room_id,
      supervisor_grant_id: input.supervisor_grant_id ?? null,
      token_hash: hashToken(workerBearer),
      generation: (latestBearer?.generation ?? 0) + 1,
      capabilities: DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES,
      issued_at: now,
      expires_at: input.worker_bearer_expires_at ?? newBearerExpiry(nowDate),
      revoked_at: null,
      rotated_from_bearer_id: latestBearer?.bearer_id ?? null,
      created_at: now,
    });
  }

  return {
    ...toRoomAgentSession(updated as RoomAgentSessionRow),
    session_token: sessionToken,
    worker_bearer: workerBearer,
  };
}

export async function createRoomAgentSession(
  input: CreateRoomAgentSessionInput,
): Promise<CreatedRoomAgentSession> {
  return db.transaction(async (tx) => {
    if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      throw new Error("Supervisor grant fence is stale.");
    }
    return insertRoomAgentSessionTx(tx, input);
  });
}

/**
 * Register one worker session behind an exact room/key/instance fence.
 *
 * A reconnect proves ownership by presenting the exact prior session
 * credential. A caller without that secret may reclaim only after the prior
 * session heartbeat expires; while it is fresh we fail closed so a genuinely
 * concurrent process cannot steal the instance identity. The advisory lock
 * linearizes simultaneous registrations and keeps at most one active session
 * for the tuple even on databases that predate a uniqueness constraint.
 */
export async function createFencedRoomAgentSession(
  input: CreateRoomAgentSessionInput,
  replacementProof?: RoomAgentSessionReplacementProof | null,
): Promise<{
  session: CreatedRoomAgentSession;
  replaced_session_ids: string[];
}> {
  const durable = isMcpWorkerId(input.agent_instance_id);
  if ((durable && input.session_kind !== "worker") || durable !== Boolean(input.connection_token)
    || (input.connection_token && !isMcpConnectionToken(input.connection_token))) {
    throw new Error("Durable MCP registration requires a prepared connection credential.");
  }
  if (input.session_kind !== "worker" || !input.agent_instance_id?.trim()) {
    return {
      session: await createRoomAgentSession(input),
      replaced_session_ids: [],
    };
  }

  const committed = await db.transaction(async (tx) => {
    if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      throw new Error("Supervisor grant fence is stale.");
    }

    const instanceId = input.agent_instance_id!.trim();
    if (durable) {
      // Names belong to durable workers, including while they are offline.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp_worker_names:${input.room_id}`}, 0))`);
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_instance:${input.room_id}:${input.agent_key}:${instanceId}`}, 0))`);
    const predecessors = await tx
      .select()
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.agent_key, input.agent_key),
        eq(room_agent_sessions.agent_instance_id, instanceId),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        ...(durable ? [] : [isNull(room_agent_sessions.ended_at)]),
      ))
      // Board Manager failover share-locks both manager session rows before
      // entering the delivery-key lock domain. Every multi-session auth
      // mutation must acquire those rows in the same deterministic order or
      // replacement and failover can each hold one row while waiting on the
      // other. Product-level predecessor ranking happens after the locks are
      // held; lock order must not encode selection policy.
      .orderBy(asc(room_agent_sessions.session_id))
      .limit(MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION + 1)
      .for("update");

    if (predecessors.length > MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION) {
      throw new Error("Too many active agent sessions to replace atomically.");
    }

    const nowMs = Date.now();
    if (durable && predecessors.length === 1) {
      const prior = predecessors[0] as RoomAgentSessionRow;
      if (prior.owner_account_id !== input.owner_account_id) {
        throw new ActiveAgentInstanceConflictError(prior.session_id);
      }
      // A lost response retries the prepared credential, not another rotation.
      if (replacementProofMatches(prior, {
        session_id: prior.session_id, session_token: input.connection_token!,
      })) {
        if (prior.ended_at) throw new ActiveAgentInstanceConflictError(prior.session_id);
        return { result: {
          session: { ...toRoomAgentSession(prior), session_token: input.connection_token!, worker_bearer: null },
          replaced_session_ids: [],
        }, invalidations: [] };
      }
    }
    for (const row of predecessors) {
      const activeSession = toRoomAgentSession(row as RoomAgentSessionRow);
      if (!replacementProofMatches(row as RoomAgentSessionRow, replacementProof)
        && (durable || !isActiveRoomAgentSessionStaleForRegistration({
        active_session: activeSession,
        now_ms: nowMs,
      }))) {
        throw new ActiveAgentInstanceConflictError(activeSession.session_id);
      }
    }

    const replacementTarget = predecessors.find((row: RoomAgentSessionRow) =>
      replacementProofMatches(row, replacementProof)
    ) ?? predecessors.reduce<RoomAgentSessionRow | null>((latest, row) => {
      if (!latest) return row as RoomAgentSessionRow;
      const rowLastSeen = Date.parse(row.last_seen_at);
      const latestLastSeen = Date.parse(latest.last_seen_at);
      if (rowLastSeen !== latestLastSeen) {
        return rowLastSeen > latestLastSeen ? row as RoomAgentSessionRow : latest;
      }
      return row.session_id > latest.session_id ? row as RoomAgentSessionRow : latest;
    }, null);
    if (durable && replacementProof && !replacementTarget) {
      throw new ActiveAgentInstanceConflictError(replacementProof.session_id);
    }
    if (durable && replacementTarget) {
      // Reconnecting is never a rename; preserve the name originally assigned.
      input = { ...input, display_name: replacementTarget.display_name,
        actor_label: replacementTarget.actor_label,
        assigned_base_display_name: replacementTarget.assigned_base_display_name };
    }
    if (durable) {
      const [reserved] = await tx.select({ session_id: room_agent_sessions.session_id })
        .from(room_agent_sessions).where(and(
          eq(room_agent_sessions.room_id, input.room_id),
          eq(room_agent_sessions.actor_label, input.actor_label),
          sql`${room_agent_sessions.agent_instance_id} LIKE 'worker\\_%'`,
          sql`${room_agent_sessions.agent_instance_id} <> ${instanceId}`,
        )).limit(1);
      if (reserved) throw Object.assign(new Error("Worker name is reserved."), {
        code: "23505", constraint: "room_agent_sessions_active_worker_actor_label_idx",
      });
    }
    const replacedSessionIds = predecessors.map((row: RoomAgentSessionRow) => row.session_id);
    const retiredCredentials = await collectSessionCredentialFingerprintsTx(
      tx,
      predecessors as RoomAgentSessionRow[],
    );
    if (replacedSessionIds.length > 0) {
      const now = new Date(nowMs).toISOString();
      const supersededSessionIds = replacedSessionIds.filter(
        (sessionId) => sessionId !== replacementTarget?.session_id,
      );
      if (supersededSessionIds.length > 0) {
        await tx.update(room_agent_sessions)
          .set({ ended_at: now, updated_at: now, last_seen_at: now })
          .where(and(
            inArray(room_agent_sessions.session_id, supersededSessionIds),
            isNull(room_agent_sessions.ended_at),
          ));
      }
      await tx.update(room_agent_session_bearers)
        .set({ revoked_at: now })
        .where(and(
          inArray(room_agent_session_bearers.session_id, replacedSessionIds),
          isNull(room_agent_session_bearers.revoked_at),
        ));
      await retireRoomAgentDeliveryTx(tx, replacedSessionIds, now);
      // Presence is actor-label keyed. Clear the replaced projection so an
      // intentional rename cannot leave an old-label ghost; the stable session
      // id keeps task leases, Board Manager authority, and liveness lineage.
    }

    const invalidations = (predecessors as RoomAgentSessionRow[]).map((previous) => ({
      room_id: previous.room_id,
      agent_session_id: previous.session_id,
      credential_fingerprints: retiredCredentials.get(previous.session_id) ?? [],
      reason: "replaced" as const,
    }));
    await queueRoomAgentCredentialInvalidationsTx(tx, invalidations);
    return {
      result: {
        session: replacementTarget
          ? await rotateRoomAgentSessionTx(
              tx,
              replacementTarget as RoomAgentSessionRow,
              { ...input, agent_instance_id: instanceId },
            )
          : await insertRoomAgentSessionTx(tx, { ...input, agent_instance_id: instanceId }),
        replaced_session_ids: replacedSessionIds,
      },
      invalidations,
    };
  });
  emitCommittedCredentialInvalidations(committed.invalidations);
  return committed.result;
}

/**
 * Create, restart, or roll over the exact worker identity owned by a
 * supervisor grant. A replacement grant for the same owner/room/key/instance
 * takes over the durable session id while every predecessor bearer is revoked.
 *
 * This is deliberately separate from the general reconnect path: a
 * supervisor never receives an owner-capable session token with which to
 * prove replacement.  The current grant fence plus this tuple lock are the
 * authority to rotate the worker bearer in place.
 */
export async function createOrRotateSupervisorWorkerSession(
  input: CreateRoomAgentSessionInput & {
    supervisor_grant_id: string;
    supervisor_grant_fence: SupervisorGrantFence;
    agent_instance_id: string;
  },
): Promise<{ session: CreatedRoomAgentSession; bearer: RoomAgentSessionBearer }> {
  const instanceId = input.agent_instance_id.trim();
  if (!instanceId) throw new Error("Supervisor worker agent_instance_id is required.");

  const committed = await db.transaction(async (tx) => {
    if (!(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      throw new SupervisorGrantFenceStaleError();
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_worker:${input.owner_account_id}:${input.room_id}:${input.agent_key}:${instanceId}`}, 0))`);
    const existing = await tx.select()
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.owner_account_id, input.owner_account_id),
        sql`${room_agent_sessions.supervisor_grant_id} IS NOT NULL`,
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.agent_key, input.agent_key),
        eq(room_agent_sessions.agent_instance_id, instanceId),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        isNull(room_agent_sessions.ended_at),
      ))
      // Match the global session-row lock order used by failover and general
      // replacement. Retention policy is evaluated below after all rows are
      // locked, independently from concurrency control.
      .orderBy(asc(room_agent_sessions.session_id))
      .limit(MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION + 1)
      .for("update");
    if (existing.length > MAX_SESSION_CREDENTIAL_INVALIDATIONS_PER_MUTATION) {
      throw new Error("Too many active supervisor sessions to rotate atomically.");
    }
    const retained = existing.reduce<RoomAgentSessionRow | null>((oldest, row) => {
      if (!oldest) return row as RoomAgentSessionRow;
      const rowCreatedAt = Date.parse(row.created_at);
      const oldestCreatedAt = Date.parse(oldest.created_at);
      if (rowCreatedAt !== oldestCreatedAt) {
        return rowCreatedAt < oldestCreatedAt ? row as RoomAgentSessionRow : oldest;
      }
      return row.session_id < oldest.session_id ? row as RoomAgentSessionRow : oldest;
    }, null);
    const duplicateSessionIds = existing
      .filter((row: RoomAgentSessionRow) => row.session_id !== retained?.session_id)
      .map((row: RoomAgentSessionRow) => row.session_id);
    const retiredCredentials = await collectSessionCredentialFingerprintsTx(
      tx,
      existing as RoomAgentSessionRow[],
    );
    if (duplicateSessionIds.length > 0) {
      const now = new Date().toISOString();
      await tx.update(room_agent_sessions)
        .set({ ended_at: now, updated_at: now, last_seen_at: now })
        .where(and(
          inArray(room_agent_sessions.session_id, duplicateSessionIds),
          isNull(room_agent_sessions.ended_at),
        ));
      await tx.update(room_agent_session_bearers)
        .set({ revoked_at: now })
        .where(and(
          inArray(room_agent_session_bearers.session_id, duplicateSessionIds),
          isNull(room_agent_session_bearers.revoked_at),
        ));
      await retireRoomAgentDeliveryTx(tx, duplicateSessionIds, now);
    }
    if (retained) {
      // The bearer rotates in place on a stable session id. Retire the prior
      // process's durable delivery lease in the same transaction so another
      // API instance cannot keep presenting it as reachable after rotation.
      const now = new Date().toISOString();
      await retireRoomAgentDeliveryTx(tx, [retained.session_id], now);
    }
    const session = retained
      ? await rotateRoomAgentSessionTx(tx, retained as RoomAgentSessionRow, { ...input, agent_instance_id: instanceId })
      : await insertRoomAgentSessionTx(tx, { ...input, agent_instance_id: instanceId });
    if (!session.worker_bearer) throw new Error("Worker bearer mode is not enabled.");
    const [bearer] = await tx.select().from(room_agent_session_bearers).where(and(
      eq(room_agent_session_bearers.session_id, session.session_id),
      eq(room_agent_session_bearers.token_hash, hashToken(session.worker_bearer)),
      isNull(room_agent_session_bearers.revoked_at),
    )).limit(1);
    if (!bearer) throw new Error("Worker bearer was not persisted.");
    const invalidations = (existing as RoomAgentSessionRow[]).map((previous) => ({
      room_id: previous.room_id,
      agent_session_id: previous.session_id,
      credential_fingerprints: retiredCredentials.get(previous.session_id) ?? [],
      reason: "replaced" as const,
    }));
    await queueRoomAgentCredentialInvalidationsTx(tx, invalidations);
    return {
      result: { session, bearer: toRoomAgentSessionBearer(bearer) },
      invalidations,
    };
  });
  emitCommittedCredentialInvalidations(committed.invalidations);
  return committed.result;
}


export async function getActiveRoomAgentSessionsForWorkerIdentity(input: {
  room_id: string;
  agent_key: string;
}): Promise<RoomAgentSession[]> {
  const rows = await db
    .select()
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, input.room_id),
      eq(room_agent_sessions.agent_key, input.agent_key),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
      isNull(room_agent_sessions.ended_at)
    ))
    .orderBy(desc(room_agent_sessions.last_seen_at))

  return rows.map((row) => toRoomAgentSession(row as RoomAgentSessionRow));
}

export async function getDurableRoomWorkerSessions(roomId: string): Promise<RoomAgentSession[]> {
  const rows = await db.select().from(room_agent_sessions).where(and(
    eq(room_agent_sessions.room_id, roomId),
    eq(room_agent_sessions.session_kind, "worker"),
    sql`${room_agent_sessions.agent_instance_id} LIKE 'worker\\_%'`,
  ));
  return rows.map((row) => toRoomAgentSession(row as RoomAgentSessionRow));
}

/**
 * The display name this agent instance used the last time it worked in this
 * room, when that session ended cleanly. Burst workers re-register per work
 * cycle; resuming the prior name keeps one stable identity in the room
 * instead of minting "Name 2", "Name 3", ... per burst.
 */
export async function getLastEndedWorkerSessionDisplayName(input: {
  room_id: string;
  agent_key: string;
  agent_instance_id: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ display_name: room_agent_sessions.display_name })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, input.room_id),
      eq(room_agent_sessions.agent_key, input.agent_key),
      eq(room_agent_sessions.agent_instance_id, input.agent_instance_id),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
      sql`${room_agent_sessions.ended_at} IS NOT NULL`
    ))
    .orderBy(desc(room_agent_sessions.ended_at))
    .limit(1);

  return row?.display_name ?? null;
}

export async function getRoomAgentSessionByCredentials(input: {
  session_id: string;
  session_token: string;
  room_id?: string | null;
  owner_account_id?: string | null;
}): Promise<RoomAgentSession | null> {
  const tokenHash = hashToken(input.session_token);
  const conditions = [
    eq(room_agent_sessions.session_id, input.session_id),
    eq(room_agent_sessions.token_hash, tokenHash),
    sql`${room_agent_sessions.ended_at} IS NULL`,
  ];
  if (input.room_id) {
    conditions.push(eq(room_agent_sessions.room_id, input.room_id));
  }
  if (input.owner_account_id) {
    conditions.push(eq(room_agent_sessions.owner_account_id, input.owner_account_id));
  }

  const [row] = await db
    .select()
    .from(room_agent_sessions)
    .where(and(...conditions))
    .limit(1);

  return row ? toRoomAgentSession(row as RoomAgentSessionRow) : null;
}

export async function getSupervisorRoomAgentSession(input: {
  session_id: string;
  supervisor_grant_id: string;
  include_ended?: boolean;
}): Promise<RoomAgentSession | null> {
  const conditions = [
    eq(room_agent_sessions.session_id, input.session_id),
    eq(room_agent_sessions.supervisor_grant_id, input.supervisor_grant_id),
    eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
  ];
  if (!input.include_ended) conditions.push(isNull(room_agent_sessions.ended_at));
  const [row] = await db.select().from(room_agent_sessions).where(and(...conditions)).limit(1);
  return row ? toRoomAgentSession(row as RoomAgentSessionRow) : null;
}

export interface ResolvedRoomAgentSessionBearer {
  bearer: RoomAgentSessionBearer;
  session: RoomAgentSession;
}

export async function getRoomAgentSessionBearerByToken(
  token: string
): Promise<ResolvedRoomAgentSessionBearer | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .select({ bearer: room_agent_session_bearers, session: room_agent_sessions })
    .from(room_agent_session_bearers)
    .innerJoin(
      room_agent_sessions,
      eq(room_agent_session_bearers.session_id, room_agent_sessions.session_id)
    )
    .leftJoin(
      supervisor_host_grants,
      eq(room_agent_session_bearers.supervisor_grant_id, supervisor_host_grants.grant_id),
    )
    .where(and(
      eq(room_agent_session_bearers.token_hash, hashToken(token)),
      isNull(room_agent_session_bearers.revoked_at),
      gt(room_agent_session_bearers.expires_at, now),
      isNull(room_agent_sessions.ended_at),
      eq(room_agent_session_bearers.room_id, room_agent_sessions.room_id),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
      or(
        and(
          isNull(room_agent_session_bearers.supervisor_grant_id),
          isNull(room_agent_sessions.supervisor_grant_id),
        ),
        and(
          eq(room_agent_session_bearers.supervisor_grant_id, supervisor_host_grants.grant_id),
          eq(room_agent_sessions.supervisor_grant_id, supervisor_host_grants.grant_id),
          isNull(supervisor_host_grants.revoked_at),
          gt(supervisor_host_grants.expires_at, now),
        ),
      ),
    ))
    .limit(1);

  return row ? {
    bearer: toRoomAgentSessionBearer(row.bearer),
    session: toRoomAgentSession(row.session as RoomAgentSessionRow),
  } : null;
}

export async function revokeRoomAgentSessionBearer(input: {
  bearer_id: string;
  session_id?: string;
}): Promise<RoomAgentSessionBearer | null> {
  const committed = await db.transaction(async (tx) => {
    const conditions = [eq(room_agent_session_bearers.bearer_id, input.bearer_id), isNull(room_agent_session_bearers.revoked_at)];
    if (input.session_id) conditions.push(eq(room_agent_session_bearers.session_id, input.session_id));
    const now = new Date().toISOString();
    const [row] = await tx
      .update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(and(...conditions))
      .returning();
    if (!row) return { result: null, invalidation: null };
    await retireRoomAgentDeliveryTx(tx, [row.session_id], now);
    const invalidation = {
      room_id: row.room_id,
      agent_session_id: row.session_id,
      credential_fingerprints: [
        bearerDeliveryCredentialFingerprint(row.bearer_id, row.generation),
      ],
      reason: "revoked" as const,
    };
    await queueRoomAgentCredentialInvalidationsTx(tx, [invalidation]);
    return {
      result: toRoomAgentSessionBearer(row),
      invalidation,
    };
  });
  if (committed.invalidation) emitRoomAgentCredentialInvalidationLocal(committed.invalidation);
  return committed.result;
}

export async function rotateRoomAgentSessionBearer(input: {
  bearer_id: string;
  session_id?: string;
  capabilities?: AgentSessionBearerCapability[];
  expires_at?: string;
  supervisor_grant_id?: string;
  supervisor_grant_fence?: SupervisorGrantFence;
}): Promise<{ bearer: RoomAgentSessionBearer; token: string } | null> {
  const committed = await db.transaction(async (tx) => {
    if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      throw new SupervisorGrantFenceStaleError();
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_bearer:${input.bearer_id}`}, 0))`);
    const [current] = await tx
      .select()
      .from(room_agent_session_bearers)
      .where(and(
        eq(room_agent_session_bearers.bearer_id, input.bearer_id),
        ...(input.session_id ? [eq(room_agent_session_bearers.session_id, input.session_id)] : []),
        isNull(room_agent_session_bearers.revoked_at),
        ...(input.supervisor_grant_id ? [eq(room_agent_session_bearers.supervisor_grant_id, input.supervisor_grant_id)] : []),
      ))
      .limit(1);
    if (!current) return { result: null, invalidation: null };

    const nowDate = new Date();
    const now = nowDate.toISOString();
    await tx.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(eq(room_agent_session_bearers.bearer_id, current.bearer_id));
    await retireRoomAgentDeliveryTx(tx, [current.session_id], now);

    const token = makeAgentSessionBearerToken();
    const next = {
      bearer_id: await nextPrefixedId("room_agent_session_bearers", "agent_bearer", tx),
      session_id: current.session_id,
      room_id: current.room_id,
      supervisor_grant_id: current.supervisor_grant_id,
      token_hash: hashToken(token),
      generation: current.generation + 1,
      capabilities: input.capabilities ?? current.capabilities,
      issued_at: now,
      expires_at: input.expires_at ?? newBearerExpiry(nowDate),
      revoked_at: null,
      rotated_from_bearer_id: current.bearer_id,
      created_at: now,
    };
    const [created] = await tx.insert(room_agent_session_bearers).values(next).returning();
    const invalidation = {
      room_id: current.room_id,
      agent_session_id: current.session_id,
      credential_fingerprints: [
        bearerDeliveryCredentialFingerprint(current.bearer_id, current.generation),
      ],
      reason: "rotated" as const,
    };
    await queueRoomAgentCredentialInvalidationsTx(tx, [invalidation]);
    return {
      result: { bearer: toRoomAgentSessionBearer(created), token },
      invalidation,
    };
  });
  if (committed.invalidation) emitRoomAgentCredentialInvalidationLocal(committed.invalidation);
  return committed.result;
}

export async function touchRoomAgentSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(room_agent_sessions)
    .set({
      updated_at: now,
      last_seen_at: now,
    })
    .where(eq(room_agent_sessions.session_id, sessionId));
}

export async function endRoomAgentSession(input: {
  session_id: string;
  room_id?: string | null;
  owner_account_id?: string | null;
  supervisor_grant_id?: string | null;
  supervisor_grant_fence?: SupervisorGrantFence;
  credential_fence?: RoomAgentDeliveryCredentialFence | null;
}): Promise<RoomAgentSession | null> {
  const unavailableReceiptTargets: number[] = [];
  let unavailableReceiptRoom: string | null = null;
  const credentialInvalidations: RoomAgentCredentialInvalidation[] = [];
  const ended = await db.transaction(async (tx) => {
  if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
    throw new SupervisorGrantFenceStaleError();
  }
  if (input.supervisor_grant_id) {
    const [session] = await tx.select().from(room_agent_sessions).where(and(
      eq(room_agent_sessions.session_id, input.session_id),
      ...(input.owner_account_id ? [eq(room_agent_sessions.owner_account_id, input.owner_account_id)] : []),
      eq(room_agent_sessions.supervisor_grant_id, input.supervisor_grant_id),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
    )).limit(1);
    if (!session) throw new SupervisorGrantFenceStaleError();
    if (!session.agent_instance_id && input.supervisor_grant_fence) {
      throw new SupervisorGrantFenceStaleError();
    }
    if (session.agent_instance_id) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_worker:${session.owner_account_id}:${session.room_id}:${session.agent_key}:${session.agent_instance_id}`}, 0))`);
    }
    // A lost response after the first commit must be safely replayable under
    // the same exact current grant fence and session coordinates.
    if (session.ended_at) return toRoomAgentSession(session as RoomAgentSessionRow);
  }
  const now = new Date().toISOString();
  const conditions = [eq(room_agent_sessions.session_id, input.session_id)];
  if (input.room_id) {
    conditions.push(eq(room_agent_sessions.room_id, input.room_id));
  }
  if (input.owner_account_id) {
    conditions.push(eq(room_agent_sessions.owner_account_id, input.owner_account_id));
  }
  if (input.supervisor_grant_id) {
    conditions.push(eq(room_agent_sessions.supervisor_grant_id, input.supervisor_grant_id));
    conditions.push(eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind));
    conditions.push(isNull(room_agent_sessions.ended_at));
  }
  const fence = input.credential_fence;
  if (fence?.kind === "session_token") {
    conditions.push(eq(room_agent_sessions.token_hash, fence.token_hash));
  } else if (fence?.kind === "bearer") {
    // Lock the session before checking its bearer, in the same order as rotation.
    const [current] = await tx.select().from(room_agent_sessions)
      .where(and(...conditions)).for("update").limit(1);
    if (!current) return null;
    const [bearer] = await tx.select().from(room_agent_session_bearers).where(and(
      eq(room_agent_session_bearers.session_id, current.session_id),
      eq(room_agent_session_bearers.bearer_id, fence.bearer_id),
      eq(room_agent_session_bearers.generation, fence.generation),
      isNull(room_agent_session_bearers.revoked_at),
      gt(room_agent_session_bearers.expires_at, new Date().toISOString()),
    )).for("share").limit(1);
    if (!bearer) return null;
  }

  const [row] = await tx
    .update(room_agent_sessions)
    .set({
      ended_at: now,
      updated_at: now,
      last_seen_at: now,
    })
      .where(and(...conditions))
      .returning();

  if (!row && input.supervisor_grant_id) throw new SupervisorGrantFenceStaleError();

  if (row) {
    const retiredCredentials = await collectSessionCredentialFingerprintsTx(
      tx,
      [row as RoomAgentSessionRow],
    );
    await tx.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(and(
        eq(room_agent_session_bearers.session_id, row.session_id),
        isNull(room_agent_session_bearers.revoked_at),
      ));
    await retireRoomAgentDeliveryTx(tx, [row.session_id], now);
    credentialInvalidations.push({
      room_id: row.room_id,
      agent_session_id: row.session_id,
      credential_fingerprints: retiredCredentials.get(row.session_id) ?? [],
      reason: "ended",
    });
    await queueRoomAgentCredentialInvalidationsTx(tx, credentialInvalidations.slice(-1));
    unavailableReceiptTargets.push(
      ...await markUnresolvedReceiptsUnavailableTx(tx, row as RoomAgentSessionRow, now),
    );
    unavailableReceiptRoom = (row as RoomAgentSessionRow).room_id;
  }

  return row ? toRoomAgentSession(row as RoomAgentSessionRow) : null;
  });
  emitCommittedCredentialInvalidations(credentialInvalidations);
  if (unavailableReceiptRoom && unavailableReceiptTargets.length > 0) {
    // Dynamic import: the server event module transitively imports this file.
    // Room-level so the shared stream never enumerates ids that may be
    // concealed from some participants.
    const { queueMessageInfoInvalidation } = await import("../../server/message-info-events.js");
    queueMessageInfoInvalidation(unavailableReceiptRoom, null);
  }
  return ended;
}

/**
 * Server-owned terminal receipt transition. Supersession and duplicate
 * cleanup deliberately never reach this: they leave (or create) a live
 * successor for the same durable agent, and receipts match on agent_key, so
 * that successor implicitly keeps them. Only an end with no live successor
 * is durable evidence that unresolved routed work has become unavailable.
 */
async function markUnresolvedReceiptsUnavailableTx(
  tx: any,
  endedSession: RoomAgentSessionRow,
  now: string,
): Promise<number[]> {
  const [successor] = await tx
    .select({ session_id: room_agent_sessions.session_id })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, endedSession.room_id),
      eq(room_agent_sessions.agent_key, endedSession.agent_key),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
      isNull(room_agent_sessions.ended_at),
    ))
    .limit(1);
  if (successor) return [];

  const unresolved: Array<{ id: string; message_number: number; receipt_state: string }> = await tx
    .select({
      id: message_agent_receipts.id,
      message_number: message_agent_receipts.message_number,
      receipt_state: message_agent_receipts.receipt_state,
    })
    .from(message_agent_receipts)
    .where(and(
      eq(message_agent_receipts.message_room_id, endedSession.room_id),
      eq(message_agent_receipts.agent_key, endedSession.agent_key),
      inArray(message_agent_receipts.receipt_state, ["queued", "responding", "retrying", "blocked"]),
    ));
  if (unresolved.length === 0) return [];

  await tx
    .update(message_agent_receipts)
    .set({ receipt_state: "unavailable", updated_at: now })
    .where(inArray(message_agent_receipts.id, unresolved.map((receipt) => receipt.id)));
  await tx.insert(message_agent_receipt_events).values(unresolved.map((receipt) => ({
    id: `rcpt_evt_${randomUUID().replace(/-/g, "")}`,
    receipt_id: receipt.id,
    message_room_id: endedSession.room_id,
    message_number: receipt.message_number,
    from_state: receipt.receipt_state,
    to_state: "unavailable",
    // Server-authored: no session actor. A dead session cannot self-report.
    actor_session_id: null,
    timestamp: now,
  })));
  return unresolved.map((receipt) => receipt.message_number);
}
