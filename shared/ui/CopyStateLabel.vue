<template>
  <!--
    "⧉ Copy" and "✓ Copied" are two units in one grid cell, each centred, so
    the button keeps one width and neither word sits off to the side. After
    the first swap the old unit leaves upward and the new one rises in once
    it is gone; the check pops in. While the server makes the code only the
    copy mark turns into a spinner, and only when that takes longer than a
    blink, so a fast answer goes straight from Copy to Copied. A spinner
    alone swaps no unit, so it starts no word animation.
  -->
  <span class="copy-state" :data-state="shown" :data-changed="changed || undefined">
    <span class="copy-state-unit" data-for="idle" :aria-hidden="shown === 'done' || undefined">
      <span class="copy-state-icon" aria-hidden="true">
        <svg class="copy-state-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        <span class="copy-state-spinner"></span>
      </span>
      <span>{{ idle }}</span>
    </span>
    <span class="copy-state-unit" data-for="done" :aria-hidden="shown !== 'done' || undefined">
      <svg class="copy-state-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>
      <span>{{ done }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { nextCopyStateLook, type CopyStateLook } from "./invite-bot";
import "./invite-bot-parts.css";

const props = withDefaults(defineProps<{
  state: "idle" | "busy" | "done";
  idle?: string;
  done?: string;
  /** How long a request may take before the spinner shows. */
  busyDelayMs?: number;
}>(), { idle: "Copy", done: "Copied", busyDelayMs: 160 });

const shown = ref<CopyStateLook>(props.state);
/** The words animate only once "Copy" and "Copied" have swapped, never on first paint. */
const changed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function show(next: CopyStateLook): void {
  const look = nextCopyStateLook({ shown: shown.value, changed: changed.value }, next);
  shown.value = look.shown;
  changed.value = look.changed;
}

watch(() => props.state, (state) => {
  clearTimeout(timer);
  if (state === "busy") timer = setTimeout(() => show("busy"), props.busyDelayMs);
  else show(state);
});
onBeforeUnmount(() => clearTimeout(timer));
</script>
