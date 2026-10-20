import { sql } from "drizzle-orm";
import { MESSAGE_SENDER_MAX_CODE_POINTS, MESSAGE_SENDER_MAX_UTF8_BYTES, isMessageSenderWithinBounds, parseSupervisedReplySourceNumber } from "../../../../shared/message-contracts.mjs";
import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import type { Message, MessageMentionNotice, MessageRecipientAgentTarget } from "../types.js";
import { queueReplyTurnWakes, releaseAgentReplyTurnHoldsTx, type ReleasedReplyTurn } from "./reply-turns.js";
import type { AddMessageOptions, AddMessageResult } from "./create/types.js";
import { hydrateCreatedMessage } from "./create/hydrate.js";
import { normalizeClientMessageId, resolveMessageTargets } from "./create/validation.js";
import { insertMessageRow } from "./create/insert.js";
import { attachMessageUploads } from "./create/attachments.js";
import { finishCreatedMessage } from "./create/after-insert.js";
import { resolveMessageRoutingContext } from "./create/routing-context.js";
import { routeMessageToActiveSessions } from "./create/receipt-routing.js";
import { routeAddressedMessage } from "./create/addressed.js";
import { markAnsweredReceiptsReplied } from "./create/reply-receipts.js";
export type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./create/types.js";
export { chunkMessageReceiptRows } from "./create/receipt-rows.js";

export async function addMessageWithCreateStatus(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<AddMessageResult> {
  if (!isMessageSenderWithinBounds(sender)) {
    throw new RequestValidationError(
      `sender must not exceed ${MESSAGE_SENDER_MAX_CODE_POINTS} characters or ${MESSAGE_SENDER_MAX_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const promptKind = options?.agent_prompt_kind ?? null;
  const attachmentRefs = options?.attachments ?? [];
  const clientMessageId = normalizeClientMessageId(options?.client_message_id);
  const repliedReceiptTargets = new Set<number>();
  const releasedReplyTurns: ReleasedReplyTurn[] = [];
  // Conversation routing (Jev) never runs inside the send: the plan is
  // captured in the transaction and executed after commit, so the human's
  // send returns as fast as the deterministic ladder alone.
  const result = await db.transaction(async (tx): Promise<AddMessageResult> => {
    // Transitional projection repair can inspect a legacy thread on the first
    // post-watermark reply. Bound that work—and every other statement in this
    // atomic send—so a pathological archive cannot wedge an API worker.
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '15s'"));
    const targets = await resolveMessageTargets(tx, roomId, sender, text, options, clientMessageId);
    if ("replay" in targets) return targets.replay;
    const { replyToNumber, threadRootNumber } = targets;

    const inserted = await insertMessageRow(
      tx, roomId, sender, text, options, promptKind, clientMessageId, replyToNumber, threadRootNumber,
    );
    if ("replay" in inserted) return inserted.replay;
    const { createdMessage } = inserted;
    await attachMessageUploads(tx, roomId, createdMessage, attachmentRefs, options);
    const { createdMessageIsPromptOnly, addressedTo, notificationEnqueueDurationMs } =
      await finishCreatedMessage(tx, roomId, sender, options, promptKind, createdMessage);

    const routing = await resolveMessageRoutingContext(tx, roomId, createdMessage, addressedTo, replyToNumber);
    const {
      routingStartedAtMs,
      activeSessions,
    } = routing;

    let receiptCount = 0;
    let recipientAgentKeys: readonly string[] = [];
    let recipientAgentTargets: readonly MessageRecipientAgentTarget[] = [];
    let mentionNotices: readonly MessageMentionNotice[] = [];

    if (activeSessions.length > 0) {
      ({ receiptCount, recipientAgentKeys, recipientAgentTargets, mentionNotices } = await routeMessageToActiveSessions(
        tx, roomId, createdMessage, createdMessageIsPromptOnly, routing, releasedReplyTurns,
      ));
    }

    if (addressedTo) {
      const addressed = await routeAddressedMessage(tx, roomId, createdMessage, addressedTo);
      releasedReplyTurns.push(...await releaseAgentReplyTurnHoldsTx(
        tx,
        roomId,
        addressed.map((target) => target.agent_key),
      ));
      receiptCount = addressed.length;
      recipientAgentKeys = addressed.map((target) => target.agent_key);
      recipientAgentTargets = addressed;
    }

    // Notification fan-out and worker routing both stay synchronous and atomic
    // with the message. Account for their combined hot-path cost so rooms with
    // no live worker sessions do not hide a slow notification enqueue.
    const routingDurationMs = Date.now() - routingStartedAtMs;
    const sendTimeFanoutDurationMs = notificationEnqueueDurationMs + routingDurationMs;
    if (sendTimeFanoutDurationMs > 250) {
      console.warn(
        `[message send-time fan-out] slow fan-out for ${roomId}: ${sendTimeFanoutDurationMs}ms`
        + ` (${notificationEnqueueDurationMs}ms notifications, ${routingDurationMs}ms routing,`
        + ` ${activeSessions.length} active sessions, ${receiptCount} receipts)`,
      );
    }

    await markAnsweredReceiptsReplied(tx, roomId, createdMessage, clientMessageId, repliedReceiptTargets, releasedReplyTurns);

    return hydrateCreatedMessage(roomId, {
      messageRow: createdMessage,
      created: true,
      recipientAgentKeys,
      recipientAgentTargets,
      mentionNotices,
    }, options, tx);
  });
  // Only after commit, and only the released agents' workers.
  queueReplyTurnWakes(releasedReplyTurns);
  if (repliedReceiptTargets.size > 0) {
    // Dynamic import avoids a module cycle; room-level so the shared stream
    // never enumerates ids that may be concealed from some participants.
    void import("../../server/message-info-events.js").then(({ queueMessageInfoInvalidation }) => {
      queueMessageInfoInvalidation(roomId, null);
    }).catch((error) => {
      console.error(`[room messages] failed receipt invalidation for ${roomId}`, error);
    });
  }
  return result;
}

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<Message> {
  const result = await addMessageWithCreateStatus(roomId, sender, text, options);
  return result.message;
}

/**
 * Supervised daemon publications carry a reply-namespace idempotency id:
 *   supervised-room:<entry>:<source-message>:reply:v1
 *   supervised-room:<entry>:<room>:<source-message>:reply:v1
 * Only this exact shape identifies a reply target; arbitrary client ids never
 * influence receipt state.
 */
export { parseSupervisedReplySourceNumber };
