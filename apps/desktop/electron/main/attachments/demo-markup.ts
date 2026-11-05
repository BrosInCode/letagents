import type { BrowserWindow, Rectangle } from "electron";

import type { DesktopStagedAttachment } from "../../ipc-types.js";
import { resolveAttachmentStore } from "../attachments.js";
import { attachmentFile } from "./store.js";

/** The longest side of a captured picture in pixels; a larger capture is scaled down to it. */
export const DEMO_MARKUP_MAX_SIDE = 2400;
const DEFAULT_FILE_NAME = "demo-marks.png";

/**
 * The part of the window to capture, in window points. The chat measures in
 * its CSS px (getBoundingClientRect); `capturePage` takes points, which the
 * app's zoom scales (measured in Electron 42: at zoom 1.25 a 200 point
 * rectangle holds 160 CSS px). Cut to the window; null when nothing is left.
 */
export function demoMarkupCaptureRect(
  rect: unknown,
  appZoom: number,
  windowSize: { width: number; height: number },
): Rectangle | null {
  if (!rect || typeof rect !== "object") return null;
  const { x, y, width, height } = rect as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  // The chat cuts the card to what is visible; nothing visible is nothing to send.
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  const zoom = Number.isFinite(appZoom) && appZoom > 0 ? appZoom : 1;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const left = clamp(Math.floor((x as number) * zoom), windowSize.width);
  const top = clamp(Math.floor((y as number) * zoom), windowSize.height);
  const right = clamp(Math.ceil(((x as number) + (width as number)) * zoom), windowSize.width);
  const bottom = clamp(Math.ceil(((y as number) + (height as number)) * zoom), windowSize.height);
  return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** A plain file name ending in .png; no folders, no control characters. */
export function demoMarkupFileName(raw: unknown): string {
  const cleaned = typeof raw === "string"
    ? raw.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "").replace(/[\\/:*?"<>|]/g, "-").trim()
    : "";
  const base = cleaned.replace(/\.png$/i, "").replace(/^\.+/, "").slice(0, 120).trim();
  return base ? `${base}.png` : DEFAULT_FILE_NAME;
}

/**
 * A picture of part of the app window (a demo with its marks; Electron 42
 * captures the webview's pixels and the chat drawn over it), staged as a PNG
 * attachment for the next message in `room`, as a picked image is. The staged
 * attachment carries its preview, which the chat shows before the person
 * decides to post it.
 */
export async function captureDesktopDemoMarkup(
  appWindow: BrowserWindow,
  room: unknown,
  rawRect: unknown,
  rawFileName: unknown,
): Promise<DesktopStagedAttachment> {
  if (appWindow.isDestroyed()) throw new Error("The app window is closed.");
  if (typeof room !== "string" || !room.trim()) throw new Error("Choose a room first.");
  const contents = appWindow.webContents;
  const [width, height] = appWindow.getContentSize();
  const rect = demoMarkupCaptureRect(rawRect, contents.getZoomFactor(), { width: width ?? 0, height: height ?? 0 });
  if (!rect) throw new Error("The demo is not on screen.");
  let image = await contents.capturePage(rect);
  if (image.isEmpty()) throw new Error("The demo could not be captured. Show the app window and try again.");
  const size = image.getSize();
  if (Math.max(size.width, size.height) > DEMO_MARKUP_MAX_SIDE) {
    image = image.resize(size.width >= size.height
      ? { width: DEMO_MARKUP_MAX_SIDE, quality: "good" }
      : { height: DEMO_MARKUP_MAX_SIDE, quality: "good" });
  }
  const store = await resolveAttachmentStore(room);
  return store.stage(attachmentFile({ fileName: demoMarkupFileName(rawFileName), mimeType: "image/png", bytes: image.toPNG() }));
}
