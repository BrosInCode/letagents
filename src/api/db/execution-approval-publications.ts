import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";

import {
  parseExecutionApprovalPublicationInput,
  parseExecutionApprovalPublicationItem,
  parseExecutionApprovalPublicationReceipt,
  parseExecutionApprovalPublicationCloseReceipt,
  executionApprovalPublicationSha256,
  isExecutionApprovalPublicationDigest,
  isExecutionApprovalPublicationIdentity,
  type ExecutionApprovalPublicationCloseReceipt,
  type ExecutionApprovalPublicationInput,
  type ExecutionApprovalPublicationItem,
  type ExecutionApprovalPublicationReceipt,
} from "../../../shared/execution-approval-publication.mjs";
import { EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS } from "../../../shared/execution-delegation-decision.mjs";
import { db } from "./client.js";
import { visibleMessageCondition } from "./messages/visibility.js";
import {
  execution_approval_publications,
  execution_delegation_decisions,
  execution_delegation_grants,
  messages,
  room_agent_sessions,
  room_agent_work,
  supervisor_host_grants,
} from "./schema.js";
import {
  assertSupervisorGrantFenceTx,
  SupervisorGrantFenceStaleError,
  type SupervisorGrantFence,
} from "./auth/supervisor-grants.js";

const PUBLICATION_PAGE_SIZE = 50;
const PUBLICATION_PRUNE_LIMIT = 500;
// The native broker admits at most 32 concurrent requests. Eight complete
// broker windows remain bounded without making ordinary retry churn visible.
const PUBLICATION_INSTANCE_CAP = 256;

export class ExecutionApprovalPublicationError extends Error {
  constructor(readonly code:
    | "invalid_publication"
    | "publisher_not_authorized"
    | "delegation_revision_conflict"
    | "publication_conflict"
    | "publication_terminal"
    | "publication_work_not_ready"
    | "publication_capacity") {
    super(`Execution approval publication rejected: ${code}.`);
    this.name = "ExecutionApprovalPublicationError";
  }
}

type PublicationRow = typeof execution_approval_publications.$inferSelect;

