import type { DesktopRoomMessage } from "../../../ipc-types.js";
import {
  mapRoomMessageAttachmentPayload,
  type RoomMessageAttachmentPayload,
} from "../../attachments/mappers.js";

export type RoomMessagePayload = {
  id: string;
  sender: string;
  text: string;
  attachments?: RoomMessageAttachmentPayload[] | null;
  agent_prompt_kind?: string | null;
  source?: string | null;
  timestamp: string;
  reply_to?: {
    id: string;
    sender: string;
    text: string;
    source?: string | null;
    timestamp: string;
  } | null;
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

export function mapRoomMessagePayload(
  message: RoomMessagePayload,
): DesktopRoomMessage {
  return {
    id: message.id,
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
