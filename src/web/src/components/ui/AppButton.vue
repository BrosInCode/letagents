<template>
  <button
    :class="['btn', `btn--${variant}`, `btn--${size}`, { 'btn--loading': loading, 'btn--block': block }]"
    :disabled="disabled || loading"
    :aria-busy="loading"
    :type="type"
  >
    <span v-if="loading" class="btn__spinner" aria-hidden="true" />
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
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform 150ms ease-out;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  user-select: none;
  position: relative;
  outline: none;
}

.btn:focus-visible {
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--blue);
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
  --btn-spinner-color: var(--btn-primary-color, #0a0a0a);
  background: var(--btn-primary-bg, #fff);
  color: var(--btn-primary-color, #0a0a0a);
}

@media (hover: hover) and (pointer: fine) {
  .btn--primary:hover:not(:disabled) {
  background: var(--btn-primary-hover-bg, #e4e4e7);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
  }
}

.btn--primary:active:not(:disabled) {
  transform: translateY(0);
}

.btn--secondary {
  background: var(--btn-secondary-bg, var(--bg-elevated));
  color: var(--btn-secondary-color, #e4e4e7);
  border: 1px solid var(--btn-secondary-border, rgba(255, 255, 255, 0.1));
}

@media (hover: hover) and (pointer: fine) {
  .btn--secondary:hover:not(:disabled) {
  background: var(--btn-secondary-hover-bg, rgba(255, 255, 255, 0.1));
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
  }
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

@media (hover: hover) and (pointer: fine) {
  .btn--danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
  transform: translateY(-1px);
  }
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
  border-top-color: var(--btn-spinner-color, var(--text));
  border-radius: 50%;
  animation: btn-spin 600ms linear infinite;
}

@keyframes btn-spin {
  to { transform: rotate(360deg); }
}
@media (pointer: coarse), (max-width: 600px) {
  .btn { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
  .btn:hover { transform: none; }
  .btn__spinner { animation: none; }
}
</style>
