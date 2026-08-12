import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";

import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ROOM_AGENT_RECONNECT_GRACE_MS,
  type RoomAgentDeliveryTransport,
  type RoomAgentDeliveryCredentialFence,
  type RoomAgentSessionKind,
} from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import {
  room_agent_delivery_sessions,
  room_agent_delivery_instances,
  room_agent_session_bearers,
  room_agent_sessions,
} from "../schema.js";
import { clampLimit } from "../utils.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";
import {
  buildRoomAgentDeliveryKey,
  isRoomAgentDeliverySessionReachable,
} from "./helpers.js";
import { setRoomLiveAgentSuppressed } from "./suppression.js";
import {
  upsertRoomAgentPresenceTx,
  type UpsertRoomAgentPresenceInput,
} from "./status.js";
import {
  roomAgentDeliveryCredentialEpoch,
  roomAgentDeliveryCredentialFingerprint,
} from "../../rooms/agent-credential-events.js";

export class InactiveRoomAgentDeliverySessionError extends Error {
  constructor(readonly agentSessionId: string) {
    super("Agent session ended before delivery connected.");
    this.name = "InactiveRoomAgentDeliverySessionError";
  }
}

const ROOM_AGENT_DELIVERY_INSTANCE_PRUNE_LIMIT = 1_000;

/**
 * Delete a bounded keyset of abandoned process tokens. Per-key connect and
 * heartbeat paths keep their own rows exact; this sweep covers keys which
 * never reconnect after a process crash.
 */
