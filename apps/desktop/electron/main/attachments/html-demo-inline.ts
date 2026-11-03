import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow, Event, InputEvent, WebContents } from "electron";
import { randomUUID } from "node:crypto";

import type { DesktopInlineHtmlDemoEvent, DesktopInlineHtmlDemoLease } from "../../ipc-types.js";
import {
  assertHtmlDemoAttachmentHref,
  HTML_DEMO_PARTITION,
  INLINE_HTML_DEMO_CACHE_BYTES,
  INLINE_HTML_DEMO_CACHE_ENTRIES,
  INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS,
  INLINE_HTML_DEMO_LEASE_MS,
  INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS,
  INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS,
  INLINE_HTML_DEMO_LIVENESS_WORLD_ID,
  inlineHtmlDemoAttachLease,
  inlineHtmlDemoHeight,
  inlineHtmlDemoLeaseHost,
  inlineHtmlDemoLeaseUrl,
  lockInlineHtmlDemoWebPreferences,
  MAX_INLINE_HTML_DEMOS,
} from "./html-demo-policy.js";
import {
  htmlDemoContentsIds,
  htmlDemoDocuments,
  htmlDemoSession,
  loadHtmlDemoAttachment,
  lockHtmlDemoContents,
} from "./html-demo-session.js";

const { app } = electron as typeof import("electron");

export const INLINE_HTML_DEMO_EVENT_CHANNEL = "desktop:room:inline-html-demo-event";

/** The first click, key or touch in a demo turns its sound on; the page cannot fake one. */
const UNMUTE_INPUT_TYPES = new Set<InputEvent["type"]>(["mouseDown", "rawKeyDown", "keyDown", "touchStart"]);

interface InlineHtmlDemoLease {
  host: string;
  url: string;
  /** A webview claimed this lease; no other webview can. */
  attached: boolean;
  guest: WebContents | null;
  embedder: WebContents | null;
  stopped: boolean;
  attachTimer: ReturnType<typeof setTimeout> | null;
  heightTimer: ReturnType<typeof setTimeout> | null;
  pendingHeight: number | null;
  sentHeight: number | null;
  heightSentAt: number;
  /** Waits for the next liveness check, or for the answer to the one in flight. */
  livenessTimer: ReturnType<typeof setTimeout> | null;
  livenessCheck: object | null;
}

/** Live leases by demo host; a host's document lives exactly as long as its lease. */
const leases = new Map<string, InlineHtmlDemoLease>();
const leasesByGuestId = new Map<number, InlineHtmlDemoLease>();
let preparing = 0;
const htmlCache = new Map<string, { html: string; byteLength: number }>();
let htmlCacheBytes = 0;
const htmlLoads = new Map<string, Promise<string>>();
/** The lease whose webview Electron is creating right now, in this task. */
let attaching: { lease: InlineHtmlDemoLease; embedder: WebContents } | null = null;
let guestBindingInstalled = false;

/** Load a room HTML attachment for a `<webview>` in the chat; the lease admits one webview, once. */
export async function prepareInlineHtmlDemo(rawHref: unknown): Promise<DesktopInlineHtmlDemoLease> {
  const href = assertHtmlDemoAttachmentHref(rawHref);
  if (leases.size + preparing >= MAX_INLINE_HTML_DEMOS) {
    throw new Error(`At most ${MAX_INLINE_HTML_DEMOS} demos can run in the chat at once.`);
  }
  preparing += 1;
  let html: string;
  try {
    // The demo session is locked before any lease exists, so no webview loads without the locks.
    await htmlDemoSession();
    html = await inlineHtmlDemoDocument(href);
  } finally {
    preparing -= 1;
  }
  const host = randomUUID().replaceAll("-", "");
  const lease: InlineHtmlDemoLease = {
    host,
    url: inlineHtmlDemoLeaseUrl(host),
    attached: false,
    guest: null,
    embedder: null,
    stopped: false,
    attachTimer: null,
    heightTimer: null,
    pendingHeight: null,
    sentHeight: null,
    heightSentAt: Number.NEGATIVE_INFINITY,
    livenessTimer: null,
    livenessCheck: null,
  };
  lease.attachTimer = setTimeout(() => {
    if (!lease.guest) endLease(lease);
  }, INLINE_HTML_DEMO_LEASE_MS);
  htmlDemoDocuments.set(host, html);
  leases.set(host, lease);
  return { url: lease.url, partition: HTML_DEMO_PARTITION };
}

