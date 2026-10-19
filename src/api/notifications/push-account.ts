import { pool } from "../db/client.js";
import type { RoomAccessAccount } from "../rooms/access.js";

/** The account and its GitHub token for a push or room access check. */
export async function getPushDeliveryAccount(accountId: string): Promise<RoomAccessAccount | null> {
  const result = await pool.query<RoomAccessAccount>(`
    SELECT account_record.id AS account_id,
           account_record.provider,
           account_record.login,
           COALESCE(
             (
               SELECT owner_token.provider_access_token
               FROM owner_tokens AS owner_token
               WHERE owner_token.account_id = account_record.id
                 AND owner_token.provider_access_token IS NOT NULL
                 AND (
                   owner_token.oauth_token_expires_at IS NULL
                   OR owner_token.oauth_token_expires_at > NOW()
                 )
               ORDER BY owner_token.updated_at DESC
               LIMIT 1
             ),
             (
               SELECT session.provider_access_token
               FROM auth_sessions AS session
               WHERE session.account_id = account_record.id
                 AND session.provider_access_token IS NOT NULL
                 AND session.expires_at > NOW()
               ORDER BY session.created_at DESC
               LIMIT 1
             )
           ) AS provider_access_token
    FROM accounts AS account_record
    WHERE account_record.id = $1
    LIMIT 1
  `, [accountId]);
  return result.rows[0] ?? null;
}
