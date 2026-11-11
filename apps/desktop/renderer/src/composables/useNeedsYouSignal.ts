import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { DesktopNeedsYou } from '../../../electron/ipc-types/knowledge';
import type { AgentAttentionItem } from '../components/desktop/content/room-inbox/agent-attention';
import { createNeedsYouChime } from '../components/desktop/content/room-shell/roomSounds';
import { readSoundEnabled } from '../components/desktop/content/room-shell/preferences';
import { roomNotificationsMuted, roomNotificationState } from './useRoomNotificationPreferences';

/** Seeing a request clears its badge, without answering or dismissing it. */
export function useInboxUnread(items: Readonly<Ref<readonly { key: string; fingerprint: string; roomIdentifier: string | null }[]>>, options: {
  account(): string;
  /** null while Needs you is closed; [] shows every room. */
  inboxRooms(): readonly string[] | null;
}) {
  const seen = ref<Record<string, string>>({});
  const visible = ref(typeof document === 'undefined' || !document.hidden);
  const storageKey = () => `letagents-desktop:inbox-seen:${options.account()}`;
  watch(options.account, () => {
    seen.value = {};
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey()) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) seen.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch { /* Read state remains available for this session. */ }
  }, { immediate: true, flush: 'sync' });
  watch([items, options.inboxRooms, visible, options.account], ([requests, rooms, shown]) => {
    if (!shown || rooms === null) return;
    const next = { ...seen.value };
    let changed = false;
    for (const item of requests) {
      if (rooms.length && (!item.roomIdentifier || !rooms.includes(item.roomIdentifier))) continue;
      if (next[item.key] !== item.fingerprint) { next[item.key] = item.fingerprint; changed = true; }
    }
    if (!changed) return;
    seen.value = next;
    try { window.localStorage.setItem(storageKey(), JSON.stringify(next)); } catch { /* Storage is optional. */ }
  }, { immediate: true });
  const visibilityChanged = () => { visible.value = !document.hidden; };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged); });
  return computed(() => items.value.filter(item => seen.value[item.key] !== item.fingerprint).length);
}

/** Session-scoped acknowledgement survives room navigation and KeepAlive eviction. */
export function useNeedsYouSignal(data: Ref<DesktopNeedsYou | null>, agents: Readonly<Ref<readonly AgentAttentionItem[]>>, options: {
  account(): string;
  activeRoom(): string | null;
  /** null when Inbox is closed; [] means all rooms. */
  inboxRooms(): readonly string[] | null;
  /** The first requests read and the separate host-approval reads have settled. */
  ready(): boolean;
}, chime = createNeedsYouChime()) {
  const visible = ref(typeof document === 'undefined' || !document.hidden);
  const acknowledged = ref(new Set<string>());
  const observed = new Set<string>();
  const loadedRooms = new Set<string>();
  const requests = computed(() => [
    ...(data.value?.rooms ?? []).flatMap(room => room.records.filter(record => !record.response).map(record => ({
      room: room.roomIdentifier, key: JSON.stringify([room.roomIdentifier, 'request', record.id]),
    }))),
    ...agents.value.map(item => ({ room: item.roomIdentifier,
      // A recovered agent can get stuck again; that is a new attention episode.
      key: JSON.stringify([item.key, item.kind === 'agent_attention' ? item.timestamp : '']),
    })),
  ]);

  watch(options.account, () => {
    observed.clear(); loadedRooms.clear(); acknowledged.value = new Set(); chime.stop();
  }, { flush: 'sync' });

  watch([requests, options.inboxRooms, visible], ([items, inbox, isVisible]) => {
    const shown = (room: string) => isVisible && inbox !== null && (!inbox.length || inbox.includes(room));
    const activeRoom = options.activeRoom();
    let fresh = false;
    for (const item of items) {
      if (shown(item.room)) acknowledged.value.add(item.key);
      if (!observed.has(item.key) && loadedRooms.has(item.room) && item.room === activeRoom && !shown(item.room)) fresh = true;
      observed.add(item.key);
    }
    // The first successful read of each room is a silent baseline, including
    // rooms that failed during startup and only load later.
    for (const room of data.value?.rooms ?? []) loadedRooms.add(room.roomIdentifier);
    for (const item of agents.value) loadedRooms.add(item.roomIdentifier);
    if (!isVisible || inbox !== null) chime.stop();
    if (fresh && options.ready() && isVisible && activeRoom && readSoundEnabled() && !roomNotificationsMuted(activeRoom)) {
      const preference = roomNotificationState(activeRoom);
      if (!preference.loading || preference.ready) chime.play();
    }
  }, { immediate: true });

  // Leaving the room never queues a delayed sound for the next visit.
  watch(options.activeRoom, () => chime.stop());
  const visibilityChanged = () => { visible.value = !document.hidden; };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
  onScopeDispose(() => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
    chime.dispose();
  });

  return computed(() => {
    const items = requests.value.filter(item => item.room === options.activeRoom());
    return { count: items.length, pulse: visible.value && items.some(item => !acknowledged.value.has(item.key)) };
  });
}
