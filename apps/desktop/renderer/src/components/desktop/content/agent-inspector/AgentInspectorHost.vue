<template>
  <div
    v-if="open && !compact"
    ref="wideHostElement"
    class="agent-inspector-host-wide"
  >
    <Transition name="agent-inspector-panel" appear>
      <component
        ref="surfaceComponent"
        :is="surfaceComponentType"
        v-bind="surfaceProps(false)"
        @close="emit('close')"
        @action="forwardAction($event, 'wide')"
        @status="participantAnnouncement = $event"
        @retry="retryStatus"
        @session-updated="emit('session-updated', $event)"
        @open-reasoning="emit('open-reasoning', $event)"
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
    <Transition name="agent-inspector-panel">
      <component
        ref="surfaceComponent"
        :is="surfaceComponentType"
        v-if="open"
        v-bind="surfaceProps(true)"
        @close="emit('close')"
        @action="forwardAction($event, 'compact')"
        @status="participantAnnouncement = $event"
        @retry="retryStatus"
        @session-updated="emit('session-updated', $event)"
        @open-reasoning="emit('open-reasoning', $event)"
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
  agentInspectorLiveAnnouncement,
  type AgentInspectorActionIntent,
  type AgentInspectorActionState,
  type AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import type { RoomArtifactTimelineItem } from "../../../../domain/room-artifacts";
import type { AgentInspectorConfigurationResource, AgentInspectorConfigurationDraft, AgentInspectorRoomMoveResource } from "../../../../domain/agent-inspector-settings";
import type {
  DesktopAgentProvider,
  DesktopAgentStreamEvent,
  DesktopFocusRoomInfo,
  DesktopManagedAgentSession,
  DesktopReasoningSession,
} from "../../../../../../electron/ipc-types";
import {
  projectAgentInspectorParticipant,
  projectAgentInspectorStatus,
  type AgentInspectorParticipantSessionUpdate,
} from "../../../../domain/agent-inspector-participant";
import { agentInspectorRequestResetKey } from "../../../../domain/agent-inspector-identity";
import { latestReasoningSessionForExactIdentity } from "../../../../domain/reasoning";
import AgentInspectorSurface from "./AgentInspectorSurface.vue";
import AgentInspectorStatusSurface from "./AgentInspectorStatusSurface.vue";
import AgentInspectorParticipantSurface from "./AgentInspectorParticipantSurface.vue";
import type { AgentInspectorSelection } from "../desktop-chat-message/types";
import "./agent-inspector.css";

const compactBreakpoint = 920;
const props = defineProps<{
  open: boolean;
  projection: AgentInspectorProjection | null;
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
  requestVersion: number;
  managedSessions: readonly DesktopManagedAgentSession[];
  reasoningSessions: readonly DesktopReasoningSession[];
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
  "session-updated": [update: AgentInspectorParticipantSessionUpdate];
  "open-reasoning": [sessionId: string];
  retry: [];
}>();

const compact = ref(false);
const wideHostElement = ref<HTMLElement | null>(null);
const surfaceComponent = ref<{ focusInitial: () => void; containsFocus: () => boolean } | null>(null);
const participantAnnouncement = ref<string | null>(null);
const participantProjection = computed(() =>
  projectAgentInspectorParticipant(props.selection, props.managedSessions, props.roomIdentifier)
);
const participantSelectionKey = computed(() =>
  agentInspectorRequestResetKey(props.selection, props.requestVersion)
);
const participantReasoning = computed(() => {
  const participant = participantProjection.value;
  if (!participant) return null;
  if (participant.kind === "local_managed" && participant.session.reasoningSessionId) {
    const linked = props.reasoningSessions.find((session) =>
      session.id === participant.session.reasoningSessionId
    );
    if (linked) return linked;
  }
  const identity = participant.kind === "local_managed"
    ? participant.session
    : props.selection;
  return latestReasoningSessionForExactIdentity(identity, props.reasoningSessions);
});
const surfaceKind = computed(() => props.projection ? "projection" : participantProjection.value ? "participant" : "status");
const surfaceComponentType = computed<Component>(() => props.projection
  ? AgentInspectorSurface
  : participantProjection.value
    ? AgentInspectorParticipantSurface
    : AgentInspectorStatusSurface);
watch(compact, (value) => emit("presentation-change", value), { immediate: true });
const statusPresentation = computed(() => projectAgentInspectorStatus(props.selection));
const liveAnnouncement = computed(() => {
  if (props.actionState?.message) return props.actionState.message;
  if (participantAnnouncement.value) return participantAnnouncement.value;
  if (props.projection) return agentInspectorLiveAnnouncement(props.projection);
  if (participantProjection.value?.kind === "local_managed") {
    return `${participantProjection.value.title}: ${participantProjection.value.heading}.`;
  }
  if (participantProjection.value?.kind === "unavailable") {
    return `${participantProjection.value.title}: ${participantProjection.value.heading}.`;
  }
  if (participantProjection.value?.kind === "external") return `${participantProjection.value.title}: externally managed agent.`;
  return `${statusPresentation.value.title}: ${statusPresentation.value.heading}.`;
});
watch(
  () => [props.roomIdentifier, props.requestVersion, participantSelectionKey.value],
  () => { participantAnnouncement.value = null; },
);
function surfaceProps(compactPresentation: boolean): Record<string, unknown> {
  if (props.projection) {
    return {
      projection: props.projection,
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
      settingsConflict: props.settingsConflict,
      liveFeed: props.liveFeed,
    };
  }
  if (participantProjection.value) {
    return {
      projection: participantProjection.value,
      compact: compactPresentation,
      busy: false,
      roomIdentifier: props.roomIdentifier,
      requestVersion: props.requestVersion,
      selectionKey: participantSelectionKey.value,
      reasoning: participantReasoning.value,
    };
  }
  return { ...statusPresentation.value, compact: compactPresentation };
}
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
    if (focusTarget) void nextTick(() => focusTarget.focus({ preventScroll: true }));
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
  if (target?.closest?.('[role="menu"]')) return;
  event.preventDefault();
  event.stopPropagation();
  emit("close");
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!props.open || compact.value || event.button !== 0) return;
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
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", syncCompact);
  document.removeEventListener("keydown", handleHostKeydown, true);
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  setShellContentInert(false);
  if (restoreFocusOnClose) restoreFocusElement?.focus({ preventScroll: true });
});
</script>
