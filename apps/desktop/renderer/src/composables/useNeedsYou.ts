import { computed, onBeforeUnmount, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { DesktopAccountActivityState } from '../../../electron/ipc-types';
import type { DesktopAttentionRoom, DesktopNeedsYou } from '../../../electron/ipc-types/knowledge.js';
import type { DesktopRoomThreadInboxPage } from '../../../electron/ipc-types.js';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../ipc/index.js';
import { roomReadKey } from '../domain/desktop-room-read-state';

export function useNeedsYou() {
  const data = ref<DesktopNeedsYou | null>(null);
  const loading = ref(false);
  const error = ref('');
  let generation = 0;
  let queued = false;
  let queuedUpdates = false;
  // Each read is stamped when it starts; a room keeps the copy from the newest
  // read, so a slow full read never undoes a newer read of one room.
  let clock = 0;
  let resets = 0;
  const roomReadAt = new Map<string, number>();
  const roomReads = new Map<string, { again: boolean }>();
  const count = computed(() => data.value?.rooms.reduce((sum, room) => sum + room.records.filter(record => !record.response).length, 0) ?? 0);
  async function refresh(includeUpdates = false): Promise<void> {
    if (loading.value) { queued = true; queuedUpdates ||= includeUpdates; return; }
    const current = ++generation;
    const startedAt = ++clock;
    loading.value = true;
    try {
      if (!desktopIpc.room?.getNeedsYou) throw new Error(desktopBridgeUpgradeMessage());
      const [result, sessions] = await Promise.all([
        desktopIpc.room.getNeedsYou(includeUpdates),
        includeUpdates
          ? (desktopIpc.workers?.listManagedAgentSessions?.() ?? Promise.reject(new Error('Agent sessions unavailable')))
            .then(managedSessions => ({ managedSessions, managedSessionsUnavailable: false }))
            .catch(() => ({ managedSessions: [], managedSessionsUnavailable: true }))
          : Promise.resolve({}),
      ]);
      Object.assign(result, sessions);
      if (current === generation) {
        for (const room of result.rooms) {
          const newer = (roomReadAt.get(room.roomIdentifier) ?? 0) > startedAt
            ? data.value?.rooms.find(item => item.roomIdentifier === room.roomIdentifier) : undefined;
          if (newer) Object.assign(room, requestsOf(newer)); else roomReadAt.set(room.roomIdentifier, startedAt);
        }
        data.value = result; error.value = '';
      }
    } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : 'Unable to load Inbox.'; }
    finally {
      if (current === generation) {
        loading.value = false;
        if (queued) { const updates = queuedUpdates; queued = false; queuedUpdates = false; void refresh(updates); }
      }
    }
  }
  function mergeThreads(roomIdentifier: string, page: DesktopRoomThreadInboxPage) {
    const room = data.value?.rooms.find(room => room.roomIdentifier === roomIdentifier);
    if (room?.updates) room.updates.threads = mergeThreadInboxPages(room.updates.threads, page);
  }
  /**
   * Re-read one room's requests and board intents, by any of its identifiers,
   * when its activity shows a change. A read already running for the room runs
   * once more afterwards instead of in parallel.
   */
  async function refreshRoom(roomIdentifier: string): Promise<void> {
    const key = roomReadKey(roomIdentifier);
    const id = data.value?.rooms.find(room => roomReadKey(room.roomIdentifier) === key)?.roomIdentifier;
    if (!id) return;
    const running = roomReads.get(id);
    if (running) { running.again = true; return; }
    const read = { again: false };
    roomReads.set(id, read);
    try { await readRoom(id); }
    catch { /* The next full read reports a failing room. */ }
    finally {
      roomReads.delete(id);
      if (read.again) void refreshRoom(id);
    }
  }
  async function readRoom(roomIdentifier: string): Promise<void> {
    const room = data.value?.rooms.find(item => item.roomIdentifier === roomIdentifier);
    const read = desktopIpc.room?.getNeedsYouRoom;
    if (!room || !read) return;
    const epoch = resets;
    const startedAt = ++clock;
    // Board intents are read only where the full read found the account may decide them.
    const fresh = await read(roomIdentifier, room.boardIntents !== undefined);
    const current = data.value?.rooms.find(item => item.roomIdentifier === roomIdentifier);
    if (epoch !== resets || !current || (roomReadAt.get(roomIdentifier) ?? 0) > startedAt) return;
    Object.assign(current, requestsOf(fresh));
    roomReadAt.set(roomIdentifier, startedAt);
  }
  function reset() { generation++; resets++; roomReadAt.clear(); data.value = null; loading.value = false; error.value = ''; queued = false; queuedUpdates = false; }
  onBeforeUnmount(reset);
  return { data, loading, error, count, refresh, refreshRoom, reset, mergeThreads };
}

/** A busy room is re-read at most this often. */
export const NEEDS_YOU_ROOM_REFRESH_GAP_MS = 3_000;

/**
 * Needs you follows each room's own activity, the stream the sidebar and room
 * view use: a decision, an answer or a new request posts a message, and that
 * room's requests are read again within a few seconds instead of the next poll.
 * Like that poll, it pauses while the window is hidden and catches up on return.
 */
export function useNeedsYouRoomActivity(activity: Ref<DesktopAccountActivityState>, refreshRoom: (roomId: string) => Promise<void>,
  gapMs = NEEDS_YOU_ROOM_REFRESH_GAP_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastRead = new Map<string, number>();
  const missedWhileHidden = new Set<string>();
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  function schedule(roomId: string): void {
    if (timers.has(roomId)) return;
    const wait = Math.max(0, (lastRead.get(roomId) ?? -Infinity) + gapMs - Date.now());
    timers.set(roomId, setTimeout(() => {
      timers.delete(roomId);
      if (hidden()) { missedWhileHidden.add(roomId); return; }
      lastRead.set(roomId, Date.now());
      void refreshRoom(roomId);
    }, wait));
  }
  function catchUp(): void {
    if (hidden()) return;
    for (const roomId of missedWhileHidden) schedule(roomId);
    missedWhileHidden.clear();
  }
  watch(() => activity.value.rooms, (rooms, previous) => {
    for (const [key, room] of Object.entries(rooms)) {
      const before = previous?.[key];
      if (before && room.latestMessageId && before.latestMessageId !== room.latestMessageId) schedule(room.roomId);
    }
  });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', catchUp);
  onScopeDispose(() => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', catchUp);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });
}

/** The parts of a room that a single-room read replaces. */
function requestsOf(room: Pick<DesktopAttentionRoom, 'records' | 'truncated' | 'tasks' | 'boardIntents'>): Pick<DesktopAttentionRoom, 'records' | 'truncated' | 'tasks' | 'boardIntents'> {
  return { records: room.records, truncated: room.truncated, tasks: room.tasks, boardIntents: room.boardIntents };
}

export function mergeThreadInboxPages(current: DesktopRoomThreadInboxPage, next: DesktopRoomThreadInboxPage): DesktopRoomThreadInboxPage {
  const threads = new Map(current.threads.map(item => [item.root.id, item]));
  for (const item of next.threads) threads.set(item.root.id, item);
  return { threads: [...threads.values()], hasMore: next.hasMore, unreadThreadCount: next.unreadThreadCount };
}
