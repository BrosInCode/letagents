import { ref } from 'vue';
import type { DesktopNeedsYou } from '../../../electron/ipc-types/knowledge.js';
import { isLocalRoomIdentifier } from '../domain/room-urls';

const storageKeyFor = (account: string) => `letagents-desktop:inbox-rooms:${account}`;

/** The room filter chosen in Inbox, kept per account across visits. */
export function readInboxRoomFilter(account: string): string[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(storageKeyFor(account)) || '[]');
    return Array.isArray(saved) ? saved.filter((room): room is string => typeof room === 'string') : [];
  } catch { return []; }
}

export function rememberInboxRoomFilter(account: string, rooms: readonly string[]): void {
  try {
    if (rooms.length) window.localStorage.setItem(storageKeyFor(account), JSON.stringify(rooms));
    else window.localStorage.removeItem(storageKeyFor(account));
  } catch { /* The filter still applies for this visit. */ }
}

export function useInboxRoomFilter(account: () => string) {
  const rooms = ref<string[]>([]);
  /** A room's own "Needs you" chip scopes one visit; any other visit uses the saved choice. */
  function open(room?: string) { rooms.value = typeof room === 'string' ? [room] : readInboxRoomFilter(account()); }
  /** A choice made in Inbox is saved. */
  function choose(next: string[]) { rooms.value = next; rememberInboxRoomFilter(account(), next); }
  /** Another account keeps its own choice. */
  function reload() { rooms.value = readInboxRoomFilter(account()); }
  /** Once the full room list is known, forget rooms that are gone; local rooms are never in it. */
  function prune(data: DesktopNeedsYou | null) {
    if (!data || data.limited || data.cloudUnavailable) return;
    const known = new Set(data.rooms.map(room => room.roomIdentifier));
    const keep = (room: string) => known.has(room) || isLocalRoomIdentifier(room);
    const saved = readInboxRoomFilter(account());
    if (!saved.every(keep)) rememberInboxRoomFilter(account(), saved.filter(keep));
    if (!rooms.value.every(keep)) rooms.value = rooms.value.filter(keep);
  }
  return { rooms, open, choose, reload, prune };
}
