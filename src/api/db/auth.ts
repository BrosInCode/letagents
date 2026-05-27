import crypto from "crypto";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "./client.js";
import { accounts, agents, auth_sessions, auth_states, owner_tokens, project_admins, room_agent_sessions } from "./schema.js";
import { AUTH_STATE_TTL_MS, hashToken, nextPrefixedId } from "./utils.js";
import { toRoomAgentSession } from "./mappers.js";
import type { Account, AgentIdentity, AuthState, CreatedRoomAgentSession, OwnerToken, OwnerTokenAccount, RoomAgentRegistrationLiveness, RoomAgentSession, RoomAgentSessionRow, Session, SessionAccount } from "./types.js";
import type { RoomAgentSessionKind } from "../../shared/agent-presence.js";

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

export async function createRoomAgentSession(input: {
  room_id: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  registration_liveness?: RoomAgentRegistrationLiveness | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id?: string | null;
  display_name: string;
  owner_account_id: string;
  owner_label: string;
  ide_label: string;
}): Promise<CreatedRoomAgentSession> {
  const now = new Date().toISOString();
  const sessionToken = makeAgentSessionToken();
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

  const [created] = await db
    .insert(room_agent_sessions)
    .values(session)
    .returning();

  return {
    ...toRoomAgentSession(created as RoomAgentSessionRow),
    session_token: sessionToken,
  };
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
