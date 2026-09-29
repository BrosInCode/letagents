import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import {
  EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS,
  isExecutionDelegationDecision,
  isExecutionDelegationDigest,
  isExecutionDelegationIdentity,
  isExecutionDelegationPositiveInt32,
} from "../../../shared/execution-delegation-decision.mjs";

import { db } from "./client.js";
import {
  execution_approval_publications,
  execution_delegation_decisions,
  execution_delegation_grants,
} from "./schema.js";
import { executionDelegationSha256 } from "./execution-delegation-digests.js";
import type {
  ExecutionDelegationDecision,
  ExecutionDelegationDecisionChoice,
  ExecutionDelegationDecisionForHost,
} from "./types.js";

const HOST_INVENTORY_PAGE_SIZE = 100;

export class ExecutionDelegationDecisionAuthorityError extends Error {
  readonly code = "execution_delegation_decision_authority_invalid";

  constructor() {
    super("The execution delegation decision is not authorized.");
    this.name = "ExecutionDelegationDecisionAuthorityError";
  }
}

export class ExecutionDelegationDecisionConflictError extends Error {
  readonly code = "execution_delegation_decision_conflict";

  constructor() {
    super("A decision is already recorded for this exact approval request.");
    this.name = "ExecutionDelegationDecisionConflictError";
  }
}

export class ExecutionDelegationDecisionIdempotencyConflictError extends Error {
  readonly code = "execution_delegation_decision_idempotency_conflict";

  constructor() {
    super("The decision request key is already bound to a different request.");
    this.name = "ExecutionDelegationDecisionIdempotencyConflictError";
  }
}

export class ExecutionDelegationDecisionRevisionConflictError extends Error {
  readonly code = "execution_delegation_decision_revision_conflict";

  constructor() {
    super("The execution delegation changed before this decision was recorded.");
    this.name = "ExecutionDelegationDecisionRevisionConflictError";
  }
}

export class ExecutionDelegationDecisionTerminalError extends Error {
  readonly code = "execution_delegation_decision_terminal";

  constructor() {
    super("The execution delegation is no longer active.");
    this.name = "ExecutionDelegationDecisionTerminalError";
  }
}

export class ExecutionDelegationDecisionPublicationClosedError extends Error {
  readonly code = "execution_delegation_decision_publication_closed";

  constructor() {
    super("The host no longer considers this approval publication actionable.");
    this.name = "ExecutionDelegationDecisionPublicationClosedError";
  }
}

export interface AdmitExecutionDelegationDecisionInput {
  actor_account_id: string;
  delegation_instance_id: string;
  expected_revision: number;
  request_id: string;
  request_version: number;
  request_sha256: string;
  projection_sha256: string;
  decision: ExecutionDelegationDecisionChoice;
  client_request_id: string;
}

function validInput(input: AdmitExecutionDelegationDecisionInput): boolean {
  return isExecutionDelegationIdentity(input.actor_account_id)
    && isExecutionDelegationIdentity(input.delegation_instance_id)
    && isExecutionDelegationIdentity(input.request_id)
    && isExecutionDelegationIdentity(input.client_request_id)
    && isExecutionDelegationPositiveInt32(input.expected_revision)
    && isExecutionDelegationPositiveInt32(input.request_version)
    && isExecutionDelegationDigest(input.request_sha256)
    && isExecutionDelegationDigest(input.projection_sha256)
    && isExecutionDelegationDecision(input.decision);
}

function toDecision(
  row: typeof execution_delegation_decisions.$inferSelect,
): ExecutionDelegationDecision {
  return {
    ...row,
    decision: row.decision as ExecutionDelegationDecisionChoice,
  };
}