function publicItem(row: PublicationRow, roomId: string, agentKey: string): ExecutionApprovalPublicationItem {
  const item = parseExecutionApprovalPublicationItem({
    publication_id: row.publication_id,
    room_id: roomId,
    agent_key: agentKey,
    delegation_instance_id: row.delegation_instance_id,
    delegation_revision: row.delegation_revision,
    request_id: row.request_id,
    request_version: row.request_version,
    request_sha256: row.request_sha256,
    projection_sha256: row.projection_sha256,
    published_at: new Date(row.published_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  });
  if (!item) throw new Error("Stored execution approval publication violated the public wire contract.");
  return item;
}

function receipt(
  status: "created" | "replayed",
  row: PublicationRow,
  roomId: string,
  agentKey: string,
): ExecutionApprovalPublicationReceipt {
  const value = parseExecutionApprovalPublicationReceipt({
    status,
    publication_digest: row.publication_digest,
    publication: publicItem(row, roomId, agentKey),
  });
  if (!value) throw new Error("Stored execution approval receipt violated the public wire contract.");
  return value;
}

function closeReceipt(
  status: "closed" | "replayed",
  row: PublicationRow,
): ExecutionApprovalPublicationCloseReceipt {
  const value = parseExecutionApprovalPublicationCloseReceipt({
    status,
    publication_id: row.publication_id,
    publication_digest: row.publication_digest,
    closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  });
  if (!value) throw new Error("Stored execution approval closure violated the public wire contract.");
  return value;
}

/**
 * Persist the exact delegate-visible bytes only after revalidating the current
 * host, worker, recorded-work custody, source visibility, and delegation row
 * in one transaction. This records an approval request; it does not decide it.
 */
export async function publishExecutionApprovalPublication(input: {
  fence: SupervisorGrantFence;
  session_id: string;
  publication: ExecutionApprovalPublicationInput;
  now?: Date;
}): Promise<ExecutionApprovalPublicationReceipt> {
  const publication = parseExecutionApprovalPublicationInput(input.publication);
  if (!publication) throw new ExecutionApprovalPublicationError("invalid_publication");
  const projectionDigest = createHash("sha256").update(publication.projection_json).digest("hex");
  if (projectionDigest !== publication.projection_sha256) {
    throw new ExecutionApprovalPublicationError("invalid_publication");
  }
  const publicationDigest = executionApprovalPublicationSha256(publication);
  if (!publicationDigest) throw new ExecutionApprovalPublicationError("invalid_publication");
  const sourceMessageNumber = Number(publication.source_message_id.slice(4));
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  return db.transaction(async (tx) => {
    if (!(await assertSupervisorGrantFenceTx(tx, input.fence))) throw new SupervisorGrantFenceStaleError();
    const [grant] = await tx.select().from(supervisor_host_grants)
      .where(eq(supervisor_host_grants.grant_id, input.fence.grant_id)).for("share");
    if (!grant || grant.current_generation !== input.fence.generation
      || grant.token_version !== input.fence.token_version || grant.revoked_at
      || Date.parse(grant.expires_at) <= now.getTime()) throw new SupervisorGrantFenceStaleError();
    if (grant.scope_key !== "owner" || grant.rental_session_id
      || !grant.allowed_room_ids.includes(publication.room_id)) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }

    const [session] = await tx.select().from(room_agent_sessions)
      .where(eq(room_agent_sessions.session_id, input.session_id)).for("share");
    if (!session || session.session_kind !== "worker" || session.ended_at || !session.agent_instance_id
      || session.room_id !== publication.room_id || session.owner_account_id !== grant.owner_account_id
      || session.supervisor_grant_id !== grant.grant_id
      || !grant.allowed_agent_keys.includes(session.agent_key)) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }

    // Match cascade/clear ordering: source before recorded work.
    const [source] = await tx.select({ number: messages.number }).from(messages).where(and(
      eq(messages.room_id, publication.room_id),
      eq(messages.number, sourceMessageNumber),
      visibleMessageCondition(false),
      isNull(messages.visibility),
      isNull(messages.rental_session_id),
    )).for("share");
    if (!source) throw new ExecutionApprovalPublicationError("publisher_not_authorized");

    const [work] = await tx.select().from(room_agent_work).where(and(
      eq(room_agent_work.room_id, publication.room_id),
      eq(room_agent_work.source_message_number, sourceMessageNumber),
      eq(room_agent_work.agent_key, session.agent_key),
    )).for("share");
    if (!work) throw new ExecutionApprovalPublicationError("publication_work_not_ready");
    if (work.owner_account_id !== grant.owner_account_id || work.host_id !== grant.host_id
      || work.installation_id !== grant.installation_id
      || work.agent_instance_id !== session.agent_instance_id) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }

    const requestLock = `execution_approval_publication:${publication.delegation_instance_id}:${publication.delegation_revision}:${publication.request_id}:${publication.request_version}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestLock}, 0))`);
    const identity = and(
      eq(execution_approval_publications.delegation_instance_id, publication.delegation_instance_id),
      eq(execution_approval_publications.delegation_revision, publication.delegation_revision),
      eq(execution_approval_publications.request_id, publication.request_id),
      eq(execution_approval_publications.request_version, publication.request_version),
    );
    const [existing] = await tx.select().from(execution_approval_publications).where(identity).limit(1);
    if (existing) {
      if (existing.publication_digest !== publicationDigest) {
        throw new ExecutionApprovalPublicationError("publication_conflict");
      }
      // A committed response may be lost just before delegation revocation.
      // Current publisher/work custody was re-proved above; acknowledge the
      // immutable receipt while the request remains actionable.
      if (Date.parse(existing.expires_at) <= now.getTime()) {
        throw new ExecutionApprovalPublicationError("publication_terminal");
      }
      return receipt("replayed", existing, work.room_id, work.agent_key);
    }

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_instance:${publication.delegation_instance_id}`}, 0))`);
    const [delegation] = await tx.select().from(execution_delegation_grants).where(
      eq(execution_delegation_grants.delegation_instance_id, publication.delegation_instance_id),
    ).orderBy(desc(execution_delegation_grants.revision)).for("update").limit(1);
    if (!delegation || delegation.owner_account_id !== grant.owner_account_id
      || delegation.host_id !== grant.host_id || delegation.installation_id !== grant.installation_id
      || delegation.scope_key !== "owner" || delegation.room_id !== publication.room_id
      || delegation.agent_key !== session.agent_key || delegation.category !== "file_change"
      || delegation.risk_ceiling !== "low") {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }
    if (delegation.revision !== publication.delegation_revision || delegation.retired_at) {
      throw new ExecutionApprovalPublicationError("delegation_revision_conflict");
    }
    if (delegation.revoked_at || delegation.expired_at || Date.parse(delegation.expires_at) <= now.getTime()) {
      throw new ExecutionApprovalPublicationError("publication_terminal");
    }

    const expiresAt = Date.parse(publication.expires_at);
    // produced_at is host-clock evidence; published_at is server-clock
    // evidence. Never compare those clocks with each other.
    if (expiresAt <= now.getTime()
      || expiresAt > now.getTime() + EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS
      || expiresAt > Date.parse(delegation.expires_at)) {
      throw new ExecutionApprovalPublicationError("publication_terminal");
    }

    const [capacity] = await tx.select({
      count: sql<number>`count(*)::integer`,
    }).from(execution_approval_publications).where(and(
      eq(execution_approval_publications.delegation_instance_id, publication.delegation_instance_id),
      gt(execution_approval_publications.expires_at, nowIso),
    ));
    if (Number(capacity?.count ?? 0) >= PUBLICATION_INSTANCE_CAP) {
      throw new ExecutionApprovalPublicationError("publication_capacity");
    }

    const [created] = await tx.insert(execution_approval_publications).values({
      publication_id: `execution_approval_publication_${randomUUID()}`,
      room_agent_work_attempt_id: work.attempt_id,
      delegation_instance_id: publication.delegation_instance_id,
      delegation_revision: publication.delegation_revision,
      request_id: publication.request_id,
      request_version: publication.request_version,
      request_sha256: publication.request_sha256,
      projection_sha256: publication.projection_sha256,
      projection_json: publication.projection_json,
      publication_digest: publicationDigest,
      produced_at: publication.produced_at,
      published_at: nowIso,
      expires_at: publication.expires_at,
    }).returning();
    return receipt("created", created, work.room_id, work.agent_key);
  });
}

