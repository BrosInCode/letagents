<template>
  <div class="agent-inspector-live">
    <section class="agent-inspector-live-summary" :data-running="isFollowing">
      <div class="agent-inspector-live-summary-head">
        <span class="agent-inspector-live-summary-dot" aria-hidden="true"></span>
        <div>
          <span class="agent-inspector-live-eyebrow">Live work</span>
          <strong>{{ workDurationLabel }}</strong>
        </div>
        <span class="agent-inspector-live-state">{{ workStateLabel }}</span>
      </div>
      <p v-if="currentStep">{{ currentStep }}</p>
    </section>

    <div v-if="canShowCurrent" class="agent-inspector-live-trigger">
      <span class="agent-inspector-live-label">Current turn</span>
      <template v-if="currentRequest">
        <strong>{{ currentRequest.sender }}</strong>
        <p>{{ currentRequest.text || 'Message text unavailable.' }}</p>
      </template>
    </div>
    <ol v-if="presented.length" class="agent-inspector-live-items">
      <li
        v-for="entry in presented"
        :key="`${entry.item.kind}:${entry.item.id}`"
        class="agent-inspector-live-item"
        :data-kind="entry.item.kind"
        :data-status="entry.item.kind === 'tool' ? entry.item.status : null"
        :data-work-kind="workKind(entry)"
      >
        <span class="agent-inspector-live-marker" aria-hidden="true"></span>
        <div class="agent-inspector-live-item-content">
          <template v-if="entry.item.kind === 'reasoning'">
            <span class="agent-inspector-live-label">Work note</span>
            <p class="agent-inspector-live-reasoning">{{ entry.item.text }}</p>
          </template>
          <template v-else-if="entry.item.kind === 'message'">
            <span
              class="agent-inspector-live-label"
              title="Public-safe commentary emitted by the provider while it works. The room receives only the reply recorded for the completed turn."
            >Agent commentary</span>
            <p class="agent-inspector-live-message">{{ entry.item.text }}</p>
          </template>
          <template v-else-if="entry.tool">
            <div class="agent-inspector-live-tool-head">
              <span class="agent-inspector-live-label">{{ entry.tool.kind === "reply" ? "Room result" : "Action" }}</span>
              <strong>{{ entry.tool.headline }}</strong>
              <span class="agent-inspector-live-tool-status" :data-status="entry.item.status">{{ toolStatusLabel(entry.item.status) }}</span>
            </div>
            <blockquote v-if="entry.tool.replyText" class="agent-inspector-live-reply">{{ entry.tool.replyText }}</blockquote>
            <p v-else-if="entry.tool.detail" class="agent-inspector-live-tool-detail">{{ entry.tool.detail }}</p>
            <p v-if="entry.item.error" class="agent-inspector-live-tool-error">{{ entry.item.error }}</p>
            <details
              v-if="formatValue(entry.item.input) || formatValue(entry.item.output)"
              class="agent-inspector-live-tool-raw"
            >
              <summary>Technical details · {{ entry.tool.toolName }}</summary>
              <pre v-if="formatValue(entry.item.input)" class="agent-inspector-live-tool-io">{{ formatValue(entry.item.input) }}</pre>
              <pre v-if="formatValue(entry.item.output)" class="agent-inspector-live-tool-io">{{ formatValue(entry.item.output) }}</pre>
            </details>
          </template>
        </div>
      </li>
    </ol>

    <p v-if="canShowCurrent && !presented.length" class="agent-inspector-live-empty">The agent is working. No public actions have arrived yet.</p>
    <p v-if="canShowCurrent && feed.droppedEvents > 0" class="agent-inspector-settings-note">Earlier live updates were omitted.</p>
    <AgentInspectorLiveHistory :resource="resource" :selected-source-message-id="selectedSourceMessageId"
      @retry="emit('retry')" @select-source="emit('select-source', $event)" @reveal="emit('reveal', $event)" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import AgentInspectorLiveHistory from "./AgentInspectorLiveHistory.vue";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import { canPresentCurrentAgentStream, currentAgentRequest } from "../../../../domain/agent-inspector-live-trace";
import {
  agentLiveAvailability,
  describeLiveToolCall,
  foldAgentStreamEvents,
  formatLiveWorkDuration,
  scopeAgentStreamEventsToWork,
} from "../../../../domain/agent-inspector-live";
import type { LiveToolPresentation, LiveTranscriptItem } from "../../../../domain/agent-inspector-live";
import type { AgentInspectorLiveWorkProjection } from "../../../../domain/agent-inspector";
import type { DesktopAgentStreamEvent } from "../../../../../../electron/ipc-types";

const props = defineProps<{
  feed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number };
  work: AgentInspectorLiveWorkProjection;
  supportsReasoning: boolean | null;
  resource: AgentInspectorWorkResource;
  selectedSourceMessageId: string | null;
  activeSourceMessageId: string | null;
}>();

const emit = defineEmits<{ retry: []; 'select-source': [sourceMessageId: string]; reveal: [messageId: string] }>();
const canShowCurrent = computed(() => canPresentCurrentAgentStream({ ...props.work, activeSourceMessageId: props.activeSourceMessageId }));
const currentRequest = computed(() => currentAgentRequest(props.resource, props.activeSourceMessageId));
const scopedEvents = computed(() => canShowCurrent.value ? scopeAgentStreamEventsToWork(props.feed.events, props.work) : []);
const transcript = computed(() => foldAgentStreamEvents(scopedEvents.value, props.feed.ended));
const now = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

