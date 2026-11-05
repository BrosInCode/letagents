import type {
  DesktopInlineHtmlDemoEvent,
  DesktopRoomMessageAttachment,
} from "../../../../../../electron/ipc-types";
import { formatBytes } from "../attachments/formatting";

export function formatDisplayBytes(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : "";
}

export function attachmentName(attachment: DesktopRoomMessageAttachment): string {
  return attachment.fileName;
}

export function attachmentMimeType(attachment: DesktopRoomMessageAttachment): string {
  return attachment.mimeType;
}

export function attachmentHref(attachment: DesktopRoomMessageAttachment): string {
  return attachment.href || "#";
}

export function attachmentKey(attachment: DesktopRoomMessageAttachment): string {
  return attachment.id || `${attachmentName(attachment)}-${attachment.sizeBytes || 0}-${attachmentMimeType(attachment)}`;
}

export function imageAttachmentId(messageId: string, attachment: DesktopRoomMessageAttachment): string {
  return `${messageId}:${attachmentKey(attachment)}`;
}

export function attachmentMeta(attachment: DesktopRoomMessageAttachment): string {
  return [attachmentMimeType(attachment), formatBytes(attachment.sizeBytes || 0)].filter(Boolean).join(" · ");
}

export function attachmentDisplayMeta(attachment: DesktopRoomMessageAttachment): string {
  return [
    attachmentMimeType(attachment),
    formatDisplayBytes(attachment.sizeBytes || 0),
  ].filter(Boolean).join(" · ");
}

export function isImageAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith("image/") && attachmentHref(attachment) !== "#";
}

/**
 * An HTML file runs as an interactive demo, inside its message or in its own
 * locked window. Files agents attached before HTML had a type arrive as
 * octet-stream, so the name decides.
 */
export function isHtmlDemoAttachment(attachment: DesktopRoomMessageAttachment): boolean {
  const href = attachmentHref(attachment);
  if (!href.startsWith("letagents-attachment://")) return false;
  const mimeType = attachmentMimeType(attachment).toLowerCase();
  return mimeType === "text/html"
    || mimeType === "application/xhtml+xml"
    || (mimeType === "application/octet-stream" && /\.html?$/i.test(attachmentName(attachment)));
}

/** Main's reason for a failure, without Electron's IPC wrapper; `fallback` when it gave none. */
export function ipcErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
  return text || fallback;
}

/** Main's reason a demo did not open, without Electron's IPC wrapper. */
export function htmlDemoErrorText(error: unknown): string {
  return ipcErrorText(error, "The demo could not open.");
}

const INLINE_DEMO_DEFAULT_HEIGHT = 240;
const INLINE_DEMO_MIN_HEIGHT = 120;
const INLINE_DEMO_MAX_HEIGHT = 560;

/**
 * How tall the demo's frame is for the page height main last reported
 * (`null` before the first report). A taller page scrolls inside the frame.
 */
export function inlineDemoFrameHeight(contentHeight: number | null): number {
  if (contentHeight === null || !Number.isFinite(contentHeight)) return INLINE_DEMO_DEFAULT_HEIGHT;
  return Math.min(INLINE_DEMO_MAX_HEIGHT, Math.max(INLINE_DEMO_MIN_HEIGHT, Math.round(contentHeight)));
}

/** How soon after an element loses focus a refused demo may hand it back. */
export const INLINE_DEMO_FOCUS_RESTORE_MS = 1_000;

/**
 * When main refuses a demo's focus, the element that lost focus to it gets focus
 * back: only if it is still in the page and lost focus no more than a second ago.
 */
export function inlineDemoFocusToRestore<T extends { isConnected: boolean }>(
  left: { element: T; at: number } | null,
  now: number,
): T | null {
  if (!left?.element.isConnected) return null;
  const age = now - left.at;
  return age >= 0 && age <= INLINE_DEMO_FOCUS_RESTORE_MS ? left.element : null;
}

export type InlineDemoStopReason = Extract<DesktopInlineHtmlDemoEvent, { type: "stopped" }>["reason"];

/** What a stopped demo tells the person, by the reason main (or the webview) gave. */
export function inlineDemoStoppedText(reason: InlineDemoStopReason): string {
  return reason === "overloaded"
    ? "This demo was stopped because it slowed down the app."
    : "This demo stopped responding.";
}

const INLINE_DEMO_RESTART_LIMIT = 2;
const INLINE_DEMO_RESTART_WINDOW_MS = 30_000;

/**
 * A demo whose guest vanished is started again by itself, but not in a loop:
 * after two restarts in 30 s it stays stopped until the person reloads it.
 */
export function inlineDemoMayRestart(now: number, restartedAt: readonly number[]): boolean {
  return restartedAt.filter((at) => now - at >= 0 && now - at < INLINE_DEMO_RESTART_WINDOW_MS).length
    < INLINE_DEMO_RESTART_LIMIT;
}
