import type { BrowserWindow as ElectronBrowserWindow, Event, InputEvent, WebContents, WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  DesktopPageThemeMode,
  DesktopRoomPage,
  DesktopRoomPageEvent,
  DesktopRoomPageLease,
} from "../../ipc-types.js";
import { watchGuestEventFlood } from "../attachments/guest-event-flood.js";
import { inlineHtmlDemoBucket, type InlineHtmlDemoBucket } from "../attachments/html-demo-policy.js";
import { lockHtmlDemoContents } from "../attachments/html-demo-session.js";
import { addWebviewRoute } from "../attachments/webview-router.js";
import { electronMainDir } from "../paths.js";
import type { RoomPageSource } from "./page-adapter.js";
import { recordPageDiagnostic } from "./page-diagnostics.js";
import {
  lockRoomPageWebPreferences,
  MAX_ROOM_PAGE_BYTES,
  MAX_ROOM_PAGES,
  PAGE_CALL_BURST,
  PAGE_CALL_CHANNEL,
  PAGE_CALLS_PER_SECOND,
  PAGE_PARTITION,
  pageTheme,
  isPageThemeMode,
  roomPageAttachLease,
  ROOM_PAGE_LEASE_MS,
  roomPageLeaseHost,
  roomPageLeaseUrl,
  type PageTheme,
} from "./page-policy.js";
import { roomPageContents, roomPageDocuments, roomPageSession } from "./page-session.js";

export const ROOM_PAGE_EVENT_CHANNEL = "desktop:pages:event";
/** The bridge preload; tsc writes `electron/page-preload.cts` as CommonJS, which a sandboxed preload must be. */
export const ROOM_PAGE_PRELOAD_PATH = join(electronMainDir, "page-preload.cjs");

/** A click, key or touch the person makes in a page; the page cannot fake one. */
const PERSON_INPUT_TYPES = new Set<InputEvent["type"]>(["mouseDown", "rawKeyDown", "keyDown", "touchStart"]);
const MAX_ID_LENGTH = 200;

type StopReason = DesktopRoomPageEvent["reason"];

/** One page in one room tab. It lives while the tab's room is open, not only while it is in view. */
export interface RoomPageLease {
  host: string;
  url: string;
  roomId: string;
  page: DesktopRoomPage;
  /** A webview claimed this lease; no other webview can. */
  attached: boolean;
  guest: WebContents | null;
  embedder: WebContents | null;
  stopped: boolean;
  attachTimer: ReturnType<typeof setTimeout> | null;
  /** The person's last click, key or touch inside this page, as main saw it. */
  lastInputAt: number;
  /** The page's calls over the bridge. */
  calls: InlineHtmlDemoBucket;
}

const leases = new Map<string, RoomPageLease>();
const leasesByGuestId = new Map<number, RoomPageLease>();
let themeMode: DesktopPageThemeMode = "dark";
let configured: {
  source: RoomPageSource;
  /** Called once when a lease ends, however it ends. */
  onLeaseEnd?: (lease: RoomPageLease) => void;
} | null = null;

/** Where pages come from, and what else must end with a lease. Set once by the IPC registrar. */
export function configureRoomPages(input: NonNullable<typeof configured>): void {
  configured = input;
}

function cleanId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH) throw new Error(`The ${label} is missing.`);
  return value.trim();
}

function assertLeaseAvailable(): void {
  if (leases.size >= MAX_ROOM_PAGES) {
    throw new Error(`At most ${MAX_ROOM_PAGES} room pages can be open at once. Close a room with pages first.`);
  }
}

/** The pinned pages of a room, in tab order. */
export async function listRoomPages(rawRoomId: unknown): Promise<DesktopRoomPage[]> {
  if (!configured) return [];
  return configured.source.list(cleanId(rawRoomId, "room"));
}

/** Load a page for a `<webview>` in its room tab; the lease admits one webview, once. */
export async function prepareRoomPage(rawRoomId: unknown, rawPageId: unknown): Promise<DesktopRoomPageLease> {
  const roomId = cleanId(rawRoomId, "room");
  const pageId = cleanId(rawPageId, "page");
  if (!configured) throw new Error("Room pages are not available in this app yet.");
  assertLeaseAvailable();
  // The page session is locked before any lease exists, so no page loads without the locks.
  await roomPageSession();
  const { page, html } = await configured.source.load(roomId, pageId);
  if (Buffer.byteLength(html, "utf8") > MAX_ROOM_PAGE_BYTES) throw new Error("This page is larger than 2 MB, so it does not open.");
  // Other pages may have taken the free leases while this one downloaded.
  assertLeaseAvailable();
  const host = randomUUID().replaceAll("-", "");
  const now = Date.now();
  const lease: RoomPageLease = {
    host,
    url: roomPageLeaseUrl(host),
    roomId,
    page,
    attached: false,
    guest: null,
    embedder: null,
    stopped: false,
    attachTimer: null,
    lastInputAt: Number.NEGATIVE_INFINITY,
    calls: inlineHtmlDemoBucket(PAGE_CALL_BURST, PAGE_CALLS_PER_SECOND, now),
  };
  lease.attachTimer = setTimeout(() => {
    if (!lease.guest) endLease(lease);
  }, ROOM_PAGE_LEASE_MS);
  roomPageDocuments.set(host, html);
  leases.set(host, lease);
  return { url: lease.url, partition: PAGE_PARTITION, page };
}

/** Free a lease and its document, and close its page if one runs. Unknown URLs are ignored. */
export function releaseRoomPage(rawUrl: unknown): void {
  const host = roomPageLeaseHost(rawUrl);
  const lease = host ? leases.get(host) : undefined;
  if (!lease) return;
  endLease(lease);
  if (lease.guest && !lease.guest.isDestroyed()) lease.guest.close();
}

