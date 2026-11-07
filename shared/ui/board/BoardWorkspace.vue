<template>
  <section ref="surface" class="board-workspace" :data-instant="keyboard" aria-label="Board" data-testid="board-workspace" @keydown="keyboard = true" @pointerdown="keyboard = false">
    <div class="board-view-row">
      <nav class="board-view-tabs" aria-label="Board view">
        <button v-for="item in views" :key="item.id" type="button" :aria-current="view === item.id ? 'page' : undefined" @click="changeView(item.id)">{{ item.label }}</button>
      </nav>
      <div class="board-heading-actions">
        <FilterDropdown v-model="sprintId" class="board-sprint-picker" label="Sprint" :options="sprintOptions" :disabled="!snapshot || loading" searchable search-placeholder="Find a sprint…"><template #icon><BoardIcon name="calendar" /></template><template #option="{ option }"><span class="work-option-label">{{ option.label }}<small v-if="sprints.find(sprint => sprint.id === option.id)">{{ sprintState(sprints.find(sprint => sprint.id === option.id)!) }}</small></span></template></FilterDropdown>
        <BoardOptionsMenu label="Board options" icon="settings"><template #default="{ close }">
          <button type="button" :disabled="!snapshot || loading || saving" @click="close(); openSettings('Columns')"><BoardIcon name="settings" />Board settings</button>
          <button type="button" :disabled="loading || saving" @click="close(); refresh()"><BoardIcon name="refresh" />Refresh board</button>
          <div v-if="$slots.actions" class="board-secondary-actions" @click="close(false)"><slot name="actions" /></div>
        </template></BoardOptionsMenu>
        <button type="button" class="board-button board-primary" :disabled="busy || saving" @click="emit('create')"><BoardIcon name="plus" />New task</button>
      </div>
    </div>
    <div class="board-workspace-toolbar">
      <label class="board-search"><BoardIcon name="search" /><input v-model="query" type="search" placeholder="Search tasks or PRs…" aria-label="Search tasks" /></label>
      <FilterDropdown v-model="ownerFilter" label="Assignee" :options="ownerOptions" searchable search-placeholder="Find an assignee…"><template #icon><BoardIcon name="user" /></template><template #option="{ option }"><ChatAvatar v-if="owners.get(option.id)?.key" :name="owners.get(option.id)!.name" :provider="owners.get(option.id)!.provider" :agent="owners.get(option.id)!.agent" :agent-key="option.id" :avatar-url="owners.get(option.id)!.avatarUrl" /><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
      <FilterDropdown v-model="typeFilter" label="Task type" :options="typeOptions"><template #option="{ option }"><BoardIcon v-if="option.id" :name="option.id" /><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
      <button type="button" class="board-filter-chip" :aria-pressed="blockedOnly" @click="blockedOnly = !blockedOnly"><span class="board-lane-dot" data-tone="amber" />Blocked</button>
      <button v-if="filtersActive" type="button" class="board-text-button" @click="clearFilters">Clear</button>
      <button v-if="selectedSprint" type="button" class="board-sprint-details board-text-button" :aria-label="`Sprint details: ${selectedSprint.name}`" @click="sprintDetails?.showModal()"><span>{{ sprintState(selectedSprint) }}</span><span>{{ sprintDates(selectedSprint) }}</span><BoardIcon name="right" /></button>
      <button v-if="view === 'board' && snapshot?.canEdit" type="button" class="board-column-add-button board-text-button" :disabled="locked" @click="openSettings('Columns', true)"><BoardIcon name="plus" />Column</button>
    </div>
    <p class="board-sr-only" role="status" aria-live="polite">{{ announcement || (loading ? 'Loading board…' : '') }}</p>
    <div v-if="error || actionError || props.error" class="board-error" role="alert">{{ actionError || error || props.error }} <button v-if="error" type="button" class="board-text-button" :disabled="saving || loading" @click="load">Try again</button></div>
    <div v-if="!snapshot" class="board-empty">{{ loading ? 'Loading board…' : 'The board is unavailable.' }}</div>
    <template v-else>
      <div v-if="view === 'board'" class="board-lanes" :style="{ gridTemplateColumns: columnTracks }" tabindex="0" aria-label="Task columns">
        <section v-for="(column, index) in snapshot.document.columns" :key="column.id" class="board-lane" :class="{ 'is-collapsed': collapsed.has(column.id), 'is-drag-over': dragOver === column.id }" :data-column="column.id"
          @dragover="dragOverColumn($event, column)" @dragleave.self="dragOver = null" @drop.prevent="dropColumn(column)">
          <button v-if="collapsed.has(column.id)" type="button" class="board-column-rail" :aria-label="`Expand ${column.name} column, ${byColumn(column.id).length} tasks`" :aria-controls="`${prefix}-${column.id}`" :aria-expanded="false" @click="toggleColumn(column.id)" @keydown="columnKey($event, index)"><span class="board-lane-dot" :data-tone="columnTone(column.statuses)" /><span class="board-rail-name">{{ column.name }}</span><span>{{ byColumn(column.id).length }}</span><BoardIcon name="expand" /></button>
          <div v-show="!collapsed.has(column.id)" :id="`${prefix}-${column.id}`" class="board-column-expanded" :inert="collapsed.has(column.id)">
            <header class="board-lane-heading" :draggable="snapshot.canEdit && !locked" @dragstart="startColumnDrag($event, column.id)" @dragend="endDrag">
              <span class="board-lane-dot" :data-tone="columnTone(column.statuses)" /><h2>{{ column.name }}</h2><span class="board-lane-count">{{ byColumn(column.id).length }}</span>
              <button class="board-icon-button board-column-collapse" type="button" :aria-label="`Collapse ${column.name} column`" :aria-expanded="true" :aria-controls="`${prefix}-${column.id}`" @click="toggleColumn(column.id)" @keydown="columnKey($event, index)"><BoardIcon name="collapse" /></button>
              <button class="board-icon-button" type="button" :aria-label="`Settings for ${column.name}`" :disabled="locked || !snapshot.canEdit" @click="openSettings('Columns')"><BoardIcon name="settings" /></button>
            </header>
            <div class="board-lane-cards">
              <BoardCard v-for="task in byColumn(column.id)" :key="task.id" :task="task" :points="planning(task.id).estimate" :type="planning(task.id).type" :draggable="!locked && (snapshot.canEdit || task.allowedTransitions.length > 0)"
                @select="emit('select', task.id)" @external="openExternal" @dragstart="startTaskDrag($event, task.id)" @dragend="endDrag">
                <template #actions><details class="board-card-actions" @toggle="closeOtherActions($event)"><summary :aria-label="`Actions for ${task.title}`">•••</summary><div class="board-card-action-menu"><button type="button" @click="openPlan(task.id, $event)">Sprint &amp; estimate</button><button v-for="action in task.allowedTransitions" :key="action.id" type="button" :disabled="locked" @click="runTransition(task, action.id, $event)">{{ action.label }}</button></div></details></template>
              </BoardCard>
              <p v-if="!byColumn(column.id).length" class="board-lane-empty">{{ filtersActive ? 'No matching tasks' : 'No tasks' }}</p>
            </div>
          </div>
        </section>
      </div>
      <BoardAssignees v-else-if="view === 'assignees'" :tasks="sprintTasks" :visible="visibleTasks" :snapshot="snapshot" :sprint="selectedSprint" @select="emit('select', $event)" @external="openExternal" @target="openSettings('Sprints')" />
      <div v-else class="board-backlog">
        <p v-if="!backlogTasks.length" class="board-empty">{{ view === 'cancelled' ? 'No matching cancelled tasks.' : 'No proposed tasks.' }}</p>
        <div v-for="task in backlogTasks" :key="task.id" class="board-backlog-row"><BoardIcon :name="planning(task.id).type || 'task'" /><button class="board-backlog-title" type="button" @click="emit('select', task.id)"><strong>{{ task.title }}</strong><small>{{ task.ticket?.key || task.id.replace(/^task_/, 'T') }}</small></button><a v-if="safeWorkUrl(task.pr?.url || null)" class="board-pr" :href="task.pr!.url" @click.prevent="openExternal(task.pr!.url)"><BoardIcon name="pr" />{{ task.pr!.number ? '#' + task.pr!.number : 'PR' }}</a><button class="board-button" type="button" @click="openPlan(task.id, $event)">Plan</button><button v-if="task.allowedTransitions.some(a => a.targetStatus === 'accepted')" class="board-button" type="button" :disabled="locked" @click="runTransition(task, task.allowedTransitions.find(a => a.targetStatus === 'accepted')!.id, $event)">Accept</button></div>
      </div>
      <BoardSettings :open="settingsOpen" :initial-tab="settingsTab" :start-adding="settingsAdd" :snapshot="snapshot" :save="save" @close="settingsOpen = false" />
      <dialog ref="sprintDetails" class="board-dialog board-sprint-detail-dialog" aria-labelledby="board-sprint-detail-title" @click="sprintBackdrop" @cancel="sprintDetails?.close()">
        <header class="board-dialog-header"><h2 id="board-sprint-detail-title">{{ selectedSprint?.name }}</h2><button class="board-icon-button" type="button" aria-label="Close sprint details" @click="sprintDetails?.close()"><BoardIcon name="close" /></button></header>
        <div v-if="selectedSprint" class="board-dialog-body board-sprint-detail-body"><span class="board-sprint-state">{{ sprintState(selectedSprint) }}</span><p>{{ sprintDates(selectedSprint) }}</p><p v-if="selectedSprint.goal">{{ selectedSprint.goal }}</p><p v-if="selectedSprint.source" class="board-settings-hint">{{ selectedSprint.source.provider === 'jira' ? 'Jira' : 'Linear' }} · imported tasks in this room</p><button class="board-button" type="button" @click="sprintDetails?.close(); openSettings('Sprints')">Sprint settings</button></div>
      </dialog>
      <dialog ref="planDialog" class="board-dialog board-task-plan-dialog" aria-labelledby="board-plan-title" @close="planTaskId = null">
        <header class="board-dialog-header"><h2 id="board-plan-title">Sprint &amp; estimate</h2><button class="board-icon-button" type="button" aria-label="Close task planning" @click="planDialog?.close()"><BoardIcon name="close" /></button></header>
        <div class="board-dialog-body"><h3>{{ allTasks.find(t => t.id === planTaskId)?.title }}</h3><BoardTaskPlanning v-if="planTaskId" :key="planTaskId" :task-id="planTaskId" :snapshot="snapshot" :save="save" /></div>
      </dialog>
      <p v-if="selectedSprint?.source" class="board-import-scope">{{ selectedSprint.source.provider === 'jira' ? 'Jira' : 'Linear' }} sprint · imported tasks in this room</p>
    </template>
    <slot :snapshot="snapshot" :save-planning="save" />
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { boardTaskColumn, type BoardSprint, type BoardColumn, type BoardTaskPlanning as BoardTaskPlanningFields } from '../../board-planning.mjs';
import FilterDropdown from '../FilterDropdown.vue';
import ChatAvatar from '../ChatAvatar.vue';
import { safeWorkUrl } from '../my-work/model';
import BoardCard from './BoardCard.vue';
import BoardIcon from './BoardIcon.vue';
import BoardAssignees from './BoardAssignees.vue';
import BoardSettings from './BoardSettings.vue';
import BoardOptionsMenu from './BoardOptionsMenu.vue';
import BoardTaskPlanning from './BoardTaskPlanning.vue';
import { columnTone, matchesSprint, replaceBoardColumns, sprintDates, taskOwner, taskIsBlocked } from './model';
import { useBoardWorkspace } from './useBoardWorkspace';
import type { BoardServices, BoardTask } from './types';
import './board.css';