export async function pruneStaleRoomAgentDeliveryInstances(
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ).toISOString();
  const limit = Math.max(1, Math.min(
    ROOM_AGENT_DELIVERY_INSTANCE_PRUNE_LIMIT,
    Math.floor(options.limit ?? ROOM_AGENT_DELIVERY_INSTANCE_PRUNE_LIMIT),
  ));
  const now = (options.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const candidateResult = await tx.execute<{ room_id: string; delivery_key: string }>(sql`
      SELECT DISTINCT candidate.room_id, candidate.delivery_key
      FROM (
        SELECT room_id, delivery_key
        FROM ${room_agent_delivery_instances}
        WHERE updated_at < ${cutoff}::timestamptz
        ORDER BY updated_at
        LIMIT ${limit}
      ) AS candidate
      ORDER BY candidate.room_id, candidate.delivery_key
    `);
    const candidateKeys = candidateResult.rows.sort((left, right) => (
      left.room_id.localeCompare(right.room_id)
      || left.delivery_key.localeCompare(right.delivery_key)
    ));
    if (candidateKeys.length === 0) return 0;

    // Use a transaction-level lock (rather than xact advisory locks) so all
    // candidate keys are claimed in one bounded statement without round trips.
    // Sorting before the call gives every sweeper the same multi-key lock order.
    const lockKeysJson = JSON.stringify(candidateKeys);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(concat(candidate.room_id, chr(31), candidate.delivery_key), 0)
      )
      FROM jsonb_to_recordset(${lockKeysJson}::jsonb)
        AS candidate(room_id text, delivery_key text)
      ORDER BY candidate.room_id, candidate.delivery_key
    `);

    const candidatesJson = JSON.stringify(candidateKeys);
    const deletedResult = await tx.execute<{ room_id: string; delivery_key: string }>(sql`
      WITH candidates AS (
        SELECT room_id, delivery_key
        FROM jsonb_to_recordset(${candidatesJson}::jsonb)
          AS candidate(room_id text, delivery_key text)
      ), stale AS (
        SELECT instance.room_id, instance.delivery_key, instance.instance_id
        FROM ${room_agent_delivery_instances} AS instance
        INNER JOIN candidates USING (room_id, delivery_key)
        WHERE instance.updated_at < ${cutoff}::timestamptz
        ORDER BY instance.updated_at, instance.room_id, instance.delivery_key, instance.instance_id
        LIMIT ${limit}
      )
      DELETE FROM ${room_agent_delivery_instances} AS instance
      USING stale
      WHERE instance.room_id = stale.room_id
        AND instance.delivery_key = stale.delivery_key
        AND instance.instance_id = stale.instance_id
      RETURNING instance.room_id, instance.delivery_key
    `);
    if (deletedResult.rows.length === 0) return 0;

    const affectedKeys = [...new Map(deletedResult.rows.map((row) => [
      `${row.room_id}\u001f${row.delivery_key}`,
      row,
    ])).values()];
    const affectedJson = JSON.stringify(affectedKeys);
    await tx.execute(sql`
      WITH affected AS (
        SELECT room_id, delivery_key
        FROM jsonb_to_recordset(${affectedJson}::jsonb)
          AS candidate(room_id text, delivery_key text)
      ), remaining AS (
        SELECT affected.room_id,
               affected.delivery_key,
               count(instance.instance_id)::int AS live_instances
        FROM affected
        LEFT JOIN ${room_agent_delivery_instances} AS instance
          ON instance.room_id = affected.room_id
         AND instance.delivery_key = affected.delivery_key
        GROUP BY affected.room_id, affected.delivery_key
      )
      UPDATE ${room_agent_delivery_sessions} AS delivery
      SET active_connection_count = remaining.live_instances,
          last_disconnected_at = CASE
            WHEN remaining.live_instances > 0 THEN delivery.last_disconnected_at
            ELSE ${now}::timestamptz
          END,
          reconnect_grace_expires_at = CASE
            WHEN remaining.live_instances > 0 THEN NULL
            ELSE ${now}::timestamptz
          END,
          updated_at = ${now}::timestamptz
      FROM remaining
      WHERE delivery.room_id = remaining.room_id
        AND delivery.delivery_key = remaining.delivery_key
    `);
    return deletedResult.rows.length;
  });
}

async function hasActiveDeliveryCredential(
  tx: any,
  input: {
    room_id: string;
    agent_session_id: string;
    credential_fence?: RoomAgentDeliveryCredentialFence | null;
  },
): Promise<boolean> {
  const fence = input.credential_fence;
  if (!fence) return false;
  if (fence.kind === "session_token") {
    const [activeSession] = await tx
      .select({ session_id: room_agent_sessions.session_id })
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.session_id, input.agent_session_id),
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.token_hash, fence.token_hash),
        isNull(room_agent_sessions.ended_at),
      ))
      .for("share")
      .limit(1);
    return Boolean(activeSession);
  }
  const [activeBearer] = await tx
    .select({ session_id: room_agent_sessions.session_id })
    .from(room_agent_sessions)
    .innerJoin(
      room_agent_session_bearers,
      eq(room_agent_session_bearers.session_id, room_agent_sessions.session_id),
    )
    .where(and(
      eq(room_agent_sessions.session_id, input.agent_session_id),
      eq(room_agent_sessions.room_id, input.room_id),
      isNull(room_agent_sessions.ended_at),
      eq(room_agent_session_bearers.bearer_id, fence.bearer_id),
      eq(room_agent_session_bearers.generation, fence.generation),
      isNull(room_agent_session_bearers.revoked_at),
      gt(room_agent_session_bearers.expires_at, new Date().toISOString()),
    ))
    .for("share")
    .limit(1);
  return Boolean(activeBearer);
}

async function countRoomAgentDeliveryInstancesTx(
  tx: any,
  roomId: string,
  deliveryKey: string,
): Promise<number> {
  const [countRow] = await tx.select({
    count: sql<number>`count(*)::int`,
  }).from(room_agent_delivery_instances).where(and(
    eq(room_agent_delivery_instances.room_id, roomId),
    eq(room_agent_delivery_instances.delivery_key, deliveryKey),
  ));
  return countRow?.count ?? 0;
}

async function lockRoomAgentDeliveryInstanceKeyTx(
  tx: any,
  roomId: string,
  deliveryKey: string,
): Promise<void> {
  // Every instance mutation and its aggregate projection must share one MVCC
  // serialization point. Row locks alone are insufficient because two hosts
  // can delete distinct rows, each count the other's uncommitted row, and
  // then both preserve a false-live aggregate. The transaction-scoped lock is
  // released automatically on commit/rollback and hash collisions only reduce
  // concurrency; they cannot weaken correctness.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(concat(${roomId}::text, chr(31), ${deliveryKey}::text), 0)
    )
  `);
}

async function assertActiveDeliveryCredential(
  tx: any,
  input: {
    room_id: string;
    agent_session_id: string;
    credential_fence?: RoomAgentDeliveryCredentialFence | null;
  },
): Promise<void> {
  if (!(await hasActiveDeliveryCredential(tx, input))) {
    throw new InactiveRoomAgentDeliverySessionError(input.agent_session_id);
  }
}

