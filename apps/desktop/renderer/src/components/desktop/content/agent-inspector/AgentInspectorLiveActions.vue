<template>
  <div class="agent-live-action" :data-status="status" :data-current="current && ongoing" :data-result="single?.tool.kind === 'reply'">
    <details class="agent-live-disclosure">
      <summary>
        <span class="agent-live-icon" aria-hidden="true"><component :is="icon" :size="15" :stroke-width="1.6" /></span>
        <span class="agent-live-action-copy">
          <span class="agent-live-action-title">{{ headline }}</span>
          <span v-if="detail" class="agent-live-action-detail" :title="detail">{{ detail }}</span>
        </span>
        <span class="agent-live-action-status">{{ liveActionStatus(status, current) }}</span>
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
            <span class="agent-live-caption">Output</span>
            <pre>{{ formatLiveValue(single.item.output) }}</pre>
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
    <div v-if="failure" class="agent-live-error">
      <p>{{ failure.message }}</p>
      <template v-if="failure.outputPreview">
        <span class="agent-live-caption">Output excerpt</span>
        <pre>{{ failure.outputPreview }}</pre>
      </template>
      <p v-if="failure.detail" class="agent-live-failure-detail">{{ failure.detail }}</p>
    </div>
    <div v-if="single?.tool.replyText" class="agent-live-prose agent-live-reply" v-html="renderDesktopMarkdown(single.tool.replyText, { block: true, mentions: false })"></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Check, ChevronRight, CircleAlert, FilePenLine, FileText, Hourglass, Search, SquareTerminal, Wrench } from "@lucide/vue";
import { formatLiveValue, liveActionFailure, liveActionStatus, type LiveTraceEntry } from "../../../../domain/agent-inspector-live-trace";
import { renderDesktopMarkdown } from "../formatting/markdown";

const props = defineProps<{ entry: Extract<LiveTraceEntry, { kind: "actions" }>; current: boolean }>();
const single = computed(() => props.entry.actions.length === 1 ? props.entry.actions[0]! : null);
const failure = computed(() => single.value ? liveActionFailure(single.value) : null);
const status = computed(() => single.value?.item.error ? "error" : single.value?.item.status ?? "completed");
const ongoing = computed(() => ["pending", "running"].includes(status.value));
const headline = computed(() => {
  if (single.value) {
    if (ongoing.value && !props.current) return `Unfinished action · ${single.value.tool.toolName.replace(/ToolCall$/, "")}`;
    return single.value.tool.headline;
  }
  return props.entry.category === "read" ? `${props.entry.actions.length} file reads` : `${props.entry.actions.length} workspace searches`;
});
const detail = computed(() => single.value ? single.value.tool.detail : props.entry.actions
  .map(action => action.tool.detail).filter(Boolean).join(" · "));
const icon = computed(() => {
  if (["error", "failed"].includes(status.value)) return CircleAlert;
  if (status.value === "interrupted" || (ongoing.value && !props.current)) return Hourglass;
  if (single.value?.tool.kind === "reply") return Check;
  const name = props.entry.actions[0]?.tool.toolName ?? "";
  if (/readToolCall/.test(name)) return FileText;
  if (/grep|glob|search/i.test(name)) return Search;
  if (/shell|terminal/i.test(name)) return SquareTerminal;
  if (/edit|write/i.test(name)) return FilePenLine;
  return Wrench;
});
</script>
