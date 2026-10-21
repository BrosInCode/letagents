/** The public surface of message creation. */
import { parseSupervisedReplySourceNumber } from "../../../../../shared/message-contracts.mjs";

export { chunkMessageReceiptRows } from "./receipt-rows.js";
export type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./types.js";
export { addMessageWithCreateStatus, addMessage } from "./add-message.js";

/**
 * Supervised daemon publications carry a reply-namespace idempotency id:
 *   supervised-room:<entry>:<source-message>:reply:v1
 *   supervised-room:<entry>:<room>:<source-message>:reply:v1
 * Only this exact shape identifies a reply target; arbitrary client ids never
 * influence receipt state.
 */
export { parseSupervisedReplySourceNumber };
