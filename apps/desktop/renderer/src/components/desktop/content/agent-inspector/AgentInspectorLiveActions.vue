<template>
  <div class="agent-live-action" :data-status="rowStatus" :data-current="current && ongoing" :data-result="single?.tool.kind === 'reply'">
    <details ref="disclosure" class="agent-live-disclosure">
      <summary>
        <span class="agent-live-icon" aria-hidden="true"><component :is="icon" :size="15" :stroke-width="1.6" /></span>
        <span class="agent-live-action-copy">
          <span class="agent-live-action-title">{{ headline }}</span>
          <span v-if="detail" class="agent-live-action-detail" :title="detail">{{ detail }}</span>
        </span>
        <span class="agent-live-action-status">{{ statusLabel }}</span>
        <ChevronRight class="agent-live-chevron" :size="14" aria-hidden="true" />
      </summary>
      <div class="agent-live-action-body">
        <template v-if="single">
          <span class="agent-live-caption">{{ single.tool.toolName }}</span>
          <template v-if="formatLiveValue(single.item.input)">
            <span class="agent-live-caption">Input</span>
            <pre>{{ formatLiveValue(single.item.input) }}</pre>
          </template>
          <template v-if="formatLiveValue(single.item.output)">
            <span class="agent-live-caption">{{ single.item.outputTruncated ? 'Output (newest lines)' : 'Output' }}</span>
            <pre ref="outputElement">{{ formatLiveValue(single.item.output) }}</pre>
          </template>
          <template v-if="background">
            <span class="agent-live-caption">The command's live output is under In the background.</span>
            <button type="button" class="agent-live-body-link" @click="emit('show-background', background.id)">
              <SquareTerminal :size="13" :stroke-width="1.6" aria-hidden="true" />Show live output
            </button>
          </template>
          <template v-if="single.item.error && failure?.message !== single.item.error">
            <span class="agent-live-caption">Full error</span>
            <pre>{{ single.item.error }}</pre>
          </template>
          <p v-if="!formatLiveValue(single.item.input) && !formatLiveValue(single.item.output)" class="agent-live-caption">No additional details received.</p>
        </template>
        <ol v-else class="agent-live-group-items" aria-label="Individual actions">
          <li v-for="action in entry.actions" :key="action.item.id">
            <details>
              <summary><span>{{ action.tool.detail || action.tool.headline }}</span><ChevronRight :size="14" aria-hidden="true" /></summary>
              <span class="agent-live-caption">{{ action.tool.toolName }} · Input</span>
              <pre v-if="formatLiveValue(action.item.input)">{{ formatLiveValue(action.item.input) }}</pre>
              <span v-if="formatLiveValue(action.item.output)" class="agent-live-caption">Output</span>
              <pre v-if="formatLiveValue(action.item.output)">{{ formatLiveValue(action.item.output) }}</pre>
            </details>
          </li>
        </ol>
      </div>
    </details>
    <div v-if="tail" class="agent-live-tail">
      <div class="agent-live-tail-body">
        <div v-if="tail.lines.length" class="agent-live-tail-screen">
          <div class="agent-live-tail-lines">
            <span v-for="(line, index) in tail.lines" :key="index" class="agent-live-tail-line">{{ line }}</span>
          </div>
        </div>
        <p v-else-if="tail.hidden" class="agent-live-tail-note">The output appears when the command ends.</p>
        <div class="agent-live-tail-meta">
          <span>{{ tail.meta }}</span>
          <button v-if="tail.lines.length" type="button" @click="showAllOutput">Show all output</button>
        </div>
      </div>
    </div>
    <div v-if="failure" class="agent-live-error">
      <p>{{ failure.message }}</p>
      <template v-if="failure.outputPreview">
        <span class="agent-live-caption">Output excerpt</span>
        <pre>{{ failure.outputPreview }}</pre>
      </template>
      <p v-if="failure.detail" class="agent-live-failure-detail">{{ failure.detail }}</p>
    </div>
    <MarkdownBlock v-if="single?.tool.replyText" class="agent-live-prose agent-live-reply" :text="single.tool.replyText" :mentions="false" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Check, ChevronRight, CircleAlert, FilePenLine, FileText, Hourglass, Search, SquareTerminal, Wrench } from "@lucide/vue";
