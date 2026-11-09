import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow, Event, InputEvent, WebContents } from "electron";
import { randomUUID } from "node:crypto";

import { LIVE_DEMO, type LiveDemoAnchor } from "../../../../../shared/live-demo.mjs";
import type { DesktopInlineHtmlDemoEvent, DesktopInlineHtmlDemoLease } from "../../ipc-types.js";
import {
  assertHtmlDemoAttachmentHref,
  HTML_DEMO_PARTITION,
  INLINE_HTML_DEMO_CACHE_BYTES,
  INLINE_HTML_DEMO_CACHE_ENTRIES,
  INLINE_HTML_DEMO_CACHE_MS,
  INLINE_HTML_DEMO_DOWNLOAD_MS,
  INLINE_HTML_DEMO_ANCHOR_TIMEOUT_MS,
  INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS,
  INLINE_HTML_DEMO_LEASE_MS,
  INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS,
  INLINE_HTML_DEMO_LIVENESS_LATE_MS,
  INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS,
  INLINE_HTML_DEMO_LIVENESS_WORLD_ID,
  inlineHtmlDemoAnchor,
  inlineHtmlDemoAnchorScript,
  inlineHtmlDemoAttachLease,
  INLINE_HTML_DEMO_EVENT_BURST,
  INLINE_HTML_DEMO_EVENTS_PER_SECOND,
  INLINE_HTML_DEMO_TEXT_BURST,
  INLINE_HTML_DEMO_TEXT_PER_SECOND,
  inlineHtmlDemoBucket,
  inlineHtmlDemoEventText,
  inlineHtmlDemoFocusAllowed,
  inlineHtmlDemoHeight,
  inlineHtmlDemoLeaseHost,
  inlineHtmlDemoLeaseUrl,
  INLINE_HTML_DEMO_LIVE_ROOT_CSS,
  INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT,
  INLINE_HTML_DEMO_MAX_ZOOM,
  INLINE_HTML_DEMO_MIN_ZOOM,
  inlineHtmlDemoLiveHeight,
  inlineHtmlDemoLiveLayoutCheck,
  inlineHtmlDemoLiveZoom,
  inlineHtmlDemoPointer,
  lockInlineHtmlDemoWebPreferences,
  MAX_INLINE_HTML_DEMO_DOWNLOADS,
  takeInlineHtmlDemoTokens,
  MAX_INLINE_HTML_DEMOS,
} from "./html-demo-policy.js";
import {
  htmlDemoContents,
  htmlDemoDocuments,
  htmlDemoSession,
  loadHtmlDemoAttachment,
  lockHtmlDemoContents,
} from "./html-demo-session.js";

const { app } = electron as typeof import("electron");

export const INLINE_HTML_DEMO_EVENT_CHANNEL = "desktop:room:inline-html-demo-event";

/**
 * A click, key or touch the person makes in a demo. The first one turns its
 * sound on, and each one lets the demo take keyboard focus; the page cannot fake one.
 */
const PERSON_INPUT_TYPES = new Set<InputEvent["type"]>(["mouseDown", "rawKeyDown", "keyDown", "touchStart"]);

/**
 * The guest events Electron 42 forwards to the `<webview>` element, each one a
 * message through main to the app page (lib/browser/web-view-events.ts).
 * A page can repeat most of them as fast as it likes.
 */
const FORWARDED_GUEST_EVENTS = [
  "load-commit", "did-finish-load", "did-fail-load", "did-frame-finish-load", "did-start-loading",
  "did-stop-loading", "dom-ready", "console-message", "context-menu", "devtools-open-url",
  "devtools-opened", "devtools-closed", "devtools-focused", "will-navigate", "will-frame-navigate",
  "did-start-navigation", "did-redirect-navigation", "did-navigate", "did-frame-navigate",
  "did-navigate-in-page", "page-title-updated", "page-favicon-updated", "enter-html-full-screen",
  "leave-html-full-screen", "media-started-playing", "media-paused", "found-in-page",
  "did-change-theme-color", "update-target-url", "-focus-change",
] as const;

type StopReason = Extract<DesktopInlineHtmlDemoEvent, { type: "stopped" }>["reason"];

/** The person's pointer over a live demo, in demo space; null when it left the demo. */
export type InlineHtmlDemoPointer = { x: number; y: number } | null;

