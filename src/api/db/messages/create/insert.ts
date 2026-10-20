/** Builds the message row and inserts it, resolving a concurrent idempotent insert to a replay. */
import { and, eq } from "drizzle-orm";
import type { AgentPromptKind } from "../../../../shared/room-agent-prompts.js";
import { WAKE_NOTICE_SOURCE } from "../../../../../shared/wake-rules.mjs";
import { messages } from "../../schema.js";
import type { MessageRow } from "../../types.js";
import { nextRoomScopedNumber } from "../../utils.js";
import { messageRowSelection } from "../selections.js";
import type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./types.js";
import { hydrateCreatedMessage } from "./hydrate.js";
import { assertDesktopReplayMatches } from "./validation.js";

/** System notices keep a separate line written for people. */
function retainsDisplayText(source: string | undefined): boolean {
  return source === "system" || source === WAKE_NOTICE_SOURCE;
}

/** Inserts the new message row. A lost idempotency race returns the winner's replay. */
export async function insertMessageRow(
  tx: MessageCreateTransaction,
  roomId: string,
  sender: string,
  text: string,
  options: AddMessageOptions | undefined,
  promptKind: AgentPromptKind | null,
  clientMessageId: string | null,
  replyToNumber: number | null,
  threadRootNumber: number | null,
): Promise<{ replay: AddMessageResult } | { createdMessage: MessageRow }> {
  const message: MessageRow = {
    room_id: roomId,
    number: await nextRoomScopedNumber("messages", roomId, tx),
    reply_to_number: replyToNumber,
    thread_root_number: threadRootNumber,
    sender,
    text,
    gif: options?.gif ?? null,
    display_text: retainsDisplayText(options?.source) ? options?.display_text?.trim() || null : null,
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
      await assertDesktopReplayMatches(tx, existingMessage, sender, text, options);
      return { replay: await hydrateCreatedMessage(roomId, {
        messageRow: existingMessage,
        created: false,
        recipientAgentKeys: [],
        recipientAgentTargets: [],
      }, options, tx) };
    }
    createdMessage = insertedMessage;
  } else {
    await tx.insert(messages).values(message);
  }
  return { createdMessage };
}
