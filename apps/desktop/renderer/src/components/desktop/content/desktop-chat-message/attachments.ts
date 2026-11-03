import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
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

/** Main's reason a demo did not open, without Electron's IPC wrapper. */
export function htmlDemoErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
  return text || "The demo could not open.";
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

/** How long a click or Tab key press counts as the reason a demo took focus. */
export const INLINE_DEMO_FOCUS_INTENT_MS = 1_000;

export interface InlineDemoFocusFacts {
  /** `performance.now()` when the focus event arrived. */
  now: number;
  /** When the person last pressed a pointer button on the demo, if ever. */
  pointerDownAt: number | null;
  /** When the person last pressed Tab, if ever. */
  tabKeyAt: number | null;
  /** The person already gave the demo focus; the window coming back may focus it again. */
  holdsFocus: boolean;
}

/** True when `at` is not in the future and at most the focus window before `now`. */
export function withinInlineDemoFocusWindow(now: number, at: number | null): boolean {
  return at !== null && now - at >= 0 && now - at <= INLINE_DEMO_FOCUS_INTENT_MS;
}

/** A demo takes focus only because the person just clicked it or tabbed to it. */
export function inlineDemoMayTakeFocus(facts: InlineDemoFocusFacts): boolean {
  return facts.holdsFocus
    || withinInlineDemoFocusWindow(facts.now, facts.pointerDownAt)
    || withinInlineDemoFocusWindow(facts.now, facts.tabKeyAt);
}
