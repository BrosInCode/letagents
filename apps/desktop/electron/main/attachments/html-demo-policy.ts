import type { WebPreferences } from "electron";

import { LIVE_DEMO, LIVE_DEMO_ANCHOR_DEPTH, isLiveDemoAnchorPath, isLiveDemoAnchorStep, type LiveDemoAnchor } from "../../../../../shared/live-demo.mjs";
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
 * Token buckets for what a demo makes Electron forward to its `<webview>`,
 * through main to the app page: one for events, one for the characters of
 * their text (console messages, titles, URLs). A demo is stopped only when a
 * bucket runs dry. In Electron 42 main passes about 65,000 small events, or
 * about 200 MB of text, a second at full load, so a full bucket costs main at
 * most about a third of a second. The refill is 10 times the busiest normal
 * demo measured (60 to 100 events a second, under 1 MB of text a second).
 */
export const INLINE_HTML_DEMO_EVENT_BURST = 20_000;
export const INLINE_HTML_DEMO_EVENTS_PER_SECOND = 1_000;
export const INLINE_HTML_DEMO_TEXT_BURST = 32 * 1024 * 1024;
export const INLINE_HTML_DEMO_TEXT_PER_SECOND = 2 * 1024 * 1024;
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

export interface InlineHtmlDemoBucket {
  capacity: number;
  perSecond: number;
  tokens: number;
  updatedAt: number;
}

/** A full bucket at `now`. */
export function inlineHtmlDemoBucket(capacity: number, perSecond: number, now: number): InlineHtmlDemoBucket {
  return { capacity, perSecond, tokens: capacity, updatedAt: now };
}

/** Refill for the time since the last call, then take `amount`. False once the bucket has run dry. */
export function takeInlineHtmlDemoTokens(bucket: InlineHtmlDemoBucket, amount: number, now: number): boolean {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed * bucket.perSecond) / 1000);
  bucket.updatedAt = Math.max(bucket.updatedAt, now);
  bucket.tokens -= amount;
  return bucket.tokens >= 0;
}

/**
 * The text an event carries to the app page: its string arguments after the
 * event object (a console message and its script URL, a title, a URL, favicon
 * URLs). The event object repeats some of them, so it is not counted.
 */
export function inlineHtmlDemoEventText(args: readonly unknown[]): number {
  let length = 0;
  for (const arg of args.slice(1)) {
    if (typeof arg === "string") length += arg.length;
    else if (Array.isArray(arg)) for (const item of arg) if (typeof item === "string") length += item.length;
  }
  return length;
}

/**
 * Whether a demo that just took keyboard focus may keep it: the person clicked,
 * typed or touched inside it, or pressed Tab in the app, a moment ago; or the
 * person's last input in the window went to this demo before the window lost
 * focus, and the window is coming back. Electron 42 on macOS refocuses the
 * demo just before the window's own focus event, so "coming back" is a window
 * that is still marked blurred, or one that was focused a moment ago.
 */
export function inlineHtmlDemoFocusAllowed(input: {
  now: number;
  lastInputAt: number;
  lastTabAt: number;
  hadLastInputAtWindowBlur: boolean;
  windowBlurredAt: number;
  windowFocusedAt: number;
}): boolean {
  const recent = (at: number) => input.now - at <= INLINE_HTML_DEMO_FOCUS_GRACE_MS;
  const windowReturning = input.windowBlurredAt > input.windowFocusedAt || recent(input.windowFocusedAt);
  return recent(input.lastInputAt) || recent(input.lastTabAt) || (input.hadLastInputAtWindowBlur && windowReturning);
}

/**
 * A guest's preferred height in the app's CSS pixels: Electron reports it in
 * screen points, which the app's zoom scales. A live demo's guest zoom scales
 * the points too, so the same division gives its frame height (measured in
 * Electron 42: 1500 CSS px at guest zoom 0.625 and app zoom 1.25 report 937,
 * a 750 px frame). A live demo may be as tall as LIVE_DEMO.maxHeight demo px.
 */
