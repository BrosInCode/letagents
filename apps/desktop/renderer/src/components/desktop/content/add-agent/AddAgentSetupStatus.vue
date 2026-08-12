<template>
  <section class="desktop-add-agent-status" :data-state="preflight?.status || 'loading'">
    <div class="desktop-add-agent-status-header">
      <div>
        <span>{{ providerName || "Provider" }}</span>
        <h4>{{ statusTitle }}</h4>
      </div>
      <div class="desktop-add-agent-status-actions">
        <span
          class="desktop-add-agent-status-pill"
          :data-state="preflight?.status || 'loading'"
        >{{ statusLabel }}</span>
        <button type="button" :disabled="loading" @click="emit('refresh')">
          {{ loading ? "Checking..." : providerName ? "Check again" : "Try again" }}
        </button>
      </div>
    </div>
    <p v-if="!error && preflight?.status !== 'error'">{{ statusDescription }}</p>
    <AddAgentFeedback
      v-if="error || preflight?.status === 'error'"
      :message="error || statusDescription"
      tone="error"
    />

    <dl class="desktop-add-agent-checks">
      <div><dt>Agent app</dt><dd>{{ runtimeLabel }}</dd></div>
      <div><dt>LetAgents connection</dt><dd>{{ bridgeLabel }}</dd></div>
      <div><dt>Project folder</dt><dd>{{ repoLabel }}</dd></div>
    </dl>

    <section
      v-if="showWorktrees"
      class="desktop-add-agent-worktrees"
      data-testid="desktop-add-agent-worktree-picker"
      aria-label="Matching worktrees"
    >
      <div class="desktop-add-agent-worktrees-header">
        <span>Existing worktrees</span>
        <p>{{ worktreeDescription }}</p>
      </div>
      <button
        v-for="worktree in worktrees"
        :key="worktree.path"
        type="button"
        class="desktop-add-agent-worktree"
        :data-current="worktree.isCurrent"
        :data-testid="`desktop-add-agent-worktree-${worktree.path}`"
        @click="emit('choose-worktree', worktree.path)"
      >
        <GitBranch :size="14" aria-hidden="true" />
        <span><strong>{{ worktree.branch }}</strong><small>{{ worktree.path }}</small></span>
        <code>{{ worktree.head.slice(0, 7) }}</code>
      </button>
      <p v-if="!worktrees.length" class="desktop-add-agent-worktrees-empty">
        No existing worktree is on {{ preflight?.branchMismatch?.expectedBranch }}.
      </p>
    </section>

    <section
      v-if="preflight?.nextAction === 'authenticate' && authCommand"
      class="desktop-add-agent-auth-command"
      aria-label="Agent sign-in command"
    >
      <span>Sign-in command</span>
      <code>{{ authCommand }}</code>
    </section>

    <section
      v-if="preflight?.nextAction === 'install_external_runtime' && installCommand"
      class="desktop-add-agent-auth-command"
      aria-label="Agent installation command"
    >
      <span>Install command</span>
      <code>{{ installCommand }}</code>
    </section>

    <slot />
  </section>
</template>

<script setup lang="ts">
import { GitBranch } from "@lucide/vue";
import AddAgentFeedback from "./AddAgentFeedback.vue";
import type {
  DesktopAgentProviderPreflight,
  RepoWorktreeEntry,
} from "../../../../../../electron/ipc-types";

defineProps<{
  providerName: string | null;
  preflight: DesktopAgentProviderPreflight | null;
  loading: boolean;
  statusTitle: string;
  statusDescription: string;
  statusLabel: string;
  runtimeLabel: string;
  bridgeLabel: string;
  repoLabel: string;
  showWorktrees: boolean;
  worktrees: RepoWorktreeEntry[];
  worktreeDescription: string;
  authCommand: string | null;
  installCommand: string | null;
  error: string | null;
}>();
const emit = defineEmits<{
  refresh: [];
  "choose-worktree": [path: string];
}>();
</script>
<style scoped src="./AddAgentSetupStatus.css"></style>