/**
 * The app page sees a pointer move only when the pointer is over it, so over no
 * demo. Electron 42 also gives the app page the first move into a demo, just
 * before the demo's own, so a demo's pointer counts as gone only when the demo
 * reports nothing newer in this time.
 */
const POINTER_LEFT_CHECK_MS = 100;
/** Zoom factors closer than this are the same; Electron rounds them through zoom levels. */
const ZOOM_EPSILON = 0.0001;
/** A live layout check that found the page at another zoom asks again after this time, a few times. */
const LIVE_LAYOUT_RECHECK_MS = 200;
const LIVE_LAYOUT_RECHECKS = 10;
/** Corrections of the live zoom for one frame width; one is enough unless the frame moves under it. */
const LIVE_ZOOM_CORRECTIONS = 2;

/**
 * What main knows about the app window an inline demo runs in. Only input the
 * browser saw counts; a demo can fake its own focus and blur events.
 */
interface DemoHostWindow {
  lastTabAt: number;
  blurredAt: number;
  focusedAt: number;
  /** The demo that got the person's last click, key or touch in this window; null for the app page. */
  lastInputLease: InlineHtmlDemoLease | null;
  /** Orders the pointer events of the app page and its demos. */
  pointerSequence: number;
  /** The sequence of the app page's latest pointer event. */
  appPagePointerSequence: number;
  pointerLeftTimer: ReturnType<typeof setTimeout> | null;
}

interface InlineHtmlDemoLease {
  host: string;
  url: string;
  /** A webview claimed this lease; no other webview can. */
  attached: boolean;
  guest: WebContents | null;
  embedder: WebContents | null;
  hostWindow: DemoHostWindow | null;
  stopped: boolean;
  attachTimer: ReturnType<typeof setTimeout> | null;
  heightTimer: ReturnType<typeof setTimeout> | null;
  pendingHeight: number | null;
  sentHeight: number | null;
  heightSentAt: number;
  /** Waits for the next liveness check, or for the answer to the one in flight. */
  livenessTimer: ReturnType<typeof setTimeout> | null;
  livenessCheck: object | null;
  lastInputAt: number;
  /** The person's last input went to this demo before the app window lost focus, so it may get focus back on return. */
  hadLastInputAtWindowBlur: boolean;
  /** A live demo: laid out at LIVE_DEMO.width CSS px across a frame this many app CSS px wide. */
  frameWidth: number | null;
  /**
   * The live zoom for the frame width and app zoom (`zoomBase`), times the
   * correction main measured, so the frame's whole screen points hold exactly
   * LIVE_DEMO.width CSS px.
   */
  zoomBase: number | null;
  zoomCorrection: number;
  zoomCorrections: number;
  /** Main has seen, in its own world, that the page lays out at the live zoom; until then no height goes out. */
  liveLayoutReady: boolean;
  liveLayoutCheck: object | null;
  /** A size arrived while the check was running. */
  liveLayoutCheckStale: boolean;
  liveLayoutRecheckTimer: ReturnType<typeof setTimeout> | null;
  liveLayoutRechecks: number;
  /** The latest preferred height, in screen points, and whether one came since the live zoom was last set. */
  preferredHeight: number | null;
  sizeSinceZoom: boolean;
  /** The current document has had DOMContentLoaded, and has the live root rule. */
  domReady: boolean;
  rootLocked: boolean;
  /** The demo's own content height in its CSS px, from its preferred size. */
  demoHeight: number | null;
  pointerWatchers: Set<(pointer: InlineHtmlDemoPointer) => void>;
  /** The last pointer report put the pointer over this demo. */
  pointerOver: boolean;
  /** The host window's pointer sequence at that report. */
  pointerSequence: number;
}

/** Live leases by demo host; a host's document lives exactly as long as its lease. */
const leases = new Map<string, InlineHtmlDemoLease>();
const leasesByGuestId = new Map<number, InlineHtmlDemoLease>();
const htmlCache = new Map<string, { html: string; byteLength: number; cachedAt: number }>();
let htmlCacheBytes = 0;
/** Downloads by link; a demo of a file that is already downloading waits for that download. */
const htmlLoads = new Map<string, Promise<string>>();
/** Moves on when the cache is cleared, so a download started before then is not cached. */
let htmlCacheGeneration = 0;
/** The lease whose webview Electron is creating right now, in this task. */
let attaching: { lease: InlineHtmlDemoLease; embedder: WebContents; hostWindow: DemoHostWindow } | null = null;
let guestBindingInstalled = false;

