/*
 * A small dotted canvas orb whose motion says what an agent is doing.
 *
 * The approach (monochrome dots on a plain 2D canvas, one shared clock, a
 * pause while hidden or offscreen, a still frame under reduced motion, and
 * the searching / working / composing / breathing states) is ported from
 * thinking-orbs (https://libraries.dev/orbs, npm "thinking-orbs"):
 *
 * MIT License
 *
 * Copyright (c) 2026 Jakub Antalik
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ActivityOrbState } from "../../../../domain/activity-orb-state";

export type { ActivityOrbState } from "../../../../domain/activity-orb-state";

export const ACTIVITY_ORB_LABELS: Record<ActivityOrbState, string> = {
  searching: "Searching",
  working: "Working",
  composing: "Writing",
  breathing: "Waiting",
};

/**
 * The least time between two drawn frames: 30 fps. The 1 ms slack keeps a
 * 60 Hz display on every second frame when its frame times jitter.
 */
export const ACTIVITY_ORB_FRAME_MS = 1000 / 30 - 1;

/** The time a still frame is drawn at: every state reads clearly there. */
export const ACTIVITY_ORB_STILL_SECONDS = 1.2;

type Dot = (x: number, y: number, radius: number, alpha: number) => void;
const TAU = Math.PI * 2;

/** Draw one frame. `size` is the backing width in device pixels; `ink` is "r,g,b". */
export function drawActivityOrb(ctx: CanvasRenderingContext2D, state: ActivityOrbState, t: number, size: number, ink: string): void {
  const r0 = size / 2;
  // 1 at a 20px orb drawn at 2x.
  const k = size / 40;
  ctx.clearRect(0, 0, size, size);
  // One colour for the frame; each dot sets only its alpha (no colour string per dot).
  ctx.fillStyle = `rgb(${ink})`;
  const dot: Dot = (x, y, radius, alpha) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.beginPath();
    ctx.arc(r0 + x, r0 + y, radius, 0, TAU);
    ctx.fill();
  };
  if (state === "searching") drawSearching(dot, t, k);
  else if (state === "working") drawWorking(dot, t, k);
  else if (state === "composing") drawComposing(dot, t, k);
  else drawBreathing(dot, t, k);
  ctx.globalAlpha = 1;
}

function drawSearching(dot: Dot, t: number, k: number): void {
  const rotation = t * 0.9;
  const scan = (t * 1.6) % TAU;
  const radius = 15 * k;
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    for (let longitude = 0; longitude < 360; longitude += 30) {
      const phi = latitude * Math.PI / 180;
      const theta = longitude * Math.PI / 180 + rotation;
      const z = Math.cos(phi) * Math.cos(theta);
      if (z < -0.15) continue;
      const distance = Math.abs((((theta % TAU) + TAU) % TAU) - scan);
      const lit = Math.max(0, 1 - Math.min(distance, TAU - distance) * 1.6);
      dot(radius * Math.cos(phi) * Math.sin(theta), radius * Math.sin(phi), (0.9 + lit * 0.9) * k, 0.25 + 0.35 * z + lit * 0.5);
    }
  }
}

function drawWorking(dot: Dot, t: number, k: number): void {
  for (let orbit = 0; orbit < 3; orbit += 1) {
    const tilt = orbit * 1.047;
    const rx = 15 * k;
    const ry = 5.5 * k;
    const place = (angle: number, radius: number, alpha: number) => {
      const x = rx * Math.cos(angle);
      const y = ry * Math.sin(angle);
      dot(x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt), radius, alpha);
    };
    for (let index = 0; index < 18; index += 1) place(index / 18 * TAU, 0.6 * k, 0.18);
    for (let trail = 0; trail < 4; trail += 1) {
      place(t * (1.6 + orbit * 0.35) + orbit * 2.1 - trail * 0.16, (1.6 - trail * 0.3) * k, 0.95 - trail * 0.22);
    }
  }
}

function drawComposing(dot: Dot, t: number, k: number): void {
  for (let band = 0; band < 4; band += 1) {
    for (let index = 0; index < 13; index += 1) {
      const x = (index - 6) * 2.4 * k;
      const y = (band - 1.5) * 3.6 * k + Math.sin(index * 0.55 + t * 2.4 + band * 0.8) * 3.2 * k;
      if (x * x + y * y > (16.5 * k) ** 2) continue;
      dot(x, y, 0.95 * k, 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(index * 0.4 - t * 2 + band)));
    }
  }
}

