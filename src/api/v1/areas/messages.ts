import { ApiError } from "../../../../shared/api/core.mjs";
import {
  getMessageThread,
  listRecentMessages,
  type MessageSender,
  type RoomMessage,
} from "../../../../shared/api/messages.mjs";
import { getLatestMessages, getMessageThread as readMessageThread, getMessagesBefore, type Message } from "../../db.js";
import { isAgentIdentityValue } from "../../rooms/participants.js";
import { defineRoute, type ApiRoute } from "../route.js";

// The same reads the room message routes make for a person in the app, with
// their default visibility: prompt-only messages (an agent's automatic turn
// with no text) stay out, and nothing account-scoped (desktop dispatch
// routing, unread marks) is read.
const VISIBILITY = { include_prompt_only: false, account_agent_routing: false } as const;

// Routes for the methods in shared/api/messages.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listRecentMessages, async ({ before, limit }, { room }) => {
    const page = before
      ? await getMessagesBefore(room.id, before, { ...VISIBILITY, limit })
      : await getLatestMessages(room.id, { ...VISIBILITY, limit });
    const messages = page.messages.map(toRoomMessage).reverse();
    return { messages, nextBefore: page.has_more ? messages.at(-1)?.id ?? null : null };
  }),
  defineRoute(getMessageThread, async ({ messageId, before, limit }, { room }) => {
    const thread = await readMessageThread(room.id, messageId, { ...VISIBILITY, before, limit });
    if (!thread) throw new ApiError("not_found", "No message with this id in this room.");
    const replies = thread.replies.map(toRoomMessage);
    return { root: toRoomMessage(thread.root), replies, nextBefore: thread.has_older ? replies[0]?.id ?? null : null };
  }),
];

export function toRoomMessage(message: Message): RoomMessage {
  return {
    id: message.id,
    text: message.text,
    displayText: message.display_text ?? null,
    sender: toSender(message),
    createdAt: message.timestamp,
    threadRootId: message.thread_root_id !== message.id ? message.thread_root_id : null,
    replyToId: message.thread_reply_to_id,
    replyCount: message.thread_root_id === message.id ? message.thread?.reply_count ?? 0 : 0,
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