/** Load a room HTML attachment for a `<webview>` in the chat; the lease admits one webview, once. */
export async function prepareInlineHtmlDemo(rawHref: unknown): Promise<DesktopInlineHtmlDemoLease> {
  const href = assertHtmlDemoAttachmentHref(rawHref);
  assertLeaseAvailable();
  // The demo session is locked before any lease exists, so no webview loads without the locks.
  await htmlDemoSession();
  const html = await inlineHtmlDemoDocument(href);
  // Only real leases count; other demos may have taken the free ones during the download.
  assertLeaseAvailable();
  const host = randomUUID().replaceAll("-", "");
  const lease: InlineHtmlDemoLease = {
    host,
    url: inlineHtmlDemoLeaseUrl(host),
    attached: false,
    guest: null,
    embedder: null,
    hostWindow: null,
    stopped: false,
    attachTimer: null,
    heightTimer: null,
    pendingHeight: null,
    sentHeight: null,
    heightSentAt: Number.NEGATIVE_INFINITY,
    livenessTimer: null,
    livenessCheck: null,
    lastInputAt: Number.NEGATIVE_INFINITY,
    hadLastInputAtWindowBlur: false,
    frameWidth: null,
    zoomBase: null,
    zoomCorrection: 1,
    zoomCorrections: 0,
    liveLayoutReady: false,
    liveLayoutCheck: null,
    liveLayoutCheckStale: false,
    liveLayoutRecheckTimer: null,
    liveLayoutRechecks: 0,
    preferredHeight: null,
    sizeSinceZoom: false,
    domReady: false,
    rootLocked: false,
    demoHeight: null,
    pointerWatchers: new Set(),
    pointerOver: false,
    pointerSequence: 0,
  };
  lease.attachTimer = setTimeout(() => {
    if (!lease.guest) endLease(lease);
  }, INLINE_HTML_DEMO_LEASE_MS);
  htmlDemoDocuments.set(host, html);
  leases.set(host, lease);
  return { url: lease.url, partition: HTML_DEMO_PARTITION };
}

/** Forget downloaded demo files, for sign-out and account changes. */
export function clearInlineHtmlDemoCache(): void {
  htmlCache.clear();
  htmlCacheBytes = 0;
  htmlLoads.clear();
  htmlCacheGeneration += 1;
}

function assertLeaseAvailable(): void {
  if (leases.size >= MAX_INLINE_HTML_DEMOS) {
    throw new Error(`At most ${MAX_INLINE_HTML_DEMOS} demos can run in the chat at once.`);
  }
}

/** Free a lease and its document, and close its demo if one runs. Unknown URLs are ignored. */
export function releaseInlineHtmlDemo(rawUrl: unknown): void {
  const lease = leaseFor(rawUrl);
  if (!lease) return;
  endLease(lease);
  if (lease.guest && !lease.guest.isDestroyed()) lease.guest.close();
}

/**
 * Lay a live demo out at LIVE_DEMO.width CSS px across a frame `frameWidth` app
 * CSS px wide: the guest's zoom scales it to fit. `frameWidth` is the exact
 * width, unrounded; main measures the page afterwards and corrects the zoom by
 * the fraction the frame's whole screen points add or take. The page's root
 * stops scrolling, and heights are held until the page lays out at the new
 * zoom. Returns the scale the chat draws with (frame px per demo px). A demo
 * that is not running yet gets all of this when its webview attaches.
 */
export function setInlineHtmlDemoWidth(rawUrl: unknown, frameWidth: unknown): number {
  const lease = leaseFor(rawUrl);
  if (!lease) throw new Error("This demo is closed.");
  const layout = inlineHtmlDemoLiveZoom(frameWidth, appZoom(lease));
  if (!layout) throw new Error("The demo width must be a positive number.");
  if (lease.frameWidth === null) {
    // A height of the plain layout that has not gone out yet is not the live one.
    if (lease.heightTimer) clearTimeout(lease.heightTimer);
    lease.heightTimer = null;
    lease.pendingHeight = null;
    lease.sentHeight = null;
  }
  lease.frameWidth = frameWidth as number;
  const guest = lease.guest;
  if (guest && !guest.isDestroyed()) {
    lockLiveRoot(lease, guest);
    const target = liveLayout(lease);
    if (target && !sameZoom(guest.getZoomFactor(), target.zoom)) setLiveZoom(lease, guest, target.zoom);
  }
  return layout.scale;
}

