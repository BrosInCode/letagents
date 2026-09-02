import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./client.js";
import {
  accounts,
  agents,
  execution_delegation_grants,
  supervisor_host_grants,
} from "./schema.js";
import type {
  ExecutionDelegationCategory,
  ExecutionDelegationGrant,
  ExecutionDelegationRiskCeiling,
} from "./types.js";

const EXECUTION_DELEGATION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class ExecutionDelegationIdempotencyConflictError extends Error {
  readonly code = "execution_delegation_idempotency_conflict";

  constructor() {
    super("The delegation request key is already bound to a different request.");
    this.name = "ExecutionDelegationIdempotencyConflictError";
  }
}

export class ExecutionDelegationAuthorityError extends Error {
  readonly code = "execution_delegation_authority_invalid";

  constructor() {
    super("The requested delegation is not authorized by a current owner supervisor grant.");
    this.name = "ExecutionDelegationAuthorityError";
  }
}

export class ExecutionDelegationTerminalError extends Error {
  readonly code = "execution_delegation_terminal";

  constructor() {
    super("The delegation scope is terminal and cannot be revised.");
    this.name = "ExecutionDelegationTerminalError";
  }
}

export class ExecutionDelegationRevisionConflictError extends Error {
  readonly code = "execution_delegation_revision_conflict";

  constructor() {
    super("The delegation scope changed before this revision could be admitted.");
    this.name = "ExecutionDelegationRevisionConflictError";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function toExecutionDelegationGrant(
  row: typeof execution_delegation_grants.$inferSelect,
): ExecutionDelegationGrant {
  return {
    ...row,
    scope_key: "owner",
    category: "file_change",
    risk_ceiling: "low",
  };
}

export interface AdmitExecutionDelegationGrantInput {
  owner_account_id: string;
  supervisor_grant_id: string;
  room_id: string;
  agent_key: string;
  approver_account_id: string;
  category: ExecutionDelegationCategory;
  risk_ceiling: ExecutionDelegationRiskCeiling;
  expires_at: string;
  client_request_id: string;
  /** Omit to create a fresh instance; required to revise an existing instance. */
  delegation_instance_id?: string;
  expected_revision: number;
  now?: Date;
}

function validId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 512;
}

/**
 * Create a fresh delegation instance or renew the exact immutable scope of an
 * existing instance. The caller supplies only the source grant id; host
 * provenance is copied from the locked grant row and is never reconstructed
 * from caller-provided host fields.
 */
export async function admitExecutionDelegationGrantRevision(
  input: AdmitExecutionDelegationGrantInput,
): Promise<{ status: "created" | "revised" | "replayed"; grant: ExecutionDelegationGrant }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiryMs = Date.parse(input.expires_at);
  if (
    !validId(input.owner_account_id)
    || !validId(input.supervisor_grant_id)
    || !validId(input.room_id)
    || !validId(input.agent_key)
    || !validId(input.approver_account_id)
    || !validId(input.client_request_id)
    || (input.delegation_instance_id !== undefined && !validId(input.delegation_instance_id))
    || input.category !== "file_change"
    || input.risk_ceiling !== "low"
    || !Number.isInteger(input.expected_revision)
    || input.expected_revision < 0
    || (input.delegation_instance_id === undefined && input.expected_revision !== 0)
    || (input.delegation_instance_id !== undefined && input.expected_revision < 1)
    || !Number.isFinite(expiryMs)
    || expiryMs <= now.getTime()
    || expiryMs > now.getTime() + EXECUTION_DELEGATION_MAX_TTL_MS
  ) {
    throw new ExecutionDelegationAuthorityError();
  }

