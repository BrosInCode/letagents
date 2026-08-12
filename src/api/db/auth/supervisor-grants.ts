import crypto from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "../client.js";
import { supervisor_host_grants } from "../schema.js";
import { hashToken, nextPrefixedId } from "../utils.js";
import type { SupervisorHostGrant } from "../types.js";

export function makeSupervisorGrantToken(): string {
  return `lashg_${crypto.randomBytes(32).toString("base64url")}`;
}

function toSupervisorHostGrant(row: typeof supervisor_host_grants.$inferSelect): SupervisorHostGrant {
  return {
    grant_id: row.grant_id,
    owner_account_id: row.owner_account_id,
    host_id: row.host_id,
    installation_id: row.installation_id,
    scope_key: row.scope_key,
    rental_session_id: row.rental_session_id,
    token_version: row.token_version,
    allowed_room_ids: row.allowed_room_ids,
    allowed_agent_keys: row.allowed_agent_keys,
    current_generation: row.current_generation,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

export interface SupervisorGrantFence {
  grant_id: string;
  generation: number;
  token_version: number;
}

export class SupervisorGrantFenceStaleError extends Error {
  readonly code = "supervisor_grant_fence_stale";

  constructor() {
    super("Supervisor grant fence is stale.");
    this.name = "SupervisorGrantFenceStaleError";
  }
}

export function isSupervisorGrantFenceStaleError(error: unknown): error is SupervisorGrantFenceStaleError {
  return error instanceof SupervisorGrantFenceStaleError;
}

export class SupervisorGrantProvisionConflictError extends Error {
  readonly code = "supervisor_grant_provision_conflict";

  constructor() {
    super("An active supervisor grant already exists for this host installation with different authority.");
    this.name = "SupervisorGrantProvisionConflictError";
  }
}

export function isSupervisorGrantProvisionConflictError(
  error: unknown,
): error is SupervisorGrantProvisionConflictError {
  return error instanceof SupervisorGrantProvisionConflictError;
}

export async function assertSupervisorGrantFenceTx(tx: any, fence: SupervisorGrantFence): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_grant:${fence.grant_id}`}, 0))`);
  const [grant] = await tx.select({ grant_id: supervisor_host_grants.grant_id }).from(supervisor_host_grants).where(and(
    eq(supervisor_host_grants.grant_id, fence.grant_id),
    eq(supervisor_host_grants.current_generation, fence.generation),
    eq(supervisor_host_grants.token_version, fence.token_version),
    isNull(supervisor_host_grants.revoked_at),
    gt(supervisor_host_grants.expires_at, new Date().toISOString()),
  )).limit(1);
  return Boolean(grant);
}


export async function createSupervisorHostGrant(input: {
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  allowed_room_ids: string[];
  allowed_agent_keys: string[];
  expires_at: string;
  scope_key?: string;
  rental_session_id?: string | null;
}): Promise<{ grant: SupervisorHostGrant; token: string }> {
  return db.transaction(async (tx) => {
    const scopeKey = input.scope_key ?? "owner";
    const installationFence = `supervisor_grant_installation:${input.owner_account_id}:${input.host_id}:${input.installation_id}:${scopeKey}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${installationFence}, 0))`);
    const activeGrants = await tx.select().from(supervisor_host_grants).where(and(
      eq(supervisor_host_grants.owner_account_id, input.owner_account_id),
      eq(supervisor_host_grants.host_id, input.host_id),
      eq(supervisor_host_grants.installation_id, input.installation_id),
      eq(supervisor_host_grants.scope_key, scopeKey),
      isNull(supervisor_host_grants.revoked_at),
    ));
    // Pre-upgrade concurrent creates may have left multiple live rows. Never
    // select one arbitrarily and leave another credential authoritative.
    if (activeGrants.length > 1) throw new SupervisorGrantProvisionConflictError();
    const [active] = activeGrants;
    const exactSet = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value) => right.includes(value));
    const now = new Date().toISOString();
    const token = makeSupervisorGrantToken();
    if (active) {
      if (!exactSet(active.allowed_room_ids, input.allowed_room_ids)
        || !exactSet(active.allowed_agent_keys, input.allowed_agent_keys)) {
        throw new SupervisorGrantProvisionConflictError();
      }
      // An owner retry after the server committed but the response was lost
      // recovers the exact grant identity and scope while rotating away the
      // unknown bearer. Repeating this operation is always safe: only the
      // latest returned token remains usable.
      const [recovered] = await tx.update(supervisor_host_grants).set({
        token_hash: hashToken(token),
        token_version: active.token_version + 1,
        expires_at: input.expires_at,
        updated_at: now,
      }).where(and(
        eq(supervisor_host_grants.grant_id, active.grant_id),
        eq(supervisor_host_grants.token_version, active.token_version),
        isNull(supervisor_host_grants.revoked_at),
      )).returning();
      if (!recovered) throw new SupervisorGrantProvisionConflictError();
      return { grant: toSupervisorHostGrant(recovered), token };
    }
    const record = {
      grant_id: await nextPrefixedId("supervisor_host_grants", "supervisor_grant", tx),
      owner_account_id: input.owner_account_id,
      host_id: input.host_id,
      installation_id: input.installation_id,
      scope_key: scopeKey,
      rental_session_id: input.rental_session_id ?? null,
      token_hash: hashToken(token),
      token_version: 1,
      allowed_room_ids: input.allowed_room_ids,
      allowed_agent_keys: input.allowed_agent_keys,
      current_generation: 1,
      issued_at: now,
      expires_at: input.expires_at,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };
    const [created] = await tx.insert(supervisor_host_grants).values(record).returning();
    return { grant: toSupervisorHostGrant(created), token };
  });
}