export async function markRoomAgentDeliveryConnected(input: {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  agent_session_id?: string | null;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  repo_branch?: string | null;
  credential_fence?: RoomAgentDeliveryCredentialFence | null;
  /** Idempotent process-local ownership token for one durable delivery lease. */
  delivery_instance_id?: string | null;
  transport: RoomAgentDeliveryTransport;
}): Promise<RoomAgentDeliverySession> {
  const now = new Date().toISOString();
  const staleConnectionCutoff = new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS).toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);
  const credentialEpoch = roomAgentDeliveryCredentialEpoch(input.credential_fence);

  const session = await db.transaction(async (tx) => {
    if ((input.session_kind ?? "controller") === "worker" && input.agent_session_id) {
      // Lock the durable credential row through the connected upsert. A
      // cross-instance replacement either waits and force-disconnects after
      // this commit, or wins first and makes this stale setup fail closed.
      await assertActiveDeliveryCredential(tx, {
        room_id: input.room_id,
        agent_session_id: input.agent_session_id,
        credential_fence: input.credential_fence,
      });
    }

    let instanceConnectionDelta: number | null = null;
    let liveInstanceCount: number | null = null;
    if (input.delivery_instance_id) {
      await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
      const staleInstances = await tx.delete(room_agent_delivery_instances).where(and(
        eq(room_agent_delivery_instances.room_id, input.room_id),
        eq(room_agent_delivery_instances.delivery_key, deliveryKey),
        sql`${room_agent_delivery_instances.updated_at} < ${staleConnectionCutoff}::timestamptz`,
      )).returning({ instance_id: room_agent_delivery_instances.instance_id });
      const insertedInstances = await tx.insert(room_agent_delivery_instances).values({
        room_id: input.room_id,
        delivery_key: deliveryKey,
        instance_id: input.delivery_instance_id,
        credential_fingerprint: credentialFingerprint,
        transport: input.transport,
        created_at: now,
        updated_at: now,
      }).onConflictDoNothing().returning({ instance_id: room_agent_delivery_instances.instance_id });
      if (insertedInstances.length === 0) {
        await tx.update(room_agent_delivery_instances).set({
          credential_fingerprint: credentialFingerprint,
          transport: input.transport,
          updated_at: now,
        }).where(and(
          eq(room_agent_delivery_instances.room_id, input.room_id),
          eq(room_agent_delivery_instances.delivery_key, deliveryKey),
          eq(room_agent_delivery_instances.instance_id, input.delivery_instance_id),
        ));
      }
      instanceConnectionDelta = insertedInstances.length - staleInstances.length;
      liveInstanceCount = await countRoomAgentDeliveryInstancesTx(
        tx,
        input.room_id,
        deliveryKey,
      );
    }

    const [connectedSession] = await tx
      .insert(room_agent_delivery_sessions)
      .values({
        room_id: input.room_id,
        delivery_key: deliveryKey,
        actor_label: input.actor_label,
        agent_key: input.agent_key ?? null,
        agent_instance_id: input.agent_instance_id ?? null,
        agent_session_id: input.agent_session_id ?? null,
        session_kind: input.session_kind ?? "controller",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        repo_branch: input.repo_branch ?? null,
        transport: input.transport,
        credential_fingerprint: credentialFingerprint,
        credential_epoch: credentialEpoch,
        active_connection_count: liveInstanceCount ?? 1,
        last_connected_at: now,
        last_disconnected_at: null,
        reconnect_grace_expires_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [room_agent_delivery_sessions.room_id, room_agent_delivery_sessions.delivery_key],
        set: {
          actor_label: input.actor_label,
          agent_key: input.agent_key ?? null,
          agent_instance_id: input.agent_instance_id ?? null,
          agent_session_id: input.agent_session_id ?? null,
          session_kind: input.session_kind ?? "controller",
          runtime: input.runtime ?? "unknown",
          display_name: input.display_name,
          owner_label: input.owner_label ?? null,
          ide_label: input.ide_label ?? null,
          repo_branch: input.repo_branch ?? null,
          transport: input.transport,
          credential_fingerprint: credentialFingerprint,
          credential_epoch: credentialEpoch,
          active_connection_count: instanceConnectionDelta === null
            ? sql`CASE
                WHEN ${room_agent_delivery_sessions.updated_at} < ${staleConnectionCutoff}::timestamptz THEN 1
                ELSE GREATEST(${room_agent_delivery_sessions.active_connection_count}, 0) + 1
              END`
            : sql`CASE
                WHEN ${room_agent_delivery_sessions.updated_at} < ${staleConnectionCutoff}::timestamptz
                  THEN ${liveInstanceCount ?? 0}
                ELSE GREATEST(
                  ${room_agent_delivery_sessions.active_connection_count} + ${instanceConnectionDelta},
                  ${liveInstanceCount ?? 0},
                  0
                )
              END`,
          last_connected_at: now,
          last_disconnected_at: null,
          reconnect_grace_expires_at: null,
          updated_at: now,
        },
      })
      .returning();
    return connectedSession;
  });

  if ((input.session_kind ?? "controller") === "worker") {
    await setRoomLiveAgentSuppressed({
      room_id: input.room_id,
      actor_labels: [input.actor_label],
      suppressed: false,
    });
  }

  return toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow);
}

