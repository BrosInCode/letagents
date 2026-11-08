<template>
  <section class="agent-live-background" aria-labelledby="agent-live-background-heading">
    <div class="agent-live-background-heading">
      <h3 id="agent-live-background-heading">In the background</h3>
      <span>{{ countLabel }}</span>
    </div>
    <div class="agent-live-background-list">
      <details
        v-for="command in commands" :key="command.id" :ref="(element) => remember(command.id, element)"
        class="agent-live-background-item" :data-status="command.status"
        @toggle="onToggle(command.id, $event)"
      >
        <summary>
          <span class="agent-live-background-icon" aria-hidden="true"><SquareTerminal :size="15" :stroke-width="1.6" /></span>
          <span class="agent-live-background-copy">
            <span class="agent-live-background-command" :title="command.command">{{ command.command }}</span>
            <span class="agent-live-background-last">{{ lastLine(command) }}</span>
          </span>
          <span class="agent-live-background-state">
            <span v-if="command.status === 'running'" class="agent-live-background-pulse" aria-hidden="true"></span>{{ stateLabel(command) }}
          </span>
          <ChevronRight class="agent-live-chevron" :size="14" aria-hidden="true" />
        </summary>
        <div class="agent-live-background-body">
          <pre
            :ref="(element) => rememberOutput(command.id, element)" class="agent-live-background-output" tabindex="0"
            :aria-label="`Output of ${command.command}`"
          >{{ command.output || 'No output yet.' }}</pre>
          <div class="agent-live-background-foot">
            <span>{{ startedLabel(command) }}</span>
            <span>{{ linesLabel(command) }}</span>
          </div>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { ChevronRight, SquareTerminal } from "@lucide/vue";
import { formatDate } from "../../../../domain/formatters";
import { formatLiveWorkDuration, type LiveBackgroundCommand } from "../../../../domain/agent-inspector-live";
import { useNow } from "../../../../composables/useNow";

const props = defineProps<{ commands: readonly LiveBackgroundCommand[] }>();

const items = new Map<string, HTMLDetailsElement>();
const outputs = new Map<string, HTMLPreElement>();
const running = computed(() => props.commands.filter((command) => command.status === "running").length);
const now = useNow(1_000, () => running.value > 0);

const countLabel = computed(() => {
  if (running.value) return `${running.value} running`;
  return props.commands.length === 1 ? "1 ended" : `${props.commands.length} ended`;
});

function remember(id: string, element: unknown): void {
  if (element instanceof HTMLDetailsElement) items.set(id, element);
  else items.delete(id);
}

function rememberOutput(id: string, element: unknown): void {
  if (element instanceof HTMLPreElement) outputs.set(id, element);
  else outputs.delete(id);
}

function lines(command: LiveBackgroundCommand): string[] {
  return command.output.split("\n").filter((line) => line.trim().length > 0);
}

function lastLine(command: LiveBackgroundCommand): string {
  return lines(command).at(-1) ?? (command.status === "running" ? "Waiting for output" : "No output");
}

function stateLabel(command: LiveBackgroundCommand): string {
  if (command.status === "running") {
    const elapsed = formatLiveWorkDuration(command.startedAt, null, now.value);
    return elapsed ? `Running · ${elapsed}` : "Running";
  }
  if (command.status === "lost") return "Ended with the agent";
  if (command.status === "stopped") return "Stopped";
  return command.exitCode === null ? (command.status === "failed" ? "Failed" : "Ended") : `Exited with code ${command.exitCode}`;
}

function startedLabel(command: LiveBackgroundCommand): string {
  const started = command.startedAt && Number.isFinite(Date.parse(command.startedAt)) ? formatDate("clockTime", command.startedAt) : null;
  return started ? `Started at ${started}` : "Started in the background";
}

function linesLabel(command: LiveBackgroundCommand): string {
  const count = lines(command).length;
  if (!count) return "";
  return command.outputTruncated ? `Newest ${count} lines` : `${count} ${count === 1 ? "line" : "lines"}`;
}

function scrollToEnd(id: string): void {
  const output = outputs.get(id);
  if (output) output.scrollTop = output.scrollHeight;
}

function onToggle(id: string, event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void nextTick(() => scrollToEnd(id));
}

/** Open one command's output and bring it into view: the row that started it asks for this. */
function open(id: string): void {
  const item = items.get(id);
  if (!item) return;
  item.open = true;
  void nextTick(() => {
    scrollToEnd(id);
    item.scrollIntoView({ block: "nearest" });
    item.querySelector("summary")?.focus({ preventScroll: true });
  });
}

// An open output that shows its end keeps showing its end as new lines arrive.
watch(() => props.commands.map((command) => command.output), () => {
  const atEnd = new Set<string>();
  for (const [id, output] of outputs) {
    if (output.scrollHeight - output.scrollTop - output.clientHeight < 16) atEnd.add(id);
  }
  void nextTick(() => { for (const id of atEnd) scrollToEnd(id); });
}, { flush: "pre" });

defineExpose({ open });
</script>
