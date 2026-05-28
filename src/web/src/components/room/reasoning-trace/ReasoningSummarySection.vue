<template>
  <section v-if="summary" class="reasoning-summary" :data-updating="recentlyUpdated">
    <h3>
      Current summary
      <small v-if="live" class="reasoning-live-dot" aria-label="Streaming" />
    </h3>
    <p>{{ summary }}</p>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  live: boolean
  recentlyUpdated: boolean
  summary: string
}>()
</script>
