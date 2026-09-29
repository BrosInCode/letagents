import { computed, onBeforeUnmount, ref } from 'vue';
import type { DesktopNeedsYou } from '../../../electron/ipc-types/knowledge.js';
import type { DesktopRoomThreadInboxPage } from '../../../electron/ipc-types.js';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../ipc/index.js';

export function useNeedsYou() {
  const data = ref<DesktopNeedsYou | null>(null);
  const loading = ref(false);
  const error = ref('');
  let generation = 0;
  let queued = false;
  let queuedUpdates = false;
  const count = computed(() => data.value?.rooms.reduce((sum, room) => sum + room.records.filter(record => !record.response).length, 0) ?? 0);
  async function refresh(includeUpdates = false): Promise<void> {
    if (loading.value) { queued = true; queuedUpdates ||= includeUpdates; return; }
    const current = ++generation;
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
      if (current === generation) { data.value = result; error.value = ''; }
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
  function reset() { generation++; data.value = null; loading.value = false; error.value = ''; queued = false; queuedUpdates = false; }
  onBeforeUnmount(reset);
  return { data, loading, error, count, refresh, reset, mergeThreads };
}

export function mergeThreadInboxPages(current: DesktopRoomThreadInboxPage, next: DesktopRoomThreadInboxPage): DesktopRoomThreadInboxPage {
  const threads = new Map(current.threads.map(item => [item.root.id, item]));
  for (const item of next.threads) threads.set(item.root.id, item);
  return { threads: [...threads.values()], hasMore: next.hasMore, unreadThreadCount: next.unreadThreadCount };
}
