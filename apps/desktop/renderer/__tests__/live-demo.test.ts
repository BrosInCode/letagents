import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopLiveDemoClientFrame,
  DesktopLiveDemoEvent,
  DesktopLiveDemoServerFrame,
} from "../../electron/ipc-types";
import {
  canvasBacking,
  clampDemoPoint,
  demoToFrame,
  frameToDemo,
  LIVE_CLIP_AT,
  LIVE_CLIP_SLACK,
  LIVE_DEFAULT_DEMO_HEIGHT,
  LIVE_MIN_FRAME_HEIGHT,
  liveClip,
  liveFrameHeight,
  liveReportedHeight,
  liveScale,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/geometry";
import {
  CURSOR_DELAY_MS,
  CURSOR_GAP_MS,
  CURSOR_GLIDE_MS,
  CURSOR_MAX_SAMPLES,
  createCursorField,
  cursorPositionAt,
  cursorSettled,
  newCursorTrack,
  pruneCursorTrack,
  pushCursorSample,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/cursor-interpolation";
import {
  simplifyPoints,
  simplifyStroke,
  STROKE_TOLERANCE,
  thinPoints,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/stroke-simplify";
import {
  CURSOR_INTERVAL_MS,
  createInkBatcher,
  createLatestThrottle,
  INK_INTERVAL_MS,
  type ThrottleClock,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/throttle";
import { createLiveDemoEvents } from "../src/components/desktop/content/desktop-chat-message/live-demo/events";
import { createLiveDemoJoins } from "../src/components/desktop/content/desktop-chat-message/live-demo/joins";
import {
  applyMarkChanges,
  describeMark,
  mergeMark,
  normalizeMarks,
  planMarkPaint,
  removeMark,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/marks";
import {
  createInkField,
  INK_LINGER_MS,
  INK_MAX_STROKES,
  INK_STALE_MS,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/ink-field";
import {
  liveStatusText,
  presenceChips,
  readableTextColor,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/people";
import {
  clippingBoxes,
  markupFileName,
  markupReplyText,
  viewportBox,
  visibleCaptureRect,
  type ClipOps,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/markup";
import { newStrokeId } from "../src/components/desktop/content/desktop-chat-message/live-demo/stroke-id";
import { createWidthSync } from "../src/components/desktop/content/desktop-chat-message/live-demo/width-sync";
import {
  useLiveDemo,
  type LiveDemoApi,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/session";
import {
  LIVE_DEMO,
  LIVE_DEMO_COLORS,
  liveDemoColor,
  liveDemoKey,
  type DemoMark,
  type LiveDemoPoint,
} from "../src/components/desktop/content/desktop-chat-message/live-demo/protocol";
import {
  inlineDemoFrameHeight,
} from "../src/components/desktop/content/desktop-chat-message/attachments";
import {
  newInlineDemoHeight,
  reportInlineDemoHeight,
} from "../src/components/desktop/content/desktop-chat-message/inline-demo-height";
import { parseDemoMarkInput, parseLiveClientFrame } from "../../../../shared/live-demo.mjs";

/** A clock the test moves by hand; timers run in order as it moves. */
function fakeClock(): { clock: ThrottleClock; advance(ms: number): void; now(): number; pendingTimers(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimer(run, delayMs) {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, run });
        return id;
      },
      clearTimer(handle) {
        timers.delete(handle as number);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        timers.delete(due[0]);
        due[1].run();
      }
      now = target;
    },
    now: () => now,
    pendingTimers: () => timers.size,
  };
}

describe("live demo layout geometry", () => {
  it("scales the 760 px layout to the frame and never enlarges it", () => {
    assert.equal(liveScale(380), 0.5);
    assert.equal(liveScale(760), 1);
    assert.equal(liveScale(900), 1);
    assert.equal(liveScale(0), null);
    assert.equal(liveScale(40), null);
    assert.equal(liveScale(Number.NaN), null);
  });

  it("converts between frame pixels and demo space", () => {
    assert.deepEqual(frameToDemo(190, 100, 0.5), [380, 200]);
    assert.deepEqual(demoToFrame([380, 200], 0.5), [190, 100]);
    const point = frameToDemo(123.4, 56.7, 0.58);
    const [x, y] = demoToFrame(point, 0.58);
    assert.ok(Math.abs(x - 123.4) < 0.06 && Math.abs(y - 56.7) < 0.06, "a tenth of a demo pixel at most");
  });

  it("keeps points inside what the protocol accepts", () => {
    assert.deepEqual(clampDemoPoint(-5, -1), [0, 0]);
    assert.deepEqual(clampDemoPoint(9999, 9_999_999), [LIVE_DEMO.width, LIVE_DEMO.maxHeight]);
    assert.deepEqual(clampDemoPoint(Number.NaN, Number.POSITIVE_INFINITY), [0, 0]);
    assert.deepEqual(clampDemoPoint(10.04, 20.06), [10, 20.1]);
    // Every clamped point is valid on the wire.
    const key = liveDemoKey("msg_1", "att_1")!;
    assert.ok(parseLiveClientFrame({ t: "cur", demo: key, x: clampDemoPoint(1e9, 1e9)[0], y: clampDemoPoint(1e9, 1e9)[1] }));
  });

  it("lays the card out at the height main reports for the scaled page", () => {
    assert.equal(liveFrameHeight(750, 0.5), 750);
    assert.equal(liveFrameHeight(null, 0.5), LIVE_DEFAULT_DEMO_HEIGHT * 0.5);
    assert.equal(liveFrameHeight(40, 0.5), LIVE_MIN_FRAME_HEIGHT);
    assert.equal(liveReportedHeight(0), 1);
    assert.equal(liveReportedHeight(123.6), 124);
    assert.equal(liveReportedHeight(1e9), LIVE_DEMO.maxHeight);
    assert.equal(liveReportedHeight(Number.NaN), LIVE_MIN_FRAME_HEIGHT);
  });

  it("does not use the 560 px legacy frame limit for a live demo's height", () => {
    const legacy = reportInlineDemoHeight(newInlineDemoHeight(), 2000, 0);
    assert.equal(legacy.shown, inlineDemoFrameHeight(2000));
    assert.equal(legacy.shown, 560);
    const live = reportInlineDemoHeight(newInlineDemoHeight(), 2000, 0, liveReportedHeight);
    assert.equal(live.shown, 2000);
  });

  it("clips a card taller than 800 px, with a few pixels of slack", () => {
    assert.deepEqual(liveClip(500, false), { clippable: false, clipped: false, visibleHeight: 500 });
    assert.deepEqual(liveClip(LIVE_CLIP_AT + LIVE_CLIP_SLACK, false), { clippable: false, clipped: false, visibleHeight: 840 });
    assert.deepEqual(liveClip(2000, false), { clippable: true, clipped: true, visibleHeight: LIVE_CLIP_AT });
    assert.deepEqual(liveClip(2000, true), { clippable: true, clipped: false, visibleHeight: 2000 });
  });

  it("lowers the pixel ratio of a canvas that would be too big", () => {
    assert.deepEqual(canvasBacking(440, 600, 2), { pixelWidth: 880, pixelHeight: 1200, ratio: 2 });
    const tall = canvasBacking(440, 11_600, 2);
    assert.ok(tall.ratio < 2 && tall.ratio >= 1.4, `ratio ${tall.ratio}`);
    assert.ok(tall.pixelHeight <= 16_384);
    assert.ok(tall.pixelWidth * tall.pixelHeight <= 16_000_000);
    const huge = canvasBacking(760, 20_000, 3);
    assert.ok(huge.pixelWidth * huge.pixelHeight <= 16_000_000);
    assert.deepEqual(canvasBacking(0, 0, Number.NaN), { pixelWidth: 1, pixelHeight: 1, ratio: 1 });
  });
});

describe("remote cursor interpolation", () => {
  it("draws the cursor 100 ms in the past, between the two samples around that moment", () => {
    let track = newCursorTrack();
    track = pushCursorSample(track, 0, 0, 1000);
    track = pushCursorSample(track, 100, 40, 1050);
    track = pushCursorSample(track, 200, 80, 1100);
    // At t=1125 the drawn moment is 1025: halfway between the first two samples.
    assert.deepEqual(cursorPositionAt(track, 1125), { x: 50, y: 20 });
    assert.deepEqual(cursorPositionAt(track, 1150), { x: 100, y: 40 });
    assert.deepEqual(cursorPositionAt(track, 1175), { x: 150, y: 60 });
    assert.equal(CURSOR_DELAY_MS, 100);
  });

  it("holds at the newest sample instead of running ahead", () => {
    const track = pushCursorSample(pushCursorSample(newCursorTrack(), 0, 0, 0), 10, 10, 50);
    assert.deepEqual(cursorPositionAt(track, 5_000), { x: 10, y: 10 });
    assert.deepEqual(cursorPositionAt(track, 150), { x: 10, y: 10 });
  });

  it("shows the first sample at once and nothing for an empty track", () => {
    assert.equal(cursorPositionAt(newCursorTrack(), 10), null);
    const track = pushCursorSample(newCursorTrack(), 7, 9, 500);
    assert.deepEqual(cursorPositionAt(track, 500), { x: 7, y: 9 });
    assert.deepEqual(cursorPositionAt(track, 520), { x: 7, y: 9 });
  });

  it("glides after a long silence instead of jumping the moment the sample arrives", () => {
    let track = pushCursorSample(newCursorTrack(), 0, 0, 0);
    track = pushCursorSample(track, 300, 0, 2_000);
    assert.ok(2_000 > CURSOR_GAP_MS);
    // The newest sample arrived at 2000; 100 ms later the drawn moment is 2000, so the cursor is there.
    assert.deepEqual(cursorPositionAt(track, 2_100), { x: 300, y: 0 });
    // Right at arrival it still shows the old spot, 100 ms in the past.
    assert.deepEqual(cursorPositionAt(track, 2_000), { x: 0, y: 0 });
    // It leaves the old spot only in the last CURSOR_GLIDE_MS before the sample.
    const midway = cursorPositionAt(track, 2_100 - CURSOR_GLIDE_MS / 2)!;
    assert.ok(midway.x > 100 && midway.x < 200, `x ${midway.x}`);
  });

  it("keeps the order of samples when the clock reports an earlier time", () => {
    let track = pushCursorSample(newCursorTrack(), 0, 0, 100);
    track = pushCursorSample(track, 10, 0, 90);
    assert.deepEqual(track.samples.map((sample) => sample.at), [100, 100]);
    assert.deepEqual(cursorPositionAt(track, 1_000), { x: 10, y: 0 });
  });

  it("keeps at most a dozen samples", () => {
    let track = newCursorTrack();
    for (let index = 0; index < 40; index++) track = pushCursorSample(track, index, 0, index * 50);
    assert.equal(track.samples.length, CURSOR_MAX_SAMPLES);
    assert.equal(track.samples[track.samples.length - 1].x, 39);
  });

  it("says when the cursor has caught up, so the frame loop can rest", () => {
    const track = pushCursorSample(pushCursorSample(newCursorTrack(), 0, 0, 0), 5, 5, 50);
    assert.equal(cursorSettled(track, 120), false);
    assert.equal(cursorSettled(track, 150), true);
    assert.equal(cursorSettled(newCursorTrack(), 0), true);
  });

  it("prunes the samples that can no longer be drawn but keeps the one before the drawn moment", () => {
    let track = newCursorTrack();
    for (let index = 0; index < 6; index++) track = pushCursorSample(track, index * 10, 0, index * 50);
    const pruned = pruneCursorTrack(track, 300);
    // Drawn moment is 200: the sample at 200 and everything after it stay.
    assert.deepEqual(pruned.samples.map((sample) => sample.at), [200, 250]);
    assert.deepEqual(cursorPositionAt(pruned, 300), cursorPositionAt(track, 300));
    assert.equal(pruneCursorTrack(pruned, 300), pruned);
  });

  it("tracks everyone in a demo and forgets a cursor that went or left", () => {
    const field = createCursorField();
    field.move("a", 1, 1, 0);
    field.move("b", 2, 2, 0);
    assert.deepEqual(field.cids().sort(), ["a", "b"]);
    assert.equal(field.animating(10), true);
    assert.equal(field.animating(500), false);
    field.gone("a");
    assert.equal(field.has("a"), false);
    assert.equal(field.keepOnly(new Set(["b"])), false);
    assert.equal(field.keepOnly(new Set(["c"])), true);
    assert.equal(field.has("b"), false);
    assert.equal(field.positionOf("b", 0), null);
    field.move("a", 4, 5, 10);
    field.clear();
    assert.deepEqual(field.cids(), []);
  });

  it("draws 60 frames a second from 20 samples a second without a jump", () => {
    let track = newCursorTrack();
    // A pointer moving 10 demo px per sample, one sample every 50 ms.
    for (let index = 0; index < 20; index++) track = pushCursorSample(track, index * 10, 0, index * 50);
    let previous = -Infinity;
    let biggestStep = 0;
    for (let frame = 0; frame < 55; frame++) {
      const time = 100 + frame * (1000 / 60);
      const position = cursorPositionAt(track, time)!;
      assert.ok(position.x >= previous, "never moves backwards");
      if (previous > -Infinity) biggestStep = Math.max(biggestStep, position.x - previous);
      previous = position.x;
    }
    assert.ok(biggestStep < 3.5, `each frame moves ${biggestStep.toFixed(2)} px, a third of a sample step`);
  });
});

describe("stroke simplification", () => {
  const line = (count: number): LiveDemoPoint[] => Array.from({ length: count }, (_, index) => [index, index / 2] as LiveDemoPoint);

  it("reduces a straight line to its two ends", () => {
    assert.deepEqual(simplifyPoints(line(200), 0.5), [[0, 0], [199, 99.5]]);
  });

  it("keeps the corner of an L shape", () => {
    const corner: LiveDemoPoint[] = [];
    for (let x = 0; x <= 50; x++) corner.push([x, 0]);
    for (let y = 1; y <= 50; y++) corner.push([50, y]);
    assert.deepEqual(simplifyPoints(corner, 0.8), [[0, 0], [50, 0], [50, 50]]);
  });

  it("drops a wiggle smaller than the tolerance and keeps one larger", () => {
    const small: LiveDemoPoint[] = [[0, 0], [10, 0.4], [20, 0]];
    const large: LiveDemoPoint[] = [[0, 0], [10, 3], [20, 0]];
    assert.equal(simplifyPoints(small, STROKE_TOLERANCE).length, 2);
    assert.equal(simplifyPoints(large, STROKE_TOLERANCE).length, 3);
  });

  it("keeps the first and last point and the order of a circle drawn as a closed loop", () => {
    const circle: LiveDemoPoint[] = Array.from({ length: 361 }, (_, degree) => [
      100 + 50 * Math.cos((degree * Math.PI) / 180),
      100 + 50 * Math.sin((degree * Math.PI) / 180),
    ] as LiveDemoPoint);
    const simplified = simplifyPoints(circle, 0.8);
    assert.deepEqual(simplified[0], circle[0]);
    assert.deepEqual(simplified[simplified.length - 1], circle[circle.length - 1]);
    assert.ok(simplified.length > 12 && simplified.length < 120, `${simplified.length} points`);
    // Each kept point is on the circle, in the same order as the original.
    let last = -1;
    for (const point of simplified) {
      const index = circle.indexOf(point);
      assert.ok(index > last);
      last = index;
    }
  });

  it("handles a very long stroke without deep recursion", () => {
    const zigzag: LiveDemoPoint[] = Array.from({ length: 60_000 }, (_, index) => [(index % 700), index % 2 === 0 ? 0 : 5] as LiveDemoPoint);
    const simplified = simplifyStroke(zigzag);
    assert.ok(simplified.length <= LIVE_DEMO.strokePoints);
    assert.ok(simplified.length >= 2);
  });

  it("never returns more than the protocol allows, by widening the tolerance", () => {
    // A noisy scribble: every point is far from its neighbours.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const scribble: LiveDemoPoint[] = Array.from({ length: 6_000 }, () => [random() * 700, random() * 700] as LiveDemoPoint);
    const simplified = simplifyStroke(scribble);
    assert.ok(simplified.length <= LIVE_DEMO.strokePoints, `${simplified.length}`);
    assert.ok(simplified.length > 100);
    assert.ok(simplifyStroke(scribble, 50).length <= 50);
  });

  it("makes a tap into a dot of two equal points, which the server accepts", () => {
    const dot = simplifyStroke([[12.34, 56.78], [12.34, 56.78]]);
    assert.deepEqual(dot, [[12.3, 56.8], [12.3, 56.8]]);
    assert.deepEqual(simplifyStroke([[3, 4]]), [[3, 4], [3, 4]]);
    assert.deepEqual(simplifyStroke([]), []);
    const key = liveDemoKey("msg_9", "att_9")!;
    assert.ok(parseDemoMarkInput({ demo: key, kind: "stroke", points: dot, anchor: null }));
  });

  it("rounds to a tenth of a pixel and removes repeated points", () => {
    const result = simplifyStroke([[0.04, 0.04], [0.04, 0.04], [100.26, 50.55], [100.26, 50.55]]);
    assert.deepEqual(result, [[0, 0], [100.3, 50.6]]);
  });

  it("thins a list to an even spread that keeps both ends", () => {
    const thinned = thinPoints(line(1000), 64);
    assert.equal(thinned.length, 64);
    assert.deepEqual(thinned[0], [0, 0]);
    assert.deepEqual(thinned[63], [999, 499.5]);
    assert.deepEqual(thinPoints(line(10), 64), line(10));
    assert.deepEqual(thinPoints(line(10), 1), [[9, 4.5]]);
    assert.deepEqual(thinPoints([], 1), []);
  });
});

describe("live demo throttles", () => {
  it("sends the first cursor at once and then at most 20 a second, ending on the newest position", () => {
    assert.equal(CURSOR_INTERVAL_MS, 50);
    const time = fakeClock();
    const sent: Array<[number, number]> = [];
    const throttle = createLatestThrottle<[number, number]>(CURSOR_INTERVAL_MS, (value) => sent.push(value), time.clock);
    // A 1000 Hz pointer for one second.
    for (let ms = 0; ms < 1000; ms++) {
      throttle.push([ms, ms]);
      time.advance(1);
    }
    time.advance(100);
    assert.deepEqual(sent[0], [0, 0], "the first position goes at once");
    assert.ok(sent.length >= 19 && sent.length <= 21, `${sent.length} frames in one second`);
    assert.deepEqual(sent[sent.length - 1], [999, 999], "the last position always arrives");
    assert.equal(time.pendingTimers(), 0);
  });

  it("keeps frames at least 50 ms apart", () => {
    const time = fakeClock();
    const sentAt: number[] = [];
    const throttle = createLatestThrottle<number>(CURSOR_INTERVAL_MS, () => sentAt.push(time.now()), time.clock);
    for (let ms = 0; ms < 500; ms += 7) {
      throttle.push(ms);
      time.advance(7);
    }
    time.advance(100);
    for (let index = 1; index < sentAt.length; index++) assert.ok(sentAt[index] - sentAt[index - 1] >= 50 - 1e-9);
  });

  it("drops a waiting value when cancelled", () => {
    const time = fakeClock();
    const sent: number[] = [];
    const throttle = createLatestThrottle<number>(50, (value) => sent.push(value), time.clock);
    throttle.push(1);
    throttle.push(2);
    throttle.cancel();
    time.advance(500);
    assert.deepEqual(sent, [1]);
    throttle.push(3);
    assert.deepEqual(sent, [1, 3]);
  });

  it("batches ink into frames of at most 64 points, at most 30 frames a second", () => {
    assert.equal(INK_INTERVAL_MS, 34);
    const time = fakeClock();
    const frames: Array<{ points: LiveDemoPoint[]; end: boolean; at: number }> = [];
    const batcher = createInkBatcher((points, end) => frames.push({ points, end, at: time.now() }), time.clock);
    // 2 seconds of a 240 Hz pen: 480 points.
    for (let index = 0; index < 480; index++) {
      batcher.add([index, index]);
      time.advance(1000 / 240);
    }
    batcher.end();
    time.advance(200);
    assert.deepEqual(frames[0].points, [[0, 0]], "the first point goes at once");
    assert.ok(frames.every((frame) => frame.points.length <= LIVE_DEMO.inkPointsPerFrame));
    assert.equal(frames.filter((frame) => frame.end).length, 1);
    assert.equal(frames[frames.length - 1].end, true);
    for (let index = 1; index < frames.length; index++) assert.ok(frames[index].at - frames[index - 1].at >= INK_INTERVAL_MS - 1e-6);
    assert.ok(frames.length / 2 <= 30, `${frames.length / 2} frames a second`);
    const sentPoints = frames.flatMap((frame) => frame.points);
    assert.deepEqual(sentPoints[sentPoints.length - 1], [479, 479], "the stroke ends where the pen did");
  });

  it("thins a burst that is larger than one frame instead of sending extra frames", () => {
    const time = fakeClock();
    const frames: LiveDemoPoint[][] = [];
    const batcher = createInkBatcher((points) => frames.push(points), time.clock);
    batcher.add([0, 0]);
    for (let index = 1; index <= 300; index++) batcher.add([index, 0]);
    time.advance(40);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].length, 64);
    assert.deepEqual(frames[1][0], [1, 0]);
    assert.deepEqual(frames[1][63], [300, 0]);
  });

  it("sends the end of a stroke even when nothing waits, and nothing after it", () => {
    const time = fakeClock();
    const frames: Array<{ n: number; end: boolean }> = [];
    const batcher = createInkBatcher((points, end) => frames.push({ n: points.length, end }), time.clock);
    batcher.add([1, 1]);
    time.advance(100);
    batcher.end();
    assert.deepEqual(frames, [{ n: 1, end: false }, { n: 0, end: true }]);
    batcher.add([2, 2]);
    batcher.end();
    time.advance(500);
    assert.equal(frames.length, 2);
  });

  it("waits for the interval before the end frame, and cancel drops everything", () => {
    const time = fakeClock();
    const frames: Array<{ n: number; end: boolean }> = [];
    const batcher = createInkBatcher((points, end) => frames.push({ n: points.length, end }), time.clock);
    batcher.add([1, 1]);
    batcher.add([2, 2]);
    batcher.end();
    assert.equal(frames.length, 1, "the end waits for the interval");
    time.advance(34);
    assert.deepEqual(frames[1], { n: 1, end: true });

    const other = fakeClock();
    const sent: unknown[] = [];
    const cancelled = createInkBatcher((points) => sent.push(points), other.clock);
    cancelled.add([1, 1]);
    cancelled.add([2, 2]);
    cancelled.cancel();
    other.advance(500);
    assert.equal(sent.length, 1);
  });

  it("sends frames the server accepts", () => {
    const key = liveDemoKey("msg_1", "att_1")!;
    const time = fakeClock();
    const accepted: unknown[] = [];
    const batcher = createInkBatcher((pts, end) => {
      accepted.push(parseLiveClientFrame({ t: "ink", demo: key, id: "stroke-id-1", pts, ...(end ? { end: true } : {}) }));
    }, time.clock);
    for (let index = 0; index < 200; index++) batcher.add([Math.min(760, index * 5), index]);
    batcher.end();
    time.advance(500);
    assert.ok(accepted.length > 1);
    assert.ok(accepted.every(Boolean));
  });
});

describe("live demo event router", () => {
  function makeHub() {
    const hub = {
      subscribed: 0,
      unsubscribed: 0,
      listener: null as ((event: DesktopLiveDemoEvent) => void) | null,
      subscribe(listener: (event: DesktopLiveDemoEvent) => void) {
        hub.subscribed++;
        hub.listener = listener;
        return () => { hub.unsubscribed++; hub.listener = null; };
      },
      emit(event: DesktopLiveDemoEvent) { hub.listener?.(event); },
    };
    return hub;
  }
  const frame = (roomIdentifier: string, value: DesktopLiveDemoServerFrame): DesktopLiveDemoEvent => ({ type: "frame", roomIdentifier, frame: value });
  const K1 = "msg_1/att_a";
  const K2 = "msg_2/att_b";

  it("listens to main only after the first card registers, once for the whole window", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    assert.equal(hub.subscribed, 0);
    events.register("room-1", K1, () => undefined);
    events.register("room-1", K2, () => undefined);
    events.register("room-2", K1, () => undefined);
    assert.equal(hub.subscribed, 1);
  });

  it("routes a frame to the cards of its room and demo only", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const a: DesktopLiveDemoEvent[] = [];
    const b: DesktopLiveDemoEvent[] = [];
    const c: DesktopLiveDemoEvent[] = [];
    events.register("room-1", K1, (event) => a.push(event));
    events.register("room-1", K2, (event) => b.push(event));
    events.register("room-2", K1, (event) => c.push(event));
    const cursor = frame("room-1", { t: "cur", demo: K1, cid: "p1", x: 1, y: 2 });
    hub.emit(cursor);
    assert.deepEqual(a, [cursor]);
    assert.deepEqual(b, []);
    assert.deepEqual(c, []);
    hub.emit(frame("room-1", { t: "unmark", demo: K2, id: "mark_1" }));
    assert.equal(b.length, 1);
    assert.equal(a.length, 1);
  });

  it("compares room ids exactly, as main and the server do: two rooms that differ in case are two rooms", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const design: DesktopLiveDemoEvent[] = [];
    const lower: DesktopLiveDemoEvent[] = [];
    events.register("Design", K1, (event) => design.push(event));
    events.register("design", K1, (event) => lower.push(event));
    hub.emit(frame("design", { t: "cur", demo: K1, cid: "p1", gone: true }));
    assert.equal(design.length, 0);
    assert.equal(lower.length, 1);
    hub.emit(frame("Design", { t: "cur", demo: K1, cid: "p1", gone: true }));
    assert.equal(design.length, 1);
    assert.equal(lower.length, 1);
    hub.emit({ type: "status", roomIdentifier: "Design", status: "reconnecting" });
    assert.equal(design.length, 2);
    assert.equal(lower.length, 1);
  });

  it("ignores spaces around a room id, which main trims", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const seen: DesktopLiveDemoEvent[] = [];
    events.register(" github.com/org/repo ", K1, (event) => seen.push(event));
    hub.emit(frame("github.com/org/repo", { t: "cur", demo: K1, cid: "p1", gone: true }));
    assert.equal(seen.length, 1);
  });

  it("does not tell a card the greeting or state of a room that differs only in case", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    events.register("Design", K1, () => undefined);
    hub.emit(frame("Design", { t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] }));
    hub.emit({ type: "status", roomIdentifier: "Design", status: "live" });
    const other: DesktopLiveDemoEvent[] = [];
    events.register("design", K1, (event) => other.push(event));
    assert.deepEqual(other, []);
  });

  it("sends the connection state and greeting of a room to every card in it", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const a: DesktopLiveDemoEvent[] = [];
    const b: DesktopLiveDemoEvent[] = [];
    const other: DesktopLiveDemoEvent[] = [];
    events.register("room-1", K1, (event) => a.push(event));
    events.register("room-1", K2, (event) => b.push(event));
    events.register("room-2", K1, (event) => other.push(event));
    hub.emit({ type: "status", roomIdentifier: "room-1", status: "reconnecting" });
    hub.emit(frame("room-1", { t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] }));
    hub.emit(frame("room-1", { t: "error", code: "x", message: "y" }));
    assert.equal(a.length, 3);
    assert.equal(b.length, 3);
    assert.equal(other.length, 0);
  });

  it("tells a card that registers late the last state and greeting of its room", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    events.register("room-1", K1, () => undefined);
    hub.emit(frame("room-1", { t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[1] }));
    hub.emit({ type: "status", roomIdentifier: "room-1", status: "live" });
    hub.emit({ type: "status", roomIdentifier: "room-1", status: "reconnecting" });
    const late: DesktopLiveDemoEvent[] = [];
    events.register("room-1", K2, (event) => late.push(event));
    assert.deepEqual(late.map((event) => event.type === "status" ? event.status : event.frame.t), ["hello", "reconnecting"]);
  });

  it("serves two cards that show the same demo", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const a: DesktopLiveDemoEvent[] = [];
    const b: DesktopLiveDemoEvent[] = [];
    const stopA = events.register("room-1", K1, (event) => a.push(event));
    events.register("room-1", K1, (event) => b.push(event));
    hub.emit(frame("room-1", { t: "unmark", demo: K1, id: "mark_1" }));
    stopA();
    hub.emit(frame("room-1", { t: "unmark", demo: K1, id: "mark_2" }));
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
  });

  it("stops sending to a card that left, and a second unregister does nothing", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const seen: DesktopLiveDemoEvent[] = [];
    const stop = events.register("room-1", K1, (event) => seen.push(event));
    events.register("room-1", K2, () => undefined);
    stop();
    stop();
    hub.emit(frame("room-1", { t: "unmark", demo: K1, id: "mark_1" }));
    assert.equal(seen.length, 0);
  });

  it("keeps listening after the last card leaves, and does not subscribe a second time", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    events.register("room-1", K1, () => undefined)();
    assert.equal(hub.subscribed, 1);
    assert.equal(hub.unsubscribed, 0);
    events.register("room-1", K1, () => undefined);
    assert.equal(hub.subscribed, 1);
  });

  it("remembers a room's state and greeting for the next card, because main tells them only once", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const stop = events.register("room-1", K1, () => undefined);
    hub.emit(frame("room-1", { t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[3] }));
    hub.emit({ type: "status", roomIdentifier: "room-1", status: "live" });
    stop();
    // Main keeps the room's socket for a minute after its last card.
    hub.emit({ type: "status", roomIdentifier: "room-1", status: "reconnecting" });
    const late: DesktopLiveDemoEvent[] = [];
    events.register("room-1", K1, (event) => late.push(event));
    assert.deepEqual(late.map((event) => event.type === "status" ? event.status : event.frame.t), ["hello", "reconnecting"]);
  });

  it("sends an error that names a demo to that demo only, and one that names none to the whole room", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const a: DesktopLiveDemoEvent[] = [];
    const b: DesktopLiveDemoEvent[] = [];
    events.register("room-1", K1, (event) => a.push(event));
    events.register("room-1", K2, (event) => b.push(event));
    hub.emit(frame("room-1", { t: "error", code: "demo_full", message: "Too many people.", demo: K1 } as unknown as DesktopLiveDemoServerFrame));
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    hub.emit(frame("room-1", { t: "error", code: "unavailable", message: "Try later." }));
    assert.equal(a.length, 2);
    assert.equal(b.length, 1);
  });

  it("works when main has no live channel, and tries again for the next card", () => {
    let calls = 0;
    const events = createLiveDemoEvents(() => { calls++; return undefined; });
    events.register("room-1", K1, () => undefined);
    events.register("room-1", K2, () => undefined);
    assert.equal(calls, 2);
  });

  it("lets a handler leave while an event is delivered", () => {
    const hub = makeHub();
    const events = createLiveDemoEvents(hub.subscribe);
    const seen: string[] = [];
    let stopFirst = () => undefined as void;
    stopFirst = events.register("room-1", K1, () => { seen.push("first"); stopFirst(); });
    events.register("room-1", K1, () => seen.push("second"));
    hub.emit(frame("room-1", { t: "unmark", demo: K1, id: "mark_1" }));
    assert.deepEqual(seen, ["first", "second"]);
  });
});

