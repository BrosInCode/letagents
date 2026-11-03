import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { randomUUID } from "node:crypto";

import { htmlDemoProtocolScheme } from "../paths.js";
import { assertHtmlDemoAttachmentHref, htmlDemoWindowTitle, MAX_OPEN_HTML_DEMOS } from "./html-demo-policy.js";
import {
  htmlDemoContentsIds,
  htmlDemoDocuments,
  htmlDemoSession,
  loadHtmlDemoAttachment,
  lockHtmlDemoContents,
} from "./html-demo-session.js";

const { BrowserWindow } = electron as typeof import("electron");

/** A page that never paints still gets a window the person can see and close. */
const SHOW_DEMO_WINDOW_AFTER_MS = 1500;

const demoWindowsByHref = new Map<string, ElectronBrowserWindow>();
const pendingHrefs = new Set<string>();

/** Open a room attachment as an HTML demo, or focus the window that already shows it. */
export async function openHtmlDemo(input: {
  href: unknown;
  fileName: unknown;
  senderLabel?: unknown;
}): Promise<void> {
  const href = assertHtmlDemoAttachmentHref(input.href);
  const existing = demoWindowsByHref.get(href);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  if (pendingHrefs.has(href)) return;
  if (demoWindowsByHref.size + pendingHrefs.size >= MAX_OPEN_HTML_DEMOS) {
    throw new Error(`Close a demo window first. At most ${MAX_OPEN_HTML_DEMOS} demos can be open at once.`);
  }
  pendingHrefs.add(href);
  try {
    const { html } = await loadHtmlDemoAttachment(href);
    const demoWindow = await openHtmlDemoWindow({ html, title: htmlDemoWindowTitle(input.fileName, input.senderLabel) });
    demoWindowsByHref.set(href, demoWindow);
    demoWindow.once("closed", () => demoWindowsByHref.delete(href));
  } finally {
    pendingHrefs.delete(href);
  }
}

/**
 * Show an HTML document in a locked window: its own origin, no preload, and
 * nothing loads over the network. The page can still cause DNS lookups (DNS
 * prefetch, WebRTC) and read a file the person drops or picks in it; Electron
 * has no per-window switch for those.
 */
export async function openHtmlDemoWindow(input: { html: string; title: string }): Promise<ElectronBrowserWindow> {
  const host = randomUUID().replaceAll("-", "");
  const origin = `${htmlDemoProtocolScheme}://${host}`;
  const ses = await htmlDemoSession();
  htmlDemoDocuments.set(host, input.html);

  const demoWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 320,
    title: input.title,
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // alert() and confirm() would show the page's text in a native app dialog.
      disableDialogs: true,
      autoplayPolicy: "user-gesture-required",
    },
  });
  const contents = demoWindow.webContents;
  const contentsId = contents.id;
  htmlDemoContentsIds.add(contentsId);
  lockHtmlDemoContents(contents);
  // The title bar is the one line the demo cannot draw, so it keeps saying what this is.
  demoWindow.on("page-title-updated", (event) => event.preventDefault());
  // A page that hangs its renderer cannot hold the window (or a demo slot) open.
  demoWindow.on("unresponsive", () => {
    if (!demoWindow.isDestroyed()) demoWindow.destroy();
  });
  const showTimer = setTimeout(() => {
    if (!demoWindow.isDestroyed() && !demoWindow.isVisible()) demoWindow.show();
  }, SHOW_DEMO_WINDOW_AFTER_MS);
  demoWindow.once("ready-to-show", () => {
    clearTimeout(showTimer);
    demoWindow.show();
  });
  demoWindow.once("closed", () => {
    clearTimeout(showTimer);
    htmlDemoDocuments.delete(host);
    htmlDemoContentsIds.delete(contentsId);
    void ses.clearStorageData({ origin }).catch(() => undefined);
  });

  void demoWindow.loadURL(`${origin}/`).catch(() => undefined);
  return demoWindow;
}
