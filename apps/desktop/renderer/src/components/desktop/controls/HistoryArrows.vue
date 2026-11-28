<template>
  <!-- Back and forward through the places opened in this window (useEntryHistory). -->
  <div v-if="history" class="sidebar-history" role="group" aria-label="History" data-testid="history-arrows">
    <button class="sidebar-topbar-action" type="button" aria-label="Back" :title="`Back (${keyLabel}[)`"
      :disabled="!history.canGoBack.value" data-testid="history-back" @click="history.goBack()">
      <ChevronLeft aria-hidden="true" />
    </button>
    <button class="sidebar-topbar-action" type="button" aria-label="Forward" :title="`Forward (${keyLabel}])`"
      :disabled="!history.canGoForward.value" data-testid="history-forward" @click="history.goForward()">
      <ChevronRight aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { useEntryHistoryControls } from "../../../composables/useEntryHistory";

const history = useEntryHistoryControls();
const keyLabel = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
</script>
