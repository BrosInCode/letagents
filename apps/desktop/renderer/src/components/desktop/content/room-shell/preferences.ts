import { ref } from "vue";

export function readSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:sound") !== "off";
  } catch {
    return true;
  }
}

export const notificationsPreferenceRevision = ref(0);

export function readNotificationsEnabled(): boolean {
  void notificationsPreferenceRevision.value;
  try {
    return window.localStorage.getItem("letagents-desktop:notifications") === "on";
  } catch {
    return false;
  }
}

export function writeNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem("letagents-desktop:notifications", enabled ? "on" : "off");
  } catch {
    // Local preference persistence is best-effort.
  }
  notificationsPreferenceRevision.value += 1;
}

// Unread counts must be recomputed when chat visibility changes.
export const githubEventsVisibilityRevision = ref(0);

const githubEventsVisibilityStorageKey = "letagents-desktop:github-events-inline-visible";

export function readGitHubEventsVisible(roomIdentifier: string | null | undefined): boolean {
  const key = roomPreferenceKey(roomIdentifier);
  if (!key) return false;
  try {
    const preferences = readBooleanPreferenceMap(githubEventsVisibilityStorageKey);
    const storedValue = preferences[key];
    return typeof storedValue === "boolean" ? storedValue : false;
  } catch {
    return false;
  }
}

export function rememberGitHubEventsVisible(roomIdentifier: string | null | undefined, visible: boolean): void {
  const key = roomPreferenceKey(roomIdentifier);
  if (!key) return;
  try {
    const preferences = readBooleanPreferenceMap(githubEventsVisibilityStorageKey);
    preferences[key] = visible;
    window.localStorage.setItem(githubEventsVisibilityStorageKey, JSON.stringify(preferences));
    githubEventsVisibilityRevision.value += 1;
  } catch {
    // Local preference persistence is best-effort.
  }
}

export function readNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function roomPreferenceKey(roomIdentifier: string | null | undefined): string | null {
  const key = roomIdentifier?.trim().toLowerCase();
  return key || null;
}

function readBooleanPreferenceMap(storageKey: string): Record<string, boolean> {
  const rawValue = window.localStorage.getItem(storageKey);
  if (!rawValue) return {};
  const parsedValue: unknown = JSON.parse(rawValue);
  if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) return {};
  const preferences: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsedValue)) {
    if (typeof value === "boolean") preferences[key] = value;
  }
  return preferences;
}
