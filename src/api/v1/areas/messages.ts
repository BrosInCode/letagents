import { ApiError } from "../../../../shared/api/core.mjs";
import {
  getMessageThread,
  listRecentMessages,
  type MessageSender,
  type RoomMessage,
} from "../../../../shared/api/messages.mjs";
import { getLatestMessages, getMessageThread as readMessageThread, getMessagesBefore, type Message } from "../../db.js";
import { countSharedThreadReplies } from "../../db/messages/history/thread-summaries.js";
import { isAgentIdentityValue } from "../../rooms/participants.js";
import { defineRoute, type ApiRoute } from "../route.js";

// The same reads the room message routes make for a person in the app, with
// their default visibility: prompt-only messages (an agent's automatic turn
// with no text) stay out, and nothing account-scoped (desktop dispatch
// routing, unread marks) is read. Pages are a new kind of reader, so they get
// My work's stricter rental filter: only messages with no rental visibility
// or the rental's shared stream.
const VISIBILITY = { include_prompt_only: false, account_agent_routing: false, shared_only: true } as const;

// Routes for the methods in shared/api/messages.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listRecentMessages, async ({ before, limit }, { room }) => {
    const page = before
      ? await getMessagesBefore(room.id, before, { ...VISIBILITY, limit })
      : await getLatestMessages(room.id, { ...VISIBILITY, limit });
    const replyCounts = await sharedReplyCounts(room.id, page.messages);
    const messages = page.messages.map((message) => toRoomMessage(message, replyCounts)).reverse();
    return { messages, nextBefore: page.has_more ? messages.at(-1)?.id ?? null : null };
  }),
  defineRoute(getMessageThread, async ({ messageId, before, limit }, { room }) => {
    const thread = await readMessageThread(room.id, messageId, { ...VISIBILITY, before, limit });
    if (!thread) throw new ApiError("not_found", "No message with this id in this room.");
    const replyCounts = await sharedReplyCounts(room.id, [thread.root]);
    const replies = thread.replies.map((message) => toRoomMessage(message, replyCounts));
    return { root: toRoomMessage(thread.root, replyCounts), replies, nextBefore: thread.has_older ? replies[0]?.id ?? null : null };
  }),
];

/** Reply counts of the thread roots on a page, without replies this reader may not see. */
async function sharedReplyCounts(roomId: string, messages: readonly Message[]): Promise<Map<number, number>> {
  const roots = messages
    .filter((message) => message.thread_root_id === message.id && (message.thread?.reply_count ?? 0) > 0)
    .map((message) => Number(message.id.slice("msg_".length)));
  return countSharedThreadReplies(roomId, roots);
}

export function toRoomMessage(message: Message, replyCounts: ReadonlyMap<number, number>): RoomMessage {
  return {
    id: message.id,
    text: message.text,
    displayText: message.display_text ?? null,
    sender: toSender(message),
    createdAt: message.timestamp,
    threadRootId: message.thread_root_id !== message.id ? message.thread_root_id : null,
    replyToId: message.thread_reply_to_id,
    replyCount: message.thread_root_id === message.id ? replyCounts.get(Number(message.id.slice("msg_".length))) ?? 0 : 0,
    // Metadata only: a download needs the app's own attachment route.
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.filename,
      contentType: attachment.content_type,
      byteSize: attachment.byte_size,
    })),
  };
}

/**
 * Who wrote a message. The server writes `source` as `agent` for a worker's
 * post and `browser` for a person signed in to the app; integrations write
 * their own (`system`, `github`, ...). A message from before sources were
 * recorded is told apart by its sender: agents sign with a structured label.
 */
function toSender(message: Message): MessageSender {
  const source = message.source?.trim().toLowerCase() ?? "";
  const agent = Boolean(message.agent_identity) || source === "agent" || (!source && isAgentIdentityValue(message.sender));
  const kind = agent ? "agent" : source === "browser" || !source ? "person" : "system";
  return {
    name: message.sender,
    kind,
    login: kind === "person" ? message.sender_profile?.login ?? null : null,
    agentKey: message.agent_identity?.agent_key ?? null,
  };
}
