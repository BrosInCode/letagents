import type { WebPreferences } from "electron";

import { attachmentProtocolScheme, htmlDemoProtocolScheme } from "../paths.js";

/**
 * An HTML demo is a single file someone attached to a room message. It runs
 * inside its message or in its own window, with no preload, no Node and no app
 * sign-in, and nothing loads over the network: scripts and styles must be
 * inline, and images must be data: or blob: URLs. Known limits: the page can
 * still cause DNS lookups (DNS prefetch, WebRTC), and it can read a file the
 * person drops or picks in it.
 */
export const MAX_HTML_DEMO_BYTES = 10 * 1024 * 1024;
export const MAX_OPEN_HTML_DEMOS = 6;
/** In-memory partition (no `persist:`), so demo storage never reaches disk. */
export const HTML_DEMO_PARTITION = "letagents-html-demos";

/** Live inline demo leases main allows; the chat itself runs fewer at once. */
export const MAX_INLINE_HTML_DEMOS = 4;
/** A prepared inline demo that no webview loads in this time is dropped. */
export const INLINE_HTML_DEMO_LEASE_MS = 30_000;
/** Decoded demo files kept for the chat, so a demo that scrolls back does not download again. */
export const INLINE_HTML_DEMO_CACHE_ENTRIES = 6;
export const INLINE_HTML_DEMO_CACHE_BYTES = 2 * MAX_HTML_DEMO_BYTES;
export const INLINE_HTML_DEMO_CACHE_MS = 10 * 60_000;
/** Different demo files downloading at once, and how long one download may take. */
export const MAX_INLINE_HTML_DEMO_DOWNLOADS = 4;
export const INLINE_HTML_DEMO_DOWNLOAD_MS = 20_000;
export const MAX_INLINE_HTML_DEMO_HEIGHT = 4000;
/** Each inline demo reports its height at most once in this time. */
export const INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS = 100;
/**
 * Every interval a running inline demo must answer a trivial script within the
 * timeout, or it counts as frozen. Chromium's own hang check needs input first.
 */
export const INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS = 5_000;
export const INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS = 5_000;
/** A timeout that fires this much late means main itself was blocked, so the check proves nothing. */
export const INLINE_HTML_DEMO_LIVENESS_LATE_MS = 1_000;
/** An isolated world no other app code uses, so the page can neither see nor answer the check. */
export const INLINE_HTML_DEMO_LIVENESS_WORLD_ID = 4417;
/**
 * Events a guest makes Electron forward to its `<webview>`, per one-second
 * window. A 60 fps demo that logs every frame makes about 60, and 10,000 a
 * second still left main and the app page responsive in Electron 42; a demo
 * over the limit for two windows in a row is stopped.
 */
export const INLINE_HTML_DEMO_EVENTS_PER_SECOND = 1_000;
export const INLINE_HTML_DEMO_BUSY_SECONDS = 2;
/** A demo may take keyboard focus this soon after the person clicks or types in it, or Tabs into it. */
export const INLINE_HTML_DEMO_FOCUS_GRACE_MS = 1_000;

const INLINE_HTML_DEMO_HOST = /^[0-9a-f]{32}$/;

export const HTML_DEMO_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src data: blob:",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // Scripts and its own storage only: no dialogs, printing, forms, pop-ups, downloads or top navigation.
  "sandbox allow-scripts allow-same-origin",
].join("; ");

export const HTML_DEMO_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": HTML_DEMO_CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), fullscreen=(), picture-in-picture=()",
};

/**
 * The demo's own document and in-page data are the only requests a demo page
 * makes. DevTools opened on a demo (another web contents) may load its own UI.
 */
export function isAllowedHtmlDemoRequest(
  rawUrl: string,
  sender: { fromDemo: boolean; host?: string } = { fromDemo: true },
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // A known demo page loads only its own document, never another demo's.
  return (url.protocol === `${htmlDemoProtocolScheme}:` && (sender.host === undefined || url.hostname === sender.host))
    || url.protocol === "data:"
    || url.protocol === "blob:"
    || (url.protocol === "devtools:" && !sender.fromDemo);
}

/** Only attachment links the app itself made may open as a demo. */
export function assertHtmlDemoAttachmentHref(rawHref: unknown): string {
  if (typeof rawHref !== "string") {
    throw new Error("The demo link is missing.");
  }
  let url: URL;
  try {
    url = new URL(rawHref);
  } catch {
    throw new Error("The demo link is invalid.");
  }
  if (url.protocol !== `${attachmentProtocolScheme}:` || (url.hostname !== "download" && url.hostname !== "local")) {
    throw new Error("Only room attachments open as demos.");
  }
  return url.toString();
}

export function inlineHtmlDemoLeaseUrl(host: string): string {
  return `${htmlDemoProtocolScheme}://${host}/`;
}

/** The host of a lease URL written exactly as main makes it, or null for anything else. */
export function inlineHtmlDemoLeaseHost(rawUrl: unknown): string | null {
  const prefix = `${htmlDemoProtocolScheme}://`;
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(prefix) || !rawUrl.endsWith("/")) return null;
  const host = rawUrl.slice(prefix.length, -1);
  return INLINE_HTML_DEMO_HOST.test(host) ? host : null;
}

/**
 * The lease a `<webview>` attaches with: exactly a lease URL, in the demo
 * partition, and no webview used that lease before. Null refuses the webview.
 */
