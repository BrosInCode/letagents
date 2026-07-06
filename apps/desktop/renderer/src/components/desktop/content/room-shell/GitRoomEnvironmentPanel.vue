<template>
  <DesktopEnvironmentPanel title="Environment" data-testid="git-room-environment-panel">
    <DesktopEnvironmentSection>
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
        :label="pullRequestSummary.label"
        :description="pullRequestSummary.description"
        :value="pullRequestSummary.value"
        :tone="pullRequestSummary.tone"
        :actionable="Boolean(pullRequestSummary.url)"
        wrap-label
        test-id="git-room-environment-pull-request"
        @select="openPullRequest"
      >
        <template #icon>
          <GitPullRequest :size="18" aria-hidden="true" class="git-room-environment-pr-icon" />
        </template>
        <template #trailing>
          <span v-if="pullRequestSummary.value" class="git-room-environment-pr-state">
            {{ pullRequestSummary.value }}
          </span>
          <ChevronRight v-if="pullRequestSummary.url" :size="16" aria-hidden="true" />
        </template>
      </DesktopEnvironmentRow>

      <DesktopEnvironmentRow
        label="Branch changes"
        :description="branchChangesDescription"
        :value="branchChangesValue"
        :tone="branchChangesTone"
        test-id="git-room-environment-changes"
      >
        <template #icon>
          <FileDiff :size="18" aria-hidden="true" />
        </template>
      </DesktopEnvironmentRow>
    </DesktopEnvironmentSection>
  </DesktopEnvironmentPanel>
</template>

<script setup lang="ts">
import { ChevronRight, FileDiff, GitBranch, GitPullRequest, Home } from "@lucide/vue";
import { computed } from "vue";
import type {
  DesktopGitHubEventsPage,
  DesktopRoomInfo,
  DesktopRoomSharedArtifact,
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
const branchChangesValue = computed(() => {
  const pullRequestDeltaLabel = repoEnvironmentBranchDeltaLabel(pullRequestSummary.value?.delta);
  if (pullRequestDeltaLabel) return pullRequestDeltaLabel;
  const branchDeltaLabel = repoEnvironmentBranchDeltaLabel(roomBranchDelta.value);
  if (branchDeltaLabel) return branchDeltaLabel;
  if (!currentBranchMatchesRoom.value) {
    return "No local worktree";
  }
  if (changedCount.value === 0) return "No local edits";
  return repoEnvironmentChangeLabel(props.repoStatus, roomBranchDelta.value);
});
const branchChangesDescription = computed(() => {
  const deltaBaseBranch = pullRequestSummary.value?.delta?.baseBranch || roomBranchDelta.value?.baseBranch;
  if (!currentBranchMatchesRoom.value) {
    if (deltaBaseBranch) return `Compared with ${deltaBaseBranch}`;
    return matchingRoomWorktree.value
      ? `Open ${roomBranchLabel.value} to inspect local changes`
      : "Open a local worktree to inspect changes";
  }
  const localState = changedCount.value > 0
    ? repoEnvironmentChangeLabel(props.repoStatus)
    : "No local edits";
  const baseBranch = deltaBaseBranch;
  if (baseBranch) return `${localState} · compared with ${baseBranch}`;
  if (changedCount.value > 0) return localState;
  return "No local edits";
});
const branchChangesTone = computed(() => {
  if (!currentBranchMatchesRoom.value) return "neutral";
  if (props.repoStatus.changes?.conflicted) return "danger";
  return changedCount.value > 0 ? "positive" : "neutral";
});

function openRoomBranch(): void {
  if (currentBranchMatchesRoom.value) return;
  const rootPath = matchingRoomWorktree.value?.path;
  if (rootPath) emit("open-repo-root", rootPath);
}

function openPullRequest(): void {
  const url = pullRequestSummary.value?.url;
  if (url) emit("open-pull-request", url);
}
</script>

<style scoped>
.git-room-environment-pr-state {
  min-width: 0;
}

.git-room-environment-pr-icon {
  color: inherit;
}
</style>