  const requestFingerprint = sha256({
    owner_account_id: input.owner_account_id,
    supervisor_grant_id: input.supervisor_grant_id,
    room_id: input.room_id,
    agent_key: input.agent_key,
    approver_account_id: input.approver_account_id,
    category: input.category,
    risk_ceiling: input.risk_ceiling,
    expires_at: new Date(expiryMs).toISOString(),
    delegation_instance_id: input.delegation_instance_id ?? null,
    expected_revision: input.expected_revision,
  });

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_request:${input.owner_account_id}:${input.client_request_id}`}, 0))`);
    const [priorRequest] = await tx
      .select()
      .from(execution_delegation_grants)
      .where(and(
        eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
        eq(execution_delegation_grants.client_request_id, input.client_request_id),
      ))
      .limit(1);
    if (priorRequest) {
      if (priorRequest.request_fingerprint !== requestFingerprint) {
        throw new ExecutionDelegationIdempotencyConflictError();
      }
      return { status: "replayed" as const, grant: toExecutionDelegationGrant(priorRequest) };
    }

    const [sourceGrant] = await tx
      .select()
      .from(supervisor_host_grants)
      .where(and(
        eq(supervisor_host_grants.grant_id, input.supervisor_grant_id),
        eq(supervisor_host_grants.owner_account_id, input.owner_account_id),
        eq(supervisor_host_grants.scope_key, "owner"),
        isNull(supervisor_host_grants.rental_session_id),
        isNull(supervisor_host_grants.revoked_at),
        sql`${supervisor_host_grants.expires_at} > ${nowIso}`,
      ))
      .for("share")
      .limit(1);
    if (
      !sourceGrant
      || !sourceGrant.allowed_room_ids.includes(input.room_id)
      || !sourceGrant.allowed_agent_keys.includes(input.agent_key)
    ) {
      throw new ExecutionDelegationAuthorityError();
    }

    const [[agent], [approver]] = await Promise.all([
      tx.select({ canonical_key: agents.canonical_key }).from(agents).where(and(
        eq(agents.canonical_key, input.agent_key),
        eq(agents.owner_account_id, input.owner_account_id),
      )).limit(1),
      tx.select({ id: accounts.id }).from(accounts)
        .where(eq(accounts.id, input.approver_account_id)).limit(1),
    ]);
    if (!agent || !approver) throw new ExecutionDelegationAuthorityError();

    const scope = {
      owner_account_id: sourceGrant.owner_account_id,
      host_id: sourceGrant.host_id,
      installation_id: sourceGrant.installation_id,
      scope_key: sourceGrant.scope_key,
      room_id: input.room_id,
      agent_key: input.agent_key,
      approver_account_id: input.approver_account_id,
      category: input.category,
      risk_ceiling: input.risk_ceiling,
    };
    const scopeSha256 = sha256(scope);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_scope:${scopeSha256}`}, 0))`);

    const matchesScope = (row: typeof execution_delegation_grants.$inferSelect) => (
      row.owner_account_id === scope.owner_account_id
      && row.host_id === scope.host_id
      && row.installation_id === scope.installation_id
      && row.scope_key === scope.scope_key
      && row.room_id === scope.room_id
      && row.agent_key === scope.agent_key
      && row.approver_account_id === scope.approver_account_id
      && row.category === scope.category
      && row.risk_ceiling === scope.risk_ceiling
    );

    let latest: typeof execution_delegation_grants.$inferSelect | undefined;
    if (input.delegation_instance_id !== undefined) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_instance:${input.delegation_instance_id}`}, 0))`);
      [latest] = await tx
        .select()
        .from(execution_delegation_grants)
        .where(and(
          eq(execution_delegation_grants.delegation_instance_id, input.delegation_instance_id),
          eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
        ))
        .orderBy(desc(execution_delegation_grants.revision))
        .for("update")
        .limit(1);
      if (!latest || !matchesScope(latest)) throw new ExecutionDelegationAuthorityError();
      if (latest.revision !== input.expected_revision) {
        throw new ExecutionDelegationRevisionConflictError();
      }
      if (latest.retired_at) throw new Error("Delegation revision chain has no current revision.");
      if (latest.revoked_at || latest.expired_at) throw new ExecutionDelegationTerminalError();
      if (Date.parse(latest.expires_at) <= now.getTime()) {
        await tx.update(execution_delegation_grants)
          .set({ expired_at: nowIso })
          .where(and(
            eq(execution_delegation_grants.delegation_instance_id, latest.delegation_instance_id),
            eq(execution_delegation_grants.revision, latest.revision),
            isNull(execution_delegation_grants.expired_at),
          ));
        return { status: "expired" as const };
      }
    } else {
      const [currentHint] = await tx
        .select()
        .from(execution_delegation_grants)
        .where(and(
          eq(execution_delegation_grants.owner_account_id, scope.owner_account_id),
          eq(execution_delegation_grants.host_id, scope.host_id),
          eq(execution_delegation_grants.installation_id, scope.installation_id),
          eq(execution_delegation_grants.scope_key, scope.scope_key),
          eq(execution_delegation_grants.room_id, scope.room_id),
          eq(execution_delegation_grants.agent_key, scope.agent_key),
          eq(execution_delegation_grants.approver_account_id, scope.approver_account_id),
          isNull(execution_delegation_grants.retired_at),
          isNull(execution_delegation_grants.revoked_at),
          isNull(execution_delegation_grants.expired_at),
        ))
        .limit(1);
      if (currentHint) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_instance:${currentHint.delegation_instance_id}`}, 0))`);
        const [current] = await tx
          .select()
          .from(execution_delegation_grants)
          .where(and(
            eq(execution_delegation_grants.delegation_instance_id, currentHint.delegation_instance_id),
            eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
          ))
          .orderBy(desc(execution_delegation_grants.revision))
          .for("update")
          .limit(1);
        if (current && matchesScope(current)
          && !current.retired_at && !current.revoked_at && !current.expired_at) {
          if (Date.parse(current.expires_at) > now.getTime()) {
            throw new ExecutionDelegationRevisionConflictError();
          }
          await tx.update(execution_delegation_grants)
            .set({ expired_at: nowIso })
            .where(and(
              eq(execution_delegation_grants.delegation_instance_id, current.delegation_instance_id),
              eq(execution_delegation_grants.revision, current.revision),
              isNull(execution_delegation_grants.expired_at),
            ));
        }
      }
    }

    const revision = (latest?.revision ?? 0) + 1;
    const delegationInstanceId = latest?.delegation_instance_id
      ?? `execution_delegation_${randomUUID()}`;
    if (latest) {
      const [retired] = await tx
        .update(execution_delegation_grants)
        .set({ retired_at: nowIso, retired_by_revision: revision })
        .where(and(
          eq(execution_delegation_grants.delegation_instance_id, latest.delegation_instance_id),
          eq(execution_delegation_grants.revision, latest.revision),
          isNull(execution_delegation_grants.retired_at),
          isNull(execution_delegation_grants.revoked_at),
          isNull(execution_delegation_grants.expired_at),
        ))
        .returning({ revision: execution_delegation_grants.revision });
      if (!retired) throw new Error("Delegation revision lost its current-row fence.");
    }

    const [created] = await tx
      .insert(execution_delegation_grants)
      .values({
        delegation_instance_id: delegationInstanceId,
        revision,
        owner_account_id: scope.owner_account_id,
        admission_supervisor_grant_id: sourceGrant.grant_id,
        host_id: scope.host_id,
        installation_id: scope.installation_id,
        scope_key: scope.scope_key,
        room_id: scope.room_id,
        agent_key: scope.agent_key,
        approver_account_id: scope.approver_account_id,
        category: scope.category,
        risk_ceiling: scope.risk_ceiling,
        scope_sha256: scopeSha256,
        client_request_id: input.client_request_id,
        request_fingerprint: requestFingerprint,
        created_at: nowIso,
        expires_at: new Date(expiryMs).toISOString(),
        expired_at: null,
        retired_at: null,
        retired_by_revision: null,
        revoked_at: null,
      })
      .returning();

    return {
      status: latest ? "revised" as const : "created" as const,
      grant: toExecutionDelegationGrant(created),
    };
  });
  if (result.status === "expired") throw new ExecutionDelegationTerminalError();
  return result;
}

