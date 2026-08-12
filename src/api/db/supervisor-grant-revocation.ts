import {
  and,
  arrayOverlaps,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db } from "./client.js";
import {
  accounts,
  auth_sessions,
  github_app_repositories,
  owner_tokens,
  room_agent_sessions,
  room_git_bindings,
  room_aliases,
  rooms,
  supervisor_host_grants,
} from "./schema.js";
import {
  getSupervisorHostGrantById,
  revokeSupervisorHostGrant,
} from "./auth/supervisor-grants.js";
import {
  endRoomAgentSession,
  getSupervisorRoomAgentSession,
} from "./auth/room-agent-sessions.js";
import type { SupervisorHostGrant } from "./types.js";

export interface SupervisorGrantOwnerAccount {
  account_id: string;
  provider: string;
  login: string;
  provider_access_token: string;
}

export interface SupervisorGrantRevocationResult {
  grant: SupervisorHostGrant;
  revoked_now: boolean;
  ended_session_ids: string[];
}

/**
 * Resolve the durable owner credential used to re-check a long-lived grant.
 * Device re-authorization can leave older owner-token rows behind, so the
 * most recently refreshed credential is authoritative.
 */
export async function getSupervisorGrantOwnerAccount(
  accountId: string,
): Promise<SupervisorGrantOwnerAccount | null> {
  const now = new Date().toISOString();
  const [ownerToken] = await db
    .select({
      account_id: owner_tokens.account_id,
      provider_access_token: owner_tokens.provider_access_token,
      provider: accounts.provider,
      login: accounts.login,
    })
    .from(owner_tokens)
    .innerJoin(accounts, eq(owner_tokens.account_id, accounts.id))
    .where(and(
      eq(owner_tokens.account_id, accountId),
      eq(accounts.provider, "github"),
      sql`${owner_tokens.provider_access_token} IS NOT NULL`,
      or(
        isNull(owner_tokens.oauth_token_expires_at),
        gt(owner_tokens.oauth_token_expires_at, now),
      ),
    ))
    .orderBy(desc(owner_tokens.updated_at), desc(owner_tokens.created_at))
    .limit(1);

  if (ownerToken?.provider_access_token) {
    return ownerToken as SupervisorGrantOwnerAccount;
  }

  // Browser-provisioned grants may predate device-flow owner tokens. Reuse a
  // live web session's provider credential instead of misclassifying missing
  // bootstrap state as repository access loss.
  const [sessionAccount] = await db
    .select({
      account_id: auth_sessions.account_id,
      provider_access_token: auth_sessions.provider_access_token,
      provider: accounts.provider,
      login: accounts.login,
    })
    .from(auth_sessions)
    .innerJoin(accounts, eq(auth_sessions.account_id, accounts.id))
    .where(and(
      eq(auth_sessions.account_id, accountId),
      eq(accounts.provider, "github"),
      gt(auth_sessions.expires_at, now),
      sql`${auth_sessions.provider_access_token} IS NOT NULL`,
    ))
    .orderBy(desc(auth_sessions.created_at))
    .limit(1);

  return sessionAccount?.provider_access_token
    ? sessionAccount as SupervisorGrantOwnerAccount
    : null;
}

/**
 * Revoke the supervisor credential first, then end every worker it owns.
 * Revocation closes the mint/rotate fence before the session scan, so a
 * concurrently committing worker cannot escape teardown.
 */
export async function revokeSupervisorGrantAuthority(input: {
  grant_id: string;
  owner_account_id: string;
}): Promise<SupervisorGrantRevocationResult | null> {
  const current = await getSupervisorHostGrantById(input.grant_id);
  if (!current || current.owner_account_id !== input.owner_account_id) return null;

  const revoked = await revokeSupervisorHostGrant(input);
  const activeSessions = await db
    .select({ session_id: room_agent_sessions.session_id })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.supervisor_grant_id, input.grant_id),
      eq(room_agent_sessions.owner_account_id, input.owner_account_id),
      eq(room_agent_sessions.session_kind, "worker"),
      isNull(room_agent_sessions.ended_at),
    ));

  const endedSessionIds: string[] = [];
  for (const session of activeSessions) {
    try {
      const ended = await endRoomAgentSession({
        session_id: session.session_id,
        owner_account_id: input.owner_account_id,
        supervisor_grant_id: input.grant_id,
      });
      if (ended) endedSessionIds.push(ended.session_id);
    } catch (error) {
      // Another cleanup path may win after the active-session snapshot. Treat
      // that as success only when the exact grant-owned worker is now ended.
      const observed = await getSupervisorRoomAgentSession({
        session_id: session.session_id,
        supervisor_grant_id: input.grant_id,
        include_ended: true,
      });
      if (!observed?.ended_at) throw error;
      endedSessionIds.push(observed.session_id);
    }
  }

  return {
    grant: revoked ?? current,
    revoked_now: Boolean(revoked),
    ended_session_ids: endedSessionIds,
  };
}

