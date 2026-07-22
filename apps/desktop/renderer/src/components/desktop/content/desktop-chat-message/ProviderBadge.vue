<template>
  <span class="room-provider-badge" :class="`room-provider-badge--${providerKey}`" :title="`${label} provider`" :aria-label="`${label} provider`" role="img">
    <img v-if="iconSrc" :src="iconSrc" alt="" aria-hidden="true" draggable="false" />
    <svg v-else viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="5.5" r="1" class="provider-badge-fill" /><path d="M8 7.5v4" /></svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import antigravityIcon from "../../../../assets/harness-icons/antigravity.png";
import claudeCodeIcon from "../../../../assets/harness-icons/claude-code.png";
import codexIcon from "../../../../assets/harness-icons/codex.png";
import cursorIcon from "../../../../assets/harness-icons/cursor.png";

const props = defineProps<{ label: string; agentKey?: string | null }>();
type ProviderKey = "codex" | "claude" | "antigravity" | "cursor" | "open-model" | "other";

function providerFromLabel(value: string): ProviderKey {
  const normalized = value.trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "claude" || normalized === "claude code") return "claude";
  if (normalized === "antigravity") return "antigravity";
  if (normalized === "cursor") return "cursor";
  if (normalized === "open model" || normalized === "open-model") return "open-model";
  return "other";
}

function providerFromAgentKey(agentKey: string | null | undefined): ProviderKey | null {
  const name = (agentKey?.split("/").at(-1) || "").toLowerCase();
  if (name.startsWith("desktop-codex-")) return "codex";
  if (name.startsWith("desktop-claude-code-") || name.startsWith("desktop-claude-")) return "claude";
  if (name.startsWith("desktop-antigravity-")) return "antigravity";
  if (name.startsWith("desktop-cursor-")) return "cursor";
  if (name.startsWith("desktop-open-model-") || name.startsWith("desktop-open_model-")) return "open-model";
  return null;
}

const inferredProvider = computed<ProviderKey | null>(() =>
  props.label.trim().toLowerCase() === "supervisor worker"
    ? providerFromAgentKey(props.agentKey)
    : null
);
const providerKey = computed<ProviderKey>(() => inferredProvider.value || providerFromLabel(props.label));
const providerLabels: Record<ProviderKey, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  cursor: "Cursor",
  "open-model": "Open Model",
  other: "Other",
};
const label = computed(() => inferredProvider.value
  ? providerLabels[inferredProvider.value]
  : props.label.trim() || "Other");
const iconSources: Record<Exclude<ProviderKey, "open-model" | "other">, string> = {
  codex: codexIcon,
  claude: claudeCodeIcon,
  antigravity: antigravityIcon,
  cursor: cursorIcon,
};
const iconSrc = computed(() => providerKey.value === "other" || providerKey.value === "open-model"
  ? null
  : iconSources[providerKey.value]);
</script>

<style scoped>
.room-provider-badge { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; flex: 0 0 19px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
.room-provider-badge img { width: 15px; height: 15px; border-radius: 4px; object-fit: cover; }
.room-provider-badge svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.35; }
.provider-badge-fill { fill: currentColor; stroke: none; }
.room-provider-badge--codex { background: rgba(255, 255, 255, 0.1); }
.room-provider-badge--claude { background: rgba(240, 112, 72, 0.16); }
.room-provider-badge--antigravity { background: rgba(96, 165, 250, 0.12); }
.room-provider-badge--cursor { background: rgba(255, 255, 255, 0.1); }
.room-provider-badge--open-model { color: #a78bfa; background: rgba(167, 139, 250, 0.14); }
.room-provider-badge--other { color: var(--text-tertiary); }
</style>
