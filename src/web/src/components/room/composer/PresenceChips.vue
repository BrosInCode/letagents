<template>
  <!-- Always mounted so the live region exists before a chip is announced. -->
  <TransitionGroup
    name="presence-chip"
    tag="div"
    class="presence-chips"
    role="status"
    aria-atomic="false"
    aria-relevant="additions"
  >
    <div v-for="chip in chips" :key="chip.id" class="presence-chip" :data-kind="chip.kind">
      <IdeBadge v-if="chip.ideLabel" :label="chip.ideLabel" />
      <span v-else class="presence-chip-dot" aria-hidden="true" />
      <span class="presence-chip-copy">
        <strong>{{ chip.displayName }}</strong>
        {{ chip.kind === 'connected' ? 'connected' : 'disconnected' }}
      </span>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import IdeBadge from '../chat-message/IdeBadge.vue'
import type { PresenceChip } from './presenceChips'

defineProps<{ chips: PresenceChip[] }>()
</script>

<style scoped>
/* Floats above the composer so a chip coming or going never moves the
   composer or the timeline. Inline layout, not flex: a leaving chip is taken
   out of flow, and only in inline flow does it stay where it was while the
   others slide over. */
.presence-chips {
  position: absolute;
  /* The padding leaves room for the shadow and the slide-in inside the clip. */
  bottom: calc(100% - 18px);
  left: 28px;
  z-index: 2;
  display: block;
  /* Never wider than the composer: extra chips are clipped, not scrolled. */
  max-width: calc(100% - 56px);
  /* Keeps its height when empty: a leaving chip is out of flow, and the row
     must not collapse under it mid-fade. */
  box-sizing: content-box;
  min-height: 28px;
  padding: 12px 4px 10px;
  margin-left: -4px;
  overflow: hidden;
  white-space: nowrap;
  pointer-events: none;
}

/* Narrow screens have room for one chip: show the newest. */
@media (max-width: 640px) {
  .presence-chips {
    bottom: calc(100% - 10px);
    left: 12px;
    max-width: calc(100% - 24px);
  }

  .presence-chip:not(:last-child) {
    display: none;
  }
}

.presence-chip {
  display: inline-flex;
  box-sizing: border-box;
  height: 28px;
  vertical-align: bottom;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
  max-width: min(320px, 60vw);
  padding: 5px 11px 5px 8px;
  border: 1px solid var(--line, #27272a);
  border-radius: 999px;
  background: var(--bg-1, #0f0f11);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
  color: var(--muted, #a1a1aa);
  font-size: 0.76rem;
  line-height: 1.2;
  white-space: nowrap;
}

.presence-chip-copy {
  overflow: hidden;
  text-overflow: ellipsis;
}

.presence-chip strong {
  color: var(--text, #e4e4e7);
  font-weight: 650;
}

.presence-chip-dot {
  width: 7px;
  height: 7px;
  margin: 0 2px;
  border-radius: 999px;
  background: #34d399;
}

.presence-chip[data-kind='disconnected'] {
  color: var(--muted, #71717a);
}

.presence-chip[data-kind='disconnected'] strong {
  color: var(--muted, #a1a1aa);
}

.presence-chip[data-kind='disconnected'] :deep(.ide-icon) {
  color: var(--muted, #71717a);
}

.presence-chip[data-kind='disconnected'] .presence-chip-dot {
  background: var(--muted, #71717a);
}

.presence-chip-enter-active {
  transition:
    opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.presence-chip-leave-active {
  position: absolute;
  transition:
    opacity 160ms ease-in,
    transform 160ms ease-in;
}

.presence-chip-move {
  transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.presence-chip-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}

.presence-chip-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .presence-chip-enter-active,
  .presence-chip-leave-active,
  .presence-chip-move {
    transition: opacity 120ms linear;
  }

  .presence-chip-enter-from,
  .presence-chip-leave-to {
    transform: none;
  }
}
</style>
