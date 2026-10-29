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

export interface ApplicationMenuActions {
  openSettings: () => void;
  openUpdates: () => void;
  openWebsite: () => void;
}

function buildAppMenu(actions: ApplicationMenuActions): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings...",
        accelerator: "CommandOrControl+,",
        click: actions.openSettings,
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

function buildFileMenu(actions: ApplicationMenuActions): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      {
        label: "Settings...",
        accelerator: "CommandOrControl+,",
        click: actions.openSettings,
      },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

/**
 * macOS gets the app menu and its window roles. Windows and Linux get the
 * standard File/Edit/View/Window/Help bar; roles carry Ctrl shortcuts there,
 * and "zoom" is left out because it acts only on macOS.
 */
export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [buildAppMenu(actions)] : [buildFileMenu(actions)]),
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
      submenu: platform === "darwin"
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ]
        : [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: actions.openUpdates,
        },
        { type: "separator" },
        {
          label: "LetAgents",
          click: actions.openWebsite,
        },
      ],
    },
  ];
}

export function configureApplicationMenu(platform: NodeJS.Platform = process.platform): void {
  const template = buildApplicationMenuTemplate(platform, {
    openSettings,
    openUpdates,
    openWebsite: () => {
      void shell.openExternal("https://letagents.chat");
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
