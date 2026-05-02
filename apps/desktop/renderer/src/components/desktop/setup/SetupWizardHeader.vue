<template>
  <header class="mcp-wizard-header" data-testid="mcp-wizard-header">
    <p class="hero-kicker">{{ kicker }}</p>
    <h1>{{ headline }}</h1>
    <p>{{ copy }}</p>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  kicker: string;
  headline: string;
  copy: string;
}>();
</script>
