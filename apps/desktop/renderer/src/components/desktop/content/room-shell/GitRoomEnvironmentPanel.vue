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
import { ChevronRight, FileDiff, GitBranch, Home } from "@lucide/vue";
import { computed } from "vue";
import type { DesktopRoomInfo, RepoStatus } from "../../../../../../electron/ipc-types";
import { repoChangedFileCount } from "../../../../domain/repo-status";
import {
  repoEnvironmentBranchDeltaForRoom,
  repoEnvironmentBranchDeltaLabel,
  repoEnvironmentChangeLabel,
  repoEnvironmentCurrentBranchMatchesRoom,
  repoEnvironmentLinkedRoomLabel,
  repoEnvironmentRoomRefLabel,
} from "../../../../domain/repo-environment";
import DesktopEnvironmentPanel from "../../controls/DesktopEnvironmentPanel.vue";
import DesktopEnvironmentRow from "../../controls/DesktopEnvironmentRow.vue";
import DesktopEnvironmentSection from "../../controls/DesktopEnvironmentSection.vue";

const props = defineProps<{
  room: DesktopRoomInfo;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
}>();

const emit = defineEmits<{
  "open-repo-root": [rootPath: string];
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
const canOpenRoomBranch = computed(() => {
  if (!props.gitRoomMatchesActiveRepo || !props.room.gitRoom || !props.repoStatus.isGitRepo) return false;
  return currentBranchMatchesRoom.value || Boolean(matchingRoomWorktree.value?.path);
});
const openBranchLabel = computed(() => `Open ${roomBranchLabel.value}`);
const openBranchDescription = computed(() => {
  if (currentBranchMatchesRoom.value) return "Already open";
  if (matchingRoomWorktree.value) return "Switch to its workspace";
  return "No local workspace for this branch";
});
const branchChangesValue = computed(() => {
  if (!currentBranchMatchesRoom.value) {
    return repoEnvironmentBranchDeltaLabel(roomBranchDelta.value) || "Unknown";
  }
  if (changedCount.value === 0) {
    return repoEnvironmentBranchDeltaLabel(roomBranchDelta.value) || "Clean";
  }
  return repoEnvironmentChangeLabel(props.repoStatus);
});
const branchChangesDescription = computed(() => {
  if (!currentBranchMatchesRoom.value) {
    if (roomBranchDelta.value?.baseBranch) return `Compared with ${roomBranchDelta.value.baseBranch}`;
    return matchingRoomWorktree.value
      ? `Open ${roomBranchLabel.value} to check workspace changes`
      : "No workspace open for this branch";
  }
  if (changedCount.value > 0) return "Uncommitted changes";
  if (roomBranchDelta.value?.baseBranch) return `Compared with ${roomBranchDelta.value.baseBranch}`;
  return "No uncommitted changes";
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
</script>
