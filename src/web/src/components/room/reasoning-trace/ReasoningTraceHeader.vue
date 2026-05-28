<template>
  <header class="reasoning-header">
    <div>
      <p class="reasoning-eyebrow">Agent reasoning stream</p>
      <h2 :id="titleId">{{ heading }}</h2>
      <p class="reasoning-subtitle">{{ subtitle }}</p>
    </div>
    <span class="reasoning-live-badge" :data-state="streamState">
      {{ streamLabel }}
    </span>
    <button class="reasoning-close" type="button" @click="$emit('close')">
      Close
    </button>
  </header>
</template>

<script setup lang="ts">
import type { ReasoningStreamState } from './reasoningTrace'

defineProps<{
  heading: string
  streamLabel: string
  streamState: ReasoningStreamState
  subtitle: string
  titleId: string
}>()

defineEmits<{
  close: []
}>()
</script>
