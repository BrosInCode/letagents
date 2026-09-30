<template>
  <span v-if="summary" class="wake-rule-line" :title="details">
    <WakeGlyph />
    <span class="wake-rule-line-label">{{ summary.label }}</span>
    <span v-if="summary.detail" class="wake-rule-line-detail">· {{ summary.detail }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { formatWakeClock, summarizeWakeRuleParts, wakeRuleLabel, type WakeRule } from "../wake-rules.mjs";
import WakeGlyph from "./WakeGlyph.vue";

const props = defineProps<{ rules: readonly WakeRule[] }>();
const now = ref(new Date());
const summary = computed(() => summarizeWakeRuleParts(props.rules, now.value));
const details = computed(() => props.rules
  .map((rule) => wakeRuleLabel(rule, { formatTime: (iso) => formatWakeClock(iso, now.value) }))
  .join("\n"));

let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => { tick = setInterval(() => { now.value = new Date(); }, 30_000); });
onBeforeUnmount(() => clearInterval(tick));
</script>

<style>
.wake-rule-line {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  font-variant-numeric: tabular-nums slashed-zero;
}
.wake-rule-line > .wake-glyph {
  width: 13px;
  height: 13px;
  opacity: 0.85;
}
.wake-rule-line-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* How long, and how many more, stays visible when the label is shortened. */
.wake-rule-line-detail {
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
