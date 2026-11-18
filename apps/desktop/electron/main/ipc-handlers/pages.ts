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
import { contextOf, createPageCallHandler } from "../pages/page-bridge.js";
import { createPageWatches } from "../pages/page-watch.js";
import { createRoomPageAdmin, type RoomPageAdmin } from "../pages/page-admin.js";
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
  sendToRoomPage,
  setRoomPageTheme,
  type RoomPageLease,
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
  backend: { adapter?: PageApiAdapter; source?: RoomPageSource; choices?: PageChoiceStore; methods?: ReadonlySet<string>; admin?: RoomPageAdmin } = {},
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
  const adapter = backend.adapter ?? createHttpPageApiAdapter({ grants: roomPageGrants });
  const methods = backend.methods ?? pageApiMethodNames();
  const watches = createPageWatches<RoomPageLease>({
    run: (lease, method, input) => adapter.call(contextOf(lease), method, input),
    push: (lease, message) => { sendToRoomPage(lease, message); },
    methods,
  });
  configureRoomPages({
    source,
    grants: roomPageGrants,
    onLeaseEnd: (lease) => {
      confirm.declineFor(lease);
      watches.stopAll(lease);
    },
    onLeaseHidden: (lease) => confirm.declineFor(lease),
    onLeasePointer: (lease, resource) => watches.notify(lease, resource),
  });
  const handlePageCall = createPageCallHandler({
    leaseFor: roomPageLeaseForSender,
    adapter,
    methods,
    watches,
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
  // The registry, with the person's own app session: what the tab, the grant sheet and the banner show and do.
  const admin = backend.admin ?? createRoomPageAdmin();
  // Approve, roll back and pin end the page's open grants on the server; open pages mint new ones.
  const changed = <T>(pageId: unknown, result: Promise<T>) => result.then((value) => {
    if (typeof pageId === "string") roomPageGrants.invalidatePage(pageId);
    return value;
  });
  targetIpcMain.handle("desktop:pages:info", (event, roomId: unknown, pageId: unknown) => {
    assertAppWindowSender(event);
    return admin.info(roomId, pageId);
  });
  targetIpcMain.handle("desktop:pages:create-from-attachment", (event, roomId: unknown, messageId: unknown, attachmentId: unknown) => {
    assertAppWindowSender(event);
    return admin.createFromAttachment(roomId, messageId, attachmentId);
  });
  targetIpcMain.handle("desktop:pages:approve", (event, roomId: unknown, pageId: unknown, version: unknown, capabilities: unknown) => {
    assertAppWindowSender(event);
    return changed(pageId, admin.approve(roomId, pageId, version, capabilities));
  });
  targetIpcMain.handle("desktop:pages:pin", (event, roomId: unknown, pageId: unknown) => {
    assertAppWindowSender(event);
    return changed(pageId, admin.pin(roomId, pageId));
  });
  targetIpcMain.handle("desktop:pages:set-current", (event, roomId: unknown, pageId: unknown, version: unknown) => {
    assertAppWindowSender(event);
    return changed(pageId, admin.setCurrent(roomId, pageId, version));
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
