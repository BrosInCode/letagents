<template>
  <section class="board-release-settings">
    <h3>Waiting for release</h3>
    <p class="board-settings-hint">Choose what puts work in this queue. It appears in chat only when there’s something waiting.</p>
    <label>Include work from</label>
    <FilterDropdown :model-value="sourceId" label="Release source" :options="sourceOptions" :disabled="disabled" @update:model-value="chooseSource"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
    <template v-if="modelValue?.kind === 'column'">
      <label>Column</label>
      <FilterDropdown :model-value="modelValue.columnId" label="Release column" :options="columns.map(c => ({ id: c.id, label: c.name }))" :disabled="disabled" @update:model-value="id => emit('update:modelValue', { kind: 'column', columnId: id })"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
      <p class="board-settings-hint">Shows cards currently in this column. Moving a card or changing its status can take it out.</p>
    </template>
    <template v-else-if="modelValue?.kind === 'tracker'">
      <label>Ticket field</label>
      <FilterDropdown :model-value="modelValue.fieldId" label="Release field" :options="fieldOptions" :disabled="disabled" searchable @update:model-value="chooseField"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
      <label>Matches</label>
      <FilterDropdown :model-value="modelValue.value" label="Release value" :options="valueOptions" :disabled="disabled" searchable @update:model-value="chooseValue"><template #option="{ option }"><span class="work-option-label">{{ option.label }}</span></template></FilterDropdown>
      <p class="board-settings-hint">Options come from tickets imported to this board. Clear the flag or change the value in your tracker after release. Merging a PR leaves the ticket here.</p>
    </template>
    <p v-if="!sources.length" class="board-settings-hint">Import tracker tickets to use their status, labels, or Jira flags here.</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { BoardColumn, BoardReleaseRule, BoardReleaseSource } from '../../board-planning.mjs';
import FilterDropdown from '../FilterDropdown.vue';
const props = defineProps<{ modelValue?: BoardReleaseRule | null; columns: BoardColumn[]; sources: BoardReleaseSource[]; disabled: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [rule: BoardReleaseRule | null] }>();
const sourceId = computed(() => props.modelValue?.kind === 'tracker' ? props.modelValue.connectionId : props.modelValue?.kind === 'column' ? 'column' : 'off');
const source = computed(() => props.sources.find(s => s.id === sourceId.value));
const sourceOptions = computed(() => [{ id: 'off', label: 'Off' }, { id: 'column', label: 'Board column' }, ...props.sources.map(s => ({ id: s.id, label: `${s.name} · ${s.provider === 'jira' ? 'Jira' : s.provider === 'linear' ? 'Linear' : 'GitHub'}` })),
  ...(props.modelValue?.kind === 'tracker' && !source.value ? [{ id: props.modelValue.connectionId, label: 'Tracker unavailable' }] : [])]);
const fieldOptions = computed(() => {
  const fields = source.value?.fields.map(f => ({ id: f.id, label: f.name })) ?? [];
  const rule = props.modelValue;
  if (rule?.kind === 'tracker' && !fields.some(f => f.id === rule.fieldId)) fields.push({ id: rule.fieldId, label: 'Field unavailable' });
  return fields;
});
const valueOptions = computed(() => {
  const rule = props.modelValue;
  const values = rule?.kind === 'tracker' ? source.value?.fields.find(f => f.id === rule.fieldId)?.values ?? [] : [];
  return [{ id: '', label: 'Choose a value' }, ...[...new Set([...values, ...(rule?.kind === 'tracker' && rule.value ? [rule.value] : [])])].map(v => ({ id: v, label: v === 'true' ? 'Enabled' : v === 'false' ? 'Disabled' : v }))];
});
function chooseSource(id: string) {
  if (id === 'off') emit('update:modelValue', null);
  else if (id === 'column') emit('update:modelValue', { kind: 'column', columnId: props.columns[0]?.id ?? '' });
  else emit('update:modelValue', { kind: 'tracker', connectionId: id, fieldId: 'status', value: '' });
}
function chooseField(fieldId: string) { if (props.modelValue?.kind === 'tracker') emit('update:modelValue', { ...props.modelValue, fieldId, value: '' }); }
function chooseValue(value: string) { if (props.modelValue?.kind === 'tracker') emit('update:modelValue', { ...props.modelValue, value }); }
</script>
