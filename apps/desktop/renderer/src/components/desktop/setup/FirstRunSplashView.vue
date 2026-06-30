<template>
  <main class="desktop-launch-splash" data-testid="desktop-first-run-splash">
    <div class="desktop-launch-splash-inner">
      <span class="desktop-launch-logo-shell" aria-hidden="true">
        <LetAgentsLogoMark />
      </span>
      <strong>LetAgents</strong>
      <small>Checking setup...</small>
    </div>
  </main>
</template>

<script setup lang="ts">
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";
</script>
