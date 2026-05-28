<template>
  <dl v-if="items.length > 0" class="reasoning-highlights">
    <div v-for="item in items" :key="item.label" class="reasoning-highlight">
      <dt>{{ item.label }}</dt>
      <dd>{{ item.value }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import type { ReasoningHighlight } from './reasoningTrace'

defineProps<{
  items: ReasoningHighlight[]
}>()
</script>
