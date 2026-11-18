import type { PoolClient } from "pg";

import { pool } from "./client.js";
import type { OwnerTokenAccount } from "./types/auth.js";

/**
 * Storage for `page_grant` bearer tokens (migration 0151). Callers pass the
 * token's SHA-256 hex, never the token.
 *
 * Mint, refresh and revoke serialize on advisory locks, one per account,
 * room, page and minting session a token belongs to. Without them a refresh
 * that read its old token as live just before a revoke could insert a new
 * token the revoke never sees. A revoke locks the dimensions it filters by,
 * so it waits for any mint or refresh that could add a matching token, and
 * a refresh after the revoke finds its old token revoked.
 */

export interface ApiPageTokenRow {
  token_id: string;
  token_hash: string;
  account_id: string;
  session_id: string;
  room_id: string;
  page_id: string;
  page_version: number;
  capabilities: string[];
  created_at: string;
  expires_at: string;
}

/** A live page token with its person, shaped like an owner token's account. */
export interface ApiPageTokenAccount {
  token: ApiPageTokenRow;
  account: OwnerTokenAccount;
}

export interface NewApiPageToken {
  tokenId: string;
  tokenHash: string;
  accountId: string;
  sessionId: string;
  roomId: string;
  pageId: string;
  pageVersion: number;
  capabilities: readonly string[];
  expiresAt: string;
}

export interface ApiPageTokenFilter {
  pageId?: string;
  roomId?: string;
  accountId?: string;
  sessionId?: string;
  tokenId?: string;
}

type LockDimension = "account" | "room" | "page" | "session";

/** The advisory lock key of one dimension; exported for the race test. */
export function apiPageTokenLockKey(dimension: LockDimension, id: string): string {
  return `api_page_tokens:${dimension}:${id}`;
}

// A live token: unexpired, unrevoked, and its minting session still signed in.
const LIVE = `t.revoked_at IS NULL AND t.expires_at > now()
  AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = t.session_id AND s.expires_at > now())`;

const TOKEN_COLUMNS = `t.token_id, t.token_hash, t.account_id, t.session_id, t.room_id, t.page_id, t.page_version,
  t.capabilities, t.created_at::text AS created_at, t.expires_at::text AS expires_at`;

async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Takes all the locks at once, in one sorted order, so two writers never deadlock. */
async function lockDimensions(client: PoolClient, dimensions: ReadonlyArray<readonly [LockDimension, string | undefined]>): Promise<void> {
  const keys = [...new Set(dimensions
    .filter((entry): entry is readonly [LockDimension, string] => typeof entry[1] === "string")
    .map(([dimension, id]) => apiPageTokenLockKey(dimension, id)))]
    .sort();
  for (const key of keys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 9151))", [key]);
}

async function insertLocked(client: PoolClient, input: NewApiPageToken): Promise<ApiPageTokenRow> {
  // Rows that can never be used again go when the same person mints, so the
  // table stays the size of the live tokens without a sweeper.
  await client.query(`DELETE FROM api_page_tokens
    WHERE account_id = $1 AND (expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day')`, [input.accountId]);
  const result = await client.query<ApiPageTokenRow>(`
    INSERT INTO api_page_tokens AS t
      (token_id, token_hash, account_id, session_id, room_id, page_id, page_version, capabilities, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
    RETURNING ${TOKEN_COLUMNS}`,
  [input.tokenId, input.tokenHash, input.accountId, input.sessionId, input.roomId, input.pageId, input.pageVersion,
    JSON.stringify(input.capabilities), input.expiresAt]);
  return result.rows[0]!;
}

function dimensionsOf(token: { accountId: string; roomId: string; pageId: string; sessionId: string }) {
  return [["account", token.accountId], ["room", token.roomId], ["page", token.pageId], ["session", token.sessionId]] as const;
}

export async function insertApiPageToken(input: NewApiPageToken): Promise<ApiPageTokenRow> {
  return inTransaction(async (client) => {
    await lockDimensions(client, dimensionsOf(input));
    return insertLocked(client, input);
  });
}

/**
 * A new token with the binding of a live one of the same account. Returns
 * null when the old token is not live (or another person's) once the locks
 * are held, or when its page version is no longer the page's live version
 * pinned in the room, or no longer granted every capability the token holds.
 * The pages registry revokes such tokens after it commits a change; this
 * closes the gap between its commit and that revoke.
 */
