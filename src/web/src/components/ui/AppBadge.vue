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
  background: var(--accent-dim);
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
}

.badge--success {
  background: var(--green-dim);
  color: var(--green-text);
  border: 1px solid color-mix(in srgb, var(--green) 28%, var(--border));
}

.badge--warning {
  background: var(--amber-dim);
  color: var(--amber-text);
  border: 1px solid color-mix(in srgb, var(--amber) 30%, var(--border));
}

.badge--error {
  background: var(--red-dim);
  color: var(--red-text);
  border: 1px solid color-mix(in srgb, var(--red) 30%, var(--border));
}

.badge--info {
  background: var(--blue-dim);
  color: var(--blue-text);
  border: 1px solid color-mix(in srgb, var(--blue) 30%, var(--border));
}

.badge--accent {
  background: color-mix(in srgb, var(--task-assigned) 10%, transparent);
  color: color-mix(in srgb, var(--task-assigned) 76%, var(--text));
  border: 1px solid color-mix(in srgb, var(--task-assigned) 30%, var(--border));
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