export function inlineHtmlDemoAttachLease(
  params: Readonly<Record<string, unknown>>,
  webPreferences: Readonly<{ partition?: unknown }>,
  leases: ReadonlyMap<string, { attached: boolean }>,
): string | null {
  const host = inlineHtmlDemoLeaseHost(params.src);
  if (!host || params.partition !== HTML_DEMO_PARTITION || webPreferences.partition !== HTML_DEMO_PARTITION) return null;
  return leases.get(host)?.attached === false ? host : null;
}

/** The web preferences of every inline demo, the same locks as a demo window. */
export function inlineHtmlDemoWebPreferences(): WebPreferences & { disablePopups: true } {
  return {
    partition: HTML_DEMO_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    plugins: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    // alert() and confirm() would show the page's text in a native app dialog.
    disableDialogs: true,
    autoplayPolicy: "user-gesture-required",
    // Reports the page's height, so the message can show all of it.
    enablePreferredSizeMode: true,
    disablePopups: true,
  };
}

/**
 * Replace a guest's web preferences, in place, with the inline demo set. Only
 * the app's zoom carries over: a preload, Blink features or anything else the
 * `<webview>` asked for is dropped.
 */
export function lockInlineHtmlDemoWebPreferences(webPreferences: WebPreferences): WebPreferences {
  const { zoomFactor } = webPreferences;
  for (const key of Object.keys(webPreferences)) delete (webPreferences as Record<string, unknown>)[key];
  Object.assign(webPreferences, inlineHtmlDemoWebPreferences());
  if (typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0) webPreferences.zoomFactor = zoomFactor;
  return webPreferences;
}

export interface InlineHtmlDemoEventMeter {
  windowStart: number;
  count: number;
  /** Windows in a row, just before the current one, that went over the limit. */
  busyWindows: number;
}

export function inlineHtmlDemoEventMeter(): InlineHtmlDemoEventMeter {
  return { windowStart: Number.NEGATIVE_INFINITY, count: 0, busyWindows: 0 };
}

/**
 * Count one forwarded event at `now`. True when this event takes the demo over
 * the limit in its last busy window: a burst passes, a steady flood does not.
 */
export function countInlineHtmlDemoEvent(meter: InlineHtmlDemoEventMeter, now: number): boolean {
  const elapsed = now - meter.windowStart;
  if (elapsed >= 1000) {
    // A window with no events in between ends the run.
    const lastWasBusy = elapsed < 2000 && meter.count > INLINE_HTML_DEMO_EVENTS_PER_SECOND;
    meter.busyWindows = lastWasBusy ? meter.busyWindows + 1 : 0;
    meter.windowStart = now;
    meter.count = 0;
  }
  meter.count += 1;
  return meter.count === INLINE_HTML_DEMO_EVENTS_PER_SECOND + 1 && meter.busyWindows + 1 >= INLINE_HTML_DEMO_BUSY_SECONDS;
}

/**
 * Whether a demo that just took keyboard focus may keep it: the person clicked,
 * typed or touched inside it, or pressed Tab in the app, a moment ago; or the
 * demo had focus when the app window lost it, and the window is coming back.
 * Electron 42 on macOS refocuses the demo just before the window's own focus
 * event, so "coming back" is a window that is still marked blurred, or one
 * that was focused a moment ago.
 */
export function inlineHtmlDemoFocusAllowed(input: {
  now: number;
  lastInputAt: number;
  lastTabAt: number;
  focusedAtWindowBlur: boolean;
  windowBlurredAt: number;
  windowFocusedAt: number;
}): boolean {
  const recent = (at: number) => input.now - at <= INLINE_HTML_DEMO_FOCUS_GRACE_MS;
  const windowReturning = input.windowBlurredAt > input.windowFocusedAt || recent(input.windowFocusedAt);
  return recent(input.lastInputAt) || recent(input.lastTabAt) || (input.focusedAtWindowBlur && windowReturning);
}

/**
 * A guest's preferred height in the app's CSS pixels: Electron reports it in
 * screen points, which the app's zoom scales.
 */
export function inlineHtmlDemoHeight(preferredHeight: unknown, zoomFactor: unknown = 1): number {
  if (typeof preferredHeight !== "number" || Number.isNaN(preferredHeight)) return 0;
  const zoom = typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.min(MAX_INLINE_HTML_DEMO_HEIGHT, Math.max(0, Math.ceil(preferredHeight / zoom)));
}

export function htmlDemoWindowTitle(fileName: unknown, senderLabel: unknown): string {
  const name = cleanLabel(fileName) || "demo.html";
  const sender = cleanLabel(senderLabel);
  return sender ? `Demo · ${name} · from ${sender}` : `Demo · ${name}`;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string"
    // Control characters, and direction marks that could reorder "from <sender>".
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 120)
    : "";
}

/** Read a response body, stopping as soon as it passes `limit` bytes or `signal` aborts. */
export async function readHtmlDemoBytes(response: Response, limit = MAX_HTML_DEMO_BYTES, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(htmlDemoTooLargeMessage(limit));
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  // Cancelling wakes a read that waits on a stalled stream.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(htmlDemoTooLargeMessage(limit));
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function htmlDemoTooLargeMessage(limit: number): string {
  return `This demo is larger than ${Math.round(limit / (1024 * 1024))} MB, so it does not open in the viewer.`;
}
