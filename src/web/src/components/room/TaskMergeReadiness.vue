<template>
  <section
    class="task-merge-readiness"
    :data-tone="readiness.tone"
    aria-label="Merge readiness"
  >
    <div class="merge-readiness-topline">
      <div class="merge-readiness-title">
        <span class="merge-readiness-dot" aria-hidden="true"></span>
        <span>{{ readiness.label }}</span>
      </div>
      <a
        v-if="status.pr_url"
        class="merge-readiness-link"
        :href="status.pr_url"
        target="_blank"
        rel="noreferrer"
      >
        {{ prLabel }}
      </a>
    </div>

    <p class="merge-readiness-summary">{{ readiness.summary }}</p>

    <div class="merge-readiness-signals">
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ checkSignal }}</span>
        <span class="signal-label">CI</span>
      </div>
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ reviewSignal }}</span>
        <span class="signal-label">Review</span>
      </div>
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ prStateSignal }}</span>
        <span class="signal-label">PR state</span>
      </div>
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ boardReviewSignal }}</span>
        <span class="signal-label">Board review</span>
      </div>
    </div>

    <ul v-if="readiness.blockers.length" class="merge-readiness-blockers">
      <li v-for="blocker in readiness.blockers" :key="blocker">{{ blocker }}</li>
    </ul>

    <div v-if="status.reviews.length" class="merge-readiness-reviews">
      <span
        v-for="review in status.reviews"
        :key="`${review.actor || 'reviewer'}:${review.state || 'pending'}`"
        class="merge-review-chip"
        :data-state="normalizedReviewState(review.state)"
      >
        {{ review.actor || 'reviewer' }}: {{ reviewStateLabel(review.state) }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { useTaskMergeReadiness } from './task-merge-readiness/useTaskMergeReadiness'

const props = defineProps<{
  status: TaskGitHubArtifactStatus
  task?: RoomTask
}>()

const status = toRef(props, 'status')
const task = toRef(props, 'task')

const {
  boardReviewSignal,
  checkSignal,
  normalizedReviewState,
  prLabel,
  prStateSignal,
  readiness,
  reviewSignal,
  reviewStateLabel,
} = useTaskMergeReadiness(status, task)
</script>

<style scoped src="./task-merge-readiness/TaskMergeReadiness.css"></style>
