import electron from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { emitToMainWindow, focusMainWindow } from "./window.js";
import { desktopUpdater } from "./updates.js";

const { app, Menu, shell } = electron as typeof import("electron");

function openSettings(): void {
  focusMainWindow();
  emitToMainWindow("desktop:ui:open-settings", null);
}

function openUpdates(): void {
  focusMainWindow();
  emitToMainWindow("desktop:ui:open-updates", null);
  void desktopUpdater.check();
}

function buildAppMenu(): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings...",
        accelerator: "CommandOrControl+,",
        click: openSettings,
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

function buildFileMenu(): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      {
        label: "Settings...",
        accelerator: "CommandOrControl+,",
        click: openSettings,
      },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

export function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [buildAppMenu()] : [buildFileMenu()]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: openUpdates,
        },
        { type: "separator" },
        {
          label: "LetAgents",
          click: () => {
            void shell.openExternal("https://letagents.chat");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
