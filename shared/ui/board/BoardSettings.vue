<template>
  <dialog ref="dialog" class="board-settings board-dialog" aria-labelledby="board-settings-title" @cancel="cancel" @click="backdrop" @keydown="escape">
    <header class="board-dialog-header"><h2 id="board-settings-title">Board settings</h2><button class="board-icon-button" type="button" aria-label="Close board settings" :disabled="saving" @click="close"><BoardIcon name="close" /></button></header>
    <nav class="board-settings-tabs" aria-label="Board settings" role="tablist"><button v-for="item in tabs" :id="`${prefix}-tab-${item}`" :key="item" type="button" role="tab" :aria-controls="`${prefix}-${item}`" :aria-selected="tab === item" :tabindex="tab === item ? 0 : -1" @click="tab = item" @keydown="tabKey($event, item)">{{ item }}</button></nav>
    <div class="board-dialog-body">
      <p v-if="error" class="board-error" role="alert">{{ error }}</p>
      <section v-if="tab === 'Columns'" :id="`${prefix}-Columns`" role="tabpanel" :aria-labelledby="`${prefix}-tab-Columns`">
        <div class="board-settings-intro"><h3>Column order</h3><span>Left to right on your board</span></div>
        <TransitionGroup tag="div" name="board-settings-row" class="board-settings-columns" :data-instant="keyboard" :class="{ 'is-drop-end': dropBefore === 'end' }">
          <div v-for="(column, index) in draft.columns" :key="column.id" class="board-settings-column" :data-settings-row="column.id" :class="{ 'is-dragging': dragging?.id === column.id && dragMoved, 'is-drop-before': dropBefore === column.id }">
            <div class="board-settings-column-main">
              <button :id="`${prefix}-drag-${column.id}`" class="board-settings-grip" type="button" :disabled="locked" :aria-label="`Reorder ${column.name}`" title="Drag to reorder · Alt + ↑ / ↓" @pointerdown="beginDrag($event, column.id)" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="cancelDrag" @keydown.alt.up.prevent="shift(index, -1, true)" @keydown.alt.down.prevent="shift(index, 1, true)"><BoardIcon name="grip" /></button>
              <span class="board-lane-dot" :data-tone="columnTone(column.statuses)" />
              <div class="board-settings-column-copy">
                <input v-if="editing === column.id" :id="`${prefix}-name-${column.id}`" v-model="column.name" :aria-label="`Column ${index + 1} name`" maxlength="80" :disabled="locked" @blur="finishRename(column)" @keydown.enter.prevent="finishRename(column)" @keydown.esc.prevent.stop="cancelRename(column)" />
                <button v-else :id="`${prefix}-rename-${column.id}`" class="board-settings-column-name" type="button" :disabled="locked" :aria-label="`Rename ${column.name}`" @click="startRename(column)">{{ column.name }}</button>
                <span>{{ countFor(column.id) }} {{ countFor(column.id) === 1 ? 'task' : 'tasks' }}</span>
              </div>
              <BoardOptionsMenu :label="`Options for ${column.name}`" :disabled="locked"><template #default="{ close: closeMenu }">
                <button type="button" @click="closeMenu(false); startRename(column)">Rename</button>
                <button type="button" :disabled="index === 0" @click="closeMenu(false); shift(index, -1)">Move up<BoardIcon name="up" /></button>
                <button type="button" :disabled="index === draft.columns.length - 1" @click="closeMenu(false); shift(index, 1)">Move down<BoardIcon name="down" /></button>
                <button class="board-option-danger" type="button" :disabled="draft.columns.length < 2" @click="closeMenu(false); requestRemove(column.id)">Remove column</button>
              </template></BoardOptionsMenu>
            </div>
            <section v-if="removing === column.id" class="board-remove-column">
              <h3>Remove {{ column.name }}?</h3>
              <p>Choose where its cards and work states go. No tasks are deleted.</p>
              <FilterDropdown v-model="destination" label="Move cards to" :options="[{ id: '', label: 'Choose a column' }, ...draft.columns.filter(item => item.id !== removing).map(item => ({ id: item.id, label: item.name }))]" :disabled="locked"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
              <div class="board-plan-actions"><button class="board-button" type="button" :disabled="saving" @click="keepColumn">Keep column</button><button class="board-button board-option-danger" type="button" :disabled="!destination || locked" @click="removeColumn">Move &amp; remove</button></div>
            </section>
          </div>
        </TransitionGroup>
        <Transition name="board-settings-add" mode="out-in" @after-enter="focusAddControl">
          <form v-if="adding && snapshot.canEdit" class="board-new-column" @submit.prevent="addColumn">
            <label :for="`${prefix}-new-column`">Column name<input :id="`${prefix}-new-column`" v-model="columnName" placeholder="e.g. Ready for testing" maxlength="80" autocomplete="off" :disabled="saving" @input="error = ''" /></label>
            <div class="board-plan-actions"><button class="board-button" type="button" :disabled="saving" @click="cancelAdd">Cancel</button><button class="board-button board-primary" type="submit" :disabled="!columnName.trim() || saving">Add column</button></div>
          </form>
          <button v-else-if="snapshot.canEdit && draft.columns.length < 30" :id="`${prefix}-add-column`" class="board-settings-add-button" type="button" :disabled="saving" @click="startAdd"><BoardIcon name="plus" />Add column</button>
        </Transition>
        <p v-if="snapshot.canEdit" class="board-settings-footnote">Drag to reorder. Click a name to rename it.</p>
      </section>
      <section v-else :id="`${prefix}-Sprints`" role="tabpanel" :aria-labelledby="`${prefix}-tab-Sprints`">
        <div class="board-settings-intro"><h3>Sprint targets</h3></div>
        <p class="board-settings-hint">The story points each person aims to complete per sprint.</p>
        <div class="board-default-target"><div><label :for="`${prefix}-default-target`">Default target</label><span>Applies unless a sprint has its own target.</span></div><div class="board-target-number"><input :id="`${prefix}-default-target`" v-model.number="draft.defaultTargetPoints" type="number" min="1" max="1000" step="1" :disabled="locked" /><span>SP</span></div></div>
        <div class="board-settings-intro board-sprint-target-heading"><h3>By sprint</h3><span>Target per person</span></div>
        <section v-for="sprint in allSprints" :key="sprint.id" class="board-sprint-settings">
          <div class="board-sprint-settings-copy"><strong>{{ sprint.name }}<span>{{ sprint.source?.stale ? 'Status unavailable' : sprint.state === 'future' ? 'Upcoming' : sprint.state === 'active' ? 'Active' : 'Completed' }}</span></strong><small>{{ sprintDates(sprint) }} · {{ sprint.source?.provider === 'jira' ? 'Jira' : sprint.source?.provider === 'linear' ? 'Linear' : 'LetAgents' }}</small><button v-if="!sprint.source && snapshot.canEdit" class="board-text-button" type="button" :disabled="saving" @click="editSprint(sprint)">Edit sprint</button></div>
          <button v-if="draft.sprintTargets[sprint.id] === undefined" class="board-target-default" type="button" :disabled="locked || sprint.state === 'closed'" :aria-label="`Set target for ${sprint.name}`" @click="overrideTarget(sprint.id)">{{ draft.defaultTargetPoints }} SP<small>Default</small></button>
          <div v-else class="board-sprint-target"><div class="board-target-number"><input :id="`${prefix}-target-${sprint.id}`" :value="draft.sprintTargets[sprint.id]" type="number" min="1" max="1000" step="1" :aria-label="`${sprint.name} target`" :disabled="locked || sprint.state === 'closed'" @input="setTarget(sprint.id, $event)" /><span>SP</span></div><button class="board-icon-button" type="button" :disabled="locked || sprint.state === 'closed'" :aria-label="`Use default target for ${sprint.name}`" @click="delete draft.sprintTargets[sprint.id]"><BoardIcon name="undo" /></button></div>
        </section>
        <button v-if="snapshot.canEdit && !sprintEditor" class="board-settings-add-button" type="button" :disabled="saving" @click="newSprint"><BoardIcon name="plus" />New sprint</button>
        <form v-if="sprintEditor" class="board-sprint-form" @submit.prevent="saveSprint">
          <h3>{{ draft.sprints.some(s => s.id === sprintEditor!.id) ? 'Edit sprint' : 'New sprint' }}</h3>
          <label>Name<input v-model="sprintEditor.name" maxlength="160" required :disabled="saving" /></label>
          <div class="board-form-pair"><label>Start<input v-model="sprintEditor.startDate" type="date" required :disabled="saving" /></label><label>End<input v-model="sprintEditor.endDate" type="date" required :disabled="saving" /></label></div>
          <label>State</label><FilterDropdown v-model="sprintEditor.state" label="Sprint state" :options="sprintStates" :disabled="saving"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
          <label>Goal <small>optional</small><textarea v-model="sprintEditor.goal" rows="3" maxlength="2000" :disabled="saving" /></label>
          <div class="board-plan-actions"><button class="board-button" type="button" :disabled="saving" @click="sprintEditor = null">Cancel</button><button class="board-button" type="submit" :disabled="saving">Apply sprint</button></div>
        </form>
        <details class="board-target-explainer"><summary>How progress is counted<BoardIcon name="down" /></summary><p>Only completed work counts toward the target. Tasks in review remain unfinished. Missing estimates are called out in the assignee view.</p></details>
      </section>
    </div>
    <footer class="board-dialog-footer"><span class="board-settings-dirty" role="status">{{ dirty ? 'Unsaved changes' : '' }}</span><button class="board-button" type="button" :disabled="saving" @click="close">Cancel</button><button v-if="snapshot.canEdit" class="board-button board-primary" type="button" :disabled="saving || !dirty || Boolean(sprintEditor) || Boolean(removing) || adding || Boolean(editing)" @click="submit">{{ saving ? 'Saving…' : 'Save changes' }}</button></footer>
    <span class="board-sr-only" aria-live="polite">{{ announcement }}</span>
  </dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { boardTaskColumn, validateBoardPlanningUpdate, type BoardColumn, type BoardPlanningDocument, type BoardPlanningSnapshot, type BoardSprint } from '../../board-planning.mjs';
