<template>
  <main class="desktop-launch-splash" data-testid="desktop-first-run-splash">
    <span class="desktop-launch-logo" role="status" aria-live="polite">
      <LetAgentsLogoMark />
      <span class="sr-only">LetAgents is starting</span>
    </span>
  </main>
</template>

<script setup lang="ts">
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
</script>