export async function revokeExecutionDelegationGrant(input: {
  owner_account_id: string;
  delegation_instance_id: string;
  now?: Date;
}): Promise<ExecutionDelegationGrant | null> {
  const nowIso = (input.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution_delegation_instance:${input.delegation_instance_id}`}, 0))`);
    const [latest] = await tx
      .select()
      .from(execution_delegation_grants)
      .where(and(
        eq(execution_delegation_grants.delegation_instance_id, input.delegation_instance_id),
        eq(execution_delegation_grants.owner_account_id, input.owner_account_id),
      ))
      .orderBy(desc(execution_delegation_grants.revision))
      .for("update")
      .limit(1);
    if (!latest) return null;
    if (latest.revoked_at) return toExecutionDelegationGrant(latest);
    if (latest.retired_at) throw new Error("Delegation revision chain has no current revision.");
    const [revoked] = await tx
      .update(execution_delegation_grants)
      .set({ revoked_at: nowIso })
      .where(and(
        eq(execution_delegation_grants.delegation_instance_id, latest.delegation_instance_id),
        eq(execution_delegation_grants.revision, latest.revision),
        isNull(execution_delegation_grants.retired_at),
        isNull(execution_delegation_grants.revoked_at),
      ))
      .returning();
    if (!revoked) throw new Error("Delegation revocation lost its current-row fence.");
    return toExecutionDelegationGrant(revoked);
  });
}
