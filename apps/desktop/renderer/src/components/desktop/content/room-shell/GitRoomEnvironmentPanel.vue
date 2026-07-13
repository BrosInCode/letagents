<template>
  <DesktopEnvironmentPanel
    title="Work"
    :subtitle="roomBranchLabel"
    :show-title="false"
    data-testid="git-room-environment-panel"
  >
    <DesktopEnvironmentSection>
      <section
        class="git-room-work-receipt"
        :data-tone="branchChangesTone"
        :data-available="changesAvailable"
        data-testid="git-room-environment-changes"
      >
        <header class="git-room-work-receipt-header">
          <span class="git-room-work-receipt-icon" aria-hidden="true">
            <FileDiff :size="18" />
          </span>
          <div>
            <small>Changes</small>
            <strong>{{ changeReceiptTitle }}</strong>
          </div>
          <span v-if="isClean" class="git-room-work-receipt-clean">Clean</span>
        </header>

        <template v-if="changesAvailable">
          <div v-if="!isClean" class="git-room-work-receipt-stats" aria-live="polite">
            <strong>{{ changeStats.files }} {{ changeStats.filesLabel }}</strong>
            <span class="git-room-environment-change-added">+{{ changeStats.additions }}</span>
            <span class="git-room-environment-change-deleted">−{{ changeStats.deletions }}</span>
          </div>
          <div
            v-if="!isClean"
            class="git-room-work-diff-rail"
            :data-empty="diffRail.empty"
            aria-hidden="true"
          >
            <span class="is-added" :style="{ flexGrow: diffRail.additions }"></span>
            <span class="is-deleted" :style="{ flexGrow: diffRail.deletions }"></span>
          </div>
          <ul v-if="latestChangedFiles.length" class="git-room-work-file-list">
            <li v-for="file in latestChangedFiles" :key="file.path">
              <span class="git-room-work-file-status" :data-status="fileStatusLabel(file.status)">{{ fileStatusLabel(file.status) }}</span>
              <span class="git-room-work-file-path" :title="filePathLabel(file)">{{ filePathLabel(file) }}</span>
              <span class="git-room-work-file-counts">
                <small v-if="file.binary">bin</small>
                <template v-else>
                  <small v-if="file.additions" class="git-room-environment-change-added">+{{ file.additions }}</small>
                  <small v-if="file.deletions" class="git-room-environment-change-deleted">−{{ file.deletions }}</small>
                </template>
              </span>
            </li>
          </ul>
          <p>{{ branchChangesDescription }}</p>
        </template>

        <div v-else class="git-room-work-receipt-empty">
          <p>{{ branchChangesDescription }}</p>
          <button v-if="canOpenRoomBranch" type="button" @click="openRoomBranch">
            Open worktree
            <ChevronRight :size="15" aria-hidden="true" />
          </button>
        </div>
      </section>
    </DesktopEnvironmentSection>

    <DesktopEnvironmentSection title="Context">
      <DesktopEnvironmentRow
        label="Room"
        :description="linkedRoomLabel"
        wrap-label
        test-id="git-room-environment-linked-room"
      >
        <template #icon>
          <Home :size="18" aria-hidden="true" />
        </template>
      </DesktopEnvironmentRow>

      <DesktopEnvironmentRow
        :label="openBranchLabel"
        :description="openBranchDescription"
        :actionable="canOpenRoomBranch"
        :disabled="currentBranchMatchesRoom"
        wrap-label
        test-id="git-room-environment-open-branch"
        @select="openRoomBranch"
      >
        <template #icon>
          <GitBranch :size="18" aria-hidden="true" />
        </template>
        <template #trailing>
          <ChevronRight v-if="canOpenRoomBranch" :size="16" aria-hidden="true" />
        </template>
      </DesktopEnvironmentRow>

      <DesktopEnvironmentRow
        v-if="pullRequestSummary"
        :label="pullRequestLabel"
        :description="pullRequestDescription"
        :value="pullRequestState"
        :tone="pullRequestTone"
        :actionable="Boolean(pullRequestUrl)"
        wrap-label
        test-id="git-room-environment-pull-request"
        @select="openPullRequest"
      >
        <template #icon>
          <GitPullRequest :size="18" aria-hidden="true" class="git-room-environment-pr-icon" />
        </template>
        <template #trailing>
          <span v-if="pullRequestState" class="git-room-environment-pr-state">
            {{ pullRequestState }}
          </span>
          <ChevronRight v-if="pullRequestUrl" :size="16" aria-hidden="true" />
        </template>
      </DesktopEnvironmentRow>
    </DesktopEnvironmentSection>
  </DesktopEnvironmentPanel>