export async function refreshApiPageToken(input: {
  oldTokenHash: string;
  accountId: string;
  next: Omit<NewApiPageToken, "accountId" | "roomId" | "pageId" | "pageVersion" | "capabilities">;
}): Promise<ApiPageTokenRow | null> {
  const before = await getLiveApiPageToken(input.oldTokenHash);
  if (!before || before.account_id !== input.accountId) return null;
  return inTransaction(async (client) => {
    // The new token's dimensions, plus the old token's session.
    await lockDimensions(client, [
      ...dimensionsOf({ accountId: before.account_id, roomId: before.room_id, pageId: before.page_id, sessionId: input.next.sessionId }),
      ["session", before.session_id],
    ]);
    const current = await client.query<ApiPageTokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_page_tokens t
      WHERE t.token_hash = $1 AND t.account_id = $2 AND ${LIVE}`, [input.oldTokenHash, input.accountId]);
    const old = current.rows[0];
    if (!old) return null;
    const page = await client.query<{ capabilities: string[] }>(`SELECT g.capabilities FROM pages p
      JOIN page_grants g ON g.page_id = p.id AND g.version = p.current_version AND g.room_id = $3
      WHERE p.id = $1 AND p.current_version = $2
        AND EXISTS (SELECT 1 FROM page_placements pl WHERE pl.page_id = p.id AND pl.room_id = $3)`,
    [old.page_id, old.page_version, old.room_id]);
    const granted = page.rows[0]?.capabilities;
    if (!granted || !old.capabilities.every((name) => granted.includes(name))) return null;
    return insertLocked(client, {
      ...input.next,
      accountId: old.account_id,
      roomId: old.room_id,
      pageId: old.page_id,
      pageVersion: old.page_version,
      capabilities: old.capabilities,
    });
  });
}

/** A live page token by its hash. */
export async function getLiveApiPageToken(tokenHash: string): Promise<ApiPageTokenRow | null> {
  const result = await pool.query<ApiPageTokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_page_tokens t
    WHERE t.token_hash = $1 AND ${LIVE}`, [tokenHash]);
  return result.rows[0] ?? null;
}

interface TokenAccountRow extends ApiPageTokenRow {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  provider_access_token: string | null;
}

/**
 * A live page token and its person. The account carries the person's current
 * GitHub token (newest owner token, else newest browser session), as an MCP
 * OAuth grant's account does, so a repository room's access check runs as
 * the person; the page token itself holds no GitHub token.
 */
export async function getLiveApiPageTokenAccount(tokenHash: string): Promise<ApiPageTokenAccount | null> {
  const result = await pool.query<TokenAccountRow>(`
    SELECT ${TOKEN_COLUMNS},
           a.provider, a.provider_user_id, a.login, a.display_name, a.avatar_url,
           COALESCE(
             (SELECT o.provider_access_token FROM owner_tokens o
               WHERE o.account_id = a.id AND o.provider_access_token IS NOT NULL
                 AND (o.oauth_token_expires_at IS NULL OR o.oauth_token_expires_at > now())
               ORDER BY o.updated_at DESC LIMIT 1),
             (SELECT s.provider_access_token FROM auth_sessions s
               WHERE s.account_id = a.id AND s.provider_access_token IS NOT NULL AND s.expires_at > now()
               ORDER BY s.created_at DESC LIMIT 1)
           ) AS provider_access_token
    FROM api_page_tokens t JOIN accounts a ON a.id = t.account_id
    WHERE t.token_hash = $1 AND ${LIVE}`, [tokenHash]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    token: {
      token_id: row.token_id,
      token_hash: row.token_hash,
      account_id: row.account_id,
      session_id: row.session_id,
      room_id: row.room_id,
      page_id: row.page_id,
      page_version: row.page_version,
      capabilities: row.capabilities,
      created_at: row.created_at,
      expires_at: row.expires_at,
    },
    account: {
      token_id: row.token_id,
      account_id: row.account_id,
      github_user_id: row.provider_user_id,
      token_hash: row.token_hash,
      provider_access_token: row.provider_access_token,
      oauth_token_expires_at: null,
      created_at: row.created_at,
      updated_at: row.created_at,
      provider: row.provider,
      provider_user_id: row.provider_user_id,
      login: row.login,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    },
  };
}

/**
 * Revokes every live token that matches all the given filters (at least one
 * is required) and returns the revoked tokens' hashes, so their open streams
 * can be closed.
 */
export async function revokeApiPageTokens(filter: ApiPageTokenFilter): Promise<string[]> {
  const clauses: string[] = [];
  const values: string[] = [];
  for (const [column, value] of [
    ["page_id", filter.pageId],
    ["room_id", filter.roomId],
    ["account_id", filter.accountId],
    ["session_id", filter.sessionId],
    ["token_id", filter.tokenId],
  ] as const) {
    if (value === undefined) continue;
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }
  if (!clauses.length) throw new TypeError("revokeApiPageTokens needs a page, room, account, session or token filter.");
  return inTransaction(async (client) => {
    let page = filter.pageId;
    if (filter.tokenId && !page) {
      // One token: a refresh of it locks its page, so this does too.
      const token = await client.query<{ page_id: string }>("SELECT page_id FROM api_page_tokens WHERE token_id = $1", [filter.tokenId]);
      page = token.rows[0]?.page_id;
    }
    await lockDimensions(client, [["account", filter.accountId], ["room", filter.roomId], ["page", page], ["session", filter.sessionId]]);
    const result = await client.query<{ token_hash: string }>(`UPDATE api_page_tokens SET revoked_at = now()
      WHERE ${clauses.join(" AND ")} AND revoked_at IS NULL AND expires_at > now()
      RETURNING token_hash`, values);
    return result.rows.map((row) => row.token_hash);
  });
}
