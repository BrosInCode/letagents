import type { App, Notification as ElectronNotification, NotificationConstructorOptions } from "electron";

/**
 * Windows ties toast notifications, taskbar grouping and the Start menu entry
 * to this ID. The installer (electron/installer/windows/installer.nsi,
 * APP_ID) writes the same ID on the Start menu and desktop shortcuts it
 * creates; Windows shows a desktop app's toasts only when the process ID
 * matches a Start menu shortcut's. It is also the macOS bundle identifier.
 */
export const WINDOWS_APP_USER_MODEL_ID = "chat.letagents.desktop";

/**
 * Sets the process's AppUserModelID on Windows, before any window or
 * notification exists. An unpackaged development run has no shortcut with
 * the release ID, so it uses its own executable path, as Electron documents
 * for development builds. Returns the ID it set, or null off Windows.
 */
export function applyWindowsAppUserModelId(
  app: Pick<App, "isPackaged" | "setAppUserModelId">,
  platform: NodeJS.Platform = process.platform,
  executablePath: string = process.execPath,
): string | null {
  if (platform !== "win32") return null;
  const id = app.isPackaged ? WINDOWS_APP_USER_MODEL_ID : executablePath;
  app.setAppUserModelId(id);
  return id;
}

type SmokeNotificationOutcome = "shown" | "failed" | "timeout";
let smokeNotification: Promise<SmokeNotificationOutcome> | null = null;

/**
 * Smoke check on Windows only (LETAGENTS_DESKTOP_SMOKE_CHECK=1): shows one
 * toast. Electron is loaded here, not imported at the top, so this module
 * loads anywhere without it.
 */
export function startWindowsSmokeNotification(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SmokeNotificationOutcome> | null {
  if (platform !== "win32" || env.LETAGENTS_DESKTOP_SMOKE_CHECK !== "1") return null;
  smokeNotification ??= import("electron").then(({ Notification }) => showWindowsSmokeNotification(Notification));
  return smokeNotification;
}

/** The smoke check waits for the toast's outcome before it exits, at most the toast's own timeout. */
export function windowsSmokeNotificationSettled(): Promise<unknown> {
  return smokeNotification ?? Promise.resolve();
}

/**
 * Shows one toast and logs whether Windows accepted it ("shown" is
 * ToastNotifier.Show succeeding). It does not prove that Windows displayed
 * it: the shortcut's AppUserModelID, which the install smoke test reads back,
 * is what makes Windows display it. Resolves with the outcome; never throws.
 */
export function showWindowsSmokeNotification(
  NotificationClass: new (options: NotificationConstructorOptions) => ElectronNotification,
  log: (message: string) => void = (message) => console.log(message),
  timeoutMs = 10_000,
): Promise<SmokeNotificationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SmokeNotificationOutcome, detail = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`LETAGENTS_DESKTOP_SMOKE_NOTIFICATION ${outcome}${detail ? ` ${detail}` : ""}`);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      const notification = new NotificationClass({ title: "LetAgents", body: "Desktop smoke check notification.", silent: true });
      notification.once("show", () => finish("shown"));
      notification.once("failed", (_event, error) => finish("failed", String(error)));
      notification.show();
    } catch (error) {
      finish("failed", error instanceof Error ? error.message : String(error));
    }
  });
}
