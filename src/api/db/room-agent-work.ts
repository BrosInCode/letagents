import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { parseRoomAgentWorkSummary, type RoomAgentWork } from "../../shared/room-agent-work.js";
import { db } from "./client.js";
import { message_agent_receipts, messages, room_agent_sessions, room_agent_work, supervisor_host_grants } from "./schema.js";
import { assertSupervisorGrantFenceTx, SupervisorGrantFenceStaleError, type SupervisorGrantFence } from "./auth/supervisor-grants.js";
import { visibleMessageCondition } from "./messages/visibility.js";

export class RoomAgentWorkError extends Error {
  constructor(readonly code: "invalid_summary" | "publisher_not_authorized" | "publisher_conflict" | "revision_conflict") {
    super(`Room work evidence rejected: ${code}.`);
  }
}

function publicWork(row: typeof room_agent_work.$inferSelect): RoomAgentWork {
  const summary = parseRoomAgentWorkSummary(row.summary);
  if (!summary) throw new RoomAgentWorkError("invalid_summary");
  return {
    attempt_id: row.attempt_id, room_id: row.room_id, source_message_id: `msg_${row.source_message_number}`,
    agent_key: row.agent_key, revision: row.publisher_revision, summary, updated_at: row.updated_at,
  };
}

/**
 * Admission is evidence publication, not permission to execute. Serialize on
 * the captured receipt, then reverify the exact live publisher in the same
 * transaction. A later second session does not retroactively revoke a write;
 * immutable custody prevents it taking over the existing attempt.
 */
