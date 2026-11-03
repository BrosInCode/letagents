import { and, asc, desc, eq, lt, notInArray, sql } from "drizzle-orm";

import { db } from "./client.js";
import { mcp_oauth_grants, owner_tokens, remote_mcp_credentials, remote_mcp_sessions } from "./schema.js";

export type RemoteMcpSessionRow = typeof remote_mcp_sessions.$inferSelect;
export type RemoteMcpCredentialRow = typeof remote_mcp_credentials.$inferSelect;

/**
 * Insert a session row. Returns false when nothing was inserted: an implicit
 * session already exists for the credential (one per credential, enforced by
 * a partial unique index).
 */
export async function insertRemoteMcpSession(input: {
  sessionId: string;
  accountId: string;
  tokenHash: string;
  agentInstanceId: string;
  clientName: string | null;
  implicit: boolean;
  state: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await db.insert(remote_mcp_sessions).values({
    session_id: input.sessionId,
    account_id: input.accountId,
    token_hash: input.tokenHash,
    agent_instance_id: input.agentInstanceId,
    client_name: input.clientName,
    implicit: input.implicit,
    state: input.state,
  }).onConflictDoNothing().returning({ session_id: remote_mcp_sessions.session_id });
  return rows.length > 0;
}

export async function getRemoteMcpSession(sessionId: string): Promise<RemoteMcpSessionRow | null> {
  const [row] = await db.select().from(remote_mcp_sessions)
    .where(eq(remote_mcp_sessions.session_id, sessionId)).limit(1);
  return row ?? null;
}

/** The credential's implicit session (requests without a session id), if any. */
export async function findImplicitRemoteMcpSession(accountId: string, tokenHash: string): Promise<RemoteMcpSessionRow | null> {
  const [row] = await db.select().from(remote_mcp_sessions)
    .where(and(
      eq(remote_mcp_sessions.account_id, accountId),
      eq(remote_mcp_sessions.token_hash, tokenHash),
      eq(remote_mcp_sessions.implicit, true),
    ))
    .orderBy(desc(remote_mcp_sessions.last_seen_at))
    .limit(1);
  return row ?? null;
}

/** Save a session's state; returns the new version, or null when the row is gone or newer. */
export async function saveRemoteMcpSessionState(input: {
  sessionId: string;
  /** Write only over this version (optimistic concurrency). */
  expectedVersion: number;
  state: Record<string, unknown>;
  roomId: string | null;
  workerSessionId: string | null;
  readCursor: string | null;
}): Promise<number | null> {
  const [row] = await db.update(remote_mcp_sessions).set({
    state: input.state,
    room_id: input.roomId,
    worker_session_id: input.workerSessionId,
    read_cursor: input.readCursor,
    version: sql`${remote_mcp_sessions.version} + 1`,
    last_seen_at: sql`now()`,
  }).where(and(
    eq(remote_mcp_sessions.session_id, input.sessionId),
    eq(remote_mcp_sessions.version, input.expectedVersion),
  )).returning({ version: remote_mcp_sessions.version });
  return row?.version ?? null;
}

export async function touchRemoteMcpSession(sessionId: string): Promise<void> {
  await db.update(remote_mcp_sessions).set({ last_seen_at: sql`now()` })
    .where(eq(remote_mcp_sessions.session_id, sessionId));
}

export async function deleteRemoteMcpSession(sessionId: string): Promise<void> {
  await db.delete(remote_mcp_sessions).where(eq(remote_mcp_sessions.session_id, sessionId));
}

/** An account's sessions, least recently used first. */
export async function listRemoteMcpSessionsForAccount(accountId: string): Promise<Array<{
  session_id: string;
  token_hash: string;
  implicit: boolean;
  last_seen_at: string;
}>> {
  return db.select({
    session_id: remote_mcp_sessions.session_id, token_hash: remote_mcp_sessions.token_hash,
    implicit: remote_mcp_sessions.implicit, last_seen_at: remote_mcp_sessions.last_seen_at,
  })
    .from(remote_mcp_sessions)
    .where(eq(remote_mcp_sessions.account_id, accountId))
    .orderBy(asc(remote_mcp_sessions.last_seen_at));
}

/** Delete sessions idle since before `cutoffIso`, except busy ones; returns their ids. */
export async function deleteIdleRemoteMcpSessions(cutoffIso: string, busySessionIds: string[] = []): Promise<string[]> {
  const rows = await db.delete(remote_mcp_sessions)
    .where(and(
      lt(remote_mcp_sessions.last_seen_at, cutoffIso),
      busySessionIds.length ? notInArray(remote_mcp_sessions.session_id, busySessionIds) : undefined,
    ))
    .returning({ session_id: remote_mcp_sessions.session_id });
  return rows.map((row) => row.session_id);
}

/** Delete sessions whose owner token or OAuth grant no longer exists or is revoked; returns their ids. */
export async function deleteRevokedRemoteMcpSessions(): Promise<string[]> {
  const rows = await db.delete(remote_mcp_sessions)
    .where(sql`NOT EXISTS (SELECT 1 FROM ${owner_tokens} WHERE ${owner_tokens.token_hash} = ${remote_mcp_sessions.token_hash})
      AND NOT EXISTS (SELECT 1 FROM ${mcp_oauth_grants} WHERE ${mcp_oauth_grants.secret_hash} = ${remote_mcp_sessions.token_hash}
        AND ${mcp_oauth_grants.revoked_at} IS NULL AND ${mcp_oauth_grants.expires_at} > now())`)
    .returning({ session_id: remote_mcp_sessions.session_id });
  return rows.map((row) => row.session_id);
}

export async function getRemoteMcpCredential(tokenHash: string): Promise<RemoteMcpCredentialRow | null> {
  const [row] = await db.select().from(remote_mcp_credentials)
    .where(eq(remote_mcp_credentials.token_hash, tokenHash)).limit(1);
  return row ?? null;
}

/** True while the owner token or OAuth grant behind `tokenHash` is live. */
function credentialIsLive(tokenHash: string) {
  return sql`(EXISTS (SELECT 1 FROM ${owner_tokens} WHERE ${owner_tokens.token_hash} = ${tokenHash})
    OR EXISTS (SELECT 1 FROM ${mcp_oauth_grants} WHERE ${mcp_oauth_grants.secret_hash} = ${tokenHash}
      AND ${mcp_oauth_grants.revoked_at} IS NULL AND ${mcp_oauth_grants.expires_at} > now()))`;
}

/**
 * Save a credential's merged state. With `expectedVersion` null the row is
 * created; otherwise it is written only over that version. Either write
 * happens only while the credential is live, so a call that outlives a
 * revocation cannot bring the row back. Returns the new version, or null when
 * nothing was written (another replica created or changed the row first, or
 * the credential is gone).
 */
export async function saveRemoteMcpCredentialState(input: {
  tokenHash: string;
  accountId: string;
  expectedVersion: number | null;
  state: Record<string, unknown>;
}): Promise<number | null> {
  const state = JSON.stringify(input.state);
  const result = input.expectedVersion === null
    ? await db.execute<{ version: number }>(sql`
        INSERT INTO ${remote_mcp_credentials} (token_hash, account_id, state)
        SELECT ${input.tokenHash}, ${input.accountId}, ${state}::jsonb WHERE ${credentialIsLive(input.tokenHash)}
        ON CONFLICT DO NOTHING RETURNING version`)
    : await db.execute<{ version: number }>(sql`
        UPDATE ${remote_mcp_credentials} SET state = ${state}::jsonb, version = version + 1, updated_at = now()
        WHERE token_hash = ${input.tokenHash} AND account_id = ${input.accountId} AND version = ${input.expectedVersion}
          AND ${credentialIsLive(input.tokenHash)}
        RETURNING version`);
  const version = result.rows[0]?.version;
  return typeof version === "number" ? version : null;
}

/** Delete credential state whose owner token or OAuth grant no longer exists or is revoked. */
export async function deleteRevokedRemoteMcpCredentials(): Promise<string[]> {
  const rows = await db.delete(remote_mcp_credentials)
    .where(sql`NOT EXISTS (SELECT 1 FROM ${owner_tokens} WHERE ${owner_tokens.token_hash} = ${remote_mcp_credentials.token_hash})
      AND NOT EXISTS (SELECT 1 FROM ${mcp_oauth_grants} WHERE ${mcp_oauth_grants.secret_hash} = ${remote_mcp_credentials.token_hash}
        AND ${mcp_oauth_grants.revoked_at} IS NULL AND ${mcp_oauth_grants.expires_at} > now())`)
    .returning({ token_hash: remote_mcp_credentials.token_hash });
  return rows.map((row) => row.token_hash);
}

/** Delete one session only if it still belongs to this account (eviction). */
export async function deleteRemoteMcpSessionForAccount(sessionId: string, accountId: string): Promise<void> {
  await db.delete(remote_mcp_sessions).where(and(
    eq(remote_mcp_sessions.session_id, sessionId),
    eq(remote_mcp_sessions.account_id, accountId),
  ));
}