interface LiveLayout {
  zoom: number;
  scale: number;
  /** The page's layout width at `zoom`: LIVE_DEMO.width, unless the zoom is at Chromium's limit. */
  expectedWidth: number;
  correctable: boolean;
}

function liveLayout(lease: InlineHtmlDemoLease): LiveLayout | null {
  if (lease.frameWidth === null) return null;
  const app = appZoom(lease);
  const base = inlineHtmlDemoLiveZoom(lease.frameWidth, app);
  if (!base) return null;
  if (lease.zoomBase === null || !sameZoom(lease.zoomBase, base.zoom)) {
    // A new frame width or app zoom: what main measured before no longer holds.
    lease.zoomBase = base.zoom;
    lease.zoomCorrection = 1;
    lease.zoomCorrections = 0;
  }
  const exact = (lease.frameWidth * app) / LIVE_DEMO.width;
  const correctable = sameZoom(exact, base.zoom);
  const zoom = correctable
    ? Math.min(INLINE_HTML_DEMO_MAX_ZOOM, Math.max(INLINE_HTML_DEMO_MIN_ZOOM, base.zoom * lease.zoomCorrection))
    : base.zoom;
  return { zoom, scale: base.scale, expectedWidth: correctable ? LIVE_DEMO.width : (lease.frameWidth * app) / zoom, correctable };
}

/**
 * Set the live zoom; sizes wait until main sees the page lay out at it. A
 * check also runs on its own a moment later, because a small change may bring
 * the page no new size.
 */
function setLiveZoom(lease: InlineHtmlDemoLease, guest: WebContents, zoom: number, correction = false): void {
  lease.liveLayoutReady = false;
  lease.liveLayoutRechecks = 0;
  // A correction moves the zoom by a fraction of a percent, so the last size still holds;
  // after any other change only a size that comes later may go out.
  if (!correction) lease.sizeSinceZoom = false;
  guest.setZoomFactor(zoom);
  recheckLiveLayout(lease, guest);
}

/** The live layout's root never scrolls; each new document of the demo gets the rule again. */
function lockLiveRoot(lease: InlineHtmlDemoLease, guest: WebContents): void {
  if (lease.rootLocked || lease.frameWidth === null || !lease.domReady || guest.isDestroyed()) return;
  lease.rootLocked = true;
  guest.insertCSS(INLINE_HTML_DEMO_LIVE_ROOT_CSS, { cssOrigin: "user" }).catch(() => { lease.rootLocked = false; });
}

/** A size from the live layout: held until the page is known to lay out at the live zoom. */
function liveSize(lease: InlineHtmlDemoLease, guest: WebContents, preferredHeight: number): void {
  lease.preferredHeight = preferredHeight;
  lease.sizeSinceZoom = true;
  const layout = liveLayout(lease);
  if (!layout) return;
  if (!sameZoom(guest.getZoomFactor(), layout.zoom)) {
    // Electron 42 drops a guest zoom set before the first load, and puts the
    // guest back at the app's zoom whenever that changes.
    setLiveZoom(lease, guest, layout.zoom);
    return;
  }
  if (lease.liveLayoutReady) sendLiveHeight(lease, guest, layout);
  else checkLiveLayout(lease, guest);
}

function sendLiveHeight(lease: InlineHtmlDemoLease, guest: WebContents, layout: LiveLayout): void {
  const height = lease.preferredHeight;
  if (height === null || !lease.sizeSinceZoom) return;
  lease.demoHeight = height / guest.getZoomFactor();
  queueHeight(lease, inlineHtmlDemoLiveHeight(height, appZoom(lease), layout.scale));
}

/**
 * Electron 42 reports a new guest zoom at once, but the page may send a size
 * laid out at the old zoom after it (a 6000 px page at zoom 1 after zoom 0.33
 * was set). Main reads the page's layout width in its own world, where the
 * page cannot change it, and lets heights out only once it matches.
 */
