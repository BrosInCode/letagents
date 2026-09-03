import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { executionIdentity } from "./execution-protocol.js";
import type { DaemonManifestEntry } from "./types.js";

// Host-private structural authority only. This journal must never receive the
// supervisor bearer, request text, command, diff, path, or provider output.
const MAX_DELEGATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const delegation = z.strictObject({
  delegationInstanceId: executionIdentity,
  revision: time.min(1),
  ownerAccountId: executionIdentity,
  roomId: executionIdentity,
  agentKey: executionIdentity,
  approverAccountId: executionIdentity,
  category: z.literal("file_change"),
  riskCeiling: z.literal("low"),
  scopeSha256: sha256,
  createdAtMs: time,
  expiresAtMs: time,
  revokedAtMs: time.nullable(),
}).refine((value) => value.expiresAtMs > value.createdAtMs
  && (value.revokedAtMs === null || value.revokedAtMs >= value.createdAtMs));
const authority = z.strictObject({
  agentId: executionIdentity,
  roomId: executionIdentity,
  agentKey: executionIdentity,
  grantId: executionIdentity,
  grantGeneration: time.min(1),
  daemonGeneration: time.min(1),
  controlEpoch: time,
  hostId: executionIdentity,
  installationId: executionIdentity,
  ownerAccountId: executionIdentity,
  scopeKey: z.literal("owner"),
  expiresAtMs: time,
});
const reconciliation = z.strictObject({ delegation, authority, atMs: time });
const validation = z.strictObject({
  delegationInstanceId: executionIdentity,
  revision: time.min(1),
  agentId: executionIdentity,
  approverAccountId: executionIdentity,
  category: z.literal("file_change"),
  risk: z.literal("low"),
  scopeSha256: sha256,
  authority,
  atMs: time,
});
const inventoryScope = z.strictObject({
  agentId: executionIdentity,
  roomId: executionIdentity,
  agentKey: executionIdentity,
  ownerAccountId: executionIdentity,
  hostId: executionIdentity,
  installationId: executionIdentity,
});
const publicationScope = inventoryScope.extend({
  grantId: executionIdentity,
  atMs: time,
});

export type RemoteExecutionDelegationRevision = z.infer<typeof delegation>;
export type ExecutionDelegationHostAuthority = z.infer<typeof authority>;
export type ReconcileExecutionDelegation = z.infer<typeof reconciliation>;
export type ValidateExecutionDelegation = z.infer<typeof validation>;
export type ExecutionDelegationInventoryScope = z.infer<typeof inventoryScope>;
export type ExecutionApprovalPublicationDelegationScope = z.infer<typeof publicationScope>;

export type LocalExecutionDelegation = {
  delegationInstanceId: string;
  revision: number;
  ownerAccountId: string;
  hostId: string;
  installationId: string;
  scopeKey: "owner";
  agentId: string;
  roomId: string;
  agentKey: string;
  approverAccountId: string;
  category: "file_change";
  riskCeiling: "low";
  grantId: string;
  scopeSha256: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
};

type Row = Record<string, unknown>;

export class ExecutionDelegationJournalError extends Error {
  constructor(readonly code: "invalid_input" | "authority_mismatch" | "revision_conflict" | "terminal" | "expired") {
    super(`Execution delegation journal rejected: ${code}.`);
    this.name = "ExecutionDelegationJournalError";
  }
}

function reject(code: ExecutionDelegationJournalError["code"]): never {
  throw new ExecutionDelegationJournalError(code);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) reject("invalid_input");
  return result.data;
}

function fromRow(row: Row): LocalExecutionDelegation {
  if (row.scope_key !== "owner") reject("authority_mismatch");
  return {
    delegationInstanceId: String(row.delegation_instance_id),
    revision: Number(row.revision),
    ownerAccountId: String(row.owner_id),
    hostId: String(row.host_id),
    installationId: String(row.installation_id),
    scopeKey: "owner",
    agentId: String(row.agent_id),
    roomId: String(row.room_id),
    agentKey: String(row.agent_key),
    approverAccountId: String(row.approver_id),
    category: "file_change",
    riskCeiling: "low",
    grantId: String(row.grant_id),
    scopeSha256: String(row.scope_sha256),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
  };
}

