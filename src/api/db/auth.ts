import crypto from "crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "./client.js";
import { accounts, agents, auth_sessions, auth_states, owner_tokens, project_admins, room_agent_delivery_sessions, room_agent_presence, room_agent_session_bearers, room_agent_sessions, supervisor_host_grants } from "./schema.js";
import { AUTH_STATE_TTL_MS, hashToken, nextPrefixedId } from "./utils.js";
import { toRoomAgentSession } from "./mappers.js";
import type { Account, AgentIdentity, AuthState, CreatedRoomAgentSession, OwnerToken, OwnerTokenAccount, RoomAgentRegistrationLiveness, RoomAgentSession, RoomAgentSessionBearer, RoomAgentSessionRow, Session, SessionAccount, SupervisorHostGrant } from "./types.js";
import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ROOM_AGENT_RECONNECT_GRACE_MS,
  type RoomAgentSessionKind,
} from "../../shared/agent-presence.js";
import { DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES, getAgentSessionBearerTtlMs, isAgentSessionBearerFeatureEnabled, type AgentSessionBearerCapability } from "../../shared/agent-session-bearer.js";

export async function createAuthState(state: string, redirectTo?: string): Promise<AuthState> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTH_STATE_TTL_MS).toISOString();

  await db.delete(auth_states).where(lte(auth_states.expires_at, createdAt));

  const authState: AuthState = {
    id: await nextPrefixedId("auth_states", "auth_state"),
    state,
    redirect_to: redirectTo ?? null,
    expires_at: expiresAt,
    created_at: createdAt,
  };

  await db.insert(auth_states).values(authState);
  return authState;
}

export async function consumeAuthState(state: string): Promise<AuthState | null> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx.delete(auth_states).where(lte(auth_states.expires_at, now));

    const [authState] = await tx.select().from(auth_states).where(eq(auth_states.state, state)).limit(1);
    if (!authState) {
      return null;
    }

    await tx.delete(auth_states).where(eq(auth_states.state, state));
    return authState;
  });
}

export async function upsertAccount(input: {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
}): Promise<Account> {
  const [existing] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, input.provider),
        eq(accounts.provider_user_id, input.provider_user_id)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  if (existing) {
    await db
      .update(accounts)
      .set({
        login: input.login,
        display_name: input.display_name ?? null,
        avatar_url: input.avatar_url ?? null,
        updated_at: now,
      })
      .where(eq(accounts.id, existing.id));

    return {
      ...existing,
      login: input.login,
      display_name: input.display_name ?? null,
      avatar_url: input.avatar_url ?? null,
      updated_at: now,
    };
  }

  const account: Account = {
    id: await nextPrefixedId("accounts", "acct"),
    provider: input.provider,
    provider_user_id: input.provider_user_id,
    login: input.login,
    display_name: input.display_name ?? null,
    avatar_url: input.avatar_url ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(accounts).values(account);
  return account;
}

export async function createSession(
  accountId: string,
  token: string,
  expiresAt: string,
  providerAccessToken?: string | null
): Promise<Session> {
  const tokenHash = hashToken(token);
  const session: Session = {
    id: await nextPrefixedId("auth_sessions", "sess"),
    account_id: accountId,
    token_hash: tokenHash,
    provider_access_token: providerAccessToken ?? null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };

  await db.insert(auth_sessions).values(session);
  return session;
}

export async function refreshProviderAccessTokenForAccount(
  accountId: string,
  providerAccessToken: string | null | undefined
): Promise<void> {
  if (!providerAccessToken) {
    return;
  }

  const now = new Date().toISOString();

  await Promise.all([
    db
      .update(auth_sessions)
      .set({
        provider_access_token: providerAccessToken,
      })
      .where(eq(auth_sessions.account_id, accountId)),
    db
      .update(owner_tokens)
      .set({
        provider_access_token: providerAccessToken,
        updated_at: now,
      })
      .where(eq(owner_tokens.account_id, accountId)),
  ]);
}

