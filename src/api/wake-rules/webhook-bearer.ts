/**
 * The optional sender key of a webhook receiver. Some receivers (an
 * automation platform's inbound trigger) refuse a POST without
 * `Authorization: Bearer <key>`; the rule then carries that key. It is sealed
 * on its own, bound to the rule and account with a binding distinct from the
 * URL and secret, never returned and never logged. It is independent of
 * `X-LetAgents-Signature`: the receiver checks its key, and may also check ours.
 */
import type { CredentialBinding } from "../connectors/crypto.js";

export function wakeWebhookBearerBinding(ruleId: string, ownerAccountId: string): CredentialBinding {
  return { connection_id: `wake_webhook_bearer:${ruleId}`, account_id: ownerAccountId };
}

/** The header that carries the key. The key is visible ASCII only (checked when the rule is added). */
export function wakeWebhookBearerHeader(bearer: string): Record<string, string> {
  return { Authorization: `Bearer ${bearer}` };
}
