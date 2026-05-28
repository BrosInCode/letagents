<template>
  <div class="lifecycle">
    <span v-for="(step, index) in steps" :key="step" class="lifecycle-step">
      {{ step }}
      <span v-if="index < steps.length - 1" class="lifecycle-arrow">-&gt;</span>
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  steps: readonly string[]
}>()
</script>
