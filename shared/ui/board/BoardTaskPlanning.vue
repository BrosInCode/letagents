<template>
  <form class="board-plan-fields" @submit.prevent="submit">
    <div class="board-plan-field"><label>Sprint</label><FilterDropdown v-model="sprintId" label="Sprint" :options="sprintOptions" :disabled="busy || !snapshot.canEdit" searchable search-placeholder="Find a sprint…"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
    <label class="board-plan-field">Story points<input v-model="estimate" type="number" min="0" max="1000" step="any" placeholder="Unestimated" :disabled="busy || !snapshot.canEdit" /></label>
    <div class="board-plan-field"><label>Type</label><FilterDropdown v-model="type" label="Task type" :options="types" :disabled="busy || !snapshot.canEdit"><template #option="{ option }"><BoardIcon :name="option.id" /><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
    <div class="board-plan-field"><label>Priority</label><FilterDropdown v-model="priority" label="Priority" :options="priorities" :disabled="busy || !snapshot.canEdit"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown></div>
    <p v-if="error" class="board-error" role="alert">{{ error }}</p>
    <div v-if="snapshot.canEdit" class="board-plan-actions"><button v-if="snapshot.imported.tasks[taskId]" class="board-text-button" type="button" :disabled="busy" @click="resetImported">Use tracker values</button><button class="board-button" type="submit" :disabled="busy || !dirty">{{ busy ? 'Saving…' : 'Save planning' }}</button></div>
  </form>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { boardTaskPlanning, type BoardPlanningSnapshot, type BoardPlanningDocument, type BoardTaskPlanning } from '../../board-planning.mjs';
import FilterDropdown from '../FilterDropdown.vue';
import BoardIcon from './BoardIcon.vue';
const props = defineProps<{ taskId: string; snapshot: BoardPlanningSnapshot; save: (document: BoardPlanningDocument) => Promise<boolean> }>();
const sprintId = ref(''), estimate = ref<number | string>(''), type = ref('task'), priority = ref('medium'), busy = ref(false), error = ref(''), baseline = ref('');
let draftRevision = props.snapshot.revision;
const types = [{ id: 'task', label: 'Task' }, { id: 'bug', label: 'Bug' }, { id: 'feature', label: 'Feature' }];
const priorities = ['low', 'medium', 'high', 'urgent'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const sprintOptions = computed(() => [{ id: '', label: 'No sprint' }, ...[...props.snapshot.document.sprints, ...props.snapshot.imported.sprints].map(sprint => ({ id: sprint.id, label: sprint.name }))]);
const values = () => JSON.stringify([sprintId.value, String(estimate.value), type.value, priority.value]);
const dirty = computed(() => values() !== baseline.value);
function resetFields() {
  const planning = boardTaskPlanning(props.snapshot, props.taskId);
  sprintId.value = planning.sprintId || ''; estimate.value = planning.estimate ?? ''; type.value = planning.type || 'task'; priority.value = planning.priority || 'medium';
  baseline.value = values(); draftRevision = props.snapshot.revision; error.value = ''; busy.value = false;
}
watch([() => props.taskId, () => props.snapshot.roomId], resetFields, { immediate: true });
watch(() => props.snapshot, () => { if (!dirty.value && !busy.value) resetFields(); });
async function submit() {
  if (busy.value || !props.snapshot.canEdit) return;
  const points = estimate.value === '' ? null : Number(estimate.value);
  if (points !== null && (!Number.isFinite(points) || points < 0 || points > 1000)) { error.value = 'Enter story points from 0 to 1,000, or leave unestimated.'; return; }
  const document = JSON.parse(JSON.stringify(props.snapshot.document)) as BoardPlanningDocument;
  const previous = JSON.parse(baseline.value) as string[];
  const next = { ...document.tasks[props.taskId] };
  if (sprintId.value !== previous[0]) next.sprintId = sprintId.value || null;
  if (String(estimate.value) !== previous[1]) next.estimate = points;
  if (type.value !== previous[2]) next.type = type.value as BoardTaskPlanning['type'];
  if (priority.value !== previous[3]) next.priority = priority.value as BoardTaskPlanning['priority'];
  document.tasks[props.taskId] = next;
  await persist(document);
}
async function resetImported() {
  const document = JSON.parse(JSON.stringify(props.snapshot.document)) as BoardPlanningDocument;
  const next = { ...document.tasks[props.taskId] }; delete next.sprintId; delete next.estimate;
  document.tasks[props.taskId] = next;
  if (await persist(document)) { const inherited = boardTaskPlanning(props.snapshot, props.taskId); sprintId.value = inherited.sprintId || ''; estimate.value = inherited.estimate ?? ''; baseline.value = values(); }
}
async function persist(document: BoardPlanningDocument) {
  if (props.snapshot.revision !== draftRevision) { error.value = 'Planning changed while you were editing. Reopen this task to use the latest version. Your draft has not been saved.'; return false; }
  const taskId = props.taskId, room = props.snapshot.roomId;
  busy.value = true; error.value = '';
  try {
    const saved = await props.save(document); await nextTick();
    if (props.taskId !== taskId || props.snapshot.roomId !== room) return false;
    if (saved) resetFields(); else error.value = 'Planning was not saved. Your changes are still here.';
    return saved;
  }
  catch (reason) { if (props.taskId === taskId && props.snapshot.roomId === room) error.value = reason instanceof Error ? reason.message : 'Planning could not be saved.'; return false; }
  finally { if (props.taskId === taskId && props.snapshot.roomId === room) busy.value = false; }
}
</script>