/**
 * The live page lease of a bridge call's sender: a page guest main bound, from
 * its main frame. Null for anything else, the app window and demos included.
 */
export function roomPageLeaseForSender(sender: WebContents | null | undefined, frame: WebFrameMain | null | undefined): RoomPageLease | null {
  if (!sender) return null;
  const lease = leasesByGuestId.get(sender.id);
  if (!lease || lease.guest !== sender || lease.stopped || !isLive(lease) || sender.isDestroyed()) return null;
  if (!frame || frame !== sender.mainFrame) return null;
  return lease;
}

export function currentRoomPageTheme(): PageTheme {
  return pageTheme(themeMode);
}

/** The app's light or dark mode, from the app window; every open page hears the change. */
export function setRoomPageTheme(mode: unknown): void {
  if (!isPageThemeMode(mode) || mode === themeMode) return;
  themeMode = mode;
  const theme = currentRoomPageTheme();
  for (const lease of leases.values()) {
    const guest = lease.guest;
    if (guest && !guest.isDestroyed() && !lease.stopped) guest.send(PAGE_CALL_CHANNEL, { event: "theme", value: theme });
  }
}

/**
 * Let the app window show room pages. A `<webview>` attaches as a page only
 * with a lease from `prepareRoomPage`, and only a page gets the bridge preload.
 */
export function installRoomPageHost(hostWindow: ElectronBrowserWindow): void {
  const embedder = hostWindow.webContents;
  addWebviewRoute(embedder, {
    claim(webPreferences, params) {
      const host = roomPageAttachLease(params, webPreferences, leases);
      const lease = host ? leases.get(host) : undefined;
      if (!lease) return null;
      lockRoomPageWebPreferences(webPreferences, ROOM_PAGE_PRELOAD_PATH);
      params.src = lease.url;
      delete params.allowpopups;
      lease.attached = true;
      return { bind: (guest) => bindGuest(guest, lease, embedder) };
    },
    owns: (guest) => leasesByGuestId.get(guest.id)?.guest === guest,
  });
}

/** Lock a just-created page guest before it loads anything, and tie it to its lease. */
function bindGuest(guest: WebContents, lease: RoomPageLease, embedder: WebContents): void {
  const guestId = guest.id;
  lease.guest = guest;
  lease.embedder = embedder;
  if (lease.attachTimer) clearTimeout(lease.attachTimer);
  lease.attachTimer = null;
  leasesByGuestId.set(guestId, lease);
  roomPageContents.set(guestId, lease.host);
  lockHtmlDemoContents(guest);
  // A load with no initiating frame comes from the app (a webview `src` or `loadURL`); one to
  // another URL would replace the page. The page's own attempts are refused by will-navigate.
  guest.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument && !details.initiator && !details.url.startsWith(lease.url)) {
      stopGuest(lease, "crashed");
    }
  });
  watchGuestEventFlood(guest, () => lease.stopped, () => stopGuest(lease, "overloaded"));
  guest.on("input-event", (_event: Event, input: InputEvent) => {
    if (PERSON_INPUT_TYPES.has(input.type)) lease.lastInputAt = Date.now();
  });
  guest.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") return;
    recordPageDiagnostic(diagnosticsKey(lease), {
      kind: "console",
      level: details.level,
      message: details.message,
      source: details.sourceId,
      line: details.lineNumber,
    });
  });
  // A page stays open while its room is; only a hung or crashed process stops it.
  guest.on("unresponsive", () => stopGuest(lease, "unresponsive"));
  guest.on("render-process-gone", (_event, details) => {
    recordPageDiagnostic(diagnosticsKey(lease), { kind: "crash", reason: details.reason });
    stopGuest(lease, "crashed");
  });
  guest.once("destroyed", () => {
    leasesByGuestId.delete(guestId);
    roomPageContents.delete(guestId);
    endLease(lease);
    void roomPageSession()
      .then((ses) => ses.clearStorageData({ origin: lease.url.slice(0, -1) }))
      .catch(() => undefined);
  });
}

export function diagnosticsKey(lease: RoomPageLease) {
  return { roomId: lease.roomId, pageId: lease.page.id, version: lease.page.version };
}

/** A hung, crashed or flooding page reports once, gives up its lease, and is closed. */
function stopGuest(lease: RoomPageLease, reason: StopReason): void {
  const guest = lease.guest;
  if (lease.stopped || !guest || !isLive(lease)) return;
  lease.stopped = true;
  if (reason === "unresponsive") recordPageDiagnostic(diagnosticsKey(lease), { kind: "crash", reason: "unresponsive" });
  const event: DesktopRoomPageEvent = { type: "stopped", url: lease.url, reason };
  const embedder = lease.embedder;
  if (embedder && !embedder.isDestroyed()) embedder.send(ROOM_PAGE_EVENT_CHANNEL, event);
  endLease(lease);
  // A flood queues its events ahead of any later task, so its process ends now.
  if (reason === "overloaded" && !guest.isCrashed()) guest.forcefullyCrashRenderer();
  // Not inside the guest's own event: closing a guest deletes it at once.
  setImmediate(() => {
    if (guest.isDestroyed()) return;
    if (!guest.isCrashed()) guest.forcefullyCrashRenderer();
    guest.close();
  });
}

/** Every way a lease ends comes through here, so no timer or open sheet outlives it. */
function endLease(lease: RoomPageLease): void {
  if (lease.attachTimer) clearTimeout(lease.attachTimer);
  lease.attachTimer = null;
  if (!isLive(lease)) return;
  leases.delete(lease.host);
  roomPageDocuments.delete(lease.host);
  configured?.onLeaseEnd?.(lease);
}

function isLive(lease: RoomPageLease): boolean {
  return leases.get(lease.host) === lease;
}
