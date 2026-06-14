export function readSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:sound") !== "off";
  } catch {
    return true;
  }
}

export function readNotificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:notifications") === "on";
  } catch {
    return false;
  }
}

export function readLiquidGlassEnabled(): boolean {
  try {
    return window.localStorage.getItem("letagents-desktop:liquid-glass") !== "off";
  } catch {
    return true;
  }
}

const githubEventsVisibilityStorageKey = "letagents-desktop:github-events-visible";

export function readGitHubEventsVisible(roomIdentifier: string | null | undefined): boolean {
  const key = roomPreferenceKey(roomIdentifier);
  if (!key) return true;
  try {
    const preferences = readBooleanPreferenceMap(githubEventsVisibilityStorageKey);
    const storedValue = preferences[key];
    return typeof storedValue === "boolean" ? storedValue : true;
  } catch {
    return true;
  }
}

export function rememberGitHubEventsVisible(roomIdentifier: string | null | undefined, visible: boolean): void {
  const key = roomPreferenceKey(roomIdentifier);
  if (!key) return;
  try {
    const preferences = readBooleanPreferenceMap(githubEventsVisibilityStorageKey);
    preferences[key] = visible;
    window.localStorage.setItem(githubEventsVisibilityStorageKey, JSON.stringify(preferences));
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
