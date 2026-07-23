import type { DesktopRoomMessage } from "../../../ipc-types.js";
import {
  mapRoomMessageAttachmentPayload,
  type RoomMessageAttachmentPayload,
} from "../../attachments/mappers.js";

export type RoomMessageReplyPayload = {
  id: string;
  sender: string;
  text: string;
  source?: string | null;
  timestamp: string;
};

export type RoomMessagePayload = {
  id: string;
  client_message_id?: string | null;
  sender: string;
  text: string;
  attachments?: RoomMessageAttachmentPayload[] | null;
  agent_prompt_kind?: string | null;
  source?: string | null;
  timestamp: string;
  thread_root_id?: string | null;
  thread_reply_to_id?: string | null;
  thread?: RoomMessageThreadSummaryPayload | null;
  reply_to?: RoomMessageReplyPayload | null;
  agent_identity?: {
    name?: string | null;
    display_name?: string | null;
    owner_label?: string | null;
    owner_attribution?: string | null;
    ide_label?: string | null;
    actor_label?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
  } | null;
};

export type RoomMessageThreadSummaryPayload = {
  root_message_id?: string | null;
  reply_count?: number | null;
  unread_count?: number | null;
  has_unread?: boolean | null;
  latest_reply?: RoomMessageReplyPayload | null;
  participants?: Array<{
    sender?: string | null;
    source?: string | null;
    message_count?: number | null;
    latest_message_id?: string | null;
  }> | null;
  last_read_message_id?: string | null;
};

export function mapRoomMessagePayload(
  message: RoomMessagePayload,
): DesktopRoomMessage {
  return {
    id: message.id,
    clientMessageId: message.client_message_id?.trim() || null,
    sender: message.sender,
    text: message.text,
    attachments: (message.attachments || []).map(
      mapRoomMessageAttachmentPayload,
    ),
    agentPromptKind: message.agent_prompt_kind || null,
    source: message.source || null,
    timestamp: message.timestamp,
    actorLabel: message.agent_identity?.actor_label || null,
    agentIdentity: mapRoomMessageAgentIdentity(message.agent_identity || null),
    threadRootId:
      message.thread_root_id ||
      message.thread?.root_message_id ||
      message.id,
    threadReplyToId: message.thread_reply_to_id || message.reply_to?.id || null,
    thread: mapRoomMessageThreadSummary(message.thread),
    replyTo: message.reply_to
      ? {
          id: message.reply_to.id,
          sender: message.reply_to.sender,
          text: message.reply_to.text,
          source: message.reply_to.source || null,
          timestamp: message.reply_to.timestamp,
        }
      : null,
  };
}

export function mapRoomMessageThreadSummary(
  thread: RoomMessageThreadSummaryPayload,
): NonNullable<DesktopRoomMessage["thread"]>;
export function mapRoomMessageThreadSummary(
  thread?: RoomMessageThreadSummaryPayload | null,
): DesktopRoomMessage["thread"];
export function mapRoomMessageThreadSummary(
  thread?: RoomMessageThreadSummaryPayload | null,
): DesktopRoomMessage["thread"] {
  if (!thread) return null;
  const unreadCount = Number(thread.unread_count || 0);
  const latestReply = thread.latest_reply
    ? {
        id: thread.latest_reply.id,
        sender: thread.latest_reply.sender,
        text: thread.latest_reply.text,
        source: thread.latest_reply.source || null,
        timestamp: thread.latest_reply.timestamp,
      }
    : null;
  return {
    rootMessageId: thread.root_message_id || "",
    replyCount: Number(thread.reply_count || 0),
    unreadCount,
    hasUnread: Boolean(thread.has_unread) || unreadCount > 0,
    latestReply,
    participants: (thread.participants || [])
      .map((participant) => ({
        sender: participant.sender || "",
        source: participant.source || null,
        messageCount: Number(participant.message_count || 0),
        latestMessageId: participant.latest_message_id || "",
      }))
      .filter((participant) => participant.sender && participant.latestMessageId),
    lastReadMessageId: thread.last_read_message_id || null,
  };
}

function mapRoomMessageAgentIdentity(
  identity: RoomMessagePayload["agent_identity"] | null,
): DesktopRoomMessage["agentIdentity"] {
  if (!identity) return null;
  return {
    name: identity.name || null,
    displayName: identity.display_name || null,
    ownerLabel: identity.owner_label || null,
    ownerAttribution: identity.owner_attribution || null,
    ideLabel: identity.ide_label || null,
    actorLabel: identity.actor_label || null,
    agentKey: identity.agent_key || null,
    agentSessionId: identity.agent_session_id || null,
  };
}
