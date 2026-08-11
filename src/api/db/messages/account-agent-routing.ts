import { and, eq, sql } from "drizzle-orm";

import {
  createGlobalAgentAddressResolver,
  isTaskOwnerFollowUpMessageText,
  type ActivationIdentity,
} from "../../../shared/activation-routing.js";
import { db } from "../client.js";
import {
  message_agent_receipts,
  messages,
  room_agent_sessions,
  task_leases,
} from "../schema.js";
import type { MessageAccountAgentRouting, MessageRow } from "../types.js";
import { RequestValidationError } from "../../validation-error.js";
import { parseScopedId } from "../utils.js";
import { getGlobalMessageThreadRoutingMembers } from "./thread-routing-membership.js";

type AccountAgentRoutingExecutor = Pick<typeof db, "execute" | "select">;
export type AccountRoutingMessageRow = Pick<
  MessageRow,
  | "number"
  | "thread_root_number"
  | "routing_snapshot_version"
  | "publisher_account_id"
  | "publisher_agent_key"
  | "reply_to_number"
  | "sender"
  | "source"
  | "text"
>;

type ActiveRoutingSession = Omit<ActivationIdentity, "agent_session_id"> & {
  agent_session_id: string;
  owner_account_id: string;
  created_at: string;
};

export type LegacyTarget = {
  agent_key: string;
  agent_session_id: string;
  owner_account_id: string;
  activation_reason: string;
};

export type BoundedActiveWorkLeaseOwner = {
  kind: "work";
  status: "active";
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
};

export const MAX_ACCOUNT_ROUTING_ACCOUNTS = 1_000;
export const MAX_ACCOUNT_ROUTING_PAIRS = 100_000;
export const MAX_ACCOUNT_ROUTING_TARGETS = 100_000;
export const MAX_ACCOUNT_ROUTING_TARGET_BYTES = 8 * 1024 * 1024;
export const MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES = 8 * 1024 * 1024;

export function createAccountRoutingTargetBudget(): (target: unknown) => void {
  let targetCount = 0;
  let targetBytes = 0;
  return (target: unknown) => {
    targetCount += 1;
    targetBytes += Buffer.byteLength(JSON.stringify(target), "utf8");
    if (
      targetCount > MAX_ACCOUNT_ROUTING_TARGETS
      || targetBytes > MAX_ACCOUNT_ROUTING_TARGET_BYTES
    ) {
      throw new RequestValidationError(
        "Account message-routing overlay exceeds its bounded target contract; split the broker batch.",
      );
    }
  };
}

/** Return no more than the two distinct effective owners needed for uniqueness. */
export async function getBoundedActiveWorkLeaseOwners(
  executor: Pick<AccountAgentRoutingExecutor, "execute">,
  roomId: string,
): Promise<BoundedActiveWorkLeaseOwner[]> {
  const result = await executor.execute<BoundedActiveWorkLeaseOwner>(sql`
    WITH candidate AS (
      SELECT lease.actor_label,
             lease.agent_key,
             lease.agent_instance_id,
             lease.agent_session_id,
             COALESCE(NULLIF(lease.agent_session_id, ''),
                      NULLIF(lease.agent_key, ''),
                      NULLIF(lease.agent_instance_id, ''),
                      NULLIF(lease.actor_label, '')) AS owner_key,
             lease.created_at,
             lease.id
        FROM ${task_leases} AS lease
       WHERE lease.room_id = ${roomId}
         AND lease.kind = 'work'
         AND lease.status = 'active'
         AND (lease.expires_at IS NULL OR lease.expires_at > NOW())
    ), distinct_owner AS (
      SELECT DISTINCT ON (owner_key)
             actor_label, agent_key, agent_instance_id, agent_session_id, owner_key
        FROM candidate
       WHERE owner_key IS NOT NULL
       ORDER BY owner_key, created_at, id
    )
    SELECT 'work'::text AS kind,
           'active'::text AS status,
           actor_label,
           agent_key,
           agent_instance_id,
           agent_session_id
      FROM distinct_owner
     ORDER BY owner_key
     LIMIT 2
  `);
  return result.rows;
}

