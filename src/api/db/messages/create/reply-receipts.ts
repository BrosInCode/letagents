/** Marks the publisher's receipts on the messages it answers as replied. */
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { parseSupervisedReplySourceNumber } from "../../../../../shared/message-contracts.mjs";
import { message_agent_receipts, message_agent_receipt_events } from "../../schema.js";
import type { MessageRow } from "../../types.js";
import { finishReplyTurnsTx, type ReleasedReplyTurn } from "../reply-turns.js";
import type { MessageCreateTransaction } from "./types.js";

/** Moves this publisher's open receipts on the answered messages to replied, and finishes their reply turns. */
export async function markAnsweredReceiptsReplied(
  tx: MessageCreateTransaction,
  roomId: string,
  createdMessage: MessageRow,
  clientMessageId: string | null,
  repliedReceiptTargets: Set<number>,
  releasedReplyTurns: ReleasedReplyTurn[],
): Promise<void> {
  // The canonical reply transition is server-owned and atomic with the
  // reply's creation: any worker publication that answers an earlier message
  // — an explicit reply_to, or a supervised daemon publication carrying its
  // reply-namespace idempotency id — marks that agent's receipt replied.
  // Supervised turns never call self-report endpoints, so this is the only
  // path that can move their receipts.
  const publisherAgentKey = createdMessage.publisher_agent_key;
  if (publisherAgentKey) {
    const replyTargetNumbers = new Set<number>();
    if (createdMessage.reply_to_number) replyTargetNumbers.add(createdMessage.reply_to_number);
    const supervisedTarget = parseSupervisedReplySourceNumber(clientMessageId);
    if (supervisedTarget) replyTargetNumbers.add(supervisedTarget);
    for (const targetNumber of replyTargetNumbers) {
      const unresolved = await tx
        .select({
          id: message_agent_receipts.id,
          receipt_state: message_agent_receipts.receipt_state,
          turn_position: message_agent_receipts.turn_position,
        })
        .from(message_agent_receipts)
        .where(and(
          eq(message_agent_receipts.message_room_id, roomId),
          eq(message_agent_receipts.message_number, targetNumber),
          eq(message_agent_receipts.agent_key, publisherAgentKey),
          inArray(message_agent_receipts.receipt_state, ["queued", "responding", "retrying", "blocked", "no_reply", "unavailable"]),
        ));
      for (const receipt of unresolved) {
        // Compare-and-set: if a concurrent transition won between the read
        // and this write, record nothing — an event may only describe a
        // state change that actually happened.
        const applied = await tx
          .update(message_agent_receipts)
          .set({
            receipt_state: "replied",
            // The committed reply IS the canonical answer: stamp its number
            // so Message info can link "View reply" even for supervised
            // publications, which never set reply_to.
            reply_message_number: createdMessage.number,
            updated_at: createdMessage.timestamp,
          })
          .where(and(
            eq(message_agent_receipts.id, receipt.id),
            eq(message_agent_receipts.receipt_state, receipt.receipt_state),
          ))
          .returning({ id: message_agent_receipts.id });
        if (applied.length === 0) continue;
        await tx.insert(message_agent_receipt_events).values({
          id: `rcpt_evt_${randomUUID().replace(/-/g, "")}`,
          receipt_id: receipt.id,
          message_room_id: roomId,
          message_number: targetNumber,
          from_state: receipt.receipt_state,
          to_state: "replied",
          actor_session_id: createdMessage.publisher_agent_session_id,
          timestamp: createdMessage.timestamp,
        });
        repliedReceiptTargets.add(targetNumber);
        // This agent's turn is done: the next ready position may now see
        // the message, with this reply already in its context.
        if (receipt.turn_position !== null) {
          releasedReplyTurns.push(...await finishReplyTurnsTx(tx, roomId, [{
            message_number: targetNumber,
            agent_key: publisherAgentKey,
          }]));
        }
      }
    }
  }
}
