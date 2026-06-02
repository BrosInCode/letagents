<template>
  <DesktopSurfacePage data-testid="repo-status-view">
    <DesktopSurfaceIntro
      kicker="Room details"
      title="Room context and branch details, in one place."
      description="See where this desktop app is rooted, which branch it is on, and which related worktrees are already open."
    />

    <DesktopSurfaceList data-testid="repo-status-summary">
      <DesktopSurfaceRow>
        <div>
          <p class="surface-title">Repository root</p>
          <p class="surface-subtitle">{{ repoStatus.rootPath }}</p>
        </div>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow>
        <div>
          <p class="surface-title">Current branch</p>
          <p class="surface-subtitle">{{ repoStatus.branch || "No active branch" }}</p>
        </div>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>

    <DesktopSurfaceList data-testid="repo-worktrees-list">
      <DesktopSurfaceRow single-line>
        <div>
          <p class="surface-title">Worktrees</p>
          <p class="surface-subtitle">Open branches that can map cleanly to rooms and focused work.</p>
        </div>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow
        v-for="worktree in repoStatus.worktrees"
        :key="worktree.path"
        :data-current="worktree.isCurrent"
        :data-testid="`repo-worktree-${worktree.path}`"
      >
        <div>
          <p class="surface-title">{{ worktree.branch || "Detached worktree" }}</p>
          <p class="surface-subtitle">{{ worktree.path }}</p>
        </div>
        <template #meta>
          <span class="state-pill" :data-state="worktree.isCurrent ? 'connected' : 'away'">
            {{ worktree.isCurrent ? "current" : "open" }}
          </span>
          <code>{{ worktree.head.slice(0, 10) }}</code>
        </template>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow v-if="!repoStatus.worktrees.length" single-line data-testid="repo-worktrees-empty">
        <p class="surface-title">No worktrees discovered yet.</p>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import type { RepoStatus } from "../../../../../electron/ipc-types";
import DesktopSurfaceIntro from "./ui/DesktopSurfaceIntro.vue";
import DesktopSurfaceList from "./ui/DesktopSurfaceList.vue";
import DesktopSurfacePage from "./ui/DesktopSurfacePage.vue";
import DesktopSurfaceRow from "./ui/DesktopSurfaceRow.vue";

defineProps<{
  repoStatus: RepoStatus;
}>();
</script>
