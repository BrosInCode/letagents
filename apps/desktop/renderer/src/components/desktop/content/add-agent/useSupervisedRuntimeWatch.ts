import { watch, type Ref } from "vue";
import type {
  DesktopLaunchEvent,
  DesktopSupervisorManifestEntry,
} from "../../../../../../electron/ipc-types";
import type { SupervisorEntriesResource } from "../../../../domain/agent-inspector-identity";
import { supervisedLaunchProgress } from "../../../../domain/supervised-launch";
import {
  SUPERVISED_RUNTIME_READ_ERROR,
  refreshSupervisedRuntimeEntry,
  stopSupervisedProviderLane,
} from "../../../../domain/supervised-recovery";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

/**
 * Follows one supervised launch through the room shell's supervisor entries.
 * The daemon pushes every manifest change to the shell, which polls only when
 * that push goes stale, so the launch card needs no read loop of its own. When
 * the pushed list has no entry for the launch, one direct read confirms the
 * loss before the card reports it: the entry can be newer than the last push.
 */
export function useSupervisedRuntimeWatch(options: {
  open: () => boolean;
  roomIdentifier: () => string;
  currentVersion: () => number;
  isCurrentRequest: (version: number) => boolean;
  entries: () => readonly DesktopSupervisorManifestEntry[];
  entriesState: () => SupervisorEntriesResource["state"];
  /** The shell's own words for why its last read failed, when it did. */
  entriesError: () => string | null;
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
  let stopWatch: (() => void) | null = null;
  let generation = 0;

  function stopWatching(): void {
    generation += 1;
    stopWatch?.();
    stopWatch = null;
  }

  function startWatching(entryId: string): void {
    stopWatching();
    const watchGeneration = generation;
    const roomIdentifier = options.roomIdentifier();
    // The list the shell held when the watch began. A caller starts the watch
    // right after a create, retry or stop reply, and the daemon's push for
    // that change reaches the shell a frame later, so this list can predate
    // the entry the card already holds.
    const listAtStart = options.entries();
    let confirming = false;

    const current = (): boolean => watchGeneration === generation
      && options.open()
      && options.roomIdentifier() === roomIdentifier
      && options.conflict.value?.id === entryId;

    const reportReadError = (cause: unknown, error: string): void => {
      // Retain the launch identity, but current native progress has lost its
      // read authority. A later successful read restores it.
      options.conflict.value = { ...options.conflict.value!, providerProgress: null };
      options.setLookupFeedback(`${contextualAddAgentError(
        "Couldn't refresh supervised status",
        cause,
        error,
      )} We'll keep watching without restarting the agent.`, "warning");
    };

    const reportLost = (): void => {
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
      stopWatching();
      options.unsubscribeLaunchEvents();
    };

    const applyEntry = (entry: DesktopSupervisorManifestEntry): void => {
      options.conflict.value = entry;
      options.setLookupFeedback(null);
      const progress = supervisedLaunchProgress(entry);
      if (entry.desiredState === "stopped") {
        if (entry.observedState === "stopped") {
          options.stoppingEntryId.value = null;
          options.forgetLaunch(roomIdentifier, entry.id);
          options.onMessage(`${entry.displayName} is stopped. You can now start a replacement.`);
          options.clearActiveLaunch();
          return;
        }
        if (progress.stopFailed) {
          options.stoppingEntryId.value = null;
          options.onMessage(null);
          stopWatching();
          options.unsubscribeLaunchEvents();
          return;
        }
        options.stoppingEntryId.value = entryId;
        return;
      }
      if (progress.ready || progress.stopped) options.forgetLaunch(roomIdentifier, entry.id);
      if (progress.recoverableBlocked) return;
      if (progress.ready || progress.failed || progress.stopped) {
        stopWatching();
        options.unsubscribeLaunchEvents();
      }
    };

    const confirmMissing = async (): Promise<void> => {
      if (confirming) return;
      confirming = true;
      const requestVersion = options.currentVersion();
      const refreshed = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, roomIdentifier, entryId);
      confirming = false;
      if (!current() || !options.isCurrentRequest(requestVersion)) return;
      // A push that arrived during the read already applied the entry; the
      // read result is older than that push, so it has nothing to add.
      if (options.entries().some((candidate) => candidate.id === entryId)) return;
      if (refreshed.error) {
        reportReadError(refreshed.cause, refreshed.error);
        return;
      }
      if (refreshed.entry) {
        applyEntry(refreshed.entry);
        return;
      }
      reportLost();
    };

    const handle = watch(
      () => [
        options.entries().find((candidate) => candidate.id === entryId) ?? null,
        options.entriesState(),
      ] as const,
      ([entry, state]) => {
        if (!current()) {
          stopWatching();
          return;
        }
        if (state === "error") {
          reportReadError(null, options.entriesError() ?? SUPERVISED_RUNTIME_READ_ERROR);
          return;
        }
        if (entry) {
          // Desired state changes only through requests. While the shell still
          // holds the list from before this watch began, a copy whose desired
          // state disagrees with the held one predates the request whose reply
          // the card already holds; the daemon's next push catches up, and
          // applying the old copy now would flash or clear the card. A later
          // push is always applied, so a stop made elsewhere is adopted.
          const held = options.conflict.value;
          if (options.entries() === listAtStart && held && held.id === entry.id
            && held.desiredState !== entry.desiredState) return;
          applyEntry(entry);
          return;
        }
        // "loading" and "refreshing" mean the shell is still reading; its
        // result arrives through this same watch.
        if (state === "ready") void confirmMissing();
      },
      { immediate: true },
    );
    // The immediate run may already have ended the watch (a ready or stopped
    // entry); dispose the watcher instead of keeping it subscribed.
    if (watchGeneration !== generation) {
      handle();
      return;
    }
    stopWatch = handle;
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
        startWatching(updated.id);
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
          stopWatching();
          options.unsubscribeLaunchEvents();
          return;
        }
        options.onMessage("Stop was accepted. Waiting for the supervised agent to exit.", "warning");
        startWatching(entry.id);
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

  return { startWatching, stopWatching, stopEntry };
}
