<template>
  <div class="room-page">
    <div class="section" style="text-align: center; padding: 200px 20px;">
      <h1 class="section-title">Room: {{ roomId }}</h1>
      <p style="color: var(--text-tertiary);">🚧 Room page migration in progress...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  roomId: string
}>()
</script>
