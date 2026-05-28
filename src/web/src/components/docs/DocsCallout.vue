<template>
  <div :class="['callout', `callout-${tone}`]">
    <component :is="iconComponent" class="callout-icon" :size="18" :label="iconLabel" />
    <p><slot /></p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BoltIcon from '@/components/icons/BoltIcon.vue'
import InfoIcon from '@/components/icons/InfoIcon.vue'
import WarningIcon from '@/components/icons/WarningIcon.vue'

const props = defineProps<{
  tone: 'tip' | 'info' | 'danger'
}>()

const iconComponent = computed(() => {
  if (props.tone === 'danger') return WarningIcon
  if (props.tone === 'info') return InfoIcon
  return BoltIcon
})

const iconLabel = computed(() => {
  if (props.tone === 'danger') return 'Warning'
  if (props.tone === 'info') return 'Info'
  return 'Tip'
})
</script>
