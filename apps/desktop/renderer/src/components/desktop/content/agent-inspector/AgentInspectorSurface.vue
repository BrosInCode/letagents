<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface"
    :data-compact="compact"
    :data-state="projection.overallState"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <ProviderBadge :label="projection.provider" :agent-key="projection.entry.agentKey" />
        <div>
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-title">{{ projection.displayName }}</h2>
            <span class="agent-inspector-state-label" :data-state="projection.overallState">
              <span aria-hidden="true"></span>{{ projection.overallLabel }}
            </span>
          </div>
          <p>
            <span v-if="projection.ownerAttribution">{{ projection.ownerAttribution }} · </span>
            {{ providerModelLabel }}
          </p>
        </div>
      </div>
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <div class="agent-inspector-status-copy">
      <strong>{{ projection.overallLabel }}</strong>
      <p>{{ projection.overallDetail }}</p>
    </div>

    <p v-if="projection.resourceFreshness === 'stale'" class="agent-inspector-stale-banner" role="status">
      Showing the last known agent state. Controls that depend on live state are unavailable until the supervisor reconnects.
    </p>

    <AgentInspectorLifecycleActions
      :entry-id="projection.entryId"
      :room-id="projection.roomId"
      :actions="projection.actions"
      :busy="actionState?.status === 'running'"
      :compact="compact"
      @action="emit('action', $event)"
    />

    <p
      v-if="actionState?.message"
      class="agent-inspector-action-message"
      :data-state="actionState.status"
      aria-live="polite"
    >
      {{ actionState.message }}
    </p>

    <div class="agent-inspector-tabs" role="tablist" aria-label="Agent inspector sections" @keydown="handleTabKeydown">
      <button ref="overviewTab" id="agent-inspector-overview-tab" type="button" role="tab" :aria-selected="selectedTab === 'overview'" aria-controls="agent-inspector-overview-panel" :tabindex="selectedTab === 'overview' ? 0 : -1" @click="selectTab('overview')">Overview</button>
      <button id="agent-inspector-work-tab" type="button" role="tab" :aria-selected="selectedTab === 'work'" aria-controls="agent-inspector-work-panel" :tabindex="selectedTab === 'work' ? 0 : -1" @click="selectTab('work')">Work</button>
    </div>

    <div class="agent-inspector-scroll-region">
      <div v-if="selectedTab === 'overview'" id="agent-inspector-overview-panel" role="tabpanel" aria-labelledby="agent-inspector-overview-tab"><AgentInspectorOverview :projection="projection" /></div>
      <AgentInspectorWork
        v-else id="agent-inspector-work-panel" role="tabpanel" aria-labelledby="agent-inspector-work-tab"
        :resource="workResource" :selected-source-message-id="selectedWorkSourceMessageId" :tasks="projection.assignedWork" :artifacts="workArtifacts"
        @retry="emit('work-retry')" @select-source="emit('work-source-select', $event)" @reveal="emit('reveal-message', $event)"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  AgentInspectorActionIntent,
  AgentInspectorActionState,
  AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import AgentInspectorLifecycleActions from "./AgentInspectorLifecycleActions.vue";
import AgentInspectorOverview from "./AgentInspectorOverview.vue";
import AgentInspectorWork from "./AgentInspectorWork.vue";

const props = defineProps<{
  projection: AgentInspectorProjection;
  actionState: AgentInspectorActionState | null;
  compact: boolean;
  workResource: AgentInspectorWorkResource;
  selectedWorkSourceMessageId: string | null;
  workArtifacts: readonly RoomArtifactTimelineItem[];
}>();
const emit = defineEmits<{
  close: [];
  action: [intent: AgentInspectorActionIntent];
  "work-selected": [];
  "work-retry": [];
  "work-source-select": [sourceMessageId: string];
  "reveal-message": [canonicalMessageId: string];
}>();

const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const overviewTab = ref<HTMLButtonElement | null>(null);
const selectedTab = ref<"overview" | "work">("overview");
const providerModelLabel = computed(() => [props.projection.provider, props.projection.model].filter(Boolean).join(" · "));

function focusInitial(): void {
  closeButton.value?.focus({ preventScroll: true });
}

function containsFocus(): boolean {
  return Boolean(surfaceElement.value?.contains(document.activeElement));
}

defineExpose({ focusInitial, containsFocus });

watch(() => props.projection.entryId, () => { selectedTab.value = "overview"; });

function selectTab(tab: "overview" | "work"): void {
  if (selectedTab.value === tab) return;
  selectedTab.value = tab;
  if (tab === "work") emit("work-selected");
}

function handleTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'overview' : 'work';
  selectTab(next);
  void Promise.resolve().then(() => (next === 'overview' ? overviewTab.value : surfaceElement.value?.querySelector<HTMLButtonElement>('#agent-inspector-work-tab'))?.focus());
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.compact && event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (!props.compact || event.key !== "Tab" || !surfaceElement.value) return;
  const focusable = [...surfaceElement.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>
