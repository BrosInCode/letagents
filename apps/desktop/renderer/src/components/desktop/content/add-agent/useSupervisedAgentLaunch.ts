import { computed, getCurrentInstance, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopLaunchRecoveryAction,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import { foldLaunchJourney } from "../../../../domain/launch-journey";
import { supervisedLaunchProgress } from "../../../../domain/supervised-launch";
import {
  refreshSupervisedRuntimeEntry,
} from "../../../../domain/supervised-recovery";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";
import { createSupervisedLaunchAttachments } from "./supervised-launch-attachments";
import { useSupervisedLaunchEventStream } from "./useSupervisedLaunchEventStream";
import { useSupervisedRuntimePolling } from "./useSupervisedRuntimePolling";
import { useSupervisedLaunchRecovery } from "./useSupervisedLaunchRecovery";

export function canAddAnotherCodexAgent(input: {
  providerId: DesktopAgentProviderId | null;
  entry: DesktopSupervisorManifestEntry | null;
}): boolean {
  return input.providerId === "codex"
    && input.entry?.provider === "codex"
    && supervisedLaunchProgress(input.entry).ready;
}

export function useSupervisedAgentLaunch(options: {
  open: MaybeRefOrGetter<boolean>;
  roomIdentifier: MaybeRefOrGetter<string>;
  roomLabel: MaybeRefOrGetter<string>;
  providerId: MaybeRefOrGetter<DesktopAgentProviderId | null>;
  authCommand: MaybeRefOrGetter<string | null>;
  authCommandForProvider: (providerId: string | null) => string | null;
  isCurrentRequest: (version: number) => boolean;
  currentVersion: () => number;
  onChooseRepo: () => void;
  onCopyAuthCommand: (command: string) => void;
  onRetry: () => void;
  onMessage: (message: string | null, tone?: AddAgentFeedbackTone) => void;
  recoveryScanTimeoutMs?: number;
}) {
  const attachments = createSupervisedLaunchAttachments();
  const {
    activeLaunchId,
    events: launchEvents,
    append: appendLaunchEvent,
    replay,
    subscribe,
    unsubscribe,
    clear: clearLaunchEventStream,
  } = useSupervisedLaunchEventStream();
  const hasRememberedLaunch = attachments.has;
  const rememberLaunch = attachments.remember;
  const forgetLaunch = attachments.forget;
  const launchStarted = ref(false);
  const conflict = ref<DesktopSupervisorManifestEntry | null>(null);
  const conflictLookupError = ref<string | null>(null);
  const conflictLookupTone = ref<AddAgentFeedbackTone>("error");
  const stoppingEntryId = ref<string | null>(null);
  const creationRequestId = ref<string | null>(null);
  const signInCommandCopiedForEntryId = ref<string | null>(null);

  const view = computed(() =>
    launchStarted.value || conflict.value
      ? foldLaunchJourney({
          events: launchEvents.value,
          entry: conflict.value,
          provider: toValue(options.providerId) ?? undefined,
          roomLabel: toValue(options.roomLabel),
          requested: launchStarted.value,
          hasSignInCommand: Boolean(authCommandForActiveLaunch())
            && signInCommandCopiedForEntryId.value !== (conflict.value?.id ?? activeLaunchId.value),
        })
      : null,
  );

  function authCommandForActiveLaunch(): string | null {
    if (conflict.value) return options.authCommandForProvider(conflict.value.provider);
    return options.authCommandForProvider(toValue(options.providerId)) ?? toValue(options.authCommand);
  }
  const runtimePolling = useSupervisedRuntimePolling({
    open: () => toValue(options.open),
    roomIdentifier: () => toValue(options.roomIdentifier),
    currentVersion: options.currentVersion,
    isCurrentRequest: options.isCurrentRequest,
    conflict,
    stoppingEntryId,
    activeLaunchId,
    launchEvents,
    providerId: () => toValue(options.providerId),
    forgetLaunch,
    appendLaunchEvent,
    unsubscribeLaunchEvents: unsubscribe,
    clearActiveLaunch: () => clearActiveLaunch(),
    setLookupFeedback: (message, tone = "error") => {
      conflictLookupError.value = message;
      conflictLookupTone.value = tone;
    },
    onMessage: options.onMessage,
  });
  const startRuntimeRefresh = runtimePolling.startPolling;
  const stopRuntimeRefresh = runtimePolling.stopPolling;
  const stop = runtimePolling.stopEntry;
  const recovery = useSupervisedLaunchRecovery({
    open: () => toValue(options.open),
    roomIdentifier: () => toValue(options.roomIdentifier),
    providerId: () => toValue(options.providerId),
    currentVersion: options.currentVersion,
    isCurrentRequest: options.isCurrentRequest,
    launchStarted,
    conflict,
    stoppingEntryId,
    hasRememberedLaunch,
    rememberLaunch,
    forgetLaunch,
    activate: (entry) => activateRecoveredEntry(entry),
    setLookupFeedback: (message, tone = "error") => {
      conflictLookupError.value = message;
      conflictLookupTone.value = tone;
    },
    scanTimeoutMs: options.recoveryScanTimeoutMs,
  });
  const recoveryCandidate = recovery.candidate;
  const detectingRecovery = recovery.detecting;
  const recoveryScanStatus = recovery.scanStatus;
  const recoveringCandidate = recovery.recovering;
  const detectRecoverableLaunch = recovery.detect;
  const recoverDetectedLaunch = recovery.recover;
  const offerRecoveryCandidate = recovery.offer;
  const offerAmbiguousCreationCandidate = recovery.offerAmbiguousCreation;

  function begin(): string {
    recovery.invalidateAmbiguousLookups();
    creationRequestId.value ||= window.crypto.randomUUID();
    rememberLaunch(toValue(options.roomIdentifier), `supervised_${creationRequestId.value}`);
    recoveryCandidate.value = null;
    launchStarted.value = true;
    conflict.value = null;
    conflictLookupError.value = null;
    signInCommandCopiedForEntryId.value = null;
    options.onMessage(null);
    subscribe(creationRequestId.value);
    return creationRequestId.value;
  }

  function complete(entry: DesktopSupervisorManifestEntry): void {
    const pendingEntryId = creationRequestId.value ? `supervised_${creationRequestId.value}` : null;
    const progress = supervisedLaunchProgress(entry);
    if (progress.stopping) stoppingEntryId.value = entry.id;
    if (progress.stopFailed) stoppingEntryId.value = null;
    const stopConverging = stoppingEntryId.value === entry.id && progress.stopping;
    conflict.value = entry;
    conflictLookupError.value = null;
    creationRequestId.value = null;
    if (pendingEntryId && pendingEntryId !== entry.id) {
      forgetLaunch(entry.roomId, pendingEntryId);
    }
    if ((progress.ready || progress.stopped) && !stopConverging) {
      forgetLaunch(entry.roomId, entry.id);
    } else if (launchStarted.value) {
      rememberLaunch(entry.roomId, entry.id);
    }
    if (
      progress.ready
      || (progress.failed && !progress.recoverableBlocked)
      || (progress.stopped && !stopConverging)
    ) {
      stopRuntimeRefresh();
      unsubscribe();
      return;
    }
    startRuntimeRefresh(entry.id);
  }

  async function recoverFailedCreation(error?: unknown): Promise<void> {
    const requestId = creationRequestId.value;
    if (!requestId) return;
    const requestVersion = options.currentVersion();
    const roomIdentifier = toValue(options.roomIdentifier);
    const providerId = toValue(options.providerId);
    await replay(requestId);
    if (
      !options.isCurrentRequest(requestVersion)
      || toValue(options.roomIdentifier) !== roomIdentifier
      || toValue(options.providerId) !== providerId
      || creationRequestId.value !== requestId
    ) return;
    const hasTerminalEvent = launchEvents.value.some((event) => (
      event.type === "launch.blocked"
      || event.type === "launch.failed"
      || event.type === "launch.cancelled"
    ));
    const recovery = await refreshSupervisedRuntimeEntry(
      desktopIpc.supervisor,
      roomIdentifier,
      `supervised_${requestId}`,
    );
    if (!options.isCurrentRequest(requestVersion)) return;
    if (recovery.entry) {
      complete(recovery.entry);
      return;
    }
    conflict.value = null;
    if (recovery.error) {
      conflictLookupError.value = `${contextualAddAgentError(
        "Couldn't confirm whether the supervised launch was saved",
        recovery.cause,
        recovery.error,
      )} The launch was not retried.`;
      conflictLookupTone.value = "error";
      return;
    }
    if (hasTerminalEvent) {
      forgetLaunch(roomIdentifier, `supervised_${requestId}`);
      return;
    }
    forgetLaunch(roomIdentifier, `supervised_${requestId}`);
    appendLaunchEvent({
        launchId: requestId,
        entryId: null,
        roomIdentifier,
        provider: providerId ?? "agent",
        sequence: Math.max(0, ...launchEvents.value.map((event) => event.sequence)) + 1,
        type: "launch.failed",
        at: new Date().toISOString(),
        detail: contextualAddAgentError(
          "The supervised agent could not be started",
          error,
          "No durable launch was created. Try again.",
        ),
        recovery: "retry",
        durable: false,
    });
  }

  function activateRecoveredEntry(entry: DesktopSupervisorManifestEntry): void {
    recoveryCandidate.value = null;
    conflict.value = entry;
    conflictLookupError.value = null;
    launchStarted.value = true;
    subscribe(entry.id.startsWith("supervised_") ? entry.id.slice(11) : entry.id);
    complete(entry);
  }

  function clearActiveLaunch(): void {
    clearLaunchEventStream();
    stopRuntimeRefresh();
    launchStarted.value = false;
    conflict.value = null;
    conflictLookupError.value = null;
    conflictLookupTone.value = "error";
    stoppingEntryId.value = null;
    signInCommandCopiedForEntryId.value = null;
  }

  function dismiss(): void {
    const activeEntry = conflict.value;
    if (activeEntry) forgetLaunch(activeEntry.roomId, activeEntry.id);
    if (creationRequestId.value) {
      forgetLaunch(toValue(options.roomIdentifier), `supervised_${creationRequestId.value}`);
      creationRequestId.value = null;
    }
    clearActiveLaunch();
  }

  /**
   * Releases only this modal's completed-launch attachment. The durable agent
   * remains running; `stop` is deliberately not involved. Non-Codex providers
   * retain their existing singleton lane behaviour.
   */
  function dismissReadyCodexLaunchForAnother(): void {
    if (!canAddAnotherCodexAgent({
      providerId: toValue(options.providerId),
      entry: conflict.value,
    })) return;
    dismiss();
  }

  function resetActiveLaunch(preserveRecoveryCandidate = true): void {
    const activeEntry = conflict.value;
    recovery.cancelExplicitRecovery();
    clearActiveLaunch();
    if (
      preserveRecoveryCandidate
      && (activeEntry?.desiredState === "running" || activeEntry?.desiredState === "paused")
      && !supervisedLaunchProgress(activeEntry).ready
    ) recoveryCandidate.value = activeEntry;
    creationRequestId.value = null;
    stoppingEntryId.value = null;
  }

  function cleanup(): void {
    recovery.cleanup();
    resetActiveLaunch(false);
  }

  function handleRecover(action: DesktopLaunchRecoveryAction): void {
    if (action === "choose_project") {
      options.onChooseRepo();
      return;
    }
    const command = authCommandForActiveLaunch();
    if (action === "sign_in" && command) {
      signInCommandCopiedForEntryId.value = conflict.value?.id ?? activeLaunchId.value;
      options.onCopyAuthCommand(command);
      return;
    }
    if (activeLaunchId.value) creationRequestId.value = activeLaunchId.value;
    options.onRetry();
  }

  watch(() => toValue(options.open), (open) => {
    if (!open) cleanup();
  });
  watch(() => toValue(options.providerId), (providerId, previousProviderId) => {
    if (providerId !== previousProviderId) {
      recovery.providerChanged();
    }
    const candidate = recoveryCandidate.value;
    if (
      providerId
      && candidate?.provider === providerId
      && hasRememberedLaunch(toValue(options.roomIdentifier), candidate.id)
      && toValue(options.open)
      && !launchStarted.value
      && !conflict.value
    ) recoveryCandidate.value = null;
    if (candidate?.provider !== providerId) recoveryCandidate.value = null;
    if (providerId && toValue(options.open) && !launchStarted.value && !conflict.value) {
      void detectRecoverableLaunch();
    }
  });
  watch(view, (next) => {
    if (!next || (!next.ready && !next.failed && !next.stopped)) return;
    const activeEntry = conflict.value;
    if (activeEntry && supervisedLaunchProgress(activeEntry).recoverableBlocked) return;
    if (
      activeEntry
      && stoppingEntryId.value === activeEntry.id
      && supervisedLaunchProgress(activeEntry).stopping
    ) return;
    if (activeEntry && (next.ready || next.stopped)) {
      forgetLaunch(activeEntry.roomId, activeEntry.id);
    }
    stopRuntimeRefresh();
    unsubscribe();
  });
  if (getCurrentInstance()) onBeforeUnmount(cleanup);

  return {
    launchStarted,
    conflict,
    recoveryCandidate,
    detectingRecovery,
    recoveryScanStatus,
    recoveringCandidate,
    conflictLookupError,
    conflictLookupTone,
    stoppingEntryId,
    creationRequestId,
    view,
    begin,
    complete,
    recoverFailedCreation,
    detectRecoverableLaunch,
    recoverDetectedLaunch,
    offerRecoveryCandidate,
    offerAmbiguousCreationCandidate,
    stop,
    dismiss,
    dismissReadyCodexLaunchForAnother,
    resetActiveLaunch,
    handleRecover,
    cleanup,
  };
}
