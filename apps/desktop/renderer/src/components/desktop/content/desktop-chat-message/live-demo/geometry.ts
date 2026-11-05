import { LIVE_DEMO, type LiveDemoPoint } from "./protocol";

/** A live card is never shorter than this, so its status text and buttons fit. */
export const LIVE_MIN_FRAME_HEIGHT = 120;
/** The demo's height, in demo px, until main reports one (times the scale gives the frame). */
export const LIVE_DEFAULT_DEMO_HEIGHT = 320;
/** The scale to lay a card out with before its width is measured: a typical chat card. */
export const LIVE_FALLBACK_SCALE = 0.6;
/** A card taller than this is clipped, with a "Show all" button. */
export const LIVE_CLIP_AT = 800;
/** A card at most this much taller than the clip shows in full: a clip for a few pixels is noise. */
export const LIVE_CLIP_SLACK = 40;
/** Narrower than this, the frame is not measured yet (or the card is hidden). */
export const LIVE_MIN_FRAME_WIDTH = 80;

/**
 * How much the demo is scaled to fit a frame this wide (CSS px). The demo is laid
 * out at LIVE_DEMO.width and is never enlarged. `null` while the frame has no width.
 */
export function liveScale(frameWidth: number): number | null {
  if (!Number.isFinite(frameWidth) || frameWidth < LIVE_MIN_FRAME_WIDTH) return null;
  return Math.min(1, frameWidth / LIVE_DEMO.width);
}

/**
 * A height main reports for a live layout. Main measures the scaled page, so it is
 * already in frame px (CSS px of the app); keep it to what a demo may have.
 */
export function liveReportedHeight(reported: number): number {
  if (!Number.isFinite(reported)) return LIVE_MIN_FRAME_HEIGHT;
  return Math.min(LIVE_DEMO.maxHeight, Math.max(1, Math.round(reported)));
}

/** The frame's height (CSS px): what main reported for the scaled page, or a default until it does. */
export function liveFrameHeight(reported: number | null, scale: number): number {
  const height = reported === null ? Math.round(LIVE_DEFAULT_DEMO_HEIGHT * scale) : reported;
  return Math.max(LIVE_MIN_FRAME_HEIGHT, height);
}

/**
 * A live card shows its page only after main has laid it out at the live width
 * (it answered with a scale) and has sent the page's scaled height. Before
 * that, the page would show at the wrong size, and the frame would change height
 * when the first height came.
 */
export function liveLayoutReady(state: { liveLayout: boolean; scaleApplied: boolean; heightReported: boolean }): boolean {
  return !state.liveLayout || (state.scaleApplied && state.heightReported);
}

export interface LiveClip {
  /** The card is taller than the clip, so the toggle shows. */
  clippable: boolean;
  /** The clip is on right now. */
  clipped: boolean;
  /** How tall the card shows (CSS px). */
  visibleHeight: number;
}

export function liveClip(frameHeight: number, showAll: boolean): LiveClip {
  const clippable = frameHeight > LIVE_CLIP_AT + LIVE_CLIP_SLACK;
  const clipped = clippable && !showAll;
  return { clippable, clipped, visibleHeight: clipped ? LIVE_CLIP_AT : frameHeight };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Keeps a point inside what the protocol accepts, to a tenth of a pixel. */
export function clampDemoPoint(x: number, y: number): LiveDemoPoint {
  return [
    round1(Math.min(LIVE_DEMO.width, Math.max(0, Number.isFinite(x) ? x : 0))),
    round1(Math.min(LIVE_DEMO.maxHeight, Math.max(0, Number.isFinite(y) ? y : 0))),
  ];
}

/** A spot in the frame (CSS px from its top left) as a point in demo space. */
export function frameToDemo(offsetX: number, offsetY: number, scale: number): LiveDemoPoint {
  return clampDemoPoint(offsetX / scale, offsetY / scale);
}

/** A point in demo space as a spot in the frame (CSS px from its top left). */
export function demoToFrame(point: readonly [number, number], scale: number): [x: number, y: number] {
  return [point[0] * scale, point[1] * scale];
}

const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_AREA = 16_000_000;

/**
 * The backing store for a canvas that covers a frame. A tall demo at a high
 * pixel ratio would be too big for the browser, so the ratio drops instead.
 */
export function canvasBacking(
  width: number,
  height: number,
  pixelRatio: number,
): { pixelWidth: number; pixelHeight: number; ratio: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const wanted = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const ratio = Math.max(
    0.1,
    Math.min(wanted, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h))),
  );
  return { pixelWidth: Math.max(1, Math.floor(w * ratio)), pixelHeight: Math.max(1, Math.floor(h * ratio)), ratio };
}
