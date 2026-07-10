<template>
  <section class="settings-panel" data-testid="settings-runtime-panel">
    <div class="settings-control-list">
      <SettingsRow title="Desktop runtime" :description="apiEndpointLabel" badge="local" badge-state="connected">
        <code v-if="appInfo?.workspaceRoot">{{ appInfo.workspaceRoot }}</code>
        <template #action>
          <code>{{ versionLabel }}</code>
        </template>
      </SettingsRow>

      <SettingsRow title="Repository root" :description="repoStatus?.rootPath || 'Repository status unavailable.'" />
      <SettingsRow title="Current branch" :description="repoStatus?.branch || 'No active branch.'" />
    </div>

    <div class="surface-list settings-system-list" data-testid="repo-worktrees-list">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Worktrees</p>
          <p class="surface-subtitle">Open branches that can map cleanly to rooms and focused work.</p>
        </div>
      </article>

      <article
        v-for="worktree in repoStatus?.worktrees || []"
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

      <article v-if="!repoStatus?.worktrees?.length" class="surface-row single-line" data-testid="repo-worktrees-empty">
        <p class="surface-title">No worktrees discovered yet.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAppInfo,
  DesktopAuthStatus,
  RepoStatus,
} from "../../../../../../electron/ipc-types";
import SettingsRow from "../SettingsRow.vue";

const props = defineProps<{
  appInfo: DesktopAppInfo | null;
  authStatus: DesktopAuthStatus | null;
  repoStatus: RepoStatus | null;
}>();

const apiEndpointLabel = computed(() => props.authStatus?.apiUrl || props.appInfo?.apiUrl || "API endpoint unavailable");

const versionLabel = computed(() => {
  if (!props.appInfo) return "version unavailable";
  return `Electron ${props.appInfo.versions.electron}`;
});
</script>