export async function getMessageAccountAgentRoutingById(
  roomId: string,
  messageId: string,
  accountId: string,
  executor: AccountAgentRoutingExecutor = db,
): Promise<MessageAccountAgentRouting | null> {
  const messageNumber = parseScopedId(messageId, "msg");
  if (!messageNumber) return null;
  const [row] = await executor
    .select({
      number: messages.number,
      thread_root_number: messages.thread_root_number,
      routing_snapshot_version: messages.routing_snapshot_version,
      publisher_account_id: messages.publisher_account_id,
      publisher_agent_key: messages.publisher_agent_key,
      reply_to_number: messages.reply_to_number,
      sender: messages.sender,
      source: messages.source,
      text: messages.text,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, messageNumber)))
    .limit(1);
  if (!row) return null;
  return (await getMessageAccountAgentRouting(executor, roomId, accountId, [row])).get(messageNumber) ?? null;
}

/** Single-account compatibility wrapper around the broker-safe batch API. */
export async function getMessageAccountAgentRouting(
  executor: AccountAgentRoutingExecutor,
  roomId: string,
  accountId: string,
  messageRows: readonly AccountRoutingMessageRow[],
): Promise<Map<number, MessageAccountAgentRouting>> {
  return (await getMessageAccountAgentRoutings(
    executor,
    roomId,
    [accountId],
    messageRows,
  )).get(accountId) ?? new Map();
}

/**
 * Build account-specific desktop dispatch overlays for a bounded subscriber
 * batch. Receipt ownership, global legacy ambiguity, thread membership, and
 * active-session selection are each resolved once before slicing by account.
 */
