<template>
  <img
    class="mcp-harness-icon"
    :src="iconSrc"
    :alt="label"
    :data-harness="targetId"
    draggable="false"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopMcpInstallTargetId } from "../../../../../electron/ipc-types";
import antigravityIcon from "../../../assets/harness-icons/antigravity.png";
import claudeCodeIcon from "../../../assets/harness-icons/claude-code.png";
import codexIcon from "../../../assets/harness-icons/codex.png";
import cursorIcon from "../../../assets/harness-icons/cursor.png";

const props = defineProps<{
  targetId: DesktopMcpInstallTargetId;
}>();

const iconSources: Record<DesktopMcpInstallTargetId, string> = {
  "claude-code": claudeCodeIcon,
  antigravity: antigravityIcon,
  cursor: cursorIcon,
  codex: codexIcon,
};

const iconSrc = computed(() => iconSources[props.targetId]);
const label = computed(() => `${props.targetId} app icon`);
</script>
