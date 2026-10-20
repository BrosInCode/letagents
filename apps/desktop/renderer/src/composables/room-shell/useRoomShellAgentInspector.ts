import { computed, watch } from "vue";
import type { DesktopSupervisorStateSnapshot } from "../../../../electron/ipc-types";
import { useAgentPauseRequests } from "../../domain/agent-pause-requests";
import { roomMessageDeliveryReceipts } from "../../domain/room-message-receipts";
import {
  participantAgentInspectorRequest,
  resolvingAgentInspectorRequest,
  supervisedAgentInspectorRequest,
  inspectorInitialTab,
} from "../../domain/agent-inspector-identity";
import { agentInspectorActionStateForEntry, projectAgentInspectors } from "../../domain/agent-inspector";
import {
  agentInspectorDetailRevision,
  agentInspectorDetailKey,
  agentInspectorDetailRequestIsCurrent,
  readAgentInspectorWorkDetail,
  agentInspectorWorkArtifacts,
  defaultAgentInspectorWorkSource,
  canRevealAgentInspectorWorkMessage,
  emptyAgentInspectorWorkResource,
} from "../../domain/agent-inspector-work";
import { supervisorEntriesResourceFreshness } from "../../domain/supervisor-entries-resource";
import { ownerAttribution as ownerAttributionLabel } from "../../components/desktop/content/room-activity/agentTarget";
import { useAgentCorrectionHandoff } from "../../components/desktop/content/room-shell/useAgentCorrectionHandoff";
import { useAgentInspectorObservations } from "../../components/desktop/content/room-shell/useAgentInspectorObservations";
import { useAgentInspectorConfigurationApply } from "../../components/desktop/content/room-shell/useAgentInspectorConfigurationApply";
import type { AgentInspectorRequest, AgentModalTarget } from "../../components/desktop/content/desktop-chat-message/types";
import { desktopIpc } from "../../ipc/index.js";
import { provideRoomWakeRules, useRoomWakeRules } from "../useRoomWakeRules";
import type { RoomShellContextOf } from "./context";