describe("live demo joins", () => {
  function makeApi() {
    const calls: string[] = [];
    return {
      calls,
      api: {
        async join(room: string, key: string, lease: string) { calls.push(`join ${room} ${key} ${lease}`); },
        async leave(room: string, key: string) { calls.push(`leave ${room} ${key}`); },
      },
    };
  }

  it("joins once for the first card and leaves when the last one goes", () => {
    const { calls, api } = makeApi();
    const joins = createLiveDemoJoins(api);
    const first = joins.join("r", "msg_1/a", "lease-1");
    const second = joins.join("r ", "msg_1/a", "lease-2");
    assert.deepEqual(calls, ["join r msg_1/a lease-1"]);
    second.leave();
    second.leave();
    assert.equal(calls.length, 1);
    first.leave();
    assert.deepEqual(calls, ["join r msg_1/a lease-1", "leave r msg_1/a"]);
  });

  it("hands the join to the next card when the card that holds it leaves", () => {
    const { calls, api } = makeApi();
    const joins = createLiveDemoJoins(api);
    const first = joins.join("r", "msg_1/a", "lease-1");
    joins.join("r", "msg_1/a", "lease-2");
    first.leave();
    assert.deepEqual(calls, ["join r msg_1/a lease-1", "join r msg_1/a lease-2"]);
  });

  it("keeps rooms that differ in case apart", () => {
    const { calls, api } = makeApi();
    const joins = createLiveDemoJoins(api);
    const design = joins.join("Design", "msg_1/a", "lease-1");
    const lower = joins.join("design", "msg_1/a", "lease-2");
    assert.deepEqual(calls, ["join Design msg_1/a lease-1", "join design msg_1/a lease-2"]);
    design.leave();
    assert.deepEqual(calls.slice(2), ["leave Design msg_1/a"]);
    lower.leave();
    assert.deepEqual(calls.slice(3), ["leave design msg_1/a"]);
  });

  it("keeps separate demos apart", () => {
    const { calls, api } = makeApi();
    const joins = createLiveDemoJoins(api);
    const a = joins.join("r", "msg_1/a", "lease-1");
    const b = joins.join("r", "msg_2/b", "lease-2");
    a.leave();
    assert.deepEqual(calls, ["join r msg_1/a lease-1", "join r msg_2/b lease-2", "leave r msg_1/a"]);
    b.leave();
  });

  it("reports a refused join to the card that asked, and does not throw when a leave fails", async () => {
    const joins = createLiveDemoJoins({
      join: async () => { throw new Error("refused"); },
      leave: async () => { throw new Error("gone"); },
    });
    const join = joins.join("r", "msg_1/a", "lease");
    await assert.rejects(join.done, /refused/);
    join.leave();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("saved marks", () => {
  const author = { accountId: "acct_1", name: "Emmy", color: LIVE_DEMO_COLORS[0] };
  const key = "msg_1/att_1";
  const pin = (id: string, createdAt: string, text = "Look here"): DemoMark => ({
    id, demo: key, kind: "pin", at: [10, 20], text, author, anchor: null, createdAt,
  });
  const stroke = (id: string, createdAt: string): DemoMark => ({
    id, demo: key, kind: "stroke", points: [[0, 0], [5, 5]], author, anchor: null, createdAt,
  });

  it("orders marks by age and keeps one per id", () => {
    const marks = normalizeMarks([pin("mark_bbbbbb", "2026-01-02"), pin("mark_aaaaaa", "2026-01-01"), pin("mark_bbbbbb", "2026-01-02", "Changed")]);
    assert.deepEqual(marks.map((mark) => mark.id), ["mark_aaaaaa", "mark_bbbbbb"]);
    assert.equal((marks[1] as { text: string }).text, "Changed");
  });

  it("merges a mark that arrives by REST and again by frame into one", () => {
    const mark = stroke("mark_aaaaaa", "2026-01-01");
    const once = mergeMark([], mark);
    assert.equal(mergeMark(once, mark).length, 1);
  });

  it("keeps at most 500 marks, dropping the oldest", () => {
    const many = Array.from({ length: 520 }, (_, index) => pin(`mark_${String(index).padStart(6, "0")}`, `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.${String(Math.floor(index / 60)).padStart(3, "0")}Z`));
    const kept = normalizeMarks(many);
    assert.equal(kept.length, LIVE_DEMO.marksPerDemo);
  });

  it("removes a mark by id and leaves the list alone for an unknown id", () => {
    const marks = [pin("mark_aaaaaa", "2026-01-01"), stroke("mark_bbbbbb", "2026-01-02")];
    assert.deepEqual(removeMark(marks, "mark_aaaaaa").map((mark) => mark.id), ["mark_bbbbbb"]);
    assert.equal(removeMark(marks, "nope").length, 2);
  });

  it("applies the changes that arrived while the list was loading", () => {
    const listed = [pin("mark_aaaaaa", "2026-01-01"), pin("mark_bbbbbb", "2026-01-02")];
    const result = applyMarkChanges(listed, [
      { t: "unmark", id: "mark_aaaaaa" },
      { t: "mark", mark: stroke("mark_cccccc", "2026-01-03") },
    ]);
    assert.deepEqual(result.map((mark) => mark.id), ["mark_bbbbbb", "mark_cccccc"]);
  });

  it("paints only the new stroke when a mark arrives, and everything when a stroke goes or the layer was cleared", () => {
    const a = stroke("mark_aaaaaa", "2026-01-01");
    const b = stroke("mark_bbbbbb", "2026-01-02");
    const c = stroke("mark_cccccc", "2026-01-03");
    // The first paint draws all.
    const first = planMarkPaint(new Set(), [a, b], true);
    assert.equal(first.full, true);
    assert.deepEqual(first.paint.map((mark) => mark.id), ["mark_aaaaaa", "mark_bbbbbb"]);
    // One new stroke: only it is drawn.
    const added = planMarkPaint(first.ids, [a, b, c], false);
    assert.equal(added.full, false);
    assert.deepEqual(added.paint.map((mark) => mark.id), ["mark_cccccc"]);
    // The same list again draws nothing.
    assert.deepEqual(planMarkPaint(added.ids, [a, b, c], false).paint, []);
    // A removed stroke needs the whole layer again.
    const removed = planMarkPaint(added.ids, [a, c], false);
    assert.equal(removed.full, true);
    assert.deepEqual(removed.paint.map((mark) => mark.id), ["mark_aaaaaa", "mark_cccccc"]);
    // A new size or scale clears the canvas.
    const cleared = planMarkPaint(added.ids, [a, b, c], true);
    assert.equal(cleared.full, true);
    assert.equal(cleared.paint.length, 3);
  });

  it("does not paint for pins, and a pin that goes does not clear the strokes", () => {
    const a = stroke("mark_aaaaaa", "2026-01-01");
    const p = pin("mark_pinpin01", "2026-01-02");
    const drawn = planMarkPaint(new Set(), [a], true).ids;
    assert.deepEqual(planMarkPaint(drawn, [a, p], false), { full: false, paint: [], ids: drawn });
    assert.equal(planMarkPaint(drawn, [a], false).full, false);
  });

  it("paints 500 saved strokes in one full pass and a new one on its own", () => {
    const many = Array.from({ length: 500 }, (_, index) => stroke(`mark_${String(index).padStart(6, "0")}`, `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.${String(Math.floor(index / 60)).padStart(3, "0")}Z`));
    const first = planMarkPaint(new Set(), many, true);
    assert.equal(first.paint.length, 500);
    const next = stroke("mark_zzzzzz", "2026-02-01");
    const added = planMarkPaint(first.ids, mergeMark(many, next).slice(-500), false);
    // The oldest fell off the 500 cap, so the layer starts over; a list that grows paints one.
    assert.equal(added.full, true);
    const few = many.slice(0, 100);
    const small = planMarkPaint(planMarkPaint(new Set(), few, true).ids, [...few, next], false);
    assert.deepEqual(small.paint.map((mark) => mark.id), ["mark_zzzzzz"]);
  });

  it("describes a mark in a line", () => {
    assert.equal(describeMark(stroke("mark_aaaaaa", "2026-01-01")), "Drawing");
    assert.equal(describeMark(pin("mark_aaaaaa", "2026-01-01", "  Fix\n this ")), "Fix this");
    assert.equal(describeMark(pin("mark_aaaaaa", "2026-01-01", "x".repeat(100))).length, 60);
  });
});

describe("ink from other people", () => {
  it("collects the frames of one stroke", () => {
    const field = createInkField();
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[1, 1], [2, 2]] }, 0);
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[3, 3]], end: true }, 10);
    const [stroke] = field.strokes();
    assert.deepEqual(stroke.points, [[1, 1], [2, 2], [3, 3]]);
    assert.equal(stroke.ended, true);
  });

  it("keeps two people's strokes with the same id apart", () => {
    const field = createInkField();
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[1, 1]] }, 0);
    field.apply({ cid: "p2", id: "stroke-aaaa", pts: [[9, 9]] }, 0);
    assert.equal(field.strokes().length, 2);
  });

  it("lets an ended stroke linger for a moment so its saved copy can replace it", () => {
    const field = createInkField();
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[1, 1], [2, 2]], end: true }, 100);
    assert.equal(field.prune(100 + INK_LINGER_MS - 1), false);
    assert.equal(field.prune(100 + INK_LINGER_MS), true);
    assert.equal(field.strokes().length, 0);
  });

  it("drops a stroke whose drawer went silent without ending it", () => {
    const field = createInkField();
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[1, 1]] }, 0);
    assert.equal(field.prune(INK_STALE_MS - 1), false);
    assert.equal(field.prune(INK_STALE_MS), true);
  });

  it("forgets the strokes of people who left", () => {
    const field = createInkField();
    field.apply({ cid: "p1", id: "stroke-aaaa", pts: [[1, 1]] }, 0);
    field.apply({ cid: "p2", id: "stroke-bbbb", pts: [[1, 1]] }, 0);
    assert.equal(field.keepOnly(new Set(["p2"])), true);
    assert.deepEqual(field.strokes().map((stroke) => stroke.cid), ["p2"]);
    assert.equal(field.keepOnly(new Set(["p2"])), false);
  });

  it("bounds the strokes and the points it holds", () => {
    const field = createInkField();
    for (let index = 0; index < INK_MAX_STROKES + 10; index++) field.apply({ cid: "p1", id: `stroke-${index}-aaaa`, pts: [[1, 1]] }, 0);
    assert.equal(field.strokes().length, INK_MAX_STROKES);
    const long = createInkField();
    for (let frame = 0; frame < 100; frame++) long.apply({ cid: "p1", id: "stroke-aaaa", pts: Array.from({ length: 64 }, () => [1, 1] as LiveDemoPoint) }, 0);
    assert.equal(long.strokes()[0].points.length, LIVE_DEMO.strokePoints);
  });
});