function checkLiveLayout(lease: InlineHtmlDemoLease, guest: WebContents): void {
  if (lease.liveLayoutCheck) {
    lease.liveLayoutCheckStale = true;
    return;
  }
  if (lease.liveLayoutRecheckTimer) clearTimeout(lease.liveLayoutRecheckTimer);
  lease.liveLayoutRecheckTimer = null;
  const check = {};
  lease.liveLayoutCheck = check;
  lease.liveLayoutCheckStale = false;
  const done = (width: unknown) => {
    if (lease.liveLayoutCheck !== check) return;
    lease.liveLayoutCheck = null;
    if (!isLive(lease) || guest.isDestroyed()) return;
    const layout = liveLayout(lease);
    // The zoom moved while the page answered; the next size starts over.
    if (!layout || !sameZoom(guest.getZoomFactor(), layout.zoom)) return;
    const verdict = inlineHtmlDemoLiveLayoutCheck(width, layout.expectedWidth);
    if (verdict.state === "pending") {
      if (lease.liveLayoutCheckStale) checkLiveLayout(lease, guest);
      else recheckLiveLayout(lease, guest);
      return;
    }
    if (verdict.state === "correct" && layout.correctable && lease.zoomCorrections < LIVE_ZOOM_CORRECTIONS) {
      lease.zoomCorrections += 1;
      lease.zoomCorrection *= verdict.factor;
      const corrected = liveLayout(lease);
      if (corrected) setLiveZoom(lease, guest, corrected.zoom, true);
      return;
    }
    lease.liveLayoutReady = true;
    sendLiveHeight(lease, guest, layout);
  };
  guest.executeJavaScriptInIsolatedWorld(INLINE_HTML_DEMO_LIVENESS_WORLD_ID, [{ code: INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT }])
    .then(done, () => {
      if (lease.liveLayoutCheck !== check) return;
      // No document to ask yet (the demo is still loading): ask again shortly.
      lease.liveLayoutCheck = null;
      if (isLive(lease) && !guest.isDestroyed()) recheckLiveLayout(lease, guest);
    });
}

function recheckLiveLayout(lease: InlineHtmlDemoLease, guest: WebContents): void {
  if (lease.liveLayoutRecheckTimer || lease.liveLayoutRechecks >= LIVE_LAYOUT_RECHECKS) return;
  lease.liveLayoutRechecks += 1;
  lease.liveLayoutRecheckTimer = setTimeout(() => {
    lease.liveLayoutRecheckTimer = null;
    if (isLive(lease) && !guest.isDestroyed() && !lease.liveLayoutReady) checkLiveLayout(lease, guest);
  }, LIVE_LAYOUT_RECHECK_MS);
}

/**
 * Follow the person's pointer over a live demo, in demo space, from the input
 * events main sees; the demo page cannot fake them. The listener hears null
 * when the pointer leaves, and when the demo goes away. Null for an unknown lease.
 */
export function watchInlineHtmlDemoPointer(
  rawUrl: unknown,
  listener: (pointer: InlineHtmlDemoPointer) => void,
): (() => void) | null {
  const lease = leaseFor(rawUrl);
  if (!lease) return null;
  lease.pointerWatchers.add(listener);
  return () => { lease.pointerWatchers.delete(listener); };
}

/**
 * The element under a point of a live demo, for a new pin: a CSS path the
 * page's author wrote (tag names, ids, classes), so an agent that reads the
 * pin finds what it is about. Main asks in its own world of the page, where
 * the page's scripts cannot change the lookup. Null when the demo is not laid
 * out live, the point is outside it, there is no element, or the page did not
 * answer in time (a pin saves without it).
 */
