import electron from "electron";
import type { Session, WebContents } from "electron";
import { join } from "node:path";

import type { DesktopDemoSettings } from "../../ipc-types.js";

import { htmlDemoProtocolScheme } from "../paths.js";
import {
  HTML_DEMO_DEAD_PROXY,
  HTML_DEMO_PARTITION,
  htmlDemoProxyBypassRules,
  htmlDemoResponseHeaders,
  isAllowedHtmlDemoRequest,
  MAX_HTML_DEMO_BYTES,
  readHtmlDemoBytes,
} from "./html-demo-policy.js";
import { desktopDemoSettings, HtmlDemoSettingsStore } from "./html-demo-settings.js";
import { attachmentResponse } from "./protocol.js";

const { app, session } = electron as typeof import("electron");

/**
 * Demo documents by host, for demo windows and demos inside messages alike. A
 * host exists only while its window is open or its inline demo is live.
 */
export const htmlDemoDocuments = new Map<string, string>();
/** The demo pages' own web contents and the host each one shows; DevTools opened on a demo is not one of them. */
export const htmlDemoContents = new Map<number, string>();
let demoSession: Promise<Session> | null = null;
let demoSettings: HtmlDemoSettingsStore | null = null;

function htmlDemoSettings(): HtmlDemoSettingsStore {
  const override = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR?.trim();
  demoSettings ??= new HtmlDemoSettingsStore(join(override || app.getPath("userData"), "demo-settings.json"));
  return demoSettings;
}

export async function getDesktopDemoSettings(): Promise<DesktopDemoSettings> {
  return desktopDemoSettings(await htmlDemoSettings().read());
}

/**
 * Save whether demos may load from the CDNs. The request filter reads the new
 * value at once, so a running demo's next CDN request follows it; the proxy
 * follows here; a demo's CSP follows when the demo next opens. A save that
 * fails changes nothing and throws.
 */
export async function setDesktopDemoCdnLibraries(enabled: unknown): Promise<DesktopDemoSettings> {
  if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
  try {
    return desktopDemoSettings(await htmlDemoSettings().setCdnLibraries(enabled));
  } finally {
    // The proxy always follows the saved value, after a failed save too.
    await applyHtmlDemoProxy();
  }
}

async function applyHtmlDemoProxy(): Promise<void> {
  const ses = await demoSession?.catch(() => null);
  // A proxy that cannot be set must not fail the save: the request filter already decides each request.
  await ses?.setProxy({ proxyRules: HTML_DEMO_DEAD_PROXY, proxyBypassRules: htmlDemoProxyBypassRules(htmlDemoSettings().cdnLibraries()) }).catch(() => undefined);
}

/** The decoded HTML behind a room attachment link, read up to the demo size limit. */
export async function loadHtmlDemoAttachment(href: string, signal?: AbortSignal): Promise<{ html: string; byteLength: number }> {
  const response = await attachmentResponse(href, signal);
  // The attachment proxy turns an aborted fetch into an error page; the abort reason says more.
  signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The demo file could not be loaded (HTTP ${response.status}).`);
  }
  const bytes = await readHtmlDemoBytes(response, MAX_HTML_DEMO_BYTES, signal);
  return { html: new TextDecoder("utf-8").decode(bytes), byteLength: bytes.byteLength };
}

/** The rules every demo page gets, in its own window or inside a message. */
export function lockHtmlDemoContents(contents: WebContents): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // A demo cannot keep its page open with a beforeunload prompt.
  contents.on("will-prevent-unload", (event) => event.preventDefault());
  // A demo cannot move or resize its window to cover the app or hide off-screen.
  contents.on("content-bounds-updated", (event) => event.preventDefault());
}

export function htmlDemoSession(): Promise<Session> {
  // A failed setup is not cached, so the next open tries again.
  demoSession ??= prepareHtmlDemoSession().catch((error: unknown) => {
    demoSession = null;
    throw error;
  });
  return demoSession;
}

async function prepareHtmlDemoSession(): Promise<Session> {
  const settings = htmlDemoSettings();
  await settings.read();
  return prepareLockedHtmlSession({
    partition: HTML_DEMO_PARTITION,
    scheme: htmlDemoProtocolScheme,
    documents: htmlDemoDocuments,
    contents: htmlDemoContents,
    closedText: "This demo is closed.",
    networkBlockError: "Demos cannot open because their network block could not be set up.",
    cdn: () => settings.cdnLibraries(),
  });
}

/** What one locked HTML session serves, and to whom. */
export interface LockedHtmlSessionOptions {
  /** An in-memory partition (no `persist:`), so its storage never reaches disk. */
  partition: string;
  scheme: string;
  /** The documents it serves at `/`, by host. */
  documents: ReadonlyMap<string, string>;
  /** Its own pages' web contents and the host each one shows. */
  contents: ReadonlyMap<number, string>;
  closedText: string;
  networkBlockError: string;
  /** Whether its pages may load from the CDNs (HTML_DEMO_CDN_HOSTS) now. Room pages never may. */
  cdn?: () => boolean;
}

/**
 * The locks of every session that runs HTML someone attached or pinned: a dead
 * proxy, a request filter that lets a page load only its own document (and,
 * for demos while allowed, files from the CDNs), no permissions and no
 * downloads. Demos and room pages each get their own.
 */
export async function prepareLockedHtmlSession(options: LockedHtmlSessionOptions): Promise<Session> {
  const ses = session.fromPartition(options.partition);
  const cdn = () => options.cdn?.() === true;
  // Connections that skip the request filter (WebRTC over TCP, preconnect) meet a
  // closed port. Set first: without it nothing opens, and nothing below is
  // registered yet, so the next open can set the session up again.
  try {
    await ses.setProxy({ proxyRules: HTML_DEMO_DEAD_PROXY, proxyBypassRules: htmlDemoProxyBypassRules(cdn()) });
  } catch {
    throw new Error(options.networkBlockError);
  }
  ses.protocol.handle(options.scheme, (request) => {
    const url = new URL(request.url);
    const html = url.pathname === "/" ? options.documents.get(url.hostname) : undefined;
    const headers = htmlDemoResponseHeaders(cdn());
    return html === undefined
      ? new Response(options.closedText, { status: 404, headers })
      : new Response(html, { headers });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    // A request without a known non-demo sender counts as the page's own.
    const host = details.webContentsId === undefined ? undefined : options.contents.get(details.webContentsId);
    const fromDemo = details.webContentsId === undefined || host !== undefined;
    const request = cdn() ? { method: details.method, resourceType: details.resourceType } : undefined;
    callback({ cancel: !isAllowedHtmlDemoRequest(details.url, { fromDemo, host }, options.scheme, request) });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  return ses;
}