export async function markRoomAgentDeliveryHeartbeat(input: {
  room_id: string;
  actor_label: string;
  agent_session_id?: string | null;
  credential_fence?: RoomAgentDeliveryCredentialFence | null;
  delivery_instance_id?: string | null;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);
  return db.transaction(async (tx) => {
    const credentialActive = !input.agent_session_id || await hasActiveDeliveryCredential(tx, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      credential_fence: input.credential_fence,
    });
    if (!credentialActive) {
      if (input.delivery_instance_id) {
        await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
        const releasedInstances = await tx.delete(room_agent_delivery_instances).where(and(
          eq(room_agent_delivery_instances.room_id, input.room_id),
          eq(room_agent_delivery_instances.delivery_key, deliveryKey),
          eq(room_agent_delivery_instances.instance_id, input.delivery_instance_id),
          ...(credentialFingerprint
            ? [eq(room_agent_delivery_instances.credential_fingerprint, credentialFingerprint)]
            : []),
        )).returning({ instance_id: room_agent_delivery_instances.instance_id });
        if (releasedInstances.length > 0) {
          const liveInstanceCount = await countRoomAgentDeliveryInstancesTx(
            tx,
            input.room_id,
            deliveryKey,
          );
          await tx.update(room_agent_delivery_sessions)
            .set({
              active_connection_count: sql`GREATEST(
                ${room_agent_delivery_sessions.active_connection_count} - ${releasedInstances.length},
                ${liveInstanceCount},
                0
              )`,
              last_disconnected_at: now,
              reconnect_grace_expires_at: sql`CASE
                WHEN GREATEST(
                  ${room_agent_delivery_sessions.active_connection_count} - ${releasedInstances.length},
                  ${liveInstanceCount}
                ) > 0
                  THEN NULL
                ELSE ${now}::timestamptz
              END`,
              updated_at: now,
            })
            .where(and(
              eq(room_agent_delivery_sessions.room_id, input.room_id),
              eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
            ));
        }
        return false;
      }
      // Retire only the exact stale fingerprint. A rotated successor may use
      // the same durable session id and must not be clobbered by this cleanup.
      await tx.update(room_agent_delivery_sessions)
        .set({
          active_connection_count: 0,
          last_disconnected_at: now,
          reconnect_grace_expires_at: now,
          updated_at: now,
        })
        .where(and(
          eq(room_agent_delivery_sessions.room_id, input.room_id),
          eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
          ...(credentialFingerprint
            ? [eq(room_agent_delivery_sessions.credential_fingerprint, credentialFingerprint)]
            : []),
        ));
      return false;
    }
    if (input.delivery_instance_id) {
      await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
      const staleConnectionCutoff = new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS).toISOString();
      const staleInstances = await tx.delete(room_agent_delivery_instances).where(and(
        eq(room_agent_delivery_instances.room_id, input.room_id),
        eq(room_agent_delivery_instances.delivery_key, deliveryKey),
        sql`${room_agent_delivery_instances.updated_at} < ${staleConnectionCutoff}::timestamptz`,
      )).returning({ instance_id: room_agent_delivery_instances.instance_id });
      const [instance] = await tx.update(room_agent_delivery_instances)
        .set({ updated_at: now })
        .where(and(
          eq(room_agent_delivery_instances.room_id, input.room_id),
          eq(room_agent_delivery_instances.delivery_key, deliveryKey),
          eq(room_agent_delivery_instances.instance_id, input.delivery_instance_id),
          ...(credentialFingerprint
            ? [eq(room_agent_delivery_instances.credential_fingerprint, credentialFingerprint)]
            : []),
        ))
        .returning({ instance_id: room_agent_delivery_instances.instance_id });
      if (instance || staleInstances.length > 0) {
        const liveInstanceCount = await countRoomAgentDeliveryInstancesTx(
          tx,
          input.room_id,
          deliveryKey,
        );
        await tx.update(room_agent_delivery_sessions)
          .set({
            active_connection_count: sql`GREATEST(
              ${room_agent_delivery_sessions.active_connection_count} - ${staleInstances.length},
              ${liveInstanceCount},
              0
            )`,
            updated_at: now,
          })
          .where(and(
            eq(room_agent_delivery_sessions.room_id, input.room_id),
            eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
          ));
      }
      if (instance && input.agent_session_id) {
        await tx.update(room_agent_sessions)
          .set({ updated_at: now, last_seen_at: now })
          .where(eq(room_agent_sessions.session_id, input.agent_session_id));
      }
      return Boolean(instance);
    }
    const [session] = await tx
      .update(room_agent_delivery_sessions)
      .set({ updated_at: now })
      .where(and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
        ...(credentialFingerprint
          ? [eq(room_agent_delivery_sessions.credential_fingerprint, credentialFingerprint)]
          : []),
        sql`${room_agent_delivery_sessions.active_connection_count} > 0`,
      ))
      .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });
    if (session && input.agent_session_id) {
      await tx.update(room_agent_sessions)
        .set({ updated_at: now, last_seen_at: now })
        .where(eq(room_agent_sessions.session_id, input.agent_session_id));
    }
    return Boolean(session);
  });
}

