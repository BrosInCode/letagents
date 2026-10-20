/** Builds the acknowledgement for a created or replayed message inside its transaction. */
import { toMessageWithReply } from "../../mappers.js";
import { hydrateMessageReplies } from "../history.js";
import { getMessageAccountAgentRouting } from "../account-agent-routing.js";
import { getMessageThreadReadOverlays } from "../thread-read-overlays.js";
import type { MessageCreateTransaction, AddMessageOptions, AddMessageResult, AddMessageTransactionResult } from "./types.js";

// Build the complete acknowledgement before commit: a failed attachment,
// thread, or routing read must roll back the write rather than strand an
// unpublished message that idempotent retries can no longer publish.
export async function hydrateCreatedMessage(
  roomId: string,
  result: AddMessageTransactionResult,
  options: AddMessageOptions | undefined,
  tx: MessageCreateTransaction,
): Promise<AddMessageResult> {
  const [hydrated] = await hydrateMessageReplies(roomId, [result.messageRow], {
    accountId: null,
    executor: tx,
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
          }], [accountId], tx)
        : Promise.resolve(new Map()),
      options?.account_agent_routing
        ? getMessageAccountAgentRouting(tx, roomId, accountId, [result.messageRow])
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
  if (result.mentionNotices?.length) {
    // Copy rather than annotate: the canonical message is the shared event.
    message = { ...message, mention_notices: [...result.mentionNotices] };
  }
  return {
    message,
    canonical_message: canonicalMessage,
    created: result.created,
    recipientAgentKeys: result.recipientAgentKeys,
    recipientAgentTargets: result.recipientAgentTargets,
  };
}
