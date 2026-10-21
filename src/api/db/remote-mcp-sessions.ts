import { and, asc, eq, lt, sql } from "drizzle-orm";

import { db } from "./client.js";
import { owner_tokens, remote_mcp_sessions } from "./schema.js";

export type RemoteMcpSessionRow = typeof remote_mcp_sessions.$inferSelect;

export async function insertRemoteMcpSession(input: {
  sessionId: string;
  accountId: string;
  tokenHash: string;
  agentInstanceId: string;
  clientName: string | null;
  state: Record<string, unknown>;
}): Promise<void> {
  await db.insert(remote_mcp_sessions).values({
    session_id: input.sessionId,
    account_id: input.accountId,
    token_hash: input.tokenHash,
    agent_instance_id: input.agentInstanceId,
    client_name: input.clientName,
    state: input.state,
  });
}

export async function getRemoteMcpSession(sessionId: string): Promise<RemoteMcpSessionRow | null> {
  const [row] = await db.select().from(remote_mcp_sessions)
    .where(eq(remote_mcp_sessions.session_id, sessionId)).limit(1);
  return row ?? null;
}

/** Save a session's state; returns the new version, or null when the row is gone. */
export async function saveRemoteMcpSessionState(input: {
  sessionId: string;
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
  }).where(eq(remote_mcp_sessions.session_id, input.sessionId))
    .returning({ version: remote_mcp_sessions.version });
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
  last_seen_at: string;
}>> {
  return db.select({ session_id: remote_mcp_sessions.session_id, last_seen_at: remote_mcp_sessions.last_seen_at })
    .from(remote_mcp_sessions)
    .where(eq(remote_mcp_sessions.account_id, accountId))
    .orderBy(asc(remote_mcp_sessions.last_seen_at));
}

/** Delete sessions idle since before `cutoffIso`; returns their ids. */
export async function deleteIdleRemoteMcpSessions(cutoffIso: string): Promise<string[]> {
  const rows = await db.delete(remote_mcp_sessions)
    .where(lt(remote_mcp_sessions.last_seen_at, cutoffIso))
    .returning({ session_id: remote_mcp_sessions.session_id });
  return rows.map((row) => row.session_id);
}

/** Delete sessions whose owner token no longer exists; returns their ids. */
export async function deleteRevokedRemoteMcpSessions(): Promise<string[]> {
  const rows = await db.delete(remote_mcp_sessions)
    .where(sql`NOT EXISTS (SELECT 1 FROM ${owner_tokens} WHERE ${owner_tokens.token_hash} = ${remote_mcp_sessions.token_hash})`)
    .returning({ session_id: remote_mcp_sessions.session_id });
  return rows.map((row) => row.session_id);
}

/** Delete one session only if it still belongs to this account (eviction). */
export async function deleteRemoteMcpSessionForAccount(sessionId: string, accountId: string): Promise<void> {
  await db.delete(remote_mcp_sessions).where(and(
    eq(remote_mcp_sessions.session_id, sessionId),
    eq(remote_mcp_sessions.account_id, accountId),
  ));
}
