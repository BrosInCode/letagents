import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "./client.js";
import type { OwnerTokenAccount } from "./types/auth.js";

/**
 * Storage for the remote MCP endpoint's OAuth 2.1 authorization server
 * (migration 0126). Callers pass hashes, never raw secrets.
 */

export type McpOAuthAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface McpOAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: McpOAuthAuthMethod;
  client_secret_hash: string | null;
  application_type: string;
  created_at: string;
}

export interface McpOAuthAuthorization {
  authorization_id: string;
  account_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  state: string | null;
  expires_at: string;
}

/** An access token's grant and account, shaped like an owner token's account. */
export interface McpOAuthGrantAccount {
  grant_id: string;
  client_id: string;
  resource: string;
  secret_hash: string;
  account: OwnerTokenAccount;
}

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

export async function insertMcpOAuthClient(input: Omit<McpOAuthClient, "created_at">): Promise<McpOAuthClient> {
  const result = await pool.query<McpOAuthClient>(`
    INSERT INTO mcp_oauth_clients
      (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, application_type)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6)
    RETURNING client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash,
              application_type, created_at::text`,
  [input.client_id, input.client_name, JSON.stringify(input.redirect_uris), input.token_endpoint_auth_method,
    input.client_secret_hash, input.application_type]);
  return result.rows[0]!;
}

export async function getMcpOAuthClient(clientId: string): Promise<McpOAuthClient | null> {
  const result = await pool.query<McpOAuthClient>(`
    SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash,
           application_type, created_at::text
    FROM mcp_oauth_clients WHERE client_id = $1`, [clientId]);
  return result.rows[0] ?? null;
}

/** A pending consent for a signed-in person. */
export async function createMcpOAuthAuthorization(input: {
  consentHash: string;
  accountId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
  expiresAt: string;
}): Promise<string> {
  const authorizationId = `mcpauthz_${randomUUID()}`;
  await pool.query(`
    INSERT INTO mcp_oauth_authorizations
      (authorization_id, consent_hash, account_id, client_id, redirect_uri, code_challenge, resource, scope, state, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [authorizationId, input.consentHash, input.accountId, input.clientId, input.redirectUri, input.codeChallenge,
    input.resource, input.scope, input.state, input.expiresAt]);
  return authorizationId;
}

/**
 * Record the person's decision on a pending consent, once. Only the account
 * that the consent page was made for may decide, before it expires. Approval
 * stores the code's hash. Returns the authorization, or null when the consent
 * is unknown, expired, already decided, or belongs to another account.
 */
export async function decideMcpOAuthAuthorization(input: {
  consentHash: string;
  accountId: string;
  codeHash: string | null;
  codeExpiresAt: string;
}): Promise<McpOAuthAuthorization | null> {
  return inTransaction(async (client) => {
    const result = await client.query<McpOAuthAuthorization>(`
      UPDATE mcp_oauth_authorizations
      SET decided_at = now(), code_hash = $3,
          expires_at = CASE WHEN $3::text IS NULL THEN expires_at ELSE $4::timestamptz END
      WHERE consent_hash = $1 AND account_id = $2 AND decided_at IS NULL AND expires_at > now()
      RETURNING authorization_id, account_id, client_id, redirect_uri, code_challenge, resource, scope, state,
                expires_at::text`,
    [input.consentHash, input.accountId, input.codeHash, input.codeExpiresAt]);
    const row = result.rows[0] ?? null;
    if (row && input.codeHash) {
      await client.query("UPDATE mcp_oauth_clients SET last_used_at = now() WHERE client_id = $1", [row.client_id]);
    }
    return row;
  });
}

export type CodeExchangeOutcome =
  | { kind: "issued"; grantId: string }
  | { kind: "invalid_grant"; reason: string };

/**
 * Exchange an authorization code for a new grant and its first tokens, in one
 * transaction. A code works once: a second use revokes the grant it created
 * (OAuth 2.1 section 4.1.3).
 */
export async function exchangeMcpOAuthCode(input: {
  codeHash: string;
  clientId: string;
  check(authorization: McpOAuthAuthorization): string | null;
  grantSecretHash: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}): Promise<CodeExchangeOutcome> {
  return inTransaction(async (client) => {
    const found = await client.query<McpOAuthAuthorization & { consumed: boolean; expired: boolean; grant_id: string | null }>(`
      SELECT authorization_id, account_id, client_id, redirect_uri, code_challenge, resource, scope, state,
             expires_at::text, consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired, grant_id
      FROM mcp_oauth_authorizations WHERE code_hash = $1 FOR UPDATE`, [input.codeHash]);
    const row = found.rows[0];
    if (!row) return { kind: "invalid_grant", reason: "The authorization code is invalid." };
    if (row.consumed) {
      if (row.grant_id) await revokeGrantInTransaction(client, row.grant_id);
      return { kind: "invalid_grant", reason: "The authorization code was already used." };
    }
    if (row.expired) return { kind: "invalid_grant", reason: "The authorization code has expired." };
    if (row.client_id !== input.clientId) return { kind: "invalid_grant", reason: "The authorization code was issued to another client." };
    const problem = input.check(row);
    if (problem) {
      // A failed exchange also spends the code, so it cannot be retried with guesses.
      await client.query("UPDATE mcp_oauth_authorizations SET consumed_at = now() WHERE authorization_id = $1", [row.authorization_id]);
      return { kind: "invalid_grant", reason: problem };
    }
    const grantId = `mcpgrant_${randomUUID()}`;
    await client.query(`
      INSERT INTO mcp_oauth_grants (grant_id, account_id, client_id, secret_hash, resource, scope, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [grantId, row.account_id, row.client_id, input.grantSecretHash, row.resource, row.scope, input.refreshExpiresAt]);
    await insertTokens(client, grantId, input);
    await client.query("UPDATE mcp_oauth_authorizations SET consumed_at = now(), grant_id = $2 WHERE authorization_id = $1",
      [row.authorization_id, grantId]);
    return { kind: "issued", grantId };
  });
}