describe("live demo people and status", () => {
  const person = (cid: string, name: string) => ({ cid, name, color: LIVE_DEMO_COLORS[0] });

  it("shows no chips while you are alone", () => {
    assert.deepEqual(presenceChips([person("a", "Emmy")], "a"), { chips: [], more: 0 });
    assert.deepEqual(presenceChips([], null), { chips: [], more: 0 });
  });

  it("puts you first and counts the people who do not fit", () => {
    const people = [person("a", "Ann"), person("b", "Bo"), person("c", "Cy"), person("d", "Di"), person("e", "Ed"), person("f", "Flo")];
    const result = presenceChips(people, "c");
    assert.deepEqual(result.chips.map((chip) => chip.name), ["Cy", "Ann", "Bo", "Di"]);
    assert.equal(result.chips[0].self, true);
    assert.equal(result.more, 2);
  });

  it("does not mark anyone as you when the greeting is unknown", () => {
    assert.ok(presenceChips([person("a", "Ann"), person("b", "Bo")], null).chips.every((chip) => !chip.self));
  });

  it("picks dark text on the light colours and white on the dark ones", () => {
    assert.equal(readableTextColor("#ffc53d"), "#111111");
    assert.equal(readableTextColor("#8e4ec6"), "#ffffff");
    assert.equal(readableTextColor("#0090ff"), "#111111");
    assert.equal(readableTextColor("not a colour"), "#ffffff");
    for (const color of LIVE_DEMO_COLORS) assert.match(readableTextColor(color), /^#(111111|ffffff)$/);
  });

  it("says nothing while the connection works and a short sentence when it does not", () => {
    assert.equal(liveStatusText(null, null), "");
    assert.equal(liveStatusText("connecting", null), "");
    assert.equal(liveStatusText("live", null), "");
    assert.equal(liveStatusText("reconnecting", null), "Reconnecting…");
    assert.equal(liveStatusText("offline", null), "Offline. Live view is paused.");
    assert.equal(liveStatusText("refused", null), "Live view is not available here.");
  });

  it("gives the reason main or the server gave, on one line", () => {
    assert.equal(liveStatusText("refused", null, "You are not a member of this room."), "Live view is off. You are not a member of this room.");
    assert.equal(liveStatusText("offline", null, "This room is only on this computer."), "Live view is off. This room is only on this computer.");
    assert.equal(liveStatusText("live", "Too many people are viewing this demo live."), "Too many people are viewing this demo live.");
    assert.equal(liveStatusText("refused", "  Too\n many  "), "Too many");
    assert.equal(liveStatusText("live", "x".repeat(300)).length, 120);
  });

  it("gives an account the same colour every time", () => {
    assert.equal(liveDemoColor("acct_1"), liveDemoColor("acct_1"));
    assert.ok(LIVE_DEMO_COLORS.includes(liveDemoColor("acct_2")));
  });
});

describe("send to thread", () => {
  it("names the picture after the demo", () => {
    assert.equal(markupFileName("pricing.html"), "pricing marked up.png");
    assert.equal(markupFileName("Board demo.HTM"), "Board demo marked up.png");
    assert.equal(markupFileName("a/b.html"), "a-b marked up.png");
    assert.equal(markupFileName(""), "Demo marked up.png");
  });

  it("writes a short reply text", () => {
    assert.equal(markupReplyText("pricing.html", 3), "Marked-up picture of the demo pricing.html.");
    assert.equal(markupReplyText("pricing.html", 0), "Picture of the demo pricing.html.");
  });

  const WINDOW = viewportBox(1200, 800);

  it("captures only the part of the card that is on screen", () => {
    const whole = visibleCaptureRect({ x: 100, y: 50, width: 400, height: 300 }, [WINDOW]);
    assert.deepEqual(whole, { rect: { x: 100, y: 50, width: 400, height: 300 }, complete: true });
    const cut = visibleCaptureRect({ x: 100, y: 600, width: 400, height: 300 }, [WINDOW]);
    assert.deepEqual(cut, { rect: { x: 100, y: 600, width: 400, height: 200 }, complete: false });
    const above = visibleCaptureRect({ x: 0, y: -100, width: 400, height: 300 }, [WINDOW]);
    assert.deepEqual(above, { rect: { x: 0, y: 0, width: 400, height: 200 }, complete: false });
    assert.deepEqual(visibleCaptureRect({ x: 0, y: 900, width: 400, height: 300 }, [WINDOW]), { rect: null, complete: false });
  });

  it("rounds a fractional rectangle outward", () => {
    const result = visibleCaptureRect({ x: 10.4, y: 20.4, width: 100.2, height: 50.2 }, [WINDOW]);
    assert.deepEqual(result.rect, { x: 10, y: 20, width: 101, height: 51 });
    assert.equal(result.complete, true);
  });

  it("cuts the picture to every box that clips the card, so a tall card never reaches the composer", () => {
    // The window is 800 high. The message list ends at 700; the composer fills 700 to 800.
    const messageList = { left: 250, top: 40, right: 1100, bottom: 700 };
    const card = { x: 300, y: 300, width: 760, height: 1500 };
    const result = visibleCaptureRect(card, [WINDOW, messageList]);
    assert.deepEqual(result, { rect: { x: 300, y: 300, width: 760, height: 400 }, complete: false });
    assert.ok(result.rect!.y + result.rect!.height <= messageList.bottom, "ends where the list ends");
    // Without the list's box, the window alone would let the picture run into the composer.
    assert.equal(visibleCaptureRect(card, [WINDOW]).rect!.height, 500);
  });

  it("uses the smallest of several clipping boxes", () => {
    const rect = visibleCaptureRect(
      { x: 0, y: 0, width: 500, height: 500 },
      [WINDOW, { left: 0, top: 0, right: 450, bottom: 480 }, { left: 20, top: 30, right: 1000, bottom: 400 }],
    );
    assert.deepEqual(rect, { rect: { x: 20, y: 30, width: 430, height: 370 }, complete: false });
  });

  it("gives nothing when a clipping box leaves no part of the card", () => {
    assert.deepEqual(
      visibleCaptureRect({ x: 0, y: 0, width: 100, height: 100 }, [WINDOW, { left: 0, top: 200, right: 500, bottom: 300 }]),
      { rect: null, complete: false },
    );
  });

  it("keeps a card that fits every box whole", () => {
    const result = visibleCaptureRect(
      { x: 300, y: 100, width: 400, height: 300 },
      [WINDOW, { left: 250, top: 40, right: 1100, bottom: 700 }, { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }],
    );
    assert.deepEqual(result, { rect: { x: 300, y: 100, width: 400, height: 300 }, complete: true });
  });

  describe("clipping ancestors", () => {
    interface Node {
      name: string;
      parent: Node | null;
      clipX: boolean;
      clipY: boolean;
      box: { x: number; y: number; width: number; height: number };
    }
    const node = (name: string, parent: Node | null, box: Node["box"], clip: [boolean, boolean] = [false, false]): Node =>
      ({ name, parent, clipX: clip[0], clipY: clip[1], box });
    const ops: ClipOps<Node> = {
      parent: (n) => n.parent,
      clips: (n) => ({ x: n.clipX, y: n.clipY }),
      box: (n) => n.box,
    };

    it("collects the boxes of the ancestors that clip, nearest first, and not the card itself", () => {
      const page = node("page", null, { x: 0, y: 0, width: 1200, height: 800 }, [true, true]);
      const main = node("main", page, { x: 250, y: 0, width: 900, height: 800 });
      const viewport = node("viewport", main, { x: 250, y: 40, width: 850, height: 660 }, [true, true]);
      const list = node("list", viewport, { x: 250, y: 40, width: 850, height: 660 }, [false, true]);
      const row = node("row", list, { x: 300, y: 300, width: 760, height: 1500 });
      const card = node("card", row, { x: 300, y: 300, width: 760, height: 1500 }, [true, true]);
      const boxes = clippingBoxes(card, ops);
      assert.equal(boxes.length, 3);
      assert.deepEqual(boxes[0], { left: -Infinity, right: Infinity, top: 40, bottom: 700 });
      assert.deepEqual(boxes[1], { left: 250, right: 1100, top: 40, bottom: 700 });
      assert.deepEqual(boxes[2], { left: 0, right: 1200, top: 0, bottom: 800 });
    });

    it("stops the picture at the end of the message list, above the composer", () => {
      const page = node("page", null, { x: 0, y: 0, width: 1200, height: 800 }, [true, true]);
      const viewport = node("viewport", page, { x: 250, y: 40, width: 850, height: 660 }, [true, true]);
      const card = node("card", viewport, { x: 300, y: 300, width: 760, height: 1500 }, [true, true]);
      const box = card.box;
      const result = visibleCaptureRect(box, [WINDOW, ...clippingBoxes(card, ops)]);
      assert.equal(result.rect!.y + result.rect!.height, 700);
      assert.equal(result.complete, false);
    });

    it("finds no box when nothing above the card clips", () => {
      const page = node("page", null, { x: 0, y: 0, width: 1200, height: 800 });
      const card = node("card", page, { x: 0, y: 0, width: 10, height: 10 });
      assert.deepEqual(clippingBoxes(card, ops), []);
      assert.deepEqual(clippingBoxes(page, ops), []);
    });
  });
});

describe("stroke ids", () => {
  it("makes ids the server accepts, different each time", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newStrokeId()));
    assert.equal(ids.size, 50);
    const key = liveDemoKey("msg_1", "att_1")!;
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9_-]{12}$/);
      assert.ok(parseLiveClientFrame({ t: "ink", demo: key, id, pts: [[1, 1]] }));
    }
  });

  it("uses url-safe characters for every byte value", () => {
    const id = newStrokeId((bytes) => bytes.fill(0xfb));
    assert.match(id, /^[A-Za-z0-9_-]{12}$/);
    assert.ok(!/[+/=]/.test(newStrokeId((bytes) => bytes.fill(0xff))));
  });
});