export async function getSessionAccountByToken(token: string): Promise<SessionAccount | null> {
  const tokenHash = hashToken(token);
  const [session] = await db
    .select({
      id: auth_sessions.id,
      account_id: auth_sessions.account_id,
      token_hash: auth_sessions.token_hash,
      provider_access_token: auth_sessions.provider_access_token,
      expires_at: auth_sessions.expires_at,
      created_at: auth_sessions.created_at,
      provider: accounts.provider,
      provider_user_id: accounts.provider_user_id,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(auth_sessions)
    .innerJoin(accounts, eq(auth_sessions.account_id, accounts.id))
    .where(eq(auth_sessions.token_hash, tokenHash))
    .limit(1);

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await deleteSessionByToken(token);
    return null;
  }

  return session;
}

export async function deleteSessionByToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(auth_sessions).where(eq(auth_sessions.token_hash, tokenHash));
}

export async function createOwnerToken(input: {
  accountId: string;
  githubUserId: string;
  token: string;
  providerAccessToken?: string | null;
  oauthTokenExpiresAt?: string | null;
}): Promise<OwnerToken> {
  const now = new Date().toISOString();
  const tokenHash = hashToken(input.token);

  const ownerToken: OwnerToken = {
    token_id: await nextPrefixedId("owner_tokens", "owner_token"),
    account_id: input.accountId,
    github_user_id: input.githubUserId,
    token_hash: tokenHash,
    provider_access_token: input.providerAccessToken ?? null,
    oauth_token_expires_at: input.oauthTokenExpiresAt ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(owner_tokens).values(ownerToken);
  return ownerToken;
}

export async function getOwnerTokenAccountByToken(token: string): Promise<OwnerTokenAccount | null> {
  const tokenHash = hashToken(token);

  const [ownerToken] = await db
    .select({
      token_id: owner_tokens.token_id,
      account_id: owner_tokens.account_id,
      github_user_id: owner_tokens.github_user_id,
      token_hash: owner_tokens.token_hash,
      provider_access_token: owner_tokens.provider_access_token,
      oauth_token_expires_at: owner_tokens.oauth_token_expires_at,
      created_at: owner_tokens.created_at,
      updated_at: owner_tokens.updated_at,
      provider: accounts.provider,
      provider_user_id: accounts.provider_user_id,
      login: accounts.login,
      display_name: accounts.display_name,
      avatar_url: accounts.avatar_url,
    })
    .from(owner_tokens)
    .innerJoin(accounts, eq(owner_tokens.account_id, accounts.id))
    .where(eq(owner_tokens.token_hash, tokenHash))
    .limit(1);

  return ownerToken ?? null;
}

export async function registerAgentIdentity(input: {
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  name: string;
  display_name?: string;
}): Promise<AgentIdentity> {
  const canonicalKey = `${input.owner_login}/${input.name}`;
  const [existing] = await db
    .select()
    .from(agents)
    .where(eq(agents.canonical_key, canonicalKey))
    .limit(1);

  const now = new Date().toISOString();
  const displayName = input.display_name?.trim() || input.name;

  if (existing) {
    await db
      .update(agents)
      .set({
        display_name: displayName,
        owner_label: input.owner_label,
        updated_at: now,
      })
      .where(eq(agents.id, existing.id));

    return {
      ...existing,
      display_name: displayName,
      owner_label: input.owner_label,
      updated_at: now,
    };
  }

  const agent: AgentIdentity = {
    id: await nextPrefixedId("agents", "agent"),
    canonical_key: canonicalKey,
    name: input.name,
    display_name: displayName,
    owner_account_id: input.owner_account_id,
    owner_login: input.owner_login,
    owner_label: input.owner_label,
    created_at: now,
    updated_at: now,
  };

  await db.insert(agents).values(agent);
  return agent;
}

export async function getAgentIdentityByCanonicalKey(
  canonicalKey: string
): Promise<AgentIdentity | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.canonical_key, canonicalKey))
    .limit(1);

  return agent ?? null;
}

export async function getAgentIdentitiesForOwner(ownerAccountId: string): Promise<AgentIdentity[]> {
  return db
    .select()
    .from(agents)
    .where(eq(agents.owner_account_id, ownerAccountId))
    .orderBy(asc(agents.name));
}

export function makeAgentSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function makeAgentSessionBearerToken(): string {
  return `lasb_${crypto.randomBytes(32).toString("base64url")}`;
}