export async function admitExecutionDelegationDecision(
  input: AdmitExecutionDelegationDecisionInput,
): Promise<{ status: "created" | "replayed"; decision: ExecutionDelegationDecision; room_id: string }> {
  if (!validInput(input)) throw new ExecutionDelegationDecisionAuthorityError();
  const requestFingerprint = executionDelegationSha256({
    actor_account_id: input.actor_account_id,
    delegation_instance_id: input.delegation_instance_id,
    expected_revision: input.expected_revision,
    request_id: input.request_id,
    request_version: input.request_version,
    request_sha256: input.request_sha256,
    projection_sha256: input.projection_sha256,
    decision: input.decision,
  });

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_decision_request:${input.actor_account_id}:${input.client_request_id}`}, 0))`);
    const [priorRequest] = await tx
      .select()
      .from(execution_delegation_decisions)
      .where(and(
        eq(execution_delegation_decisions.actor_account_id, input.actor_account_id),
        eq(execution_delegation_decisions.client_request_id, input.client_request_id),
      ))
      .limit(1);
    if (priorRequest) {
      if (priorRequest.request_fingerprint !== requestFingerprint) {
        throw new ExecutionDelegationDecisionIdempotencyConflictError();
      }
      const [grant] = await tx
        .select({ room_id: execution_delegation_grants.room_id })
        .from(execution_delegation_grants)
        .where(and(
          eq(execution_delegation_grants.delegation_instance_id, priorRequest.delegation_instance_id),
          eq(execution_delegation_grants.revision, priorRequest.delegation_revision),
        ))
        .limit(1);
      if (!grant) throw new ExecutionDelegationDecisionAuthorityError();
      return { status: "replayed" as const, decision: toDecision(priorRequest), room_id: grant.room_id };
    }

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_instance:${input.delegation_instance_id}`}, 0))`);
    const [grant] = await tx
      .select()
      .from(execution_delegation_grants)
      .where(eq(execution_delegation_grants.delegation_instance_id, input.delegation_instance_id))
      .orderBy(desc(execution_delegation_grants.revision))
      .for("update")
      .limit(1);
    if (!grant || grant.approver_account_id !== input.actor_account_id
      || grant.category !== "file_change" || grant.risk_ceiling !== "low") {
      throw new ExecutionDelegationDecisionAuthorityError();
    }
    if (grant.revision !== input.expected_revision || grant.retired_at) {
      throw new ExecutionDelegationDecisionRevisionConflictError();
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_approval:${input.delegation_instance_id}:${input.expected_revision}:${input.request_id}:${input.request_version}`}, 0))`);
    const [priorDecision] = await tx
      .select({ decision_id: execution_delegation_decisions.decision_id })
      .from(execution_delegation_decisions)
      .where(and(
        eq(execution_delegation_decisions.delegation_instance_id, input.delegation_instance_id),
        eq(execution_delegation_decisions.delegation_revision, input.expected_revision),
        eq(execution_delegation_decisions.request_id, input.request_id),
        eq(execution_delegation_decisions.request_version, input.request_version),
      ))
      .limit(1);
    if (priorDecision) throw new ExecutionDelegationDecisionConflictError();

    const [publication] = await tx
      .select({
        closed_at: execution_approval_publications.closed_at,
        request_sha256: execution_approval_publications.request_sha256,
        projection_sha256: execution_approval_publications.projection_sha256,
      })
      .from(execution_approval_publications)
      .where(and(
        eq(execution_approval_publications.delegation_instance_id, input.delegation_instance_id),
        eq(execution_approval_publications.delegation_revision, input.expected_revision),
        eq(execution_approval_publications.request_id, input.request_id),
        eq(execution_approval_publications.request_version, input.request_version),
      ))
      .limit(1);
    if (publication?.closed_at) throw new ExecutionDelegationDecisionPublicationClosedError();
    if (publication && (publication.request_sha256 !== input.request_sha256
      || publication.projection_sha256 !== input.projection_sha256)) {
      throw new ExecutionDelegationDecisionConflictError();
    }

    // Capture wall time only after every contended authority lock. A request
    // that waited past grant expiry must not commit against a stale timestamp.
    const now = new Date();
    if (grant.revoked_at || grant.expired_at || Date.parse(grant.expires_at) <= now.getTime()) {
      throw new ExecutionDelegationDecisionTerminalError();
    }

    const [created] = await tx
      .insert(execution_delegation_decisions)
      .values({
        decision_id: `execution_delegation_decision_${randomUUID()}`,
        delegation_instance_id: grant.delegation_instance_id,
        delegation_revision: grant.revision,
        actor_account_id: input.actor_account_id,
        request_id: input.request_id,
        request_version: input.request_version,
        request_sha256: input.request_sha256,
        projection_sha256: input.projection_sha256,
        decision: input.decision,
        client_request_id: input.client_request_id,
        request_fingerprint: requestFingerprint,
        decided_at: now.toISOString(),
      })
      .returning();
    return { status: "created" as const, decision: toDecision(created), room_id: grant.room_id };
  });
}

