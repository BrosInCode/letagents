<template>
  <div class="first-run-agent-step" data-testid="first-run-agent-step">
    <div class="first-run-agent-route" aria-hidden="true">
      <Transition name="first-run-route-provider" mode="out-in">
        <span :key="selectedOption?.provider.id || 'empty'" class="first-run-agent-route-provider">
          <McpHarnessIcon
            v-if="selectedOption?.provider.mcpTargetId"
            :target-id="selectedOption.provider.mcpTargetId"
          />
          <Code2 v-else-if="selectedOption" />
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

    <div v-if="loading" class="first-run-agent-checking" role="status">
      <LoaderCircle aria-hidden="true" />
      <strong>Checking agent CLIs…</strong>
    </div>

    <div v-else-if="error && !options.length" class="first-run-agent-checking" role="status">
      <CircleAlert aria-hidden="true" />
      <strong>Couldn’t check agent CLIs.</strong>
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">Try again</button>
    </div>

    <div
      v-else
      class="first-run-agent-options"
      role="radiogroup"
      aria-label="Choose a managed agent provider"
    >
      <button
        v-for="option in options"
        :key="option.provider.id"
        class="first-run-agent-option"
        type="button"
        role="radio"
        :aria-checked="option.provider.id === selectedProviderId"
        :data-selected="option.provider.id === selectedProviderId"
        :data-testid="`first-run-agent-${option.provider.id}`"
        @click="$emit('select', option.provider.id)"
      >
        <span class="first-run-agent-option-icon" aria-hidden="true">
          <McpHarnessIcon
            v-if="option.provider.mcpTargetId"
            :target-id="option.provider.mcpTargetId"
          />
          <Code2 v-else class="first-run-agent-option-fallback" />
          <Check class="first-run-agent-option-check" />
        </span>
        <strong>{{ option.provider.name }}</strong>
        <small :data-state="optionState(option)">{{ optionLabel(option) }}</small>
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
import { Bot, Check, CircleAlert, Code2, LoaderCircle, MessagesSquare } from "@lucide/vue";
import type { DesktopAgentProviderId } from "../../../../../electron/ipc-types";
import type { FirstRunAgentOption } from "./types";
import McpHarnessIcon from "./McpHarnessIcon.vue";

const props = defineProps<{
  options: FirstRunAgentOption[];
  selectedProviderId: DesktopAgentProviderId | null;
  roomName: string | null;
  loading: boolean;
  error: string | null;
}>();

defineEmits<{
  select: [providerId: DesktopAgentProviderId];
  retry: [];
}>();

const selectedOption = computed(() => {
  return props.options.find((option) => option.provider.id === props.selectedProviderId) || null;
});

function optionState(option: FirstRunAgentOption): "ready" | "attention" | "missing" | "error" {
  if (option.error || option.preflight?.status === "error") return "error";
  if (option.preflight?.canStart) return "ready";
  if (option.preflight?.status === "missing_runtime") return "missing";
  return "attention";
}

function optionLabel(option: FirstRunAgentOption): string {
  if (option.error || option.preflight?.status === "error") return "Could not check";
  if (option.preflight?.canStart) return "Ready";
  switch (option.preflight?.status) {
    case "missing_runtime": return option.provider.id === "open-model" ? "Runtime not ready" : "CLI not found";
    case "auth_required": return "Sign-in needed";
    case "bridge_required": return "MCP needed";
    case "repo_required": return "Choose repo";
    case "branch_mismatch": return "Branch mismatch";
    case "config_required": return "Setup needed";
    case "runtime_installed": return "Detected";
    case "running": return "Ready";
    default: return "Setup needed";
  }
}
</script>