/** Free a lease and its document, and close its demo if one runs. Unknown URLs are ignored. */
export function releaseInlineHtmlDemo(rawUrl: unknown): void {
  const host = inlineHtmlDemoLeaseHost(rawUrl);
  const lease = host ? leases.get(host) : undefined;
  if (!lease) return;
  endLease(lease);
  if (lease.guest && !lease.guest.isDestroyed()) lease.guest.close();
}

/**
 * Let the app window show inline demos. A `<webview>` attaches only with a
 * lease from `prepareInlineHtmlDemo`; every other webview is refused.
 */
export function installInlineHtmlDemoHost(hostWindow: ElectronBrowserWindow): void {
  if (!guestBindingInstalled) {
    app.on("web-contents-created", (_event, contents) => bindAttachingGuest(contents));
    guestBindingInstalled = true;
  }
  const embedder = hostWindow.webContents;
  embedder.on("will-attach-webview", (event, webPreferences, params) => {
    const host = inlineHtmlDemoAttachLease(params, webPreferences, leases);
    const lease = host ? leases.get(host) : undefined;
    if (!lease) {
      event.preventDefault();
      return;
    }
    lockInlineHtmlDemoWebPreferences(webPreferences);
    params.src = lease.url;
    delete params.allowpopups;
    lease.attached = true;
    // Electron creates the guest right after this listener returns, in the same
    // task, and reports it to "web-contents-created". A later webview is a later
    // task, so it never finds this lease waiting for it.
    attaching = { lease, embedder };
    queueMicrotask(() => { attaching = null; });
  });
  embedder.on("did-attach-webview", (_event, guest) => {
    if (leasesByGuestId.get(guest.id)?.guest === guest) return;
    // A webview that passed the lease check but is not bound to its lease does not run.
    setImmediate(() => {
      if (!guest.isDestroyed()) guest.close();
    });
  });
}

/** Lock a just-created guest before it loads anything, and tie it to its lease. */
function bindAttachingGuest(guest: WebContents): void {
  const current = attaching;
  attaching = null;
  if (!current || guest.getType() !== "webview") return;
  const { lease, embedder } = current;
  const guestId = guest.id;
  lease.guest = guest;
  lease.embedder = embedder;
  if (lease.attachTimer) clearTimeout(lease.attachTimer);
  lease.attachTimer = null;
  leasesByGuestId.set(guestId, lease);
  htmlDemoContentsIds.add(guestId);
  lockHtmlDemoContents(guest);

  guest.setAudioMuted(true);
  const unmuteOnInput = (_event: Event, input: InputEvent) => {
    if (!UNMUTE_INPUT_TYPES.has(input.type)) return;
    guest.off("input-event", unmuteOnInput);
    guest.setAudioMuted(false);
  };
  guest.on("input-event", unmuteOnInput);
  guest.on("preferred-size-changed", (_event, size) => {
    queueHeight(lease, inlineHtmlDemoHeight(size.height, embedder.isDestroyed() ? 1 : embedder.getZoomFactor()));
  });
  guest.on("unresponsive", () => stopGuest(lease, "unresponsive"));
  guest.on("render-process-gone", () => stopGuest(lease, "crashed"));
  scheduleLivenessCheck(lease, guest);
  guest.once("destroyed", () => {
    leasesByGuestId.delete(guestId);
    htmlDemoContentsIds.delete(guestId);
    endLease(lease);
    void htmlDemoSession()
      .then((ses) => ses.clearStorageData({ origin: lease.url.slice(0, -1) }))
      .catch(() => undefined);
  });
}

/** A frozen or crashed demo reports once, gives up its lease, and is closed. */
function stopGuest(lease: InlineHtmlDemoLease, reason: "unresponsive" | "crashed"): void {
  const guest = lease.guest;
  if (lease.stopped || !guest || !isLive(lease)) return;
  lease.stopped = true;
  sendEvent(lease, { type: "stopped", url: lease.url, reason });
  endLease(lease);
  // Not inside the guest's own event: closing a guest deletes it at once.
  setImmediate(() => {
    if (guest.isDestroyed()) return;
    // A hung page's process is ended first, so the close does not wait on it.
    if (!guest.isCrashed()) guest.forcefullyCrashRenderer();
    guest.close();
  });
}

