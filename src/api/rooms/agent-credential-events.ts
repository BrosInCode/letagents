import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import type { RoomAgentDeliveryCredentialFence } from "../../shared/agent-presence.js";
import { createBridgedEmitter } from "../server/bridged-emitter.js";

export interface RoomAgentCredentialInvalidation {
  room_id: string;
  agent_session_id: string;
  credential_fingerprints: readonly string[];
  reason: "rotated" | "ended" | "revoked" | "replaced";
}

/** Exact credential retirement; DB mutations relay transactionally and emit locally after commit. */
export const roomAgentCredentialInvalidationEvents = createBridgedEmitter("agent_credentials");
const ROOM_EVENT_CHANNEL = "letagents_room_events";
const MAX_TRANSACTIONAL_CREDENTIAL_ENVELOPE_BYTES = 7_000;

export function roomAgentDeliveryCredentialFingerprint(
  fence: RoomAgentDeliveryCredentialFence | null | undefined,
): string | null {
  if (!fence) return null;
  const value = fence.kind === "session_token"
    ? `session:${fence.token_hash}`
    : `bearer:${fence.bearer_id}:${fence.generation}`;
  return createHash("sha256").update(value).digest("base64url");
}

export function roomAgentDeliveryCredentialEpoch(
  fence: RoomAgentDeliveryCredentialFence | null | undefined,
): number | null {
  return fence?.kind === "bearer" ? fence.generation : null;
}

export function sessionTokenDeliveryCredentialFingerprint(tokenHash: string): string {
  return roomAgentDeliveryCredentialFingerprint({ kind: "session_token", token_hash: tokenHash })!;
}

export function bearerDeliveryCredentialFingerprint(
  bearerId: string,
  generation: number,
): string {
  return roomAgentDeliveryCredentialFingerprint({
    kind: "bearer",
    bearer_id: bearerId,
    generation,
  })!;
}

export function emitRoomAgentCredentialInvalidation(
  invalidation: RoomAgentCredentialInvalidation,
): void {
  const credentialFingerprints = [...new Set(
    invalidation.credential_fingerprints.filter(Boolean),
  )];
  if (credentialFingerprints.length === 0) return;
  roomAgentCredentialInvalidationEvents.emit("invalidate", {
    ...invalidation,
    credential_fingerprints: credentialFingerprints,
  } satisfies RoomAgentCredentialInvalidation);
}

/** Local half of a transactionally relayed invalidation; never republishes. */
export function emitRoomAgentCredentialInvalidationLocal(
  invalidation: RoomAgentCredentialInvalidation,
): void {
  const credentialFingerprints = [...new Set(invalidation.credential_fingerprints.filter(Boolean))];
  if (credentialFingerprints.length === 0) return;
  roomAgentCredentialInvalidationEvents.emitLocal("invalidate", {
    ...invalidation,
    credential_fingerprints: credentialFingerprints,
  } satisfies RoomAgentCredentialInvalidation);
}

/**
 * Queue exact retirement notifications in the credential mutation itself.
 * PostgreSQL emits them only if the transaction commits, closing the
 * commit-to-JavaScript-emitter crash window for remote API instances.
 */
export async function queueRoomAgentCredentialInvalidationsTx(
  tx: { execute(query: unknown): Promise<unknown> },
  invalidations: readonly RoomAgentCredentialInvalidation[],
): Promise<void> {
  for (const invalidation of invalidations) {
    const credentialFingerprints = [...new Set(invalidation.credential_fingerprints.filter(Boolean))];
    if (credentialFingerprints.length === 0) continue;
    const origin = `credential-tx:${randomUUID()}`;
    const chunks: string[][] = [];
    let chunk: string[] = [];
    for (const fingerprint of credentialFingerprints) {
      const candidate = [...chunk, fingerprint];
      if (transactionalCredentialEnvelopeBytes(invalidation, candidate, origin)
        <= MAX_TRANSACTIONAL_CREDENTIAL_ENVELOPE_BYTES) {
        chunk = candidate;
        continue;
      }
      if (chunk.length === 0) {
        // Legacy room/session identifiers predate the bounded bridge contract.
        // If even one exact invalidation cannot fit, retain a compact global
        // loss fence in this transaction so every remote lease revalidates its
        // durable credential before another body instead of rolling back the
        // credential mutation.
        await tx.execute(sql`SELECT pg_notify(${ROOM_EVENT_CHANNEL}, ${transactionalCredentialLossEnvelope(origin)})`);
        chunk = [];
        break;
      }
      chunks.push(chunk);
      chunk = [fingerprint];
      if (transactionalCredentialEnvelopeBytes(invalidation, chunk, origin)
        > MAX_TRANSACTIONAL_CREDENTIAL_ENVELOPE_BYTES) {
        // Preserve already-completed exact chunks, but fence the unencodable
        // remainder globally. PostgreSQL publishes this marker before those
        // exact chunks because all notifications share the mutation commit.
        await tx.execute(sql`SELECT pg_notify(${ROOM_EVENT_CHANNEL}, ${transactionalCredentialLossEnvelope(origin)})`);
        chunk = [];
        break;
      }
    }
    if (chunk.length > 0) chunks.push(chunk);
    for (const credentialChunk of chunks) {
      const envelope = transactionalCredentialEnvelope(invalidation, credentialChunk, origin);
      await tx.execute(sql`SELECT pg_notify(${ROOM_EVENT_CHANNEL}, ${envelope})`);
    }
  }
}

function transactionalCredentialLossEnvelope(origin: string): string {
  return JSON.stringify({
    v: 1,
    mode: "loss",
    losses: [{ room_id: null, epoch: 1 }],
    origin,
  });
}

function transactionalCredentialEnvelope(
  invalidation: RoomAgentCredentialInvalidation,
  credentialFingerprints: readonly string[],
  origin: string,
): string {
  return JSON.stringify({
    v: 1,
    lane: "agent_credentials",
    event: "invalidate",
    mode: "inline",
    data: { ...invalidation, credential_fingerprints: credentialFingerprints },
    origin,
  });
}

function transactionalCredentialEnvelopeBytes(
  invalidation: RoomAgentCredentialInvalidation,
  credentialFingerprints: readonly string[],
  origin: string,
): number {
  return Buffer.byteLength(
    transactionalCredentialEnvelope(invalidation, credentialFingerprints, origin),
    "utf8",
  );
}
