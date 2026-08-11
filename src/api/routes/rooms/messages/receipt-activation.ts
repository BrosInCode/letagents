import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "../../../db/client.js";
import { message_agent_receipts, messages, room_agent_sessions } from "../../../db/schema.js";
import {
  attachAgentMessageActivationsFromReceipts,
  type AgentMessageActivation,
  type ActivationIdentity,
} from "../../../../shared/activation-routing.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import {
  resolveGlobalLegacyTargets,
  type AccountRoutingMessageRow,
} from "../../../db/messages/account-agent-routing.js";
import { parseScopedId } from "../../../db/utils.js";

type MessageWithId = {
  id?: unknown;
};

/**
 * The single activation authority for every delivery surface (history, poll,
 * stream). Send-time receipts decide activation for snapshot-bearing
 * messages: a receipt activates; no receipt on a snapshot message is a
 * durable send-time "silent" and must never be re-promoted by re-running the
 * router against later state. Only messages that predate routing snapshots
 * keep the lazy per-reader decision.
 */
export async function attachReceiptAuthorityActivations<T extends MessageWithId>(
  roomId: string,
  identity: ResolvedRequestAgentIdentity | null,
  msgs: readonly T[],
  contextOptions?: { includeTaskOwnerLeases?: boolean },
): Promise<T[]> {
  if (!identity || identity.session_kind !== "worker" || msgs.length === 0) {
    return [...msgs];
  }
  const numbers = [...new Set(
    msgs
      .map((message) => typeof message.id === "string" ? parseScopedId(message.id, "msg") : null)
      .filter((value): value is number => value !== null),
  )];

  const receiptsMap = new Map<number, { activation_reason: string }>();
  const snapshotNumbers = new Set<number>();
  if (numbers.length > 0) {
    // Receipts are seeded against one exact send-time session. A successor
    // may inherit only after that captured session ends, only when it is the
    // sole live session for the key, and only within the same owner account.
    const identityMatch = identity.agent_key
      ? eq(message_agent_receipts.agent_key, identity.agent_key)
      : eq(message_agent_receipts.agent_session_id, identity.agent_session_id ?? "");
    const receiptRows = await db
      .select({
        message_number: message_agent_receipts.message_number,
        activation_reason: message_agent_receipts.activation_reason,
        agent_session_id: message_agent_receipts.agent_session_id,
      })
      .from(message_agent_receipts)
      .where(and(
        eq(message_agent_receipts.message_room_id, roomId),
        identityMatch,
        inArray(message_agent_receipts.message_number, numbers),
      ));
    const currentSessionId = identity.agent_session_id ?? "";
    const needsSuccessorResolution = Boolean(identity.agent_key)
      && receiptRows.some((row) => row.agent_session_id !== currentSessionId);
    const relevantSessionIds = [...new Set([
      currentSessionId,
      ...receiptRows.map((row) => row.agent_session_id),
    ].filter(Boolean))];
    const sessionRows = needsSuccessorResolution
      ? (await db.execute<{
          session_id: string;
          owner_account_id: string;
          ended_at: string | null;
          live_count: number;
          sole_live_session_id: string | null;
        }>(sql`
          WITH selected_session AS (
            SELECT session.session_id,
                   session.owner_account_id,
                   session.ended_at
              FROM ${room_agent_sessions} AS session
              JOIN jsonb_to_recordset(${JSON.stringify(relevantSessionIds.map((session_id) => ({ session_id })))}::jsonb)
                AS requested(session_id text)
                ON requested.session_id = session.session_id
             WHERE session.room_id = ${roomId}
               AND session.agent_key = ${identity.agent_key}
               AND session.session_kind = 'worker'
          ), live_summary AS (
            SELECT COUNT(*)::int AS live_count,
                   CASE WHEN COUNT(*) = 1 THEN MIN(session.session_id) ELSE NULL END AS sole_live_session_id
              FROM ${room_agent_sessions} AS session
             WHERE session.room_id = ${roomId}
               AND session.agent_key = ${identity.agent_key}
               AND session.session_kind = 'worker'
               AND session.ended_at IS NULL
          )
          SELECT selected_session.session_id,
                 selected_session.owner_account_id,
                 selected_session.ended_at,
                 live_summary.live_count,
                 live_summary.sole_live_session_id
            FROM selected_session
            CROSS JOIN live_summary
        `)).rows
      : [];
    const sessionById = new Map(sessionRows.map((row) => [row.session_id, row]));
    const currentOwnerAccountId = sessionById.get(currentSessionId)?.owner_account_id;
    const isUniqueLiveSuccessor = sessionRows[0]?.live_count === 1
      && sessionRows[0]?.sole_live_session_id === currentSessionId;
    for (const row of receiptRows) {
      const isCapturedSession = row.agent_session_id === currentSessionId;
      const capturedSession = sessionById.get(row.agent_session_id);
      const capturedSessionEnded = capturedSession !== undefined && capturedSession.ended_at !== null;
      const sameOwner = Boolean(currentOwnerAccountId)
        && capturedSession?.owner_account_id === currentOwnerAccountId;
      if (isCapturedSession || (capturedSessionEnded && isUniqueLiveSuccessor && sameOwner)) {
        receiptsMap.set(row.message_number, { activation_reason: row.activation_reason });
      }
    }

    const snapshotRows = await db
      .select({ number: messages.number })
      .from(messages)
      .where(and(
        eq(messages.room_id, roomId),
        inArray(messages.number, numbers),
        isNotNull(messages.routing_snapshot_version),
      ));
    for (const row of snapshotRows) snapshotNumbers.add(row.number);
  }

  // Pre-snapshot messages use the same room-global authority as desktop
  // overlays. Resolve every active identity before selecting this request's
  // exact representative so independent API/MCP readers cannot manufacture
  // uniqueness by asking one identity at a time.
  const legacyNumbers = numbers.filter((number) => !snapshotNumbers.has(number));
  const authoritativeLegacyDecisions = new Map<
    string,
    AgentMessageActivation["for_current_agent"]
  >();
  if (legacyNumbers.length > 0) {
    const legacyRows = await db
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
      .where(and(
        eq(messages.room_id, roomId),
        inArray(messages.number, legacyNumbers),
      ));
    const targetsByMessage = await resolveGlobalLegacyTargets(
      db,
      roomId,
      legacyRows as AccountRoutingMessageRow[],
      {
        ...contextOptions,
        ownerAccountIds: identity.owner_account_id ? [identity.owner_account_id] : undefined,
      },
    );
    for (const number of legacyNumbers) {
      const target = (targetsByMessage.get(number) ?? []).find((candidate) =>
        candidate.agent_key === identity.agent_key
        && candidate.agent_session_id === identity.agent_session_id);
      authoritativeLegacyDecisions.set(`msg_${number}`, target
        ? {
            decision: "activate",
            reason: target.activation_reason as AgentMessageActivation["for_current_agent"]["reason"],
            addressed: true,
          }
        : {
            decision: "silent",
            reason: "unaddressed",
            addressed: false,
          });
    }
  }

  return attachAgentMessageActivationsFromReceipts(
    msgs,
    identity as ActivationIdentity,
    receiptsMap,
    snapshotNumbers,
    { authoritativeLegacyDecisions },
  ) as T[];
}
