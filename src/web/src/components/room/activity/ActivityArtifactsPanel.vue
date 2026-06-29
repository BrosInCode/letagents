<template>
  <section v-if="artifacts.length" class="activity-artifacts" aria-label="Shared artifacts">
    <div class="activity-artifacts-header">
      <div>
        <h3>Shared artifacts</h3>
        <p>{{ artifacts.length === 1 ? '1 linked workflow object' : `${artifacts.length} linked workflow objects` }}</p>
      </div>
      <span class="activity-group-count">{{ artifacts.length }}</span>
    </div>

    <div class="activity-artifact-list">
      <article
        v-for="artifact in visibleArtifacts"
        :key="artifact.identity_key"
        class="activity-artifact-row"
      >
        <div class="activity-artifact-main">
          <div class="activity-artifact-title-line">
            <span class="activity-artifact-kind" :data-kind="artifact.kind">
              {{ artifactKindLabel(artifact.kind) }}
            </span>
            <a
              v-if="artifact.url"
              :href="artifact.url"
              target="_blank"
              rel="noreferrer"
              :title="artifact.url"
            >
              {{ artifactTitle(artifact) }}
            </a>
            <strong v-else>{{ artifactTitle(artifact) }}</strong>
          </div>
          <p>{{ artifactMeta(artifact) }}</p>
        </div>

        <div v-if="artifact.linked_task_ids.length" class="activity-artifact-task-list">
          <span
            v-for="taskId in artifact.linked_task_ids"
            :key="`${artifact.identity_key}:${taskId}`"
            class="activity-artifact-task"
            :title="taskTitle(taskId)"
          >
            {{ taskId }}
          </span>
        </div>
      </article>
    </div>

    <button
      v-if="canToggle"
      class="activity-artifacts-toggle"
      type="button"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show fewer artifacts' : `Show all ${artifacts.length} artifacts` }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  RoomSharedArtifact,
  RoomSharedArtifactKind,
  RoomTask,
} from '@/composables/useRoom'

const props = defineProps<{
  artifacts: readonly RoomSharedArtifact[]
  tasks: readonly RoomTask[]
}>()

const COLLAPSED_ARTIFACT_LIMIT = 5
const expanded = ref(false)
const canToggle = computed(() => props.artifacts.length > COLLAPSED_ARTIFACT_LIMIT)
const visibleArtifacts = computed(() =>
  expanded.value ? props.artifacts : props.artifacts.slice(0, COLLAPSED_ARTIFACT_LIMIT)
)

function artifactKindLabel(kind: RoomSharedArtifactKind): string {
  switch (kind) {
    case 'pull_request':
      return 'PR'
    case 'merge_request':
      return 'MR'
    case 'check_run':
      return 'Check'
    default:
      return kind.replace('_', ' ')
  }
}

function artifactTitle(artifact: RoomSharedArtifact): string {
  if (artifact.title?.trim()) return artifact.title
  if (artifact.ref?.trim()) return artifact.ref
  if (artifact.artifact_number !== null) {
    return `${artifactKindLabel(artifact.kind)} #${artifact.artifact_number}`
  }
  if (artifact.artifact_id?.trim()) return artifact.artifact_id
  return artifactKindLabel(artifact.kind)
}

function artifactMeta(artifact: RoomSharedArtifact): string {
  const parts = [
    artifact.provider,
    artifact.state,
    artifact.ref ? `ref ${artifact.ref}` : null,
    artifact.artifact_number !== null ? `#${artifact.artifact_number}` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

function taskTitle(taskId: string): string {
  const task = props.tasks.find((item) => item.id === taskId)
  return task ? `${task.id}: ${task.title}` : taskId
}
</script>
