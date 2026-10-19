<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface agent-inspector-participant-surface"
    :data-compact="compact"
    :data-kind="projection.kind" :data-tab="selectedTab"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-participant-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <ProviderBadge :label="shared.provider" :agent-key="workspaceAgentKey" />
        <div>
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-participant-title">{{ projection.title }}</h2>
          </div>
          <p>{{ shared.provider }}</p>
        </div>
      </div>
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <template v-if="shared.owner">
      <p class="agent-inspector-owner-line">{{ shared.ownerLabel }}</p>
      <AgentInspectorSignal v-bind="shared.signal" />
    </template>
    <div class="agent-inspector-tabs" role="tablist" aria-label="Agent inspector sections" @keydown="handleTabKeydown">
      <button id="participant-overview-tab" type="button" role="tab" :aria-selected="selectedTab === 'overview'" :tabindex="selectedTab === 'overview' ? 0 : -1" aria-controls="participant-overview-panel" @click="selectedTab = 'overview'">Overview</button>
      <button v-if="liveView" id="participant-live-tab" type="button" role="tab" :aria-selected="selectedTab === 'live'" :tabindex="selectedTab === 'live' ? 0 : -1" aria-controls="participant-live-panel" @click="selectedTab = 'live'">Live</button>
      <button id="participant-workspace-tab" type="button" role="tab" :aria-selected="selectedTab === 'workspace'" :tabindex="selectedTab === 'workspace' ? 0 : -1" aria-controls="participant-workspace-panel" @click="selectedTab = 'workspace'">Workspace</button>
    </div>
    <div v-if="selectedTab === 'live' && liveView" class="agent-inspector-scroll-region">
      <AgentInspectorSharedLive id="participant-live-panel" role="tabpanel" aria-labelledby="participant-live-tab"
        :view="liveView" :presence="shared.signal.state" @reveal-request="emit('reveal-live-request', $event)" />
    </div>
    <AgentInspectorWorkspace v-if="selectedTab === 'workspace'" id="participant-workspace-panel" class="agent-inspector-scroll-region" role="tabpanel" aria-labelledby="participant-workspace-tab"
      :work="roomAgentWork ?? []" :agent-key="workspaceAgentKey ?? null" :status="roomAgentWorkStatus ?? 'idle'" :source-message-id="workspaceSourceMessageId" :request-version="requestVersion" />
    <div v-show="selectedTab === 'overview'" id="participant-overview-panel" role="tabpanel" aria-labelledby="participant-overview-tab" class="agent-inspector-participant-overview">
      <div class="agent-inspector-scroll-region agent-inspector-participant-scroll">
        <template v-if="!shared.owner">
          <p class="agent-inspector-owner-line">{{ shared.ownerLabel }}</p>
          <AgentInspectorSignal v-bind="shared.signal">
            <template #footer>
              <span>Shared with {{ roomDisplayName || roomIdentifier }}</span>
              <button v-if="reasoning" type="button" class="agent-inspector-signal-link" @click="emit('open-reasoning', reasoning.id)">View activity <span aria-hidden="true">→</span></button>
            </template>
          </AgentInspectorSignal>
        </template>
        <template v-else>
          <section class="agent-inspector-overview-section">
            <div class="agent-inspector-section-heading"><p>Shared work</p></div>
            <p class="agent-inspector-charter">{{ reasoning ? reasoningSummary(reasoning) : 'No work summary has been shared yet.' }}</p>
            <button v-if="reasoning" type="button" class="agent-inspector-inline-action" @click="emit('open-reasoning', reasoning.id)">View activity →</button>
          </section>
          <button type="button" class="agent-inspector-shared-changes" @click="selectedTab = 'workspace'">
            <span>Workspace</span><span>View shared changes <span aria-hidden="true">→</span></span>
          </button>
        </template>
      </div>
    </div>
    <footer v-if="shared.owner" class="agent-inspector-footer">Manage on the host machine</footer>
  </aside>
</template>

<script setup lang="ts">
import AgentInspectorSignal from "./AgentInspectorSignal.vue";
import type { sharedAgentInspectorPresentation } from "../../../../domain/agent-inspector-presentation";
import AgentInspectorWorkspace from "./AgentInspectorWorkspace.vue";
import AgentInspectorSharedLive from "./AgentInspectorSharedLive.vue";
import { computed, nextTick, ref, watch } from "vue";
import type { SharedLiveView } from "../../../../domain/agent-inspector-shared-live";
import type { DesktopReasoningSession } from "../../../../../../electron/ipc-types";
import type { AgentInspectorParticipantProjection } from "../../../../domain/agent-inspector-participant";
import { reasoningSummary } from "../../../../domain/reasoning";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";

const props = defineProps<{
  initialTab?: "overview" | "live" | "work" | "workspace" | "diagnostics";
  roomAgentWork?: import("../../../../../../electron/ipc-types").DesktopRoomAgentWork[];
  roomAgentWorkStatus?: string;
  workspaceSourceMessageId?: string | null;
  workspaceAgentKey?: string | null;
  shared: ReturnType<typeof sharedAgentInspectorPresentation>;
  roomDisplayName?: string;
  compact: boolean;
  projection: AgentInspectorParticipantProjection;
  roomIdentifier: string;
  requestVersion: number;
  reasoning: DesktopReasoningSession | null;
  /** The agent's current turn, when its owner shares live activity with the room. */
  liveView?: SharedLiveView | null;
}>();
type ParticipantTab = "overview" | "live" | "workspace";
// Live is offered only while the agent's owner shares it.
const tabs = computed<ParticipantTab[]>(() => props.liveView ? ["overview", "live", "workspace"] : ["overview", "workspace"]);
function requestedTab(): ParticipantTab {
  if (props.initialTab === "workspace") return "workspace";
  return props.initialTab === "live" && props.liveView ? "live" : "overview";
}
const selectedTab = ref<ParticipantTab>(requestedTab());
watch([() => props.initialTab, () => props.requestVersion], () => { selectedTab.value = requestedTab(); });
// When the owner stops sharing, what was shared disappears with the tab.
watch(() => Boolean(props.liveView), (sharing) => { if (!sharing && selectedTab.value === "live") selectedTab.value = "overview"; });
function handleTabKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const order = tabs.value;
  const index = Math.max(0, order.indexOf(selectedTab.value));
  selectedTab.value = event.key === 'Home' ? order[0]!
    : event.key === 'End' ? order.at(-1)!
    : order[(index + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]!;
  void nextTick(() => surfaceElement.value?.querySelector<HTMLButtonElement>(`#participant-${selectedTab.value}-tab`)?.focus());
}
const emit = defineEmits<{
  close: [];
  "open-reasoning": [sessionId: string];
  "reveal-live-request": [messageId: string];
}>();
const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);

function focusInitial(): void { closeButton.value?.focus({ preventScroll: true }); }
function containsFocus(): boolean { return Boolean(surfaceElement.value?.contains(document.activeElement)); }
defineExpose({ focusInitial, containsFocus });

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
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
</script>
