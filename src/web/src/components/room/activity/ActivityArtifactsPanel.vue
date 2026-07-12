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

        <div
          v-if="artifact.kind === 'change_summary' && artifact.detail"
          class="activity-artifact-changes"
        >
          <p class="activity-artifact-changes-summary">{{ changeSummaryHeadline(artifact.detail) }}</p>
          <ul :id="fileListId(artifact)" class="activity-artifact-file-list">
            <li
              v-for="file in visibleChangeFiles(artifact)"
              :key="file.path"
              class="activity-artifact-file"
            >
              <span class="activity-artifact-file-path" :title="filePathLabel(file)">
                {{ filePathLabel(file) }}
              </span>
              <span class="activity-artifact-file-counts">
                <span v-if="file.binary" class="activity-artifact-file-bin">bin</span>
                <template v-else>
                  <span v-if="file.additions" class="activity-artifact-file-add">+{{ file.additions }}</span>
                  <span v-if="file.deletions" class="activity-artifact-file-del">−{{ file.deletions }}</span>
                </template>
              </span>
            </li>
          </ul>
          <button
            v-if="changeToggleVisible(artifact)"
            class="activity-artifact-file-toggle"
            type="button"
            :aria-expanded="isChangeExpanded(artifact)"
            :aria-controls="fileListId(artifact)"
            :aria-label="changeToggleLabel(artifact)"
            @click="toggleChange(artifact)"
          >
            {{ changeToggleText(artifact) }}
          </button>
          <p v-if="artifact.detail.hiddenFileCount > 0" class="activity-artifact-file-note">
            {{ artifact.detail.hiddenFileCount }} more not shown
          </p>
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
import { computed, ref, useId, watch } from 'vue'
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
const CHANGE_FILE_COLLAPSED_LIMIT = 3
const expanded = ref(false)
const canToggle = computed(() => props.artifacts.length > COLLAPSED_ARTIFACT_LIMIT)
const visibleArtifacts = computed(() =>
  expanded.value ? props.artifacts : props.artifacts.slice(0, COLLAPSED_ARTIFACT_LIMIT)
)

type ChangeSummaryDetail = NonNullable<RoomSharedArtifact['detail']>
const expandedChanges = ref<Set<string>>(new Set())

function changeFiles(artifact: RoomSharedArtifact): ChangeSummaryDetail['files'] {
  return artifact.detail?.files ?? []
}
function isChangeExpanded(artifact: RoomSharedArtifact): boolean {
  return expandedChanges.value.has(artifact.identity_key)
}
function toggleChange(artifact: RoomSharedArtifact): void {
  const next = new Set(expandedChanges.value)
  if (next.has(artifact.identity_key)) next.delete(artifact.identity_key)
  else next.add(artifact.identity_key)
  expandedChanges.value = next
}
function visibleChangeFiles(artifact: RoomSharedArtifact): ChangeSummaryDetail['files'] {
  const files = changeFiles(artifact)
  return isChangeExpanded(artifact) ? files : files.slice(0, CHANGE_FILE_COLLAPSED_LIMIT)
}
function collapsedHiddenCount(artifact: RoomSharedArtifact): number {
  if (isChangeExpanded(artifact)) return 0
  return Math.max(0, changeFiles(artifact).length - CHANGE_FILE_COLLAPSED_LIMIT)
}
// The disclosure only makes sense when there are more files than the collapsed
// limit; a shrink to <= limit removes it even if the row was previously expanded.
function changeToggleVisible(artifact: RoomSharedArtifact): boolean {
  return changeFiles(artifact).length > CHANGE_FILE_COLLAPSED_LIMIT
}
// Globally-unique, collision-safe DOM ids: an SSR-stable per-instance base
// (useId) plus a per-artifact counter keyed by the full unique identity_key —
// unique across multiple panels in one document and across refs that would
// otherwise sanitize alike.
const changePanelIdBase = useId()
const fileListIds = new Map<string, string>()
let fileListIdSeq = 0
function fileListId(artifact: RoomSharedArtifact): string {
  let id = fileListIds.get(artifact.identity_key)
  if (!id) {
    id = `${changePanelIdBase}-change-files-${fileListIdSeq++}`
    fileListIds.set(artifact.identity_key, id)
  }
  return id
}
function changeToggleText(artifact: RoomSharedArtifact): string {
  if (isChangeExpanded(artifact)) return 'Show fewer files'
  const n = collapsedHiddenCount(artifact)
  return `Show ${n} more ${n === 1 ? 'file' : 'files'}`
}
function changeToggleLabel(artifact: RoomSharedArtifact): string {
  return `${changeToggleText(artifact)} for ${artifactTitle(artifact)}`
}

// Prune stale expansion when artifacts update, so a row that went clean (or
// dropped to <= the collapsed limit) never silently reopens expanded on return.
watch(
  () => props.artifacts,
  (artifacts) => {
    const next = new Set<string>()
    for (const artifact of artifacts) {
      if (
        expandedChanges.value.has(artifact.identity_key) &&
        artifact.kind === 'change_summary' &&
        changeFiles(artifact).length > CHANGE_FILE_COLLAPSED_LIMIT
      ) {
        next.add(artifact.identity_key)
      }
    }
    if (next.size !== expandedChanges.value.size) expandedChanges.value = next
  },
)
function filePathLabel(file: ChangeSummaryDetail['files'][number]): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
}
function changeSummaryHeadline(detail: ChangeSummaryDetail): string {
  const parts = [`${detail.changedFileCount} ${detail.changedFileCount === 1 ? 'file' : 'files'}`]
  if (detail.additions) parts.push(`+${detail.additions}`)
  if (detail.deletions) parts.push(`−${detail.deletions}`)
  return parts.join('  ')
}

function artifactKindLabel(kind: RoomSharedArtifactKind): string {
  switch (kind) {
    case 'pull_request':
      return 'PR'
    case 'merge_request':
      return 'MR'
    case 'check_run':
      return 'Check'
    case 'change_summary':
      return 'Changes'
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

<style scoped>
.activity-artifact-changes {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--activity-border, #27272a);
}
.activity-artifact-changes-summary {
  margin: 0;
  font-size: 0.72rem;
  color: var(--activity-text-secondary, #a1a1aa);
  font-variant-numeric: tabular-nums;
}
.activity-artifact-file-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.activity-artifact-file {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  font-size: 0.74rem;
}
.activity-artifact-file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--activity-text-secondary, #a1a1aa);
}
.activity-artifact-file-counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.activity-artifact-file-add {
  color: var(--activity-green, #4ade80);
}
.activity-artifact-file-del {
  color: var(--activity-red, #f87171);
}
.activity-artifact-file-bin {
  color: var(--activity-text-tertiary, #71717a);
}
.activity-artifact-file-toggle {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 4px;
  margin-left: -4px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--activity-text-secondary, #a1a1aa);
  font-size: 0.72rem;
  cursor: pointer;
}
.activity-artifact-file-toggle:hover {
  color: var(--text, #fafafa);
}
.activity-artifact-file-toggle:focus-visible {
  color: var(--text, #fafafa);
  outline: 2px solid var(--activity-blue, #60a5fa);
  outline-offset: 1px;
}
@media (pointer: coarse) {
  .activity-artifact-file-toggle {
    min-height: 44px;
  }
}
.activity-artifact-file-note {
  margin: 0;
  font-size: 0.7rem;
  color: var(--activity-text-tertiary, #71717a);
}
</style>
