<template>
  <dialog ref="dialog" class="board-settings board-dialog" aria-labelledby="board-settings-title" @cancel="cancel" @click="backdrop">
    <header class="board-dialog-header"><h2 id="board-settings-title">Board settings</h2><button class="board-icon-button" type="button" aria-label="Close board settings" :disabled="saving" @click="close"><BoardIcon name="close" /></button></header>
    <nav class="board-settings-tabs" aria-label="Board settings"><button v-for="item in ['Columns', 'Sprints']" :key="item" type="button" :aria-pressed="tab === item" @click="tab = item">{{ item }}</button></nav>
    <div class="board-dialog-body">
      <p v-if="error" class="board-error" role="alert">{{ error }}</p>
      <template v-if="tab === 'Columns'">
        <div v-for="(column, index) in draft.columns" :key="column.id" class="board-settings-column">
          <span class="board-lane-dot" :data-tone="columnTone(column.statuses)" />
          <input v-model="column.name" :aria-label="`Column ${index + 1} name`" maxlength="80" :disabled="saving || !snapshot.canEdit" />
          <button class="board-icon-button" type="button" :disabled="index === 0 || saving || !snapshot.canEdit" :aria-label="`Move ${column.name} left`" @click="shift(index, -1)"><BoardIcon name="left" /></button>
          <button class="board-icon-button" type="button" :disabled="index === draft.columns.length - 1 || saving || !snapshot.canEdit" :aria-label="`Move ${column.name} right`" @click="shift(index, 1)"><BoardIcon name="right" /></button>
          <button class="board-icon-button" type="button" :disabled="draft.columns.length < 2 || saving || !snapshot.canEdit" :aria-label="`Remove ${column.name}`" @click="removing = column.id; destination = ''"><BoardIcon name="close" /></button>
        </div>
        <section v-if="removing" class="board-remove-column">
          <h3>Remove {{ draft.columns.find(column => column.id === removing)?.name }}?</h3>
          <p>Choose where its cards go. Tasks and their work states are kept.</p>
          <FilterDropdown v-model="destination" label="Move cards to" :options="[{ id: '', label: 'Choose a column' }, ...draft.columns.filter(column => column.id !== removing).map(column => ({ id: column.id, label: column.name }))]" :disabled="saving"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
          <div class="board-plan-actions"><button class="board-button" type="button" @click="removing = ''">Cancel</button><button class="board-button" type="button" :disabled="!destination" @click="removeColumn">Remove column</button></div>
        </section>
        <form v-if="snapshot.canEdit && draft.columns.length < 30" class="board-new-column" @submit.prevent="addColumn">
          <h3>Add column</h3><label>Name<input v-model="columnName" placeholder="For example, Testing" maxlength="80" :disabled="saving" /></label>
          <label>Work state</label><FilterDropdown v-model="columnState" label="New column work state" :options="columnStates" :disabled="saving"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
          <button class="board-button" type="submit" :disabled="!columnName.trim() || saving"><BoardIcon name="plus" />Add column</button>
        </form>
      </template>
      <template v-else>
        <label class="board-setting-target">Default target per person<input v-model.number="draft.defaultTargetPoints" type="number" min="1" max="1000" step="1" :disabled="saving || !snapshot.canEdit" /><span>SP per sprint</span></label>
        <p class="board-settings-hint">Each sprint can use its own target. Missing estimates remain visible in the assignee overview.</p>
        <section v-for="sprint in allSprints" :key="sprint.id" class="board-sprint-settings">
          <header><strong>{{ sprint.name }}</strong><span>{{ sprint.source?.provider || 'LetAgents' }}</span></header>
          <p>{{ sprintDates(sprint) }} · {{ sprint.source?.stale ? 'Status unavailable' : sprint.state === 'future' ? 'Upcoming' : sprint.state === 'active' ? 'Active' : 'Completed' }}</p>
          <label>Target per person<input :value="draft.sprintTargets[sprint.id] ?? draft.defaultTargetPoints" type="number" min="1" max="1000" step="1" :disabled="saving || !snapshot.canEdit || sprint.state === 'closed'" @input="setTarget(sprint.id, $event)" /><span>SP</span></label>
          <button v-if="!sprint.source && snapshot.canEdit" class="board-text-button" type="button" :disabled="saving" @click="editSprint(sprint)">Edit sprint</button>
        </section>
        <button v-if="snapshot.canEdit && !sprintEditor" class="board-button" type="button" :disabled="saving" @click="newSprint"><BoardIcon name="plus" />New sprint</button>
        <form v-if="sprintEditor" class="board-sprint-form" @submit.prevent="saveSprint">
          <h3>{{ draft.sprints.some(s => s.id === sprintEditor!.id) ? 'Edit sprint' : 'New sprint' }}</h3>
          <label>Name<input v-model="sprintEditor.name" maxlength="160" required :disabled="saving" /></label>
          <div class="board-form-pair"><label>Start<input v-model="sprintEditor.startDate" type="date" required :disabled="saving" /></label><label>End<input v-model="sprintEditor.endDate" type="date" required :disabled="saving" /></label></div>
          <label>State</label><FilterDropdown v-model="sprintEditor.state" label="Sprint state" :options="sprintStates" :disabled="saving"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
          <label>Goal <small>optional</small><textarea v-model="sprintEditor.goal" rows="3" maxlength="2000" :disabled="saving" /></label>
          <div class="board-plan-actions"><button class="board-button" type="button" @click="sprintEditor = null">Cancel</button><button class="board-button" type="submit" :disabled="saving">Apply sprint</button></div>
        </form>
      </template>
    </div>
    <footer class="board-dialog-footer"><button class="board-button" type="button" :disabled="saving" @click="close">Cancel</button><button v-if="snapshot.canEdit" class="board-button board-primary" type="button" :disabled="saving || Boolean(sprintEditor) || Boolean(removing)" @click="submit">{{ saving ? 'Saving…' : 'Save changes' }}</button></footer>
  </dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { BOARD_TASK_STATUSES, boardTaskColumn, validateBoardPlanningUpdate, type BoardPlanningDocument, type BoardPlanningSnapshot, type BoardSprint, type BoardTaskStatus } from '../../board-planning.mjs';
