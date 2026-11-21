import type { WebPreferences } from "electron";

import type { DesktopPageThemeMode } from "../../ipc-types.js";
import { inlineHtmlDemoWebPreferences, lockGuestWebPreferences } from "../attachments/html-demo-policy.js";
import { pageProtocolScheme } from "#provider-runtime/paths.js";

/**
 * A room page is one HTML file a team pinned in its room. It runs in the
 * locks of an HTML demo with CDN loading off (no network, no permissions, no
 * Node, the offline demo CSP), whatever the demo setting says,
 * in its own session and on its own scheme. Unlike a demo it gets one preload,
 * which gives it `window.letagents` and talks to main over one channel.
 */
export const PAGE_PARTITION = "letagents-pages";
/** Live page leases main allows across the app; separate from the demo budget. */
export const MAX_ROOM_PAGES = 6;
/** A prepared page that no webview loads in this time is dropped. */
export const ROOM_PAGE_LEASE_MS = 30_000;
/** The server keeps at most 2 MB per page version; main refuses more than that. */
export const MAX_ROOM_PAGE_BYTES = 2 * 1024 * 1024;

/** The one IPC channel of the page bridge: calls from the page, and events main pushes to it. */
export const PAGE_CALL_CHANNEL = "page:call";
/** Calls a page may make: a burst, then this many a second. The server has its own limits. */
export const PAGE_CALL_BURST = 40;
export const PAGE_CALLS_PER_SECOND = 10;
/** The JSON text of one call's input. */
export const MAX_PAGE_CALL_INPUT_CHARS = 256 * 1024;
/** `ui.open` and `ui.copy` work this long after the person clicks, types or touches inside the page. */
export const PAGE_PERSON_INPUT_WINDOW_MS = 5_000;
/** One `ui.open` per lease in this time, asked or not. */
export const PAGE_OPEN_INTERVAL_MS = 2_000;
export const MAX_PAGE_COPY_CHARS = 100_000;
export const MAX_PAGE_OPEN_URL_CHARS = 2_048;

const PAGE_HOST = /^[0-9a-f]{32}$/;
const PAGE_METHOD = /^[a-z][a-z0-9_]{0,31}(\.[a-z][A-Za-z0-9_]{0,63}){1,2}$/;

/** The contract's one error shape (`shared/api/core.mjs` API_ERROR_CODES), as the page receives it. */
export type PageErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "not_granted"
  | "not_participant"
  | "not_found"
  | "no_source"
  | "source_unavailable"
  | "rate_limited"
  | "conflict"
  | "too_large"
  | "declined"
  | "pending_approval"
  | "internal";

export interface PageCallError {
  code: PageErrorCode;
  message: string;
  retryAfterMs?: number;
}

export type PageCallResult = { ok: true; value: unknown } | { ok: false; error: PageCallError };

export class PageCallFailure extends Error {
  constructor(readonly code: PageErrorCode, message: string, readonly retryAfterMs?: number) {
    super(message);
  }

  toError(): PageCallError {
    return this.retryAfterMs === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfterMs: this.retryAfterMs };
  }
}

/** Methods main answers itself; every other method goes to the API adapter. */
export const PAGE_BUILTIN_METHODS: ReadonlySet<string> = new Set([
  "page.get",
  "viewer.get",
  "ui.open",
  "ui.copy",
  "ui.theme",
  "ui.context",
  // Keep a read running: main re-runs it on room stream pointers and pushes each answer.
  "events.watch",
  "events.unwatch",
]);

export function isPageMethodName(value: unknown): value is string {
  return typeof value === "string" && PAGE_METHOD.test(value);
}

export function roomPageLeaseUrl(host: string): string {
  return `${pageProtocolScheme}://${host}/`;
}

/** The host of a page lease URL written exactly as main makes it, or null for anything else. */
export function roomPageLeaseHost(rawUrl: unknown): string | null {
  const prefix = `${pageProtocolScheme}://`;
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(prefix) || !rawUrl.endsWith("/")) return null;
  const host = rawUrl.slice(prefix.length, -1);
  return PAGE_HOST.test(host) ? host : null;
}

