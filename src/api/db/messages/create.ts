import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  assertAttachmentTotalByteSize,
  type NormalizedMessageAttachmentReference,
} from "../../messages/attachments.js";
import {
  isPromptOnlyAgentMessage,
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../../../shared/room-agent-prompts.js";
import { decideAgentMessageActivation } from "../../../shared/activation-routing.js";
import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import { message_attachment_uploads, message_attachments, messages, room_agent_sessions, message_agent_receipts, message_agent_receipt_events, task_leases } from "../schema.js";
import { toMessageWithReply } from "../mappers.js";
import type {
  Message,
  MessageAttachmentRow,
  MessageRow,
} from "../types.js";
import { nextRoomScopedNumber, parseScopedId } from "../utils.js";
import {
  messageRowSelection,
  messageAttachmentUploadSelection,
} from "./selections.js";
import { hydrateMessageReplies } from "./history.js";
import { enqueueDesktopPushNotifications } from "../../notifications/enqueue.js";

function normalizeClientMessageId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

/** The transaction handle message creation runs in, for atomic side effects. */
export type MessageCreateTransaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export interface AddMessageOptions {
  source?: string;
  agent_prompt_kind?: AgentPromptKind | null;
  reply_to_message_id?: string | null;
  thread_root_message_id?: string | null;
  attachments?: NormalizedMessageAttachmentReference[];
  client_message_id?: string | null;
  publisher_agent_key?: string | null;
  publisher_agent_session_id?: string | null;
  account_id?: string | null;
  /**
   * Runs inside the message-insert transaction after the row is created, so
   * callers can persist state that must be atomic with message creation
   * (e.g. liveness announcement markers). A throw rolls the message back too.
   * Not invoked on the idempotent-replay path: a deduped message means a
   * prior transaction already committed both the message and this side
   * effect together.
   */
  with_created_message_in_transaction?: (tx: MessageCreateTransaction) => Promise<void>;
}

export interface AddMessageResult {
  message: Message;
  created: boolean;
}

interface AddMessageTransactionResult {
  messageRow: MessageRow;
  created: boolean;
}

export async function addMessageWithCreateStatus(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<AddMessageResult> {
  const promptKind = options?.agent_prompt_kind ?? null;
  const attachmentRefs = options?.attachments ?? [];
  const clientMessageId = normalizeClientMessageId(options?.client_message_id);
  const repliedReceiptTargets = new Set<number>();
  const result = await db.transaction(async (tx): Promise<AddMessageTransactionResult> => {
    const replyToNumber =
      options?.reply_to_message_id
        ? parseScopedId(options.reply_to_message_id, "msg")
        : null;
    const explicitThreadRootNumber =
      options?.thread_root_message_id
        ? parseScopedId(options.thread_root_message_id, "msg")
        : null;

    if (clientMessageId) {
      const [existingMessage] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.client_message_id, clientMessageId)))
        .limit(1);

      if (existingMessage) {
        return {
          messageRow: existingMessage,
          created: false,
        };
      }
    }

    if (options?.reply_to_message_id && !replyToNumber) {
      throw new RequestValidationError("reply_to must be a valid message id");
    }
    if (options?.thread_root_message_id && !explicitThreadRootNumber) {
      throw new RequestValidationError("thread_root_id must be a valid message id");
    }

    let replyTargetRootNumber: number | null = null;
    if (replyToNumber) {
      const [replyTarget] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);

      if (!replyTarget) {
        throw new RequestValidationError("reply_to must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(replyTarget.text, normalizeAgentPromptKind(replyTarget.agent_prompt_kind))) {
        throw new RequestValidationError("reply_to must reference a visible message");
      }

      replyTargetRootNumber = replyTarget.thread_root_number ?? replyTarget.number;
    }

    let threadRootNumber = explicitThreadRootNumber;
    if (explicitThreadRootNumber) {
      const [threadRoot] = await tx
        .select(messageRowSelection)
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, explicitThreadRootNumber)))
        .limit(1);

      if (!threadRoot) {
        throw new RequestValidationError("thread_root_id must reference an existing message in this room");
      }

      if (isPromptOnlyAgentMessage(threadRoot.text, normalizeAgentPromptKind(threadRoot.agent_prompt_kind))) {
        throw new RequestValidationError("thread_root_id must reference a visible message");
      }

      threadRootNumber = threadRoot.thread_root_number ?? threadRoot.number;
      if (replyTargetRootNumber && replyTargetRootNumber !== threadRootNumber) {
        throw new RequestValidationError("reply_to must belong to the requested thread");
      }
    }

    const message: MessageRow = {
      room_id: roomId,
      number: await nextRoomScopedNumber("messages", roomId, tx),
      reply_to_number: replyToNumber,
      thread_root_number: threadRootNumber,
      sender,
      text,
      agent_prompt_kind: promptKind,
      source: options?.source ?? null,
      client_message_id: clientMessageId,
      publisher_agent_key: options?.publisher_agent_key?.trim() || null,
      publisher_agent_session_id: options?.publisher_agent_session_id?.trim() || null,
      publisher_account_id: options?.account_id?.trim() || null,
      routing_snapshot_version: 1,
      timestamp: new Date().toISOString(),
    };

    let createdMessage = message;
    if (clientMessageId) {
      const [insertedMessage] = await tx
        .insert(messages)
        .values(message)
        .onConflictDoNothing()
        .returning(messageRowSelection);
      if (!insertedMessage) {
        const [existingMessage] = await tx
          .select(messageRowSelection)
          .from(messages)
          .where(and(eq(messages.room_id, roomId), eq(messages.client_message_id, clientMessageId)))
          .limit(1);
        if (!existingMessage) {
          throw new Error("message idempotency conflict could not be resolved");
        }
        return {
          messageRow: existingMessage,
          created: false,
        };
      }
      createdMessage = insertedMessage;
    } else {
      await tx.insert(messages).values(message);
    }
    let attachmentRows: MessageAttachmentRow[] = [];
    if (attachmentRefs.length > 0) {
      const uploadIds = attachmentRefs.map((attachment) => attachment.upload_id);
      const claimedUploadRows = await tx
        .update(message_attachment_uploads)
        .set({
          status: "attached",
          attached_message_number: createdMessage.number,
          attached_at: createdMessage.timestamp,
        })
        .where(
          and(
            eq(message_attachment_uploads.room_id, roomId),
            inArray(message_attachment_uploads.upload_id, uploadIds),
            eq(message_attachment_uploads.status, "pending"),
            sql`${message_attachment_uploads.expires_at} > ${createdMessage.timestamp}`,
          ),
        )
        .returning(messageAttachmentUploadSelection);
      const uploadsById = new Map(claimedUploadRows.map((row) => [row.upload_id, row]));
      const orderedUploads = uploadIds.map((uploadId) => {
        const upload = uploadsById.get(uploadId);
        if (!upload) {
          throw new RequestValidationError("attachment upload not found or expired");
        }
        return upload;
      });
      assertAttachmentTotalByteSize(orderedUploads);
      attachmentRows = orderedUploads.map((attachment, index) => ({
        room_id: roomId,
        message_number: createdMessage.number,
        attachment_number: index + 1,
        upload_id: attachment.upload_id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
        storage_provider: attachment.storage_provider,
        bucket: attachment.bucket,
        object_key: attachment.object_key,
        created_at: createdMessage.timestamp,
      }));
    }
    if (attachmentRows.length > 0) {
      await tx.insert(message_attachments).values(attachmentRows);
    }
    if (isPromptOnlyAgentMessage(createdMessage.text, promptKind)) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.room_id, roomId),
            eq(messages.sender, sender),
            eq(messages.agent_prompt_kind, "auto"),
            sql`BTRIM(${messages.text}) = ''`,
            sql`${messages.number} < ${createdMessage.number}`,
          ),
        );
    }

    let notificationEnqueueDurationMs = 0;
    if (!isPromptOnlyAgentMessage(createdMessage.text, promptKind)) {
      const notificationEnqueueStartedAtMs = Date.now();
      await enqueueDesktopPushNotifications(tx, createdMessage);
      notificationEnqueueDurationMs = Date.now() - notificationEnqueueStartedAtMs;
    }

    if (options?.with_created_message_in_transaction) {
      await options.with_created_message_in_transaction(tx);
    }

    // Send-time routing snapshot: resolve active worker sessions in this room and insert queued receipts
    const routingStartedAtMs = Date.now();
    const activeSessions = await tx
      .select()
      .from(room_agent_sessions)
      .where(
        and(
          eq(room_agent_sessions.room_id, roomId),
          eq(room_agent_sessions.session_kind, "worker"),
          sql`${room_agent_sessions.ended_at} IS NULL`
        )
      )
      // Deterministic representative when several sessions share an agent_key.
      .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id));

    let receiptCount = 0;

    if (activeSessions.length > 0) {
      const leases = await tx
        .select()
        .from(task_leases)
        .where(
          and(
            eq(task_leases.room_id, roomId),
            eq(task_leases.status, "active")
          )
        );

      let replyToMessage: { sender: string; source?: string } | null = null;
      if (replyToNumber) {
        const [foundReply] = await tx
          .select({ sender: messages.sender, source: messages.source })
          .from(messages)
          .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
          .limit(1);
        if (foundReply) replyToMessage = { sender: foundReply.sender, source: foundReply.source ?? undefined };
      }

      // A top-level message is its own (still-empty) thread: the only
      // participant is its sender, so the participant query is skipped.
      const threadRootNumber = createdMessage.thread_root_number || createdMessage.number;
      const threadParticipants = createdMessage.thread_root_number
        ? (await tx
          .select({ sender: messages.sender })
          .from(messages)
          .where(
            and(
              eq(messages.room_id, roomId),
              sql`(${messages.thread_root_number} = ${threadRootNumber} OR ${messages.number} = ${threadRootNumber})`
            )
          )).map((m) => ({ sender: m.sender }))
        : [{ sender: createdMessage.sender }];

      const messageForRouting = {
        id: `msg_${createdMessage.number}`,
        sender: createdMessage.sender,
        text: createdMessage.text,
        source: createdMessage.source,
        reply_to: replyToMessage,
        thread_root_id: `msg_${threadRootNumber}`,
        thread: {
          root_message_id: `msg_${threadRootNumber}`,
          participants: threadParticipants,
        },
      };

      const routingContext = { activeTaskLeases: leases };
      // Receipts are keyed by durable agent identity: several live sessions
      // (duplicates, mid-rotation overlap) may share one agent_key, but the
      // agent was asked once. The earliest session represents it; the unique
      // (message, agent_key) index makes this a database invariant.
      const receiptsByAgentKey = new Map<string, {
        id: string; message_room_id: string; message_number: number; room_id: string;
        agent_session_id: string; agent_key: string; actor_label: string;
        activation_reason: string; receipt_state: string; created_at: string; updated_at: string;
      }>();

      for (const session of activeSessions) {
        if (receiptsByAgentKey.has(session.agent_key)) continue;
        const activation = decideAgentMessageActivation(
          messageForRouting,
          {
            actor_label: session.actor_label,
            agent_key: session.agent_key,
            agent_instance_id: session.agent_instance_id,
            agent_session_id: session.session_id,
            display_name: session.display_name,
            session_kind: session.session_kind,
          },
          routingContext
        );

        if (activation.decision === "activate") {
          const receiptId = `rcpt_${randomUUID().replace(/-/g, "")}`;
          receiptsByAgentKey.set(session.agent_key, {
            id: receiptId,
            message_room_id: roomId,
            message_number: createdMessage.number,
            room_id: roomId,
            agent_session_id: session.session_id,
            agent_key: session.agent_key,
            actor_label: session.actor_label,
            activation_reason: activation.reason,
            receipt_state: "queued",
            created_at: createdMessage.timestamp,
            updated_at: createdMessage.timestamp,
          });
        }
      }

      const receiptRowsToInsert = [...receiptsByAgentKey.values()];
      receiptCount = receiptRowsToInsert.length;
      if (receiptRowsToInsert.length > 0) {
        await tx.insert(message_agent_receipts).values(receiptRowsToInsert).onConflictDoNothing();
      }
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
          .select({ id: message_agent_receipts.id, receipt_state: message_agent_receipts.receipt_state })
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
        }
      }
    }

    return {
      messageRow: createdMessage,
      created: true,
    };
  });
  if (repliedReceiptTargets.size > 0) {
    // Dynamic import avoids a module cycle; room-level so the shared stream
    // never enumerates ids that may be concealed from some participants.
    const { queueMessageInfoInvalidation } = await import("../../server/message-info-events.js");
    queueMessageInfoInvalidation(roomId, null);
  }
  const [message] = await hydrateMessageReplies(roomId, [result.messageRow], {
    accountId: options?.account_id ?? null,
  });
  return {
    message: message ?? toMessageWithReply(result.messageRow, null),
    created: result.created,
  };
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
export function parseSupervisedReplySourceNumber(clientMessageId: string | null): number | null {
  if (!clientMessageId) return null;
  const parts = clientMessageId.split(":");
  if (parts[0] !== "supervised-room" || parts.at(-2) !== "reply" || parts.at(-1) !== "v1") return null;
  const body = parts.slice(1, -2);
  if (body.length !== 2 && body.length !== 3) return null;
  const source = body.at(-1);
  if (!source || !/^msg_\d+$/.test(source)) return null;
  const parsed = Number(source.slice(4));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