function latest(db: DatabaseSync, instanceId: string): LocalExecutionDelegation | null {
  const row = db.prepare(`SELECT * FROM execution_local_delegations
    WHERE delegation_instance_id=? ORDER BY revision DESC LIMIT 1`).get(instanceId);
  return row ? fromRow(row) : null;
}

function exact(db: DatabaseSync, instanceId: string, revision: number): LocalExecutionDelegation | null {
  const row = db.prepare(`SELECT * FROM execution_local_delegations
    WHERE delegation_instance_id=? AND revision=?`).get(instanceId, revision);
  return row ? fromRow(row) : null;
}

/**
 * Return the delegation identities already known under one current host
 * installation. The caller still has to exact-fetch every identity; these
 * rows are discovery hints, never reusable authority.
 */
export function listExecutionDelegationInstanceIds(
  db: DatabaseSync,
  input: ExecutionDelegationInventoryScope,
): string[] {
  const scope = parse(inventoryScope, input);
  return db.prepare(`SELECT DISTINCT delegation_instance_id FROM execution_local_delegations
    WHERE agent_id=? AND room_id=? AND agent_key=? AND owner_id=?
      AND host_id=? AND installation_id=? AND scope_key='owner'
    ORDER BY delegation_instance_id ASC`).all(
    scope.agentId,
    scope.roomId,
    scope.agentKey,
    scope.ownerAccountId,
    scope.hostId,
    scope.installationId,
  ).map((row) => String((row as Row).delegation_instance_id));
}

/** Bounded current local revisions eligible to receive one freshly admitted approval projection. */
export function listExecutionDelegationsForApprovalPublication(
  db: DatabaseSync,
  input: ExecutionApprovalPublicationDelegationScope,
): LocalExecutionDelegation[] {
  const scope = parse(publicationScope, input);
  const rows = db.prepare(`SELECT candidate.* FROM execution_local_delegations candidate
    WHERE candidate.agent_id=? AND candidate.room_id=? AND candidate.agent_key=? AND candidate.owner_id=?
      AND candidate.host_id=? AND candidate.installation_id=? AND candidate.grant_id=? AND candidate.scope_key='owner'
      AND candidate.revoked_at_ms IS NULL AND candidate.expires_at_ms>?
      AND NOT EXISTS (SELECT 1 FROM execution_local_delegations newer
        WHERE newer.delegation_instance_id=candidate.delegation_instance_id AND newer.revision>candidate.revision)
    ORDER BY candidate.delegation_instance_id LIMIT 65`).all(
    scope.agentId,
    scope.roomId,
    scope.agentKey,
    scope.ownerAccountId,
    scope.hostId,
    scope.installationId,
    scope.grantId,
    scope.atMs,
  );
  if (rows.length > 64) reject("authority_mismatch");
  return rows.map(fromRow);
}

function assertFreshScopeAvailable(
  db: DatabaseSync,
  remote: RemoteExecutionDelegationRevision,
  trusted: ExecutionDelegationHostAuthority,
): void {
  const rows = db.prepare(`SELECT candidate.* FROM execution_local_delegations candidate
    WHERE candidate.delegation_instance_id<>?
      AND candidate.owner_id=? AND candidate.host_id=? AND candidate.installation_id=? AND candidate.scope_key=?
      AND candidate.agent_id=? AND candidate.approver_id=?
      AND candidate.category=? AND candidate.risk_ceiling=?
      AND NOT EXISTS (
        SELECT 1 FROM execution_local_delegations newer
        WHERE newer.delegation_instance_id=candidate.delegation_instance_id AND newer.revision>candidate.revision
      )`).all(
    remote.delegationInstanceId,
    trusted.ownerAccountId,
    trusted.hostId,
    trusted.installationId,
    trusted.scopeKey,
    trusted.agentId,
    remote.approverAccountId,
    remote.category,
    remote.riskCeiling,
  );
  if (rows.some((row) => {
    const current = fromRow(row);
    return current.expiresAtMs > remote.createdAtMs
      && (current.revokedAtMs === null || current.revokedAtMs > remote.createdAtMs);
  })) reject("revision_conflict");
}

