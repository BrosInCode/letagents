<template>
  <span :class="['badge', `badge--${variant}`, `badge--${size}`]">
    <span v-if="dot" class="badge__dot" />
    <slot />
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'accent'
  size?: 'sm' | 'md'
  dot?: boolean
}>(), {
  variant: 'default',
  size: 'md',
  dot: false,
})
</script>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 99px;
  font-weight: 600;
  white-space: nowrap;
  user-select: none;
}

/* Sizes */
.badge--sm {
  padding: 2px 8px;
  font-size: 0.7rem;
}

.badge--md {
  padding: 4px 12px;
  font-size: 0.75rem;
}

/* Variants */
.badge--default {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted, #a1a1aa);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.badge--success {
  background: rgba(34, 197, 94, 0.12);
  color: var(--green-text, #4ade80);
  border: 1px solid rgba(34, 197, 94, 0.2);
}

.badge--warning {
  background: rgba(234, 179, 8, 0.12);
  color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.2);
}

.badge--error {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.badge--info {
  background: rgba(59, 130, 246, 0.12);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.2);
}

.badge--accent {
  background: rgba(168, 85, 247, 0.12);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.2);
}

/* Dot indicator */
.badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
</style>
