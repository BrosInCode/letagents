/**
 * Ending the webhook and email wake rules of a revoked credential. A leaf
 * module (no imports from the rest of the database layer), so the OAuth,
 * owner-token and agent-session code can call it in their own transactions.
 */
import { sql } from "drizzle-orm";

export type WakeRuleCredentialKind = "token" | "agent_session";

const ENDED_REASON = "the sign-in that registered it was revoked";

/**
 * Raw SQL with `$1` (kind) and `$2` (ref): retire the credential's held
 * delivery rules and drop what they still had to send.
 */
export const RETIRE_WAKE_RULES_FOR_CREDENTIAL_SQL = `
  WITH retired AS (
    UPDATE agent_wake_rules
       SET status = 'retired', ended_at = now(), updated_at = now(), ended_reason = '${ENDED_REASON}',
           -- Retired for good: the sealed target and sender key are no longer needed.
           delivery_target = NULL, delivery_bearer = NULL
     WHERE credential_kind = $1 AND credential_ref = $2
       AND status IN ('active', 'paused', 'pending_confirmation')
    RETURNING id
  )
  UPDATE wake_webhook_deliveries
     SET state = 'dead', sender = '', text_preview = '', last_error = 'credential_revoked', updated_at = now()
   WHERE rule_id IN (SELECT id FROM retired) AND state IN ('queued', 'retry')`;

/** The same, for a drizzle executor (`db` or a transaction). */
export async function retireWakeRulesForCredential(
  executor: { execute(query: ReturnType<typeof sql>): Promise<unknown> },
  kind: WakeRuleCredentialKind,
  ref: string,
): Promise<void> {
  await executor.execute(sql`
    WITH retired AS (
      UPDATE agent_wake_rules
         SET status = 'retired', ended_at = now(), updated_at = now(), ended_reason = ${ENDED_REASON},
             delivery_target = NULL, delivery_bearer = NULL
       WHERE credential_kind = ${kind} AND credential_ref = ${ref}
         AND status IN ('active', 'paused', 'pending_confirmation')
      RETURNING id
    )
    UPDATE wake_webhook_deliveries
       SET state = 'dead', sender = '', text_preview = '', last_error = 'credential_revoked', updated_at = now()
     WHERE rule_id IN (SELECT id FROM retired) AND state IN ('queued', 'retry')
  `);
}
