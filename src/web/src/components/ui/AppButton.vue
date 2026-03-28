<template>
  <button
    :class="['btn', `btn--${variant}`, `btn--${size}`, { 'btn--loading': loading, 'btn--block': block }]"
    :disabled="disabled || loading"
    :type="type"
  >
    <span v-if="loading" class="btn__spinner" />
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  loading?: boolean
  block?: boolean
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
  disabled: false,
  loading: false,
  block: false,
})
</script>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: var(--radius-md, 10px);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: all 200ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
  white-space: nowrap;
  user-select: none;
  position: relative;
  outline: none;
}

.btn:focus-visible {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sizes */
.btn--sm {
  padding: 6px 14px;
  font-size: 0.8rem;
}

.btn--md {
  padding: 10px 20px;
  font-size: 0.875rem;
}

.btn--lg {
  padding: 14px 28px;
  font-size: 1rem;
}

/* Variants */
.btn--primary {
  background: var(--btn-primary-bg, #fff);
  color: var(--btn-primary-color, #0a0a0a);
}

.btn--primary:hover:not(:disabled) {
  background: var(--btn-primary-hover-bg, #e4e4e7);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
}

.btn--primary:active:not(:disabled) {
  transform: translateY(0);
}

.btn--secondary {
  background: var(--btn-secondary-bg, rgba(255, 255, 255, 0.06));
  color: var(--btn-secondary-color, #e4e4e7);
  border: 1px solid var(--btn-secondary-border, rgba(255, 255, 255, 0.1));
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.btn--secondary:hover:not(:disabled) {
  background: var(--btn-secondary-hover-bg, rgba(255, 255, 255, 0.1));
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.btn--secondary:active:not(:disabled) {
  transform: translateY(0);
}

.btn--ghost {
  background: transparent;
  color: var(--btn-ghost-color, #a1a1aa);
}

.btn--ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--btn-ghost-hover-color, #e4e4e7);
}

.btn--danger {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.btn--danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  transform: translateY(-1px);
}

.btn--danger:active:not(:disabled) {
  transform: translateY(0);
}

/* Block */
.btn--block {
  width: 100%;
}

/* Loading */
.btn--loading {
  color: transparent;
}

.btn__spinner {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: btn-spin 600ms linear infinite;
}

@keyframes btn-spin {
  to { transform: rotate(360deg); }
}
</style>