async function insertTokens(client: PoolClient, grantId: string, input: {
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}): Promise<void> {
  await client.query(`
    INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at)
    VALUES ($1, $3, 'access', $4), ($2, $3, 'refresh', $5)`,
  [input.accessTokenHash, input.refreshTokenHash, grantId, input.accessExpiresAt, input.refreshExpiresAt]);
}

export type RefreshOutcome =
  | { kind: "issued"; grantId: string; scope: string }
  | { kind: "invalid_grant"; reason: string };

/**
 * Rotate a refresh token: the presented one is spent and a new access and
 * refresh token are issued. Presenting a spent refresh token again means a
 * copy exists elsewhere, so the whole grant is revoked.
 */
export async function refreshMcpOAuthGrant(input: {
  refreshTokenHash: string;
  grantSecretHash: string;
  clientId: string;
  check(grant: { resource: string; scope: string }): string | null;
  accessTokenHash: string;
  newRefreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}): Promise<RefreshOutcome> {
  return inTransaction(async (client) => {
    const found = await client.query<{
      grant_id: string; client_id: string; secret_hash: string; resource: string; scope: string;
      used: boolean; expired: boolean; revoked: boolean;
    }>(`
      SELECT g.grant_id, g.client_id, g.secret_hash, g.resource, g.scope,
             t.used_at IS NOT NULL AS used, t.expires_at <= now() AS expired, g.revoked_at IS NOT NULL AS revoked
      FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.grant_id = t.grant_id
      WHERE t.token_hash = $1 AND t.kind = 'refresh'
      FOR UPDATE OF t, g`, [input.refreshTokenHash]);
    const row = found.rows[0];
    if (!row || row.revoked) return { kind: "invalid_grant", reason: "The refresh token is invalid." };
    if (row.client_id !== input.clientId || row.secret_hash !== input.grantSecretHash) {
      return { kind: "invalid_grant", reason: "The refresh token is invalid." };
    }
    if (row.used) {
      await revokeGrantInTransaction(client, row.grant_id);
      return { kind: "invalid_grant", reason: "The refresh token was already used; the connection is revoked." };
    }
    if (row.expired) return { kind: "invalid_grant", reason: "The refresh token has expired." };
    const problem = input.check(row);
    if (problem) return { kind: "invalid_grant", reason: problem };
    await client.query("UPDATE mcp_oauth_tokens SET used_at = now() WHERE token_hash = $1", [input.refreshTokenHash]);
    await insertTokens(client, row.grant_id, {
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.newRefreshTokenHash,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
    });
    await client.query("UPDATE mcp_oauth_grants SET expires_at = $2, last_used_at = now() WHERE grant_id = $1",
      [row.grant_id, input.refreshExpiresAt]);
    return { kind: "issued", grantId: row.grant_id, scope: row.scope };
  });
}