export function inlineHtmlDemoHeight(preferredHeight: unknown, zoomFactor: unknown = 1, max = MAX_INLINE_HTML_DEMO_HEIGHT): number {
  if (typeof preferredHeight !== "number" || Number.isNaN(preferredHeight)) return 0;
  const zoom = positiveZoom(zoomFactor);
  return Math.min(max, Math.max(0, Math.ceil(preferredHeight / zoom)));
}

/** Chromium's page zoom limits; a live demo in a very narrow or very wide frame stops scaling at these. */
export const INLINE_HTML_DEMO_MIN_ZOOM = 0.25;
export const INLINE_HTML_DEMO_MAX_ZOOM = 5;

/**
 * The guest zoom that lays a live demo out at LIVE_DEMO.width CSS px across a
 * frame `frameWidth` app CSS px wide, and the scale the chat draws with (frame
 * px per demo px). The frame is frameWidth × appZoom screen points wide, and
 * the guest zoom divides those into its CSS px. Null for a width that is not
 * a positive number.
 */
export function inlineHtmlDemoLiveZoom(frameWidth: unknown, appZoom: unknown = 1): { zoom: number; scale: number } | null {
  if (typeof frameWidth !== "number" || !Number.isFinite(frameWidth) || frameWidth <= 0) return null;
  const app = positiveZoom(appZoom);
  const zoom = Math.min(INLINE_HTML_DEMO_MAX_ZOOM, Math.max(INLINE_HTML_DEMO_MIN_ZOOM, (frameWidth * app) / LIVE_DEMO.width));
  return { zoom, scale: zoom / app };
}

/**
 * In the live layout the chat scrolls, never the demo's own page. A user
 * stylesheet's !important outranks every rule of the page, its !important and
 * inline styles included (measured in Electron 42: it holds after the page adds
 * its own !important rules, rewrites its document or swaps its root element).
 * Elements inside the page may still scroll.
 */
export const INLINE_HTML_DEMO_LIVE_ROOT_CSS = "html, body { overflow: hidden !important; }";
/** Read in main's own world, where the page cannot change it: the layout width in CSS px, pinch zoom left out. */
export const INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT = "visualViewport.width * visualViewport.scale";
/** A measured layout width this far from the expected one means the page does not run at the live zoom yet. */
export const INLINE_HTML_DEMO_LIVE_ZOOM_TOLERANCE = 0.02;
/** Smaller differences from LIVE_DEMO.width are left alone. */
export const INLINE_HTML_DEMO_LIVE_WIDTH_SLACK = 0.25;

/**
 * Judge a live demo's layout width, measured after its zoom was set.
 * "pending": the page still lays out at another zoom (Electron 42 reports the
 * new zoom at once, but the page may send one more size at the old one).
 * "correct": the frame's whole screen points hold a fraction more or less
 * than `expected` CSS px (607.6 px measured as 607 gave 761.25); multiply the
 * zoom by `factor`. "ready": the page lays out at `expected` CSS px.
 */
export function inlineHtmlDemoLiveLayoutCheck(
  measuredWidth: unknown,
  expected: number,
): { state: "pending" } | { state: "ready" } | { state: "correct"; factor: number } {
  if (typeof measuredWidth !== "number" || !Number.isFinite(measuredWidth) || measuredWidth <= 0) return { state: "pending" };
  const ratio = measuredWidth / expected;
  if (Math.abs(ratio - 1) > INLINE_HTML_DEMO_LIVE_ZOOM_TOLERANCE) return { state: "pending" };
  return Math.abs(measuredWidth - expected) >= INLINE_HTML_DEMO_LIVE_WIDTH_SLACK ? { state: "correct", factor: ratio } : { state: "ready" };
}

/**
 * A live demo's frame height in app CSS px. Chromium rounds the preferred
 * height to whole points, so one more point keeps the frame from being a
 * fraction shorter than the page: in Electron 42 that fraction (2223.66 CSS px
 * of viewport for a 2224 px page) took every wheel turn over the demo.
 */
