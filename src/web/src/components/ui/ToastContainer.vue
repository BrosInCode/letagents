<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-container">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="['toast', `toast--${toast.type}`]"
        :role="toast.type === 'error' ? 'alert' : 'status'"
        :aria-live="toast.type === 'error' ? 'assertive' : 'polite'"
        aria-atomic="true"
        @click="dismiss(toast.id)"
      >
        <span>{{ toast.message }}</span>
        <button type="button" class="toast-dismiss" aria-label="Dismiss notification" @click.stop="dismiss(toast.id)">×</button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<style scoped>
.toast-container {
  position: fixed;
  bottom: max(24px, env(safe-area-inset-bottom, 0px));
  right: max(16px, env(safe-area-inset-right, 0px));
  max-width: calc(100vw - 32px);
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 16px;
  overflow-wrap: anywhere;
  border-radius: var(--radius-lg);
  font-size: 0.85rem;
  font-weight: 600;
  pointer-events: auto;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  max-width: 380px;
  background: var(--bg-elevated);
}

.toast--success {
  background: color-mix(in srgb, var(--bg-elevated) 88%, var(--green));
  border: 1px solid color-mix(in srgb, var(--green) 46%, var(--border-strong));
  color: var(--green-text);
}

.toast--error {
  background: color-mix(in srgb, var(--bg-elevated) 88%, var(--red));
  border: 1px solid color-mix(in srgb, var(--red) 46%, var(--border-strong));
  color: var(--red-text);
}

.toast--info {
  background: color-mix(in srgb, var(--bg-elevated) 88%, var(--blue));
  border: 1px solid color-mix(in srgb, var(--blue) 46%, var(--border-strong));
  color: var(--blue-text);
}

.toast > span { min-width: 0; }
.toast-dismiss { width: 44px; height: 44px; flex: none; color: inherit; font-size: 22px; border-radius: 6px; }
.toast-dismiss:focus-visible { outline: 2px solid currentColor; outline-offset: -4px; }

/* Transitions */
.toast-enter-active {
  transition: opacity 200ms ease-out, transform 200ms var(--ease-out);
}

.toast-leave-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(32px) scale(0.95);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(32px) scale(0.95);
}

.toast-move {
  transition: transform 250ms var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-from, .toast-leave-to { transform: none; }
  .toast-move { transition: none; }
}
</style>
