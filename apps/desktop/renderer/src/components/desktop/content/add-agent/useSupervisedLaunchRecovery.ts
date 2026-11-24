import { ref, type Ref } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import { supervisedLaunchProgress } from "../../../../domain/supervised-launch";
import { refreshSupervisedRuntimeEntry } from "../../../../domain/supervised-recovery";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

const DEFAULT_RECOVERY_SCAN_TIMEOUT_MS = 12_000;

export type SupervisedRecoveryScanStatus = "idle" | "checking" | "ready" | "error";

/** A failed passive lookup must not trap the user. The durable create path still
 * owns conflict and availability reporting if a replacement cannot be started. */
export function recoveryScanAllowsNewLaunch(status: SupervisedRecoveryScanStatus): boolean {
  return status === "ready" || status === "error";
}

export function canStartNewSupervisedLaunch(input: {
  providerId: DesktopAgentProviderId | null;
  scanStatus: SupervisedRecoveryScanStatus;
  hasActiveLaunch: boolean;
  recoveringCandidate: boolean;
}): boolean {
  // Every durable agent owns its own runtime, so a recoverable entry never
  // blocks another launch; only an explicit recovery in flight does.
  return recoveryScanAllowsNewLaunch(input.scanStatus)
    && !input.hasActiveLaunch
    && !input.recoveringCandidate;
}

/** Recovery belongs to launches that never produced a ready agent. Once an
 * agent reached ready, later liveness degradation is lifecycle state for that
 * stable agent—not an abandoned Add Agent transaction. */
function isIncompleteRecoverableLaunch(entry: DesktopSupervisorManifestEntry): boolean {
  return entry.desiredState === "running"
    && entry.readyReachedAt == null
    && !supervisedLaunchProgress(entry).ready;
}