export function inlineHtmlDemoLiveHeight(preferredHeight: unknown, appZoom: unknown, scale: number): number {
  if (typeof preferredHeight !== "number" || Number.isNaN(preferredHeight)) return 0;
  return inlineHtmlDemoHeight(preferredHeight + 1, appZoom, Math.ceil(LIVE_DEMO.maxHeight * scale) + 1);
}

/**
 * The person's pointer in demo space, from a guest's `input-event`. Electron 42
 * reports x and y in screen points from the webview's top-left corner, and the
 * guest's own zoom (which already holds the app's zoom) turns points into its
 * CSS px: at app zoom 1.25 and guest zoom 0.625, x 168.75 is the page's 270.
 * Null for a point outside the demo, as a drag held from inside it reports.
 */
export function inlineHtmlDemoPointer(
  x: unknown,
  y: unknown,
  guestZoom: unknown,
  demoHeight: number = LIVE_DEMO.maxHeight,
): { x: number; y: number } | null {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const zoom = positiveZoom(guestZoom);
  const demoX = Math.round((x / zoom) * 10) / 10;
  const demoY = Math.round((y / zoom) * 10) / 10;
  const bottom = Math.min(LIVE_DEMO.maxHeight, Math.max(0, demoHeight));
  return demoX >= 0 && demoX <= LIVE_DEMO.width && demoY >= 0 && demoY <= bottom ? { x: demoX, y: demoY } : null;
}

function positiveZoom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

/** How long main waits for a live demo to name the element under a new pin. */
export const INLINE_HTML_DEMO_ANCHOR_TIMEOUT_MS = 500;
/** The most elements a pin's path names, from the element under it up (the server keeps no longer path). */
export const INLINE_HTML_DEMO_ANCHOR_DEPTH = LIVE_DEMO_ANCHOR_DEPTH;

/**
 * Run in main's own world of a live demo, where the page's scripts cannot see
 * or change it: the element under (x, y) in demo space (the page's CSS px from
 * its top-left corner, as main reports the pointer), as the steps of a CSS
 * path from the top down, and where the point sits in the element's box. An
 * id that is unique ends the path early. The steps come from the page, so
 * main checks them (`inlineHtmlDemoAnchor`).
 */
export function inlineHtmlDemoAnchorScript(x: number, y: number): string {
  return `(() => {
  const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
  const target = document.elementFromPoint(x, y);
  if (!target || target === document.documentElement) return null;
  const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  const TAG = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
  const parts = [];
  for (let node = target; node && node !== document.documentElement && parts.length < ${INLINE_HTML_DEMO_ANCHOR_DEPTH}; node = node.parentElement) {
    const tag = TAG.test(node.localName) ? node.localName : '*';
    if (node.id && NAME.test(node.id) && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift(tag + '#' + node.id);
      break;
    }
    let part = tag + Array.from(node.classList).filter((name) => NAME.test(name)).slice(0, 2).map((name) => '.' + name).join('');
    const parent = node.parentElement;
    if (parent && tag !== '*') {
      const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
  }
  const box = target.getBoundingClientRect();
  return { parts, dx: x - box.left, dy: y - box.top };
})()`;
}

/**
 * The anchor a pin saves from what `inlineHtmlDemoAnchorScript` answered, or
 * null. Each step must look like one the script makes; a path longer than
 * LIVE_DEMO.anchorPath loses its top steps, since the end names the element.
 */
export function inlineHtmlDemoAnchor(answer: unknown): LiveDemoAnchor | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const { parts, dx, dy } = answer as Record<string, unknown>;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > INLINE_HTML_DEMO_ANCHOR_DEPTH) return null;
  if (!parts.every((part): part is string => isLiveDemoAnchorStep(part))) return null;
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const kept = [...parts];
  while (kept.length > 1 && kept.join(" > ").length > LIVE_DEMO.anchorPath) kept.shift();
  const path = kept.join(" > ");
  if (!isLiveDemoAnchorPath(path)) return null;
  return { path, dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 };
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