describe("width sync", () => {
  it("asks main for the newest width, one call at a time", async () => {
    const asked: number[] = [];
    let inFlight = 0;
    let overlap = false;
    const release: Array<() => void> = [];
    const scales: Array<[number, number]> = [];
    const sync = createWidthSync(
      (width) => new Promise<number>((resolve) => {
        asked.push(width);
        inFlight++;
        if (inFlight > 1) overlap = true;
        release.push(() => { inFlight--; resolve(width / 760); });
      }),
      (scale, width) => scales.push([scale, width]),
      () => assert.fail("no error expected"),
    );
    sync.request(400);
    sync.request(410);
    sync.request(420);
    sync.request(430);
    assert.deepEqual(asked, [400], "later widths wait for the call in flight");
    release.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asked, [400, 430], "only the newest waiting width is asked");
    release.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(overlap, false);
    assert.deepEqual(scales, [[400 / 760, 400], [430 / 760, 430]]);
  });

  it("does not ask again for a width that is applied, unless forced", async () => {
    const asked: number[] = [];
    const sync = createWidthSync(async (width) => { asked.push(width); return 0.5; }, () => undefined, () => undefined);
    sync.request(400);
    await new Promise((resolve) => setImmediate(resolve));
    sync.request(400);
    await new Promise((resolve) => setImmediate(resolve));
    sync.request(400, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asked, [400, 400]);
  });

  it("reports an error once and stops, and ignores answers after close", async () => {
    const errors: unknown[] = [];
    const scales: number[] = [];
    const failing = createWidthSync(async () => { throw new Error("refused"); }, (scale) => scales.push(scale), (error) => errors.push(error));
    failing.request(400);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);

    let finish: (scale: number) => void = () => undefined;
    const closing = createWidthSync(() => new Promise<number>((resolve) => { finish = resolve; }), (scale) => scales.push(scale), (error) => errors.push(error));
    closing.request(400);
    closing.close();
    finish(0.5);
    await new Promise((resolve) => setImmediate(resolve));
    closing.request(500);
    assert.deepEqual(scales, []);
    assert.equal(errors.length, 1);
  });
});

