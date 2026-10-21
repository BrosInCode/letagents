/**
 * Work that follows the insert in the same transaction: blank auto prompts,
 * desktop push notifications and the caller's hook.
 */
import { and, eq, sql } from "drizzle-orm";
import { isPromptOnlyAgentMessage, type AgentPromptKind } from "../../../../shared/room-agent-prompts.js";
import { messages } from "../../schema.js";
import type { MessageRow } from "../../types.js";
import { enqueueDesktopPushNotifications } from "../../../notifications/enqueue.js";
import { recordTaskMentionsForMessage } from "../../task-external-refs.js";
import type { MessageCreateTransaction, AddMessageOptions } from "./types.js";

/**
 * Removes the sender's older blank auto prompts, enqueues desktop push
 * notifications, links ticket-key mentions to cards, and runs the caller's
 * in-transaction hook.
 */
export async function finishCreatedMessage(
  tx: MessageCreateTransaction,
  roomId: string,
  sender: string,
  options: AddMessageOptions | undefined,
  promptKind: AgentPromptKind | null,
  createdMessage: MessageRow,
) {
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

  const addressedTo = options?.addressed_to ?? null;
  let notificationEnqueueDurationMs = 0;
  if (!createdMessageIsPromptOnly && !addressedTo) {
    const notificationEnqueueStartedAtMs = Date.now();
    await enqueueDesktopPushNotifications(tx, createdMessage, {
      notify_account_ids: options?.notify_account_ids,
      recents_account_ids: options?.recents_account_ids,
    });
    notificationEnqueueDurationMs = Date.now() - notificationEnqueueStartedAtMs;
  }

  if (!createdMessageIsPromptOnly) {
    await recordTaskMentionsForMessage(tx, roomId, createdMessage);
  }

  if (options?.with_created_message_in_transaction) {
    await options.with_created_message_in_transaction(tx, createdMessage);
  }
  return { createdMessageIsPromptOnly, addressedTo, notificationEnqueueDurationMs };
}
