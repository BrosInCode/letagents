import {
  normalizeMessageReactionEmoji,
  normalizeMessageReactions,
  type MessageReaction,
} from "../../../../../shared/message-reactions.mjs";
import type { DesktopMessageReactionChange, DesktopMessageReactionsRange } from "../../ipc-types/api.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

const MESSAGE_ID = /^msg_[1-9]\d*$/;

async function messagesPath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Reactions require a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/messages`;
}

function requireMessageId(value: string): string {
  if (typeof value !== "string" || !MESSAGE_ID.test(value)) throw new Error("Choose a message first.");
  return value;
}

export async function getDesktopMessageReactions(
  identifier: string,
  firstMessageId: string,
  lastMessageId: string,
): Promise<DesktopMessageReactionsRange> {
  const query = new URLSearchParams({ first: requireMessageId(firstMessageId), last: requireMessageId(lastMessageId) });
  const response = await apiFetch<{
    reactions?: Record<string, unknown>;
    viewer_reactions?: Record<string, unknown>;
    next_first_message_id?: unknown;
  }>(`${await messagesPath(identifier)}/reactions?${query}`);
  const reactions: Record<string, MessageReaction[]> = {};
  for (const [messageId, value] of Object.entries(response.reactions ?? {})) {
    if (!MESSAGE_ID.test(messageId)) continue;
    const list = normalizeMessageReactions(value);
    if (list.length) reactions[messageId] = list;
  }
  const viewerReactions: Record<string, string[]> = {};
  for (const [messageId, value] of Object.entries(response.viewer_reactions ?? {})) {
    if (!MESSAGE_ID.test(messageId) || !Array.isArray(value)) continue;
    viewerReactions[messageId] = value
      .map(normalizeMessageReactionEmoji)
      .filter((emoji): emoji is string => emoji !== null);
  }
  const next = response.next_first_message_id;
  return {
    reactions,
    // Absent from a server that cannot say; the renderer then relies on the reactor list.
    ...(response.viewer_reactions ? { viewer_reactions: viewerReactions } : {}),
    next_first_message_id: typeof next === "string" && MESSAGE_ID.test(next) ? next : null,
  };
}

export async function setDesktopMessageReaction(
  identifier: string,
  messageId: string,
  emoji: string,
  reacted: boolean,
): Promise<DesktopMessageReactionChange> {
  const normalized = normalizeMessageReactionEmoji(emoji);
  if (!normalized) throw new Error("A reaction must be a single emoji.");
  if (typeof reacted !== "boolean") throw new Error("Choose whether to add or remove the reaction.");
  const response = await apiFetch<{ changed?: boolean; reactions?: unknown }>(
    `${await messagesPath(identifier)}/${requireMessageId(messageId)}/reactions/${encodeURIComponent(normalized)}`,
    { method: reacted ? "PUT" : "DELETE" },
  );
  return { changed: Boolean(response.changed), reactions: normalizeMessageReactions(response.reactions) };
}
