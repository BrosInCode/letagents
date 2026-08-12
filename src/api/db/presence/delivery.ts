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
          active_connection_count: sql`CASE
            WHEN ${room_agent_delivery_sessions.updated_at} < ${staleConnectionCutoff}::timestamptz THEN 1
            ELSE GREATEST(${room_agent_delivery_sessions.active_connection_count}, 0) + 1
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
}): Promise<boolean> {
  const now = new Date().toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);
  return db.transaction(async (tx) => {
    if (
      input.agent_session_id
      && !(await hasActiveDeliveryCredential(tx, {
        room_id: input.room_id,
        agent_session_id: input.agent_session_id,
        credential_fence: input.credential_fence,
      }))
    ) {
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
        active_connection_count: 1,
        last_disconnected_at: null,
        reconnect_grace_expires_at: null,
        updated_at: now,
      },
    })
      .returning();
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
}): Promise<RoomAgentDeliverySession | null> {
  const now = new Date().toISOString();
  const graceExpiresAt = new Date(Date.now() + ROOM_AGENT_RECONNECT_GRACE_MS).toISOString();
  const deliveryKey = buildRoomAgentDeliveryKey(input);
  const credentialFingerprint = roomAgentDeliveryCredentialFingerprint(input.credential_fence);

  const session = await db.transaction(async (tx) => {
    if (
      input.agent_session_id
      && !(await hasActiveDeliveryCredential(tx, {
        room_id: input.room_id,
        agent_session_id: input.agent_session_id,
        credential_fence: input.credential_fence,
      }))
    ) return null;
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

  const [session] = await db
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