export interface DesktopRoomAgentDeliveryHeartbeatInput {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  agent_session_id: string;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  repo_branch?: string | null;
  credential_fence?: RoomAgentDeliveryCredentialFence | null;
  desktop_signal_sequence?: number | null;
}

async function upsertDesktopRoomAgentDeliveryHeartbeatTx(
  input: DesktopRoomAgentDeliveryHeartbeatInput,
  presenceInput?: UpsertRoomAgentPresenceInput,
): Promise<{
  delivery: RoomAgentDeliverySession;
  presence: Awaited<ReturnType<typeof upsertRoomAgentPresenceTx>> | null;
}> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);
  const credentialEpoch = roomAgentDeliveryCredentialEpoch(input.credential_fence);
  const result = await db.transaction(async (tx) => {
    await assertActiveDeliveryCredential(tx, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      credential_fence: input.credential_fence,
    });
    await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
    const [connectedSession] = await tx
      .insert(room_agent_delivery_sessions)
    .values({
      room_id: input.room_id,
      delivery_key: deliveryKey,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      agent_instance_id: input.agent_instance_id ?? null,
      agent_session_id: input.agent_session_id,
      session_kind: input.session_kind ?? "worker",
      runtime: input.runtime ?? "unknown",
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      repo_branch: input.repo_branch ?? null,
      transport: "desktop_events",
      credential_fingerprint: credentialFingerprint,
      credential_epoch: credentialEpoch,
      desktop_signal_sequence: input.desktop_signal_sequence ?? 0,
      active_connection_count: 1,
      last_connected_at: now,
      last_disconnected_at: null,
      reconnect_grace_expires_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_agent_delivery_sessions.room_id, room_agent_delivery_sessions.delivery_key],
      set: {
        actor_label: input.actor_label,
        agent_key: input.agent_key ?? null,
        agent_instance_id: input.agent_instance_id ?? null,
        agent_session_id: input.agent_session_id,
        session_kind: input.session_kind ?? "worker",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        repo_branch: input.repo_branch ?? null,
        transport: "desktop_events",
        credential_fingerprint: credentialFingerprint,
        credential_epoch: credentialEpoch,
        desktop_signal_sequence: input.desktop_signal_sequence ?? sql`${room_agent_delivery_sessions.desktop_signal_sequence}`,
        active_connection_count: 1,
        last_disconnected_at: null,
        reconnect_grace_expires_at: null,
        updated_at: now,
      },
      setWhere: input.desktop_signal_sequence === undefined || input.desktop_signal_sequence === null
        ? sql`${room_agent_delivery_sessions.desktop_signal_sequence} = 0`
        : sql`${room_agent_delivery_sessions.desktop_signal_sequence} < ${input.desktop_signal_sequence}`,
    })
      .returning();
    if (!connectedSession) {
      throw await staleDesktopSignalError(tx, {
        room_id: input.room_id,
        delivery_key: deliveryKey,
        agent_session_id: input.agent_session_id,
      });
    }
    await tx
      .update(room_agent_sessions)
      .set({ updated_at: now, last_seen_at: now })
      .where(eq(room_agent_sessions.session_id, input.agent_session_id));
    const presence = presenceInput
      ? await upsertRoomAgentPresenceTx(tx, presenceInput, now)
      : null;
    return { connectedSession, presence };
  });
  await setRoomLiveAgentSuppressed({
    room_id: input.room_id,
    actor_labels: [input.actor_label],
    suppressed: false,
  });
  return {
    delivery: toRoomAgentDeliverySession(result.connectedSession as RoomAgentDeliverySessionRow),
    presence: result.presence,
  };
}

