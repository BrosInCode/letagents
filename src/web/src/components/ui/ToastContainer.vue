<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-container">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="['toast', `toast--${toast.type}`]"
        @click="dismiss(toast.id)"
      >
        {{ toast.message }}
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
  bottom: 24px;
  right: 24px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  padding: 12px 20px;
  border-radius: var(--radius-lg);
  font-size: 0.85rem;
  font-weight: 600;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  pointer-events: auto;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  max-width: 380px;
}

.toast--success {
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.2);
  color: var(--green-text);
}

.toast--error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.toast--info {
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.2);
  color: #60a5fa;
}

/* Transitions */
.toast-enter-active {
  transition: all 300ms var(--ease-out);
}

.toast-leave-active {
  transition: all 200ms ease-in;
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
</style>