function drawBreathing(dot: Dot, t: number, k: number): void {
  for (let index = 0; index < 28; index += 1) {
    const angle = index / 28 * TAU;
    const radius = (12 + 2.2 * Math.sin(angle * 3 + t * 1.3) + 1.2 * Math.sin(t * 0.9)) * k;
    dot(radius * Math.cos(angle), radius * Math.sin(angle), k, 0.45 + 0.4 * Math.sin(angle * 2 - t));
  }
}

export interface ActivityOrbHost {
  /** Draw this orb at time t (seconds). */
  draw(t: number): void;
  /** False while the orb is offscreen; its frames are skipped. */
  visible(): boolean;
}

export interface ActivityOrbClockEnvironment {
  now(): number;
  requestFrame(callback: (ms: number) => void): number;
  cancelFrame(handle: number): void;
  reducedMotion(): boolean;
  documentHidden(): boolean;
}

/**
 * One clock for every orb on screen: a single animation frame loop that
 * runs only while an orb is registered and visible. Under reduced motion
 * each orb gets one still frame and the loop does not run.
 */
export function createActivityOrbClock(environment: ActivityOrbClockEnvironment) {
  const hosts = new Set<ActivityOrbHost>();
  let frame: number | null = null;
  let lastDrawMs = Number.NEGATIVE_INFINITY;

  function tick(ms: number): void {
    frame = null;
    if (environment.reducedMotion() || environment.documentHidden()) return;
    // A 20px orb reads the same at 30 fps; skip the frames between.
    const due = ms - lastDrawMs >= ACTIVITY_ORB_FRAME_MS;
    let any = false;
    for (const host of hosts) {
      if (!host.visible()) continue;
      if (due) host.draw(ms / 1000);
      any = true;
    }
    if (due && any) lastDrawMs = ms;
    if (any) frame = environment.requestFrame(tick);
  }

  /** Draw a frame at once, so an orb is never blank, and run the loop if motion is allowed. */
  function kick(host?: ActivityOrbHost): void {
    const still = environment.reducedMotion();
    const t = still ? ACTIVITY_ORB_STILL_SECONDS : environment.now() / 1000;
    for (const candidate of host ? [host] : hosts) candidate.draw(t);
    if (still || environment.documentHidden() || frame !== null || hosts.size === 0) return;
    frame = environment.requestFrame(tick);
  }

  function stop(): void {
    if (frame !== null) environment.cancelFrame(frame);
    frame = null;
  }

  return {
    add(host: ActivityOrbHost): void { hosts.add(host); kick(host); },
    remove(host: ActivityOrbHost): void { hosts.delete(host); if (!hosts.size) stop(); },
    /** Visibility, offscreen or motion preference changed. */
    refresh(): void { stop(); kick(); },
    running: () => frame !== null,
    size: () => hosts.size,
  };
}

let sharedClock: ReturnType<typeof createActivityOrbClock> | null = null;
// One query for the app; reading `.matches` each frame costs nothing.
let reducedMotionQuery: MediaQueryList | null = null;

function reducedMotionMediaQuery(): MediaQueryList | null {
  if (!reducedMotionQuery && typeof matchMedia === "function") reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery;
}

function prefersReducedMotion(): boolean {
  return reducedMotionMediaQuery()?.matches ?? false;
}

/** The app's one orb clock. It follows the window's visibility and motion preference. */
export function activityOrbClock(): ReturnType<typeof createActivityOrbClock> {
  if (sharedClock) return sharedClock;
  const hasFrames = typeof requestAnimationFrame === "function";
  const clock = createActivityOrbClock({
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    requestFrame: (callback) => hasFrames ? requestAnimationFrame(callback) : -1,
    cancelFrame: (handle) => { if (hasFrames && handle >= 0) cancelAnimationFrame(handle); },
    // No frame loop at all where there is none to run (a unit harness): one still frame.
    reducedMotion: () => !hasFrames || prefersReducedMotion(),
    documentHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  });
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => clock.refresh());
  }
  reducedMotionMediaQuery()?.addEventListener?.("change", () => clock.refresh());
  sharedClock = clock;
  return clock;
}