const props = defineProps<{ roomId: string; tasks: readonly BoardTask[]; services: BoardServices; busy?: boolean; error?: string | null }>();
const emit = defineEmits<{ select: [id: string]; create: []; refresh: [] }>();
const { snapshot, loading, saving, error, load, save, allTasks, sprints, planning, copyDocument } = useBoardWorkspace(props);
const surface = ref<HTMLElement>(), view = ref('board'), sprintId = ref('all'), query = ref(''), ownerFilter = ref(''), typeFilter = ref(''), blockedOnly = ref(false), keyboard = ref(false);
const settingsAdd = ref(false), sprintDetails = ref<HTMLDialogElement>();
const settingsOpen = ref(false), settingsTab = ref('Columns'), actionError = ref(''), announcement = ref(''), moving = ref(false);
const planTaskId = ref<string | null>(null), planDialog = ref<HTMLDialogElement>();
const collapsed = ref(new Set<string>()), draggedTask = ref<string | null>(null), draggedColumn = ref<string | null>(null), dragOver = ref<string | null>(null);
const prefix = `board-${useId()}`;
const views = computed(() => [{ id: 'board', label: 'Board', icon: 'board' }, { id: 'assignees', label: 'By assignee', icon: 'people' }, { id: 'backlog', label: 'Backlog', icon: 'list' }, ...(allTasks.value.some(t => t.status === 'cancelled') ? [{ id: 'cancelled', label: 'Cancelled', icon: 'list' }] : [])]);
const typeOptions = [{ id: '', label: 'All types' }, { id: 'task', label: 'Task' }, { id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }];
const locked = computed(() => Boolean(props.busy || saving.value || loading.value || moving.value));
const selectedSprint = computed(() => sprints.value.find(sprint => sprint.id === sprintId.value));
defineExpose({ snapshot, savePlanning: save, refresh: load, revealTask, selectedSprintId: sprintId, applyCreatedPlanning });
const sprintOptions = computed(() => [{ id: 'all', label: 'All work' }, ...sprints.value.map(sprint => ({ id: sprint.id, label: sprint.name })), { id: 'none', label: 'No sprint' }]);
const sprintTasks = computed(() => snapshot.value ? allTasks.value.filter(task => task.status !== 'cancelled' && matchesSprint(task, snapshot.value!, sprintId.value)) : []);
const owners = computed(() => new Map(allTasks.value.map(task => { const owner = snapshot.value ? taskOwner(task, snapshot.value) : { key: '', name: 'Unassigned', provider: null, agent: false, avatarUrl: null }; return [owner.key, owner] as const; })));
const ownerOptions = computed(() => [{ id: '', label: 'Everyone' }, { id: '__unassigned', label: 'Unassigned' }, ...[...owners.value.values()].filter(owner => owner.key).sort((a, b) => a.name.localeCompare(b.name)).map(owner => ({ id: owner.key, label: owner.name }))]);
const filtersActive = computed(() => Boolean(query.value || ownerFilter.value || typeFilter.value || blockedOnly.value));
function matchesFilters(task: BoardTask) {
  const owner = snapshot.value ? taskOwner(task, snapshot.value) : { key: '', name: '' };
  return (!query.value.trim() || [task.title, task.id, task.ticket?.key, task.pr?.number, owner.name].join(' ').toLowerCase().includes(query.value.trim().toLowerCase()))
    && (!ownerFilter.value || (ownerFilter.value === '__unassigned' ? !owner.key : owner.key === ownerFilter.value))
    && (!typeFilter.value || (planning(task.id).type || 'task') === typeFilter.value) && (!blockedOnly.value || (snapshot.value && taskIsBlocked(task, snapshot.value)));
}
const visibleTasks = computed(() => sprintTasks.value.filter(matchesFilters));
const backlogTasks = computed(() => view.value === 'cancelled'
  ? allTasks.value.filter(task => task.status === 'cancelled' && snapshot.value && matchesSprint(task, snapshot.value, sprintId.value) && matchesFilters(task))
  : visibleTasks.value.filter(task => task.status === 'proposed'));
