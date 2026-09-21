<template>
  <section class="desktop-add-agent-status" :data-state="secureStorageNeedsAttention ? 'error' : preflight?.status || 'loading'">
    <div v-if="needsAttention" class="desktop-add-agent-status-header">
      <div>
        <h4>{{ statusTitle }}</h4>
      </div>
      <div class="desktop-add-agent-status-actions">
        <button type="button" :disabled="loading" @click="emit('refresh')">
          {{ loading ? "Checking..." : providerName ? "Check again" : "Try again" }}
        </button>
      </div>
    </div>
    <p v-if="needsAttention && !error && preflight?.status !== 'error'">{{ statusDescription }}</p>
    <AddAgentFeedback
      v-if="error || preflight?.status === 'error'"
      message="Check the agent app and selected project, then choose Check again."
      tone="error"
    />
    <details v-if="error || preflight?.status === 'error'">
      <summary tabindex="0">Technical details</summary>
      <p>{{ error || statusDescription }}</p>
    </details>

    <details
      class="desktop-add-agent-setup-details"
      :open="needsAttention"
      :data-attention="needsAttention"
    >
      <summary tabindex="0">Setup details</summary>
      <dl class="desktop-add-agent-checks">
        <div><dt>Agent app</dt><dd>{{ runtimeLabel }}</dd></div>
        <div><dt>LetAgents connection</dt><dd>{{ bridgeLabel }}</dd></div>
        <div><dt>Project folder</dt><dd>{{ repoLabel }}</dd></div>
        <div
          v-if="showSecureStorage"
          :data-attention="secureStorageNeedsAttention"
        >
          <dt>Secure storage</dt>
          <dd>{{ secureStorageLabel }}</dd>
          <button
            v-if="secureStorageNeedsAttention && canOpenSecureStorage"
            type="button"
            @click="emit('open-secure-storage')"
          >Open Keychain Access</button>
        </div>
      </dl>
      <button
        v-if="!needsAttention"
        class="desktop-add-agent-recheck"
        type="button"
        :disabled="loading"
        @click="emit('refresh')"
      >{{ loading ? "Checking…" : "Check again" }}</button>
    </details>

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
    <slot name="actions" />
  </section>
</template>

<script setup lang="ts">
import { GitBranch } from "@lucide/vue";
import { computed } from "vue";
import AddAgentFeedback from "./AddAgentFeedback.vue";
import type {
  DesktopAgentProviderPreflight,
  RepoWorktreeEntry,
} from "../../../../../../electron/ipc-types";

const props = defineProps<{
  providerName: string | null;
  preflight: DesktopAgentProviderPreflight | null;
  loading: boolean;
  statusTitle: string;
  statusDescription: string;
  runtimeLabel: string;
  bridgeLabel: string;
  repoLabel: string;
  showSecureStorage: boolean;
  secureStorageLabel: string | null;
  secureStorageNeedsAttention: boolean;
  canOpenSecureStorage: boolean;
  showWorktrees: boolean;
  worktrees: RepoWorktreeEntry[];
  worktreeDescription: string;
  authCommand: string | null;
  installCommand: string | null;
  error: string | null;
}>();
const needsAttention = computed(() => Boolean(
  props.error || props.secureStorageNeedsAttention || props.preflight?.status !== "ready",
));
const emit = defineEmits<{
  refresh: [];
  "choose-worktree": [path: string];
  "open-secure-storage": [];
}>();
</script>
<style scoped src="./AddAgentSetupStatus.css"></style>