export function makeSupervisorGrantToken(): string {
  return `lashg_${crypto.randomBytes(32).toString("base64url")}`;
}

function toSupervisorHostGrant(row: typeof supervisor_host_grants.$inferSelect): SupervisorHostGrant {
  return {
    grant_id: row.grant_id,
    owner_account_id: row.owner_account_id,
    host_id: row.host_id,
    installation_id: row.installation_id,
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
  const sessionToken = makeAgentSessionToken();
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
  const sessionToken = makeAgentSessionToken();
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
    isNull(room_agent_sessions.ended_at),
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
  if (input.session_kind !== "worker" || !input.agent_instance_id?.trim()) {
    return {
      session: await createRoomAgentSession(input),
      replaced_session_ids: [],
    };
  }

  return db.transaction(async (tx) => {
    if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
      throw new Error("Supervisor grant fence is stale.");
    }

    const instanceId = input.agent_instance_id!.trim();
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_instance:${input.room_id}:${input.agent_key}:${instanceId}`}, 0))`);
    const predecessors = await tx
      .select()
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.agent_key, input.agent_key),
        eq(room_agent_sessions.agent_instance_id, instanceId),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        isNull(room_agent_sessions.ended_at),
      ))
      .orderBy(desc(room_agent_sessions.last_seen_at));

    const nowMs = Date.now();
    for (const row of predecessors) {
      const activeSession = toRoomAgentSession(row as RoomAgentSessionRow);
      if (!replacementProofMatches(row as RoomAgentSessionRow, replacementProof)
        && !isActiveRoomAgentSessionStaleForRegistration({
        active_session: activeSession,
        now_ms: nowMs,
      })) {
        throw new ActiveAgentInstanceConflictError(activeSession.session_id);
      }
    }

    const replacementTarget = predecessors.find((row: RoomAgentSessionRow) =>
      replacementProofMatches(row, replacementProof)
    ) ?? predecessors[0] ?? null;
    const replacedSessionIds = predecessors.map((row: RoomAgentSessionRow) => row.session_id);
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
      await tx.update(room_agent_delivery_sessions)
        .set({
          active_connection_count: 0,
          last_disconnected_at: now,
          reconnect_grace_expires_at: now,
          updated_at: now,
        })
        .where(inArray(room_agent_delivery_sessions.agent_session_id, replacedSessionIds));
      // Presence is actor-label keyed. Clear the replaced projection so an
      // intentional rename cannot leave an old-label ghost; the stable session
      // id keeps task leases, Board Manager authority, and liveness lineage.
      await tx.delete(room_agent_presence)
        .where(inArray(room_agent_presence.agent_session_id, replacedSessionIds));
    }

    return {
      session: replacementTarget
        ? await rotateRoomAgentSessionTx(
            tx,
            replacementTarget as RoomAgentSessionRow,
            { ...input, agent_instance_id: instanceId },
          )
        : await insertRoomAgentSessionTx(tx, { ...input, agent_instance_id: instanceId }),
      replaced_session_ids: replacedSessionIds,
    };
  });
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

  return db.transaction(async (tx) => {
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
      .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id));
    const retained = existing[0] ?? null;
    const duplicateSessionIds = existing.slice(1).map((row: RoomAgentSessionRow) => row.session_id);
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
      await tx.update(room_agent_delivery_sessions)
        .set({
          active_connection_count: 0,
          last_disconnected_at: now,
          reconnect_grace_expires_at: now,
          updated_at: now,
        })
        .where(inArray(room_agent_delivery_sessions.agent_session_id, duplicateSessionIds));
      await tx.delete(room_agent_presence)
        .where(inArray(room_agent_presence.agent_session_id, duplicateSessionIds));
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
    return { session, bearer: toRoomAgentSessionBearer(bearer) };
  });
}