/**
 * The lease a `<webview>` attaches with: exactly a page lease URL, in the page
 * partition, and no webview used that lease before. Null passes it on.
 */
export function roomPageAttachLease(
  params: Readonly<Record<string, unknown>>,
  webPreferences: Readonly<{ partition?: unknown }>,
  leases: ReadonlyMap<string, { attached: boolean }>,
): string | null {
  const host = roomPageLeaseHost(params.src);
  if (!host || params.partition !== PAGE_PARTITION || webPreferences.partition !== PAGE_PARTITION) return null;
  return leases.get(host)?.attached === false ? host : null;
}

/** The demo locks in the page partition, with the page preload and no size reports. */
export function roomPageWebPreferences(preload: string): WebPreferences {
  return {
    ...inlineHtmlDemoWebPreferences(),
    partition: PAGE_PARTITION,
    // A page fills its tab, so main needs no preferred size from it.
    enablePreferredSizeMode: false,
    preload,
  };
}

/** Replace a page guest's web preferences in place; only the app's zoom carries over. */
export function lockRoomPageWebPreferences(webPreferences: WebPreferences, preload: string): WebPreferences {
  return lockGuestWebPreferences(webPreferences, roomPageWebPreferences(preload));
}

/** An https URL a page may ask the system browser to open, and its domain; null for anything else. */
export function pageOpenTarget(rawUrl: unknown): { url: string; domain: string } | null {
  if (typeof rawUrl !== "string" || rawUrl.length > MAX_PAGE_OPEN_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // A user name in the link could make the domain shown in the sheet look like another site.
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return { url: url.toString(), domain: url.hostname.toLowerCase() };
}

/**
 * The colours a page can use through `ui.theme` and the `--la-*` CSS variables,
 * the app's own values from the renderer's base styles.
 */
export const PAGE_THEME_TOKENS: Readonly<Record<DesktopPageThemeMode, Readonly<Record<string, string>>>> = {
  light: {
    "--la-bg": "#ffffff",
    "--la-bg-subtle": "#fafafa",
    "--la-bg-card": "#f4f4f5",
    "--la-bg-elevated": "#ffffff",
    "--la-text": "#09090b",
    "--la-text-secondary": "#52525b",
    "--la-text-muted": "#71717a",
    "--la-border": "rgba(0, 0, 0, 0.08)",
    "--la-border-strong": "rgba(0, 0, 0, 0.15)",
    "--la-accent": "#2563eb",
    "--la-accent-text": "#1d4ed8",
    "--la-green": "#15803d",
    "--la-amber": "#92400e",
    "--la-red": "#b91c1c",
    "--la-font-sans": "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
    "--la-font-mono": "\"SF Mono\", \"Fira Code\", \"Cascadia Code\", monospace",
    "--la-radius": "8px",
  },
  dark: {
    "--la-bg": "#0a0a0a",
    "--la-bg-subtle": "#111111",
    "--la-bg-card": "#141414",
    "--la-bg-elevated": "#1a1a1a",
    "--la-text": "#fafafa",
    "--la-text-secondary": "#a1a1aa",
    "--la-text-muted": "#8d8d97",
    "--la-border": "rgba(255, 255, 255, 0.06)",
    "--la-border-strong": "rgba(255, 255, 255, 0.12)",
    "--la-accent": "#3b82f6",
    "--la-accent-text": "#60a5fa",
    "--la-green": "#4ade80",
    "--la-amber": "#fbbf24",
    "--la-red": "#f87171",
    "--la-font-sans": "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
    "--la-font-mono": "\"SF Mono\", \"Fira Code\", \"Cascadia Code\", monospace",
    "--la-radius": "8px",
  },
};

export interface PageTheme {
  mode: DesktopPageThemeMode;
  tokens: Record<string, string>;
}

export function pageTheme(mode: DesktopPageThemeMode): PageTheme {
  return { mode, tokens: { ...PAGE_THEME_TOKENS[mode] } };
}

export function isPageThemeMode(value: unknown): value is DesktopPageThemeMode {
  return value === "light" || value === "dark";
}