export async function getMessageAccountAgentRoutings(
  executor: AccountAgentRoutingExecutor,
  roomId: string,
  accountIdsInput: readonly string[],
  messageRows: readonly AccountRoutingMessageRow[],
): Promise<Map<string, Map<number, MessageAccountAgentRouting>>> {
  const accountIds = [...new Set(accountIdsInput.map((value) => value.trim()).filter(Boolean))];
  const uniqueRows = new Map(messageRows.map((row) => [row.number, row]));
  if (accountIds.length === 0 || uniqueRows.size === 0) return new Map();
  if (
    accountIds.length > MAX_ACCOUNT_ROUTING_ACCOUNTS
    || accountIds.length * uniqueRows.size > MAX_ACCOUNT_ROUTING_PAIRS
  ) {
    throw new RequestValidationError(
      "Account message-routing overlay batch exceeds its bounded account/message contract; split the broker batch.",
    );
  }
  const consumeTargetBudget = createAccountRoutingTargetBudget();

  const accountSet = new Set(accountIds);
  const result = new Map<string, Map<number, MessageAccountAgentRouting>>();
  let envelopeBytes = Buffer.byteLength(JSON.stringify({ roomId, accountIds }), "utf8");
  for (const accountId of accountIds) {
    const byMessage = new Map<number, MessageAccountAgentRouting>();
    for (const row of uniqueRows.values()) {
      const control_authorized = row.publisher_account_id === accountId
        && row.source === "browser"
        && !row.publisher_agent_key;
      const routing: MessageAccountAgentRouting = row.routing_snapshot_version !== null
        ? {
            version: 1,
            authority: "receipts",
            recipient_agent_keys: [],
            recipient_agent_sessions: [],
            control_authorized,
          }
        : {
            version: 1,
            authority: "legacy",
            recipient_agent_keys: [],
            recipient_agent_sessions: [],
            control_authorized,
          };
      envelopeBytes += Buffer.byteLength(JSON.stringify({
        accountId,
        messageNumber: row.number,
        routing,
      }), "utf8");
      if (envelopeBytes > MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES) {
        throw new RequestValidationError(
          "Account message-routing overlay exceeds its bounded envelope contract; split the broker batch.",
        );
      }
      byMessage.set(row.number, routing);
    }
    result.set(accountId, byMessage);
  }

  const snapshotNumbers = [...uniqueRows.values()]
    .filter((row) => row.routing_snapshot_version !== null)
    .map((row) => row.number);
  if (snapshotNumbers.length > 0) {
    const receipts = await executor.execute<{
      account_id: string;
      message_number: number;
      agent_key: string;
      agent_session_id: string;
      successor_agent_session_id: string | null;
    }>(sql`
      WITH requested_account AS (
        SELECT value.account_id
          FROM jsonb_to_recordset(${JSON.stringify(accountIds.map((account_id) => ({ account_id })))}::jsonb)
            AS value(account_id text)
      ), input_message AS (
        SELECT value.message_number
          FROM jsonb_to_recordset(${JSON.stringify(snapshotNumbers.map((message_number) => ({ message_number })))}::jsonb)
            AS value(message_number integer)
      ), owned_receipt AS (
        SELECT captured.owner_account_id AS account_id,
               receipt.message_number,
               receipt.agent_key,
               receipt.agent_session_id,
               captured.ended_at
          FROM ${message_agent_receipts} AS receipt
          JOIN input_message ON input_message.message_number = receipt.message_number
          JOIN ${room_agent_sessions} AS captured
            ON captured.session_id = receipt.agent_session_id
           AND captured.room_id = receipt.room_id
           AND captured.agent_key = receipt.agent_key
          JOIN requested_account ON requested_account.account_id = captured.owner_account_id
         WHERE receipt.message_room_id = ${roomId}
           AND captured.session_kind = 'worker'
      ), receipt_key AS (
        SELECT DISTINCT owned_receipt.account_id, owned_receipt.agent_key
          FROM owned_receipt
         WHERE owned_receipt.ended_at IS NOT NULL
      ), unique_live_successor AS (
        SELECT receipt_key.account_id,
               active.agent_key,
               CASE WHEN COUNT(*) = 1
                      AND MIN(active.owner_account_id) = receipt_key.account_id
                      AND MAX(active.owner_account_id) = receipt_key.account_id
                      THEN MIN(active.session_id)
                    ELSE NULL END AS agent_session_id
          FROM receipt_key
          JOIN ${room_agent_sessions} AS active ON active.agent_key = receipt_key.agent_key
         WHERE active.room_id = ${roomId}
           AND active.session_kind = 'worker'
           AND active.ended_at IS NULL
         GROUP BY receipt_key.account_id, active.agent_key
      )
      SELECT owned_receipt.account_id,
             owned_receipt.message_number,
             owned_receipt.agent_key,
             owned_receipt.agent_session_id,
             CASE WHEN owned_receipt.ended_at IS NOT NULL
                    THEN unique_live_successor.agent_session_id
                  ELSE NULL END AS successor_agent_session_id
        FROM owned_receipt
        LEFT JOIN unique_live_successor
          ON unique_live_successor.account_id = owned_receipt.account_id
         AND unique_live_successor.agent_key = owned_receipt.agent_key
       LIMIT ${MAX_ACCOUNT_ROUTING_TARGETS + 1}
    `);
    if (receipts.rows.length > MAX_ACCOUNT_ROUTING_TARGETS) {
      throw new RequestValidationError(
        "Account message-routing overlay exceeds its bounded receipt contract; split the broker batch.",
      );
    }
    for (const receipt of receipts.rows) {
      const routing = result.get(receipt.account_id)?.get(Number(receipt.message_number));
      if (routing?.authority !== "receipts") continue;
      const target = {
        agent_key: receipt.agent_key,
        agent_session_id: receipt.agent_session_id,
        ...(receipt.successor_agent_session_id
          ? { successor_agent_session_id: receipt.successor_agent_session_id }
          : {}),
      };
      consumeTargetBudget(target);
      routing.recipient_agent_keys.push(receipt.agent_key);
      routing.recipient_agent_sessions?.push(target);
    }
  }

  const legacyRows = [...uniqueRows.values()].filter((row) => row.routing_snapshot_version === null);
  if (legacyRows.length > 0) {
    const legacyTargets = await resolveGlobalLegacyTargets(executor, roomId, legacyRows, {
      ownerAccountIds: accountIds,
    });
    for (const [messageNumber, targets] of legacyTargets) {
      for (const target of targets) {
        if (!accountSet.has(target.owner_account_id)) continue;
        const routing = result.get(target.owner_account_id)?.get(messageNumber);
        if (routing?.authority !== "legacy") continue;
        const sessionTarget = {
          agent_key: target.agent_key,
          agent_session_id: target.agent_session_id,
          activation_reason: target.activation_reason,
        };
        consumeTargetBudget(sessionTarget);
        routing.recipient_agent_keys.push(target.agent_key);
        routing.recipient_agent_sessions.push(sessionTarget);
      }
    }
  }

  for (const byMessage of result.values()) {
    for (const routing of byMessage.values()) {
      routing.recipient_agent_keys.sort();
      routing.recipient_agent_sessions?.sort((left, right) =>
        left.agent_key.localeCompare(right.agent_key)
        || left.agent_session_id.localeCompare(right.agent_session_id));
    }
  }
  const finalEnvelopeBytes = Buffer.byteLength(JSON.stringify(
    [...result].map(([account_id, byMessage]) => ({
      account_id,
      messages: [...byMessage].map(([message_number, routing]) => ({
        message_number,
        routing,
      })),
    })),
  ), "utf8");
  if (finalEnvelopeBytes > MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES) {
    throw new RequestValidationError(
      "Account message-routing overlay exceeds its bounded envelope contract; split the broker batch.",
    );
  }
  return result;
}

