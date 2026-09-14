<template>
  <div ref="liveElement" class="agent-inspector-live">
    <section class="agent-live-now" :data-running="isFollowing">
      <div class="agent-live-now-meta">
        <span class="agent-live-state" role="status"><span aria-hidden="true"></span>{{ workStateLabel }}</span>
        <span class="agent-live-duration">{{ workDurationLabel }}</span>
      </div>
      <p v-if="currentStep" class="agent-live-current-step">{{ currentStep }}</p>
    </section>

    <details v-if="canShowCurrent && currentRequest" class="agent-inspector-live-trigger" :key="activeSourceMessageId ?? undefined">
      <summary><MessageSquare :size="14" aria-hidden="true" /><span>Current request</span><span class="agent-live-request-sender">{{ currentRequest.sender }}</span></summary>
      <p>{{ currentRequest.text || 'Message text unavailable.' }}</p>
    </details>

    <div class="agent-live-timeline-heading">
      <h3>{{ canShowCurrent ? 'Activity' : 'Recent actions' }}</h3>
      <span v-if="actionCount">{{ actionCount }} {{ actionCount === 1 ? 'action' : 'actions' }}</span>
    </div>
    <p v-if="entries.length && !canShowCurrent" class="agent-live-notice">Saved updates from recent work.</p>
    <p v-if="feed.droppedEvents > 0" class="agent-live-notice">Earlier live updates were omitted. This trace starts with the updates still available.</p>

    <ol v-if="entries.length" class="agent-live-timeline" aria-label="Agent work activity">
      <li v-for="entry in entries" :key="`${entry.kind}:${entry.id}`" class="agent-live-entry" :data-kind="entry.kind" @pointerdown="preserveInspectedGroup(entry)" @focusin="preserveInspectedGroup(entry)">
        <AgentInspectorLiveActions v-if="entry.kind === 'actions'" :entry="entry" :current="isFollowing" />
        <template v-else>
          <span class="agent-live-icon" aria-hidden="true"><component :is="entry.kind === 'reasoning' ? NotebookPen : MessageSquare" :size="14" :stroke-width="1.6" /></span>
          <div class="agent-live-note">
            <span class="agent-live-caption">{{ entry.kind === 'reasoning' ? 'Work note' : 'Agent update' }}</span>
            <div class="agent-live-prose" v-html="renderDesktopMarkdown(entry.text, { block: true, mentions: false })"></div>
          </div>
        </template>
      </li>
    </ol>
    <div v-else class="agent-live-empty">
      <MessageSquare :size="22" :stroke-width="1.4" aria-hidden="true" />
      <p>{{ emptyStateLabel }}</p>
      <span>Actions and agent updates will appear here as they arrive.</span>
    </div>

    <div v-if="entries.length" class="agent-live-follow-bar">
      <span v-if="lastUpdateLabel" :title="formatFullTimestamp(transcript.lastActivityAt!)">Last update: {{ lastUpdateLabel }}</span>
      <button v-if="!followingLatest" type="button" @click="scrollFollower?.resume()"><ArrowDown :size="14" aria-hidden="true" />Follow latest</button>
      <span v-else class="agent-live-following"><span v-if="isFollowing" aria-hidden="true"></span>{{ isFollowing ? 'Following live' : 'Latest activity' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowDown, MessageSquare, NotebookPen } from "@lucide/vue";
import AgentInspectorLiveActions from "./AgentInspectorLiveActions.vue";
import { renderDesktopMarkdown } from "../formatting/markdown";
import { followAgentLiveScroll } from "../../../../domain/agent-inspector-live-scroll";
import { formatFullTimestamp } from "../../../../domain/time";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import { canPresentCurrentAgentStream, currentAgentRequest, presentAgentTrace, type LiveTraceEntry } from "../../../../domain/agent-inspector-live-trace";
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
  activeSourceMessageId: string | null;
}>();

