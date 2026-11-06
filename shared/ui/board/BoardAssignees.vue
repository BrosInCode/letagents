<template>
  <div class="board-assignee-view">
    <div v-if="sprint" class="board-story-context">
      <span>{{ sprint.state === 'active' && !sprint.source?.stale && clock ? `${clock.left} working ${clock.left === 1 ? 'day' : 'days'} left` : sprintDates(sprint) }}</span>
      <div>
        <button v-if="sprint.state !== 'closed'" class="board-button" type="button" :disabled="!snapshot.canEdit" @click="emit('target')">Target <strong>{{ target }} SP</strong></button>
        <details v-if="sprint.state === 'active' && !sprint.source?.stale" class="board-pace-guide"><summary>Pace guide</summary><p>Completed story points count toward the target. The marker shows the share of Monday–Friday working days elapsed. Review work and missing estimates are shown separately; this is a guide, not a forecast.</p></details>
      </div>
    </div>
    <p v-if="!stories.length" class="board-empty">No matching work.</p>
    <DisclosurePanel v-for="story in stories" :key="story.key" class="board-story" :open="expanded.has(story.key)" @toggle="toggle(story.key)">
      <template #summary>
        <span class="board-story-heading">
          <span class="board-story-person"><ChatAvatar v-if="story.key" :name="story.owner.name" :provider="story.owner.provider" :agent="story.owner.agent" :agent-key="story.owner.key" :avatar-url="story.owner.avatarUrl" /><BoardIcon v-else name="user" /><span><strong>{{ story.owner.name }}</strong><small>{{ story.summary }}</small></span></span>
          <span v-if="story.hasTarget" class="board-story-meter"><span class="board-story-points"><strong>{{ story.value }}</strong><span>/ {{ story.target }} SP</span><small>{{ sprint?.state === 'future' ? 'planned' : 'completed' }}</small></span><span class="board-story-track"><span class="board-story-fill" :data-tone="story.tone" :style="{ transform: `scaleX(${story.ratio})` }" /><span v-if="story.pace !== null" class="board-story-marker" :style="{ left: `${story.pace * 100}%` }" :title="`${story.expected} SP expected at this point in the sprint`" /></span></span>
          <span v-else class="board-story-total">{{ story.items.length }} {{ story.items.length === 1 ? 'task' : 'tasks' }}</span>
          <span class="board-story-verdict" :data-tone="story.tone">{{ story.label }}</span>
        </span>
      </template>
      <div class="board-story-tasks">
        <div v-for="task in story.items" :key="task.id" class="board-story-task">
          <button type="button" class="board-story-task-title" @click="emit('select', task.id)"><span>{{ task.title }}</span><small>{{ task.ticket?.key || task.id.replace(/^task_/, 'T') }} · {{ taskStoryStatus(task, snapshot) }}</small></button>
          <span class="board-story-estimate">{{ boardTaskPlanning(snapshot, task.id).estimate == null ? 'Unestimated' : `${boardTaskPlanning(snapshot, task.id).estimate} SP` }}</span>
          <a v-if="safeWorkUrl(task.pr?.url || null)" class="board-pr" :href="task.pr!.url" @click.prevent="emit('external', task.pr!.url)"><BoardIcon name="pr" />{{ task.pr!.number ? '#' + task.pr!.number : 'PR' }}</a>
        </div>
      </div>
    </DisclosurePanel>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { boardTaskPlanning, type BoardPlanningSnapshot, type BoardSprint } from '../../board-planning.mjs';
import ChatAvatar from '../ChatAvatar.vue';
import DisclosurePanel from '../DisclosurePanel.vue';
import { safeWorkUrl } from '../my-work/model';
import BoardIcon from './BoardIcon.vue';
import { assigneeStories, sprintClock, sprintDates, taskStoryStatus } from './model';
import type { BoardTask } from './types';
const props = defineProps<{ tasks: readonly BoardTask[]; visible: readonly BoardTask[]; snapshot: BoardPlanningSnapshot; sprint?: BoardSprint }>();
const emit = defineEmits<{ select: [id: string]; external: [url: string]; target: [] }>();
const expanded = ref(new Set<string>());
const stories = computed(() => assigneeStories(props.tasks, props.visible, props.snapshot, props.sprint));
const target = computed(() => props.sprint ? props.snapshot.document.sprintTargets[props.sprint.id] ?? props.snapshot.document.defaultTargetPoints : 0);
const clock = computed(() => sprintClock(props.sprint));
function toggle(key: string) { const next = new Set(expanded.value); if (next.has(key)) next.delete(key); else next.add(key); expanded.value = next; }
watch(() => props.sprint?.id, () => { expanded.value = new Set(); });
</script>
