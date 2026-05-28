<template>
  <div class="drawer-section drawer-panel parent-room-section">
    <div class="drawer-section-title">
      <h2>Parent Room</h2>
      <span>focus</span>
    </div>
    <a class="parent-room-link" :href="url" @click="$emit('close')">
      <span>{{ display }}</span>
      <strong>Open parent room</strong>
    </a>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  display: string
  url: string
}>()

defineEmits<{ close: [] }>()
</script>
