<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface"
    :data-compact="compact"
    :data-state="projection.overallState" :data-tab="selectedTab"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <ProviderBadge :label="projection.provider" :agent-key="projection.entry.agentKey" />
        <div class="agent-inspector-identity-copy">
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-title">{{ projection.displayName }}</h2>
            <span v-if="projection.entry.homeHarness" class="agent-inspector-own-setup" :title="homeHarnessBadge(projection.provider, projection.entry.homeHarness).title" data-testid="agent-inspector-own-setup">{{ homeHarnessBadge(projection.provider, projection.entry.homeHarness).label }}</span>
          </div>
          <p>
            {{ providerModelLabel }}
          </p>
        </div>
      </div>
      <div class="agent-inspector-header-tools">
        <AgentInspectorLifecycleActions
          :entry-id="projection.entryId" :room-id="projection.roomId"
          :actions="headerActions" :busy="lifecycleActionBusy" :busy-kind="lifecycleBusyKind"
          :compact="compact" menu-only @action="handleLifecycleAction"
        />
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
      </div>
    </header>

    <AgentInspectorSignal
      v-if="selectedTab !== 'diagnostics'"
      :label="signal.label" :detail="signal.detail" :state="signal.state" :tone="signal.tone" :moving="signal.moving"
    >
      <template #actions>
        <button v-if="projection.turnControl?.canStop" type="button" :disabled="lifecycleActionBusy" @click="emitTurnControl('stop_turn')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>Stop turn
        </button>
        <button type="button" class="agent-inspector-signal-link" @click="selectTab('live')">View Live <span aria-hidden="true">→</span></button>
      </template>
      <template v-if="recoveryActions.length" #footer>
        <AgentInspectorLifecycleActions
          :entry-id="projection.entryId" :room-id="projection.roomId" :actions="recoveryActions"
          :busy="lifecycleActionBusy" :busy-kind="lifecycleBusyKind" :compact="compact" @action="handleLifecycleAction"
        />
      </template>
    </AgentInspectorSignal>

    <p
      v-if="visibleActionMessage && selectedTab !== 'diagnostics'"
      class="agent-inspector-action-message"
      :data-state="actionState?.status"
    >
      {{ visibleActionMessage }}
    </p>

    <div class="agent-inspector-tabs" role="tablist" aria-label="Agent inspector sections" @keydown="handleTabKeydown">
      <button ref="overviewTab" id="agent-inspector-overview-tab" type="button" role="tab" :aria-selected="selectedTab === 'overview'" aria-controls="agent-inspector-overview-panel" :tabindex="selectedTab === 'overview' ? 0 : -1" @click="selectTab('overview')">Overview</button>
      <button id="agent-inspector-live-tab" type="button" role="tab" :aria-selected="selectedTab === 'live'" aria-controls="agent-inspector-live-panel" :tabindex="selectedTab === 'live' ? 0 : -1" @click="selectTab('live')">Live</button>
      <button ref="workTab" id="agent-inspector-work-tab" type="button" role="tab" :aria-selected="selectedTab === 'work'" aria-controls="agent-inspector-work-panel" :tabindex="selectedTab === 'work' ? 0 : -1" @click="selectTab('work')">Work</button>
      <button id="agent-inspector-workspace-tab" type="button" role="tab" :aria-selected="selectedTab === 'workspace'" aria-controls="agent-inspector-workspace-panel" :tabindex="selectedTab === 'workspace' ? 0 : -1" @click="selectTab('workspace')">Workspace</button>
      <button id="agent-inspector-settings-tab" type="button" role="tab" :aria-selected="selectedTab === 'settings'" aria-controls="agent-inspector-settings-panel" :tabindex="selectedTab === 'settings' ? 0 : -1" @click="selectTab('settings')">Settings</button>
      <button id="agent-inspector-diagnostics-tab" type="button" role="tab" :aria-selected="selectedTab === 'diagnostics'" aria-controls="agent-inspector-diagnostics-panel" :tabindex="selectedTab === 'diagnostics' ? 0 : -1" @click="selectTab('diagnostics')">Diagnostics</button>
    </div>

    <div class="agent-inspector-scroll-region">
      <div v-if="selectedTab === 'overview'" id="agent-inspector-overview-panel" role="tabpanel" aria-labelledby="agent-inspector-overview-tab">
        <AgentInspectorOverview
          :room-name="roomDisplayName"
          :projection="projection"
          :busy="actionState?.status === 'running'"
          :runtime-control="workResource.detail?.runtime_control ?? null"
          :runtime-control-pending="workResource.status === 'loading' || workResource.status === 'refreshing'"
          :correction-request="correctionRequest"
          @stop-turn="emitTurnControl('stop_turn')"
          @correct-turn="emitTurnControl('steer_turn', $event)"
          @retry-turn-control="emitTurnControl('retry_turn_control')"
          @resolve-turn-control="emitTurnControl('resolve_turn_control', undefined, $event)"
          @restore-conversation="emitRecoveryControl('restore_conversation', $event)"
          @skip-message="emitRecoveryControl('skip_message', $event)"
        />
      </div>
      <AgentInspectorLive
        v-else-if="selectedTab === 'live'" id="agent-inspector-live-panel" role="tabpanel" aria-labelledby="agent-inspector-live-tab"
        :feed="liveFeed"
        :work="projection.liveWork"
        :supports-reasoning="liveSupportsReasoning"
        :resource="workResource"
        :active-source-message-id="projection.liveWork.active ? projection.entry.roomAgentState?.turn.sourceMessageId ?? null : null"
      />
      <AgentInspectorWork
        v-else-if="selectedTab === 'work'" id="agent-inspector-work-panel" role="tabpanel" aria-labelledby="agent-inspector-work-tab"
        :resource="workResource" :selected-source-message-id="selectedWorkSourceMessageId" :tasks="projection.assignedWork" :artifacts="workArtifacts"
        @retry="emit('work-retry')" @select-source="emit('work-source-select', $event)" @reveal="emit('reveal-message', $event)"
      />
      <AgentInspectorWorkspace v-else-if="selectedTab === 'workspace'" id="agent-inspector-workspace-panel" role="tabpanel" aria-labelledby="agent-inspector-workspace-tab"
        :work="roomAgentWork ?? []" :agent-key="projection.entry.agentKey ?? null" :status="roomAgentWorkStatus ?? 'idle'" :source-message-id="workspaceSourceMessageId" :request-version="requestVersion" />
      <AgentInspectorSettings
        v-else-if="selectedTab === 'settings'" id="agent-inspector-settings-panel" role="tabpanel" aria-labelledby="agent-inspector-settings-tab"
        :entry-id="projection.entryId" :display-name="projection.displayName" :workspace-path="projection.entry.workspacePath" :retired="projection.overallState === 'retired'"
        :resource="settingsResource" :move="roomMoveResource" :move-available="roomMoveAvailable" :providers="providers" :destinations="destinations"
        :busy="actionState?.status === 'running'" :apply-pending="actionState?.kind === 'apply_settings' && actionState.status === 'success' && configurationHasRuntimeLag(settingsResource.configuration)" :conflict="settingsConflict"
        @patch="emit('settings-patch', $event)" @save="emit('settings-save', $event)" @apply="emit('settings-apply')" @reload="emit('settings-reload')"
        @prepare-move="emit('room-move-prepare', $event)" @commit-move="emit('room-move-commit')"
        @retire="emit('retire')" @purge="emit('purge')"
      />
      <AgentInspectorDiagnostics
        v-else id="agent-inspector-diagnostics-panel" role="tabpanel" aria-labelledby="agent-inspector-diagnostics-tab"
        :projection="projection" :initial-recovery-options="recoveryOptionsRequested"
        :work-resource="workResource" :daemon-status="daemonStatus" :action-state="actionState" :busy="lifecycleActionBusy" :refresh-diagnostics="refreshDiagnostics"
        @action="handleLifecycleAction" @navigate="navigateFromDiagnostics"
      />
    </div>

  </aside>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from "vue";
