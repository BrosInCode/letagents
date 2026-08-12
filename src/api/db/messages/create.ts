import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
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
import {
  MESSAGE_SENDER_MAX_CODE_POINTS,
  MESSAGE_SENDER_MAX_UTF8_BYTES,
  isMessageSenderWithinBounds,
} from "../../../../shared/message-contracts.mjs";
import {
  createGlobalAgentAddressResolver,
  decideAgentMessageActivation,
  isUntrustedExternalActivationSource,
  isTaskOwnerFollowUpMessageText,
  type ActivationIdentity,
} from "../../../shared/activation-routing.js";
import { RequestValidationError } from "../../validation-error.js";
import { db } from "../client.js";
import { message_attachment_uploads, message_attachments, messages, room_agent_sessions, message_agent_receipts, message_agent_receipt_events } from "../schema.js";
import { toMessageWithReply } from "../mappers.js";
import type {
  Message,
  MessageAttachmentRow,
  MessageRecipientAgentTarget,
  MessageRow,
} from "../types.js";
import { nextRoomScopedNumber, parseScopedId } from "../utils.js";
import {
  messageRowSelection,
  messageAttachmentUploadSelection,
} from "./selections.js";
import { hydrateMessageReplies } from "./history.js";
import {
  createAccountRoutingTargetBudget,
  getBoundedActiveWorkLeaseOwners,
  getMessageAccountAgentRouting,
  MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES,
  MAX_ACCOUNT_ROUTING_TARGETS,
} from "./account-agent-routing.js";
import { getMessageThreadReadOverlays } from "./thread-read-overlays.js";
import {
  getMessageThreadRoutingProjection,
  resolveMessageThreadRoutingProjection,
  type ThreadRoutingProjection,
} from "./thread-routing-membership.js";
import { enqueueDesktopPushNotifications } from "../../notifications/enqueue.js";

const MESSAGE_RECEIPT_INSERT_BATCH_SIZE = 500;
const MAX_ACTIVE_ROUTING_SESSIONS = 50_000;

export function chunkMessageReceiptRows<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += MESSAGE_RECEIPT_INSERT_BATCH_SIZE) {
    chunks.push(rows.slice(offset, offset + MESSAGE_RECEIPT_INSERT_BATCH_SIZE));
  }
  return chunks;
}

async function insertMessageReceiptRows(
  tx: MessageCreateTransaction,
  rows: readonly {
    id: string;
    message_room_id: string;
    message_number: number;
    room_id: string;
    agent_session_id: string;
    agent_key: string;
    actor_label: string;
    activation_reason: string;
    receipt_state: string;
    created_at: string;
    updated_at: string;
  }[],
): Promise<void> {
  for (const batch of chunkMessageReceiptRows(rows)) {
    // One JSON bind per bounded batch avoids Drizzle/Postgres parameter growth
    // and keeps large broadcasts set-based inside the message transaction.
    await tx.execute(sql`
      INSERT INTO ${message_agent_receipts} (
        id, message_room_id, message_number, room_id, agent_session_id,
        agent_key, actor_label, activation_reason, receipt_state,
        created_at, updated_at
      )
      SELECT input.id, input.message_room_id, input.message_number,
             input.room_id, input.agent_session_id, input.agent_key,
             input.actor_label, input.activation_reason, input.receipt_state,
             input.created_at::timestamptz, input.updated_at::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS input(
          id text, message_room_id text, message_number integer, room_id text,
          agent_session_id text, agent_key text, actor_label text,
          activation_reason text, receipt_state text,
          created_at text, updated_at text
        )
      ON CONFLICT DO NOTHING
    `);
  }
}

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
  account_agent_routing?: boolean;
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
  canonical_message: Message;
  created: boolean;
  /** Durable recipients resolved in the same transaction as the message. */
  recipientAgentKeys: readonly string[];
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}