export async function listSupervisorGrantAuthoritiesForRepository(input: {
  repository_full_name: string;
  canonical_room_id: string;
  owner_login?: string | null;
}): Promise<Array<{ grant_id: string; owner_account_id: string }>> {
  const gitRooms = await db
    .select({ room_id: room_git_bindings.room_id })
    .from(room_git_bindings)
    .where(and(
      eq(room_git_bindings.provider, "github"),
      sql`lower(${room_git_bindings.repository_full_name}) = lower(${input.repository_full_name})`,
    ));
  const gitRoomIds = [...new Set([
    input.canonical_room_id,
    ...gitRooms.map((binding) => binding.room_id),
  ].filter(Boolean))];
  const aliases = gitRoomIds.length === 0
    ? []
    : await db
      .select({ room_id: room_aliases.alias })
      .from(room_aliases)
      .where(inArray(room_aliases.room_id, gitRoomIds));
  const focusRooms = gitRoomIds.length === 0
    ? []
    : await db
      .select({ room_id: rooms.id })
      .from(rooms)
      .where(inArray(rooms.parent_room_id, gitRoomIds));
  const affectedRoomIds = [...new Set([
    ...gitRoomIds,
    ...aliases.map((room) => room.room_id),
    ...focusRooms.map((room) => room.room_id),
  ])];
  if (affectedRoomIds.length === 0) return [];

  const conditions = [
    or(
      and(
        isNull(supervisor_host_grants.revoked_at),
        gt(supervisor_host_grants.expires_at, new Date().toISOString()),
      ),
      sql`EXISTS (
        SELECT 1 FROM ${room_agent_sessions}
        WHERE ${room_agent_sessions.supervisor_grant_id} = ${supervisor_host_grants.grant_id}
          AND ${room_agent_sessions.owner_account_id} = ${supervisor_host_grants.owner_account_id}
          AND ${room_agent_sessions.session_kind} = 'worker'
          AND ${room_agent_sessions.ended_at} IS NULL
      )`,
    ),
    arrayOverlaps(supervisor_host_grants.allowed_room_ids, affectedRoomIds),
  ];
  if (input.owner_login?.trim()) {
    conditions.push(sql`lower(${accounts.login}) = lower(${input.owner_login.trim()})`);
  }

  return db
    .select({
      grant_id: supervisor_host_grants.grant_id,
      owner_account_id: supervisor_host_grants.owner_account_id,
    })
    .from(supervisor_host_grants)
    .innerJoin(accounts, eq(supervisor_host_grants.owner_account_id, accounts.id))
    .where(and(...conditions));
}

/**
 * Invalidate repo-scoped supervisor authority after a definitive GitHub
 * authorization-boundary event. A privatization invalidates every grant
 * issued while the room was public; a member removal targets that login.
 */
export async function revokeSupervisorGrantsForRepositoryAccessChange(input: {
  repository_full_name: string;
  canonical_room_id: string;
  owner_login?: string | null;
}): Promise<{
  revoked_grant_ids: string[];
  ended_session_ids: string[];
}> {
  const grants = await listSupervisorGrantAuthoritiesForRepository(input);
  const revokedGrantIds: string[] = [];
  const endedSessionIds: string[] = [];
  for (const grant of grants) {
    const result = await revokeSupervisorGrantAuthority(grant);
    if (!result) continue;
    if (result.revoked_now) revokedGrantIds.push(result.grant.grant_id);
    endedSessionIds.push(...result.ended_session_ids);
  }
  return {
    revoked_grant_ids: revokedGrantIds,
    ended_session_ids: [...new Set(endedSessionIds)],
  };
}

/** Definitive App-installation loss revokes every repository-scoped grant. */
export async function revokeSupervisorGrantsForGitHubInstallationAccessChange(input: {
  installation_id: string;
  repositories?: Array<{ full_name: string; room_id?: string | null }>;
}): Promise<{
  revoked_grant_ids: string[];
  ended_session_ids: string[];
}> {
  const storedRepositories = await db
    .select({
      full_name: github_app_repositories.full_name,
      room_id: github_app_repositories.room_id,
    })
    .from(github_app_repositories)
    .where(eq(github_app_repositories.installation_id, input.installation_id));
  const repositories = new Map<string, { full_name: string; room_id: string }>();
  for (const repository of [...storedRepositories, ...(input.repositories ?? [])]) {
    const fullName = repository.full_name.trim();
    if (!fullName) continue;
    repositories.set(fullName.toLowerCase(), {
      full_name: fullName,
      room_id: repository.room_id?.trim() || `github.com/${fullName.toLowerCase()}`,
    });
  }

  const revokedGrantIds: string[] = [];
  const endedSessionIds: string[] = [];
  for (const repository of repositories.values()) {
    const result = await revokeSupervisorGrantsForRepositoryAccessChange({
      repository_full_name: repository.full_name,
      canonical_room_id: repository.room_id,
    });
    revokedGrantIds.push(...result.revoked_grant_ids);
    endedSessionIds.push(...result.ended_session_ids);
  }
  return {
    revoked_grant_ids: [...new Set(revokedGrantIds)],
    ended_session_ids: [...new Set(endedSessionIds)],
  };
}