</template>

<script setup lang="ts">
import { ChevronRight, FileDiff, GitBranch, GitPullRequest, Home } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type {
  DesktopGitHubEventsPage,
  DesktopGitHubPullRequestStats,
  DesktopRoomInfo,
  DesktopRoomSharedArtifact,
  DesktopRoomSharedArtifactChangedFile,
  RepoBranchDelta,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import { repoChangedFileCount } from "../../../../domain/repo-status";
import { splitChangeSummaryFiles } from "../../../../domain/room-artifacts";
import {
  repoEnvironmentInspectableBranchDeltaForRoom,
  repoEnvironmentBranchDeltaLabel,
  repoEnvironmentChangeLabel,
  repoEnvironmentCurrentBranchMatchesRoom,
  repoEnvironmentLinkedRoomLabel,
  repoEnvironmentPullRequestForRoom,
  repoEnvironmentRoomRefLabel,
} from "../../../../domain/repo-environment";
import DesktopEnvironmentPanel from "../../controls/DesktopEnvironmentPanel.vue";
import DesktopEnvironmentRow from "../../controls/DesktopEnvironmentRow.vue";
import DesktopEnvironmentSection from "../../controls/DesktopEnvironmentSection.vue";
import { desktopIpc } from "../../../../ipc/index.js";

const props = defineProps<{
  room: DesktopRoomInfo;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
  roomArtifacts: DesktopRoomSharedArtifact[];
  githubEvents: DesktopGitHubEventsPage | null;
}>();

const emit = defineEmits<{
  "open-repo-root": [rootPath: string];
  "open-pull-request": [url: string];
}>();

const livePullRequestStats = ref<DesktopGitHubPullRequestStats | null>(null);
let pullRequestStatsRequestId = 0;

const changedCount = computed(() => repoChangedFileCount(props.repoStatus));
const linkedRoomLabel = computed(() => repoEnvironmentLinkedRoomLabel(props.room));
const roomBranchLabel = computed(() => repoEnvironmentRoomRefLabel(props.room) || "this branch");
const roomBranchDelta = computed(() =>
  repoEnvironmentInspectableBranchDeltaForRoom(props.room, props.repoStatus, props.gitRoomMatchesActiveRepo)
);
const currentBranchMatchesRoom = computed(() =>
  repoEnvironmentCurrentBranchMatchesRoom(props.room, props.repoStatus, props.gitRoomMatchesActiveRepo)
);
const matchingRoomWorktree = computed(() => {
  if (!props.gitRoomMatchesActiveRepo) return null;
  const roomBranch = roomBranchLabel.value;
  return props.repoStatus.worktrees.find((worktree) => worktree.branch === roomBranch) || null;
});
const pullRequestSummary = computed(() =>
  repoEnvironmentPullRequestForRoom(props.room, props.roomArtifacts, props.githubEvents?.events || [])
);
const pullRequestUrl = computed(() => pullRequestSummary.value?.url || livePullRequestStats.value?.url || null);
const livePullRequestDelta = computed<RepoBranchDelta | null>(() => {
  const stats = livePullRequestStats.value;
  if (!stats) return null;
  return {
    branch: stats.headRefName,
    filesChanged: stats.changedFiles,
    additions: stats.additions,
    deletions: stats.deletions,
    baseBranch: stats.baseRefName,
  };
});
const latestChangeSummary = computed(() => [...props.roomArtifacts]
  .filter((artifact) =>
    artifact.kind === "change_summary" &&
    (!artifact.ref || artifact.ref === roomBranchLabel.value)
  )
  .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null
);
const artifactDelta = computed<RepoBranchDelta | null>(() => {
  const artifact = latestChangeSummary.value;
  if (!artifact) return null;
  if (artifact.state === "clean") {
    return {
      branch: artifact.ref || roomBranchLabel.value,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      baseBranch: null,
    };
  }
  const detail = artifact.detail;
  if (detail?.type !== "change_summary") return null;
  return {
    branch: artifact.ref || roomBranchLabel.value,
    filesChanged: detail.changedFileCount,
    additions: detail.additions,
    deletions: detail.deletions,
    baseBranch: null,
  };
});
const primaryDelta = computed(() => {
  if (artifactDelta.value) return artifactDelta.value;
  const pullRequestDelta = livePullRequestDelta.value || pullRequestSummary.value?.delta || null;
  if (pullRequestDelta) return pullRequestDelta;
  const delta = roomBranchDelta.value;
  if (!delta) return null;
  if (changedCount.value > 0 && isEmptyDelta(delta)) return null;
  return delta;
});
const latestChangedFiles = computed(() => {
  const detail = latestChangeSummary.value?.detail;
  return detail?.type === "change_summary" ? splitChangeSummaryFiles(detail.files, false).visible : [];
});
const changesAvailable = computed(() => Boolean(primaryDelta.value) || currentBranchMatchesRoom.value);
const isClean = computed(() => changesAvailable.value
  && changeStats.value.files === "0"
  && changeStats.value.additions === "0"
  && changeStats.value.deletions === "0"
);
const changeReceiptTitle = computed(() => {
  if (!changesAvailable.value) return `No checkout for ${roomBranchLabel.value}`;
  if (isClean.value) return "Working tree clean";
  return latestChangeSummary.value ? "Latest reported work" : "Branch changes";
});
const diffRail = computed(() => {
  const additions = Number(primaryDelta.value?.additions || 0);
  const deletions = Number(primaryDelta.value?.deletions || 0);
  return {
    additions: Math.max(0, additions),
    deletions: Math.max(0, deletions),
    empty: additions + deletions === 0,
  };
});
const pullRequestLabel = computed(() =>
  livePullRequestStats.value
    ? `PR #${livePullRequestStats.value.number}`
    : pullRequestSummary.value?.label || "Pull request"
);
const pullRequestDescription = computed(() =>
  livePullRequestStats.value?.title || pullRequestSummary.value?.description || null
);
const pullRequestState = computed(() =>
  pullRequestStateLabel(livePullRequestStats.value?.state) || pullRequestSummary.value?.value || null
);
const pullRequestTone = computed(() =>
  pullRequestStatsTone(livePullRequestStats.value?.state) || pullRequestSummary.value?.tone || "neutral"
);
const canOpenRoomBranch = computed(() => {
  if (!props.gitRoomMatchesActiveRepo || !props.room.gitRoom || !props.repoStatus.isGitRepo) return false;
  return !currentBranchMatchesRoom.value && Boolean(matchingRoomWorktree.value?.path);
});
const openBranchLabel = computed(() =>
  currentBranchMatchesRoom.value ? "Local worktree" : "Open local worktree"
);
const openBranchDescription = computed(() => {
  if (currentBranchMatchesRoom.value) return `${roomBranchLabel.value} is open on this machine`;
  if (matchingRoomWorktree.value) return roomBranchLabel.value;
  return "No local worktree for this branch";
});
const changeStats = computed(() => {
  const delta = primaryDelta.value;
  if (delta) {
    return {
      files: delta.filesChanged.toLocaleString(),
      filesLabel: delta.filesChanged === 1 ? "file" : "files",
      additions: delta.additions.toLocaleString(),
      deletions: delta.deletions.toLocaleString(),
    };
  }
  return {
    files: changedCount.value.toLocaleString(),
    filesLabel: changedCount.value === 1 ? "file" : "files",
    additions: "0",
    deletions: "0",
  };
});
const branchChangesDescription = computed(() => {
  if (latestChangeSummary.value) return "Reported from the latest room work artifact.";
  const delta = primaryDelta.value;
  if (delta?.baseBranch) return `Compared with ${delta.baseBranch}`;
  if (!currentBranchMatchesRoom.value) {
    return matchingRoomWorktree.value
      ? `Open ${roomBranchLabel.value} to inspect local changes`
      : `Create or open the ${roomBranchLabel.value} worktree to inspect changes.`;
  }
  const localState = changedCount.value > 0
    ? repoEnvironmentChangeLabel(props.repoStatus)
    : "No local edits";
  if (changedCount.value > 0) return localState;
  return "No local edits";
});
const branchChangesTone = computed(() => {
  if (primaryDelta.value) return "positive";
  if (!currentBranchMatchesRoom.value) return "neutral";
  if (props.repoStatus.changes?.conflicted) return "danger";
  return changedCount.value > 0 ? "positive" : "neutral";
});

watch(
  () => pullRequestSummary.value?.url || null,
  (url) => {
    void refreshPullRequestStats(url);
  },
  { immediate: true },
);

function openRoomBranch(): void {
  if (currentBranchMatchesRoom.value) return;
  const rootPath = matchingRoomWorktree.value?.path;
  if (rootPath) emit("open-repo-root", rootPath);
}

function openPullRequest(): void {
  const url = pullRequestUrl.value;
  if (url) emit("open-pull-request", url);
}

async function refreshPullRequestStats(url: string | null): Promise<void> {
  livePullRequestStats.value = null;
  if (!url || !desktopIpc.app?.getGitHubPullRequestStats) return;
  const requestId = ++pullRequestStatsRequestId;
  const stats = await desktopIpc.app.getGitHubPullRequestStats(url).catch(() => null);
  if (requestId !== pullRequestStatsRequestId) return;
  livePullRequestStats.value = stats;
}

function pullRequestStateLabel(state: DesktopGitHubPullRequestStats["state"] | null | undefined): string | null {
  if (!state || state === "unknown") return null;
  return state[0].toUpperCase() + state.slice(1);
}

function pullRequestStatsTone(
  state: DesktopGitHubPullRequestStats["state"] | null | undefined,
): "neutral" | "positive" | "attention" | "danger" | null {
  if (!state || state === "unknown") return null;
  if (state === "closed") return "danger";
  if (state === "draft") return "attention";
  return "positive";
}

function isEmptyDelta(delta: RepoBranchDelta): boolean {
  return delta.filesChanged === 0 && delta.additions === 0 && delta.deletions === 0;
}

function fileStatusLabel(status: string): string {
  const normalized = status.trim().toUpperCase();
  if (normalized.startsWith("A")) return "A";
  if (normalized.startsWith("D")) return "D";
  if (normalized.startsWith("R")) return "R";
  return "M";
}

function filePathLabel(file: DesktopRoomSharedArtifactChangedFile): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}
</script>