function assertCurrentAuthority(
  entry: DaemonManifestEntry | undefined,
  trusted: ExecutionDelegationHostAuthority,
): void {
  if (!entry || entry.id !== trusted.agentId || entry.room_id !== trusted.roomId
    || trusted.scopeKey !== "owner") reject("authority_mismatch");
}

function assertRemoteOwner(
  remote: RemoteExecutionDelegationRevision,
  trusted: ExecutionDelegationHostAuthority,
): void {
  if (remote.ownerAccountId !== trusted.ownerAccountId) reject("authority_mismatch");
}

function sameStableAuthority(
  existing: LocalExecutionDelegation,
  remote: RemoteExecutionDelegationRevision,
  trusted: ExecutionDelegationHostAuthority,
): boolean {
  // scopeSha256 is revision identity, not chain identity: after a canonical
  // alias cascade, the next owner-authored server revision has a new digest.
  return existing.ownerAccountId === trusted.ownerAccountId
    && existing.hostId === trusted.hostId
    && existing.installationId === trusted.installationId
    && existing.scopeKey === trusted.scopeKey
    && existing.agentId === trusted.agentId
    && existing.approverAccountId === remote.approverAccountId
    && existing.category === remote.category
    && existing.riskCeiling === remote.riskCeiling;
}

/**
 * Reconcile one authenticated server revision into the host's local authority
 * journal. Host provenance is supplied from current process custody; the
 * remote projection cannot choose host, installation, local agent, or grant.
 */