export async function inlineHtmlDemoAnchorAt(rawUrl: unknown, x: unknown, y: unknown): Promise<LiveDemoAnchor | null> {
  const lease = leaseFor(rawUrl);
  const guest = lease?.guest;
  if (!lease || !guest || guest.isDestroyed() || lease.frameWidth === null) return null;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > LIVE_DEMO.width || y < 0 || y > Math.min(LIVE_DEMO.maxHeight, lease.demoHeight ?? LIVE_DEMO.maxHeight)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    guest.executeJavaScriptInIsolatedWorld(INLINE_HTML_DEMO_LIVENESS_WORLD_ID, [{ code: inlineHtmlDemoAnchorScript(x, y) }])
      .catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INLINE_HTML_DEMO_ANCHOR_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  // The demo was released, replaced or left the live layout while it answered: its answer no longer names this point.
  return leaseFor(rawUrl) === lease && lease.guest === guest && lease.frameWidth !== null ? inlineHtmlDemoAnchor(answer) : null;
}

function leaseFor(rawUrl: unknown): InlineHtmlDemoLease | undefined {
  const host = inlineHtmlDemoLeaseHost(rawUrl);
  return host ? leases.get(host) : undefined;
}

function appZoom(lease: InlineHtmlDemoLease): number {
  const embedder = lease.embedder;
  return embedder && !embedder.isDestroyed() ? embedder.getZoomFactor() : 1;
}

function sameZoom(a: number, b: number): boolean {
  return Math.abs(a - b) < ZOOM_EPSILON;
}

/** A pointer report from the demo's own input: a point over it, or gone. */
function reportPointer(lease: InlineHtmlDemoLease, guest: WebContents, input: InputEvent): void {
  // Demo space exists only in the live layout.
  if (lease.frameWidth === null || lease.pointerWatchers.size === 0 || !isLive(lease)) return;
  const position = input as InputEvent & { x?: number; y?: number };
  const pointer = input.type === "mouseLeave"
    ? null
    : inlineHtmlDemoPointer(position.x, position.y, guest.getZoomFactor(), lease.demoHeight ?? LIVE_DEMO.maxHeight);
  if (!pointer) {
    pointerGone(lease);
    return;
  }
  lease.pointerOver = true;
  if (lease.hostWindow) lease.pointerSequence = ++lease.hostWindow.pointerSequence;
  for (const listener of lease.pointerWatchers) listener(pointer);
}

function pointerGone(lease: InlineHtmlDemoLease): void {
  if (!lease.pointerOver) return;
  lease.pointerOver = false;
  for (const listener of lease.pointerWatchers) listener(null);
}

/**
 * The pointer is over the app page or out of the window: a demo that reported
 * nothing newer than the app page's latest pointer event has lost it. The check
 * waits a moment, once, however often the pointer moves over the app page.
 */
