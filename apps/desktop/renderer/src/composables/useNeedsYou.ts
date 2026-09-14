import { computed, onBeforeUnmount, ref } from 'vue';
import type { DesktopNeedsYou } from '../../../electron/ipc-types/knowledge.js';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../ipc/index.js';

export function useNeedsYou() {
  const data = ref<DesktopNeedsYou | null>(null);
  const loading = ref(false);
  const error = ref('');
  let generation = 0;
  const count = computed(() => data.value?.rooms.reduce((sum, room) => sum + room.records.filter(record => !record.response).length + room.tasks.length, 0) ?? 0);
  async function refresh() {
    if (loading.value) return;
    const current = ++generation;
    loading.value = true;
    try {
      if (!desktopIpc.room?.getNeedsYou) throw new Error(desktopBridgeUpgradeMessage());
      const result = await desktopIpc.room.getNeedsYou();
      if (current === generation) { data.value = result; error.value = ''; }
    } catch (cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : 'Unable to load Needs you.'; }
    finally { if (current === generation) loading.value = false; }
  }
  function reset() { generation++; data.value = null; loading.value = false; error.value = ''; }
  onBeforeUnmount(reset);
  return { data, loading, error, count, refresh, reset };
}
