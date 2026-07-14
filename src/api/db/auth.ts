import crypto from "crypto";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { db } from "./client.js";
import { accounts, agents, auth_sessions, auth_states, owner_tokens, project_admins, room_agent_session_bearers, room_agent_sessions } from "./schema.js";
import { AUTH_STATE_TTL_MS, hashToken, nextPrefixedId } from "./utils.js";
import { toRoomAgentSession } from "./mappers.js";
import type { Account, AgentIdentity, AuthState, CreatedRoomAgentSession, OwnerToken, OwnerTokenAccount, RoomAgentRegistrationLiveness, RoomAgentSession, RoomAgentSessionBearer, RoomAgentSessionRow, Session, SessionAccount } from "./types.js";
import type { RoomAgentSessionKind } from "../../shared/agent-presence.js";
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
  };
}

function newBearerExpiry(now: Date): string {
  return new Date(now.getTime() + getAgentSessionBearerTtlMs()).toISOString();
}

export async function createRoomAgentSession(input: {
  room_id: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  registration_liveness?: RoomAgentRegistrationLiveness | null;
  repo_branch?: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id?: string | null;
  display_name: string;
  owner_account_id: string;
  owner_label: string;
  ide_label: string;
}): Promise<CreatedRoomAgentSession> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const sessionToken = makeAgentSessionToken();
  const workerBearer = input.session_kind === "worker" && isAgentSessionBearerFeatureEnabled()
    ? makeAgentSessionBearerToken()
    : null;
  const session = {
    session_id: await nextPrefixedId("room_agent_sessions", "agent_session"),
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
    owner_account_id: input.owner_account_id,
    owner_label: input.owner_label,
    ide_label: input.ide_label,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  };

  return db.transaction(async (tx) => {
    const [created] = await tx.insert(room_agent_sessions).values(session).returning();
    if (workerBearer) await tx.insert(room_agent_session_bearers).values({
      bearer_id: await nextPrefixedId("room_agent_session_bearers", "agent_bearer", tx),
      session_id: session.session_id,
      room_id: session.room_id,
      token_hash: hashToken(workerBearer),
      generation: 1,
      capabilities: DEFAULT_AGENT_SESSION_BEARER_CAPABILITIES,
      issued_at: now,
      expires_at: newBearerExpiry(nowDate),
      revoked_at: null,
      rotated_from_bearer_id: null,
      created_at: now,
    });
    return { ...toRoomAgentSession(created as RoomAgentSessionRow), session_token: sessionToken, worker_bearer: workerBearer };
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
  capabilities?: AgentSessionBearerCapability[];
}): Promise<{ bearer: RoomAgentSessionBearer; token: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent_bearer:${input.bearer_id}`}, 0))`);
    const [current] = await tx
      .select()
      .from(room_agent_session_bearers)
      .where(and(
        eq(room_agent_session_bearers.bearer_id, input.bearer_id),
        isNull(room_agent_session_bearers.revoked_at),
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
      token_hash: hashToken(token),
      generation: current.generation + 1,
      capabilities: input.capabilities ?? current.capabilities,
      issued_at: now,
      expires_at: newBearerExpiry(nowDate),
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
}): Promise<RoomAgentSession | null> {
  const now = new Date().toISOString();
  const conditions = [eq(room_agent_sessions.session_id, input.session_id)];
  if (input.room_id) {
    conditions.push(eq(room_agent_sessions.room_id, input.room_id));
  }
  if (input.owner_account_id) {
    conditions.push(eq(room_agent_sessions.owner_account_id, input.owner_account_id));
  }

  const [row] = await db
    .update(room_agent_sessions)
    .set({
      ended_at: now,
      updated_at: now,
      last_seen_at: now,
    })
    .where(and(...conditions))
    .returning();

  if (row) {
    await db.update(room_agent_session_bearers)
      .set({ revoked_at: now })
      .where(and(
        eq(room_agent_session_bearers.session_id, row.session_id),
        isNull(room_agent_session_bearers.revoked_at),
      ));
  }

  return row ? toRoomAgentSession(row as RoomAgentSessionRow) : null;
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