import FilterDropdown from '../FilterDropdown.vue';
import BoardIcon from './BoardIcon.vue';
import { columnTone, sprintDates, statusLabel } from './model';
const props = defineProps<{ open: boolean; initialTab?: string; snapshot: BoardPlanningSnapshot; save: (document: BoardPlanningDocument) => Promise<boolean> }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const draft = ref<BoardPlanningDocument>(JSON.parse(JSON.stringify(props.snapshot.document)));
let draftRevision = props.snapshot.revision;
const tab = ref('Columns'), saving = ref(false), error = ref(''), removing = ref(''), destination = ref(''), columnName = ref(''), columnState = ref('in_progress');
const sprintEditor = ref<BoardSprint | null>(null);
const columnStates = BOARD_TASK_STATUSES.map(id => ({ id, label: statusLabel(id) }));
const sprintStates = [{ id: 'future', label: 'Upcoming' }, { id: 'active', label: 'Active' }, { id: 'closed', label: 'Completed' }];
const allSprints = computed(() => [...draft.value.sprints, ...props.snapshot.imported.sprints]);
watch(() => props.open, async open => {
  if (open) { draft.value = JSON.parse(JSON.stringify(props.snapshot.document)); draftRevision = props.snapshot.revision; error.value = ''; removing.value = ''; sprintEditor.value = null; tab.value = props.initialTab || 'Columns'; await nextTick(); dialog.value?.showModal(); }
  else dialog.value?.close();
}, { immediate: true });
function close() { if (!saving.value) emit('close'); }
function cancel(event: Event) { event.preventDefault(); close(); }
function backdrop(event: MouseEvent) { if (event.target === dialog.value) { const rect = dialog.value.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }
function shift(index: number, direction: number) { const columns = [...draft.value.columns]; const [column] = columns.splice(index, 1); columns.splice(index + direction, 0, column); draft.value.columns = columns; }
function addColumn() { if (!columnName.value.trim()) return; draft.value.columns.push({ id: `column-${crypto.randomUUID()}`, name: columnName.value.trim(), statuses: [columnState.value as BoardTaskStatus] }); columnName.value = ''; }
function removeColumn() {
  const source = draft.value.columns.find(c => c.id === removing.value), target = draft.value.columns.find(c => c.id === destination.value);
  if (!source || !target || source === target) return;
  // Retain state coverage and cards in the destination without changing any task's lifecycle.
  for (const task of props.snapshot.taskFacts) {
    const meta = draft.value.tasks[task.id];
    if (boardTaskColumn(draft.value, task) === source.id) draft.value.tasks[task.id] = { ...meta, columnId: target.id };
  }
  target.statuses = [...new Set([...target.statuses, ...source.statuses])];
  for (const meta of Object.values(draft.value.tasks)) if (meta.columnId === source.id) meta.columnId = target.id;
  draft.value.columns = draft.value.columns.filter(c => c.id !== source.id); removing.value = '';
}
function setTarget(id: string, event: Event) { draft.value.sprintTargets[id] = Number((event.target as HTMLInputElement).value); }
function newSprint() { sprintEditor.value = { id: `sprint-${crypto.randomUUID()}`, name: '', state: 'future', startDate: null, endDate: null, goal: '' }; }
function editSprint(sprint: BoardSprint) { sprintEditor.value = { ...sprint }; }
function saveSprint() {
  const sprint = sprintEditor.value;
  if (!sprint || !sprint.name.trim() || !sprint.startDate || !sprint.endDate) return;
  if (sprint.endDate < sprint.startDate) { error.value = 'Choose an end date after the start date.'; return; }
  const next = { ...sprint, name: sprint.name.trim(), goal: sprint.goal?.trim() || null };
  const index = draft.value.sprints.findIndex(s => s.id === sprint.id);
  if (index < 0) draft.value.sprints.push(next); else draft.value.sprints[index] = next;
  error.value = ''; sprintEditor.value = null;
}
async function submit() {
  error.value = '';
  if (props.snapshot.revision !== draftRevision) { error.value = 'The board changed while you were editing. Close and reopen settings to use the latest version. Your draft has not been saved.'; return; }
  try { validateBoardPlanningUpdate({ expectedRevision: draftRevision, document: draft.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Check the board settings.'; return; }
  saving.value = true;
  try { if (await props.save(draft.value)) emit('close'); else error.value = 'Settings were not saved. Refresh the board if someone else changed it; your draft is still here.'; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Settings could not be saved.'; }
  finally { saving.value = false; }
}
</script>
