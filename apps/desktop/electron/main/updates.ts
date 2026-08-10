import electron from "electron";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";

import type { DesktopUpdateStatus } from "../ipc-types.js";
import { DesktopUpdaterController, desktopUpdateFeedBaseUrl } from "./desktop-updater.js";
import { supervisorDaemonClient } from "./supervisor-daemon.js";
import { supervisorGrantCoordinator } from "./supervisor-grant-coordinator.js";
import { emitToMainWindow, focusMainWindow } from "./window.js";

const electronRuntime = electron as Partial<typeof import("electron")>;
const { app, autoUpdater, Notification } = electronRuntime;
const updateInterval = "6 hours";

let initialized = false;
let stopScheduledUpdates: (() => void) | null = null;
let notifiedReleaseName: string | null = null;

function updatesSupported(): boolean {
  return process.platform === "darwin"
    && app?.isPackaged === true
    && Boolean(autoUpdater)
    && Boolean(desktopUpdateFeedBaseUrl(process.arch));
}

function unsupportedReason(): string | null {
  if (process.platform !== "darwin") return "Automatic updates currently require macOS.";
  if (app?.isPackaged !== true) return "Automatic updates run only in signed production builds.";
  if (!desktopUpdateFeedBaseUrl(process.arch)) {
    return `Automatic updates do not have a release feed for the ${process.arch} architecture.`;
  }
  return null;
}

function publishStatus(status: DesktopUpdateStatus): void {
  emitToMainWindow("desktop:updates:status-changed", status);
  if (status.phase !== "ready") return;
  const releaseKey = status.releaseName || status.availableVersion || "downloaded";
  if (releaseKey === notifiedReleaseName || !Notification?.isSupported()) return;
  notifiedReleaseName = releaseKey;
  const notification = new Notification({
    title: "LetAgents update ready",
    body: `${status.releaseName || "A new version"} is downloaded. Restart when you are ready.`,
  });
  notification.on("click", () => {
    focusMainWindow();
    emitToMainWindow("desktop:ui:open-updates", null);
  });
  notification.show();
}

export const desktopUpdater = new DesktopUpdaterController({
  currentVersion: app?.getVersion?.() || process.env.npm_package_version || "0.0.0",
  supported: updatesSupported(),
  unsupportedReason: unsupportedReason(),
  checkForUpdates: () => {
    if (!autoUpdater) throw new Error("Electron autoUpdater is unavailable.");
    return autoUpdater.checkForUpdates();
  },
  prepareForInstall: () => supervisorDaemonClient.prepareForApplicationUpdate(),
  recoverAfterInstallFailure: async () => {
    await supervisorDaemonClient.resumeAfterApplicationUpdateFailure();
    await supervisorGrantCoordinator.reconcileDesiredRunning();
  },
  quitAndInstall: () => {
    if (!autoUpdater) throw new Error("Electron autoUpdater is unavailable.");
    autoUpdater.quitAndInstall();
  },
  publish: publishStatus,
});

function updateBaseUrl(): string {
  const configuredBaseUrl = process.env.LETAGENTS_DESKTOP_UPDATE_BASE_URL?.trim();
  const baseUrl = configuredBaseUrl || desktopUpdateFeedBaseUrl(process.arch);
  if (!baseUrl) throw new Error(`No desktop update feed is configured for the ${process.arch} architecture.`);
  return baseUrl.replace(/\/+$/, "");
}

export function initializeDesktopUpdates(): void {
  if (initialized) return;
  initialized = true;
  if (!updatesSupported()) return;
  if (!autoUpdater) return;

  autoUpdater.on("checking-for-update", () => desktopUpdater.markChecking());
  autoUpdater.on("update-available", () => desktopUpdater.markAvailable());
  autoUpdater.on("update-not-available", () => desktopUpdater.markUpToDate());
  autoUpdater.on("error", (error) => desktopUpdater.fail(error));
  autoUpdater.on(
    "update-downloaded",
    (_event, releaseNotes, releaseName) => desktopUpdater.markDownloaded({ releaseName, releaseNotes }),
  );

  try {
    const scheduled = updateElectronApp({
      updateSource: {
        type: UpdateSourceType.StaticStorage,
        baseUrl: updateBaseUrl(),
      },
      updateInterval,
      notifyUser: false,
      logger: {
        log: (...values: unknown[]) => console.log("[desktop-updater]", ...values),
        info: (...values: unknown[]) => console.info("[desktop-updater]", ...values),
        warn: (...values: unknown[]) => console.warn("[desktop-updater]", ...values),
        error: (...values: unknown[]) => console.error("[desktop-updater]", ...values),
      },
    });
    stopScheduledUpdates = scheduled.stopUpdates;
  } catch (error) {
    desktopUpdater.fail(error);
  }
}

export function stopDesktopUpdates(): void {
  stopScheduledUpdates?.();
  stopScheduledUpdates = null;
}

export function assertDesktopUpdateMutationAllowed(): void {
  if (desktopUpdater.isInstalling()) {
    throw new Error("LetAgents is preparing a downloaded update. Wait for the app to restart before changing agent state.");
  }
}
