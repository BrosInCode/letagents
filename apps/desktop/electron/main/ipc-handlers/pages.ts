import electron from "electron";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { DesktopPageConfirmMessage } from "../../ipc-types.js";
import { readStoredAuth } from "../auth.js";
import { openExternalWebUrl } from "../external-url.js";
import {
  createHttpPageApiAdapter,
  createHttpRoomPageSource,
  pageApiMethodNames,
  type PageApiAdapter,
  type RoomPageSource,
} from "../pages/page-adapter.js";
import { createPageCallHandler } from "../pages/page-bridge.js";
import { createFilePageChoiceStore, createPageConfirmBroker, type PageChoiceStore } from "../pages/page-confirm.js";
import { recordPageDiagnostic } from "../pages/page-diagnostics.js";
import { roomPageGrants } from "../pages/page-grants.js";
import {
  configureRoomPages,
  currentRoomPageTheme,
  listRoomPages,
  prepareRoomPage,
  releaseRoomPage,
  roomPageLeaseForSender,
  setRoomPageTheme,
  setRoomPageVisible,
} from "../pages/page-host.js";
import { PAGE_CALL_CHANNEL } from "../pages/page-policy.js";
import { getMainWindow } from "../window.js";

const { clipboard } = electron as typeof import("electron");

/** Main asks the app window to show or take down a page's confirm sheet. */
export const PAGE_CONFIRM_CHANNEL = "desktop:pages:confirm";

/**
 * Room pages: the app window lists, opens and closes them and answers their
 * confirm sheets; the pages themselves reach main only through `page:call`.
 * The server side is one adapter and one page source; tests pass their own.
 */
export function registerDesktopPageIpcHandlers(
  targetIpcMain: IpcMain,
  backend: { adapter?: PageApiAdapter; source?: RoomPageSource; choices?: PageChoiceStore; methods?: ReadonlySet<string> } = {},
): void {
  const send = (message: DesktopPageConfirmMessage): boolean => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(PAGE_CONFIRM_CHANNEL, message);
    return true;
  };
  const confirm = createPageConfirmBroker({
    show: (request) => send({ type: "ask", request }),
    dismiss: (id) => { send({ type: "dismiss", id }); },
    choices: backend.choices ?? createFilePageChoiceStore(),
  });
  const source = backend.source ?? createHttpRoomPageSource();
  // Each lease mints its own page_grant with the app session; page calls carry only that token.
  roomPageGrants.configure((roomId, pageId) => source.grant(roomId, pageId));
  configureRoomPages({
    source,
    grants: roomPageGrants,
    onLeaseEnd: (lease) => confirm.declineFor(lease),
    onLeaseHidden: (lease) => confirm.declineFor(lease),
  });
  const handlePageCall = createPageCallHandler({
    leaseFor: roomPageLeaseForSender,
    adapter: backend.adapter ?? createHttpPageApiAdapter({ grants: roomPageGrants }),
    methods: backend.methods ?? pageApiMethodNames(),
    confirm,
    viewer: async () => {
      const account = (await readStoredAuth()).account;
      return account ? { id: account.id, login: account.login, displayName: account.displayName } : null;
    },
    theme: currentRoomPageTheme,
    openExternal: openExternalWebUrl,
    writeClipboard: (text) => clipboard.writeText(text),
    record: recordPageDiagnostic,
  });

  // The page bridge: only a live page lease's own frame gets an answer other than not_granted.
  targetIpcMain.handle(PAGE_CALL_CHANNEL, (event, payload: unknown) => handlePageCall(event, payload));
  targetIpcMain.handle("desktop:pages:list", (event, roomId: unknown) => {
    assertAppWindowSender(event);
    return listRoomPages(roomId);
  });
  targetIpcMain.handle("desktop:pages:prepare", (event, roomId: unknown, pageId: unknown) => {
    assertAppWindowSender(event);
    return prepareRoomPage(roomId, pageId);
  });
  targetIpcMain.handle("desktop:pages:release", (event, url: unknown) => {
    assertAppWindowSender(event);
    releaseRoomPage(url);
  });
  targetIpcMain.handle("desktop:pages:set-visible", (event, url: unknown, visible: unknown) => {
    assertAppWindowSender(event);
    setRoomPageVisible(url, visible);
  });
  targetIpcMain.handle("desktop:pages:set-theme", (event, mode: unknown) => {
    assertAppWindowSender(event);
    setRoomPageTheme(mode);
  });
  targetIpcMain.handle("desktop:pages:answer-confirm", (event, id: unknown, answer: unknown, remember: unknown) => {
    // A page cannot answer its own sheet: only the app window's main frame can.
    assertAppWindowSender(event);
    confirm.answer(id, answer, remember);
  });
}

function assertAppWindowSender(event: IpcMainInvokeEvent): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Room pages open only from the main window.");
  }
}