interface AddMessageTransactionResult {
  messageRow: MessageRow;
  created: boolean;
  recipientAgentKeys: readonly string[];
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}

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
  const result = await db.transaction(async (tx): Promise<AddMessageTransactionResult> => {
    // Transitional projection repair can inspect a legacy thread on the first
    // post-watermark reply. Bound that work—and every other statement in this
    // atomic send—so a pathological archive cannot wedge an API worker.
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '15s'"));
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
          recipientAgentKeys: [],
          recipientAgentTargets: [],
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
          recipientAgentKeys: [],
          recipientAgentTargets: [],
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
    const createdMessageIsPromptOnly = isPromptOnlyAgentMessage(createdMessage.text, promptKind);
    if (createdMessageIsPromptOnly) {
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
    if (!createdMessageIsPromptOnly) {
      const notificationEnqueueStartedAtMs = Date.now();
      await enqueueDesktopPushNotifications(tx, createdMessage);
      notificationEnqueueDurationMs = Date.now() - notificationEnqueueStartedAtMs;
    }

    if (options?.with_created_message_in_transaction) {
      await options.with_created_message_in_transaction(tx);
    }

    // Send-time routing snapshot: resolve active worker sessions in this room and insert queued receipts
    const routingStartedAtMs = Date.now();
    const untrustedExternalEvent = isUntrustedExternalActivationSource(createdMessage.source);
    const taskOwnerFollowUp = !untrustedExternalEvent
      && isTaskOwnerFollowUpMessageText(createdMessage.text);
    const leases = taskOwnerFollowUp
      ? await getBoundedActiveWorkLeaseOwners(tx, roomId)
      : [];

    let replyToMessage: {
      sender: string;
      source?: string;
      publisher_agent_key?: string | null;
      publisher_agent_session_id?: string | null;
      publisher_account_id?: string | null;
    } | null = null;
    if (replyToNumber) {
      const [foundReply] = await tx
        .select({
          sender: messages.sender,
          source: messages.source,
          publisher_agent_key: messages.publisher_agent_key,
          publisher_agent_session_id: messages.publisher_agent_session_id,
          publisher_account_id: messages.publisher_account_id,
        })
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);
      if (foundReply) replyToMessage = {
        sender: foundReply.sender,
        source: foundReply.source ?? undefined,
        publisher_agent_key: foundReply.publisher_agent_key,
        publisher_agent_session_id: foundReply.publisher_agent_session_id,
        publisher_account_id: foundReply.publisher_account_id,
      };
    }

    const routingThreadRootNumber = createdMessage.thread_root_number || createdMessage.number;
    const threadRootId = `msg_${routingThreadRootNumber}`;
    let threadRoutingProjection: ThreadRoutingProjection = {
      exactMembers: new Map(),
      legacyAliases: new Map(),
    };
    const messageForRouting = {
      id: `msg_${createdMessage.number}`,
      sender: createdMessage.sender,
      text: createdMessage.text,
      source: createdMessage.source,
      reply_to: replyToMessage,
      thread_root_id: threadRootId,
      thread: {
        root_message_id: threadRootId,
        // Display participants are intentionally not hydrated on the hot
        // write path. Exact membership comes from the indexed projection.
        participants: [],
      },
    };

    // Only address resolution needs the complete room population. Exact
    // thread, reply, and lease authority already yields durable candidates;
    // querying just those keys/sessions avoids enumerating a large room twice
    // for an ordinary one-recipient continuation.
    const routingShape = createGlobalAgentAddressResolver([])(messageForRouting);
    const candidateAgentKeys = new Set<string>();
    const candidateSessionIds = new Set<string>();
    if (replyToMessage?.publisher_agent_key && replyToMessage.publisher_account_id) {
      candidateAgentKeys.add(replyToMessage.publisher_agent_key);
      if (replyToMessage.publisher_agent_session_id) {
        candidateSessionIds.add(replyToMessage.publisher_agent_session_id);
      }
    }
    let leaseNeedsCompletePopulation = false;
    for (const lease of leases) {
      if (lease.agent_key) candidateAgentKeys.add(lease.agent_key);
      if (lease.agent_session_id) candidateSessionIds.add(lease.agent_session_id);
      if (!lease.agent_key && !lease.agent_session_id) leaseNeedsCompletePopulation = true;
    }
    const needsCompletePopulation = routingShape.broadcast
      || routingShape.hasMention
      || createdMessage.thread_root_number !== null
      || (
        replyToMessage?.source === "agent"
        && !replyToMessage.publisher_agent_key
        // A threaded legacy reply target is already resolved globally by the
        // participant projection above. Top-level quotes still need the full
        // room alias population to establish uniqueness.
        && !createdMessage.thread_root_number
      )
      || (createdMessage.source === "agent" && !createdMessage.publisher_agent_key)
      || leaseNeedsCompletePopulation;
    const candidateKeys = [...candidateAgentKeys];
    const candidateSessions = [...candidateSessionIds];
    // Keep candidate lookup to O(1) PostgreSQL bind parameters. Expanding a
    // projected 65k+ durable-key set through inArray() exceeds the wire
    // protocol's 65,535 parameter ceiling before the active-session bound can
    // fail closed.
    const candidateKeyCondition = candidateKeys.length > 0
      ? sql`${room_agent_sessions.agent_key} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateKeys)}::jsonb)
        )`
      : undefined;
    const candidateSessionCondition = candidateSessions.length > 0
      ? sql`${room_agent_sessions.session_id} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateSessions)}::jsonb)
        )`
      : undefined;
    const candidateCondition = candidateKeyCondition && candidateSessionCondition
      ? or(
          candidateKeyCondition,
          candidateSessionCondition,
        )
      : candidateKeyCondition ?? candidateSessionCondition;
    const activeSessions = !untrustedExternalEvent && (needsCompletePopulation || candidateCondition)
      ? await tx
          .select({
            session_id: room_agent_sessions.session_id,
            actor_label: room_agent_sessions.actor_label,
            agent_key: room_agent_sessions.agent_key,
            agent_instance_id: room_agent_sessions.agent_instance_id,
            display_name: room_agent_sessions.display_name,
            session_kind: room_agent_sessions.session_kind,
            owner_account_id: room_agent_sessions.owner_account_id,
            created_at: room_agent_sessions.created_at,
          })
          .from(room_agent_sessions)
          .where(
            and(
              eq(room_agent_sessions.room_id, roomId),
              eq(room_agent_sessions.session_kind, "worker"),
              sql`${room_agent_sessions.ended_at} IS NULL`,
              needsCompletePopulation ? undefined : candidateCondition,
            )
          )
          // Deterministic representative when several sessions share an agent_key.
          .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
          .limit(MAX_ACTIVE_ROUTING_SESSIONS + 1)
      : [];

    if (activeSessions.length > MAX_ACTIVE_ROUTING_SESSIONS) {
      throw new RequestValidationError("Room has too many active worker sessions to route a message safely.");
    }

    if (createdMessage.thread_root_number && activeSessions.length > 0) {
      threadRoutingProjection = await getMessageThreadRoutingProjection(
        tx,
        roomId,
        [routingThreadRootNumber],
        {
          activeIdentities: activeSessions.map((session) => ({
            actor_label: session.actor_label,
            agent_key: session.agent_key,
            agent_instance_id: session.agent_instance_id,
            agent_session_id: session.session_id,
            display_name: session.display_name,
            session_kind: session.session_kind,
            owner_account_id: session.owner_account_id,
          })),
        },
      );
    }

    let receiptCount = 0;
    let recipientAgentKeys: readonly string[] = [];
    let recipientAgentTargets: readonly MessageRecipientAgentTarget[] = [];

    if (activeSessions.length > 0) {
      // Resolve routing against every overlapping session identity first.
      // Only a durable key with one owner may choose a deterministic session
      // representative for its single receipt after routing is complete.
      const sessionsByAgentKey = new Map<string, {
        sessions: (typeof activeSessions)[number][];
        identities: ActivationIdentity[];
        ownerAccountIds: Set<string>;
      }>();
      for (const session of activeSessions) {
        const group = sessionsByAgentKey.get(session.agent_key) ?? {
          sessions: [],
          identities: [],
          ownerAccountIds: new Set<string>(),
        };
        group.sessions.push(session);
        group.identities.push({
          actor_label: session.actor_label,
          agent_key: session.agent_key,
          agent_instance_id: session.agent_instance_id,
          agent_session_id: session.session_id,
          display_name: session.display_name,
          session_kind: session.session_kind,
        });
        group.ownerAccountIds.add(session.owner_account_id);
        sessionsByAgentKey.set(session.agent_key, group);
      }
      const allRoutingIdentities = [...sessionsByAgentKey.values()].flatMap(({ identities }) => identities);
      const threadMembership = new Set(
        resolveMessageThreadRoutingProjection(
          threadRoutingProjection,
          activeSessions.map((session) => ({
            actor_label: session.actor_label,
            agent_key: session.agent_key,
            agent_instance_id: session.agent_instance_id,
            agent_session_id: session.session_id,
            display_name: session.display_name,
            session_kind: session.session_kind,
            owner_account_id: session.owner_account_id,
          })),
        ).get(routingThreadRootNumber)?.map((member) => member.agent_key) ?? [],
      );
      const ownedSessionGroups = [...sessionsByAgentKey]
        .filter(([, group]) => group.ownerAccountIds.size === 1);
      const globalAddresses = createGlobalAgentAddressResolver(allRoutingIdentities)(messageForRouting);
      let exactReplySession: (typeof activeSessions)[number] | undefined;
      if (replyToMessage?.publisher_agent_key && replyToMessage.publisher_account_id) {
        globalAddresses.replyTargetKeys.clear();
        const replyGroup = sessionsByAgentKey.get(replyToMessage.publisher_agent_key);
        if (
          replyGroup?.ownerAccountIds.size === 1
          && replyGroup.ownerAccountIds.has(replyToMessage.publisher_account_id)
        ) {
          globalAddresses.replyTargetKeys.add(replyToMessage.publisher_agent_key);
          exactReplySession = replyToMessage.publisher_agent_session_id
            ? replyGroup.sessions.find((session) =>
                session.session_id === replyToMessage.publisher_agent_session_id)
            : undefined;
        }
      }

      // Receipts are keyed by durable agent identity: several live sessions
      // (duplicates, mid-rotation overlap) may share one agent_key, but the
      // agent was asked once. The earliest session represents it; the unique
      // (message, agent_key) index makes this a database invariant.
      const receiptsByAgentKey = new Map<string, {
        id: string; message_room_id: string; message_number: number; room_id: string;
        agent_session_id: string; agent_key: string; actor_label: string;
        activation_reason: string; receipt_state: string; created_at: string; updated_at: string;
      }>();

      for (const [agentKey, group] of ownedSessionGroups) {
        if (
          createdMessage.source === "agent"
          && createdMessage.publisher_agent_key === agentKey
        ) continue;
        const representative = group.sessions[0]!;
        // Exact authenticated publisher identity owns self suppression. Do
        // not let a mutable/same-label sender alias suppress an unrelated
        // durable worker when that exact identity is available.
        if (
          createdMessage.source === "agent"
          &&
          !createdMessage.publisher_agent_key
          && globalAddresses.senderKeys.has(agentKey)
        ) continue;
        let selectedActivation: {
          session: (typeof activeSessions)[number];
          activation: { decision: "activate"; reason: string; addressed: true };
        } | undefined;
        if (globalAddresses.broadcast) {
          selectedActivation = {
            session: representative,
            activation: { decision: "activate", reason: "broadcast", addressed: true },
          };
        } else if (globalAddresses.explicitMentionKeys.has(agentKey)) {
          selectedActivation = {
            session: representative,
            activation: { decision: "activate", reason: "explicit_mention", addressed: true },
          };
        } else if (globalAddresses.hasMention) {
          continue;
        } else if (globalAddresses.replyTargetKeys.has(agentKey)) {
          selectedActivation = {
            session: exactReplySession?.agent_key === agentKey
              ? exactReplySession
              : representative,
            activation: { decision: "activate", reason: "reply_target", addressed: true },
          };
        } else if (threadMembership.has(agentKey)) {
          selectedActivation = {
            session: representative,
            activation: { decision: "activate", reason: "thread_participant", addressed: true },
          };
        } else if (taskOwnerFollowUp) {
          selectedActivation = group.identities
            .map((identity, index) => ({
              session: group.sessions[index]!,
              activation: decideAgentMessageActivation(messageForRouting, identity, {
                activeTaskLeases: leases,
                threadParticipantRootIds: new Set<string>(),
              }),
            }))
            .find(({ activation }) =>
              activation.decision === "activate" && activation.reason === "task_owner") as
                typeof selectedActivation;
        }

        if (selectedActivation) {
          const receiptSession = selectedActivation.activation.reason === "task_owner"
            || selectedActivation.activation.reason === "reply_target"
            ? selectedActivation.session
            : representative;
          const receiptId = `rcpt_${randomUUID().replace(/-/g, "")}`;
          receiptsByAgentKey.set(agentKey, {
            id: receiptId,
            message_room_id: roomId,
            message_number: createdMessage.number,
            room_id: roomId,
            agent_session_id: receiptSession.session_id,
            agent_key: agentKey,
            actor_label: receiptSession.actor_label,
            activation_reason: selectedActivation.activation.reason,
            receipt_state: "queued",
            created_at: createdMessage.timestamp,
            updated_at: createdMessage.timestamp,
          });
        }
      }

      const receiptRowsToInsert = [...receiptsByAgentKey.values()];
      if (receiptRowsToInsert.length > MAX_ACCOUNT_ROUTING_TARGETS) {
        throw new RequestValidationError("Message fanout exceeds the bounded desktop routing contract.");
      }
      const consumeRoutingTarget = createAccountRoutingTargetBudget();
      for (const receipt of receiptRowsToInsert) {
        consumeRoutingTarget({
          agent_key: receipt.agent_key,
          agent_session_id: receipt.agent_session_id,
        });
      }
      const receiptEnvelopeBytes = Buffer.byteLength(JSON.stringify({
        version: 1,
        authority: "receipts",
        recipient_agent_keys: receiptRowsToInsert.map((receipt) => receipt.agent_key),
        recipient_agent_sessions: receiptRowsToInsert.map((receipt) => ({
          agent_key: receipt.agent_key,
          agent_session_id: receipt.agent_session_id,
        })),
        control_authorized: false,
      }), "utf8");
      if (receiptEnvelopeBytes > MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES) {
        throw new RequestValidationError("Message fanout exceeds the bounded desktop routing envelope.");
      }
      receiptCount = receiptRowsToInsert.length;
      recipientAgentKeys = receiptRowsToInsert.map((receipt) => receipt.agent_key);
      recipientAgentTargets = receiptRowsToInsert.map((receipt) => ({
        agent_key: receipt.agent_key,
        agent_session_id: receipt.agent_session_id,
        owner_account_id: sessionsByAgentKey.get(receipt.agent_key)!.sessions
          .find((session) => session.session_id === receipt.agent_session_id)!.owner_account_id,
      }));
      await insertMessageReceiptRows(tx, receiptRowsToInsert);
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
      recipientAgentKeys,
      recipientAgentTargets,
    };
  });
  if (repliedReceiptTargets.size > 0) {
    // Dynamic import avoids a module cycle; room-level so the shared stream
    // never enumerates ids that may be concealed from some participants.
    const { queueMessageInfoInvalidation } = await import("../../server/message-info-events.js");
    queueMessageInfoInvalidation(roomId, null);
  }
  const [hydrated] = await hydrateMessageReplies(roomId, [result.messageRow], {
    accountId: null,
  });
  const canonicalMessage = hydrated ?? toMessageWithReply(result.messageRow, null);
  let message = canonicalMessage;
  const accountId = options?.account_id ?? null;
  if (accountId) {
    const [readOverlays, accountRouting] = await Promise.all([
      canonicalMessage.thread
        ? getMessageThreadReadOverlays(roomId, [{
            root_message_id: canonicalMessage.thread.root_message_id,
            reply_count: canonicalMessage.thread.reply_count,
          }], [accountId])
        : Promise.resolve(new Map()),
      options?.account_agent_routing
        ? getMessageAccountAgentRouting(db, roomId, accountId, [result.messageRow])
        : Promise.resolve(new Map()),
    ]);
    const readOverlay = canonicalMessage.thread
      ? readOverlays.get(accountId)?.get(canonicalMessage.thread.root_message_id)
      : null;
    message = {
      ...canonicalMessage,
      ...(canonicalMessage.thread && readOverlay
        ? { thread: { ...canonicalMessage.thread, ...readOverlay } }
        : {}),
      ...(options?.account_agent_routing
        ? { account_agent_routing: accountRouting.get(result.messageRow.number) ?? null }
        : {}),
    };
  }
  return {
    message,
    canonical_message: canonicalMessage,
    created: result.created,
    recipientAgentKeys: result.recipientAgentKeys,
    recipientAgentTargets: result.recipientAgentTargets,
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
  return source ? parseScopedId(source, "msg") : null;
}
