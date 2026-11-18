/** Entries main keeps per page version; the oldest go first. */
export const PAGE_DIAGNOSTICS_ENTRIES = 200;
/** Page versions main keeps entries for; the least recently written go first. */
export const PAGE_DIAGNOSTICS_PAGES = 32;
export const MAX_PAGE_DIAGNOSTIC_TEXT = 2_000;
/** Writes main keeps per page version: a burst, then this many a second. The rest are only counted. */
export const PAGE_DIAGNOSTIC_WRITE_BURST = 20;
export const PAGE_DIAGNOSTIC_WRITES_PER_SECOND = 5;

export type PageDiagnostic =
  | { kind: "console"; at: string; level: "warning" | "error"; message: string; source: string; line: number }
  | { kind: "crash"; at: string; reason: string }
  | { kind: "call"; at: string; method: string; code: string; message: string }
  /** Entries main did not keep because the page wrote too fast, since the last kept one. */
  | { kind: "dropped"; at: string; count: number };

/** One page version in one room, the unit an agent reads diagnostics for. */
export interface PageDiagnosticsKey {
  roomId: string;
  pageId: string;
  version: number;
}

type PageDiagnosticInput =
  | Omit<Extract<PageDiagnostic, { kind: "console" }>, "at">
  | Omit<Extract<PageDiagnostic, { kind: "crash" }>, "at">
  | Omit<Extract<PageDiagnostic, { kind: "call" }>, "at">;

const buffers = new Map<string, PageDiagnostic[]>();
const writeRates = new Map<string, { tokens: number; updatedAt: number; dropped: number }>();

function keyOf(key: PageDiagnosticsKey): string {
  return JSON.stringify([key.roomId, key.pageId, key.version]);
}

function clip(text: unknown): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value.length > MAX_PAGE_DIAGNOSTIC_TEXT ? `${value.slice(0, MAX_PAGE_DIAGNOSTIC_TEXT)}…` : value;
}

/**
 * Keep one console warning or error, crash, or failed call of a page. The
 * text comes from the page, so it is clipped and never interpreted.
 */
export function recordPageDiagnostic(key: PageDiagnosticsKey, entry: PageDiagnosticInput, now = Date.now()): void {
  const id = keyOf(key);
  const rate = writeRates.get(id) ?? { tokens: PAGE_DIAGNOSTIC_WRITE_BURST, updatedAt: now, dropped: 0 };
  writeRates.set(id, rate);
  rate.tokens = Math.min(PAGE_DIAGNOSTIC_WRITE_BURST, rate.tokens + (Math.max(0, now - rate.updatedAt) * PAGE_DIAGNOSTIC_WRITES_PER_SECOND) / 1000);
  rate.updatedAt = Math.max(rate.updatedAt, now);
  // A page that logs or fails in a loop costs main a counter, not a string copy each time.
  if (rate.tokens < 1) {
    rate.dropped += 1;
    return;
  }
  rate.tokens -= 1;
  const buffer = buffers.get(id) ?? [];
  // Re-inserting keeps the map in least-recently-written order.
  buffers.delete(id);
  buffers.set(id, buffer);
  const at = new Date(now).toISOString();
  if (rate.dropped > 0) {
    buffer.push({ kind: "dropped", at, count: rate.dropped });
    rate.dropped = 0;
  }
  if (entry.kind === "console") {
    buffer.push({ ...entry, at, message: clip(entry.message), source: clip(entry.source) });
  } else if (entry.kind === "crash") {
    buffer.push({ ...entry, at, reason: clip(entry.reason) });
  } else {
    buffer.push({ ...entry, at, method: clip(entry.method), message: clip(entry.message) });
  }
  if (buffer.length > PAGE_DIAGNOSTICS_ENTRIES) buffer.splice(0, buffer.length - PAGE_DIAGNOSTICS_ENTRIES);
  for (const oldest of buffers.keys()) {
    if (buffers.size <= PAGE_DIAGNOSTICS_PAGES) break;
    buffers.delete(oldest);
    writeRates.delete(oldest);
  }
}

/** A copy of what main holds for one page version, oldest first. */
export function readPageDiagnostics(key: PageDiagnosticsKey): PageDiagnostic[] {
  return [...(buffers.get(keyOf(key)) ?? [])];
}

/**
 * Hand over and forget what main holds for one page version, for an upload.
 * An upload that fails can give the entries back with `restorePageDiagnostics`.
 */
export function takePageDiagnostics(key: PageDiagnosticsKey): PageDiagnostic[] {
  const id = keyOf(key);
  const entries = buffers.get(id) ?? [];
  buffers.delete(id);
  return entries;
}

/** Put entries back in front of newer ones, after an upload that failed. */
export function restorePageDiagnostics(key: PageDiagnosticsKey, entries: readonly PageDiagnostic[]): void {
  if (entries.length === 0) return;
  const id = keyOf(key);
  const merged = [...entries, ...(buffers.get(id) ?? [])].slice(-PAGE_DIAGNOSTICS_ENTRIES);
  buffers.set(id, merged);
}

export function clearPageDiagnosticsForTest(): void {
  buffers.clear();
  writeRates.clear();
}