function pointerLeftDemos(hostWindow: DemoHostWindow, now: boolean): void {
  hostWindow.appPagePointerSequence = ++hostWindow.pointerSequence;
  const check = () => {
    for (const lease of leases.values()) {
      if (lease.hostWindow === hostWindow && lease.pointerSequence < hostWindow.appPagePointerSequence) pointerGone(lease);
    }
  };
  if (now) {
    check();
    return;
  }
  hostWindow.pointerLeftTimer ??= setTimeout(() => {
    hostWindow.pointerLeftTimer = null;
    check();
  }, POINTER_LEFT_CHECK_MS);
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
  const demoHost: DemoHostWindow = {
    lastTabAt: Number.NEGATIVE_INFINITY,
    blurredAt: Number.NEGATIVE_INFINITY,
    focusedAt: Number.NEGATIVE_INFINITY,
    lastInputLease: null,
    pointerSequence: 0,
    appPagePointerSequence: 0,
    pointerLeftTimer: null,
  };
  // Tab in the app page may move focus into a demo; the page still gets the key.
  embedder.on("before-input-event", (_event, input) => {
    if ((input.type === "keyDown" || input.type === "rawKeyDown") && input.key === "Tab") demoHost.lastTabAt = Date.now();
  });
  // A click into a demo reaches only the demo, so input here is the person using the app page.
  embedder.on("input-event", (_event, input) => {
    if (PERSON_INPUT_TYPES.has(input.type)) demoHost.lastInputLease = null;
    if (input.type === "mouseMove" || input.type === "mouseLeave") pointerLeftDemos(demoHost, false);
  });
  // A hidden window has no pointer over it, and its demos hear no more input.
  hostWindow.on("hide", () => pointerLeftDemos(demoHost, true));
  hostWindow.on("minimize", () => pointerLeftDemos(demoHost, true));
  hostWindow.on("blur", () => {
    demoHost.blurredAt = Date.now();
    for (const lease of leases.values()) {
      if (lease.hostWindow === demoHost) lease.hadLastInputAtWindowBlur = demoHost.lastInputLease === lease;
    }
  });
  hostWindow.on("focus", () => { demoHost.focusedAt = Date.now(); });
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
    attaching = { lease, embedder, hostWindow: demoHost };
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
  const { lease, embedder, hostWindow } = current;
  const guestId = guest.id;
  lease.guest = guest;
  lease.embedder = embedder;
  lease.hostWindow = hostWindow;
  if (lease.attachTimer) clearTimeout(lease.attachTimer);
  lease.attachTimer = null;
  leasesByGuestId.set(guestId, lease);
  htmlDemoContents.set(guestId, lease.host);
  lockHtmlDemoContents(guest);
  // A load with no initiating frame comes from the app (a webview `src` or `loadURL`); one to
  // another URL would replace the demo. The page's own attempts are refused by will-navigate.
  guest.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument && !details.initiator && !details.url.startsWith(lease.url)) {
      stopGuest(lease, "crashed");
    }
  });
  const emitter: NodeJS.EventEmitter = guest;
  const boundAt = Date.now();
  const events = inlineHtmlDemoBucket(INLINE_HTML_DEMO_EVENT_BURST, INLINE_HTML_DEMO_EVENTS_PER_SECOND, boundAt);
  const text = inlineHtmlDemoBucket(INLINE_HTML_DEMO_TEXT_BURST, INLINE_HTML_DEMO_TEXT_PER_SECOND, boundAt);
  const countEvent = (...args: unknown[]) => {
    if (lease.stopped) return;
    const now = Date.now();
    const eventsLeft = takeInlineHtmlDemoTokens(events, 1, now);
    const textLeft = takeInlineHtmlDemoTokens(text, inlineHtmlDemoEventText(args), now);
    if (!eventsLeft || !textLeft) stopGuest(lease, "overloaded");
  };
  for (const name of FORWARDED_GUEST_EVENTS) emitter.on(name, countEvent);

  guest.setAudioMuted(true);
  let muted = true;
  guest.on("input-event", (_event: Event, input: InputEvent) => {
    if (input.type === "mouseMove" || input.type === "mouseWheel" || input.type === "mouseLeave") {
      reportPointer(lease, guest, input);
    }
    if (!PERSON_INPUT_TYPES.has(input.type)) return;
    lease.lastInputAt = Date.now();
    hostWindow.lastInputLease = lease;
    if (!muted) return;
    muted = false;
    guest.setAudioMuted(false);
  });
  // Electron 42 does not emit "focus" for a webview guest. Its own webview code
  // sends "-focus-change" from listeners in the guest page that do not check
  // isTrusted, so the page can fake it: each "true" is judged on its own and
  // never stored. A fake one costs only a needless "focus-refused".
  emitter.on("-focus-change", (_event: unknown, focused: unknown) => {
    if (focused === true) judgeDemoFocus(lease);
  });
  guest.on("focus", () => judgeDemoFocus(lease));
  guest.on("preferred-size-changed", (_event, size) => {
    if (lease.frameWidth === null) queueHeight(lease, inlineHtmlDemoHeight(size.height, appZoom(lease)));
    else liveSize(lease, guest, size.height);
  });
  // Each document the demo loads (a reload makes a new one) gets the live root rule again.
  guest.on("dom-ready", () => {
    lease.domReady = true;
    lease.rootLocked = false;
    lockLiveRoot(lease, guest);
  });
  guest.on("unresponsive", () => stopGuest(lease, "unresponsive"));
  guest.on("render-process-gone", () => stopGuest(lease, "crashed"));
  scheduleLivenessCheck(lease, guest);
  guest.once("destroyed", () => {
    if (hostWindow.lastInputLease === lease) hostWindow.lastInputLease = null;
    pointerGone(lease);
    lease.pointerWatchers.clear();
    leasesByGuestId.delete(guestId);
    htmlDemoContents.delete(guestId);
    endLease(lease);
    void htmlDemoSession()
      .then((ses) => ses.clearStorageData({ origin: lease.url.slice(0, -1) }))
      .catch(() => undefined);
  });
}