const hostDecisionColumns = {
  decision_id: execution_delegation_decisions.decision_id,
  delegation_instance_id: execution_delegation_decisions.delegation_instance_id,
  delegation_revision: execution_delegation_decisions.delegation_revision,
  actor_account_id: execution_delegation_decisions.actor_account_id,
  request_id: execution_delegation_decisions.request_id,
  request_version: execution_delegation_decisions.request_version,
  request_sha256: execution_delegation_decisions.request_sha256,
  projection_sha256: execution_delegation_decisions.projection_sha256,
  decision: execution_delegation_decisions.decision,
  client_request_id: execution_delegation_decisions.client_request_id,
  request_fingerprint: execution_delegation_decisions.request_fingerprint,
  decided_at: execution_delegation_decisions.decided_at,
  owner_account_id: execution_delegation_grants.owner_account_id,
  host_id: execution_delegation_grants.host_id,
  installation_id: execution_delegation_grants.installation_id,
  scope_key: execution_delegation_grants.scope_key,
  room_id: execution_delegation_grants.room_id,
  agent_key: execution_delegation_grants.agent_key,
  approver_account_id: execution_delegation_grants.approver_account_id,
  category: execution_delegation_grants.category,
  risk_ceiling: execution_delegation_grants.risk_ceiling,
  scope_sha256: execution_delegation_grants.scope_sha256,
};

function toHostDecision(row: Record<keyof typeof hostDecisionColumns, unknown>): ExecutionDelegationDecisionForHost {
  return {
    ...row,
    delegation_revision: Number(row.delegation_revision),
    request_version: Number(row.request_version),
    scope_key: "owner",
    category: "file_change",
    risk_ceiling: "low",
    decision: row.decision as ExecutionDelegationDecisionChoice,
  } as ExecutionDelegationDecisionForHost;
}

export async function getExecutionDelegationDecisionForHost(input: {
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  decision_id: string;
}): Promise<ExecutionDelegationDecisionForHost | null> {
  const [row] = await db
    .select(hostDecisionColumns)
    .from(execution_delegation_decisions)
    .innerJoin(execution_delegation_grants, and(
      eq(execution_delegation_grants.delegation_instance_id, execution_delegation_decisions.delegation_instance_id),
      eq(execution_delegation_grants.revision, execution_delegation_decisions.delegation_revision),
    ))
    .where(and(
      eq(execution_delegation_decisions.decision_id, input.decision_id),
      eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
      eq(execution_delegation_grants.host_id, input.host_id),
      eq(execution_delegation_grants.installation_id, input.installation_id),
      eq(execution_delegation_grants.scope_key, "owner"),
    ))
    .limit(1);
  return row ? toHostDecision(row) : null;
}

export async function listExecutionDelegationDecisionIdsForHost(input: {
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  room_id: string;
  agent_key: string;
  after?: string | null;
  now?: Date;
}): Promise<{ decision_ids: string[]; next_cursor: string | null }> {
  const applicableAfter = new Date(
    (input.now ?? new Date()).getTime() - EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS,
  ).toISOString();
  const rows = await db
    .select({ decision_id: execution_delegation_decisions.decision_id })
    .from(execution_delegation_decisions)
    .innerJoin(execution_delegation_grants, and(
      eq(execution_delegation_grants.delegation_instance_id, execution_delegation_decisions.delegation_instance_id),
      eq(execution_delegation_grants.revision, execution_delegation_decisions.delegation_revision),
    ))
    .where(and(
      eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
      eq(execution_delegation_grants.host_id, input.host_id),
      eq(execution_delegation_grants.installation_id, input.installation_id),
      eq(execution_delegation_grants.scope_key, "owner"),
      eq(execution_delegation_grants.room_id, input.room_id),
      eq(execution_delegation_grants.agent_key, input.agent_key),
      gt(execution_delegation_decisions.decided_at, applicableAfter),
      ...(input.after ? [gt(execution_delegation_decisions.decision_id, input.after)] : []),
    ))
    .orderBy(asc(execution_delegation_decisions.decision_id))
    .limit(HOST_INVENTORY_PAGE_SIZE + 1);
  const page = rows.slice(0, HOST_INVENTORY_PAGE_SIZE);
  return {
    decision_ids: page.map((row) => row.decision_id),
    next_cursor: rows.length > HOST_INVENTORY_PAGE_SIZE ? page.at(-1)?.decision_id ?? null : null,
  };
}
