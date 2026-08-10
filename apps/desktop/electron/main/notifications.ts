import electron from "electron";
import { join } from "node:path";

import type {
  DesktopNotificationStatus,
  DesktopNotificationTarget,
} from "../ipc-types.js";
import { apiFetch } from "./auth.js";
import {
  parseDesktopNotificationLaunchInfo,
  parseDesktopNotificationTarget,
} from "./notification-target.js";
import {
  attachNotificationHistoryEntries,
  DesktopNotificationActivationState,
  DesktopNotificationStateStore,
  type PersistedNotificationState,
} from "./notification-state.js";
import { createWindow, emitToMainWindow, focusMainWindow, hasOpenWindows } from "./window.js";

const { app, Notification, pushNotifications } = electron as typeof import("electron");

const DESKTOP_BUNDLE_ID = "chat.letagents.desktop";
const APNS_ENVIRONMENT = "production";
let stateStore: DesktopNotificationStateStore | null = null;
let initializationPromise: Promise<void> | null = null;
const activationState = new DesktopNotificationActivationState();
const restoredNotifications = new Map<string, Electron.Notification>();

function statePath(): string {
  const override = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR?.trim();
  return join(override || app.getPath("userData"), "desktop-notifications.json");
}

function getStateStore(): DesktopNotificationStateStore {
  stateStore ??= new DesktopNotificationStateStore(statePath());
  return stateStore;
}

function isNativeSupported(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

async function readState(): Promise<PersistedNotificationState> {
  return getStateStore().read();
}

async function persistState(): Promise<void> {
  await getStateStore().persist();
}

async function rememberTarget(target: DesktopNotificationTarget): Promise<void> {
  await getStateStore().remember(target);
}

function activateTarget(target: DesktopNotificationTarget): void {
  activationState.markActivated(target);
  if (!hasOpenWindows()) createWindow();
  focusMainWindow();
  emitToMainWindow("desktop:notifications:activated", target);
}

async function attachNotificationHistory(): Promise<void> {
  if (!isNativeSupported()) return;
  const current = await readState();
  const history = await Notification.getHistory();
  attachNotificationHistoryEntries({
    history,
    targets: current.targets,
    restored: restoredNotifications,
    activate: activateTarget,
  });
}

async function upsertDevice(deviceToken: string): Promise<void> {
  const current = await readState();
  await apiFetch("/desktop/push/devices", {
    method: "POST",
    body: JSON.stringify({
      installation_id: current.installationId,
      device_token: deviceToken,
      bundle_id: DESKTOP_BUNDLE_ID,
      environment: APNS_ENVIRONMENT,
      app_version: app.getVersion(),
    }),
  });
}

async function deleteDevice(): Promise<void> {
  const current = await readState();
  await apiFetch(`/desktop/push/devices/${encodeURIComponent(current.installationId)}`, { method: "DELETE" });
}

async function registerNativeDevice(): Promise<void> {
  const current = await readState();
  if (!current.enabled || !isNativeSupported()) return;
  try {
    const token = await pushNotifications.registerForAPNSNotifications();
    current.deviceToken = token;
    current.lastError = null;
    await upsertDevice(token);
  } catch (error) {
    current.lastError = error instanceof Error ? error.message : String(error);
  }
  await persistState();
}

function handleApnsNotification(_event: Electron.Event, userInfo: Record<string, unknown>): void {
  const target = parseDesktopNotificationTarget(userInfo.letagents);
  if (!target) return;
  void rememberTarget(target).then(attachNotificationHistory).catch((error) => {
    console.warn(`[desktop-notifications] Could not persist APNs target: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!app.isReady()) activationState.captureDuringStartup(target);
  setTimeout(() => void attachNotificationHistory().catch(() => undefined), 750).unref();
}

export function prepareDesktopNotifications(): void {
  if (process.platform !== "darwin") return;
  pushNotifications.on("received-apns-notification", handleApnsNotification);
}

export function prepareDesktopNotificationLaunch(launchInfo: unknown): void {
  const target = parseDesktopNotificationLaunchInfo(launchInfo);
  if (!target) return;
  activationState.captureDuringStartup(target);
  void rememberTarget(target).catch((error) => {
    console.warn(`[desktop-notifications] Could not persist launch target: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function initializeDesktopNotifications(): Promise<void> {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    await readState();
    await registerNativeDevice();
    await attachNotificationHistory();
    const startupTarget = activationState.takeStartupTarget();
    if (startupTarget) activateTarget(startupTarget);
  })();
  return initializationPromise;
}

export async function refreshDesktopNotificationRegistration(): Promise<void> {
  await initializeDesktopNotifications();
  await registerNativeDevice();
  emitToMainWindow("desktop:notifications:status-changed", await getDesktopNotificationStatus());
}

export async function unregisterDesktopNotificationAccount(): Promise<void> {
  await initializeDesktopNotifications();
  const current = await readState();
  if (current.deviceToken) await deleteDevice().catch(() => undefined);
  if (process.platform === "darwin") pushNotifications.unregisterForAPNSNotifications();
  current.deviceToken = null;
  await persistState();
}

export async function getDesktopNotificationStatus(): Promise<DesktopNotificationStatus> {
  await initializeDesktopNotifications();
  const current = await readState();
  return {
    enabled: current.enabled,
    nativeSupported: isNativeSupported(),
    nativeRegistered: Boolean(current.enabled && current.deviceToken && !current.lastError),
    lastError: current.lastError,
  };
}

export async function setDesktopNotificationsEnabled(enabled: boolean): Promise<DesktopNotificationStatus> {
  await initializeDesktopNotifications();
  const current = await readState();
  current.enabled = enabled;
  current.lastError = null;
  await persistState();
  if (enabled) {
    await registerNativeDevice();
  } else {
    await deleteDevice().catch(() => undefined);
    if (process.platform === "darwin") pushNotifications.unregisterForAPNSNotifications();
    current.deviceToken = null;
    await persistState();
  }
  return getDesktopNotificationStatus();
}

export function takePendingDesktopNotificationActivation(): DesktopNotificationTarget | null {
  return activationState.takePending();
}