/**
 * Main hears a demo's input, the app's Tab and the window's focus in the order
 * they happened, which the app page cannot: a click into a demo never reaches it.
 */
function judgeDemoFocus(lease: InlineHtmlDemoLease): void {
  const hostWindow = lease.hostWindow;
  if (!hostWindow || lease.stopped || !isLive(lease)) return;
  const allowed = inlineHtmlDemoFocusAllowed({
    now: Date.now(),
    lastInputAt: lease.lastInputAt,
    lastTabAt: hostWindow.lastTabAt,
    hadLastInputAtWindowBlur: lease.hadLastInputAtWindowBlur,
    windowBlurredAt: hostWindow.blurredAt,
    windowFocusedAt: hostWindow.focusedAt,
  });
  if (!allowed) sendEvent(lease, { type: "focus-refused", url: lease.url });
}

/** A frozen, crashed or flooding demo reports once, gives up its lease, and is closed. */
function stopGuest(lease: InlineHtmlDemoLease, reason: StopReason): void {
  const guest = lease.guest;
  if (lease.stopped || !guest || !isLive(lease)) return;
  lease.stopped = true;
  sendEvent(lease, { type: "stopped", url: lease.url, reason });
  endLease(lease);
  // A flood queues its events ahead of any later task, so its process ends now.
  if (reason === "overloaded" && !guest.isCrashed()) guest.forcefullyCrashRenderer();
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
  for (const timer of [lease.attachTimer, lease.heightTimer, lease.livenessTimer, lease.liveLayoutRecheckTimer]) {
    if (timer) clearTimeout(timer);
  }
  lease.attachTimer = null;
  lease.heightTimer = null;
  lease.livenessTimer = null;
  lease.livenessCheck = null;
  lease.liveLayoutRecheckTimer = null;
  lease.liveLayoutCheck = null;
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
  const dueAt = Date.now() + INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS;
  lease.livenessTimer = setTimeout(() => {
    if (lease.livenessCheck !== check) return;
    // Main was blocked, so the answer may be waiting behind this timer: ask again instead.
    if (Date.now() - dueAt > INLINE_HTML_DEMO_LIVENESS_LATE_MS) checkLiveness(lease, guest);
    else stopGuest(lease, "unresponsive");
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
    htmlCacheBytes -= cached.byteLength;
    if (Date.now() - cached.cachedAt < INLINE_HTML_DEMO_CACHE_MS) {
      htmlCache.set(href, cached);
      htmlCacheBytes += cached.byteLength;
      return Promise.resolve(cached.html);
    }
  }
  const running = htmlLoads.get(href);
  if (running) return running;
  if (htmlLoads.size >= MAX_INLINE_HTML_DEMO_DOWNLOADS) {
    return Promise.reject(new Error(
      `At most ${MAX_INLINE_HTML_DEMO_DOWNLOADS} demo files can download at once. Try again in a moment.`,
    ));
  }
  const generation = htmlCacheGeneration;
  const download = new AbortController();
  const timer = setTimeout(
    () => download.abort(new Error("The demo file took too long to download.")),
    INLINE_HTML_DEMO_DOWNLOAD_MS,
  );
  const load = loadHtmlDemoAttachment(href, download.signal)
    .then(({ html, byteLength }) => {
      if (generation === htmlCacheGeneration) cacheHtml(href, html, byteLength);
      return html;
    })
    .finally(() => {
      clearTimeout(timer);
      if (htmlLoads.get(href) === load) htmlLoads.delete(href);
    });
  htmlLoads.set(href, load);
  return load;
}

function cacheHtml(href: string, html: string, byteLength: number): void {
  const previous = htmlCache.get(href);
  if (previous) htmlCacheBytes -= previous.byteLength;
  htmlCache.delete(href);
  htmlCache.set(href, { html, byteLength, cachedAt: Date.now() });
  htmlCacheBytes += byteLength;
  // Oldest first; one file is never over the byte cap, so the newest always stays.
  for (const [oldestHref, entry] of htmlCache) {
    if (htmlCache.size <= INLINE_HTML_DEMO_CACHE_ENTRIES && htmlCacheBytes <= INLINE_HTML_DEMO_CACHE_BYTES) break;
    htmlCache.delete(oldestHref);
    htmlCacheBytes -= entry.byteLength;
  }
}
