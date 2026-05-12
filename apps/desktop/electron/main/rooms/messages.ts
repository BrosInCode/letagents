import type {
  DesktopRoomMessage,
  DesktopRoomMessagesPage,
  DesktopSendRoomMessageResult,
} from "../../ipc-types.js";
import { apiFetch, readStoredAuth } from "../auth.js";
import { mapRoomMessageAttachmentPayload } from "../attachments.js";
import { roomMessageHistoryPageSize } from "../paths.js";

export function mapRoomMessagePayload(message: {
  id: string;
  sender: string;
  text: string;
  attachments?: Array<{
    id?: string | null;
    name?: string | null;
    file_name?: string | null;
    filename?: string | null;
    mime_type?: string | null;
    content_type?: string | null;
    size_bytes?: number | null;
    byte_size?: number | null;
    url?: string | null;
    download_url?: string | null;
    data_url?: string | null;
    content_base64?: string | null;
  }> | null;
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
  } | null;
}): DesktopRoomMessage {
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
  identity: {
    name?: string | null;
    display_name?: string | null;
    owner_label?: string | null;
    owner_attribution?: string | null;
    ide_label?: string | null;
    actor_label?: string | null;
  } | null,
): DesktopRoomMessage["agentIdentity"] {
  if (!identity) return null;
  return {
    name: identity.name || null,
    displayName: identity.display_name || null,
    ownerLabel: identity.owner_label || null,
    ownerAttribution: identity.owner_attribution || null,
    ideLabel: identity.ide_label || null,
    actorLabel: identity.actor_label || null,
  };
}

export async function sendDesktopRoomMessage(
  roomIdentifier: string,
  text: string,
  replyTo?: string | null,
  attachments: Array<{ upload_id: string }> = [],
): Promise<DesktopSendRoomMessageResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedText = text.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before sending a message.");
  }
  if (!trimmedText && attachments.length === 0) {
    throw new Error("Write a message before sending.");
  }

  const storedAuth = await readStoredAuth();
  const sender =
    storedAuth.account?.displayName || storedAuth.account?.login || "Desktop";
  const message = await apiFetch<{
    id: string;
    sender: string;
    text: string;
    attachments?:
      | Parameters<typeof mapRoomMessageAttachmentPayload>[0][]
      | null;
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
    } | null;
  }>(`/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LetAgents-Desktop-Client": "1",
    },
    body: JSON.stringify({
      sender,
      text: trimmedText,
      reply_to: replyTo || null,
      attachments,
    }),
  });

  return {
    message: mapRoomMessagePayload(message),
  };
}

export async function getDesktopRoomMessagesBefore(
  roomIdentifier: string,
  beforeMessageId: string,
  limit = roomMessageHistoryPageSize,
): Promise<DesktopRoomMessagesPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedBeforeMessageId = beforeMessageId.trim();
  if (!trimmedRoomIdentifier || !trimmedBeforeMessageId) {
    return { messages: [], hasOlder: false };
  }

  const page = await apiFetch<{
    messages?: Parameters<typeof mapRoomMessagePayload>[0][];
    has_older?: boolean;
    has_more?: boolean;
  }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages?limit=${encodeURIComponent(String(limit))}&before=${encodeURIComponent(trimmedBeforeMessageId)}`,
  );

  return {
    messages: [...(page.messages || [])]
      .sort(
        (left, right) =>
          Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""),
      )
      .map(mapRoomMessagePayload),
    hasOlder: Boolean(page.has_older ?? page.has_more),
  };
}
