import electron from "electron";
import electronUpdaterModule, { type ProgressInfo, type UpdateInfo } from "electron-updater";

import type { DesktopUpdateStatus } from "../ipc-types.js";
import {
  DesktopUpdaterController,
  desktopUpdateFeedBaseUrl,
  runDesktopUpdateCheck,
} from "./desktop-updater.js";
import { supervisorDaemonClient } from "./supervisor-daemon.js";
import { supervisorGrantCoordinator } from "./supervisor-grant-coordinator.js";
import { emitToMainWindow, focusMainWindow } from "./window.js";

const electronRuntime = electron as Partial<typeof import("electron")>;
const { app, Notification } = electronRuntime;
const updateIntervalMs = 6 * 60 * 60 * 1000;

let initialized = false;
let scheduledUpdateCheck: NodeJS.Timeout | null = null;
let notifiedReleaseName: string | null = null;

function desktopAutoUpdater() {
  return electronUpdaterModule.autoUpdater;
}

function updatesSupported(): boolean {
  return process.platform === "darwin"
    && app?.isPackaged === true
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

function updateBaseUrl(): string {
  const configuredBaseUrl = process.env.LETAGENTS_DESKTOP_UPDATE_BASE_URL?.trim();
  const baseUrl = configuredBaseUrl || desktopUpdateFeedBaseUrl(process.arch);
  if (!baseUrl) throw new Error(`No desktop update feed is configured for the ${process.arch} architecture.`);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("The desktop update feed must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("The desktop update feed must use HTTPS.");
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function releaseNotes(info: UpdateInfo): string | null {
  if (typeof info.releaseNotes === "string") return info.releaseNotes.trim() || null;
  if (Array.isArray(info.releaseNotes)) {
    const notes = info.releaseNotes.map((entry) => entry.note?.trim()).filter(Boolean);
    return notes.length > 0 ? notes.join("\n\n") : null;
  }
  return null;
}

function updateSize(info: UpdateInfo): number | null {
  const zip = info.files.find((file) => file.url.endsWith(".zip")) || info.files[0];
  return Number.isFinite(zip?.size) && Number(zip.size) > 0 ? Number(zip.size) : null;
}

export const desktopUpdater = new DesktopUpdaterController({
  currentVersion: app?.getVersion?.() || process.env.npm_package_version || "0.0.0",
  supported: updatesSupported(),
  unsupportedReason: unsupportedReason(),
  checkForUpdates: () => runDesktopUpdateCheck(() => desktopAutoUpdater().checkForUpdates()),
  prepareForInstall: () => supervisorDaemonClient.prepareForApplicationUpdate(),
  recoverAfterInstallFailure: async () => {
    await supervisorDaemonClient.resumeAfterApplicationUpdateFailure();
    await supervisorGrantCoordinator.reconcileDesiredRunning();
  },
  quitAndInstall: () => desktopAutoUpdater().quitAndInstall(false, true),
  publish: publishStatus,
});

export function initializeDesktopUpdates(): void {
  if (initialized) return;
  initialized = true;
  if (!updatesSupported()) return;

  const electronUpdater = desktopAutoUpdater();
  electronUpdater.autoDownload = true;
  electronUpdater.autoInstallOnAppQuit = false;
  electronUpdater.autoRunAppAfterInstall = true;
  electronUpdater.allowDowngrade = false;
  electronUpdater.allowPrerelease = false;
  electronUpdater.logger = {
    debug: (...values: unknown[]) => console.debug("[desktop-updater]", ...values),
    info: (...values: unknown[]) => console.info("[desktop-updater]", ...values),
    warn: (...values: unknown[]) => console.warn("[desktop-updater]", ...values),
    error: (...values: unknown[]) => console.error("[desktop-updater]", ...values),
  };

  try {
    electronUpdater.setFeedURL({ provider: "generic", url: updateBaseUrl() });
  } catch (error) {
    void desktopUpdater.fail(error);
    return;
  }

  electronUpdater.on("checking-for-update", () => desktopUpdater.markChecking());
  electronUpdater.on("update-available", (info) => desktopUpdater.markAvailable({
    version: info.version,
    releaseName: info.releaseName || `LetAgents ${info.version}`,
    releaseNotes: releaseNotes(info),
    total: updateSize(info),
  }));
  electronUpdater.on("download-progress", (progress: ProgressInfo) => {
    desktopUpdater.markDownloadProgress({
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  electronUpdater.on("update-not-available", () => desktopUpdater.markUpToDate());
  electronUpdater.on("error", (error) => {
    // MacUpdater performs native Squirrel staging after quitAndInstall returns.
    // A late error must restore daemon supervision after the completed handoff.
    void desktopUpdater.fail(error);
  });
  electronUpdater.on("update-downloaded", (info) => desktopUpdater.markDownloaded({
    releaseName: info.releaseName || `LetAgents ${info.version}`,
    releaseNotes: releaseNotes(info),
  }));

  void desktopUpdater.check();
  scheduledUpdateCheck = setInterval(() => {
    void desktopUpdater.check();
  }, updateIntervalMs);
  scheduledUpdateCheck.unref();
}

export function stopDesktopUpdates(): void {
  if (scheduledUpdateCheck) clearInterval(scheduledUpdateCheck);
  scheduledUpdateCheck = null;
}

export function assertDesktopUpdateMutationAllowed(): void {
  if (desktopUpdater.isInstalling()) {
    throw new Error("LetAgents is preparing a downloaded update. Wait for the app to restart before changing agent state.");
  }
}
