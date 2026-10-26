import { reactive, type InjectionKey } from "vue";
import type { DesktopNeedsYou } from "../../../../../../electron/ipc-types/knowledge";
import { roomReadKey } from "../../../../domain/desktop-room-read-state";

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
      const text = record.recommendation?.trim();
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
