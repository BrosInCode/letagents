<template>
  <span class="room-provider-badge" :class="`room-provider-badge--${providerKey}`" :title="`${label} provider`" :aria-label="`${label} provider`" role="img">
    <svg v-if="providerKey === 'codex'" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" /><path d="M6 6l2 2-2 2M9.5 10H11" /></svg>
    <svg v-else-if="providerKey === 'claude'" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" class="provider-badge-fill" /></svg>
    <svg v-else-if="providerKey === 'antigravity'" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l5 12H3L8 2Z" /><path d="M5.5 10h5" /></svg>
    <svg v-else-if="providerKey === 'cursor'" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l8 5-8 5V3Z" /></svg>
    <svg v-else viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="5.5" r="1" class="provider-badge-fill" /><path d="M8 7.5v4" /></svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ label: string }>();
const providerKey = computed(() => {
  const normalized = props.label.trim().toLowerCase();
  if (normalized === "claude code") return "claude";
  if (["codex", "claude", "antigravity", "cursor"].includes(normalized)) return normalized;
  return "other";
});
const label = computed(() => providerKey.value === "other" ? "Other" : props.label.trim() || "Other");
</script>

<style scoped>
.room-provider-badge { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; flex: 0 0 19px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
.room-provider-badge svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.35; }
.provider-badge-fill { fill: currentColor; stroke: none; }
.room-provider-badge--codex { color: #34d399; background: rgba(52, 211, 153, 0.12); }
.room-provider-badge--claude { color: #fb923c; background: rgba(251, 146, 60, 0.12); }
.room-provider-badge--antigravity { color: #60a5fa; background: rgba(96, 165, 250, 0.12); }
.room-provider-badge--cursor { color: #c084fc; background: rgba(192, 132, 252, 0.12); }
.room-provider-badge--other { color: var(--text-tertiary); }
</style>
