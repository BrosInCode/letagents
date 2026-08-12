import type { Ref } from "vue";
import type {
  DesktopLaunchEvent,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import { supervisedLaunchProgress } from "../../../../domain/supervised-launch";
import {
  refreshSupervisedRuntimeEntry,
  stopSupervisedProviderLane,
} from "../../../../domain/supervised-recovery";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

export function useSupervisedRuntimePolling(options: {
  open: () => boolean;
  roomIdentifier: () => string;
  currentVersion: () => number;
  isCurrentRequest: (version: number) => boolean;
  conflict: Ref<DesktopSupervisorManifestEntry | null>;
  stoppingEntryId: Ref<string | null>;
  activeLaunchId: Ref<string | null>;
  launchEvents: Ref<DesktopLaunchEvent[]>;
  providerId: () => string | null;
  forgetLaunch: (roomIdentifier: string, entryId: string) => void;
  appendLaunchEvent: (event: DesktopLaunchEvent) => void;
  unsubscribeLaunchEvents: () => void;
  clearActiveLaunch: () => void;
  setLookupFeedback: (message: string | null, tone?: AddAgentFeedbackTone) => void;
  onMessage: (message: string | null, tone?: AddAgentFeedbackTone) => void;
}) {
  let timer: number | null = null;
  let generation = 0;

  function stopPolling(): void {
    generation += 1;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function startPolling(entryId: string, intervalMs = 1_000): void {
    stopPolling();
    const pollingGeneration = generation;
    const roomIdentifier = options.roomIdentifier();
    const scheduleNext = (delayMs = intervalMs): void => {
      if (pollingGeneration !== generation) return;
      timer = window.setTimeout(() => void refresh(), delayMs);
    };
    const refresh = async (): Promise<void> => {
      if (
        pollingGeneration !== generation
        || !options.open()
        || options.roomIdentifier() !== roomIdentifier
        || options.conflict.value?.id !== entryId
      ) {
        stopPolling();
        return;
      }
      const requestVersion = options.currentVersion();
      const refreshed = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, roomIdentifier, entryId);
      if (
        pollingGeneration !== generation
        || !options.isCurrentRequest(requestVersion)
        || options.roomIdentifier() !== roomIdentifier
        || options.conflict.value?.id !== entryId
      ) return;
      if (refreshed.error) {
        options.setLookupFeedback(`${contextualAddAgentError(
          "Couldn't refresh supervised status",
          refreshed.cause,
          refreshed.error,
        )} We'll keep checking without restarting the agent.`, "warning");
        const currentProgress = options.conflict.value ? supervisedLaunchProgress(options.conflict.value) : null;
        scheduleNext(currentProgress?.recoverableBlocked ? 4_000 : intervalMs);
        return;
      }
      if (!refreshed.entry) {
        options.setLookupFeedback(null);
        options.forgetLaunch(roomIdentifier, entryId);
        if (options.stoppingEntryId.value === entryId) options.stoppingEntryId.value = null;
        const missingEntry = options.conflict.value;
        options.conflict.value = null;
        options.appendLaunchEvent({
          launchId: options.activeLaunchId.value ?? entryId,
          entryId,
          roomIdentifier,
          provider: missingEntry?.provider ?? options.providerId() ?? "agent",
          sequence: Math.max(0, ...options.launchEvents.value.map((event) => event.sequence)) + 1,
          type: "launch.failed",
          at: new Date().toISOString(),
          detail: "We lost track of this launch. Try again or dismiss it.",
          recovery: "retry",
          durable: false,
        });
        stopPolling();
        options.unsubscribeLaunchEvents();
        return;
      }
      options.conflict.value = refreshed.entry;
      options.setLookupFeedback(null);
      const progress = supervisedLaunchProgress(refreshed.entry);
      if (refreshed.entry.desiredState === "stopped") {
        if (refreshed.entry.observedState === "stopped") {
          options.stoppingEntryId.value = null;
          options.forgetLaunch(roomIdentifier, refreshed.entry.id);
          options.onMessage(`${refreshed.entry.displayName} is stopped. You can now start a replacement.`);
          options.clearActiveLaunch();
          return;
        }
        if (progress.stopFailed) {
          options.stoppingEntryId.value = null;
          options.onMessage(null);
          stopPolling();
          options.unsubscribeLaunchEvents();
          return;
        }
        options.stoppingEntryId.value = entryId;
        scheduleNext();
        return;
      }
      if (progress.ready || progress.stopped) options.forgetLaunch(roomIdentifier, refreshed.entry.id);
      if (progress.recoverableBlocked) {
        scheduleNext(4_000);
        return;
      }
      if (progress.ready || progress.failed || progress.stopped) {
        stopPolling();
        options.unsubscribeLaunchEvents();
        return;
      }
      scheduleNext();
    };
    void refresh();
  }

  async function stopEntry(): Promise<void> {
    const entry = options.conflict.value;
    if (!entry || options.stoppingEntryId.value) return;
    const requestVersion = options.currentVersion();
    options.stoppingEntryId.value = entry.id;
    options.onMessage(null);
    try {
      const updated = await stopSupervisedProviderLane(desktopIpc.supervisor, entry.id);
      if (!options.isCurrentRequest(requestVersion)) return;
      options.conflict.value = updated;
      if (updated.desiredState === "stopped" && updated.observedState === "stopped") {
        options.stoppingEntryId.value = null;
        options.forgetLaunch(entry.roomId, entry.id);
        options.onMessage(`${updated.displayName} is stopped. You can now start a replacement.`);
        options.clearActiveLaunch();
      } else if (supervisedLaunchProgress(updated).stopFailed) {
        options.stoppingEntryId.value = null;
        options.onMessage(null);
      } else {
        options.onMessage(null);
        startPolling(updated.id);
      }
    } catch (error) {
      if (!options.isCurrentRequest(requestVersion)) return;
      const refreshed = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, entry.roomId, entry.id);
      if (!options.isCurrentRequest(requestVersion)) return;
      if (refreshed.entry?.desiredState === "stopped") {
        options.conflict.value = refreshed.entry;
        if (supervisedLaunchProgress(refreshed.entry).stopFailed) {
          options.stoppingEntryId.value = null;
          options.onMessage(null);
          stopPolling();
          options.unsubscribeLaunchEvents();
          return;
        }
        options.onMessage("Stop was accepted. Waiting for the supervised agent to exit.", "warning");
        startPolling(entry.id);
        return;
      }
      options.stoppingEntryId.value = null;
      options.onMessage(contextualAddAgentError(
        `Couldn't stop ${entry.displayName}`,
        error,
        "The agent may still be running. Check its status and try again.",
      ), "error");
    }
  }

  return { startPolling, stopPolling, stopEntry };
}