export class StaleDesktopRoomAgentDeliverySignalError extends Error {
  constructor(
    readonly agentSessionId: string,
    readonly currentSequence: number,
  ) {
    super("Desktop delivery signal was superseded by a newer state transition.");
    this.name = "StaleDesktopRoomAgentDeliverySignalError";
  }
}

async function staleDesktopSignalError(
  tx: any,
  input: { room_id: string; delivery_key: string; agent_session_id: string },
): Promise<StaleDesktopRoomAgentDeliverySignalError> {
  const [current] = await tx.select({
    sequence: room_agent_delivery_sessions.desktop_signal_sequence,
  }).from(room_agent_delivery_sessions).where(and(
    eq(room_agent_delivery_sessions.room_id, input.room_id),
    eq(room_agent_delivery_sessions.delivery_key, input.delivery_key),
  )).limit(1);
  return new StaleDesktopRoomAgentDeliverySignalError(
    input.agent_session_id,
    current?.sequence ?? 0,
  );
}

export function isStaleDesktopRoomAgentDeliverySignalError(
  error: unknown,
): error is StaleDesktopRoomAgentDeliverySignalError {
  return error instanceof StaleDesktopRoomAgentDeliverySignalError
    || (error instanceof Error && error.name === "StaleDesktopRoomAgentDeliverySignalError");
}

export async function pauseDesktopRoomAgentDelivery(input: DesktopRoomAgentDeliveryHeartbeatInput & {
  desktop_signal_sequence: number;
  presence: UpsertRoomAgentPresenceInput;
}): Promise<{
  delivery: RoomAgentDeliverySession | null;
  presence: Awaited<ReturnType<typeof upsertRoomAgentPresenceTx>>;
}> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey({
    actor_label: input.actor_label,
    agent_session_id: input.agent_session_id,
  });
  return db.transaction(async (tx) => {
    await assertActiveDeliveryCredential(tx, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      credential_fence: input.credential_fence,
    });
    await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
    const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);
    const credentialEpoch = roomAgentDeliveryCredentialEpoch(input.credential_fence);
    const [deliveryRow] = await tx.insert(room_agent_delivery_sessions).values({
      room_id: input.room_id,
      delivery_key: deliveryKey,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      agent_instance_id: input.agent_instance_id ?? null,
      agent_session_id: input.agent_session_id,
      session_kind: input.session_kind ?? "worker",
      runtime: input.runtime ?? "unknown",
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      repo_branch: input.repo_branch ?? null,
      transport: "desktop_events",
      credential_fingerprint: credentialFingerprint,
      credential_epoch: credentialEpoch,
      desktop_signal_sequence: input.desktop_signal_sequence,
      active_connection_count: 0,
      last_connected_at: now,
      last_disconnected_at: now,
      reconnect_grace_expires_at: now,
      created_at: now,
      updated_at: now,
    }).onConflictDoUpdate({
      target: [room_agent_delivery_sessions.room_id, room_agent_delivery_sessions.delivery_key],
      set: {
        actor_label: input.actor_label,
        agent_key: input.agent_key ?? null,
        agent_instance_id: input.agent_instance_id ?? null,
        agent_session_id: input.agent_session_id,
        session_kind: input.session_kind ?? "worker",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        repo_branch: input.repo_branch ?? null,
        transport: "desktop_events",
        credential_fingerprint: credentialFingerprint,
        credential_epoch: credentialEpoch,
        desktop_signal_sequence: input.desktop_signal_sequence,
        active_connection_count: 0,
        last_disconnected_at: now,
        reconnect_grace_expires_at: now,
        updated_at: now,
      },
      setWhere: input.desktop_signal_sequence === 0
        ? sql`${room_agent_delivery_sessions.desktop_signal_sequence} = 0`
        : sql`${room_agent_delivery_sessions.desktop_signal_sequence} < ${input.desktop_signal_sequence}`,
    }).returning();
    if (!deliveryRow) {
      throw await staleDesktopSignalError(tx, {
        room_id: input.room_id,
        delivery_key: deliveryKey,
        agent_session_id: input.agent_session_id,
      });
    }
    const presence = await upsertRoomAgentPresenceTx(tx, input.presence, now);
    return {
      delivery: toRoomAgentDeliverySession(deliveryRow as RoomAgentDeliverySessionRow),
      presence,
    };
  });
}

