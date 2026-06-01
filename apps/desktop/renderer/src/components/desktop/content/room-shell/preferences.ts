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
    return window.localStorage.getItem("letagents-desktop:liquid-glass") === "on";
  } catch {
    return false;
  }
}

export function readNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}