async function revokeGrantInTransaction(client: PoolClient, grantId: string): Promise<void> {
  const revoked = await client.query<{ secret_hash: string }>(
    "UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1 RETURNING secret_hash",
    [grantId]);
  await client.query("DELETE FROM mcp_oauth_tokens WHERE grant_id = $1", [grantId]);
  const secretHash = revoked.rows[0]?.secret_hash;
  // Remote MCP sessions opened with the grant end now, not at the next sweep.
  if (secretHash) await client.query("DELETE FROM remote_mcp_sessions WHERE token_hash = $1", [secretHash]);
}

/** Revoke a grant. With accountId, only that account's grant; returns whether one was revoked. */
export async function revokeMcpOAuthGrant(grantId: string, accountId?: string): Promise<boolean> {
  return inTransaction(async (client) => {
    const found = await client.query<{ grant_id: string }>(
      `SELECT grant_id FROM mcp_oauth_grants WHERE grant_id = $1 AND revoked_at IS NULL
         AND ($2::text IS NULL OR account_id = $2) FOR UPDATE`, [grantId, accountId ?? null]);
    if (!found.rows[0]) return false;
    await revokeGrantInTransaction(client, grantId);
    return true;
  });
}

/** The grant and client of a token (access or refresh) by its hash, for revocation. */
export async function getMcpOAuthTokenGrant(tokenHash: string): Promise<{ grant_id: string; client_id: string } | null> {
  const result = await pool.query<{ grant_id: string; client_id: string }>(`
    SELECT g.grant_id, g.client_id FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.grant_id = t.grant_id
    WHERE t.token_hash = $1`, [tokenHash]);
  return result.rows[0] ?? null;
}

const GRANT_ACCOUNT_SELECT = `
  SELECT g.grant_id, g.client_id, g.resource, g.secret_hash,
         g.created_at::text AS grant_created_at, g.last_used_at::text AS grant_last_used_at,
         a.id AS account_id, a.provider, a.provider_user_id, a.login, a.display_name, a.avatar_url,
         COALESCE(
           (SELECT o.provider_access_token FROM owner_tokens o
             WHERE o.account_id = a.id AND o.provider_access_token IS NOT NULL
               AND (o.oauth_token_expires_at IS NULL OR o.oauth_token_expires_at > now())
             ORDER BY o.updated_at DESC LIMIT 1),
           (SELECT s.provider_access_token FROM auth_sessions s
             WHERE s.account_id = a.id AND s.provider_access_token IS NOT NULL AND s.expires_at > now()
             ORDER BY s.created_at DESC LIMIT 1)
         ) AS provider_access_token
  FROM mcp_oauth_grants g JOIN accounts a ON a.id = g.account_id`;

