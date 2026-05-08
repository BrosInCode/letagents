<template>
  <div
    class="desktop-agent-modal-backdrop"
    role="presentation"
    @click.self="$emit('close')"
  >
    <section
      class="desktop-agent-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`${agent.displayName} activity`"
    >
      <header class="desktop-agent-modal-header">
        <div>
          <span>{{ agent.ideLabel || "Agent" }}</span>
          <h3>{{ agent.displayName }}</h3>
          <p>{{ agent.ownerAttribution || activeAgentPresence?.ownerLabel || "Room agent" }}</p>
        </div>
        <button type="button" aria-label="Close agent activity" @click="$emit('close')">Close</button>
      </header>

      <div class="desktop-agent-modal-stats">
        <article>
          <strong>{{ activeAgentPresence ? connectionLabel(activeAgentPresence) : "Unknown" }}</strong>
          <span>Presence</span>
        </article>
        <article>
          <strong>{{ activeAgentTasks.length }}</strong>
          <span>Open tasks</span>
        </article>
        <article>
          <strong>{{ activeAgentReasoning.length }}</strong>
          <span>Thinking streams</span>
        </article>
        <article>
          <strong>{{ formatRelativeTime(activeAgentLastSeenAt) }}</strong>
          <span>Last signal</span>
        </article>
      </div>

      <section class="desktop-agent-modal-section">
        <header>
          <h4>Activity</h4>
          <span>{{ activeAgentMessages.length }}</span>
        </header>
        <article
          v-for="message in activeAgentMessages"
          :key="message.id"
          class="desktop-agent-modal-card"
        >
          <strong>{{ message.text ? messagePreview(message.text) : "Attachment" }}</strong>
          <span>{{ formatRelativeTime(message.timestamp) }}</span>
        </article>
        <p v-if="!activeAgentMessages.length" class="desktop-agent-modal-empty">No recent chat messages from this agent.</p>
      </section>

      <section class="desktop-agent-modal-section">
        <header>
          <h4>Thinking stream</h4>
          <span>{{ activeAgentReasoning.length }}</span>
        </header>
        <article
          v-for="session in activeAgentReasoning"
          :key="session.id"
          class="desktop-agent-modal-card is-reasoning"
        >
          <strong>{{ reasoningTitle(session) }}</strong>
          <p>{{ reasoningSummary(session) }}</p>
          <span>{{ formatRelativeTime(session.updatedAt || session.createdAt) }}</span>
          <button type="button" class="desktop-reasoning-open-button" @click="$emit('open-reasoning', session.id)">
            Open reasoning
          </button>
        </article>
        <p v-if="!activeAgentReasoning.length" class="desktop-agent-modal-empty">No visible thinking stream is active for this agent.</p>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAgentPresence,
  DesktopReasoningSession,
  DesktopRoomMessage,
  DesktopTaskSummary,
} from "../../../../../electron/ipc-types";
import { normalizeAgentKey } from "../../../domain/agents";
import { reasoningSummary, reasoningTitle } from "../../../domain/reasoning";
import { formatRelativeTime, latestTimestamp, timestampValue } from "../../../domain/time";
import type { AgentModalTarget } from "./DesktopChatMessage.vue";

const props = defineProps<{
  agent: AgentModalTarget;
  messages: DesktopRoomMessage[];
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  tasks: DesktopTaskSummary[];
}>();

defineEmits<{
  close: [];
  "open-reasoning": [sessionId: string];
}>();

const activeAgentKey = computed(() => normalizeAgentKey(props.agent.actorLabel || props.agent.sender || props.agent.displayName || ""));
const activeAgentPresence = computed(() =>
  props.presence.find((presence) =>
    normalizeAgentKey(presence.actorLabel) === activeAgentKey.value
    || normalizeAgentKey(presence.displayName) === activeAgentKey.value
  ) || null
);
const activeAgentMessages = computed(() =>
  props.messages
    .filter((message) => isMessageFromActiveAgent(message))
    .filter((message) => !isThinkingUpdateMessage(message))
    .slice(-6)
    .reverse()
);
const activeAgentReasoning = computed(() =>
  props.reasoningSessions
    .filter((session) => {
      const actor = normalizeAgentKey(session.actorLabel || "");
      return actor && actor === activeAgentKey.value;
    })
    .sort((left, right) => timestampValue(right.updatedAt || right.createdAt) - timestampValue(left.updatedAt || left.createdAt))
);
const activeAgentTasks = computed(() =>
  props.tasks.filter((task) => {
    const assignee = normalizeAgentKey(task.assignee || "");
    const agentKey = normalizeAgentKey(activeAgentPresence.value?.agentKey || "");
    return Boolean(assignee && (assignee === activeAgentKey.value || assignee === agentKey));
  })
);
const activeAgentLastSeenAt = computed(() =>
  latestTimestamp(
    activeAgentPresence.value?.lastHeartbeatAt,
    activeAgentMessages.value[0]?.timestamp,
    activeAgentReasoning.value[0]?.updatedAt,
    activeAgentReasoning.value[0]?.createdAt,
    activeAgentTasks.value[0]?.updatedAt,
  )
);

function isMessageFromActiveAgent(message: DesktopRoomMessage): boolean {
  if (!activeAgentKey.value) return false;
  return [
    message.actorLabel,
    message.agentIdentity?.actorLabel,
    message.agentIdentity?.displayName,
    message.sender,
  ].some((value) => normalizeAgentKey(value || "") === activeAgentKey.value);
}

function isThinkingUpdateMessage(message: DesktopRoomMessage): boolean {
  return message.source === "agent" && /^\[status\]\s*/i.test(message.text || "");
}

function connectionLabel(presence: DesktopAgentPresence): string {
  if (presence.activityState === "active") return "Connected";
  if (presence.activityState === "away") return "Away";
  return "Offline";
}

function messagePreview(value: string): string {
  const normalized = value.replace(/^\[status\]\s*/i, "").replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
</script>
