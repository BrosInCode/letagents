<template>
  <!-- A command that an agent runs in the background: its row opens to its live output, here in the strip. -->
  <div
    class="room-activity-command"
    :data-open="open || undefined"
    :data-nested="nested || undefined"
    role="group"
    :aria-label="`${command.command}, running in the background`"
    data-testid="room-activity-background-command"
  >
    <div class="room-activity-command-head">
      <button
        type="button"
        class="room-activity-command-toggle"
        :aria-expanded="open"
        :aria-controls="terminalId"
        data-testid="room-activity-background-command-toggle"
        @click="emit('toggle')"
      >
        <span class="room-activity-icon room-activity-command-icon" aria-hidden="true"><SquareTerminal :size="14" :stroke-width="1.6" /></span>
        <span class="room-activity-row-copy"><code :title="command.command">{{ command.command }}</code><span v-if="agentName">{{ agentName }}</span></span>
        <span class="room-activity-row-time">{{ timeLabel }}</span>
        <ChevronRight class="room-activity-command-chevron" :size="13" aria-hidden="true" />
      </button>
      <span class="room-activity-row-actions">
        <button
          type="button"
          class="room-activity-row-button"
          data-tone="stop"
          :disabled="stopState === 'stopping'"
          data-testid="room-activity-background-command-stop"
          @click="emit('stop')"
        >{{ stopState === "stopping" ? "Stopping…" : "Stop" }}</button>
        <button
          type="button"
          class="room-activity-row-button"
          :aria-label="`Open ${command.command} in the agent's Live tab`"
          data-testid="room-activity-background-command-open"
          @click="emit('open')"
        >Open</button>
      </span>
    </div>
    <p v-if="stopState === 'failed'" class="room-activity-command-error" role="status">The command did not stop. Try again, or ask the agent to stop it.</p>
    <div class="room-activity-terminal-wrap">
      <div>
        <pre
          :id="terminalId"
          ref="terminal"
          class="room-activity-terminal"
          :tabindex="open ? 0 : -1"
          :aria-label="`Output of ${command.command}`"
          data-testid="room-activity-background-command-output"
        >{{ outputText }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { ChevronRight, SquareTerminal } from "@lucide/vue";
import type { DesktopBackgroundCommand } from "../../../../../../electron/ipc-types";
import type { LiveBackgroundCommand } from "../../../../domain/agent-inspector-live";
import { elapsedLabel } from "./room-activity";

const props = defineProps<{
  command: DesktopBackgroundCommand;
  /** Shown when the row is not under its agent's own row. */
  agentName: string | null;
  nested: boolean;
  open: boolean;
  output: LiveBackgroundCommand | null;
  stopState: "idle" | "stopping" | "failed";
  now: number;
}>();
const emit = defineEmits<{ toggle: []; stop: []; open: [] }>();

const terminalId = `room-activity-terminal-${useId()}`;
const terminal = ref<HTMLPreElement | null>(null);

// The time keeps its place while Stop runs: the button says "Stopping…", so the row does not change twice.
const timeLabel = computed(() => props.command.startedAt ? elapsedLabel(props.command.startedAt, props.now) : "Running");
const outputText = computed(() => {
  if (!props.output) return "Reading the output…";
  return props.output.output || "No output yet.";
});

function toEnd(): void {
  if (terminal.value) terminal.value.scrollTop = terminal.value.scrollHeight;
}

// Opened, it shows the newest lines; while it shows its end, it keeps showing its end.
watch(() => props.open, (open) => { if (open) void nextTick(toEnd); }, { immediate: true });
watch(outputText, async () => {
  const element = terminal.value;
  const atEnd = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 16;
  await nextTick();
  if (atEnd) toEnd();
}, { flush: "pre" });
</script>