export async function createSupervisorHostGrant(input: {
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  allowed_room_ids: string[];
  allowed_agent_keys: string[];
  expires_at: string;
}): Promise<{ grant: SupervisorHostGrant; token: string }> {
  const now = new Date().toISOString();
  const token = makeSupervisorGrantToken();
  const record = {
    grant_id: await nextPrefixedId("supervisor_host_grants", "supervisor_grant"),
    owner_account_id: input.owner_account_id,
    host_id: input.host_id,
    installation_id: input.installation_id,
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
  const [created] = await db.insert(supervisor_host_grants).values(record).returning();
  return { grant: toSupervisorHostGrant(created), token };
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
}): Promise<RoomAgentSession | null> {
  const [row] = await db.select().from(room_agent_sessions).where(and(
    eq(room_agent_sessions.session_id, input.session_id),
    eq(room_agent_sessions.supervisor_grant_id, input.supervisor_grant_id),
    eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
    isNull(room_agent_sessions.ended_at),
  )).limit(1);
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
    .where(and(
      eq(room_agent_session_bearers.token_hash, hashToken(token)),
      isNull(room_agent_session_bearers.revoked_at),
      gt(room_agent_session_bearers.expires_at, now),
      isNull(room_agent_sessions.ended_at),
      eq(room_agent_session_bearers.room_id, room_agent_sessions.room_id),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
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
  const conditions = [eq(room_agent_session_bearers.bearer_id, input.bearer_id), isNull(room_agent_session_bearers.revoked_at)];
  if (input.session_id) conditions.push(eq(room_agent_session_bearers.session_id, input.session_id));
  const [row] = await db
    .update(room_agent_session_bearers)
    .set({ revoked_at: new Date().toISOString() })
    .where(and(...conditions))
    .returning();
  return row ? toRoomAgentSessionBearer(row) : null;
}

export async function rotateRoomAgentSessionBearer(input: {
  bearer_id: string;
  session_id?: string;
  capabilities?: AgentSessionBearerCapability[];
  expires_at?: string;
  supervisor_grant_id?: string;
  supervisor_grant_fence?: SupervisorGrantFence;
}): Promise<{ bearer: RoomAgentSessionBearer; token: string } | null> {
  return db.transaction(async (tx) => {
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
    if (!current) return null;

    const nowDate = new Date();
    const now = nowDate.toISOString();
    await tx.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(eq(room_agent_session_bearers.bearer_id, current.bearer_id));

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
    return { bearer: toRoomAgentSessionBearer(created), token };
  });
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
}): Promise<RoomAgentSession | null> {
  return db.transaction(async (tx) => {
  if (input.supervisor_grant_fence && !(await assertSupervisorGrantFenceTx(tx, input.supervisor_grant_fence))) {
    throw new SupervisorGrantFenceStaleError();
  }
  if (input.supervisor_grant_id) {
    const [session] = await tx.select().from(room_agent_sessions).where(and(
      eq(room_agent_sessions.session_id, input.session_id),
      ...(input.owner_account_id ? [eq(room_agent_sessions.owner_account_id, input.owner_account_id)] : []),
      eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
      isNull(room_agent_sessions.ended_at),
    )).limit(1);
    if (!session?.agent_instance_id) throw new SupervisorGrantFenceStaleError();
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor_worker:${session.owner_account_id}:${session.room_id}:${session.agent_key}:${session.agent_instance_id}`}, 0))`);
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
    await tx.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(and(
        eq(room_agent_session_bearers.session_id, row.session_id),
        isNull(room_agent_session_bearers.revoked_at),
      ));
  }

  return row ? toRoomAgentSession(row as RoomAgentSessionRow) : null;
  });
}

export async function assignProjectAdmin(projectId: string, accountId: string): Promise<void> {
  await db
    .insert(project_admins)
    .values({
      project_id: projectId,
      account_id: accountId,
      assigned_at: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

export async function assignProjectAdminIfRoomHasNoAdmins(
  projectId: string,
  accountId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project_admin:${projectId}`}, 0))`);
    const [existing] = await tx
      .select({ account_id: project_admins.account_id })
      .from(project_admins)
      .where(eq(project_admins.project_id, projectId))
      .limit(1);
    if (existing) return;
    await tx
      .insert(project_admins)
      .values({
        project_id: projectId,
        account_id: accountId,
        assigned_at: new Date().toISOString(),
      })
      .onConflictDoNothing();
  });
}

export async function isProjectAdmin(projectId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(project_admins)
    .where(
      and(eq(project_admins.project_id, projectId), eq(project_admins.account_id, accountId))
    );

  return (row?.count ?? 0) > 0;
}
