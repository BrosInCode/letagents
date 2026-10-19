<template>
  <div class="agent-inspector-live agent-inspector-shared-live">
    <section class="agent-live-now" :data-running="state === 'working'">
      <div class="agent-live-now-meta">
        <span class="agent-live-state" role="status"><span aria-hidden="true"></span>{{ stateLabel }}</span>
        <span class="agent-live-duration">{{ durationLabel }}</span>
      </div>
      <p v-if="currentStep" class="agent-live-current-step">{{ currentStep }}</p>
    </section>

    <button v-if="view.snapshot.request_message_id" type="button" class="agent-inspector-shared-live-request" @click="emit('reveal-request', view.snapshot.request_message_id)">
      <MessageSquare :size="14" aria-hidden="true" /><span>{{ state === 'finished' ? 'Request' : 'Current request' }}</span><span class="agent-live-request-sender">Show in chat <span aria-hidden="true">→</span></span>
    </button>

    <div class="agent-live-timeline-heading">
      <h3>Activity</h3>
      <span v-if="actionCount">{{ actionCount }} {{ actionCount === 1 ? 'action' : 'actions' }}</span>
    </div>
    <p class="agent-live-notice">Commands, file contents and tool results are not shared.</p>
    <p v-if="view.snapshot.omitted_earlier" class="agent-live-notice">Earlier updates from this request were left out.</p>

    <ol v-if="view.snapshot.entries.length" class="agent-live-timeline" aria-label="Shared agent activity">
      <li v-for="entry in view.snapshot.entries" :key="entry.id" class="agent-live-entry" :data-kind="entry.kind === 'note' ? 'reasoning' : entry.kind === 'update' ? 'message' : 'actions'">
        <div v-if="entry.kind === 'action'" class="agent-live-action" :data-status="entry.status" :data-current="state === 'working' && ongoing(entry.status)" :data-result="entry.tool === 'reply'">
          <div class="agent-live-row">
            <span class="agent-live-icon" aria-hidden="true"><component :is="actionIcon(entry)" :size="15" :stroke-width="1.6" /></span>
            <span class="agent-live-action-copy"><span class="agent-live-action-title">{{ entry.headline }}</span></span>
            <span class="agent-live-action-status">{{ liveActionStatus(entry.status, state === 'working') }}</span>
          </div>
        </div>
        <template v-else>
          <span class="agent-live-icon" aria-hidden="true"><component :is="entry.kind === 'note' ? NotebookPen : MessageSquare" :size="14" :stroke-width="1.6" /></span>
          <div class="agent-live-note">
            <span class="agent-live-caption">{{ entry.kind === 'note' ? 'Work note' : 'Agent update' }}</span>
            <MarkdownBlock class="agent-live-prose" :text="entry.text" :mentions="false" />
          </div>
        </template>
      </li>
    </ol>
    <div v-else class="agent-live-empty">
      <MessageSquare :size="22" :stroke-width="1.4" aria-hidden="true" />
      <p>{{ state === 'working' ? 'The agent is working. No shared actions yet.' : 'No actions were shared for this request.' }}</p>
      <span>Work notes, updates and action names appear here as the agent works.</span>
    </div>

    <div v-if="lastUpdateLabel" class="agent-live-follow-bar">
      <span :title="formatFullTimestamp(view.updatedAt!)">Last update: {{ lastUpdateLabel }}</span>
      <span class="agent-live-following"><span v-if="state === 'working'" aria-hidden="true"></span>{{ state === 'working' ? 'Live' : 'Latest shared activity' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDate } from "../../../../domain/formatters";
import { computed, type Component } from "vue";
import { useNow } from "../../../../composables/useNow";
import { Bot, Check, CircleAlert, FilePenLine, FileText, Globe, Hourglass, ListChecks, MessageSquare, NotebookPen, Search, SquareTerminal, Wrench } from "@lucide/vue";
import MarkdownBlock from "../formatting/MarkdownBlock.vue";
import { formatFullTimestamp } from "../../../../domain/time";
import { liveActionStatus } from "../../../../domain/agent-inspector-live-trace";
import { formatLiveWorkDuration } from "../../../../domain/agent-inspector-live";
import { sharedLiveState, type SharedLiveView } from "../../../../domain/agent-inspector-shared-live";
import type { RoomLiveEntry } from "../../../../../../../../shared/agent-live-trace.mjs";

/**
 * Another member's view of an agent's turn, shared by the agent's owner. It
 * keeps the owner's timeline look, without the action inputs, outputs and
 * errors, which never leave the owner's computer.
 */
const props = defineProps<{ view: SharedLiveView; presence: string }>();
const emit = defineEmits<{ "reveal-request": [messageId: string] }>();

const state = computed(() => sharedLiveState(props.view.snapshot, props.presence));
// One shared 1 s clock, running only while the agent works. The max keeps the
// value fresh when the clock was idle.
const clock = useNow(1_000, () => state.value === "working");
const now = computed(() => Math.max(clock.value, Date.now()));

const stateLabel = computed(() => ({ working: "In progress", finished: "Finished", delayed: "Updates delayed", attention: "Needs attention", stopped: "Stopped updating" })[state.value]);
const durationLabel = computed(() => {
  const { started_at: startedAt, ended_at: endedAt } = props.view.snapshot;
  if (state.value === "finished") {
    const duration = formatLiveWorkDuration(startedAt, endedAt, now.value);
    return duration ? `Worked for ${duration}` : "Finished";
  }
  if (state.value === "attention") return "Waiting for its owner";
  if (state.value !== "working") return "Live updates are not arriving";
  const duration = formatLiveWorkDuration(startedAt, null, now.value);
  return duration ? `Working for ${duration}` : "Work in progress";
});
const currentStep = computed(() => state.value === "working" ? props.view.currentStep : null);
const actionCount = computed(() => props.view.snapshot.entries.reduce((count, entry) => count + (entry.kind === "action" ? entry.count : 0), 0));
const lastUpdateLabel = computed(() => {
  const value = props.view.updatedAt;
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return formatDate("clockTime", value);
});

function ongoing(status: string): boolean {
  return status === "pending" || status === "running";
}

function actionIcon(entry: Extract<RoomLiveEntry, { kind: "action" }>): Component {
  if (entry.status === "failed") return CircleAlert;
  if (entry.status === "interrupted" || (ongoing(entry.status) && state.value !== "working")) return Hourglass;
  return ({ reply: Check, shell: SquareTerminal, read: FileText, search: Search, edit: FilePenLine, web: Globe, agent: Bot, plan: ListChecks, room: MessageSquare, other: Wrench } as const)[entry.tool];
}
</script>

<style>
@import "./agent-inspector-live.css";
</style>