import { BACKGROUND_SHELL_HEADLINES, formatLiveValue, liveActionFailure, liveActionStatus, type LiveTraceEntry } from "../../../../domain/agent-inspector-live-trace";
import { formatLiveWorkDuration, isShellToolName, type LiveBackgroundCommand } from "../../../../domain/agent-inspector-live";
import { useNow } from "../../../../composables/useNow";
import MarkdownBlock from "../formatting/MarkdownBlock.vue";

/** Lines of a running command's output that its row shows without opening it. */
const TAIL_LINES = 5;

const props = defineProps<{
  entry: Extract<LiveTraceEntry, { kind: "actions" }>;
  current: boolean;
  /** The background command that this call started, while the Live tab knows it. */
  background?: LiveBackgroundCommand | null;
}>();
const emit = defineEmits<{ "show-background": [taskId: string] }>();
const disclosure = ref<HTMLDetailsElement | null>(null);
const outputElement = ref<HTMLPreElement | null>(null);
const single = computed(() => props.entry.actions.length === 1 ? props.entry.actions[0]! : null);
const failure = computed(() => single.value ? liveActionFailure(single.value) : null);
const status = computed(() => single.value?.item.error ? "error" : single.value?.item.status ?? "completed");
const ongoing = computed(() => ["pending", "running"].includes(status.value));
const backgroundRunning = computed(() => props.background?.status === "running");
const rowStatus = computed(() => backgroundRunning.value ? "background" : status.value);
const statusLabel = computed(() => backgroundRunning.value ? "In background" : liveActionStatus(status.value, props.current));

/**
 * The newest lines of a shell command while it runs, under its row: the
 * output arrives while the command runs, so nobody has to open the row.
 */
const tailVisible = computed(() => Boolean(single.value && props.current && ongoing.value && !backgroundRunning.value
  && isShellToolName(single.value.item.tool)
  && (typeof single.value.item.output === "string" || single.value.item.outputHidden)));
const now = useNow(1_000, () => tailVisible.value);
const tail = computed(() => {
  const action = single.value;
  if (!tailVisible.value || !action) return null;
  const output = typeof action.item.output === "string" ? action.item.output : "";
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const elapsed = formatLiveWorkDuration(action.item.startedAt ?? null, null, now.value);
  const count = `${lines.length} ${lines.length === 1 ? "line" : "lines"}${action.item.outputTruncated ? " shown" : ""}`;
  return {
    lines: lines.slice(-TAIL_LINES),
    hidden: action.item.outputHidden === true,
    meta: [elapsed ? `Running for ${elapsed}` : "Running", lines.length ? count : null].filter(Boolean).join(" · "),
  };
});

function showAllOutput(): void {
  if (disclosure.value) disclosure.value.open = true;
  void nextTick(() => outputElement.value?.scrollTo({ top: outputElement.value.scrollHeight }));
}

// An open output that shows its end keeps showing its end as new lines arrive.
watch(() => single.value?.item.output, async () => {
  const element = outputElement.value;
  if (!element || !disclosure.value?.open) return;
  const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
  await nextTick();
  if (atEnd) element.scrollTop = element.scrollHeight;
}, { flush: "pre" });
const headline = computed(() => {
  if (single.value) {
    // A call whose command still runs after its turn started a background command; it is not unfinished.
    if (backgroundRunning.value) return BACKGROUND_SHELL_HEADLINES.complete;
    if (ongoing.value && !props.current) return `Unfinished action · ${single.value.tool.toolName.replace(/ToolCall$/, "")}`;
    return single.value.tool.headline;
  }
  return props.entry.category === "read" ? `${props.entry.actions.length} file reads` : `${props.entry.actions.length} workspace searches`;
});
const detail = computed(() => single.value ? single.value.tool.detail : props.entry.actions
  .map(action => action.tool.detail).filter(Boolean).join(" · "));
const icon = computed(() => {
  if (["error", "failed"].includes(status.value)) return CircleAlert;
  if (status.value === "interrupted" || (ongoing.value && !props.current && !backgroundRunning.value)) return Hourglass;
  if (single.value?.tool.kind === "reply") return Check;
  const name = props.entry.actions[0]?.tool.toolName ?? "";
  if (/readToolCall/.test(name)) return FileText;
  if (/grep|glob|search/i.test(name)) return Search;
  if (isShellToolName(name)) return SquareTerminal;
  if (/edit|write/i.test(name)) return FilePenLine;
  return Wrench;
});
</script>
