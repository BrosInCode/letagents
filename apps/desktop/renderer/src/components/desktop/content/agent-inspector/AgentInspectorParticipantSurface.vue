<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface agent-inspector-participant-surface"
    :data-compact="compact"
    :data-kind="projection.kind" :data-tab="workspaceSelected ? 'workspace' : 'overview'"
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
    <div class="agent-inspector-tabs" role="tablist" aria-label="Agent inspector sections" @keydown="handleWorkspaceTabs">
      <button id="participant-overview-tab" type="button" role="tab" :aria-selected="!workspaceSelected" :tabindex="workspaceSelected ? -1 : 0" aria-controls="participant-overview-panel" @click="workspaceSelected = false">Overview</button>
      <button id="participant-workspace-tab" type="button" role="tab" :aria-selected="workspaceSelected" :tabindex="workspaceSelected ? 0 : -1" aria-controls="participant-workspace-panel" @click="workspaceSelected = true">Workspace</button>
    </div>
    <AgentInspectorWorkspace v-if="workspaceSelected" id="participant-workspace-panel" class="agent-inspector-scroll-region" role="tabpanel" aria-labelledby="participant-workspace-tab"
      :work="roomAgentWork ?? []" :agent-key="workspaceAgentKey ?? null" :status="roomAgentWorkStatus ?? 'idle'" :source-message-id="workspaceSourceMessageId" :request-version="requestVersion" />
    <div v-show="!workspaceSelected" id="participant-overview-panel" role="tabpanel" aria-labelledby="participant-overview-tab" class="agent-inspector-participant-overview">
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
          <button type="button" class="agent-inspector-shared-changes" @click="workspaceSelected = true">
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
import { nextTick, ref, watch } from "vue";
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
}>();
const workspaceSelected = ref(props.initialTab === 'workspace');
watch([() => props.initialTab, () => props.requestVersion], () => { workspaceSelected.value = props.initialTab === 'workspace'; });
function handleWorkspaceTabs(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  workspaceSelected.value = event.key === 'Home' ? false : event.key === 'End' ? true : !workspaceSelected.value;
  void nextTick(() => surfaceElement.value?.querySelector<HTMLButtonElement>(workspaceSelected.value ? '#participant-workspace-tab' : '#participant-overview-tab')?.focus());
}
const emit = defineEmits<{
  close: [];
  "open-reasoning": [sessionId: string];
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