/** Every way a lease ends comes through here, so no timer outlives it. */
function endLease(lease: InlineHtmlDemoLease): void {
  for (const timer of [lease.attachTimer, lease.heightTimer, lease.livenessTimer]) {
    if (timer) clearTimeout(timer);
  }
  lease.attachTimer = null;
  lease.heightTimer = null;
  lease.livenessTimer = null;
  lease.livenessCheck = null;
  if (!isLive(lease)) return;
  leases.delete(lease.host);
  htmlDemoDocuments.delete(lease.host);
}

function isLive(lease: InlineHtmlDemoLease): boolean {
  return leases.get(lease.host) === lease;
}

function scheduleLivenessCheck(lease: InlineHtmlDemoLease, guest: WebContents): void {
  lease.livenessTimer = setTimeout(() => checkLiveness(lease, guest), INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS);
}

/**
 * A page stuck in a loop never answers, even when nobody touches it. One check
 * at a time; the next one starts an interval after the answer.
 */
function checkLiveness(lease: InlineHtmlDemoLease, guest: WebContents): void {
  if (!isLive(lease) || guest.isDestroyed()) return;
  const check = {};
  lease.livenessCheck = check;
  lease.livenessTimer = setTimeout(() => {
    if (lease.livenessCheck === check) stopGuest(lease, "unresponsive");
  }, INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS);
  // Any reply, even an error, shows the page's process is still working.
  const answered = () => {
    if (lease.livenessCheck !== check || !isLive(lease)) return;
    lease.livenessCheck = null;
    if (lease.livenessTimer) clearTimeout(lease.livenessTimer);
    scheduleLivenessCheck(lease, guest);
  };
  // Without a user gesture, so the check cannot turn on sound or open anything.
  guest.executeJavaScriptInIsolatedWorld(INLINE_HTML_DEMO_LIVENESS_WORLD_ID, [{ code: "1" }]).then(answered, answered);
}

/** The latest height, at most once per interval, and only when it changed. */
function queueHeight(lease: InlineHtmlDemoLease, height: number): void {
  lease.pendingHeight = height;
  if (lease.heightTimer || !isLive(lease)) return;
  const wait = Math.max(0, lease.heightSentAt + INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS - Date.now());
  lease.heightTimer = setTimeout(() => {
    lease.heightTimer = null;
    const next = lease.pendingHeight;
    lease.pendingHeight = null;
    if (next === null || next === lease.sentHeight || !isLive(lease)) return;
    lease.sentHeight = next;
    lease.heightSentAt = Date.now();
    sendEvent(lease, { type: "height", url: lease.url, height: next });
  }, wait);
}

function sendEvent(lease: InlineHtmlDemoLease, event: DesktopInlineHtmlDemoEvent): void {
  const embedder = lease.embedder;
  if (embedder && !embedder.isDestroyed()) embedder.send(INLINE_HTML_DEMO_EVENT_CHANNEL, event);
}

/** A demo file's HTML, from a small cache so a demo scrolled back into view does not download again. */
function inlineHtmlDemoDocument(href: string): Promise<string> {
  const cached = htmlCache.get(href);
  if (cached) {
    htmlCache.delete(href);
    htmlCache.set(href, cached);
    return Promise.resolve(cached.html);
  }
  let load = htmlLoads.get(href);
  if (!load) {
    load = loadHtmlDemoAttachment(href)
      .then(({ html, byteLength }) => {
        cacheHtml(href, html, byteLength);
        return html;
      })
      .finally(() => htmlLoads.delete(href));
    htmlLoads.set(href, load);
  }
  return load;
}

function cacheHtml(href: string, html: string, byteLength: number): void {
  const previous = htmlCache.get(href);
  if (previous) htmlCacheBytes -= previous.byteLength;
  htmlCache.delete(href);
  htmlCache.set(href, { html, byteLength });
  htmlCacheBytes += byteLength;
  // Oldest first; one file is never over the byte cap, so the newest always stays.
  for (const [oldestHref, entry] of htmlCache) {
    if (htmlCache.size <= INLINE_HTML_DEMO_CACHE_ENTRIES && htmlCacheBytes <= INLINE_HTML_DEMO_CACHE_BYTES) break;
    htmlCache.delete(oldestHref);
    htmlCacheBytes -= entry.byteLength;
  }
}
