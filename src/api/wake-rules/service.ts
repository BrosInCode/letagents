import { sql } from "drizzle-orm";

import {
  WakeRuleError,
  parseWakeRuleEmail,
  parseWakeRuleInput,
  parseWakeRuleWebhook,
  type WakeRule,
  type WakeRuleActor,
} from "../../../shared/wake-rules.mjs";
import { loadConnectorCipher } from "../connectors/crypto.js";
import {
  cancelWakeRule,
  createWakeRule,
  getWakeRule,
  restoreWakeRule,
  roomHasRepository,
  wakeRuleEvaluationDeps,
  type WakeRuleRow,
  type WakeEmailConfirmation,
  type WakeRuleCredential,
  type WakeRuleDeliverySeal,
  type WakeRuleViewer,
} from "../db/wake-rules.js";
import { db } from "../db/client.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import { WAKE_RULE_UNMERGED_CLOSE_GRACE_MS } from "./evaluate.js";
import {
  EMAIL_NOT_CONFIGURED,
  hashWakeLinkToken,
  wakeEmailAddressFingerprint,
  wakeEmailConfigured,
  wakeEmailConfirmToken,
  wakeEmailDisableToken,
} from "./email.js";
import { wakeWebhookBinding } from "./webhook-delivery.js";
import {
  WAKE_WEBHOOK_URL_REFUSED,
  WakeWebhookResolveError,
  WakeWebhookUrlError,
  assertWakeWebhookUrl,
  wakeWebhookHost,
  wakeWebhookTargetKey,
  type WakeWebhookLookup,
} from "./webhook-url.js";

const STATUS_WORDS: Record<string, string> = { in_review: "in review", in_progress: "in progress" };

/** A task on this room's board, or on the board of the room it belongs to. */
async function findTask(roomId: string, taskId: string): Promise<{ room_id: string; status: string } | null> {
  const number = Number(taskId.slice("task_".length));
  const result = await db.execute<{ room_id: string; status: string }>(sql`
    SELECT task.room_id, task.status::text AS status
      FROM tasks AS task
     WHERE task.number = ${number}
       AND task.room_id IN (${roomId}, (SELECT parent_room_id FROM rooms WHERE id = ${roomId}))
     ORDER BY task.room_id = ${roomId} DESC
     LIMIT 1
  `);
  return result.rows[0] ?? null;
}

type RuleAgent = { agent_key: string; agent_name: string; session_id: string | null; owner_account_id?: string | null };

/**
 * Check a webhook target and seal it for the rule. The URL must be https on
 * port 443 and resolve only to public addresses; it and the secret are stored
 * sealed with the connector key, and only keyed fingerprints of the target
 * (without its query) and of its host tell rules apart and bound their
 * budgets. Every refusal gives the same answer.
 */
async function sealWakeWebhook(agent: RuleAgent, value: unknown, lookup?: WakeWebhookLookup): Promise<WakeRuleDeliverySeal> {
  const target = parseWakeRuleWebhook(value);
  const ownerAccountId = agent.owner_account_id;
  if (!ownerAccountId) throw new WakeRuleError("A webhook rule needs an agent that belongs to an account.", 403);
  const cipher = loadConnectorCipher();
  if (!cipher) throw new WakeRuleError("Webhook delivery is not set up on this server.", 503);
  let url: URL;
  try {
    url = await assertWakeWebhookUrl(target.url, lookup);
  } catch (error) {
    if (error instanceof WakeWebhookUrlError || error instanceof WakeWebhookResolveError) throw new WakeRuleError(WAKE_WEBHOOK_URL_REFUSED, 400);
    throw error;
  }
  const href = url.href;
  return {
    kind: "webhook",
    targetFingerprint: cipher.fingerprint("wake-webhook-target", wakeWebhookTargetKey(url)),
    hostFingerprint: cipher.fingerprint("wake-webhook-host", wakeWebhookHost(url)),
    seal: (ruleId) => cipher.encrypt({ url: href, secret: target.secret }, wakeWebhookBinding(ruleId, ownerAccountId)),
  };
}

/**
 * Check an email target and seal the address (personal data) like a webhook
 * secret. Refused outright, with no rule made, while the server has no SMTP
 * settings.
 */
function sealWakeEmail(agent: RuleAgent, value: unknown): WakeRuleDeliverySeal {
  const target = parseWakeRuleEmail(value);
  if (!wakeEmailConfigured()) throw new WakeRuleError(EMAIL_NOT_CONFIGURED, 503);
  const ownerAccountId = agent.owner_account_id;
  if (!ownerAccountId) throw new WakeRuleError("An email rule needs an agent that belongs to an account.", 403);
  const cipher = loadConnectorCipher();
  if (!cipher) throw new WakeRuleError("Email delivery is not set up on this server.", 503);
  return {
    kind: "email",
    targetFingerprint: wakeEmailAddressFingerprint(cipher, target.to),
    hostFingerprint: cipher.fingerprint("wake-email-domain", target.to.split("@")[1]!.toLowerCase()),
    seal: (ruleId) => cipher.encrypt({ to: target.to }, wakeWebhookBinding(ruleId, ownerAccountId)),
    linkHashes: (ruleId, confirmExpiresAt) => ({
      confirm: hashWakeLinkToken(wakeEmailConfirmToken(cipher, ruleId, confirmExpiresAt)),
      disable: hashWakeLinkToken(wakeEmailDisableToken(cipher, ruleId)),
    }),
  };
}

