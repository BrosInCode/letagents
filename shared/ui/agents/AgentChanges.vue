<template>
  <div class="agents-changes">
    <section v-for="group in groups" :key="group.day" class="agents-record-day">
      <h3>{{ group.day }}</h3>
      <AgentDisclosure v-for="record in group.records" :key="record.id">
        <template #summary>
          <span class="agents-change-summary">
            <svg class="agents-change-mark" :data-failed="record.failed" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <template v-if="record.failed"><circle cx="10" cy="10" r="7" /><path d="M10 6v5m0 3v.1" /></template>
              <template v-else-if="record.kind === 'check_run'"><circle cx="10" cy="10" r="7" /><path v-if="record.state === 'Passed'" d="m6.5 10 2.5 2.5 4.5-5" /></template>
              <template v-else><circle cx="6" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle cx="14" cy="6" r="2" /><path d="M6 6v8m8-6c0 4-8 1-8 6" /></template>
            </svg>
            <span class="agents-copy"><strong>{{ record.title }}</strong><small>{{ record.byline }}<span class="agents-change-mobile-state"> · {{ record.state }}</span></small></span>
            <span class="agents-change-state" :data-failed="record.failed">{{ record.state }}</span>
            <time :datetime="record.time || undefined" :title="record.time || undefined">{{ changeTime(record.time) }}</time>
          </span>
        </template>
        <p v-if="record.branch" class="agents-change-branch">{{ record.branch }}</p>
        <a v-if="record.url" :href="record.url" target="_blank" rel="noopener noreferrer">{{ record.linkLabel }} ↗</a>
        <slot :record="record" />
        <div v-if="record.tasks.length" class="agents-change-tasks"><span>Linked work</span><p v-for="task in record.tasks" :key="task">{{ task }}</p></div>
        <p v-if="!record.url && !record.branch && !record.tasks.length && !$slots.default">No further details were shared.</p>
      </AgentDisclosure>
    </section>
    <p v-if="!groups.length" class="agents-empty">{{ query?.trim() ? 'No matching changes.' : emptyText || 'No changes or pull requests have been shared yet.' }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import AgentDisclosure from './AgentDisclosure.vue';
import { groupChanges, changeTime, type AgentChange } from './changes';
const props = defineProps<{ records: readonly AgentChange[]; query?: string; emptyText?: string }>();
const groups = computed(() => groupChanges(props.records, props.query || ''));
</script>
<style src="./agents.css"></style>
