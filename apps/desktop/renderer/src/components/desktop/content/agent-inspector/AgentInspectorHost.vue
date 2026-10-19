<template>
  <div
    v-if="open && !compact"
    ref="wideHostElement"
    class="agent-inspector-host-wide"
  >
    <Transition :css="false" appear @enter="enterPanel" @enter-cancelled="cancelOpening" @leave="leavePanel">
      <component
        ref="surfaceComponent"
        :is="surfaceComponentType"
        v-bind="surfaceProps(false)"
        @close="emit('close')"
        @action="forwardAction($event, 'wide')"
        @retry="retryStatus"
        @open-reasoning="emit('open-reasoning', $event)"
        @reveal-live-request="emit('reveal-live-request', $event)"
        @live-selected="emit('live-selected')" @live-dismissed="emit('live-dismissed')" @work-selected="emit('work-selected')" @work-retry="emit('work-retry')" @work-source-select="emit('work-source-select', $event)" @reveal-message="emit('reveal-message', $event)"
        @settings-selected="emit('settings-selected')" @settings-patch="emit('settings-patch', $event)" @settings-save="emit('settings-save', $event)" @settings-apply="emit('settings-apply')" @settings-reload="emit('settings-reload')" @room-move-prepare="emit('room-move-prepare', $event)" @room-move-commit="emit('room-move-commit')" @retire="emit('retire')" @purge="emit('purge')"
      />
    </Transition>
  </div>

  <Teleport v-if="compact" to="body">
    <Transition name="agent-inspector-scrim">
      <button
        v-if="open && compact"
        class="agent-inspector-scrim"
        type="button"
        aria-label="Close agent inspector"
        @click="emit('close')"
      ></button>
    </Transition>
    <Transition :css="false" @enter="enterPanel" @enter-cancelled="cancelOpening" @leave="leavePanel">
      <component
        ref="surfaceComponent"
        :is="surfaceComponentType"
        v-if="open"
        v-bind="surfaceProps(true)"
        @close="emit('close')"
        @action="forwardAction($event, 'compact')"
        @retry="retryStatus"
        @open-reasoning="emit('open-reasoning', $event)"
        @reveal-live-request="emit('reveal-live-request', $event)"
        @live-selected="emit('live-selected')" @live-dismissed="emit('live-dismissed')" @work-selected="emit('work-selected')" @work-retry="emit('work-retry')" @work-source-select="emit('work-source-select', $event)" @reveal-message="emit('reveal-message', $event)"
        @settings-selected="emit('settings-selected')" @settings-patch="emit('settings-patch', $event)" @settings-save="emit('settings-save', $event)" @settings-apply="emit('settings-apply')" @settings-reload="emit('settings-reload')" @room-move-prepare="emit('room-move-prepare', $event)" @room-move-commit="emit('room-move-commit')" @retire="emit('retire')" @purge="emit('purge')"
      />
    </Transition>
  </Teleport>
  <Teleport to="body">
    <p v-if="open" class="agent-inspector-live-region" aria-live="polite" aria-atomic="true">{{ liveAnnouncement }}</p>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import {
  type AgentInspectorActionIntent,
  type AgentInspectorActionState,
  type AgentInspectorCorrectionRequest,
  type AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import type { AgentInspectorConfigurationResource, AgentInspectorConfigurationDraft, AgentInspectorRoomMoveResource } from "../../../../domain/agent-inspector-settings";
import type {
  DesktopAgentProvider,
  DesktopRoomAgentWork,
  DesktopAgentStreamEvent,
  DesktopFocusRoomInfo,
  DesktopReasoningSession,
} from "../../../../../../electron/ipc-types";
import {
  projectAgentInspectorParticipant,
  projectAgentInspectorStatus,
} from "../../../../domain/agent-inspector-participant";
import { agentInspectorSignal, sharedAgentInspectorPresentation } from "../../../../domain/agent-inspector-presentation";
import { latestReasoningSessionForExactIdentity } from "../../../../domain/reasoning";
import { sharedLiveViewForAgent } from "../../../../domain/agent-inspector-shared-live";
import AgentInspectorSurface from "./AgentInspectorSurface.vue";
import AgentInspectorStatusSurface from "./AgentInspectorStatusSurface.vue";
import AgentInspectorParticipantSurface from "./AgentInspectorParticipantSurface.vue";
import type { AgentInspectorSelection } from "../desktop-chat-message/types";
import "./agent-inspector.css";
import { animateInspectorOpening } from "./inspector-opening";

const compactBreakpoint = 920;
const props = defineProps<{
  open: boolean;
  presence?: readonly import("../../../../../../electron/ipc-types").DesktopAgentPresence[];
  presenceFresh?: boolean;
  viewerLogin?: string | null;
  projection: AgentInspectorProjection | null;
  daemonStatus?: import("../../../../../../electron/ipc-types").DesktopSupervisorDaemonStatus | null;
  refreshDiagnostics?: () => Promise<boolean>;
  selection: AgentInspectorSelection;
  actionState: AgentInspectorActionState | null;
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
  roomIdentifier: string;
  roomDisplayName?: string;
  requestVersion: number;
  initialTab?: "overview" | "live" | "work" | "workspace" | "diagnostics";
  roomAgentWork?: DesktopRoomAgentWork[];
  roomAgentWorkStatus?: string;
  workspaceSourceMessageId?: string | null;
  reasoningSessions: readonly DesktopReasoningSession[];
  /** Agents' turns their owners share with the room. */
  liveActivitySessions?: readonly DesktopReasoningSession[];
  correctionRequest?: AgentInspectorCorrectionRequest | null;
}>();
const emit = defineEmits<{
  close: [];
  action: [intent: AgentInspectorActionIntent];
  "presentation-change": [compact: boolean];
  "live-selected": [];
  "live-dismissed": [];
  "work-selected": [];
  "work-retry": [];
  "work-source-select": [sourceMessageId: string];
  "reveal-message": [canonicalMessageId: string];
  "settings-selected": [];
  "settings-patch": [patch: Partial<AgentInspectorConfigurationDraft>];
  "settings-save": [overwrite: boolean];
  "settings-apply": [];
  "settings-reload": [];
  "room-move-prepare": [destination: string];
  "room-move-commit": [];
  retire: [];
  purge: [];
  "open-reasoning": [sessionId: string];
  "reveal-live-request": [messageId: string];
  retry: [];
}>();

const compact = ref(false);
const wideHostElement = ref<HTMLElement | null>(null);
const surfaceComponent = ref<{ focusInitial: () => void; containsFocus: () => boolean } | null>(null);
const participantProjection = computed(() => projectAgentInspectorParticipant(props.selection));
const participantReasoning = computed(() => participantProjection.value
  ? latestReasoningSessionForExactIdentity(props.selection, props.reasoningSessions)
  : null);
// Another member's agent: its turn, when its owner shares live activity with the room.
const participantLiveView = computed(() => participantProjection.value
  ? sharedLiveViewForAgent(props.selection.agentKey, props.liveActivitySessions ?? [])
  : null);
const surfaceKind = computed(() => props.projection ? "projection" : participantProjection.value ? "participant" : "status");
const surfaceComponentType = computed<Component>(() => props.projection
  ? AgentInspectorSurface
  : participantProjection.value
    ? AgentInspectorParticipantSurface
    : AgentInspectorStatusSurface);
watch(compact, (value) => emit("presentation-change", value), { immediate: true });
const statusPresentation = computed(() => projectAgentInspectorStatus(props.selection));
const sharedPresentation = computed(() => sharedAgentInspectorPresentation(
  props.selection, props.presence ?? [], props.roomIdentifier, props.viewerLogin, props.presenceFresh,
));
const liveAnnouncement = computed(() => {
  if (props.actionState?.message) return props.actionState.message;
  if (props.projection) return `${props.projection.displayName}: ${agentInspectorSignal(props.projection).label}.`;
  if (participantProjection.value) return `${participantProjection.value.title}: ${sharedPresentation.value.signal.label}.`;
  return `${statusPresentation.value.title}: ${statusPresentation.value.heading}.`;
});
function surfaceProps(compactPresentation: boolean): Record<string, unknown> {
  const workspace = { roomAgentWork: props.roomAgentWork ?? [], roomAgentWorkStatus: props.roomAgentWorkStatus ?? 'idle',
    workspaceSourceMessageId: props.workspaceSourceMessageId, workspaceAgentKey: props.selection.agentKey,
    initialTab: props.initialTab };
  if (props.projection) {
    return {
      ...workspace,
      projection: props.projection,
      daemonStatus: props.daemonStatus,
      refreshDiagnostics: props.refreshDiagnostics,
      requestVersion: props.requestVersion,
      actionState: props.actionState,
      compact: compactPresentation,
      workResource: props.workResource,
      selectedWorkSourceMessageId: props.selectedWorkSourceMessageId,
      workArtifacts: props.workArtifacts,
      settingsResource: props.settingsResource,
      roomMoveResource: props.roomMoveResource,
      roomMoveAvailable: props.roomMoveAvailable,
      providers: props.providers,
      destinations: props.destinations,
      roomDisplayName: props.roomDisplayName,
      settingsConflict: props.settingsConflict,
      liveFeed: props.liveFeed,
      correctionRequest: props.correctionRequest ?? null,
    };
  }
  if (participantProjection.value) {
    return {
      ...workspace,
      projection: participantProjection.value,
      shared: sharedPresentation.value,
      roomDisplayName: props.roomDisplayName,
      compact: compactPresentation,
      roomIdentifier: props.roomIdentifier,
      requestVersion: props.requestVersion,
      reasoning: participantReasoning.value,
      liveView: participantLiveView.value,
    };
  }
  return { ...statusPresentation.value, compact: compactPresentation };
}
let finishOpening: (() => void) | null = null;
function cancelOpening(): void { finishOpening?.(); finishOpening = null; }
function enterPanel(element: Element, done: () => void): void {
  cancelOpening();
  finishOpening = animateInspectorOpening(element as HTMLElement, restoreFocusElement?.closest<HTMLElement>('button, [role="button"]') ?? null, done);
}
function leavePanel(_element: Element, done: () => void): void { cancelOpening(); done(); }
watch(() => props.requestVersion, cancelOpening);
let resizeObserver: ResizeObserver | null = null;
let restoreFocusElement: HTMLElement | null = null;
let restoreFocusOnClose = true;
const inertSnapshots = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

function syncCompact(): void {
  const container = document.querySelector<HTMLElement>(".desktop-room-shell") ?? document.documentElement;
  compact.value = container.getBoundingClientRect().width < compactBreakpoint;
}

function forwardAction(intent: AgentInspectorActionIntent, presentation: "wide" | "compact"): void {
  emit("action", { ...intent, presentation });
}

function retryStatus(): void {
  const inspectorOwnedFocus = surfaceComponent.value?.containsFocus() ?? false;
  emit("retry");
  if (inspectorOwnedFocus) {
    void nextTick(() => surfaceComponent.value?.focusInitial());
  }
}

function setShellContentInert(inert: boolean): void {
  if (!inert) {
    for (const [element, snapshot] of inertSnapshots) {
      element.inert = snapshot.inert;
      if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", snapshot.ariaHidden);
    }
    inertSnapshots.clear();
    return;
  }
  if (inertSnapshots.size) return;
  const shell = document.querySelector<HTMLElement>(".desktop-room-shell");
  if (!shell) return;
  for (const element of [...shell.children]) {
    if (!(element instanceof HTMLElement) || element.classList.contains("agent-inspector-host-wide")) continue;
    inertSnapshots.set(element, { inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") });
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }
}

watch(() => [props.open, compact.value] as const, ([open, isCompact], previous) => {
  if (open && !previous?.[0]) {
    restoreFocusElement = document.activeElement as HTMLElement | null;
    restoreFocusOnClose = true;
  }
  setShellContentInert(open && isCompact);
  if (open && (!previous?.[0] || previous[1] !== isCompact)) {
    void nextTick(() => surfaceComponent.value?.focusInitial());
  }
  if (!open && previous?.[0]) {
    const focusTarget = restoreFocusOnClose ? restoreFocusElement : null;
    restoreFocusElement = null;
    restoreFocusOnClose = true;
    if (focusTarget) {
      void nextTick(() => {
        if (focusTarget.isConnected) {
          focusTarget.focus({ preventScroll: true });
        } else {
          const composer = document.querySelector<HTMLElement>('[data-testid="desktop-composer-input"]');
          composer?.focus({ preventScroll: true });
        }
      });
    }
  }
}, { immediate: true });

watch(surfaceKind, () => {
  const inspectorOwnedFocus = surfaceComponent.value?.containsFocus() ?? false;
  if (!props.open || !inspectorOwnedFocus) return;
  void nextTick(() => surfaceComponent.value?.focusInitial());
});

function handleHostKeydown(event: KeyboardEvent): void {
  if (!props.open || !compact.value || event.key !== "Escape") return;
  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  if (target?.closest?.('[role="menu"]') || target?.closest?.('.workspace-reader-backdrop')) return;
  event.preventDefault();
  event.stopPropagation();
  emit("close");
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!props.open || compact.value || event.button !== 0) return;
  // The workspace reader belongs to this inspector but is teleported to body.
  // Its own dialog handles dismissal, including pointer presses on its scrim.
  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  if (target?.closest?.('.workspace-reader-backdrop')) return;
  const host = wideHostElement.value;
  if (!host || (event.target && host.contains(event.target as Node))) return;
  // The pointer target is the user's new focus destination. Escape and the
  // explicit Close button restore invocation focus; an outside click must not
  // steal focus back after the browser completes that click.
  restoreFocusOnClose = false;
  emit("close");
}

onMounted(() => {
  syncCompact();
  if (typeof ResizeObserver !== "undefined") {
    const container = document.querySelector<HTMLElement>(".desktop-room-shell") ?? document.documentElement;
    resizeObserver = new ResizeObserver(syncCompact);
    resizeObserver.observe(container);
  } else {
    window.addEventListener("resize", syncCompact);
  }
  document.addEventListener("keydown", handleHostKeydown, true);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  cancelOpening();
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", syncCompact);
  document.removeEventListener("keydown", handleHostKeydown, true);
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  setShellContentInert(false);
  if (restoreFocusOnClose && restoreFocusElement) {
    if (restoreFocusElement.isConnected) {
      restoreFocusElement.focus({ preventScroll: true });
    } else {
      document.querySelector<HTMLElement>('[data-testid="desktop-composer-input"]')?.focus({ preventScroll: true });
    }
  }
});
</script>
