import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { boardTaskPlanning, type BoardPlanningDocument, type BoardPlanningSnapshot } from '../../board-planning.mjs';
import type { BoardServices, BoardTask } from './types';

export function useBoardWorkspace(props: { roomId: string; tasks: readonly BoardTask[]; services: BoardServices }) {
  const snapshot = ref<BoardPlanningSnapshot | null>(null), loading = ref(false), saving = ref(false), error = ref('');
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let iterationTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPending = false;
  async function readPlanning(background = false): Promise<boolean> {
    if (saving.value) return false;
    const request = ++generation;
    if (!background) { loading.value = true; error.value = ''; }
    try {
      const result = await props.services.loadPlanning();
      if (request !== generation) return false;
      snapshot.value = result;
      return true;
    } catch (reason) {
      if (request === generation) error.value = reason instanceof Error ? reason.message : 'Board could not be loaded. Try again.';
      return false;
    } finally { if (request === generation) loading.value = false; }
  }
  function load() { return readPlanning(); }
  async function save(document: BoardPlanningDocument): Promise<boolean> {
    if (!snapshot.value?.canEdit || saving.value || loading.value) return false;
    const request = ++generation, room = props.roomId;
    saving.value = true; error.value = '';
    try {
      const result = await props.services.savePlanning(snapshot.value.revision, document);
      if (request !== generation || room !== props.roomId) return false;
      snapshot.value = result;
      return true;
    } catch (reason) {
      if (request === generation) error.value = reason instanceof Error ? reason.message : 'Changes could not be saved. Try again.';
      return false;
    } finally { if (request === generation) saving.value = false; }
  }
  // Facts include completed work and off-screen tasks. Prefer the host's freshest task state.
  const allTasks = computed<BoardTask[]>(() => {
    const tasks = new Map(props.tasks.map(task => [task.id, task]));
    const result = (snapshot.value?.taskFacts || []).map(fact => {
      const task = tasks.get(fact.id);
      tasks.delete(fact.id);
      const ticket = fact.externalRef ? /^([^:]+):(.+)$/.exec(fact.externalRef) : null;
      const prNumber = fact.prUrl ? /\/pull\/(\d+)/.exec(fact.prUrl) : null;
      return {
        id: fact.id, title: fact.title, status: fact.status, assigneeLabel: fact.assignee?.split('|')[0].trim() || null,
        assigneeKey: fact.assigneeAgentKey, updatedAt: fact.updatedAt,
        pr: fact.prUrl ? { url: fact.prUrl, number: prNumber ? Number(prNumber[1]) : null } : null,
        allowedTransitions: [], ...task,
        ticket: task?.ticket ? { ...task.ticket, url: task.ticket.url || fact.ticketUrl } : ticket ? { provider: ticket[1], key: ticket[2], url: fact.ticketUrl } : null,
        provider: task?.provider || fact.provider,
        ...(task && Date.parse(fact.updatedAt) > Date.parse(task.updatedAt) ? {
          title: fact.title, status: fact.status, assigneeLabel: fact.assignee?.split('|')[0].trim() || null,
          assigneeKey: fact.assigneeAgentKey, provider: fact.provider, updatedAt: fact.updatedAt, allowedTransitions: [],
        } : {}),
      } as BoardTask;
    });
    return [...result, ...tasks.values()];
  });
  const sprints = computed(() => [...(snapshot.value?.document.sprints || []), ...(snapshot.value?.imported.sprints || [])]);
  function planning(taskId: string) { return snapshot.value ? boardTaskPlanning(snapshot.value, taskId) : {}; }
  function copyDocument(): BoardPlanningDocument { return JSON.parse(JSON.stringify(snapshot.value!.document)); }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!refreshPending || saving.value || loading.value) return;
      refreshPending = false;
      void readPlanning(true);
    }, 350);
  }
  watch(() => props.tasks.map(task => `${task.id}:${task.updatedAt}:${task.status}`).join('|'), () => {
    refreshPending = true; scheduleRefresh();
  });
  watch([saving, loading], () => { if (refreshPending) scheduleRefresh(); });
  watch(() => props.roomId, () => { clearTimeout(refreshTimer); refreshPending = false; snapshot.value = null; saving.value = false; void load(); }, { immediate: true });
  function refreshIterations() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!snapshot.value || saving.value || loading.value) return;
    void readPlanning(true);
  }
  onMounted(() => {
    iterationTimer = setInterval(refreshIterations, 60_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refreshIterations);
  });
  onBeforeUnmount(() => {
    generation += 1; clearTimeout(refreshTimer); clearInterval(iterationTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refreshIterations);
  });
  return { snapshot, loading, saving, error, load, save, allTasks, sprints, planning, copyDocument };
}
