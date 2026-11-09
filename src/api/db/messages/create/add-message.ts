/**
 * Creates a room message: one transaction that validates, inserts, notifies
 * and routes it, then post-commit wakes.
 */
import { and, eq, sql } from "drizzle-orm";
import { MESSAGE_SENDER_MAX_CODE_POINTS, MESSAGE_SENDER_MAX_UTF8_BYTES, isMessageSenderWithinBounds } from "../../../../../shared/message-contracts.mjs";
import { RequestValidationError } from "../../../validation-error.js";
import { db } from "../../client.js";
import { messages, room_agent_sessions, type MessageNoWake } from "../../schema.js";
import type { Message, MessageMentionNotice, MessageRecipientAgentTarget } from "../../types.js";
import { queueReplyTurnWakes, releaseAgentReplyTurnHoldsTx, type ReleasedReplyTurn } from "../reply-turns.js";
import type { AddMessageOptions, AddMessageResult } from "./types.js";
import { hydrateCreatedMessage } from "./hydrate.js";
import { normalizeClientMessageId, resolveMessageTargets } from "./validation.js";
import { insertMessageRow } from "./insert.js";
import { attachMessageUploads } from "./attachments.js";
import { finishCreatedMessage } from "./after-insert.js";
import { resolveMessageRoutingContext } from "./routing-context.js";
import { routeMessageToActiveSessions } from "./receipt-routing.js";
import { routeAddressedMessage } from "./addressed.js";
import { markAnsweredReceiptsReplied } from "./reply-receipts.js";
import { enqueueWakeWebhooksForMessageTx } from "../../../wake-rules/webhook-enqueue.js";

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
    let routedNoWake: MessageNoWake | null = null;
    let jevPending = false;

    if (activeSessions.length > 0) {
      ({
        receiptCount, recipientAgentKeys, recipientAgentTargets, mentionNotices,
        noWake: routedNoWake, jevPending,
      } = await routeMessageToActiveSessions(
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

    // Hosted bots woken by webhook follow the same routing decision, committed with the message.
    const wakeRuleDeliveries = await enqueueWakeWebhooksForMessageTx(tx, createdMessage, {
      promptOnly: createdMessageIsPromptOnly,
      addressedAgentKey: addressedTo?.agent_key ?? null,
      recipientAgentKeys,
      activeSessions,
      routingMessage: routing.messageForRouting,
    });

    // A human's message that woke nobody keeps the reason for its sender.
    // While deferred routing is pending the column stays empty; the routing
    // job writes it if it elects nobody.
    if (receiptCount === 0 && !jevPending && createdMessage.source === "browser"
      && createdMessage.publisher_account_id && !createdMessage.publisher_agent_key
      && !createdMessageIsPromptOnly) {
      let noWake: MessageNoWake = routedNoWake ?? { reason: "unknown" };
      if (wakeRuleDeliveries > 0) {
        // A wake rule (a hosted bot's webhook) woke an agent without a
        // receipt. Recorded so the sender is not told that nobody woke.
        noWake = { reason: "wake_rule" };
      } else if (activeSessions.length === 0) {
        // Routing may load only candidate sessions; check the whole room.
        const [registered] = await tx.select({ session_id: room_agent_sessions.session_id })
          .from(room_agent_sessions)
          .where(and(
            eq(room_agent_sessions.room_id, roomId),
            eq(room_agent_sessions.session_kind, "worker"),
            sql`${room_agent_sessions.ended_at} IS NULL`,
          ))
          .limit(1);
        if (!registered) noWake = { reason: "no_agents" };
      }
      await tx.update(messages).set({ no_wake: noWake })
        .where(and(eq(messages.room_id, roomId), eq(messages.number, createdMessage.number)));
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
    void import("../../../server/message-info-events.js").then(({ queueMessageInfoInvalidation }) => {
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