const liveElement = ref<HTMLElement | null>(null);
const followingLatest = ref(true);
let scrollFollower: ReturnType<typeof followAgentLiveScroll> | undefined;
onMounted(() => {
  const content = liveElement.value;
  const viewport = content?.closest<HTMLElement>(".agent-inspector-scroll-region");
  if (content && viewport) scrollFollower = followAgentLiveScroll(viewport, content, following => { followingLatest.value = following; });
});
onUnmounted(() => scrollFollower?.dispose());

const canShowCurrent = computed(() => canPresentCurrentAgentStream({ ...props.work, activeSourceMessageId: props.activeSourceMessageId }));
const currentRequest = computed(() => currentAgentRequest(props.resource, props.activeSourceMessageId));
const scopedEvents = computed(() => !props.work.active || canShowCurrent.value ? scopeAgentStreamEventsToWork(props.feed.events, props.work) : []);
const transcript = computed(() => foldAgentStreamEvents(scopedEvents.value, props.feed.ended));
const now = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

const isFollowing = computed(() => availability.value === "active" && canShowCurrent.value);
const availability = computed(() => agentLiveAvailability(props.work, props.feed.ended));

const presented = computed((): { item: LiveTranscriptItem; tool: LiveToolPresentation | null }[] =>
  transcript.value.items.filter(item => item.kind !== "reasoning" || props.supportsReasoning !== false).map((item) => ({
    item,
    tool: item.kind === "tool" ? describeLiveToolCall(item.tool, item.input, item) : null,
  })));

const inspectedGroups = ref(new Map<string, string>());
const entries = computed(() => presentAgentTrace(transcript.value.items, props.supportsReasoning, inspectedGroups.value));
function preserveInspectedGroup(entry: LiveTraceEntry): void {
  if (entry.kind !== "actions" || inspectedGroups.value.has(entry.id)) return;
  const groups = new Map(inspectedGroups.value);
  for (const action of entry.actions) groups.set(action.item.id, entry.id);
  inspectedGroups.value = groups;
}
const actionCount = computed(() => transcript.value.items.filter(item => item.kind === "tool").length);
const lastUpdateLabel = computed(() => {
  const value = transcript.value.lastActivityAt;
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

const workDurationLabel = computed(() => {
  if (availability.value === "closed") return "Work stream closed";
  if (availability.value === "stale") return "Live status unavailable";
  if (availability.value === "stopped") return "Agent stopped";
  if (availability.value === "paused") return "Agent paused";
  if (availability.value === "disconnected") return "Agent disconnected";
  if (availability.value === "attention") return "Agent needs attention";
  if (availability.value === "transitioning") return transitionTitle(props.work.agentState);
  if (availability.value !== "active") return "Ready for a message";
  if (!canShowCurrent.value) return "Identifying current work";
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
  if (!canShowCurrent.value) return null;
  const runningTool = [...presented.value].reverse().find((entry) =>
    entry.item.kind === "tool" && ["running", "pending"].includes(entry.item.status));
  const entry = runningTool ?? presented.value[presented.value.length - 1];
  if (!entry) return props.work.detail || turnStateFallback(props.work.state);
  if (entry.item.kind === "tool") {
    if (!entry.tool) return "Using a tool";
    return entry.tool.detail ? `${entry.tool.headline} · ${entry.tool.detail}` : entry.tool.headline;
  }
  return entry.item.text.replace(/\s+/g, " ").trim().slice(0, 150);
});

const emptyStateLabel = computed(() => {
  if (["stale", "closed", "disconnected", "paused", "stopped", "attention"].includes(availability.value)) return "No recent actions are available.";
  if (props.work.active && !canShowCurrent.value) return "Current activity unavailable: waiting for the current request to be identified.";
  if (canShowCurrent.value) return "The agent is working. No public actions have arrived yet.";
  return "No recent actions are available.";
});

onMounted(syncElapsedTimer);

watch([isFollowing, () => props.work.startedAt], syncElapsedTimer);

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

</script>

<style>
@import "./agent-inspector-live.css";
</style>
