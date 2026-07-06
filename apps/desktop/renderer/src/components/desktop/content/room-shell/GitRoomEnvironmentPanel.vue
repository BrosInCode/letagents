<template>
  <DesktopEnvironmentPanel title="Environment" data-testid="git-room-environment-panel">
    <DesktopEnvironmentSection>
      <div
        class="git-room-environment-change-card"
        :data-tone="branchChangesTone"
        data-testid="git-room-environment-changes"
      >
        <span class="git-room-environment-change-icon" aria-hidden="true">
          <FileDiff :size="18" />
        </span>
        <div class="git-room-environment-change-copy">
          <strong>Changes</strong>
          <small>{{ branchChangesDescription }}</small>
        </div>
        <div class="git-room-environment-change-stats">
          <span>
            <strong>{{ changeStats.files }}</strong>
            <small>{{ changeStats.filesLabel }}</small>
          </span>
          <span class="git-room-environment-change-added">+{{ changeStats.additions }}</span>
          <span class="git-room-environment-change-deleted">-{{ changeStats.deletions }}</span>
        </div>
      </div>

      <DesktopEnvironmentRow
        label="Linked room"
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
  RepoBranchDelta,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import { repoChangedFileCount } from "../../../../domain/repo-status";
import {
  repoEnvironmentBranchDeltaForRoom,
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
  repoEnvironmentBranchDeltaForRoom(props.room, props.repoStatus, props.gitRoomMatchesActiveRepo)
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
const primaryDelta = computed(() =>
  livePullRequestDelta.value || pullRequestSummary.value?.delta || roomBranchDelta.value
);
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
  const delta = primaryDelta.value;
  if (delta?.baseBranch) return `Compared with ${delta.baseBranch}`;
  if (!currentBranchMatchesRoom.value) {
    return matchingRoomWorktree.value
      ? `Open ${roomBranchLabel.value} to inspect local changes`
      : "Open a local worktree to inspect changes";
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
  if (!url || !window.letagentsDesktop?.app?.getGitHubPullRequestStats) return;
  const requestId = ++pullRequestStatsRequestId;
  const stats = await window.letagentsDesktop.app.getGitHubPullRequestStats(url).catch(() => null);
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
</script>

<style scoped>
.git-room-environment-change-card {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
}

.git-room-environment-change-card[data-tone="positive"] {
  border-color: rgba(118, 245, 111, 0.16);
  background: rgba(118, 245, 111, 0.055);
}

.git-room-environment-change-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  color: rgba(255, 255, 255, 0.72);
}

.git-room-environment-change-card[data-tone="positive"] .git-room-environment-change-icon {
  color: #76f56f;
}

.git-room-environment-change-copy {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.git-room-environment-change-copy strong {
  color: rgba(255, 255, 255, 0.78);
  font-size: 0.94rem;
  font-weight: 680;
}

.git-room-environment-change-copy small {
  min-width: 0;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.42);
  font-size: 0.72rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-room-environment-change-stats {
  grid-column: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 12px;
  min-width: 0;
}

.git-room-environment-change-stats span {
  min-width: 0;
  font-size: 0.88rem;
  font-weight: 780;
  line-height: 1.1;
}

.git-room-environment-change-stats span:first-child {
  display: grid;
  gap: 2px;
  color: rgba(255, 255, 255, 0.72);
}

.git-room-environment-change-stats span:first-child small {
  color: rgba(255, 255, 255, 0.38);
  font-size: 0.62rem;
  font-weight: 680;
}

.git-room-environment-change-added {
  color: #76f56f;
}

.git-room-environment-change-deleted {
  color: #ff6b82;
}

.git-room-environment-pr-state {
  min-width: 0;
}

.git-room-environment-pr-icon {
  color: inherit;
}
</style>