import FilterDropdown from '../FilterDropdown.vue';
import BoardIcon from './BoardIcon.vue';
import BoardOptionsMenu from './BoardOptionsMenu.vue';
import { columnTone, replaceBoardColumns, sprintDates } from './model';
const props = defineProps<{ open: boolean; initialTab?: string; startAdding?: boolean; snapshot: BoardPlanningSnapshot; save: (document: BoardPlanningDocument) => Promise<boolean> }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>(), prefix = `board-settings-${useId()}`, tabs = ['Columns', 'Sprints'];
const draft = ref<BoardPlanningDocument>(JSON.parse(JSON.stringify(props.snapshot.document))), initialDocument = ref(JSON.stringify(props.snapshot.document));
let draftRevision = props.snapshot.revision;
const tab = ref('Columns'), saving = ref(false), error = ref(''), removing = ref(''), destination = ref(''), columnName = ref(''), adding = ref(false), editing = ref(''), originalName = ref(''), announcement = ref(''), keyboard = ref(false);
const dragging = shallowRef<{ id: string; x: number; y: number; pointerId: number; target: HTMLElement } | null>(null), dragMoved = ref(false), dropBefore = ref<string | null>(null);
const sprintEditor = ref<BoardSprint | null>(null);
const sprintStates = [{ id: 'future', label: 'Upcoming' }, { id: 'active', label: 'Active' }, { id: 'closed', label: 'Completed' }];
const allSprints = computed(() => [...draft.value.sprints, ...props.snapshot.imported.sprints]);
const locked = computed(() => saving.value || !props.snapshot.canEdit);
const dirty = computed(() => JSON.stringify(draft.value) !== initialDocument.value);
watch(() => props.open, async open => {
  cancelDrag();
  if (open) { draft.value = JSON.parse(JSON.stringify(props.snapshot.document)); initialDocument.value = JSON.stringify(props.snapshot.document); draftRevision = props.snapshot.revision; error.value = ''; removing.value = ''; editing.value = ''; adding.value = false; columnName.value = ''; sprintEditor.value = null; tab.value = props.initialTab || 'Columns'; await nextTick(); dialog.value?.showModal(); if (props.startAdding) startAdd(); }
  else dialog.value?.close();
}, { immediate: true });
function focus(id: string) { void nextTick(() => dialog.value?.querySelector<HTMLElement>(`[id="${prefix}-${id}"]`)?.focus({ preventScroll: true })); }
function close() { if (!saving.value) { cancelDrag(); emit('close'); } }
function cancel(event: Event) { event.preventDefault(); close(); }
function backdrop(event: MouseEvent) { if (event.target === dialog.value) { const rect = dialog.value.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }
function escape(event: KeyboardEvent) { if (event.key !== 'Escape' || saving.value) return; if (dragging.value) { cancelDrag(); event.preventDefault(); event.stopPropagation(); } else if (removing.value) { keepColumn(); event.preventDefault(); event.stopPropagation(); } else if (adding.value) { cancelAdd(); event.preventDefault(); event.stopPropagation(); } }
function tabKey(event: KeyboardEvent, item: string) { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(item) + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length; tab.value = tabs[index]; focus(`tab-${tab.value}`); }
function countFor(id: string) { return props.snapshot.taskFacts.filter(task => boardTaskColumn(draft.value, task) === id).length; }
function startRename(column: BoardColumn) { if (locked.value) return; originalName.value = column.name; editing.value = column.id; void nextTick(() => { const input = dialog.value?.querySelector<HTMLInputElement>(`[id="${prefix}-name-${column.id}"]`); input?.focus(); input?.select(); }); }
function finishRename(column: BoardColumn) { if (editing.value !== column.id) return; const restore = dialog.value?.ownerDocument?.activeElement?.id === `${prefix}-name-${column.id}`; column.name = column.name.trim() || originalName.value; editing.value = ''; if (restore) focus(`rename-${column.id}`); }
function cancelRename(column: BoardColumn) { column.name = originalName.value; editing.value = ''; focus(`rename-${column.id}`); }
function shift(index: number, direction: number, instant = false) { if (locked.value || index + direction < 0 || index + direction >= draft.value.columns.length) return; keyboard.value = instant; const columns = [...draft.value.columns]; const [column] = columns.splice(index, 1); columns.splice(index + direction, 0, column); replaceBoardColumns(draft.value, columns, props.snapshot.taskFacts); announcement.value = `${column.name} moved to position ${index + direction + 1}`; focus(`drag-${column.id}`); }
function startAdd() { if (locked.value || draft.value.columns.length >= 30) return; adding.value = true; error.value = ''; focus('new-column'); }
function focusAddControl() { if (props.open) focus(adding.value ? 'new-column' : 'add-column'); }
function cancelAdd() { adding.value = false; error.value = ''; columnName.value = ''; focus('add-column'); }
function addColumn() { if (locked.value || !columnName.value.trim() || draft.value.columns.length >= 30) return; const name = columnName.value.trim(); if (draft.value.columns.some(c => c.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) { error.value = 'That column already exists.'; return; } keyboard.value = false; draft.value.columns.push({ id: `column-${crypto.randomUUID()}`, name, statuses: ['in_progress'] }); announcement.value = `${name} added`; cancelAdd(); }
function requestRemove(id: string) { if (locked.value || draft.value.columns.length < 2) return; removing.value = id; destination.value = ''; void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>('.board-remove-column button')?.focus()); }
function keepColumn() { const id = removing.value; removing.value = ''; focus(`rename-${id}`); }
function removeColumn() {
  if (locked.value || draft.value.columns.length < 2) return;
  const source = draft.value.columns.find(c => c.id === removing.value), target = draft.value.columns.find(c => c.id === destination.value);
  if (!source || !target || source === target) return;
  // Capture visible placement before changing either mappings or per-task overrides.
  const previousColumns = new Map(props.snapshot.taskFacts.map(task => [task.id, boardTaskColumn(draft.value, task)]));
  const columns = draft.value.columns.filter(c => c.id !== source.id).map(column => column.id === target.id ? { ...column, statuses: [...new Set([...target.statuses, ...source.statuses])] } : column);
  replaceBoardColumns(draft.value, columns, props.snapshot.taskFacts);
  for (const [id, columnId] of previousColumns) {
    if (columnId === source.id) draft.value.tasks[id] = { ...draft.value.tasks[id], columnId: target.id };
  }
  for (const [id, meta] of Object.entries(draft.value.tasks)) {
    if (meta.columnId === source.id) meta.columnId = previousColumns.has(id) ? previousColumns.get(id)! : target.id;
  }
  removing.value = ''; announcement.value = `${source.name} removed from the draft`; focus(`rename-${target.id}`);
}
function beginDrag(event: PointerEvent, id: string) { if (locked.value || event.button !== 0 || !event.isPrimary) return; keyboard.value = false; dragMoved.value = false; dragging.value = { id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, target: event.currentTarget as HTMLElement }; dragging.value.target.setPointerCapture(event.pointerId); }
function moveDrag(event: PointerEvent) { const drag = dragging.value; if (!drag || event.pointerId !== drag.pointerId) return; if (!dragMoved.value && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return; dragMoved.value = true; const nodes = [...(dialog.value?.querySelectorAll<HTMLElement>('[data-settings-row]') || [])].filter(node => node.dataset.settingsRow !== drag.id); dropBefore.value = nodes.find(node => event.clientY < node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2)?.dataset.settingsRow || 'end'; }
function endDrag(event: PointerEvent) { const drag = dragging.value; if (!drag || event.pointerId !== drag.pointerId) return; if (dragMoved.value && !locked.value) { const column = draft.value.columns.find(c => c.id === drag.id); if (column) { const columns = draft.value.columns.filter(c => c.id !== drag.id); const before = columns.findIndex(c => c.id === dropBefore.value); const index = before < 0 ? columns.length : before; columns.splice(index, 0, column); replaceBoardColumns(draft.value, columns, props.snapshot.taskFacts); announcement.value = `${column.name} moved to position ${index + 1}`; } } cancelDrag(); focus(`drag-${drag.id}`); }
function cancelDrag() { const drag = dragging.value; if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId); dragging.value = null; dragMoved.value = false; dropBefore.value = null; }
onBeforeUnmount(cancelDrag);
function setTarget(id: string, event: Event) { if (!locked.value) draft.value.sprintTargets[id] = Number((event.target as HTMLInputElement).value); }
function overrideTarget(id: string) { if (locked.value) return; draft.value.sprintTargets[id] = draft.value.defaultTargetPoints; focus(`target-${id}`); }
function newSprint() { if (!locked.value) sprintEditor.value = { id: `sprint-${crypto.randomUUID()}`, name: '', state: 'future', startDate: null, endDate: null, goal: '' }; }
function editSprint(sprint: BoardSprint) { if (!locked.value) sprintEditor.value = { ...sprint }; }
function saveSprint() {
  const sprint = sprintEditor.value;
  if (locked.value || !sprint || !sprint.name.trim() || !sprint.startDate || !sprint.endDate) return;
  if (sprint.endDate < sprint.startDate) { error.value = 'Choose an end date after the start date.'; return; }
  const next = { ...sprint, name: sprint.name.trim(), goal: sprint.goal?.trim() || null };
  const index = draft.value.sprints.findIndex(s => s.id === sprint.id);
  if (index < 0) draft.value.sprints.push(next); else draft.value.sprints[index] = next;
  error.value = ''; sprintEditor.value = null;
}
async function submit() {
  if (locked.value) return;
  error.value = '';
  if (props.snapshot.revision !== draftRevision) { error.value = 'The board changed while you were editing. Close and reopen settings to use the latest version. Your draft has not been saved.'; return; }
  const names = draft.value.columns.map(column => column.name.trim().toLocaleLowerCase());
  if (new Set(names).size !== names.length) { error.value = 'Choose a different name for each column.'; return; }
  try { validateBoardPlanningUpdate({ expectedRevision: draftRevision, document: draft.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Check the board settings.'; return; }
  saving.value = true;
  try { if (await props.save(draft.value)) emit('close'); else error.value = 'Settings were not saved. Refresh the board if someone else changed it; your draft is still here.'; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Settings could not be saved.'; }
  finally { saving.value = false; }
}
</script>
