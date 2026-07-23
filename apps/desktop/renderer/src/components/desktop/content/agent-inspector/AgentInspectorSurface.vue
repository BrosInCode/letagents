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
    >
      {{ actionState.message }}
    </p>

    <div class="agent-inspector-tabs" role="tablist" aria-label="Agent inspector sections" @keydown="handleTabKeydown">
      <button ref="overviewTab" id="agent-inspector-overview-tab" type="button" role="tab" :aria-selected="selectedTab === 'overview'" aria-controls="agent-inspector-overview-panel" :tabindex="selectedTab === 'overview' ? 0 : -1" @click="selectTab('overview')">Overview</button>
      <button id="agent-inspector-work-tab" type="button" role="tab" :aria-selected="selectedTab === 'work'" aria-controls="agent-inspector-work-panel" :tabindex="selectedTab === 'work' ? 0 : -1" @click="selectTab('work')">Work</button>
      <button id="agent-inspector-settings-tab" type="button" role="tab" :aria-selected="selectedTab === 'settings'" aria-controls="agent-inspector-settings-panel" :tabindex="selectedTab === 'settings' ? 0 : -1" @click="selectTab('settings')">Settings</button>
      <button id="agent-inspector-diagnostics-tab" type="button" role="tab" :aria-selected="selectedTab === 'diagnostics'" aria-controls="agent-inspector-diagnostics-panel" :tabindex="selectedTab === 'diagnostics' ? 0 : -1" @click="selectTab('diagnostics')">Diagnostics</button>
    </div>

    <div class="agent-inspector-scroll-region">
      <div v-if="selectedTab === 'overview'" id="agent-inspector-overview-panel" role="tabpanel" aria-labelledby="agent-inspector-overview-tab">
        <AgentInspectorOverview
          :projection="projection"
          :busy="actionState?.status === 'running'"
          @stop-turn="emitTurnControl('stop_turn')"
          @correct-turn="emitTurnControl('steer_turn', $event)"
          @resolve-turn-control="emitTurnControl('resolve_turn_control', undefined, $event)"
        />
      </div>
      <AgentInspectorWork
        v-else-if="selectedTab === 'work'" id="agent-inspector-work-panel" role="tabpanel" aria-labelledby="agent-inspector-work-tab"
        :resource="workResource" :selected-source-message-id="selectedWorkSourceMessageId" :tasks="projection.assignedWork" :artifacts="workArtifacts"
        @retry="emit('work-retry')" @select-source="emit('work-source-select', $event)" @reveal="emit('reveal-message', $event)"
      />
      <AgentInspectorSettings
        v-else-if="selectedTab === 'settings'" id="agent-inspector-settings-panel" role="tabpanel" aria-labelledby="agent-inspector-settings-tab"
        :entry-id="projection.entryId" :workspace-path="projection.entry.workspacePath" :retired="projection.overallState === 'retired'"
        :resource="settingsResource" :move="roomMoveResource" :move-available="roomMoveAvailable" :providers="providers" :destinations="destinations"
        :busy="actionState?.status === 'running'" :conflict="settingsConflict"
        @patch="emit('settings-patch', $event)" @save="emit('settings-save', $event)" @reload="emit('settings-reload')"
        @prepare-move="emit('room-move-prepare', $event)" @commit-move="emit('room-move-commit')"
        @retire="emit('retire')" @purge="emit('purge')"
      />
      <AgentInspectorDiagnostics
        v-else id="agent-inspector-diagnostics-panel" role="tabpanel" aria-labelledby="agent-inspector-diagnostics-tab"
        :projection="projection"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import type {
  AgentInspectorActionIntent,
  AgentInspectorActionState,
  AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import type { AgentInspectorConfigurationResource, AgentInspectorRoomMoveResource } from "../../../../domain/agent-inspector-settings";
import type { DesktopAgentProvider, DesktopFocusRoomInfo } from "../../../../../../electron/ipc-types";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import AgentInspectorLifecycleActions from "./AgentInspectorLifecycleActions.vue";
import AgentInspectorOverview from "./AgentInspectorOverview.vue";
import AgentInspectorWork from "./AgentInspectorWork.vue";
import AgentInspectorSettings from "./AgentInspectorSettings.vue";
/** Diagnostics stays out of the normal inspector path until a human opens it. */
const AgentInspectorDiagnostics = defineAsyncComponent(() => import("./AgentInspectorDiagnostics.vue"));

const props = defineProps<{
  projection: AgentInspectorProjection;
  actionState: AgentInspectorActionState | null;
  compact: boolean;
  workResource: AgentInspectorWorkResource;
  selectedWorkSourceMessageId: string | null;
  workArtifacts: readonly RoomArtifactTimelineItem[];
  settingsResource: AgentInspectorConfigurationResource;
  roomMoveResource: AgentInspectorRoomMoveResource;
  roomMoveAvailable: boolean;
  providers: readonly DesktopAgentProvider[];
  destinations: readonly DesktopFocusRoomInfo[];
  settingsConflict: boolean;
}>();
const emit = defineEmits<{
  close: [];
  action: [intent: AgentInspectorActionIntent];
  "work-selected": [];
  "work-retry": [];
  "work-source-select": [sourceMessageId: string];
  "reveal-message": [canonicalMessageId: string];
  "settings-selected": [];
  "settings-patch": [patch: Partial<import("../../../../domain/agent-inspector-settings").AgentInspectorConfigurationDraft>];
  "settings-save": [overwrite: boolean];
  "settings-reload": [];
  "room-move-prepare": [destination: string];
  "room-move-commit": [];
  retire: [];
  purge: [];
}>();

const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const overviewTab = ref<HTMLButtonElement | null>(null);
const selectedTab = ref<"overview" | "work" | "settings" | "diagnostics">("overview");
const providerModelLabel = computed(() => [props.projection.provider, props.projection.model].filter(Boolean).join(" · "));

function focusInitial(): void {
  closeButton.value?.focus({ preventScroll: true });
}

function containsFocus(): boolean {
  return Boolean(surfaceElement.value?.contains(document.activeElement));
}

defineExpose({ focusInitial, containsFocus });

watch(() => props.projection.entryId, () => { selectedTab.value = "overview"; });

function selectTab(tab: "overview" | "work" | "settings" | "diagnostics"): void {
  if (selectedTab.value === tab) return;
  selectedTab.value = tab;
  if (tab === "work") emit("work-selected");
  if (tab === "settings") emit("settings-selected");
}

function emitTurnControl(
  kind: Extract<AgentInspectorActionIntent["kind"], "stop_turn" | "steer_turn" | "resolve_turn_control">,
  correction?: string,
  turnControlResolution?: "not_applied" | "applied",
): void {
  emit("action", {
    entryId: props.projection.entryId,
    roomId: props.projection.roomId,
    kind,
    ...(correction ? { correction } : {}),
    ...(turnControlResolution ? { turnControlResolution } : {}),
  });
}

function handleTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs: Array<"overview" | "work" | "settings" | "diagnostics"> = ["overview", "work", "settings", "diagnostics"];
  const current = tabs.indexOf(selectedTab.value);
  const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'diagnostics' : tabs[(current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]!;
  selectTab(next);
  void Promise.resolve().then(() => (next === 'overview' ? overviewTab.value : surfaceElement.value?.querySelector<HTMLButtonElement>(`#agent-inspector-${next}-tab`))?.focus());
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