export async function resolveGlobalLegacyTargets(
  executor: AccountAgentRoutingExecutor,
  roomId: string,
  legacyRows: readonly AccountRoutingMessageRow[],
  options: {
    includeTaskOwnerLeases?: boolean;
    ownerAccountIds?: readonly string[];
  } = {},
): Promise<Map<number, LegacyTarget[]>> {
  const requestedOwnerAccounts = options.ownerAccountIds === undefined
    ? null
    : new Set(options.ownerAccountIds.map((value) => value.trim()).filter(Boolean));
  const activeSessionRows = await executor.execute<ActiveRoutingSession>(sql`
    SELECT session.actor_label,
           session.agent_key,
           session.agent_instance_id,
           session.session_id AS agent_session_id,
           session.display_name,
           session.session_kind,
           session.owner_account_id,
           session.created_at::text AS created_at
      FROM ${room_agent_sessions} AS session
     WHERE session.room_id = ${roomId}
       AND session.session_kind = 'worker'
       AND session.ended_at IS NULL
     ORDER BY session.created_at, session.session_id
     LIMIT ${MAX_ACCOUNT_ROUTING_TARGETS + 1}
  `);
  if (activeSessionRows.rows.length > MAX_ACCOUNT_ROUTING_TARGETS) {
    throw new RequestValidationError(
      "Legacy message-routing authority exceeds its bounded active-worker contract.",
    );
  }
  const activeSessions = activeSessionRows.rows;
  const sessionsByKey = new Map<string, ActiveRoutingSession[]>();
  for (const session of activeSessions) {
    const group = sessionsByKey.get(session.agent_key) ?? [];
    group.push(session);
    sessionsByKey.set(session.agent_key, group);
  }
  const representativeByKey = new Map<string, ActiveRoutingSession>();
  for (const [agentKey, sessions] of sessionsByKey) {
    if (new Set(sessions.map((session) => session.owner_account_id)).size === 1) {
      representativeByKey.set(agentKey, sessions[0]!);
    }
  }

  // Alias ambiguity is deliberately computed before excluding multi-owner
  // durable keys. Filtering first could manufacture a false unique match.
  const resolveGlobalAddress = createGlobalAgentAddressResolver(activeSessions);
  const threadRoots = [...new Set(legacyRows
    .map((row) => row.thread_root_number)
    .filter((value): value is number => Number.isInteger(value) && Number(value) > 0))];
  const membersByRoot = threadRoots.length > 0
    ? await getGlobalMessageThreadRoutingMembers(executor, roomId, threadRoots, {
        ownerAccountIds: options.ownerAccountIds,
        activeIdentities: activeSessions,
      })
    : new Map();

  const replyNumbers = [...new Set(legacyRows
    .map((row) => row.reply_to_number)
    .filter((value): value is number => Number.isInteger(value) && Number(value) > 0))];
  const replyByNumber = new Map<number, {
    sender: string;
    source: string | null;
    publisher_agent_key: string | null;
    publisher_agent_session_id: string | null;
    publisher_account_id: string | null;
  }>();
  if (replyNumbers.length > 0) {
    const replies = await executor.execute<{
      number: number;
      sender: string;
      source: string | null;
      publisher_agent_key: string | null;
      publisher_agent_session_id: string | null;
      publisher_account_id: string | null;
    }>(sql`
      WITH input_reply AS (
        SELECT value.number
          FROM jsonb_to_recordset(${JSON.stringify(replyNumbers.map((number) => ({ number })))}::jsonb)
            AS value(number integer)
      )
      SELECT reply.number, reply.sender, reply.source,
             reply.publisher_agent_key, reply.publisher_agent_session_id,
             reply.publisher_account_id
        FROM ${messages} AS reply
        JOIN input_reply ON input_reply.number = reply.number
       WHERE reply.room_id = ${roomId}
    `);
    for (const reply of replies.rows) replyByNumber.set(Number(reply.number), reply);
  }

  const needsTaskLeases = options.includeTaskOwnerLeases !== false
    && legacyRows.some((row) => isTaskOwnerFollowUpMessageText(row.text));
  const activeWorkLeases = needsTaskLeases
    ? await getBoundedActiveWorkLeaseOwners(executor, roomId)
    : [];
  const taskOwners = new Map<string, (typeof activeWorkLeases)[number]>();
  for (const lease of activeWorkLeases) {
    const ownerKey = lease.agent_session_id || lease.agent_key || lease.actor_label;
    if (ownerKey) taskOwners.set(ownerKey, lease);
  }
  const uniqueTaskOwner = taskOwners.size === 1 ? [...taskOwners.values()][0] : undefined;

  const targetsByMessage = new Map<number, LegacyTarget[]>();
  const consumeTargetBudget = createAccountRoutingTargetBudget();
  for (const row of legacyRows) {
    const reply = row.reply_to_number === null ? null : replyByNumber.get(row.reply_to_number) ?? null;
    const addressed = resolveGlobalAddress({
      sender: row.sender,
      text: row.text,
      reply_to: reply,
    });
    let exactReplySession: ActiveRoutingSession | undefined;
    if (reply?.publisher_agent_key && reply.publisher_account_id) {
      addressed.replyTargetKeys.clear();
      const representative = representativeByKey.get(reply.publisher_agent_key);
      if (representative?.owner_account_id === reply.publisher_account_id) {
        addressed.replyTargetKeys.add(reply.publisher_agent_key);
        exactReplySession = reply.publisher_agent_session_id
          ? activeSessions.find((session) =>
              session.agent_key === reply.publisher_agent_key
              && session.agent_session_id === reply.publisher_agent_session_id)
          : undefined;
      }
    }
    const selfKeys = new Set<string>(row.source === "agent"
      ? row.publisher_agent_key
        ? [row.publisher_agent_key]
        : addressed.senderKeys
      : []);
    let reason = "unaddressed";
    let targetKeys = new Set<string>();
    let exactTaskSession: ActiveRoutingSession | undefined;

    if (row.source === "managed_agent_failure") {
      reason = "system_event";
    } else if (addressed.broadcast) {
      reason = "broadcast";
      targetKeys = new Set(representativeByKey.keys());
    } else if (addressed.hasMention) {
      reason = addressed.explicitMentionKeys.size > 0 ? "explicit_mention" : "explicit_other_mention";
      targetKeys = addressed.explicitMentionKeys;
    } else if (row.thread_root_number !== null) {
      reason = "thread_participant";
      targetKeys = new Set((membersByRoot.get(row.thread_root_number) ?? [])
        .map((member: { agent_key: string }) => member.agent_key));
    } else if (addressed.replyTargetKeys.size > 0) {
      reason = "reply_target";
      targetKeys = addressed.replyTargetKeys;
    } else if (reply?.source === "agent") {
      reason = "other_reply_target";
    } else if (uniqueTaskOwner && isTaskOwnerFollowUpMessageText(row.text)) {
      reason = "task_owner";
      if (uniqueTaskOwner.agent_session_id) {
        const matches = activeSessions.filter((session) =>
          session.agent_session_id === uniqueTaskOwner.agent_session_id
          && (!uniqueTaskOwner.agent_key || session.agent_key === uniqueTaskOwner.agent_key));
        if (matches.length === 1) exactTaskSession = matches[0];
      } else if (uniqueTaskOwner.agent_key) {
        const representative = representativeByKey.get(uniqueTaskOwner.agent_key);
        if (representative) targetKeys.add(uniqueTaskOwner.agent_key);
      } else {
        const ownerAddress = resolveGlobalAddress({
          text: "",
          reply_to: { sender: uniqueTaskOwner.actor_label, source: "agent" },
        });
        targetKeys = ownerAddress.replyTargetKeys;
      }
    }

    const targets: LegacyTarget[] = [];
    if (exactTaskSession && !selfKeys.has(exactTaskSession.agent_key)) {
      const target = { ...exactTaskSession, activation_reason: reason };
      if (requestedOwnerAccounts === null || requestedOwnerAccounts.has(target.owner_account_id)) {
        consumeTargetBudget(target);
        targets.push(target);
      }
    }
    for (const agentKey of targetKeys) {
      if (selfKeys.has(agentKey)) continue;
      const representative = reason === "reply_target"
        && exactReplySession?.agent_key === agentKey
        ? exactReplySession
        : representativeByKey.get(agentKey);
      if (!representative) continue;
      const target = { ...representative, activation_reason: reason };
      if (requestedOwnerAccounts !== null && !requestedOwnerAccounts.has(target.owner_account_id)) continue;
      consumeTargetBudget(target);
      targets.push(target);
    }
    targetsByMessage.set(row.number, targets);
  }
  return targetsByMessage;
}
