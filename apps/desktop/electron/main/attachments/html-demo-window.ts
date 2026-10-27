import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow, Session } from "electron";
import { randomUUID } from "node:crypto";

import { htmlDemoProtocolScheme } from "../paths.js";
import {
  assertHtmlDemoAttachmentHref,
  HTML_DEMO_PARTITION,
  HTML_DEMO_RESPONSE_HEADERS,
  htmlDemoWindowTitle,
  isAllowedHtmlDemoRequest,
  MAX_OPEN_HTML_DEMOS,
  readHtmlDemoBytes,
} from "./html-demo-policy.js";
import { attachmentResponse } from "./protocol.js";

const { BrowserWindow, session } = electron as typeof import("electron");

/** A page that never paints still gets a window the person can see and close. */
const SHOW_DEMO_WINDOW_AFTER_MS = 1500;

/** Demo documents by window host; a host exists only while its window is open. */
const demoDocuments = new Map<string, string>();
const demoWindowsByHref = new Map<string, ElectronBrowserWindow>();
const pendingHrefs = new Set<string>();
let demoSession: Promise<Session> | null = null;

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
    const response = await attachmentResponse(href);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The demo file could not be loaded (HTTP ${response.status}).`);
    }
    const html = new TextDecoder("utf-8").decode(await readHtmlDemoBytes(response));
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
 * prefetch, WebRTC); Electron has no per-window switch for those.
 */
export async function openHtmlDemoWindow(input: { html: string; title: string }): Promise<ElectronBrowserWindow> {
  const host = randomUUID().replaceAll("-", "");
  const origin = `${htmlDemoProtocolScheme}://${host}`;
  const ses = await htmlDemoSession();
  demoDocuments.set(host, input.html);

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
      safeDialogs: true,
      autoplayPolicy: "user-gesture-required",
    },
  });
  const contents = demoWindow.webContents;
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // A demo cannot keep its window open with a beforeunload prompt.
  contents.on("will-prevent-unload", (event) => event.preventDefault());
  // A demo cannot move or resize its window to cover the app or hide off-screen.
  contents.on("content-bounds-updated", (event) => event.preventDefault());
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
    demoDocuments.delete(host);
    void ses.clearStorageData({ origin }).catch(() => undefined);
  });

  void demoWindow.loadURL(`${origin}/`).catch(() => undefined);
  return demoWindow;
}

function htmlDemoSession(): Promise<Session> {
  demoSession ??= prepareHtmlDemoSession();
  return demoSession;
}

async function prepareHtmlDemoSession(): Promise<Session> {
  const ses = session.fromPartition(HTML_DEMO_PARTITION);
  ses.protocol.handle(htmlDemoProtocolScheme, (request) => {
    const url = new URL(request.url);
    const html = url.pathname === "/" ? demoDocuments.get(url.hostname) : undefined;
    return html === undefined
      ? new Response("This demo is closed.", { status: 404, headers: HTML_DEMO_RESPONSE_HEADERS })
      : new Response(html, { headers: HTML_DEMO_RESPONSE_HEADERS });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedHtmlDemoRequest(details.url) });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // Connections that skip the request filter (WebRTC over TCP, preconnect) meet a
  // closed port. Set before the first demo loads.
  await ses.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" }).catch(() => undefined);
  return ses;
}
