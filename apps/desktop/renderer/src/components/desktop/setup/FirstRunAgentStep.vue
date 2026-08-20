<template>
  <div class="first-run-agent-step" data-testid="first-run-agent-step">
    <div class="first-run-agent-route" aria-hidden="true">
      <Transition name="first-run-route-provider" mode="out-in">
        <span :key="selectedTarget?.id || 'empty'" class="first-run-agent-route-provider">
          <McpHarnessIcon v-if="selectedTarget" :target-id="selectedTarget.id" />
          <Bot v-else />
        </span>
      </Transition>
      <span class="first-run-agent-route-line">
        <i></i>
      </span>
      <span class="first-run-agent-route-room">
        <MessagesSquare />
      </span>
    </div>

    <div
      class="first-run-agent-options"
      role="radiogroup"
      aria-label="Choose the first agent to add"
    >
      <button
        v-for="target in targets"
        :key="target.id"
        class="first-run-agent-option"
        type="button"
        role="radio"
        :aria-checked="target.id === selectedTargetId"
        :data-selected="target.id === selectedTargetId"
        :data-testid="`first-run-agent-${target.id}`"
        @click="$emit('select', target.id)"
      >
        <span class="first-run-agent-option-icon" aria-hidden="true">
          <McpHarnessIcon :target-id="target.id" />
          <Check />
        </span>
        <strong>{{ target.name }}</strong>
      </button>
    </div>

    <p class="first-run-agent-room">
      <MessagesSquare aria-hidden="true" />
      <span>Joining <strong>{{ roomName || "your room" }}</strong></span>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Bot, Check, MessagesSquare } from "@lucide/vue";
import type {
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "../../../../../electron/ipc-types";
import McpHarnessIcon from "./McpHarnessIcon.vue";

const props = defineProps<{
  targets: DesktopMcpInstallTarget[];
  selectedTargetId: DesktopMcpInstallTargetId | null;
  roomName: string | null;
}>();

defineEmits<{
  select: [targetId: DesktopMcpInstallTargetId];
}>();

const selectedTarget = computed(() => {
  return props.targets.find((target) => target.id === props.selectedTargetId) || null;
});
</script>