const columnTracks = computed(() => (snapshot.value?.document.columns.map(column => collapsed.value.has(column.id) ? '52px' : 'minmax(var(--board-column-min), 1fr)') || []).join(' '));
function byColumn(id: string) { return snapshot.value ? visibleTasks.value.filter(task => boardTaskColumn(snapshot.value!.document, task) === id) : []; }
function clearFilters() { query.value = ''; ownerFilter.value = ''; typeFilter.value = ''; blockedOnly.value = false; }
function preferences() { try { localStorage.setItem(`letagents-board-view:${props.roomId}`, JSON.stringify({ view: view.value, collapsed: [...collapsed.value] })); } catch { /* View preferences must never prevent board use. */ } }
function changeView(id: string) { view.value = id; preferences(); }
watch(() => props.roomId, () => {
  view.value = 'board'; collapsed.value = new Set(); sprintId.value = 'all'; clearFilters(); settingsOpen.value = false; sprintDetails.value?.close(); planDialog.value?.close(); planTaskId.value = null; moving.value = false; actionError.value = ''; endDrag();
  try { const saved = JSON.parse(localStorage.getItem(`letagents-board-view:${props.roomId}`) || 'null'); if (views.value.some(v => v.id === saved?.view)) view.value = saved.view; if (Array.isArray(saved?.collapsed)) collapsed.value = new Set(saved.collapsed.filter((id: unknown) => typeof id === 'string')); } catch { /* Ignore stale preferences. */ }
}, { immediate: true });
watch(snapshot, (value, previous) => { if (value && !previous) sprintId.value = sprints.value.find(sprint => sprint.state === 'active' && !sprint.source?.stale)?.id || 'all'; });
async function toggleColumn(id: string) { const next = new Set(collapsed.value); if (next.has(id)) next.delete(id); else next.add(id); collapsed.value = next; preferences(); await nextTick(); surface.value?.querySelector<HTMLElement>(`[data-column="${id}"] ${next.has(id) ? '.board-column-rail' : '.board-column-collapse'}`)?.focus({ preventScroll: true }); }
async function revealTask(id: string) {
  const task = allTasks.value.find(item => item.id === id);
  if (!task || !snapshot.value) return;
  if (!matchesSprint(task, snapshot.value, sprintId.value)) sprintId.value = 'all';
  if (!matchesFilters(task)) clearFilters();
  if (task.status === 'proposed') view.value = 'backlog';
  else if (task.status === 'cancelled') view.value = 'cancelled';
  else if (view.value === 'backlog' || view.value === 'cancelled') view.value = 'board';
  const column = boardTaskColumn(snapshot.value.document, task);
  if (column && collapsed.value.has(column)) { const next = new Set(collapsed.value); next.delete(column); collapsed.value = next; }
  await nextTick(); surface.value?.querySelector<HTMLElement>(`[data-board-task-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
async function applyCreatedPlanning(id: string, fields: BoardTaskPlanningFields): Promise<boolean> {
  const room = props.roomId;
  if (!await load() || room !== props.roomId || !snapshot.value?.canEdit) return false;
  const document = copyDocument(); document.tasks[id] = { ...document.tasks[id], ...fields };
  return save(document);
}
function openSettings(tab: string, add = false) { settingsTab.value = tab; settingsAdd.value = add; settingsOpen.value = true; }
function sprintState(sprint: BoardSprint) { return sprint.source?.stale ? 'Status unavailable' : sprint.state === 'future' ? 'Upcoming' : sprint.state === 'active' ? 'Active' : 'Completed'; }
function sprintBackdrop(event: MouseEvent) { if (event.target === sprintDetails.value) { const rect = sprintDetails.value.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) sprintDetails.value.close(); } }
async function refresh() { emit('refresh'); await load(); }
async function openExternal(url: string) { const safe = safeWorkUrl(url); if (!safe) return; try { await props.services.openExternal(safe); } catch { actionError.value = 'The link could not be opened.'; } }
function closeOtherActions(event: Event) { const detail = event.currentTarget as HTMLDetailsElement; if (detail.open) surface.value?.querySelectorAll<HTMLDetailsElement>('.board-card-actions[open]').forEach(other => { if (other !== detail) other.open = false; }); }
function closeActions(event?: Event) { (event?.target as HTMLElement | null)?.closest('details')?.removeAttribute('open'); }
async function openPlan(taskId: string, event?: Event) { closeActions(event); planTaskId.value = taskId; await nextTick(); planDialog.value?.showModal(); }
function endDrag() { draggedTask.value = null; draggedColumn.value = null; dragOver.value = null; }
function startTaskDrag(event: DragEvent, id: string) { if (locked.value || (event.target as HTMLElement).closest('a, details')) { event.preventDefault(); return; } draggedTask.value = id; draggedColumn.value = null; event.dataTransfer?.setData('text/plain', id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }
function startColumnDrag(event: DragEvent, id: string) { if (locked.value || (event.target as HTMLElement).closest('button')) { event.preventDefault(); return; } draggedColumn.value = id; draggedTask.value = null; event.dataTransfer?.setData('text/plain', id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }
function dropTransition(task: BoardTask, column: BoardColumn) { return task.allowedTransitions.find(action => (column.statuses as readonly string[]).includes(action.targetStatus)); }
function canDrop(column: BoardColumn) {
  if (locked.value || !snapshot.value) return false;
  if (draggedColumn.value) return snapshot.value.canEdit && draggedColumn.value !== column.id;
  const task = allTasks.value.find(t => t.id === draggedTask.value);
  if (!task || boardTaskColumn(snapshot.value.document, task) === column.id) return false;
  if ((column.statuses as readonly string[]).includes(task.status)) return snapshot.value.canEdit;
  const transition = dropTransition(task, column);
  return Boolean(transition && (snapshot.value.canEdit || boardTaskColumn(snapshot.value.document, { id: task.id, status: transition.targetStatus }) === column.id));
}
function dragOverColumn(event: DragEvent, column: BoardColumn) { if (!canDrop(column)) return; event.preventDefault(); dragOver.value = column.id; if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
async function dropColumn(column: BoardColumn) {
  if (!canDrop(column) || !snapshot.value) { endDrag(); return; }
  const sourceColumn = draggedColumn.value, task = allTasks.value.find(t => t.id === draggedTask.value); endDrag();
  if (sourceColumn) { const document = copyDocument(); const from = document.columns.findIndex(c => c.id === sourceColumn), to = document.columns.findIndex(c => c.id === column.id); const columns = [...document.columns]; const [source] = columns.splice(from, 1); columns.splice(to, 0, source); replaceBoardColumns(document, columns, allTasks.value); if (await save(document)) announcement.value = `${source.name} moved.`; return; }
  if (!task) return;
  const room = props.roomId;
  if (!(column.statuses as readonly string[]).includes(task.status)) { const transition = dropTransition(task, column); if (!transition || !await runTransition(task, transition.id)) return; }
  if (room !== props.roomId || !snapshot.value?.canEdit) return;
  const document = copyDocument(); document.tasks[task.id] = { ...document.tasks[task.id], columnId: column.id };
  if (await save(document)) announcement.value = `${task.title} moved to ${column.name}.`;
}
async function runTransition(task: BoardTask, id: string, event?: Event) {
  closeActions(event); if (locked.value) return false;
  const room = props.roomId; moving.value = true; actionError.value = '';
  try { const moved = await props.services.moveTask(task.id, id); if (room !== props.roomId) return false; if (!moved) { actionError.value = 'The task could not be moved. Its work state was not changed here.'; return false; } return await load(); }
  catch (reason) { if (room === props.roomId) actionError.value = reason instanceof Error ? reason.message : 'Task could not be moved.'; return false; }
  finally { if (room === props.roomId) moving.value = false; }
}
async function columnKey(event: KeyboardEvent, index: number) {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !snapshot.value?.canEdit || locked.value) return;
  event.preventDefault(); const to = index + (event.key === 'ArrowLeft' ? -1 : 1); const document = copyDocument(); if (to < 0 || to >= document.columns.length) return;
  const columns = [...document.columns]; const [column] = columns.splice(index, 1); columns.splice(to, 0, column); replaceBoardColumns(document, columns, allTasks.value);
  if (await save(document)) { await nextTick(); surface.value?.querySelector<HTMLElement>(`[data-column="${column.id}"] ${collapsed.value.has(column.id) ? '.board-column-rail' : '.board-column-collapse'}`)?.focus({ preventScroll: true }); announcement.value = `${column.name} moved.`; }
}
</script>
