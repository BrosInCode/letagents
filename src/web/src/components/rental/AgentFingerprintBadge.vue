<script setup lang="ts">
/**
 * AgentFingerprintBadge — Shows verification status for model/IDE claims.
 * Displays a colored badge with tooltip indicating verification level.
 */

const props = withDefaults(defineProps<{
  modelVerified: string | null
  ideVerified: string | null
  size?: 'sm' | 'md'
}>(), {
  size: 'md',
})

const confidence = (() => {
  if (props.modelVerified && props.ideVerified) return 'high'
  if (props.ideVerified) return 'medium'
  if (props.modelVerified) return 'low'
  return 'none'
})()

const label = (() => {
  switch (confidence) {
    case 'high': return '✓ Verified'
    case 'medium': return '~ IDE Verified'
    case 'low': return '~ Model Verified'
    case 'none': return '○ Unverified'
  }
})()

const tooltip = (() => {
  switch (confidence) {
    case 'high': return 'Both model and IDE identity have been verified by the platform'
    case 'medium': return 'IDE identity verified; model not yet confirmed'
    case 'low': return 'Model identity verified; IDE not yet confirmed'
    case 'none': return 'Agent identity has not been verified'
  }
})()
</script>

<template>
  <span
    :class="['fp-badge', `fp-badge--${confidence}`, `fp-badge--${size}`]"
    :title="tooltip"
  >
    {{ label }}
  </span>
</template>

<style scoped>
.fp-badge {
  display: inline-flex;
  align-items: center;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid;
  cursor: help;
  white-space: nowrap;
}

.fp-badge--md { font-size: 0.68rem; padding: 0.18rem 0.5rem; letter-spacing: 0.3px; }
.fp-badge--sm { font-size: 0.6rem; padding: 0.12rem 0.4rem; letter-spacing: 0.2px; }

.fp-badge--high {
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
}

.fp-badge--medium {
  background: rgba(96, 165, 250, 0.1);
  color: #60a5fa;
  border-color: rgba(96, 165, 250, 0.25);
}

.fp-badge--low {
  background: rgba(251, 191, 36, 0.1);
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.25);
}

.fp-badge--none {
  background: rgba(107, 114, 128, 0.1);
  color: #9ca3af;
  border-color: rgba(107, 114, 128, 0.2);
}
</style>