export function reconcileExecutionDelegation(
  db: DatabaseSync,
  input: ReconcileExecutionDelegation,
  entry: DaemonManifestEntry | undefined,
): { created: boolean; delegation: LocalExecutionDelegation } {
  const value = parse(reconciliation, input);
  if (value.atMs < value.delegation.createdAtMs
    || (value.delegation.revokedAtMs !== null && value.delegation.revokedAtMs > value.atMs)) reject("invalid_input");
  assertCurrentAuthority(entry, value.authority);
  assertRemoteOwner(value.delegation, value.authority);
  if (value.delegation.expiresAtMs - value.delegation.createdAtMs > MAX_DELEGATION_TTL_MS) {
    reject("authority_mismatch");
  }
  if (value.authority.expiresAtMs <= value.atMs) reject("authority_mismatch");
  const prior = latest(db, value.delegation.delegationInstanceId);
  if (prior && value.delegation.revision < prior.revision) reject("revision_conflict");
  const priorExact = exact(db, value.delegation.delegationInstanceId, value.delegation.revision);
  if (priorExact) {
    if (!sameStableAuthority(priorExact, value.delegation, value.authority)
      || priorExact.scopeSha256 !== value.delegation.scopeSha256
      || priorExact.createdAtMs !== value.delegation.createdAtMs
      || priorExact.expiresAtMs !== value.delegation.expiresAtMs
      || (priorExact.revokedAtMs !== null && priorExact.revokedAtMs !== value.delegation.revokedAtMs)) {
      reject("revision_conflict");
    }
    if (priorExact.revokedAtMs === null && value.delegation.revokedAtMs !== null) {
      db.prepare(`UPDATE execution_local_delegations
        SET room_id=?,agent_key=?,grant_id=?,revoked_at_ms=?
        WHERE delegation_instance_id=? AND revision=? AND revoked_at_ms IS NULL`).run(
        value.delegation.roomId,
        value.delegation.agentKey,
        value.authority.grantId,
        value.delegation.revokedAtMs,
        value.delegation.delegationInstanceId,
        value.delegation.revision,
      );
    } else if (priorExact.roomId !== value.delegation.roomId
      || priorExact.agentKey !== value.delegation.agentKey
      || priorExact.grantId !== value.authority.grantId) {
      db.prepare(`UPDATE execution_local_delegations SET room_id=?,agent_key=?,grant_id=?
        WHERE delegation_instance_id=? AND revision=?`).run(
        value.delegation.roomId,
        value.delegation.agentKey,
        value.authority.grantId,
        value.delegation.delegationInstanceId,
        value.delegation.revision,
      );
    }
    return { created: false, delegation: exact(db, value.delegation.delegationInstanceId, value.delegation.revision)! };
  }

  if (!prior) {
    assertFreshScopeAvailable(db, value.delegation, value.authority);
  } else {
    if (value.delegation.revision <= prior.revision
      || !sameStableAuthority(prior, value.delegation, value.authority)) reject("revision_conflict");
    if (prior.revokedAtMs !== null) reject("terminal");
    // Consecutive revisions cannot revive an expired instance. A larger gap is
    // an offline checkpoint: the exact local authorization is authority for the
    // latest revision even though the server exposes no intermediate history.
    if (value.delegation.revision === prior.revision + 1
      && value.delegation.createdAtMs >= prior.expiresAtMs) reject("terminal");
    if (value.delegation.createdAtMs < prior.createdAtMs) reject("revision_conflict");
  }

  db.prepare(`INSERT INTO execution_local_delegations(
    delegation_instance_id,revision,owner_id,host_id,installation_id,scope_key,
    agent_id,room_id,agent_key,approver_id,category,risk_ceiling,grant_id,scope_sha256,
    created_at_ms,expires_at_ms,revoked_at_ms
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    value.delegation.delegationInstanceId,
    value.delegation.revision,
    value.authority.ownerAccountId,
    value.authority.hostId,
    value.authority.installationId,
    value.authority.scopeKey,
    value.authority.agentId,
    value.delegation.roomId,
    value.delegation.agentKey,
    value.delegation.approverAccountId,
    value.delegation.category,
    value.delegation.riskCeiling,
    value.authority.grantId,
    value.delegation.scopeSha256,
    value.delegation.createdAtMs,
    value.delegation.expiresAtMs,
    value.delegation.revokedAtMs,
  );
  return { created: true, delegation: exact(db, value.delegation.delegationInstanceId, value.delegation.revision)! };
}

/**
 * Point-in-time eligibility check against current host custody and manifest
 * membership. It is never a dispatch permit: eventual decision admission must
 * invoke this function inside the transaction that records the decision.
 */
export function validateExecutionDelegation(
  db: DatabaseSync,
  input: ValidateExecutionDelegation,
  entry: DaemonManifestEntry | undefined,
): LocalExecutionDelegation {
  const value = parse(validation, input);
  const current = latest(db, value.delegationInstanceId);
  if (!current || current.revision !== value.revision) reject("revision_conflict");
  assertCurrentAuthority(entry, value.authority);
  if (value.atMs < current.createdAtMs) reject("invalid_input");
  if (current.revokedAtMs !== null) reject("terminal");
  if (current.expiresAtMs <= value.atMs || value.authority.expiresAtMs <= value.atMs) reject("expired");
  if (current.agentId !== value.agentId || current.approverAccountId !== value.approverAccountId
    || current.category !== value.category || current.riskCeiling !== value.risk
    || current.ownerAccountId !== value.authority.ownerAccountId
    || current.hostId !== value.authority.hostId
    || current.installationId !== value.authority.installationId
    || current.scopeKey !== value.authority.scopeKey
    || current.grantId !== value.authority.grantId
    || current.scopeSha256 !== value.scopeSha256) reject("authority_mismatch");
  return current;
}