/**
 * Record only that the current host no longer considers the publication
 * actionable. The host's allow/deny outcome never crosses this boundary.
 */
export async function closeExecutionApprovalPublication(input: {
  fence: SupervisorGrantFence;
  session_id: string;
  publication_id: string;
  publication_digest: string;
  now?: Date;
}): Promise<{ receipt: ExecutionApprovalPublicationCloseReceipt; room_id: string }> {
  if (!isExecutionApprovalPublicationIdentity(input.publication_id)
    || !isExecutionApprovalPublicationDigest(input.publication_digest)) {
    throw new ExecutionApprovalPublicationError("invalid_publication");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  return db.transaction(async (tx) => {
    if (!(await assertSupervisorGrantFenceTx(tx, input.fence))) throw new SupervisorGrantFenceStaleError();
    const [grant] = await tx.select().from(supervisor_host_grants)
      .where(eq(supervisor_host_grants.grant_id, input.fence.grant_id)).for("share");
    if (!grant || grant.current_generation !== input.fence.generation
      || grant.token_version !== input.fence.token_version || grant.revoked_at
      || Date.parse(grant.expires_at) <= now.getTime() || grant.scope_key !== "owner"
      || grant.rental_session_id) throw new SupervisorGrantFenceStaleError();

    const [session] = await tx.select().from(room_agent_sessions)
      .where(eq(room_agent_sessions.session_id, input.session_id)).for("share");
    if (!session || session.session_kind !== "worker" || session.ended_at || !session.agent_instance_id
      || session.owner_account_id !== grant.owner_account_id
      || session.supervisor_grant_id !== grant.grant_id
      || !grant.allowed_room_ids.includes(session.room_id)
      || !grant.allowed_agent_keys.includes(session.agent_key)) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }

    const [candidate] = await tx.select({
      delegation_instance_id: execution_approval_publications.delegation_instance_id,
      delegation_revision: execution_approval_publications.delegation_revision,
      request_id: execution_approval_publications.request_id,
      request_version: execution_approval_publications.request_version,
      publication_digest: execution_approval_publications.publication_digest,
      room_id: room_agent_work.room_id,
      agent_key: room_agent_work.agent_key,
      owner_account_id: room_agent_work.owner_account_id,
      host_id: room_agent_work.host_id,
      installation_id: room_agent_work.installation_id,
      agent_instance_id: room_agent_work.agent_instance_id,
    }).from(execution_approval_publications)
      .innerJoin(
        room_agent_work,
        eq(room_agent_work.attempt_id, execution_approval_publications.room_agent_work_attempt_id),
      )
      .where(eq(execution_approval_publications.publication_id, input.publication_id))
      .limit(1);
    if (!candidate) throw new ExecutionApprovalPublicationError("publication_terminal");
    if (candidate.room_id !== session.room_id || candidate.agent_key !== session.agent_key
      || candidate.owner_account_id !== grant.owner_account_id
      || candidate.host_id !== grant.host_id || candidate.installation_id !== grant.installation_id
      || candidate.agent_instance_id !== session.agent_instance_id) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }
    if (candidate.publication_digest !== input.publication_digest) {
      throw new ExecutionApprovalPublicationError("publication_conflict");
    }

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${
      `execution_delegation_approval:${candidate.delegation_instance_id}:${candidate.delegation_revision}:${candidate.request_id}:${candidate.request_version}`
    }, 0))`);
    const [record] = await tx.select({
      publication: execution_approval_publications,
      work: room_agent_work,
    }).from(execution_approval_publications)
      .innerJoin(
        room_agent_work,
        eq(room_agent_work.attempt_id, execution_approval_publications.room_agent_work_attempt_id),
      )
      .where(eq(execution_approval_publications.publication_id, input.publication_id))
      .for("update")
      .limit(1);
    if (!record) throw new ExecutionApprovalPublicationError("publication_terminal");
    if (record.work.room_id !== session.room_id || record.work.agent_key !== session.agent_key
      || record.work.owner_account_id !== grant.owner_account_id
      || record.work.host_id !== grant.host_id || record.work.installation_id !== grant.installation_id
      || record.work.agent_instance_id !== session.agent_instance_id) {
      throw new ExecutionApprovalPublicationError("publisher_not_authorized");
    }
    if (record.publication.publication_digest !== input.publication_digest) {
      throw new ExecutionApprovalPublicationError("publication_conflict");
    }
    if (record.publication.closed_at) return {
      receipt: closeReceipt("replayed", record.publication),
      room_id: record.work.room_id,
    };

    const [closed] = await tx.update(execution_approval_publications)
      .set({ closed_at: nowIso })
      .where(and(
        eq(execution_approval_publications.publication_id, input.publication_id),
        isNull(execution_approval_publications.closed_at),
      ))
      .returning();
    if (!closed) throw new ExecutionApprovalPublicationError("publication_terminal");
    return {
      receipt: closeReceipt("closed", closed),
      room_id: record.work.room_id,
    };
  });
}

/**
 * Delete a bounded batch once the request can no longer be decided or replayed.
 * Terminal delegations remain until request expiry so a lost publish response
 * can still receive its immutable receipt.
 */
export async function pruneExpiredExecutionApprovalPublications(
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = (options.now ?? new Date()).toISOString();
  const limit = Math.max(1, Math.min(
    PUBLICATION_PRUNE_LIMIT,
    Math.floor(options.limit ?? PUBLICATION_PRUNE_LIMIT),
  ));
  const result = await db.execute<{ publication_id: string }>(sql`
    WITH candidates AS (
      SELECT ${execution_approval_publications.publication_id}
      FROM ${execution_approval_publications}
      WHERE ${execution_approval_publications.expires_at} <= ${now}
      ORDER BY ${execution_approval_publications.expires_at}, ${execution_approval_publications.publication_id}
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${execution_approval_publications}
    USING candidates
    WHERE ${execution_approval_publications.publication_id} = candidates.publication_id
    RETURNING ${execution_approval_publications.publication_id}
  `);
  return result.rows.length;
}

const readablePublication = (nowIso: string) => and(
  isNull(execution_approval_publications.closed_at),
  isNull(execution_delegation_grants.retired_at),
  isNull(execution_delegation_grants.revoked_at),
  isNull(execution_delegation_grants.expired_at),
  gt(execution_delegation_grants.expires_at, nowIso),
  gt(execution_approval_publications.expires_at, nowIso),
  notExists(db.select({ one: sql`1` }).from(execution_delegation_decisions).where(and(
    eq(execution_delegation_decisions.delegation_instance_id, execution_approval_publications.delegation_instance_id),
    eq(execution_delegation_decisions.delegation_revision, execution_approval_publications.delegation_revision),
    eq(execution_delegation_decisions.request_id, execution_approval_publications.request_id),
    eq(execution_delegation_decisions.request_version, execution_approval_publications.request_version),
    eq(execution_delegation_decisions.request_sha256, execution_approval_publications.request_sha256),
    eq(execution_delegation_decisions.projection_sha256, execution_approval_publications.projection_sha256),
  ))),
  visibleMessageCondition(false),
  isNull(messages.visibility),
  isNull(messages.rental_session_id),
);

const publicColumns = {
  publication: execution_approval_publications,
  room_id: room_agent_work.room_id,
  agent_key: room_agent_work.agent_key,
};

function readablePublicationQuery(nowIso: string) {
  return db.select(publicColumns).from(execution_approval_publications)
    .innerJoin(execution_delegation_grants, and(
      eq(execution_delegation_grants.delegation_instance_id, execution_approval_publications.delegation_instance_id),
      eq(execution_delegation_grants.revision, execution_approval_publications.delegation_revision),
    ))
    .innerJoin(room_agent_work, eq(room_agent_work.attempt_id, execution_approval_publications.room_agent_work_attempt_id))
    .innerJoin(messages, and(
      eq(messages.room_id, room_agent_work.room_id),
      eq(messages.number, room_agent_work.source_message_number),
    ));
}

/** Current designated-approver view; route membership is checked separately. */
export async function listExecutionApprovalPublicationsForApprover(input: {
  room_id: string;
  approver_account_id: string;
  after?: string | null;
  now?: Date;
}): Promise<{ publications: ExecutionApprovalPublicationItem[]; next_cursor: string | null }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  let afterCondition;
  if (input.after) {
    const [cursor] = await readablePublicationQuery(nowIso).where(and(
      readablePublication(nowIso),
      eq(execution_delegation_grants.room_id, input.room_id),
      eq(execution_delegation_grants.approver_account_id, input.approver_account_id),
      eq(execution_approval_publications.publication_id, input.after),
    )).limit(1);
    if (!cursor) throw new ExecutionApprovalPublicationError("invalid_publication");
    afterCondition = or(
      lt(execution_approval_publications.published_at, cursor.publication.published_at),
      and(
        eq(execution_approval_publications.published_at, cursor.publication.published_at),
        lt(execution_approval_publications.publication_id, cursor.publication.publication_id),
      ),
    );
  }
  const rows = await readablePublicationQuery(nowIso)
    .where(and(
      readablePublication(nowIso),
      eq(execution_delegation_grants.room_id, input.room_id),
      eq(execution_delegation_grants.approver_account_id, input.approver_account_id),
      afterCondition,
    ))
    .orderBy(desc(execution_approval_publications.published_at), desc(execution_approval_publications.publication_id))
    .limit(PUBLICATION_PAGE_SIZE + 1);
  const page = rows.slice(0, PUBLICATION_PAGE_SIZE);
  return {
    publications: page
      .map((row) => publicItem(row.publication, row.room_id, row.agent_key)),
    next_cursor: rows.length > PUBLICATION_PAGE_SIZE
      ? page.at(-1)?.publication.publication_id ?? null
      : null,
  };
}

/** Exact canonical bytes for the exact designated approver, or concealed null. */
export async function getExecutionApprovalPublicationForApprover(input: {
  room_id: string;
  approver_account_id: string;
  publication_id: string;
  now?: Date;
}): Promise<{ publication: ExecutionApprovalPublicationItem; projection_json: string } | null> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const [row] = await readablePublicationQuery(nowIso).where(and(
    readablePublication(nowIso),
    eq(execution_delegation_grants.room_id, input.room_id),
    eq(execution_delegation_grants.approver_account_id, input.approver_account_id),
    eq(execution_approval_publications.publication_id, input.publication_id),
  )).limit(1);
  return row ? {
    publication: publicItem(row.publication, row.room_id, row.agent_key),
    projection_json: row.publication.projection_json,
  } : null;
}
