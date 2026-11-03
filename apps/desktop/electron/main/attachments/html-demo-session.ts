import electron from "electron";
import type { Session, WebContents } from "electron";

import { htmlDemoProtocolScheme } from "../paths.js";
import {
  HTML_DEMO_PARTITION,
  HTML_DEMO_RESPONSE_HEADERS,
  isAllowedHtmlDemoRequest,
  readHtmlDemoBytes,
} from "./html-demo-policy.js";
import { attachmentResponse } from "./protocol.js";

const { session } = electron as typeof import("electron");

/**
 * Demo documents by host, for demo windows and demos inside messages alike. A
 * host exists only while its window is open or its inline demo is live.
 */
export const htmlDemoDocuments = new Map<string, string>();
/** The demo pages' own web contents; DevTools opened on a demo is not one of them. */
export const htmlDemoContentsIds = new Set<number>();
let demoSession: Promise<Session> | null = null;

/** The decoded HTML behind a room attachment link, read up to the demo size limit. */
export async function loadHtmlDemoAttachment(href: string): Promise<{ html: string; byteLength: number }> {
  const response = await attachmentResponse(href);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The demo file could not be loaded (HTTP ${response.status}).`);
  }
  const bytes = await readHtmlDemoBytes(response);
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
  const ses = session.fromPartition(HTML_DEMO_PARTITION);
  // Connections that skip the request filter (WebRTC over TCP, preconnect) meet a
  // closed port. Set first: without it no demo opens, and nothing below is
  // registered yet, so the next open can set the session up again.
  try {
    await ses.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" });
  } catch {
    throw new Error("Demos cannot open because their network block could not be set up.");
  }
  ses.protocol.handle(htmlDemoProtocolScheme, (request) => {
    const url = new URL(request.url);
    const html = url.pathname === "/" ? htmlDemoDocuments.get(url.hostname) : undefined;
    return html === undefined
      ? new Response("This demo is closed.", { status: 404, headers: HTML_DEMO_RESPONSE_HEADERS })
      : new Response(html, { headers: HTML_DEMO_RESPONSE_HEADERS });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    // A request without a known non-demo sender counts as the demo's own.
    const fromDemo = details.webContentsId === undefined || htmlDemoContentsIds.has(details.webContentsId);
    callback({ cancel: !isAllowedHtmlDemoRequest(details.url, { fromDemo }) });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  return ses;
}
