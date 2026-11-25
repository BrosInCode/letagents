import { reactive, ref, watch, type InjectionKey, type Ref } from "vue";
import { desktopIpc } from "../../../../ipc/index.js";
import type { DesktopNeedsYou } from "../../../../../../electron/ipc-types/knowledge";
import { roomReadKey } from "../../../../domain/desktop-room-read-state";
import { attentionRecommendationReply } from "../../../../../../../../shared/room-knowledge.mjs";

export interface ComposerSuggestedReply {
  /** The attention record the suggestion answers. */
  recordId: string;
  /** Who asked, for screen readers only. */
  from: string;
  text: string;
}

/** Reads the suggested reply for a room; App provides it from the Needs you data. */
export const composerSuggestedReplyKey: InjectionKey<(roomIdentifier: string | null) => ComposerSuggestedReply | null> =
  Symbol("composerSuggestedReply");

/**
 * The newest open Needs you request in this room that an agent asked and that
 * carries a recommendation. Its recommendation is the suggested reply.
 */
export function roomSuggestedReply(data: DesktopNeedsYou | null | undefined, roomIdentifier: string | null): ComposerSuggestedReply | null {
  const key = roomReadKey(roomIdentifier);
  if (!data || !key) return null;
  let best: { record: DesktopNeedsYou["rooms"][number]["records"][number]; text: string } | null = null;
  for (const room of data.rooms) {
    if (roomReadKey(room.roomIdentifier) !== key) continue;
    for (const record of room.records) {
      const text = attentionRecommendationReply(record.recommendation);
      if (record.type !== "attention" || record.response || record.archived || record.author?.kind !== "agent" || !text) continue;
      if (!best || record.updated_at > best.record.updated_at) best = { record, text };
    }
  }
  return best ? { recordId: best.record.id, from: best.record.author.label, text: best.text } : null;
}

// A suggestion that was used or dismissed stays away for this app session,
// across room switches and composer remounts.
const settledSuggestions = reactive(new Set<string>());

export function suggestionSettled(recordId: string): boolean {
  return settledSuggestions.has(recordId);
}

export function settleSuggestion(recordId: string): void {
  settledSuggestions.add(recordId);
}

/** A short pause so a burst of new messages costs one request. */
const AGENT_SUGGESTION_DELAY_MS = 300;

/**
 * The reply an agent suggested for this room, read from the server whenever
 * the room's newest message changes. The server picks among the agents'
 * suggestions and answers null once the person has spoken after them.
 * Rooms kept on this computer have none.
 */
export function useAgentSuggestedReply(
  roomIdentifier: () => string | null,
  latestMessageId: () => string | null,
): Ref<ComposerSuggestedReply | null> {
  const suggestion = ref<ComposerSuggestedReply | null>(null);
  let version = 0;
  let shownRoom: string | null = null;
  watch(() => [roomIdentifier(), latestMessageId()] as const, async ([room, latest]) => {
    const current = ++version;
    // Another room's suggestion never shows here, not even for a moment.
    if (room !== shownRoom) {
      suggestion.value = null;
      shownRoom = room;
    }
    const read = desktopIpc.room?.getSuggestedReply;
    if (!room || !latest || typeof read !== "function") {
      suggestion.value = null;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, AGENT_SUGGESTION_DELAY_MS));
    if (current !== version) return;
    try {
      const next = await read(room);
      if (current !== version) return;
      suggestion.value = next ? { recordId: `message:${next.messageId}`, from: next.from, text: next.text } : null;
    } catch {
      if (current === version) suggestion.value = null;
    }
  }, { immediate: true });
  return suggestion;
}
