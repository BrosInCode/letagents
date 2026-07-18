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
  scanStatus: SupervisedRecoveryScanStatus;
  hasActiveLaunch: boolean;
  hasRecoveryCandidate: boolean;
  recoveringCandidate: boolean;
}): boolean {
  return recoveryScanAllowsNewLaunch(input.scanStatus)
    && !input.hasActiveLaunch
    && !input.hasRecoveryCandidate
    && !input.recoveringCandidate;
}

function withRecoveryScanTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };
    const timer = window.setTimeout(() => finish(() => reject(new Error(
      "The supervisor check took too long to respond.",
    ))), timeoutMs);
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
    let entries: DesktopSupervisorManifestEntry[];
    try {
      entries = await withRecoveryScanTimeout(
        desktopIpc.supervisor.listAgents(roomIdentifier),
        options.scanTimeoutMs ?? DEFAULT_RECOVERY_SCAN_TIMEOUT_MS,
      );
    } catch (error) {
      if (
        generation === lookupGeneration
        && options.open()
        && options.roomIdentifier() === roomIdentifier
        && options.providerId() === providerId
      ) {
        scanStatus.value = "error";
        options.setLookupFeedback(`${contextualAddAgentError(
          `Couldn't check for previous ${providerId.replaceAll("-", " ")} agents`,
          error,
          "The supervisor is unavailable.",
        )} Try the check again, or start a new supervised agent.`, "error");
      }
      return;
    } finally {
      if (generation === lookupGeneration) detecting.value = false;
    }
    if (
      generation !== lookupGeneration
      || !options.open()
      || options.roomIdentifier() !== roomIdentifier
      || options.providerId() !== providerId
    ) return;
    if (options.conflict.value || options.launchStarted.value || recovering.value || candidate.value) {
      scanStatus.value = "ready";
      return;
    }
    scanStatus.value = "ready";
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
        && (entry.desiredState === "running" || entry.desiredState === "paused")
        && !supervisedLaunchProgress(entry).ready
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const remembered = recoverable.find((entry) => options.hasRememberedLaunch(roomIdentifier, entry.id));
    const launching = remembered ?? recoverable[0];
    if (!launching) return;
    if (remembered && launching.desiredState !== "paused") {
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
      if (!refreshed.entry || (refreshed.entry.desiredState !== "running" && refreshed.entry.desiredState !== "paused")) {
        options.forgetLaunch(roomIdentifier, selected.id);
        candidate.value = null;
        options.setLookupFeedback("That previous supervised launch is no longer available. It was not restarted.", "warning");
        return;
      }
      let entry = refreshed.entry;
      if (entry.desiredState === "paused") {
        try {
          entry = await desktopIpc.supervisor.resumeOwnershipTransfer(entry.id);
        } catch (error) {
          if (generation === lookupGeneration && options.isCurrentRequest(requestVersion)) {
            options.setLookupFeedback(`${contextualAddAgentError(
              `Couldn't resume the saved ${entry.displayName} launch`,
              error,
              "The ownership transfer is still paused.",
            )} Cancel it before starting a replacement, or try Recover again.`, "error");
          }
          return;
        }
      }
      if (
        generation !== lookupGeneration
        || !options.open()
        || !options.isCurrentRequest(requestVersion)
        || options.roomIdentifier() !== roomIdentifier
        || options.providerId() !== selected.provider
        || candidate.value?.id !== selected.id
      ) return;
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
      || (entry.desiredState !== "running" && entry.desiredState !== "paused")
      || supervisedLaunchProgress(entry).ready
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

  async function offerAmbiguousCreation(creationRequestId: string, roomIdentifier: string): Promise<void> {
    const generation = ambiguousGeneration;
    const refreshed = await refreshSupervisedRuntimeEntry(
      desktopIpc.supervisor,
      roomIdentifier,
      `supervised_${creationRequestId}`,
    );
    if (generation !== ambiguousGeneration || options.roomIdentifier() !== roomIdentifier) return;
    if (!refreshed.entry) {
      if (!refreshed.error) options.forgetLaunch(roomIdentifier, `supervised_${creationRequestId}`);
      return;
    }
    if (options.open()) offer(refreshed.entry);
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
