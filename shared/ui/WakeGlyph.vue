<template>
  <svg
    class="wake-glyph"
    :data-state="state"
    :data-still="still || undefined"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- A crescent: the agent is resting until something happens. -->
    <path d="M13.25 9.9A5.75 5.75 0 1 1 6.1 2.75a4.5 4.5 0 0 0 7.15 7.15Z" />
    <!-- Woken: a small spark in the crescent's hollow, drawn once. -->
    <path v-if="state === 'woke'" class="wake-glyph-spark" pathLength="1" d="M12.25 1.6v2.3M11.1 2.75h2.3" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  state?: "waiting" | "woke" | "ended";
  /** Skip the spark's draw-in, e.g. for a message scrolled back into view. */
  still?: boolean;
}>(), { state: "waiting", still: false });
</script>

<style>
.wake-glyph {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  /* The crescent's visual centre sits left of its box. */
  translate: 0.25px 0;
}
.wake-glyph[data-state="ended"] {
  opacity: 0.55;
}
.wake-glyph-spark {
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  animation: wake-glyph-spark 320ms cubic-bezier(0.23, 1, 0.32, 1) 80ms both;
}
@keyframes wake-glyph-spark {
  from { stroke-dashoffset: 1; opacity: 0; }
  to { stroke-dashoffset: 0; opacity: 1; }
}
.wake-glyph[data-still] .wake-glyph-spark {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .wake-glyph-spark { animation: none; }
}
</style>
