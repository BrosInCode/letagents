<template>
  <span :class="['provider-mark', `provider-mark-${provider.kind}`]" :style="{ '--mark-size': `${size}px` }">
    <img v-if="provider.kind === 'image'" :src="provider.src" alt="" :width="size" :height="size" loading="lazy" decoding="async">
    <svg v-else viewBox="0 0 24 24" :width="size" :height="size" aria-hidden="true" focusable="false">
      <path :d="provider.path" :fill="provider.color ?? 'currentColor'" fill-rule="evenodd" />
    </svg>
    <span v-if="showName" class="provider-mark-name">{{ provider.name }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { providers, type ProviderId } from './providers'

const props = withDefaults(defineProps<{
  id: ProviderId
  size?: number
  showName?: boolean
}>(), {
  size: 20,
  showName: true,
})

const provider = computed(() => providers[props.id])
</script>
