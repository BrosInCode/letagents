<template>
  <!--
    The two labels share one grid cell, so the button keeps one width while
    its word changes from Copy to Copied, and the icon turns from a copy mark
    into a check. While the server makes the code only the icon turns into a
    spinner, and only when that takes longer than a blink, so a fast answer
    goes straight from Copy to Copied.
  -->
  <span class="copy-state" :data-state="shown" :data-changed="changed || undefined">
    <span class="copy-state-icon" aria-hidden="true">
      <svg class="copy-state-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
      <svg class="copy-state-check" viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7" /></svg>
      <span class="copy-state-spinner"></span>
    </span>
    <span class="copy-state-labels">
      <span class="copy-state-label" data-for="idle" :aria-hidden="shown === 'done' || undefined">{{ idle }}</span>
      <span class="copy-state-label" data-for="done" :aria-hidden="shown !== 'done' || undefined">{{ done }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import "./invite-bot-parts.css";

const props = withDefaults(defineProps<{
  state: "idle" | "busy" | "done";
  idle?: string;
  done?: string;
  /** How long a request may take before the spinner shows. */
  busyDelayMs?: number;
}>(), { idle: "Copy", done: "Copied", busyDelayMs: 160 });

const shown = ref(props.state);
/** The words animate only after the first change, never on first paint. */
const changed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.state, (state) => {
  clearTimeout(timer);
  changed.value = true;
  if (state === "busy") timer = setTimeout(() => { shown.value = "busy"; }, props.busyDelayMs);
  else shown.value = state;
});
onBeforeUnmount(() => clearTimeout(timer));
</script>
