<template>
  <div class="room-typing-fold" :class="{ 'is-in': open }" data-testid="room-typing-indicator">
    <span class="room-typing-status" role="status" aria-live="polite" aria-atomic="true">{{ label }}</span>
    <div class="room-typing-clip" aria-hidden="true">
      <div class="room-typing-pad"><div class="room-typing-row">
        <span class="room-typing-marks" :data-count="marks.length">
          <i v-for="(name, index) in marks" :key="index" :style="{ '--room-typing-color': colorFor?.(name) }"></i>
        </span>
        <span class="room-typing-copy">
          <span :key="sentenceKey">
            <template v-for="(part, index) in sentence" :key="index">
              <strong v-if="part.name">{{ part.text }}</strong>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </span>
        <span class="room-typing-wave">
          <i v-for="index in 3" :key="index" :style="{ '--room-typing-color': waveColor(index - 1) }"></i>
        </span>
      </div></div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { typingLabel, typingSentence } from '../room-typing.mjs';

const props = defineProps<{
  /** People typing now, one per account. Names are rendered as text, never as HTML. */
  names: readonly string[];
  /** The room's own sender colour, so a typer's dot matches the dot on their messages. */
  colorFor?: (name: string) => string | undefined;
}>();

const MAX_MARKS = 3;
const open = computed(() => props.names.length > 0);
const label = computed(() => typingLabel(props.names));
// Keep the last sentence while the row leaves, so the exit does not show an empty row.
const shown = ref<readonly string[]>(props.names);
watch(() => props.names, names => { if (names.length) shown.value = names; });
const marks = computed(() => shown.value.slice(0, MAX_MARKS));
const sentenceKey = computed(() => shown.value.join('\n'));
const sentence = computed(() => typingSentence(shown.value));
function waveColor(index: number): string | undefined {
  const typers = marks.value;
  return typers.length ? props.colorFor?.(typers[index % typers.length]) : undefined;
}
</script>
<style scoped>
/* One row, last in the room's live strip. Its metrics mirror .room-local-agent-work
   so a person typing lines up with the agents working above it. */
.room-typing-fold {
  position: relative;
  display: grid;
  grid-template-rows: 0fr;
  align-self: center;
  width: min(var(--room-chat-content-max, 720px), 100%);
  transition: grid-template-rows 140ms cubic-bezier(.22, 1, .36, 1), margin-top 140ms cubic-bezier(.22, 1, .36, 1);
}
.room-typing-fold.is-in { grid-template-rows: 1fr; transition-duration: 180ms; }
.room-typing-clip { min-height: 0; overflow: hidden; }
.room-typing-pad { padding-bottom: 8px; }
.room-typing-fold:first-child .room-typing-pad { padding-top: 6px; }
/* Under working agents, sit one row gap below them instead of a full list margin. */
.room-local-agent-work-list + .room-typing-fold.is-in { margin-top: -4px; }
.room-typing-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.room-typing-row {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  padding: 5px 8px 5px 3px;
  color: var(--text-tertiary, var(--muted));
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 140ms ease, transform 140ms cubic-bezier(.22, 1, .36, 1);
  pointer-events: none;
}
.room-typing-fold.is-in .room-typing-row { opacity: 1; transform: none; transition-duration: 180ms; }
.room-typing-marks { display: flex; width: 9px; }
.room-typing-marks[data-count="3"] { width: 12px; margin-left: -3px; }
.room-typing-marks i {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--room-typing-color, currentColor);
  box-shadow: 0 0 0 1.5px var(--bg, transparent);
}
.room-typing-marks i + i { margin-left: -3px; }
.room-typing-copy {
  min-width: 0;
  overflow: hidden;
  font-size: 0.73rem;
  font-weight: 640;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.room-typing-copy > span { animation: room-typing-swap 120ms ease; }
.room-typing-copy strong { color: var(--text-secondary, inherit); font-size: 0.74rem; font-weight: 760; }
.room-typing-wave { display: inline-flex; gap: 3px; align-items: center; }
.room-typing-wave i {
  width: 3px;
  height: 3px;
  border-radius: 999px;
  background: var(--room-typing-color, currentColor);
  opacity: 0.35;
  animation: room-typing-wave 1.25s ease-in-out infinite;
}
.room-typing-wave i:nth-child(2) { animation-delay: 140ms; }
.room-typing-wave i:nth-child(3) { animation-delay: 280ms; }
/* A closed row costs nothing: the wave only runs while someone is typing. */
.room-typing-fold:not(.is-in) .room-typing-wave i { animation-play-state: paused; }
@keyframes room-typing-wave {
  0%, 48%, 100% { opacity: 0.35; transform: translateY(0); }
  24% { opacity: 1; transform: translateY(-2.5px); }
}
@keyframes room-typing-swap { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .room-typing-fold, .room-typing-fold.is-in { transition: none; }
  .room-typing-row, .room-typing-fold.is-in .room-typing-row { transform: none; transition: opacity 140ms ease; }
  .room-typing-wave i { animation: none; opacity: 0.55; }
  .room-typing-copy > span { animation: none; }
}
</style>