<style scoped>
.git-room-work-receipt {
  display: grid;
  gap: 16px;
  padding: 2px 0 4px;
}

.git-room-work-receipt-header {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 15px;
}

.git-room-work-receipt-icon {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(119, 197, 232, 0.09);
  color: rgba(174, 219, 240, 0.8);
}

.git-room-work-receipt[data-tone="positive"] .git-room-work-receipt-icon {
  background: rgba(126, 231, 135, 0.1);
  color: #7ee787;
}

.git-room-work-receipt[data-tone="danger"] .git-room-work-receipt-icon {
  background: rgba(255, 123, 134, 0.1);
  color: #ff7b86;
}

.git-room-work-receipt-header > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.git-room-work-receipt-header small {
  color: rgba(255, 255, 255, 0.36);
  font-size: 0.62rem;
  font-weight: 760;
  letter-spacing: 0.07em;
  line-height: 1;
  text-transform: uppercase;
}

.git-room-work-receipt-header strong {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.88);
  font-size: 0.96rem;
  font-weight: 720;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-room-work-receipt-clean {
  padding: 4px 7px;
  border-radius: 999px;
  background: rgba(126, 231, 135, 0.1);
  color: #7ee787;
  font-size: 0.64rem;
  font-weight: 750;
}

.git-room-work-receipt-stats {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.git-room-work-receipt-stats > strong {
  color: rgba(255, 255, 255, 0.76);
  font-size: 0.78rem;
  font-weight: 660;
}

.git-room-work-receipt-stats > span {
  font-size: 0.78rem;
  font-weight: 760;
}

.git-room-work-diff-rail {
  display: flex;
  gap: 2px;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
}

.git-room-work-diff-rail > span {
  min-width: 3px;
}

.git-room-work-diff-rail .is-added {
  background: #7ee787;
}

.git-room-work-diff-rail .is-deleted {
  background: #ff7b86;
}

.git-room-work-diff-rail[data-empty="true"] > span {
  display: none;
}

.git-room-work-file-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.git-room-work-file-list li {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.git-room-work-file-status {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.055);
  color: rgba(255, 255, 255, 0.5);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.6rem;
  font-weight: 760;
}

.git-room-work-file-status[data-status^="A"] { color: #7ee787; }
.git-room-work-file-status[data-status^="D"] { color: #ff7b86; }
.git-room-work-file-status[data-status^="R"] { color: #77c5e8; }

.git-room-work-file-path {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.68);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-room-work-file-counts {
  display: inline-flex;
  gap: 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.git-room-work-file-counts small {
  font-size: 0.64rem;
  font-weight: 700;
}

.git-room-work-receipt p {
  margin: 0;
  color: rgba(255, 255, 255, 0.4);
  font-size: 0.7rem;
  font-weight: 560;
  line-height: 1.45;
}

.git-room-work-receipt-empty {
  display: grid;
  gap: 14px;
  padding-left: 43px;
}

.git-room-work-receipt-empty button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  justify-self: start;
  min-height: 30px;
  padding: 6px 10px;
  border: 1px solid rgba(119, 197, 232, 0.22);
  border-radius: 8px;
  background: rgba(119, 197, 232, 0.09);
  color: rgba(205, 235, 248, 0.86);
  font: inherit;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
  transition:
    background-color 140ms var(--ease-out),
    border-color 140ms var(--ease-out),
    transform 140ms var(--ease-out);
}

.git-room-work-receipt-empty button:hover,
.git-room-work-receipt-empty button:focus-visible {
  border-color: rgba(119, 197, 232, 0.4);
  background: rgba(119, 197, 232, 0.14);
}

.git-room-work-receipt-empty button:focus-visible {
  outline: 2px solid rgba(119, 197, 232, 0.55);
  outline-offset: 2px;
}

.git-room-work-receipt-empty button:active {
  transform: scale(0.975);
}

.git-room-environment-change-added {
  color: #7ee787;
}

.git-room-environment-change-deleted {
  color: #ff7b86;
}

.git-room-environment-pr-state {
  min-width: 0;
}

.git-room-environment-pr-icon {
  color: inherit;
}

@media (hover: none), (pointer: coarse) {
  .git-room-work-receipt-empty button:hover {
    border-color: rgba(119, 197, 232, 0.22);
    background: rgba(119, 197, 232, 0.09);
  }
}

@media (prefers-reduced-motion: reduce) {
  .git-room-work-receipt-empty button {
    transition-property: background-color, border-color;
  }

  .git-room-work-receipt-empty button:active {
    transform: none;
  }
}
</style>