export function useSupervisedLaunchRecovery(options: {
  open: () => boolean;
  roomIdentifier: () => string;
  providerId: () => DesktopAgentProviderId | null;
  currentVersion: () => number;
  isCurrentRequest: (version: number) => boolean;
  launchStarted: Ref<boolean>;
  conflict: Ref<DesktopSupervisorManifestEntry | null>;
  stoppingEntryId: Ref<string | null>;
  hasRememberedLaunch: (roomIdentifier: string, entryId: string) => boolean;
  rememberLaunch: (roomIdentifier: string, entryId: string) => void;
  forgetLaunch: (roomIdentifier: string, entryId: string) => void;
  activate: (entry: DesktopSupervisorManifestEntry) => void;
  setLookupFeedback: (message: string | null, tone?: AddAgentFeedbackTone) => void;
  scanTimeoutMs?: number;
}) {
  const candidate = ref<DesktopSupervisorManifestEntry | null>(null);
  const detecting = ref(false);
  const scanStatus = ref<SupervisedRecoveryScanStatus>("idle");
  const recovering = ref(false);
  let lookupGeneration = 0;
  let ambiguousGeneration = 0;

  async function detect(): Promise<void> {
    if (!options.open() || options.conflict.value || options.launchStarted.value || candidate.value || detecting.value) return;
    const generation = ++lookupGeneration;
    const roomIdentifier = options.roomIdentifier();
    const providerId = options.providerId();
    if (!providerId) return;
    detecting.value = true;
    scanStatus.value = "checking";
    options.setLookupFeedback(null);
    const isCurrent = () => generation === lookupGeneration && options.open()
      && options.roomIdentifier() === roomIdentifier && options.providerId() === providerId;
    const applicable = () => isCurrent() && !options.conflict.value && !options.launchStarted.value
      && !recovering.value && !candidate.value;

    const readEntries = async (): Promise<void> => {
      let entries: DesktopSupervisorManifestEntry[];
      try { entries = await desktopIpc.supervisor.listAgents(roomIdentifier); }
      catch (error) {
        if (applicable()) {
          scanStatus.value = "error";
          options.setLookupFeedback(contextualAddAgentError(
            "The local supervisor could not list previous agents", error, "Choose Check again to retry.",
          ), "error");
        }
        return;
      }
      if (!isCurrent()) return;
      scanStatus.value = "ready";
      if (applicable()) {
        options.setLookupFeedback(null);
        selectPreviousLaunch(entries, roomIdentifier, providerId);
      }
    };

    // Release the form on its deadline, while still accepting the actual answer
    // if the same lookup finishes and no new launch or retry has superseded it.
    let timer: number | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = window.setTimeout(() => {
        if (applicable()) {
          scanStatus.value = "error";
          options.setLookupFeedback("The local supervisor is taking longer to respond. Choose Check again to retry.", "warning");
        }
        resolve();
      }, options.scanTimeoutMs ?? DEFAULT_RECOVERY_SCAN_TIMEOUT_MS);
    });
    try { await Promise.race([readEntries(), deadline]); }
    finally {
      window.clearTimeout(timer);
      if (generation === lookupGeneration) detecting.value = false;
    }
  }

  function selectPreviousLaunch(entries: DesktopSupervisorManifestEntry[], roomIdentifier: string, providerId: DesktopAgentProviderId): void {
    const failedStop = entries
      .filter((entry) => entry.provider === providerId && supervisedLaunchProgress(entry).stopFailed)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (failedStop) {
      options.rememberLaunch(roomIdentifier, failedStop.id);
      options.activate(failedStop);
      return;
    }
    const stopping = entries
      .filter((entry) => (
        entry.provider === providerId
        && entry.desiredState === "stopped"
        && entry.observedState !== "stopped"
        && !supervisedLaunchProgress(entry).stopFailed
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (stopping) {
      options.stoppingEntryId.value = stopping.id;
      options.rememberLaunch(roomIdentifier, stopping.id);
      options.activate(stopping);
      return;
    }
    const recoverable = entries
      .filter((entry) => (
        entry.provider === providerId
        && isIncompleteRecoverableLaunch(entry)
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const remembered = recoverable.find((entry) => options.hasRememberedLaunch(roomIdentifier, entry.id));
    const launching = remembered ?? recoverable[0];
    if (!launching) return;
    if (remembered) {
      options.activate(launching);
      return;
    }
    candidate.value = launching;
  }

  async function recover(): Promise<void> {
    const selected = candidate.value;
    if (
      !selected
      || selected.provider !== options.providerId()
      || !options.open()
      || options.launchStarted.value
      || options.conflict.value
      || recovering.value
    ) return;
    const generation = ++lookupGeneration;
    const roomIdentifier = options.roomIdentifier();
    const requestVersion = options.currentVersion();
    recovering.value = true;
    options.setLookupFeedback(null);
    try {
      const refreshed = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, roomIdentifier, selected.id);
      if (
        generation !== lookupGeneration
        || !options.open()
        || !options.isCurrentRequest(requestVersion)
        || options.roomIdentifier() !== roomIdentifier
        || options.providerId() !== selected.provider
        || candidate.value?.id !== selected.id
        || options.launchStarted.value
        || options.conflict.value
      ) return;
      if (refreshed.error) {
        options.setLookupFeedback(`${contextualAddAgentError(
          "Could not refresh the previous supervised launch",
          refreshed.cause,
          refreshed.error,
        )} Try Recover again; no new agent was started.`, "error");
        return;
      }
      if (!refreshed.entry || refreshed.entry.desiredState !== "running") {
        options.forgetLaunch(roomIdentifier, selected.id);
        candidate.value = null;
        options.setLookupFeedback("That previous supervised launch is no longer available. It was not restarted.", "warning");
        return;
      }
      const entry = refreshed.entry;
      options.rememberLaunch(roomIdentifier, entry.id);
      options.activate(entry);
    } finally {
      if (generation === lookupGeneration) recovering.value = false;
    }
  }

  function offer(entry: DesktopSupervisorManifestEntry): void {
    if (
      !options.open()
      || entry.roomId !== options.roomIdentifier()
      || entry.provider !== options.providerId()
      || !isIncompleteRecoverableLaunch(entry)
      || options.conflict.value
      || options.launchStarted.value
      || recovering.value
    ) return;
    if (!candidate.value || entry.createdAt >= candidate.value.createdAt) {
      lookupGeneration += 1;
      detecting.value = false;
      candidate.value = entry;
      scanStatus.value = "ready";
      options.setLookupFeedback(null);
    }
  }

  async function offerAmbiguousCreation(creationRequestId: string, roomIdentifier: string): Promise<DesktopSupervisorManifestEntry | null> {
    const generation = ambiguousGeneration;
    const refreshed = await refreshSupervisedRuntimeEntry(
      desktopIpc.supervisor,
      roomIdentifier,
      `supervised_${creationRequestId}`,
    );
    if (generation !== ambiguousGeneration || options.roomIdentifier() !== roomIdentifier) return null;
    if (!refreshed.entry) {
      if (!refreshed.error) options.forgetLaunch(roomIdentifier, `supervised_${creationRequestId}`);
      return null;
    }
    if (options.open()) offer(refreshed.entry);
    // The room may display this confirmed save even when the create surface
    // has closed. No recovery is activated and no new create is attempted.
    return refreshed.entry;
  }

  function invalidateAmbiguousLookups(): void {
    ambiguousGeneration += 1;
  }

  function cancelExplicitRecovery(): void {
    if (!recovering.value) return;
    lookupGeneration += 1;
    recovering.value = false;
  }

  function providerChanged(): void {
    lookupGeneration += 1;
    detecting.value = false;
    scanStatus.value = "idle";
    recovering.value = false;
  }

  function cleanup(): void {
    lookupGeneration += 1;
    ambiguousGeneration += 1;
    detecting.value = false;
    scanStatus.value = "idle";
    recovering.value = false;
    candidate.value = null;
  }

  return {
    candidate,
    detecting,
    scanStatus,
    recovering,
    detect,
    recover,
    offer,
    offerAmbiguousCreation,
    invalidateAmbiguousLookups,
    cancelExplicitRecovery,
    providerChanged,
    cleanup,
  };
}