/** Opening and closing the agent inspector, its live feed, providers, and work detail. */
export function useRoomShellInspectorActions(context: unknown) {
  const {
    activeTab, agentInspectorActionState, agentInspectorBackgroundRefresh, agentInspectorCompact,
    agentInspectorDetailRequest, agentInspectorInitialTab, agentInspectorLiveFeed,
    agentInspectorProviders, agentInspectorRequestState, agentInspectorWorkResource,
    agentInspectorWorkSourceMessageId, personActions, props, selectedAgentDetailRequest,
    selectedAgentDetailRequestVersion, selectedAgentDetailTarget, supervisorStatus,
    supervisorSyncState,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<
      "useRoomShellAgentProjections"
    | "useRoomShellInspectorObservations"
    | "useRoomShellInspectorSettings"
    | "useRoomShellIntegrations"
    | "useRoomShellToolActions"
  >;
  let agentInspectorProvidersRequest: Promise<void> | null = null;
  let agentInspectorMessageIdentityRequestToken = 0;

  async function openAgentDetailFromParticipant(target: AgentModalTarget): Promise<void> {
    const hasExactPublishedIdentity = Boolean(target.clientMessageId?.trim());
    const hasExactRuntimeIdentity = Boolean(
      target.agentSessionId?.trim()
      || (target.agentKey?.trim() && /[/:]/.test(target.agentKey)),
    );
    if (hasExactPublishedIdentity || hasExactRuntimeIdentity || !target.messageId?.trim()) {
      openAgentDetailRequest(participantAgentInspectorRequest(target));
      return;
    }

    const roomIdentifier = props.room.identifier;
    const requestToken = ++agentInspectorMessageIdentityRequestToken;
    openAgentDetailRequest(resolvingAgentInspectorRequest(target));
    const requestVersion = selectedAgentDetailRequestVersion.value;
    try {
      const message = await desktopIpc.room.getMessage(roomIdentifier, target.messageId);
      if (
        requestToken !== agentInspectorMessageIdentityRequestToken
        || requestVersion !== selectedAgentDetailRequestVersion.value
        || roomIdentifier !== props.room.identifier
      ) return;
      openAgentDetailRequest(participantAgentInspectorRequest(message
        ? {
            ...target,
            messageId: message.id,
            clientMessageId: message.clientMessageId ?? null,
            messageSource: message.source ?? target.messageSource,
            actorLabel: message.actorLabel || message.agentIdentity?.actorLabel || target.actorLabel,
            agentKey: message.agentIdentity?.agentKey || target.agentKey,
            agentSessionId: message.agentIdentity?.agentSessionId || target.agentSessionId,
          }
        : target));
    } catch {
      if (
        requestToken !== agentInspectorMessageIdentityRequestToken
        || requestVersion !== selectedAgentDetailRequestVersion.value
        || roomIdentifier !== props.room.identifier
      ) return;
      openAgentDetailRequest(participantAgentInspectorRequest(target));
    }
  }

  function openAgentDetailRequest(request: AgentInspectorRequest): void {
    agentInspectorInitialTab.value = inspectorInitialTab(request.target);
    selectedAgentDetailRequestVersion.value += 1;
    selectedAgentDetailRequest.value = request; personActions.value?.close();
    agentInspectorActionState.value = null;
    app.releaseAgentCorrectionRequest({ restoreComposerText: true });
    agentInspectorRequestState.agentInspectorWorkRequestToken += 1;
    agentInspectorBackgroundRefresh.reset();
    agentInspectorDetailRequest.reset();
    agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
    agentInspectorWorkSourceMessageId.value = request.target.workSourceMessageId ?? null;
    // Drop any prior live subscription so another agent's feed cannot leak
    // into the requested message's inspector.
    stopAgentInspectorLive();
    app.resetAgentInspectorSettings();
    // Live capability copy is provider-driven and must be ready independently
    // of the Settings tab, which happens to consume the same catalog.
    void loadAgentInspectorProviders();
    // Overview reads the exact current control-health projection without
    // selecting or loading a retained message from the Work tab.
    if (request.target.workSourceMessageId) void loadAgentInspectorWorkDetail(request.target.workSourceMessageId, false, false);
    else void loadAgentInspectorWorkDetail(null, false, false);
  }

  async function loadAgentInspectorProviders(): Promise<void> {
    if (agentInspectorProviders.value.length > 0) return;
    if (agentInspectorProvidersRequest) return agentInspectorProvidersRequest;
    agentInspectorProvidersRequest = desktopIpc.workers.listAgentProviders()
      .then((providers) => { agentInspectorProviders.value = providers; })
      .catch(() => undefined)
      .finally(() => { agentInspectorProvidersRequest = null; });
    return agentInspectorProvidersRequest;
  }

  function closeAgentDetail(): void {
    agentInspectorMessageIdentityRequestToken += 1;
    selectedAgentDetailRequestVersion.value += 1;
    selectedAgentDetailRequest.value = null;
    agentInspectorActionState.value = null;
    app.releaseAgentCorrectionRequest({ restoreComposerText: true });
    agentInspectorRequestState.agentInspectorWorkRequestToken += 1;
    agentInspectorBackgroundRefresh.reset();
    agentInspectorDetailRequest.reset();
    agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
    agentInspectorWorkSourceMessageId.value = null;
    stopAgentInspectorLive();
    app.resetAgentInspectorSettings();
  }

  function openAgentInspectorLive(): void {
    const projection = app.selectedAgentDetailProjection.value;
    if (!projection) return;
    const identity = JSON.stringify([projection.entryId, projection.entry.agentSessionId, projection.entry.executionGenerationId]);
    if (agentInspectorRequestState.agentInspectorLiveIdentity === identity) return;
    agentInspectorRequestState.agentInspectorLiveIdentity = identity;
    agentInspectorLiveFeed.value = { events: [], ended: false, droppedEvents: 0 };
    void loadAgentInspectorProviders();
    app.openAgentInspectorWork();
    void desktopIpc.supervisor?.watchAgentStream?.(projection.entryId);
  }

  function stopAgentInspectorLive(): void {
    agentInspectorRequestState.agentInspectorLiveIdentity = null;
    agentInspectorLiveFeed.value = { events: [], ended: false, droppedEvents: 0 };
    void desktopIpc.supervisor?.watchAgentStream?.(null);
  }

  function refreshOpenAgentInspectorRuntimeControl(snapshot: DesktopSupervisorStateSnapshot): void {
    if (snapshot.daemonGeneration !== supervisorSyncState.supervisorStateDaemonGeneration || snapshot.sequence !== supervisorSyncState.supervisorStateSequence) return;
    const target = selectedAgentDetailTarget.value;
    if (target?.kind !== "supervised") return;
    const entry = snapshot.entries.find((candidate) => candidate.id === target.supervisorEntryId);
    if (!entry || entry.roomId !== props.room.identifier) return;
    const source = agentInspectorWorkSourceMessageId.value;
    const key = agentInspectorDetailKey(entry, source, snapshot.daemonGeneration);
    const revision = agentInspectorDetailRevision(entry);
    void agentInspectorBackgroundRefresh.refresh(key, revision, async () => {
      const current = app.selectedAgentDetailProjection.value;
      if (!current || agentInspectorDetailKey(current.entry, agentInspectorWorkSourceMessageId.value,
        supervisorStatus.value?.generation ?? 0) !== key) return false;
      await loadAgentInspectorWorkDetail(source, true, false);
      const latest = app.selectedAgentDetailProjection.value;
      return Boolean(latest && agentInspectorDetailKey(latest.entry, agentInspectorWorkSourceMessageId.value,
        supervisorStatus.value?.generation ?? 0) === key && agentInspectorWorkResource.value.status === "ready");
    });
  }

  function selectAgentInspectorWorkSource(sourceMessageId: string): void {
    if (!sourceMessageId.trim()) return;
    agentInspectorWorkSourceMessageId.value = sourceMessageId;
    // A work item is a fenced causal record, not a generic detail cache. Never
    // leave the previous message visible while the exact new source is loading.
    agentInspectorWorkResource.value = { status: "loading", detail: null, error: null, sourceMessageId };
    void loadAgentInspectorWorkDetail(sourceMessageId);
  }

  async function loadAgentInspectorWorkDetail(
    sourceMessageId: string | null = agentInspectorWorkSourceMessageId.value,
    force = false,
    followDefaultSource = true,
  ): Promise<void> {
    const target = selectedAgentDetailTarget.value;
    const projection = app.selectedAgentDetailProjection.value;
    if (target?.kind !== "supervised" || !projection || projection.roomId !== props.room.identifier) return;
    if (!desktopIpc.supervisor?.getAgentInspectorDetail || !supervisorStatus.value?.capabilities.agentInspectorDetail) {
      agentInspectorWorkResource.value = { status: "unavailable", detail: null, error: null, sourceMessageId };
      return;
    }
    if (!force && agentInspectorWorkResource.value.status === "ready" && agentInspectorWorkSourceMessageId.value === sourceMessageId) return;
    const daemonGeneration = supervisorStatus.value.generation;
    agentInspectorWorkSourceMessageId.value = sourceMessageId;
    const key = agentInspectorDetailKey(projection.entry, sourceMessageId, daemonGeneration);
    return agentInspectorDetailRequest.run(key, followDefaultSource, async intent => {
      const token = ++agentInspectorRequestState.agentInspectorWorkRequestToken;
      const isCurrent = () => agentInspectorDetailRequestIsCurrent(key, token, {
        entry: app.selectedAgentDetailProjection.value?.entry, roomId: props.room.identifier,
        source: agentInspectorWorkSourceMessageId.value, generation: supervisorStatus.value?.generation ?? null,
        snapshotGeneration: supervisorSyncState.supervisorStateDaemonGeneration, token: agentInspectorRequestState.agentInspectorWorkRequestToken,
      });
      const currentDetail = await readAgentInspectorWorkDetail({
        entry: projection.entry, source: sourceMessageId, generation: daemonGeneration,
        previous: agentInspectorWorkResource.value,
        read: () => desktopIpc.supervisor.getAgentInspectorDetail({ entryId: target.supervisorEntryId, roomId: projection.roomId, sourceMessageId }),
        isCurrent,
        write: resource => { agentInspectorWorkResource.value = resource; },
      });
      if (!currentDetail || !isCurrent()) return;
      const defaultSource = defaultAgentInspectorWorkSource(projection.entry, currentDetail);
      if (intent.followDefaultSource && sourceMessageId === null && defaultSource && defaultSource !== agentInspectorWorkSourceMessageId.value) {
        agentInspectorWorkSourceMessageId.value = defaultSource;
        void loadAgentInspectorWorkDetail(defaultSource);
      }
    });
  }

  async function revealAgentInspectorWorkMessage(canonicalMessageId: string): Promise<void> {
    const detail = agentInspectorWorkResource.value.detail;
    const target = selectedAgentDetailTarget.value;
    if (target?.kind !== "supervised" || !canRevealAgentInspectorWorkMessage(detail, target.supervisorEntryId, props.room.identifier, canonicalMessageId)) return;
    activeTab.value = "chat";
    await app.revealRoomMessage(canonicalMessageId);
    if (agentInspectorCompact.value) closeAgentDetail();
  }

  function openReasoningFromAgentDetail(sessionId: string): void {
    closeAgentDetail();
    app.openReasoningInspector(sessionId);
  }
  return {
    openAgentDetailFromParticipant, openAgentDetailRequest, loadAgentInspectorProviders,
    closeAgentDetail, openAgentInspectorLive, stopAgentInspectorLive,
    refreshOpenAgentInspectorRuntimeControl, selectAgentInspectorWorkSource,
    loadAgentInspectorWorkDetail, revealAgentInspectorWorkMessage, openReasoningFromAgentDetail,
  };
}

/** Pause requests, wake rules, inspector projections, correction handoff, and configuration apply. */
export function useRoomShellAgentProjections(context: unknown) {
  const {
    agentInspectorActionState, agentInspectorConfigurationResource, agentInspectorOperationCurrent,
    agentInspectorOperationIdentityCurrent, agentInspectorSettingsSelectionCurrent,
    agentInspectorWorkResource, beginAgentInspectorOperation, continuationRepairAvailable,
    deliveryRetryAvailable, deliveryRetryingKeys, openAgentDetailRequest, props,
    recoverAgentInspectorSettingsGeneration, refreshSupervisorStatus, revealWakeMessage,
    roomDeliverySkipAvailable, roomIdentifierRef, selectedAgentDetailTarget, supervisorEntries,
    supervisorEntriesState, supervisorStatus,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellInspectorActions"
    | "useRoomShellInspectorSettings"
    | "useRoomShellState"
    | "useRoomShellSupervisorActions"
    | "useRoomShellToolActions"
  >;
  const app = context as RoomShellContextOf<"useRoomShellParticipants">;
  const agentPauseRequests = useAgentPauseRequests(supervisorEntries);
  const roomWakeRules = useRoomWakeRules(roomIdentifierRef, computed(() => props.storage.effectiveMode !== "local"));
  provideRoomWakeRules({
    roomIdentifier: roomIdentifierRef,
    activeByAgentKey: roomWakeRules.activeByAgentKey,
    recentByAgentKey: roomWakeRules.recentByAgentKey,
    api: roomWakeRules.api,
    openMessage: (messageId) => { void revealWakeMessage(messageId); },
  });
  const agentInspectorProjections = computed(() => {
    return projectAgentInspectors(supervisorEntries.value, {
      roomId: props.room.identifier,
      tasks: props.tasks,
      deliveryRetryAvailable: deliveryRetryAvailable.value,
      continuationRepairAvailable: continuationRepairAvailable.value,
      roomDeliverySkipAvailable: roomDeliverySkipAvailable.value,
      resourceFreshness: supervisorEntriesResourceFreshness(supervisorEntriesState.value),
      workResource: agentInspectorWorkResource.value,
      daemonGeneration: supervisorStatus.value?.generation ?? null,
      mentionInsertTextByEntryId: app.agentMentionInsertTextByEntryId.value,
      deliveryRetryingKeys: deliveryRetryingKeys.value,
      pauseRequestedEntryIds: agentPauseRequests.entryIds.value,
    });
  });
  const {
    correctionRequest: agentInspectorCorrectionRequest,
    correctableAgents,
    openCorrectionOrInspector: openAgentCorrectionOrInspector,
    openCorrectionFromComposer: openAgentCorrectionFromComposer,
    releaseCorrection: releaseAgentCorrectionRequest,
  } = useAgentCorrectionHandoff({
    roomIdentifier: () => props.room.identifier,
    projections: () => agentInspectorProjections.value,
    openInspector: (projection) => openAgentDetailRequest(supervisedAgentInspectorRequest(projection.entry, {
      ownerAttribution: ownerAttributionLabel(projection.entry.createdBy),
    })),
  });
  Object.assign(app, { releaseAgentCorrectionRequest });
  const selectedAgentDetailProjection = computed(() => {
    const target = selectedAgentDetailTarget.value;
    if (target?.kind !== "supervised") return null;
    return agentInspectorProjections.value.find((projection) => projection.entryId === target.supervisorEntryId) ?? null;
  });
  Object.assign(app, { selectedAgentDetailProjection });
  const { applyAgentInspectorSettings } = useAgentInspectorConfigurationApply({
    selectedProjection: selectedAgentDetailProjection,
    configurationResource: agentInspectorConfigurationResource,
    actionState: agentInspectorActionState,
    refreshSupervisorStatus,
    selectionCurrent: agentInspectorSettingsSelectionCurrent,
    beginOperation: (message, daemonGeneration) =>
      beginAgentInspectorOperation("apply_settings", message, daemonGeneration),
    operationIdentityCurrent: agentInspectorOperationIdentityCurrent,
    operationCurrent: agentInspectorOperationCurrent,
    recoverGeneration: recoverAgentInspectorSettingsGeneration,
  });
  const selectedAgentInspectorActionState = computed(() => {
    const target = selectedAgentDetailTarget.value;
    return agentInspectorActionStateForEntry(
      agentInspectorActionState.value,
      target?.kind === "supervised" ? target.supervisorEntryId : null,
    );
  });
  const selectedAgentInspectorWorkArtifacts = computed(() => {
    const projection = selectedAgentDetailProjection.value;
    return projection ? agentInspectorWorkArtifacts(projection.assignedWork, props.roomArtifacts) : [];
  });
  const deliveryReceiptsByMessage = computed(() => roomMessageDeliveryReceipts(supervisorEntries.value));
  return {
    agentPauseRequests, roomWakeRules, agentInspectorProjections, agentInspectorCorrectionRequest,
    correctableAgents, openAgentCorrectionOrInspector, openAgentCorrectionFromComposer,
    releaseAgentCorrectionRequest, selectedAgentDetailProjection, applyAgentInspectorSettings,
    selectedAgentInspectorActionState, selectedAgentInspectorWorkArtifacts,
    deliveryReceiptsByMessage,
  };
}

/** Reset the inspector on focus changes, and follow the live session. */
export function useRoomShellInspectorWatchers(context: unknown) {
  const {
    agentInspectorConfigurationResource, agentInspectorRequestState, loadAgentInspectorSettings,
    openAgentInspectorLive, selectedAgentDetailProjection, selectedAgentDetailRequestVersion,
  } = context as RoomShellContextOf<
      "useRoomShellAgentProjections"
    | "useRoomShellInspectorActions"
    | "useRoomShellInspectorSettings"
    | "useRoomShellState"
  >;
  // Identity can resolve after the panel opens from a historical message.
  watch([() => selectedAgentDetailProjection.value?.entryId, selectedAgentDetailRequestVersion], ([entryId]) => {
    if (entryId && agentInspectorConfigurationResource.value.status === "idle") void loadAgentInspectorSettings();
  });

  watch(
    () => [selectedAgentDetailProjection.value?.entry.agentSessionId, selectedAgentDetailProjection.value?.entry.executionGenerationId],
    () => {
      if (agentInspectorRequestState.agentInspectorLiveIdentity !== null) openAgentInspectorLive();
    },
  );
}

/** Inspector diagnostics and work observations. */
export function useRoomShellInspectorObservations(context: unknown) {
  const {
    agentInspectorWorkResource, agentInspectorWorkSourceMessageId, loadAgentInspectorWorkDetail,
    refreshSupervisorStatus, selectedAgentDetailProjection, selectedAgentDetailRequestVersion,
    supervisorEntriesError, supervisorEntriesState, supervisorStatus, supervisorSyncState,
    upsertSupervisorEntry,
  } = context as RoomShellContextOf<
      "useRoomShellAgentProjections"
    | "useRoomShellInspectorActions"
    | "useRoomShellState"
    | "useRoomShellSupervisorActions"
  >;
  const app = context as object;
  const { refreshDiagnostics: refreshAgentInspectorDiagnostics, openWork: openAgentInspectorWork } = useAgentInspectorObservations({
    selectedProjection: selectedAgentDetailProjection, requestVersion: selectedAgentDetailRequestVersion,
    daemonStatus: supervisorStatus, workSource: agentInspectorWorkSourceMessageId, workResource: agentInspectorWorkResource,
    observationVersion: () => `${supervisorSyncState.supervisorEntriesMutationVersion}:${supervisorSyncState.supervisorStateSequence}`,
    refreshStatus: refreshSupervisorStatus, readAgents: room => desktopIpc.supervisor.listAgents(room),
    loadDetail: (source, followDefault) => loadAgentInspectorWorkDetail(source, true, followDefault),
    upsert: (entry, version) => upsertSupervisorEntry({ entry, roomIdentifier: entry.roomId, inspectorRequestVersion: version }),
    entriesState: supervisorEntriesState, entriesError: supervisorEntriesError,
  });
  Object.assign(app, { openAgentInspectorWork });
  return {
    refreshAgentInspectorDiagnostics, openAgentInspectorWork,
  };
}
