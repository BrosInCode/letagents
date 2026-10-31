<template>
  <AgentChanges :records="records" :query="query">
    <template #default="{ record }">
      <template v-for="artifact in [artifactsById.get(record.id)!]" :key="artifact.identity_key">
        <div
          v-if="artifact.kind === 'change_summary' && artifact.detail"
          class="activity-artifact-changes"
        >
          <p class="activity-artifact-changes-summary">
            {{ changeSummaryHeadline(artifact.detail) }}
            <a
              v-if="linkedPr(artifact)"
              class="activity-artifact-changes-pr"
              :href="linkedPr(artifact)!.url"
              target="_blank"
              rel="noreferrer"
            >· PR #{{ linkedPr(artifact)!.number }}{{ prStateSuffix(linkedPr(artifact)!) }}</a>
          </p>
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

        <p v-if="!artifact.detail && !record.url && !record.branch && !record.tasks.length">No further details were shared.</p>
      </template>
    </template>
  </AgentChanges>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import AgentChanges from '../../../../../../shared/ui/agents/AgentChanges.vue'
import { agentChange } from '../../../../../../shared/ui/agents/changes'
import type {
  RoomSharedArtifact,
  RoomTask,
} from '@/composables/useRoom'

const props = defineProps<{
  artifacts: readonly RoomSharedArtifact[]
  tasks: readonly RoomTask[]
  query?: string
  prRepo?: { host: string; owner: string; name: string } | null
}>()

const CHANGE_FILE_COLLAPSED_LIMIT = 3
const artifactsById = computed(() => new Map(props.artifacts.map(artifact => [artifact.identity_key, artifact])))
const records = computed(() => props.artifacts.map(artifact => agentChange({
  id: artifact.identity_key, kind: artifact.kind, provider: artifact.provider,
  title: artifact.title, number: artifact.artifact_number, state: artifact.state,
  time: artifact.updated_at || artifact.first_seen_at, url: artifact.url, branch: artifact.ref,
  tasks: artifact.linked_task_ids.map(id => props.tasks.find(task => task.id === id)?.title || id),
})))
function artifactTitle(artifact: RoomSharedArtifact) { return records.value.find(record => record.id === artifact.identity_key)!.title }

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
// Associate a change_summary with a PR on the same branch (ref), scoped to the
// room's known repository since branch names aren't globally unique. Candidates
// must be same-branch PRs whose URL structurally verifies against the repo and
// carry a usable number+URL. Selection fails closed on ambiguity: a unique open
// PR, or (when none are open) a single lone candidate; otherwise no link.
// Suppressed when the repo is unknown. Computed once, keyed by identity_key.
interface LinkedPr {
  number: number
  url: string
  state: string | null
}
// Structurally verify a PR URL against the room repo + number (not a substring —
// a deceptive host or a /pull/N that disagrees with the number must fail).
function pullRequestUrlMatches(
  url: string,
  scope: { host: string; owner: string; name: string },
  n: number,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.host.toLowerCase() !== scope.host.toLowerCase()) return false
  const segments = parsed.pathname.split('/').filter(Boolean)
  return (
    segments.length >= 4 &&
    segments[0].toLowerCase() === scope.owner.toLowerCase() &&
    segments[1].toLowerCase() === scope.name.toLowerCase() &&
    segments[2] === 'pull' &&
    segments[3] === String(n)
  )
}
const changeSummaryPrLinks = computed(() => {
  const map = new Map<string, LinkedPr>()
  const scope = props.prRepo
  if (!scope?.host || !scope.owner || !scope.name) return map
  for (const artifact of props.artifacts) {
    if (artifact.kind !== 'change_summary') continue
    const ref = artifact.ref?.trim()
    if (!ref) continue
    const candidates = props.artifacts.filter(
      (c): c is RoomSharedArtifact & { url: string; artifact_number: number } =>
        c.kind === 'pull_request' &&
        c.ref?.trim() === ref &&
        c.artifact_number !== null &&
        typeof c.url === 'string' &&
        pullRequestUrlMatches(c.url, scope, c.artifact_number),
    )
    if (!candidates.length) continue
    const open = candidates.filter((c) => (c.state ?? '').toLowerCase() === 'open')
    // Fail closed on ambiguity (fork / differing base branch can share a head ref):
    // a unique open PR, or a single lone candidate when none are open; else no link.
    const chosen =
      open.length === 1
        ? open[0]
        : open.length === 0 && candidates.length === 1
          ? candidates[0]
          : null
    if (!chosen) continue
    map.set(artifact.identity_key, { number: chosen.artifact_number, url: chosen.url, state: chosen.state })
  }
  return map
})
function linkedPr(artifact: RoomSharedArtifact): LinkedPr | null {
  return changeSummaryPrLinks.value.get(artifact.identity_key) ?? null
}
function prStateSuffix(link: LinkedPr): string {
  const state = link.state?.trim()
  return state && state.toLowerCase() !== 'open' ? ` (${state})` : ''
}

function changeSummaryHeadline(detail: ChangeSummaryDetail): string {
  const parts = [`${detail.changedFileCount} ${detail.changedFileCount === 1 ? 'file' : 'files'}`]
  if (detail.additions) parts.push(`+${detail.additions}`)
  if (detail.deletions) parts.push(`−${detail.deletions}`)
  return parts.join('  ')
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
.activity-artifact-changes-pr {
  color: var(--activity-blue, #60a5fa);
  text-decoration: none;
}
.activity-artifact-changes-pr:hover,
.activity-artifact-changes-pr:focus-visible {
  text-decoration: underline;
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