/** Idempotent lease heartbeat for a desktop host that owns room delivery. */
export async function upsertDesktopRoomAgentDeliveryHeartbeat(
  input: DesktopRoomAgentDeliveryHeartbeatInput,
): Promise<RoomAgentDeliverySession> {
  return (await upsertDesktopRoomAgentDeliveryHeartbeatTx(input)).delivery;
}

/** Credential-check, delivery lease, session touch and presence commit atomically. */
export async function upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat(
  input: DesktopRoomAgentDeliveryHeartbeatInput & {
    presence: Omit<UpsertRoomAgentPresenceInput, keyof DesktopRoomAgentDeliveryHeartbeatInput>;
  },
) {
  return upsertDesktopRoomAgentDeliveryHeartbeatTx(input, {
    room_id: input.room_id,
    actor_label: input.actor_label,
    agent_key: input.agent_key,
    agent_session_id: input.agent_session_id,
    session_kind: input.session_kind,
    runtime: input.runtime,
    display_name: input.display_name,
    owner_label: input.owner_label,
    ide_label: input.ide_label,
    repo_branch: input.repo_branch,
    ...input.presence,
  });
}

export async function markRoomAgentDeliveryDisconnected(input: {
  room_id: string;
  actor_label: string;
  agent_session_id?: string | null;
  credential_fence?: RoomAgentDeliveryCredentialFence | null;
  delivery_instance_id?: string | null;
}): Promise<RoomAgentDeliverySession | null> {
  const now = new Date().toISOString();
  const graceExpiresAt = new Date(Date.now() + ROOM_AGENT_RECONNECT_GRACE_MS).toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);

  const session = await db.transaction(async (tx) => {
    const credentialActive = !input.agent_session_id || await hasActiveDeliveryCredential(tx, {
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      credential_fence: input.credential_fence,
    });
    if (!credentialActive && !input.delivery_instance_id) return null;
    if (input.delivery_instance_id) {
      await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
      const [released] = await tx.delete(room_agent_delivery_instances)
        .where(and(
          eq(room_agent_delivery_instances.room_id, input.room_id),
          eq(room_agent_delivery_instances.delivery_key, deliveryKey),
          eq(room_agent_delivery_instances.instance_id, input.delivery_instance_id),
          ...(credentialFingerprint
            ? [eq(room_agent_delivery_instances.credential_fingerprint, credentialFingerprint)]
            : []),
        ))
        .returning({ instance_id: room_agent_delivery_instances.instance_id });
      if (!released) {
        const [current] = await tx.select().from(room_agent_delivery_sessions).where(and(
          eq(room_agent_delivery_sessions.room_id, input.room_id),
          eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
        )).limit(1);
        return current ?? null;
      }
      const liveInstanceCount = await countRoomAgentDeliveryInstancesTx(
        tx,
        input.room_id,
        deliveryKey,
      );
      const [disconnected] = await tx.update(room_agent_delivery_sessions)
        .set({
          active_connection_count: sql`GREATEST(
            ${room_agent_delivery_sessions.active_connection_count} - 1,
            ${liveInstanceCount},
            0
          )`,
          last_disconnected_at: now,
          reconnect_grace_expires_at: sql`CASE
            WHEN GREATEST(
              ${room_agent_delivery_sessions.active_connection_count} - 1,
              ${liveInstanceCount}
            ) > 0 THEN NULL
            ELSE ${graceExpiresAt}::timestamptz
          END`,
          updated_at: now,
        })
        .where(and(
          eq(room_agent_delivery_sessions.room_id, input.room_id),
          eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
        ))
        .returning();
      if (disconnected && input.agent_session_id && credentialActive) {
        await tx.update(room_agent_sessions)
          .set({ updated_at: now, last_seen_at: now })
          .where(eq(room_agent_sessions.session_id, input.agent_session_id));
      }
      return disconnected ?? null;
    }
    const [disconnected] = await tx
      .update(room_agent_delivery_sessions)
      .set({
        active_connection_count: sql`GREATEST(${room_agent_delivery_sessions.active_connection_count} - 1, 0)`,
        last_disconnected_at: now,
        reconnect_grace_expires_at: sql`CASE
          WHEN ${room_agent_delivery_sessions.active_connection_count} - 1 > 0 THEN NULL
          ELSE ${graceExpiresAt}::timestamptz
        END`,
        updated_at: now,
      })
      .where(and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, deliveryKey),
        ...(credentialFingerprint
          ? [eq(room_agent_delivery_sessions.credential_fingerprint, credentialFingerprint)]
          : []),
      ))
      .returning();
    if (disconnected && input.agent_session_id) {
      await tx.update(room_agent_sessions)
        .set({ updated_at: now, last_seen_at: now })
        .where(eq(room_agent_sessions.session_id, input.agent_session_id));
    }
    return disconnected ?? null;
  });

  return session ? toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow) : null;
}