export async function getSupervisorHostGrantByToken(token: string): Promise<SupervisorHostGrant | null> {
  const [row] = await db.select().from(supervisor_host_grants).where(and(
    eq(supervisor_host_grants.token_hash, hashToken(token)),
    isNull(supervisor_host_grants.revoked_at),
    gt(supervisor_host_grants.expires_at, new Date().toISOString()),
  )).limit(1);
  return row ? toSupervisorHostGrant(row) : null;
}

export async function getSupervisorHostGrantById(grantId: string): Promise<SupervisorHostGrant | null> {
  const [row] = await db.select().from(supervisor_host_grants)
    .where(eq(supervisor_host_grants.grant_id, grantId)).limit(1);
  return row ? toSupervisorHostGrant(row) : null;
}

export async function rotateSupervisorHostGrant(input: {
  grant_id: string;
  expected_generation: number;
  expected_token_version: number;
  expires_at: string;
}): Promise<{ grant: SupervisorHostGrant; token: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_grant:${input.grant_id}`}, 0))`);
    const [current] = await tx.select().from(supervisor_host_grants).where(and(
      eq(supervisor_host_grants.grant_id, input.grant_id),
      eq(supervisor_host_grants.current_generation, input.expected_generation),
      eq(supervisor_host_grants.token_version, input.expected_token_version),
      isNull(supervisor_host_grants.revoked_at),
      gt(supervisor_host_grants.expires_at, new Date().toISOString()),
    )).limit(1);
    if (!current) return null;
    const token = makeSupervisorGrantToken();
    const now = new Date().toISOString();
    const [updated] = await tx.update(supervisor_host_grants).set({
      token_hash: hashToken(token), token_version: input.expected_token_version + 1, expires_at: input.expires_at, updated_at: now,
    }).where(eq(supervisor_host_grants.grant_id, input.grant_id)).returning();
    return { grant: toSupervisorHostGrant(updated), token };
  });
}

// This is intentionally a CAS rather than a property of the credential.  A
// successor may take a host over only by proving the exact generation it saw.
export async function advanceSupervisorHostGrantGeneration(input: {
  grant_id: string;
  expected_generation: number;
  expected_token_version: number;
}): Promise<{ grant: SupervisorHostGrant; token: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_grant:${input.grant_id}`}, 0))`);
    const now = new Date().toISOString();
    const token = makeSupervisorGrantToken();
    const [updated] = await tx.update(supervisor_host_grants).set({
      current_generation: input.expected_generation + 1,
      token_hash: hashToken(token),
      token_version: input.expected_token_version + 1,
      updated_at: now,
    }).where(and(
      eq(supervisor_host_grants.grant_id, input.grant_id),
      eq(supervisor_host_grants.current_generation, input.expected_generation),
      eq(supervisor_host_grants.token_version, input.expected_token_version),
      isNull(supervisor_host_grants.revoked_at),
      gt(supervisor_host_grants.expires_at, now),
    )).returning();
    return updated ? { grant: toSupervisorHostGrant(updated), token } : null;
  });
}

export async function revokeSupervisorHostGrant(input: { grant_id: string; owner_account_id: string }): Promise<SupervisorHostGrant | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_grant:${input.grant_id}`}, 0))`);
    const now = new Date().toISOString();
    const [updated] = await tx.update(supervisor_host_grants).set({ revoked_at: now, updated_at: now })
      .where(and(eq(supervisor_host_grants.grant_id, input.grant_id), eq(supervisor_host_grants.owner_account_id, input.owner_account_id), isNull(supervisor_host_grants.revoked_at)))
      .returning();
    return updated ? toSupervisorHostGrant(updated) : null;
  });
}
