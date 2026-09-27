import electron, { type IpcMain } from "electron";
import { supervisorDaemonClient } from "../supervisor-daemon.js";
import { performConfirmedMaintenance } from "../force-daemon-restart.js";
import { assertHostApprovalSender } from "../window.js";

const { app, dialog, BrowserWindow } = electron as typeof import("electron");
let operation: Promise<void> | null = null;

export function registerDaemonMaintenanceIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle("desktop:maintenance:status", async event => {
    assertHostApprovalSender(event);
    return supervisorDaemonClient.getMaintenanceStatus();
  });
  targetIpcMain.handle("desktop:maintenance:restart", (event, resume: unknown) => {
    assertHostApprovalSender(event);
    if (typeof resume !== "boolean") throw new Error("Invalid maintenance action.");
    if (process.platform !== "darwin") throw new Error("Service restart currently requires macOS.");
    if (operation) return operation;
    operation = performConfirmedMaintenance({
      assertTrusted: () => assertHostApprovalSender(event),
      confirm: async resume => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        if (!parent) throw new Error("The desktop window is unavailable.");
        const result = await dialog.showMessageBox(parent, {
          type: "warning", title: resume ? "Resume agent supervision?" : "Force restart background service?",
          message: resume ? "Restart LetAgents and resume supervision" : "Restart LetAgents and its background service",
          detail: resume
            ? "Saved agent settings will apply again. LetAgents will use its normal recovery checks; uncertain operations are not marked successful by this action."
            : "Saved files and conversations are kept. Current responses may be interrupted, and detached provider processes or commands may keep running. Supervision stays paused after restart until you resume it in Settings. Rental deadlines keep running; local cleanup may wait for resume.",
          buttons: ["Cancel", resume ? "Resume supervision" : "Force restart"],
          defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 1;
      },
      stop: resume => supervisorDaemonClient.stopForMaintenance(resume),
      relaunch: () => {
        // End this Electron generation too: old rental/grant callbacks cannot
        // survive into the new daemon's supervision lifetime.
        app.relaunch();
        app.exit(0);
      },
    }, resume).finally(() => { operation = null; });
    return operation;
  });
}