describe("live demo session", () => {
  const ROOM = "github.com/org/repo";
  const KEY = liveDemoKey("msg_5", "att_9")!;
  const OTHER = { accountId: "acct_2", name: "Bo", color: LIVE_DEMO_COLORS[2] };
  const OWN = { accountId: "acct_1", name: "Emmy", color: liveDemoColor("acct_1") };

  const mark = (id: string, author = OWN, createdAt = "2026-01-01T00:00:00.000Z"): DemoMark => ({
    id, demo: KEY, kind: "pin", at: [1, 2], text: "Hi", author, anchor: null, createdAt,
  });

  function setup(options: { listed?: DemoMark[]; listFails?: boolean } = {}) {
    const handlers = new Set<(event: DesktopLiveDemoEvent) => void>();
    const sent: DesktopLiveDemoClientFrame[] = [];
    const joined: string[] = [];
    let listCalls = 0;
    const added: unknown[] = [];
    const removed: string[] = [];
    let time = 1000;
    const api: LiveDemoApi = {
      async join(room, key, lease) { joined.push(`join ${room} ${key} ${lease}`); },
      async leave(room, key) { joined.push(`leave ${room} ${key}`); },
      async send(_room, frame) { sent.push(frame); },
      async listMarks() { listCalls++; if (options.listFails) throw new Error("no"); return options.listed ?? []; },
      async addMark(_room, input) {
        added.push(input);
        return { ...mark("mark_new_001"), ...(input.kind === "pin" ? { at: input.at, text: input.text } : { kind: "stroke", points: input.points }) } as DemoMark;
      },
      async removeMark(_room, id) { removed.push(id); },
      async viewerAccountId() { return "acct_1"; },
    };
    const events = {
      register(_room: string, _key: string, handler: (event: DesktopLiveDemoEvent) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
    };
    const session = useLiveDemo({
      roomIdentifier: () => ROOM,
      demoKey: () => KEY,
      api,
      events,
      now: () => time,
    });
    const emit = (frame: DesktopLiveDemoServerFrame) => { for (const handler of [...handlers]) handler({ type: "frame", roomIdentifier: ROOM, frame }); };
    const status = (value: "connecting" | "live" | "reconnecting" | "offline" | "refused", reason?: string) => {
      for (const handler of [...handlers]) handler({ type: "status", roomIdentifier: ROOM, status: value, ...(reason ? { reason } : {}) });
    };
    return {
      session, emit, status, sent, joined, added, removed,
      listCalls: () => listCalls,
      handlers: () => handlers.size,
      tick: (ms: number) => { time += ms; },
    };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("joins the demo, loads the saved marks and learns who the viewer is", async () => {
    const t = setup({ listed: [mark("mark_listed_01")] });
    assert.equal(t.session.start("lease://one"), true);
    await settle();
    assert.deepEqual(t.joined, [`join ${ROOM} ${KEY} lease://one`]);
    assert.deepEqual(t.session.marks.value.map((m) => m.id), ["mark_listed_01"]);
    assert.equal(t.session.isOwnMark(t.session.marks.value[0]), true);
    assert.equal(t.session.isOwnMark(mark("mark_other_01", OTHER)), false);
    assert.equal(t.session.viewerColor.value, liveDemoColor("acct_1"));
  });

  it("leaves the demo and forgets everything on stop", async () => {
    const t = setup({ listed: [mark("mark_listed_01")] });
    t.session.start("lease://one");
    await settle();
    t.emit({ t: "presence", demo: KEY, people: [{ cid: "p1", name: "Bo", color: LIVE_DEMO_COLORS[2] }] });
    t.session.stop();
    assert.equal(t.handlers(), 0);
    assert.deepEqual(t.joined, [`join ${ROOM} ${KEY} lease://one`, `leave ${ROOM} ${KEY}`]);
    assert.deepEqual(t.session.people.value, []);
    assert.deepEqual(t.session.marks.value, []);
    assert.equal(t.session.status.value, null);
  });

  it("does not join a demo without a room or a key", () => {
    const session = useLiveDemo({ roomIdentifier: () => null, demoKey: () => KEY, api: {} as LiveDemoApi });
    assert.equal(session.start("lease"), false);
  });

  it("tracks the people on the demo and drops the cursor of anyone who left", async () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] });
    t.emit({ t: "presence", demo: KEY, people: [{ cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] }, { cid: "p1", name: "Bo", color: LIVE_DEMO_COLORS[2] }] });
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 10, y: 20 });
    assert.equal(t.session.selfCid.value, "me");
    assert.equal(t.session.people.value.length, 2);
    assert.deepEqual(t.session.cursors.cids(), ["p1"]);
    const version = t.session.cursorVersion.value;
    t.emit({ t: "presence", demo: KEY, people: [{ cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] }] });
    assert.deepEqual(t.session.cursors.cids(), []);
    assert.ok(t.session.cursorVersion.value > version);
  });

  it("raises the cursor version when a cursor appears or goes, not when it moves", () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 10, y: 20 });
    const version = t.session.cursorVersion.value;
    t.tick(50);
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 11, y: 21 });
    t.tick(50);
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 12, y: 22 });
    assert.equal(t.session.cursorVersion.value, version);
    t.emit({ t: "cur", demo: KEY, cid: "p1", gone: true });
    assert.equal(t.session.cursorVersion.value, version + 1);
  });

  it("wakes the frame loop for cursor and ink frames, with the arrival time", () => {
    const t = setup();
    t.session.start("lease://one");
    let wakes = 0;
    t.session.onWake(() => { wakes++; });
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 10, y: 20 });
    t.emit({ t: "ink", demo: KEY, cid: "p1", id: "stroke-aaaa", pts: [[1, 1]] });
    assert.equal(wakes, 2);
    assert.deepEqual(t.session.cursors.positionOf("p1", 1000), { x: 10, y: 20 });
    assert.equal(t.session.ink.strokes().length, 1);
  });

  it("ignores its own cursor and ink if the server echoes them", () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "hello", cid: "me", name: "Emmy", color: LIVE_DEMO_COLORS[0] });
    t.emit({ t: "cur", demo: KEY, cid: "me", x: 1, y: 1 });
    t.emit({ t: "ink", demo: KEY, cid: "me", id: "stroke-aaaa", pts: [[1, 1]] });
    assert.deepEqual(t.session.cursors.cids(), []);
    assert.equal(t.session.ink.strokes().length, 0);
  });

  it("applies mark and unmark frames", () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "mark", demo: KEY, mark: mark("mark_aaaaaa", OTHER) });
    t.emit({ t: "mark", demo: KEY, mark: mark("mark_bbbbbb", OTHER, "2026-01-02T00:00:00.000Z") });
    t.emit({ t: "unmark", demo: KEY, id: "mark_aaaaaa" });
    assert.deepEqual(t.session.marks.value.map((m) => m.id), ["mark_bbbbbb"]);
  });

  it("keeps a mark that arrives while the list loads", async () => {
    const t = setup({ listed: [] });
    t.session.start("lease://one");
    t.emit({ t: "mark", demo: KEY, mark: mark("mark_early_01", OTHER) });
    await settle();
    assert.deepEqual(t.session.marks.value.map((m) => m.id), ["mark_early_01"]);
  });

  it("shows the connection state and loads the marks again after a reconnect", async () => {
    const t = setup({ listed: [mark("mark_listed_01")] });
    t.session.start("lease://one");
    await settle();
    t.status("live");
    assert.equal(t.session.status.value, "live");
    assert.equal(t.listCalls(), 1);
    t.emit({ t: "presence", demo: KEY, people: [{ cid: "p1", name: "Bo", color: LIVE_DEMO_COLORS[2] }] });
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 5, y: 5 });
    t.status("reconnecting");
    assert.equal(t.session.status.value, "reconnecting");
    assert.deepEqual(t.session.people.value, [], "who is there is unknown while the connection is down");
    assert.deepEqual(t.session.cursors.cids(), []);
    t.status("live");
    await settle();
    assert.equal(t.listCalls(), 2);
    t.status("live");
    assert.equal(t.listCalls(), 2, "only a recovery reloads");
  });

  it("keeps the reason main gives for a connection that is off, and clears the room's people", () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "presence", demo: KEY, people: [{ cid: "p1", name: "Bo", color: LIVE_DEMO_COLORS[2] }] });
    t.status("refused", "You are not a member of this room.");
    assert.equal(t.session.status.value, "refused");
    assert.equal(t.session.statusReason.value, "You are not a member of this room.");
    assert.deepEqual(t.session.people.value, []);
    t.status("connecting");
    assert.equal(t.session.statusReason.value, null);
  });

  it("shows the server's words when it refuses this demo's join, until the room answers", () => {
    const t = setup();
    t.session.start("lease://one");
    t.emit({ t: "error", code: "demo_full", message: "Too many people are viewing this demo live.", demo: KEY } as unknown as DesktopLiveDemoServerFrame);
    assert.equal(t.session.joinError.value, "Too many people are viewing this demo live.");
    t.emit({ t: "presence", demo: KEY, people: [] });
    assert.equal(t.session.joinError.value, null);
  });

  it("treats a connection that starts over like one that dropped", async () => {
    const t = setup({ listed: [mark("mark_listed_01")] });
    t.session.start("lease://one");
    await settle();
    t.status("live");
    t.emit({ t: "cur", demo: KEY, cid: "p1", x: 1, y: 1 });
    t.status("connecting");
    assert.deepEqual(t.session.cursors.cids(), []);
    t.status("live");
    await settle();
    assert.equal(t.listCalls(), 2);
  });

  it("marks the join as failed when main refuses it", async () => {
    const handlers = new Set<(event: DesktopLiveDemoEvent) => void>();
    const session = useLiveDemo({
      roomIdentifier: () => ROOM,
      demoKey: () => KEY,
      api: {
        async join() { throw new Error("no"); }, async leave() { /* nothing */ }, async send() { /* nothing */ },
        async listMarks() { return []; }, async addMark() { throw new Error("no"); }, async removeMark() { /* nothing */ },
        async viewerAccountId() { return null; },
      },
      events: { register: (_room, _key, handler) => { handlers.add(handler); return () => handlers.delete(handler); } },
    });
    session.start("lease");
    await settle();
    assert.equal(session.joinError.value, "no");
  });

  it("sends cursor and ink frames for its demo", () => {
    const t = setup();
    t.session.start("lease://one");
    t.session.sendCursor([10, 20]);
    t.session.sendCursor(null);
    t.session.sendInk("stroke-aaaa", [[1, 2]], false);
    t.session.sendInk("stroke-aaaa", [], true);
    assert.deepEqual(t.sent, [
      { t: "cur", demo: KEY, x: 10, y: 20 },
      { t: "cur", demo: KEY, gone: true },
      { t: "ink", demo: KEY, id: "stroke-aaaa", pts: [[1, 2]] },
      { t: "ink", demo: KEY, id: "stroke-aaaa", pts: [], end: true },
    ]);
    for (const frame of t.sent) assert.ok(parseLiveClientFrame(frame), JSON.stringify(frame));
    t.session.stop();
    t.session.sendCursor([1, 1]);
    assert.equal(t.sent.length, 4, "nothing is sent after stop");
  });

  it("saves strokes and pins as marks and merges the saved mark, once", async () => {
    const t = setup();
    t.session.start("lease://one");
    await settle();
    const stroke = await t.session.addStroke([[0, 0], [5, 5]]);
    assert.equal(stroke.id, "mark_new_001");
    // The same mark arrives again as a frame.
    t.emit({ t: "mark", demo: KEY, mark: stroke });
    assert.equal(t.session.marks.value.length, 1);
    await t.session.addPin([3, 4], "Look");
    assert.deepEqual(t.added, [
      { demo: KEY, kind: "stroke", points: [[0, 0], [5, 5]], anchor: null },
      { demo: KEY, kind: "pin", at: [3, 4], text: "Look", anchor: null },
    ]);
    for (const input of t.added) assert.ok(parseDemoMarkInput(input));
  });

  it("deletes a mark through main and removes it from the list", async () => {
    const t = setup({ listed: [mark("mark_listed_01")] });
    t.session.start("lease://one");
    await settle();
    await t.session.deleteMark("mark_listed_01");
    assert.deepEqual(t.removed, ["mark_listed_01"]);
    assert.deepEqual(t.session.marks.value, []);
  });

  it("keeps a mark whose delete failed", async () => {
    const failing = useLiveDemo({
      roomIdentifier: () => ROOM,
      demoKey: () => KEY,
      api: {
        async join() { /* nothing */ }, async leave() { /* nothing */ }, async send() { /* nothing */ },
        async listMarks() { return [mark("mark_listed_01")]; }, async addMark() { throw new Error("no"); },
        async removeMark() { throw new Error("denied"); }, async viewerAccountId() { return "acct_1"; },
      },
      events: { register: () => () => undefined },
    });
    failing.start("lease");
    await settle();
    await assert.rejects(failing.deleteMark("mark_listed_01"), /denied/);
    assert.equal(failing.marks.value.length, 1);
  });

  it("refuses to save a mark when it is not joined", async () => {
    const t = setup();
    await assert.rejects(t.session.addPin([1, 1], "x"), /Update LetAgents/);
  });
});