export async function publishRoomAgentWork(input: {
  fence: SupervisorGrantFence; room_id: string; session_id: string;
  source_message_number: number; revision: number; summary: unknown;
}): Promise<{ status: "created" | "updated" | "replayed"; work: RoomAgentWork }> {
  const summary = parseRoomAgentWorkSummary(input.summary);
  if (!summary || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !Number.isSafeInteger(input.source_message_number) || input.source_message_number < 1) {
    throw new RoomAgentWorkError("invalid_summary");
  }
  const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  return db.transaction(async (tx) => {
    if (!(await assertSupervisorGrantFenceTx(tx, input.fence))) throw new SupervisorGrantFenceStaleError();
    // Reprovisioning can rotate token_version under the installation advisory
    // lock instead. This row lock also fences that path through commit.
    const [grant] = await tx.select().from(supervisor_host_grants)
      .where(eq(supervisor_host_grants.grant_id, input.fence.grant_id)).for("share");
    if (!grant || grant.current_generation !== input.fence.generation || grant.token_version !== input.fence.token_version
      || grant.revoked_at || Date.parse(grant.expires_at) <= Date.now()) throw new SupervisorGrantFenceStaleError();
    if (grant.scope_key !== "owner" || grant.rental_session_id || !grant.allowed_room_ids.includes(input.room_id)) {
      throw new RoomAgentWorkError("publisher_not_authorized");
    }
    const [candidate] = await tx.select().from(room_agent_sessions)
      .where(eq(room_agent_sessions.session_id, input.session_id));
    if (!candidate || !grant.allowed_agent_keys.includes(candidate.agent_key)) throw new RoomAgentWorkError("publisher_not_authorized");
    const receiptWhere = and(eq(message_agent_receipts.message_room_id, input.room_id),
      eq(message_agent_receipts.message_number, input.source_message_number), eq(message_agent_receipts.agent_key, candidate.agent_key));
    const [capturedReceipt] = await tx.select().from(message_agent_receipts).where(receiptWhere);
    if (!capturedReceipt) throw new RoomAgentWorkError("publisher_not_authorized");
    // Match lifecycle lock order: sessions (sorted), then receipts. Taking the
    // receipt first could deadlock with owner-driven retirement's receipt sweep.
    const sessions = await tx.select().from(room_agent_sessions)
      .where(inArray(room_agent_sessions.session_id, [input.session_id, capturedReceipt.agent_session_id]))
      .orderBy(asc(room_agent_sessions.session_id)).for("share");
    const publisher = sessions.find((session) => session.session_id === input.session_id);
    const captured = sessions.find((session) => session.session_id === capturedReceipt.agent_session_id);
    if (!publisher || !captured || publisher.room_id !== input.room_id || captured.room_id !== input.room_id
      || publisher.agent_key !== candidate.agent_key || captured.agent_key !== candidate.agent_key
      || publisher.owner_account_id !== grant.owner_account_id || captured.owner_account_id !== grant.owner_account_id
      || publisher.session_kind !== "worker" || captured.session_kind !== "worker"
      || publisher.supervisor_grant_id !== grant.grant_id || publisher.ended_at || !publisher.agent_instance_id) {
      throw new RoomAgentWorkError("publisher_not_authorized");
    }
    // Deletion/pruning locks the source before cascading to its receipts.
    const [source] = await tx.select({ visibility: messages.visibility, rental: messages.rental_session_id }).from(messages)
      .where(and(eq(messages.room_id, input.room_id), eq(messages.number, input.source_message_number))).for("share");
    // Rental projection has a separate participant visibility domain. It is
    // deliberately not admitted by this owner-host foundation.
    if (!source || source.visibility !== null || source.rental !== null) throw new RoomAgentWorkError("publisher_not_authorized");
    const [receipt] = await tx.select().from(message_agent_receipts).where(receiptWhere).for("update");
    if (!receipt || receipt.agent_session_id !== captured.session_id || receipt.room_id !== input.room_id) {
      throw new RoomAgentWorkError("publisher_not_authorized");
    }
    if (captured.ended_at) {
      // Re-read after acquiring the receipt's write lock, not from an earlier
      // routing snapshot. All same-key workers count, including foreign owners.
      const active = await tx.select({ id: room_agent_sessions.session_id }).from(room_agent_sessions)
        .where(and(eq(room_agent_sessions.room_id, input.room_id), eq(room_agent_sessions.agent_key, publisher.agent_key),
          eq(room_agent_sessions.session_kind, "worker"), isNull(room_agent_sessions.ended_at))).limit(2);
      if (active.length !== 1 || active[0].id !== publisher.session_id) throw new RoomAgentWorkError("publisher_not_authorized");
    } else if (captured.session_id !== publisher.session_id) throw new RoomAgentWorkError("publisher_not_authorized");
    if (Date.parse(grant.expires_at) <= Date.now()) throw new SupervisorGrantFenceStaleError();
    const identity = and(eq(room_agent_work.room_id, input.room_id),
      eq(room_agent_work.source_message_number, input.source_message_number), eq(room_agent_work.agent_key, publisher.agent_key));
    const [existing] = await tx.select().from(room_agent_work).where(identity);
    if (existing) {
      if (existing.owner_account_id !== grant.owner_account_id || existing.host_id !== grant.host_id
        || existing.installation_id !== grant.installation_id || existing.agent_instance_id !== publisher.agent_instance_id) {
        throw new RoomAgentWorkError("publisher_conflict");
      }
      if (input.revision < existing.publisher_revision || (input.revision === existing.publisher_revision && digest !== existing.summary_digest)) {
        throw new RoomAgentWorkError("revision_conflict");
      }
      if (input.revision === existing.publisher_revision) return { status: "replayed", work: publicWork(existing) };
      const [updated] = await tx.update(room_agent_work).set({ publisher_revision: input.revision, summary_digest: digest, summary,
        updated_at: new Date().toISOString() }).where(identity).returning();
      return { status: "updated", work: publicWork(updated) };
    }
    const [created] = await tx.insert(room_agent_work).values({
      attempt_id: randomUUID(), room_id: input.room_id, source_message_number: input.source_message_number,
      agent_key: publisher.agent_key, owner_account_id: grant.owner_account_id, host_id: grant.host_id,
      installation_id: grant.installation_id, agent_instance_id: publisher.agent_instance_id,
      publisher_revision: input.revision, summary_digest: digest, summary, updated_at: new Date().toISOString(),
    }).returning();
    return { status: "created", work: publicWork(created) };
  });
}

/** Authorized human room readers only; the route performs current membership checks. */
export async function readRoomAgentWork(input: { room_id: string; attempt_id?: string }): Promise<{ work: RoomAgentWork[]; truncated: boolean }> {
  const rows = await db.select({ work: room_agent_work }).from(room_agent_work)
    .innerJoin(messages, and(eq(messages.room_id, room_agent_work.room_id), eq(messages.number, room_agent_work.source_message_number)))
    .where(and(eq(room_agent_work.room_id, input.room_id),
      ...(input.attempt_id ? [eq(room_agent_work.attempt_id, input.attempt_id)] : []),
      visibleMessageCondition(false), isNull(messages.visibility), isNull(messages.rental_session_id)))
    .orderBy(desc(room_agent_work.updated_at), asc(room_agent_work.attempt_id)).limit(input.attempt_id ? 1 : 51);
  return { work: rows.slice(0, 50).map((row) => publicWork(row.work)), truncated: rows.length > 50 };
}
