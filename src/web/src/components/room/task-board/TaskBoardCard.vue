<template>
  <article
    :class="['task-card', { selected }]"
    :data-board-task-id="task.id"
    :aria-current="selected ? 'true' : undefined"
    :aria-label="`${formatTaskShortId(task.id)}: ${task.title}. ${taskStatusLabel(task.status)}.`"
    tabindex="-1"
    @click="onCardClick"
  >
    <header class="task-card-header">
      <span class="task-id-badge" :title="task.id">{{ formatTaskShortId(task.id) }}</span>
      <span :title="`Updated ${task.updated_at}`">{{ formatTimestamp(task.updated_at || task.created_at) }}</span>
    </header>
    <h4 class="task-card-title"><button type="button" aria-haspopup="dialog" :aria-label="`Open ${formatTaskShortId(task.id)}: ${task.title}`" @click="emit('select', task.id)">{{ task.title }}</button></h4>
    <div class="task-owner" :title="`Owner: ${ownerName}`">
      <span class="task-avatar" aria-hidden="true">{{ task.assignee ? ownerName.charAt(0).toUpperCase() : '-' }}</span>
      <span>{{ ownerName }}</span>
    </div>

    <div v-if="showAuthority || showReviewAuthority || secondaryLeases.length || task.active_locks?.length" class="task-coordination">
      <span v-if="showAuthority" :class="['coordination-badge', authority.state === 'held' ? 'lease' : 'warning']" :title="authority.detail">
        {{ authority.state === 'held' ? 'Worker attached' : authority.state === 'mismatch' ? 'Check owner' : 'No active worker' }}
      </span>
      <span v-if="showReviewAuthority" :class="['coordination-badge', review.state === 'assigned' ? 'review' : 'warning']" :title="review.detail">
        {{ review.label }}
      </span>
      <span v-for="lease in secondaryLeases" :key="lease.id" class="coordination-badge">
        {{ lease.kind }}: {{ formatActorName(lease.actor_label) }}
      </span>
      <span v-for="lock in task.active_locks" :key="lock.id" class="coordination-badge lock" :title="`${lock.scope} lock: ${lock.reason}${lock.message ? ' - ' + lock.message : ''}`">
        {{ lock.reason || 'Locked' }}
      </span>
    </div>

    <div v-if="workflowRefs.length" class="task-links">
      <a v-for="ref in workflowRefs.slice(0, 2)" :key="ref.url" :href="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.label }}</a>
    </div>
    <div v-if="githubStatus" class="task-coordination" aria-label="GitHub checks and reviews">
      <span :class="['coordination-badge', githubStatus.check_summary.failure ? 'lock' : githubStatus.check_summary.pending ? 'warning' : '']">
        CI: {{ githubStatus.check_summary.failure ? githubStatus.check_summary.failure + ' failing' : githubStatus.check_summary.pending ? githubStatus.check_summary.pending + ' pending' : githubStatus.check_summary.total ? 'passing' : 'no checks' }}
      </span>
      <span v-if="githubStatus.review_summary.changes_requested" class="coordination-badge lock">Changes requested</span>
    </div>

    <button
      v-if="primaryAction"
      type="button"
      :class="['task-action-btn', primaryAction.cls]"
      :disabled="updating || mutationBusy"
      @click="emit('updateStatus', task.id, primaryAction.status)"
    >{{ updating ? 'Updating...' : primaryAction.label }}</button>

    <button v-if="workflowRefs.length > 2" type="button" class="task-more-links" aria-haspopup="dialog" @click="emit('select', task.id)">+{{ workflowRefs.length - 2 }} links</button>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { getAuthorityState } from '../task-lease-authority/model'
import { getReviewState } from '../task-review-authority/model'
import {
  formatActorName, formatTaskShortId, formatTimestamp,
  getSecondaryLeases, getTaskActions, getTaskWorkflowRefs,
  shouldShowAuthority, shouldShowReviewAuthority,
} from './model'
import { taskStatusLabel } from '../../../domain/taskStatus'

const props = defineProps<{
  task: RoomTask
  updating: boolean
  mutationBusy?: boolean
  githubStatus: TaskGitHubArtifactStatus | null
  selected?: boolean
}>()
const emit = defineEmits<{
  updateStatus: [taskId: string, status: string]
  select: [taskId: string]
}>()

const ownerName = computed(() => formatActorName(props.task.assignee) || 'Unassigned')
const secondaryLeases = computed(() => getSecondaryLeases(props.task))
const taskActions = computed(() => getTaskActions(props.task))
const primaryAction = computed(() => taskActions.value.find(action => action.cls !== 'cancel'))
const workflowRefs = computed(() => getTaskWorkflowRefs(props.task))
const showAuthority = computed(() => shouldShowAuthority(props.task))
const showReviewAuthority = computed(() => shouldShowReviewAuthority(props.task))
const authority = computed(() => getAuthorityState(props.task))
const review = computed(() => getReviewState(props.task))
function onCardClick(event: MouseEvent) {
  if ((event.target as Element).closest('button, a, input, select, textarea')) return
  emit('select', props.task.id)
}
</script>

<style scoped>
.task-card {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color var(--duration-fast) ease, background-color var(--duration-fast) ease;
}
.task-card.selected { border-color: var(--blue); }
.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  color: var(--text-tertiary);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.task-id-badge { font-family: var(--font-mono); overflow-wrap: anywhere; }
.task-card-title {
  margin: 0;
  color: var(--text);
  font-size: 0.875rem;
  font-weight: 550;
  line-height: 1.5;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
.task-owner {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}
.task-owner > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--accent-dim);
  font-size: 0.625rem;
}
.task-coordination, .task-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.coordination-badge, .task-links a {
  max-width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.6875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.coordination-badge.lease { color: var(--green-text); }
.coordination-badge.review { color: var(--task-in-review); }
.coordination-badge.warning { color: var(--amber-text); background: var(--amber-dim); }
.coordination-badge.lock { color: var(--red-text); background: var(--red-dim); }
.task-links a { color: var(--blue); text-decoration: none; }
.task-action-btn {
  justify-self: start;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
.task-action-btn.accept { color: var(--task-accepted); background: var(--blue-dim); }
.task-action-btn.merge { color: var(--task-merged); }
.task-action-btn:disabled { opacity: 0.48; cursor: wait; }
.task-card-title button { width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.task-more-links { justify-self: start; padding: 4px 0; border: 0; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.75rem; cursor: pointer; }
.task-card:focus-visible, .task-card :is(button, a):focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
@media (hover: hover) and (pointer: fine) {
  .task-card:hover { border-color: var(--border-strong); }
  .task-action-btn:hover:not(:disabled), .task-links a:hover { background: var(--accent-hover); color: var(--text); }
}
@media (pointer: coarse), (max-width: 640px) {
  .task-action-btn, .task-links a, .task-more-links { min-height: 44px; }
  .task-links a { display: inline-flex; align-items: center; }
}
</style>
