/**
 * Checks a new message before it is written: its idempotency key, an exact
 * replay, and its reply and thread targets.
 */
import { and, eq } from "drizzle-orm";
import { isPromptOnlyAgentMessage, normalizeAgentPromptKind } from "../../../../shared/room-agent-prompts.js";
import { RequestValidationError } from "../../../validation-error.js";
import { room_settings, message_attachments, messages } from "../../schema.js";
import type { MessageRow } from "../../types.js";
import { parseScopedId } from "../../utils.js";
import { messageRowSelection } from "../selections.js";
import type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./types.js";
import { hydrateCreatedMessage } from "./hydrate.js";

export function normalizeClientMessageId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

export async function assertDesktopReplayMatches(
  tx: MessageCreateTransaction, existing: MessageRow, sender: string, text: string, options: AddMessageOptions | undefined,
): Promise<void> {
  // Existing internal publishers intentionally replay by key alone. Desktop
  // keys are public correlation IDs, so they must never grant another writer
  // access to a previous writer's successful result.
  if (!existing.client_message_id?.startsWith("desktop-send:")) return;
  const replyNumber = options?.reply_to_message_id ? parseScopedId(options.reply_to_message_id, "msg") : null;
  const rootNumber = options?.thread_root_message_id ? parseScopedId(options.thread_root_message_id, "msg") : null;
  if (existing.publisher_account_id !== (options?.account_id?.trim() || null)
    || existing.publisher_agent_key !== (options?.publisher_agent_key?.trim() || null)
    || existing.publisher_agent_session_id !== (options?.publisher_agent_session_id?.trim() || null)
    || existing.source !== (options?.source || null) || existing.sender !== sender || existing.text !== text
    || (existing.gif?.id ?? null) !== (options?.gif?.id ?? null)
    || (existing.gif?.title ?? null) !== (options?.gif?.title ?? null)
    || Boolean(existing.gif?.text_fallback_only) !== Boolean(options?.gif?.text_fallback_only)
    || existing.reply_to_number !== replyNumber
    || (existing.thread_root_number ?? existing.number) !== (rootNumber ?? existing.number)
    || existing.agent_prompt_kind !== (options?.agent_prompt_kind || null)) {
    throw new RequestValidationError("Outgoing message identity was reused by another writer or with different content.");
  }
  const attached = await tx.select({ upload_id: message_attachments.upload_id }).from(message_attachments)
    .where(and(eq(message_attachments.room_id, existing.room_id), eq(message_attachments.message_number, existing.number)));
  if (attached.map(item => item.upload_id).sort().join("|") !== (options?.attachments || []).map(item => item.upload_id).sort().join("|")) {
    throw new RequestValidationError("Outgoing message identity was reused with different attachments.");
  }
}

/**
 * Parses the reply and thread targets, returns an exact replay of an earlier
 * send with the same idempotency key, and checks that the targets exist, are
 * visible and agree.
 */
export async function resolveMessageTargets(
  tx: MessageCreateTransaction,
  roomId: string,
  sender: string,
  text: string,
  options: AddMessageOptions | undefined,
  clientMessageId: string | null,
): Promise<{ replay: AddMessageResult } | { replyToNumber: number | null; threadRootNumber: number | null }> {
  const replyToNumber =
    options?.reply_to_message_id
      ? parseScopedId(options.reply_to_message_id, "msg")
      : null;
  const explicitThreadRootNumber =
    options?.thread_root_message_id
      ? parseScopedId(options.thread_root_message_id, "msg")
      : null;

  // Lock before looking up a replay: a previous attempt may commit while a
  // concurrent Off update is ahead of us. Its saved message must still win.
  const expressionSetting = options?.gif
    ? (await tx.select({ enabled: room_settings.expressions_enabled }).from(room_settings)
      .where(eq(room_settings.room_id, roomId)).for("share"))[0]
    : null;
  if (clientMessageId) {
    const [existingMessage] = await tx
      .select(messageRowSelection)
      .from(messages)
      .where(and(eq(messages.room_id, roomId), eq(messages.client_message_id, clientMessageId)))
      .limit(1);

    if (existingMessage) {
      await assertDesktopReplayMatches(tx, existingMessage, sender, text, options);
      return { replay: await hydrateCreatedMessage(roomId, {
        messageRow: existingMessage,
        created: false,
        recipientAgentKeys: [],
        recipientAgentTargets: [],
      }, options, tx) };
    }
  }

  if (options?.gif) {
    if (!expressionSetting?.enabled) throw new RequestValidationError("expressions_disabled: GIF sending is disabled in this room. Send text instead.");
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
  return { replyToNumber, threadRootNumber };
}
