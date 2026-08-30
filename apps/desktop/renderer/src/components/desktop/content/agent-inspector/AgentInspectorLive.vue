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

    <p class="agent-inspector-settings-note">
      {{ evidenceDescription }} Hidden chain of thought is never shown. The supervisor's room-turn lifecycle owns whether work is active; technical payloads stay behind disclosure.
    </p>

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

    <p v-if="feed.droppedEvents > 0" class="agent-inspector-settings-note" role="status">
      {{ feed.droppedEvents }} earlier live-work {{ feed.droppedEvents === 1 ? "event was" : "events were" }} omitted because this provider stream exceeded the replay limit.
    </p>

    <p v-if="!presented.length" class="agent-inspector-live-empty">
      {{ emptyStateLabel }}
    </p>

    <p class="agent-inspector-live-footer" :data-running="isFollowing">
      <span aria-hidden="true"></span>{{ footerLabel }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
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
}>();

const scopedEvents = computed(() => scopeAgentStreamEventsToWork(props.feed.events, props.work));
const transcript = computed(() => foldAgentStreamEvents(scopedEvents.value, props.feed.ended));
const now = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

const isFollowing = computed(() => props.work.active && !props.feed.ended);
const availability = computed(() => agentLiveAvailability(props.work, props.feed.ended));

const presented = computed((): { item: LiveTranscriptItem; tool: LiveToolPresentation | null }[] =>
  transcript.value.items.map((item) => ({
    item,
    tool: item.kind === "tool" ? describeLiveToolCall(item.tool, item.input, item) : null,
  })));

const evidenceDescription = computed(() => props.supportsReasoning === false
  ? "Shows public commentary and observed actions from this provider."
  : "Shows provider-approved work notes, public commentary, and observed actions.");

const workDurationLabel = computed(() => {
  if (availability.value === "closed") return "Work stream closed";
  if (availability.value === "stale") return "Live status unavailable";
  if (availability.value === "stopped") return "Agent stopped";
  if (availability.value === "paused") return "Agent paused";
  if (availability.value === "disconnected") return "Agent disconnected";
  if (availability.value === "attention") return "Agent needs attention";
  if (availability.value === "transitioning") return transitionTitle(props.work.agentState);
  if (availability.value !== "active") return presented.value.length ? "Recent work" : "No work in progress";
  const duration = formatLiveWorkDuration(
    props.work.startedAt,
    null,
    now.value,
  );
  return duration ? `Working for ${duration}` : "Work in progress";
});

const workStateLabel = computed(() => {
  if (availability.value === "active") return "In progress";
  if (availability.value === "idle") return "Waiting";
  if (availability.value === "stopped") return "Stopped";
  if (availability.value === "paused") return "Paused";
  if (availability.value === "attention") return "Needs attention";
  if (availability.value === "transitioning") return "Recovering";
  return "Unavailable";
});

const currentStep = computed(() => {
  if (availability.value === "closed") return props.work.agentState === "retired"
    ? "This agent is retired and cannot receive new room work."
    : "The provider's activity stream is no longer available.";
  if (availability.value === "stale") return "Waiting for fresh supervisor state before reporting live work.";
  if (availability.value === "stopped") return "This agent is retired and cannot receive new room work.";
  if (availability.value === "paused") return "Resume this agent before sending it more room work.";
  if (availability.value === "disconnected") return "Reconnect this agent before sending it more room work.";
  if (availability.value === "attention") return "Resolve the agent's blocked state before work can continue.";
  if (availability.value === "transitioning") return transitionDetail(props.work.agentState);
  if (availability.value === "idle") return presented.value.length
    ? "The agent is ready for the next room message."
    : "No room turn is currently active.";
  const runningTool = [...presented.value].reverse().find((entry) =>
    entry.item.kind === "tool" && entry.item.status === "running");
  const entry = runningTool ?? presented.value[presented.value.length - 1];
  if (!entry) return props.work.detail || turnStateFallback(props.work.state);
  if (entry.item.kind === "tool") {
    if (!entry.tool) return "Using a tool";
    return entry.tool.detail ? `${entry.tool.headline} · ${entry.tool.detail}` : entry.tool.headline;
  }
  return truncateStep(entry.item.text);
});

const emptyStateLabel = computed(() => {
  if (availability.value === "closed") return "The provider's activity stream is not available.";
  if (availability.value === "stale") return "Live work will return when the supervisor reconnects.";
  if (availability.value !== "active") return "No recent work is available for this agent.";
  return props.work.startedAt
    ? "Waiting for the agent's next observed action…"
    : "Waiting for the supervisor's room-turn boundary…";
});

const footerLabel = computed(() => {
  if (isFollowing.value) return "Following the current room turn";
  if (availability.value === "closed") return "Work stream closed";
  if (availability.value === "stale") return "Live status unavailable";
  if (availability.value !== "idle") return "Live work unavailable";
  return "Waiting for room work";
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

function truncateStep(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 150 ? `${normalized.slice(0, 149)}…` : normalized;
}

function toolStatusLabel(status: string): string {
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
