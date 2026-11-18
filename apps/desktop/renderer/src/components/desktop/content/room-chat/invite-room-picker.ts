import { computed, ref, watch, type Ref } from "vue";
import type { DesktopBotInviteRoom } from "../../../../../../electron/ipc-types";

/** With more rooms than this, a "Find a room" field shows above the list. */
export const INVITE_ROOM_SEARCH_AFTER = 6;

/**
 * What a room row says at its end. A count shows only when two or more people
 * are in the room (a room of one is the viewer alone); a member's invite asks
 * the room's admins.
 */
export function inviteRoomMeta(room: Pick<DesktopBotInviteRoom, "role" | "memberCount">): string {
  const people = room.memberCount !== null && room.memberCount >= 2 ? `${room.memberCount} people` : "";
  if (room.role === "admin") return people;
  return people ? `${people} · asks admin` : "asks admin";
}

/** A room name cut around its first match, so the matching part can be bold. */
export interface InviteRoomNamePart {
  text: string;
  match: boolean;
}

function matcherFor(query: string): RegExp | null {
  const needle = query.trim();
  return needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : null;
}

export function inviteRoomNameParts(name: string, query: string): InviteRoomNamePart[] {
  const found = matcherFor(query)?.exec(name);
  if (!found) return [{ text: name, match: false }];
  const end = found.index + found[0].length;
  return [
    { text: name.slice(0, found.index), match: false },
    { text: found[0], match: true },
    { text: name.slice(end), match: false },
  ].filter((part) => part.text);
}

/** Whether rows lie past the top or the bottom edge of a scrolled list; that edge then fades. */
export function inviteRoomListFades(list: { scrollTop: number; scrollHeight: number; clientHeight: number }): { above: boolean; below: boolean } {
  return {
    above: list.scrollTop > 1,
    below: list.scrollHeight - list.clientHeight - list.scrollTop > 1,
  };
}

/**
 * The room list's search: it filters by name as you type (case-insensitive),
 * and one row is active for the keys. ↑ and ↓ move the active row, ↵ picks it,
 * and Escape clears the text first; with no text, Escape is left to the panel,
 * which closes.
 */
export function useInviteRoomPicker(rooms: Ref<readonly DesktopBotInviteRoom[]>, onPick: (room: DesktopBotInviteRoom) => void) {
  const query = ref("");
  const active = ref(0);
  const searchable = computed(() => rooms.value.length > INVITE_ROOM_SEARCH_AFTER);
  const shown = computed(() => {
    const matcher = searchable.value ? matcherFor(query.value) : null;
    return matcher ? rooms.value.filter((room) => matcher.test(room.displayName)) : rooms.value;
  });

  // A new search starts at its first row; a shorter list keeps the active row inside it.
  watch(query, () => { active.value = 0; });
  watch(shown, (list) => { active.value = Math.min(active.value, Math.max(list.length - 1, 0)); });

  function setQuery(text: string): void {
    query.value = text;
  }

  function setActive(index: number): void {
    const count = shown.value.length;
    if (count) active.value = ((index % count) + count) % count;
  }

  function nameParts(name: string): InviteRoomNamePart[] {
    return inviteRoomNameParts(name, searchable.value ? query.value : "");
  }

  /** Keys in the search field. Returns true when the key was used. */
  function handleKey(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active.value + (event.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const room = shown.value[active.value];
      if (room) onPick(room);
      return true;
    }
    if (event.key === "Escape" && query.value) {
      // The first Escape clears the text; the next one closes the panel.
      event.preventDefault();
      event.stopPropagation();
      query.value = "";
      return true;
    }
    return false;
  }

  return { query, active, searchable, shown, setQuery, setActive, nameParts, handleKey };
}