const isFollowing = computed(() => props.work.active && !props.feed.ended);
const availability = computed(() => agentLiveAvailability(props.work, props.feed.ended));

const presented = computed((): { item: LiveTranscriptItem; tool: LiveToolPresentation | null }[] =>
  transcript.value.items.filter(item => item.kind !== "reasoning" || props.supportsReasoning !== false).map((item) => ({
    item,
    tool: item.kind === "tool" ? describeLiveToolCall(item.tool, item.input, item) : null,
  })));

const workDurationLabel = computed(() => {
  if (availability.value === "closed") return "Work stream closed";
  if (availability.value === "stale") return "Live status unavailable";
  if (availability.value === "stopped") return "Agent stopped";
  if (availability.value === "paused") return "Agent paused";
  if (availability.value === "disconnected") return "Agent disconnected";
  if (availability.value === "attention") return "Agent needs attention";
  if (availability.value === "transitioning") return transitionTitle(props.work.agentState);
  if (availability.value !== "active") return "Ready for a message";
  const duration = formatLiveWorkDuration(
    props.work.startedAt,
    null,
    now.value,
  );
  return duration ? `Working for ${duration}` : "Work in progress";
});

const workStateLabel = computed(() => {
  if (availability.value === "active") return "In progress";
  if (availability.value === "idle") return "Ready";
  if (availability.value === "stopped") return "Stopped";
  if (availability.value === "paused") return "Paused";
  if (availability.value === "attention") return "Needs attention";
  if (availability.value === "transitioning") return "Recovering";
  return "Unavailable";
});

const currentStep = computed(() => {
  if (availability.value === "closed") return props.work.agentState === "retired"
    ? "This agent is retired and cannot receive new room work."
    : null;
  if (availability.value === "stale") return "Waiting for fresh supervisor state before reporting live work.";
  if (availability.value === "stopped") return "This agent is retired and cannot receive new room work.";
  if (availability.value === "paused") return "Resume this agent before sending it more room work.";
  if (availability.value === "disconnected") return "Reconnect this agent before sending it more room work.";
  if (availability.value === "attention") return "Resolve the agent's blocked state before work can continue.";
  if (availability.value === "transitioning") return transitionDetail(props.work.agentState);
  if (availability.value === "idle") return null;
  const runningTool = [...presented.value].reverse().find((entry) =>
    entry.item.kind === "tool" && entry.item.status === "running");
  const entry = runningTool ?? presented.value[presented.value.length - 1];
  if (!entry) return props.work.detail || turnStateFallback(props.work.state);
  if (entry.item.kind === "tool") {
    if (!entry.tool) return "Using a tool";
    return entry.tool.detail ? `${entry.tool.headline} · ${entry.tool.detail}` : entry.tool.headline;
  }
  return null;
});

onMounted(syncElapsedTimer);

watch([() => props.feed.ended, () => props.work.active, () => props.work.startedAt], syncElapsedTimer);

onUnmounted(() => {
  stopElapsedTimer();
});

function syncElapsedTimer(): void {
  stopElapsedTimer();
  now.value = Date.now();
  if (!isFollowing.value) return;
  elapsedTimer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
}

function turnStateFallback(state: AgentInspectorLiveWorkProjection["state"]): string {
  if (state === "dispatching") return "Preparing a response";
  if (state === "publishing") return "Sending the response";
  if (state === "retrying") return "Trying the room turn again";
  return "Working on the room message";
}

function transitionTitle(state: AgentInspectorLiveWorkProjection["agentState"]): string {
  if (state === "starting") return "Agent starting";
  if (state === "reconnecting") return "Agent reconnecting";
  if (state === "restoring_conversation") return "Restoring conversation";
  return "Agent recovering";
}

function transitionDetail(state: AgentInspectorLiveWorkProjection["agentState"]): string {
  if (state === "starting") return "The agent is still starting and cannot receive room work yet.";
  if (state === "reconnecting") return "Reconnecting the room delivery path before work can continue.";
  if (state === "restoring_conversation") return "Restoring the private conversation before room work can continue.";
  return "Restoring room access before work can continue.";
}

function stopElapsedTimer(): void {
  if (!elapsedTimer) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function toolStatusLabel(status: string): string {
  if (status === "pending") return "Requested";
  if (status === "running") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "error" || status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return status.replace(/[_-]+/g, " ");
}

function workKind(entry: { item: LiveTranscriptItem; tool: LiveToolPresentation | null }): string {
  if (entry.tool?.kind === "reply") return "result";
  if (entry.item.kind === "tool") return "action";
  if (entry.item.kind === "message") return "commentary";
  return "note";
}

function formatValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    const text = JSON.stringify(input, null, 2);
    return text === "{}" ? "" : text;
  } catch {
    return "";
  }
}
</script>

<style scoped>
.agent-inspector-live-trigger { display: grid; gap: 6px; padding: 10px 12px; border-left: 2px solid rgba(96,165,250,.4); }
.agent-inspector-live-trigger strong { font-size: 12px; color: var(--text, #fafafa); }
.agent-inspector-live-trigger p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; color: var(--text-secondary, #a1a1aa); max-height: 140px; overflow: auto; }
</style>
