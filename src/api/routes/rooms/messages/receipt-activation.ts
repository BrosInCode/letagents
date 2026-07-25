import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../../../db/client.js";
import { message_agent_receipts, messages } from "../../../db/schema.js";
import {
  attachAgentMessageActivationsFromReceipts,
  type ActivationIdentity,
} from "../../../../shared/activation-routing.js";
import { resolveMessageActivationContext } from "./activation-context.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";

type MessageWithId = { id?: unknown };

function messageNumbers(msgs: readonly MessageWithId[]): number[] {
  return msgs
    .map((message) => (typeof message.id === "string" ? parseInt(message.id.replace(/^msg_/, ""), 10) : null))
    .filter((value): value is number => value !== null && !isNaN(value));
}

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
  const numbers = messageNumbers(msgs);

  const receiptsMap = new Map<number, { activation_reason: string }>();
  const snapshotNumbers = new Set<number>();
  if (numbers.length > 0) {
    // Receipts are seeded against the send-time session; the durable
    // agent_key keeps them attached to rotated successor sessions.
    const identityMatch = identity.agent_key
      ? eq(message_agent_receipts.agent_key, identity.agent_key)
      : eq(message_agent_receipts.agent_session_id, identity.agent_session_id ?? "");
    const receiptRows = await db
      .select({
        message_number: message_agent_receipts.message_number,
        activation_reason: message_agent_receipts.activation_reason,
      })
      .from(message_agent_receipts)
      .where(and(
        eq(message_agent_receipts.message_room_id, roomId),
        identityMatch,
        inArray(message_agent_receipts.message_number, numbers),
      ));
    for (const row of receiptRows) {
      receiptsMap.set(row.message_number, { activation_reason: row.activation_reason });
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

  // The lazy router runs only for pre-snapshot legacy messages.
  const needsLazyContext = numbers.some((number) => !snapshotNumbers.has(number));
  const context = needsLazyContext
    ? await resolveMessageActivationContext(roomId, identity, contextOptions)
    : undefined;

  return attachAgentMessageActivationsFromReceipts(
    msgs,
    identity as ActivationIdentity,
    receiptsMap,
    snapshotNumbers,
    context ?? {},
  ) as T[];
}
