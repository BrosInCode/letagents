<template>
  <section class="surface-page" data-testid="repo-status-view">
    <article class="surface-intro">
      <p class="sidebar-label">Room details</p>
      <h3>Room context and branch details, in one place.</h3>
      <p>
        See where this desktop app is rooted, which branch it is on, and which related worktrees are already open.
      </p>
    </article>

    <div class="surface-list" data-testid="repo-status-summary">
      <article class="surface-row">
        <div>
          <p class="surface-title">Repository root</p>
          <p class="surface-subtitle">{{ repoStatus.rootPath }}</p>
        </div>
      </article>

      <article class="surface-row">
        <div>
          <p class="surface-title">Current branch</p>
          <p class="surface-subtitle">{{ repoStatus.branch || "No active branch" }}</p>
        </div>
      </article>
    </div>

    <div class="surface-list" data-testid="repo-worktrees-list">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Worktrees</p>
          <p class="surface-subtitle">Open branches that can map cleanly to rooms and focused work.</p>
        </div>
      </article>

      <article
        v-for="worktree in repoStatus.worktrees"
        :key="worktree.path"
        class="surface-row"
        :data-current="worktree.isCurrent"
        :data-testid="`repo-worktree-${worktree.path}`"
      >
        <div>
          <p class="surface-title">{{ worktree.branch || "Detached worktree" }}</p>
          <p class="surface-subtitle">{{ worktree.path }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" :data-state="worktree.isCurrent ? 'connected' : 'away'">
            {{ worktree.isCurrent ? "current" : "open" }}
          </span>
          <code>{{ worktree.head.slice(0, 10) }}</code>
        </div>
      </article>

      <article v-if="!repoStatus.worktrees.length" class="surface-row single-line" data-testid="repo-worktrees-empty">
        <p class="surface-title">No worktrees discovered yet.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { RepoStatus } from "../../../../../electron/ipc-types";

defineProps<{
  repoStatus: RepoStatus;
}>();
</script>