import type {
  AgentInspectorActionIntent,
  AgentInspectorActionState,
  AgentInspectorCorrectionRequest,
  AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import type { AgentInspectorConfigurationResource, AgentInspectorRoomMoveResource } from "../../../../domain/agent-inspector-settings";
import type { DesktopAgentProvider, DesktopAgentStreamEvent, DesktopFocusRoomInfo } from "../../../../../../electron/ipc-types";
import { configurationHasRuntimeLag } from "../../../../domain/agent-inspector-settings";
import { homeHarnessBadge } from "../../../../domain/agent-home-harness";
import { initialTabEffects } from "../../../../domain/agent-inspector-identity";
import { agentInspectorSignal, agentInspectorProviderLabel } from "../../../../domain/agent-inspector-presentation";
import AgentInspectorSignal from "./AgentInspectorSignal.vue";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import AgentInspectorLifecycleActions from "./AgentInspectorLifecycleActions.vue";
import AgentInspectorOverview from "./AgentInspectorOverview.vue";
import AgentInspectorWorkspace from "./AgentInspectorWorkspace.vue";
import AgentInspectorWork from "./AgentInspectorWork.vue";
import AgentInspectorSettings from "./AgentInspectorSettings.vue";

type InspectorTab = "overview" | "live" | "work" | "workspace" | "settings" | "diagnostics";

/** Diagnostics and Live stay out of the normal inspector path until opened. */
const AgentInspectorDiagnostics = defineAsyncComponent(() => import("./AgentInspectorDiagnostics.vue"));
const AgentInspectorLive = defineAsyncComponent(() => import("./AgentInspectorLive.vue"));

const props = defineProps<{
  projection: AgentInspectorProjection;
  roomDisplayName?: string;
  daemonStatus?: import("../../../../../../electron/ipc-types").DesktopSupervisorDaemonStatus | null;
  refreshDiagnostics?: () => Promise<boolean>;
  initialTab?: "overview" | "live" | "work" | "workspace" | "diagnostics";
  roomAgentWork?: import("../../../../../../electron/ipc-types").DesktopRoomAgentWork[];
  roomAgentWorkStatus?: string;
  workspaceSourceMessageId?: string | null;
  requestVersion?: number;
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
  liveFeed: { events: readonly DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number };
  correctionRequest?: AgentInspectorCorrectionRequest | null;
}>();
const emit = defineEmits<{
  close: [];
  action: [intent: AgentInspectorActionIntent];
  "live-selected": [];
  "live-dismissed": [];
  "work-selected": [];
  "work-retry": [];
  "work-source-select": [sourceMessageId: string];
  "reveal-message": [canonicalMessageId: string];
  "settings-selected": [];
  "settings-patch": [patch: Partial<import("../../../../domain/agent-inspector-settings").AgentInspectorConfigurationDraft>];
  "settings-save": [overwrite: boolean];
  "settings-apply": [];
  "settings-reload": [];
  "room-move-prepare": [destination: string];
  "room-move-commit": [];
  retire: [];
  purge: [];
}>();

const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const overviewTab = ref<HTMLButtonElement | null>(null);
const workTab = ref<HTMLButtonElement | null>(null);
const selectedTab = ref<InspectorTab>(props.initialTab ?? "overview");
const providerModelLabel = computed(() => [
  agentInspectorProviderLabel(props.projection.provider), props.projection.model,
  props.settingsResource.configuration?.entryId === props.projection.entryId
    && !configurationHasRuntimeLag(props.settingsResource.configuration)
    ? props.settingsResource.configuration.reasoningEffort : null,
].filter(Boolean).join(" · "));
const signal = computed(() => agentInspectorSignal(props.projection));
const recoveryKinds = new Set(["resume", "recover", "reconnect", "retry_delivery", "recovery_options"]);
const recoveryActions = computed(() => props.projection.actions.filter(action => action.available && recoveryKinds.has(action.kind)));
const headerActions = computed(() => props.projection.actions.filter(action => !recoveryKinds.has(action.kind)));
const liveSupportsReasoning = computed(() => {
  const provider = props.providers.find((candidate) => candidate.id === props.projection.provider);
  return provider ? provider.capabilities.includes("reasoning_stream") : null;
});
const retryRequestIsPending = computed(() => props.projection.deliveryProgress?.requestedLocally === true);
const lifecycleActionBusy = computed(() => props.actionState?.status === "running" || retryRequestIsPending.value);
const lifecycleBusyKind = computed<AgentInspectorActionIntent["kind"] | null>(() =>
  props.actionState?.status === "running"
    ? props.actionState.kind
    : retryRequestIsPending.value ? "retry_delivery" : null);
const visibleActionMessage = computed(() => {
  if (!props.actionState?.message) return null;
  if (props.actionState.kind === "retry_delivery" && props.actionState.status !== "error") return null;
  return props.actionState.message;
});
const recoveryOptionsRequested = ref(false);

function handleLifecycleAction(intent: AgentInspectorActionIntent): void {
  if (intent.kind !== "recovery_options") { emit("action", intent); return; }
  if (lifecycleActionBusy.value || props.projection.resourceFreshness !== "fresh"
    || intent.entryId !== props.projection.entryId || intent.roomId !== props.projection.roomId
    || !props.projection.actions.some(action => action.kind === intent.kind && action.available)) return;
  recoveryOptionsRequested.value = true;
  selectTab("diagnostics");
}

function focusInitial(): void {
  if (focusCorrection()) return;
  if (selectedTab.value === "live") {
    const liveTab = surfaceElement.value?.querySelector<HTMLButtonElement>("#agent-inspector-live-tab");
    if (liveTab) {
      liveTab.focus({ preventScroll: true });
      return;
    }
  }
  closeButton.value?.focus({ preventScroll: true });
}

/** Opened to correct the current turn: land in the box, not on Close. */
function focusCorrection(): boolean {
  if (props.correctionRequest?.entryId !== props.projection.entryId || selectedTab.value !== "overview") return false;
  const field = surfaceElement.value?.querySelector<HTMLTextAreaElement>(
    `#agent-inspector-turn-correction-${CSS.escape(props.projection.entryId)}`,
  );
  if (!field || field.disabled) return false;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  return true;
}

function containsFocus(): boolean {
  return Boolean(surfaceElement.value?.contains(document.activeElement));
}

defineExpose({ focusInitial, containsFocus });

function applyInitialTab(): void {
  selectedTab.value = props.initialTab ?? "overview";
  const effects = initialTabEffects(selectedTab.value);
  if (effects.emitLiveSelected) {
    emit("live-selected");
  }
}

onMounted(() => {
  applyInitialTab();
});

watch([() => props.projection.entryId, () => props.requestVersion, () => props.initialTab], () => {
  applyInitialTab();
  recoveryOptionsRequested.value = false;
});

// An already-open Inspector gets no new focusInitial from its host.
watch(() => props.correctionRequest?.id, (id) => {
  if (id !== undefined) focusCorrection();
}, { flush: "post" });

function selectTab(tab: InspectorTab): void {
  if (selectedTab.value === tab) return;
  if (selectedTab.value === "live" && tab !== "live") emit("live-dismissed");
  selectedTab.value = tab;
  if (tab !== "diagnostics") recoveryOptionsRequested.value = false;
  if (tab === "live") emit("live-selected");
  if (tab === "work" || tab === "diagnostics") emit("work-selected");
  if (tab === "settings") emit("settings-selected");
}

function navigateFromDiagnostics(tab: "overview" | "work"): void {
  selectTab(tab);
  void nextTick(() => (tab === "work" ? workTab.value : overviewTab.value)?.focus());
}

function emitTurnControl(
  kind: Extract<AgentInspectorActionIntent["kind"], "stop_turn" | "steer_turn" | "retry_turn_control" | "resolve_turn_control">,
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

function emitRecoveryControl(
  kind: Extract<AgentInspectorActionIntent["kind"], "restore_conversation" | "skip_message">,
  sourceMessageId: string,
): void {
  emit("action", {
    entryId: props.projection.entryId,
    roomId: props.projection.roomId,
    kind,
    sourceMessageId,
  });
}

function handleTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs: InspectorTab[] = ["overview", "live", "work", "workspace", "settings", "diagnostics"];
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
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter(element => element.tabIndex >= 0 && element.checkVisibility({ visibilityProperty: true }));
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
