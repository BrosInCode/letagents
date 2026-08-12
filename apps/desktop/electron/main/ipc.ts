import electron from "electron";
import type { IpcMain } from "electron";

import { registerDesktopAppIpcHandlers } from "./ipc-handlers/app.js";
import { registerDesktopAuthAndSetupIpcHandlers } from "./ipc-handlers/auth-setup.js";
import { registerDesktopRentalDomainIpcHandlers } from "./ipc-handlers/rental.js";
import { registerDesktopRepoIpcHandlers } from "./ipc-handlers/repos.js";
import { registerDesktopRoomIpcHandlers } from "./ipc-handlers/rooms.js";
import { registerDesktopSupervisorIpcHandlers } from "./ipc-handlers/supervisor.js";
import { registerDesktopWorkerIpcHandlers } from "./ipc-handlers/workers.js";

const { ipcMain } = electron as typeof import("electron");

/**
 * Compose the desktop IPC surface from bounded domain registrars.
 *
 * Handler implementations live with their domain dependencies so this module
 * remains an inventory of native capabilities rather than another application
 * layer.
 */
export function registerDesktopIpcHandlers(
  targetIpcMain: IpcMain = ipcMain,
): void {
  registerDesktopAuthAndSetupIpcHandlers(targetIpcMain);
  registerDesktopAppIpcHandlers(targetIpcMain);
  registerDesktopRoomIpcHandlers(targetIpcMain);
  registerDesktopRentalDomainIpcHandlers(targetIpcMain);
  registerDesktopRepoIpcHandlers(targetIpcMain);
  registerDesktopSupervisorIpcHandlers(targetIpcMain);
  registerDesktopWorkerIpcHandlers(targetIpcMain);
}
