<template>
  <article class="managed-agent-change-card" data-testid="managed-agent-change-card">
    <header>
      <span class="managed-agent-change-card-icon" aria-hidden="true">
        <FileDiff />
      </span>
      <div>
        <strong>{{ managedAgentChangeSummaryTitle(summary, loading, { unavailable }) }}</strong>
        <small>{{ managedAgentChangeSummarySubtitle(summary, loading, { unavailable }) }}</small>
      </div>
    </header>

    <p
      v-if="summary?.error"
      class="managed-agent-change-card-error"
    >
      {{ summary.error }}
    </p>
    <ul
      v-else-if="summary?.changedFileCount"
      class="managed-agent-change-files"
    >
      <li
        v-for="file in visibleFiles"
        :key="file.path"
      >
        <span :title="file.path">{{ file.path }}</span>
        <strong>
          <b v-if="file.additions">+{{ file.additions }}</b>
          <b v-if="file.deletions" class="managed-agent-change-deletions">-{{ file.deletions }}</b>
          <em v-if="file.binary">binary</em>
          <em v-if="!file.additions && !file.deletions && !file.binary">
            {{ managedAgentChangedFileStateLabel(file) }}
          </em>
        </strong>
      </li>
    </ul>
    <p
      v-else-if="!loading"
      class="managed-agent-change-card-empty"
    >
      {{ fallbackText }}
    </p>

    <div
      v-if="actionVisible"
      class="managed-agent-change-card-actions"
    >
      <button
        v-if="hiddenFileCount > 0"
        type="button"
        class="managed-agent-change-show-files"
        :aria-expanded="expanded"
        @click="$emit('toggle-expanded')"
      >
        {{ expanded ? "Show fewer files" : `Show ${hiddenFileCount} more files` }}
      </button>
      <a
        v-if="openHref"
        class="managed-agent-change-open-attachment"
        :href="openHref"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open attachment
      </a>
      <button
        v-if="retryVisible"
        type="button"
        class="managed-agent-change-retry"
        @click="$emit('retry')"
      >
        Retry
      </button>
    </div>

    <p
      v-if="expanded && backendHiddenFileCount > 0"
      class="managed-agent-change-card-empty"
    >
      {{ backendHiddenFileCount }} more files are not shown here.
    </p>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FileDiff } from "@lucide/vue";
import type { ManagedAgentChangeSummaryView } from "../../../domain/managed-agent-changes";
import {
  hiddenManagedAgentChangedFileCount,
  managedAgentChangedFileStateLabel,
  managedAgentChangeSummarySubtitle,
  managedAgentChangeSummaryTitle,
  visibleManagedAgentChangedFiles,
} from "../../../domain/managed-agent-changes";

const props = withDefaults(defineProps<{
  summary: ManagedAgentChangeSummaryView | null;
  loading?: boolean;
  expanded?: boolean;
  fallbackText?: string;
  openHref?: string | null;
  retryVisible?: boolean;
  unavailable?: boolean;
}>(), {
  loading: false,
  expanded: false,
  fallbackText: "No working tree changes in this Codex working tree.",
  openHref: null,
  retryVisible: false,
  unavailable: false,
});

defineEmits<{
  "toggle-expanded": [];
  retry: [];
}>();

const visibleFiles = computed(() =>
  visibleManagedAgentChangedFiles(props.summary, props.expanded),
);
const hiddenFileCount = computed(() =>
  hiddenManagedAgentChangedFileCount(props.summary, props.expanded),
);
const backendHiddenFileCount = computed(() => props.summary?.hiddenFileCount ?? 0);
const actionVisible = computed(() =>
  hiddenFileCount.value > 0 || Boolean(props.openHref) || props.retryVisible,
);
</script>