interface GrantAccountRow {
  grant_id: string;
  client_id: string;
  resource: string;
  secret_hash: string;
  grant_created_at: string;
  grant_last_used_at: string;
  account_id: string;
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  provider_access_token: string | null;
}

/**
 * The grant's account in the owner-token shape. It carries the account's
 * current GitHub token (from its newest owner token or browser session), as
 * an owner token's account does; the grant itself stores no GitHub token.
 */
function toGrantAccount(row: GrantAccountRow): McpOAuthGrantAccount {
  return {
    grant_id: row.grant_id,
    client_id: row.client_id,
    resource: row.resource,
    secret_hash: row.secret_hash,
    account: {
      token_id: row.grant_id,
      account_id: row.account_id,
      github_user_id: row.provider_user_id,
      token_hash: row.secret_hash,
      provider_access_token: row.provider_access_token,
      oauth_token_expires_at: null,
      created_at: row.grant_created_at,
      updated_at: row.grant_last_used_at,
      provider: row.provider,
      provider_user_id: row.provider_user_id,
      login: row.login,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    },
  };
}

/** An unexpired access token of a live grant, by the token's hash. */
export async function getMcpOAuthAccessGrant(accessTokenHash: string): Promise<McpOAuthGrantAccount | null> {
  const result = await pool.query<GrantAccountRow>(`${GRANT_ACCOUNT_SELECT}
    JOIN mcp_oauth_tokens t ON t.grant_id = g.grant_id
    WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now()
      AND g.revoked_at IS NULL AND g.expires_at > now()
    LIMIT 1`, [accessTokenHash]);
  const row = result.rows[0];
  if (!row) return null;
  // At most one write a minute per grant, for "last used" in settings.
  await pool.query(`UPDATE mcp_oauth_grants SET last_used_at = now()
    WHERE grant_id = $1 AND last_used_at < now() - interval '1 minute'`, [row.grant_id]).catch(() => undefined);
  return toGrantAccount(row);
}

/** A live grant by its secret's hash: what a remote MCP session's in-process calls re-check. */
export async function getMcpOAuthGrantBySecretHash(secretHash: string): Promise<McpOAuthGrantAccount | null> {
  const result = await pool.query<GrantAccountRow>(`${GRANT_ACCOUNT_SELECT}
    WHERE g.secret_hash = $1 AND g.revoked_at IS NULL AND g.expires_at > now()
    LIMIT 1`, [secretHash]);
  return result.rows[0] ? toGrantAccount(result.rows[0]) : null;
}

export interface McpOAuthGrantView {
  grant_id: string;
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  scope: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

/** The account's live grants, newest first. */
export async function listMcpOAuthGrantsForAccount(accountId: string): Promise<McpOAuthGrantView[]> {
  const result = await pool.query<McpOAuthGrantView>(`
    SELECT g.grant_id, g.client_id, c.client_name, c.redirect_uris, g.scope,
           g.created_at::text, g.last_used_at::text, g.expires_at::text
    FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.client_id = g.client_id
    WHERE g.account_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now()
    ORDER BY g.created_at DESC LIMIT 100`, [accountId]);
  return result.rows;
}

/** Delete what can never be used again. */
export async function sweepMcpOAuthRows(unusedClientCutoff: string): Promise<void> {
  await pool.query("DELETE FROM mcp_oauth_tokens WHERE expires_at < now() - interval '1 day'");
  await pool.query("DELETE FROM mcp_oauth_authorizations WHERE expires_at < now() - interval '1 day'");
  await pool.query(`DELETE FROM mcp_oauth_grants
    WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 day') OR expires_at < now() - interval '1 day'`);
  await pool.query(`DELETE FROM mcp_oauth_clients c
    WHERE c.last_used_at IS NULL AND c.created_at < $1
      AND NOT EXISTS (SELECT 1 FROM mcp_oauth_authorizations a WHERE a.client_id = c.client_id)`, [unusedClientCutoff]);
}
