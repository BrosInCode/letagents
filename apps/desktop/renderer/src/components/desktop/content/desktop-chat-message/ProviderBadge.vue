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
import openCodeIcon from "../../../../assets/harness-icons/opencode.svg";

import { providerFromAgentKey, providerFromLabel, type ProviderLabelKey } from "../room-chat/provider-icon";

const props = defineProps<{ label: string; agentKey?: string | null }>();
type ProviderKey = ProviderLabelKey;

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
// Open Model agents run on OpenCode, so both show the OpenCode mark.
const iconSources: Record<Exclude<ProviderKey, "other">, string> = {
  codex: codexIcon,
  claude: claudeCodeIcon,
  antigravity: antigravityIcon,
  cursor: cursorIcon,
  "open-model": openCodeIcon,
};
const iconSrc = computed(() => providerKey.value === "other" ? null : iconSources[providerKey.value]);
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
