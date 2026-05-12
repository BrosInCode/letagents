import { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { devServerUrl, electronMainDir, rendererDistPath } from "./paths.js";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function hasOpenWindows(): boolean {
  return BrowserWindow.getAllWindows().length > 0;
}

export function focusMainWindow(): void {
  mainWindow?.show();
  mainWindow?.focus();
}

export function emitToMainWindow(channel: string, payload: unknown): void {
  if (mainWindow?.isDestroyed()) return;
  mainWindow?.webContents.send(channel, payload);
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "LetAgents Desktop",
    backgroundColor: "#0a0d14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(electronMainDir, "preload.js"),
    },
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (!existsSync(rendererDistPath)) {
    throw new Error(`Renderer build not found at ${rendererDistPath}`);
  }

  void mainWindow.loadFile(rendererDistPath);
}
