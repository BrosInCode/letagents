<template>
  <Transition name="message-ref-popover">
    <div
      v-if="reference"
      :id="tooltipId"
      class="message-ref-popover"
      :class="{ missing: !reference.loaded }"
      :style="positionStyle"
      role="tooltip"
    >
      <strong>{{ reference.id }}</strong>
      <span>{{ reference.preview }}</span>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import type { MessageReferencePreview } from './useMessageReferences'

defineProps<{
  reference: MessageReferencePreview | null
  positionStyle: Record<string, string>
  tooltipId: string
}>()
</script>

<style scoped>
.message-ref-popover {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: min(320px, calc(100vw - 24px));
  padding: 10px 12px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.36);
  pointer-events: none;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
  transform-origin: center center;
}

.message-ref-popover-enter-active,
.message-ref-popover-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.message-ref-popover-enter-from,
.message-ref-popover-leave-to {
  opacity: 0;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) translateY(3px) scale(0.98);
}

.message-ref-popover-enter-to,
.message-ref-popover-leave-from {
  opacity: 1;
  transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
}

.message-ref-popover strong {
  font-size: 0.72rem;
  line-height: 1.2;
  color: #93c5fd;
}

.message-ref-popover span {
  color: var(--muted, #d4d4d8);
  font-size: 0.78rem;
  line-height: 1.45;
}

.message-ref-popover.missing span {
  color: var(--muted, #a1a1aa);
}

@media (prefers-reduced-motion: reduce) {
  .message-ref-popover-enter-active,
  .message-ref-popover-leave-active {
    transition-duration: 1ms;
  }

  .message-ref-popover-enter-from,
  .message-ref-popover-leave-to,
  .message-ref-popover-enter-to,
  .message-ref-popover-leave-from {
    transform: var(--message-ref-popover-transform, translate(-50%, -100%)) scale(1);
  }
}
</style>