export async function addWakeRuleForAgent(input: {
  roomId: string;
  agent: RuleAgent;
  body: unknown;
  /** The credential that made the request; a webhook or email rule stops when it is revoked. */
  credential?: WakeRuleCredential | null;
  /** Tests resolve webhook hosts without DNS. */
  webhookLookup?: WakeWebhookLookup;
}): Promise<{ rule: WakeRule; created: boolean; confirmation?: WakeEmailConfirmation & { next_step: string } }> {
  const rule = parseWakeRuleInput(input.body);
  const body = input.body as { webhook?: unknown; email?: unknown };
  const delivery = rule.event !== "room.message" ? null
    : body.email !== undefined ? sealWakeEmail(input.agent, body.email)
      : await sealWakeWebhook(input.agent, body.webhook, input.webhookLookup);
  let baseline: WakeRuleRow["baseline"] = null;
  if (rule.event === "task.status_changed") {
    const task = await findTask(input.roomId, rule.arguments.task_id!);
    if (!task) throw new WakeRuleError(`${rule.arguments.task_id} is not on this room's board.`, 404);
    if (rule.arguments.to?.includes(task.status as never)) {
      throw new WakeRuleError(`${rule.arguments.task_id} is already ${STATUS_WORDS[task.status] ?? task.status}. There is nothing to wait for.`, 409);
    }
    baseline = { room_id: task.room_id, status: task.status };
  }
  if (rule.event.startsWith("github.") && !(await roomHasRepository(input.roomId))) {
    throw new WakeRuleError("This room is not connected to a GitHub repository, so GitHub activity cannot wake you here.", 409);
  }
  // A rule on one pull request ends when it merges, or once it has stayed
  // closed past the grace for a reopen: one made after that would end at its
  // first look. A pull request closed moments ago may still be reopened.
  const closed = rule.event.startsWith("github.") && rule.arguments.pr
    ? await wakeRuleEvaluationDeps.pullRequestClosed(input.roomId, rule.arguments.pr)
    : null;
  if (closed && (closed.merged || Date.now() - Date.parse(closed.closed_at) >= WAKE_RULE_UNMERGED_CLOSE_GRACE_MS)) {
    throw new WakeRuleError(`#${rule.arguments.pr} is already ${closed.merged ? "merged" : "closed"}. There is nothing to wait for.`, 409);
  }
  const result = await createWakeRule({ roomId: input.roomId, agent: input.agent, rule, baseline, delivery, credential: input.credential ?? null });
  // Adding a delivery rule again may resume it, so people's views refresh then too.
  if (result.created || delivery) queueWakeRuleInvalidation(input.roomId);
  if (!result.confirmation) return { rule: result.rule, created: result.created };
  return {
    rule: result.rule,
    created: result.created,
    confirmation: {
      ...result.confirmation,
      next_step: result.confirmation.sent
        ? "LetAgents emailed a confirmation request to the address. No room messages are emailed until the address confirms it (the link works for 24 hours)."
        : "A confirmation request went to the address a few minutes ago and still works. No room messages are emailed until the address confirms it.",
    },
  };
}

/** Whether a person may cancel a webhook or email rule they do not own: room admins may. */
async function isRoomAdmin(roomId: string, accountId: string): Promise<boolean> {
  const { isRoomAdminAccount } = await import("../connectors/rules/engine.js");
  return isRoomAdminAccount(roomId, accountId);
}

/**
 * Agents may cancel only their own rules. People in the room may cancel any
 * rule; an agent's wait is part of the room's shared plan. A webhook or email
 * rule is the exception: it sends to a target that belongs to the agent's
 * account, so only that account (the agent or its owner) or a room admin may
 * cancel it, and only its account may undo the cancel.
 */
export async function cancelWakeRuleAs(
  roomId: string,
  ruleId: string,
  actor: WakeRuleActor,
  viewer: WakeRuleViewer = {},
): Promise<WakeRule> {
  const existing = await getWakeRule(roomId, ruleId);
  if (!existing) throw new WakeRuleError("Wake rule not found in this room.", 404);
  if (actor.kind === "agent" && existing.agent_key !== actor.id) {
    throw new WakeRuleError("You can cancel only your own wake rules.", 403);
  }
  if (existing.delivery_kind && actor.kind === "human" && actor.id !== existing.owner_account_id
    && !(await isRoomAdmin(roomId, actor.id))) {
    throw new WakeRuleError("Only the account that owns this agent, or a room admin, can cancel its webhook or email rule.", 403);
  }
  const cancelled = await cancelWakeRule(roomId, ruleId, actor, viewer);
  if (!cancelled) throw new WakeRuleError("This wake rule already ended.", 409);
  queueWakeRuleInvalidation(roomId);
  return cancelled;
}

export async function restoreWakeRuleAs(
  roomId: string,
  ruleId: string,
  actor: WakeRuleActor,
  viewer: WakeRuleViewer = {},
): Promise<WakeRule> {
  const existing = await getWakeRule(roomId, ruleId);
  if (!existing) throw new WakeRuleError("Wake rule not found in this room.", 404);
  // Undo belongs to whoever cancelled: an agent cannot revive a wait a person stopped.
  if (existing.cancelled_by && (existing.cancelled_by.kind !== actor.kind || existing.cancelled_by.id !== actor.id)) {
    throw new WakeRuleError(`Only ${existing.cancelled_by.label} can undo this cancel.`, 403);
  }
  // A room admin may stop a delivery rule but not start it again: that is for its account.
  if (existing.delivery_kind && actor.kind === "human" && actor.id !== existing.owner_account_id) {
    throw new WakeRuleError("Only the account that owns this agent can start its webhook or email rule again.", 403);
  }
  const restored = await restoreWakeRule(roomId, ruleId, actor, new Date(), viewer);
  queueWakeRuleInvalidation(roomId);
  return restored;
}