export async function forceDisconnectRoomAgentDeliverySession(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<RoomAgentDeliverySession | null> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey({
    actor_label: "",
    agent_session_id: input.agent_session_id,
  });

  const session = await db.transaction(async (tx) => {
    await lockRoomAgentDeliveryInstanceKeyTx(tx, input.room_id, deliveryKey);
    await tx.delete(room_agent_delivery_instances).where(and(
      eq(room_agent_delivery_instances.room_id, input.room_id),
      eq(room_agent_delivery_instances.delivery_key, deliveryKey),
    ));
    const [disconnected] = await tx
      .update(room_agent_delivery_sessions)
      .set({
        active_connection_count: 0,
        last_disconnected_at: now,
        reconnect_grace_expires_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(room_agent_delivery_sessions.room_id, input.room_id),
          eq(room_agent_delivery_sessions.delivery_key, deliveryKey)
        )
      )
      .returning();
    return disconnected;
  });

  return session ? toRoomAgentDeliverySession(session as RoomAgentDeliverySessionRow) : null;
}

export async function getRoomAgentDeliverySessions(
  roomId: string,
  options?: { limit?: number }
): Promise<RoomAgentDeliverySession[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const rows = await db
    .select()
    .from(room_agent_delivery_sessions)
    .where(eq(room_agent_delivery_sessions.room_id, roomId))
    .orderBy(
      desc(room_agent_delivery_sessions.updated_at),
      desc(room_agent_delivery_sessions.active_connection_count),
      desc(room_agent_delivery_sessions.last_connected_at),
      asc(room_agent_delivery_sessions.display_name)
    )
    .limit(limit);

  return (rows as RoomAgentDeliverySessionRow[]).map(toRoomAgentDeliverySession);
}

export async function getReachableWorkerDeliverySessionForAgentSession(input: {
  room_id: string;
  agent_session_id: string;
}): Promise<RoomAgentDeliverySession | null> {
  const [row] = await db
    .select()
    .from(room_agent_delivery_sessions)
    .where(and(
      eq(room_agent_delivery_sessions.room_id, input.room_id),
      eq(room_agent_delivery_sessions.agent_session_id, input.agent_session_id),
      eq(room_agent_delivery_sessions.session_kind, "worker" as RoomAgentSessionKind)
    ))
    .orderBy(desc(room_agent_delivery_sessions.updated_at))
    .limit(1);

  if (!row) {
    return null;
  }

  const session = toRoomAgentDeliverySession(row as RoomAgentDeliverySessionRow);
  return isRoomAgentDeliverySessionReachable(session) ? session : null;
}
