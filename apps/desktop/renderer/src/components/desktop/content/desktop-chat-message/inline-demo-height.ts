import { inlineDemoFrameHeight } from "./attachments";

/** A lower height must hold this long before the frame shrinks to it. */
export const INLINE_DEMO_HEIGHT_SETTLE_MS = 400;
/**
 * A page sized by its own frame reports a little less than the frame each time
 * the frame shrinks, so the frame would creep down to its minimum. Smaller
 * decreases than this are ignored.
 */
export const INLINE_DEMO_HEIGHT_MIN_SHRINK = 24;
/** More than this many changed reports in the window freeze the frame. */
export const INLINE_DEMO_JITTER_MAX_CHANGES = 10;
export const INLINE_DEMO_JITTER_WINDOW_MS = 2_000;

/**
 * What the frame shows, given the heights main reports. A page whose height
 * follows its own frame can report a new height every few frames, and each one
 * would move the chat, so growth shows at once, shrinking waits for a quiet
 * moment (and only counts when it is big enough), and a page that will not
 * settle is frozen at its largest height.
 * All heights are frame heights, already clamped.
 */
export interface InlineDemoHeight {
  /** The frame height now; `null` until the first report. */
  shown: number | null;
  /** A lower height waiting to show, and when it was first reported. */
  pending: { height: number; since: number } | null;
  /** The last height reported, to tell a change from a repeat. */
  latest: number | null;
  /** When the recent reports changed the height. */
  changedAt: number[];
  largest: number;
  /** Frozen at `shown` until the demo is reloaded. */
  held: boolean;
}

export function newInlineDemoHeight(shown: number | null = null): InlineDemoHeight {
  return { shown, pending: null, latest: null, changedAt: [], largest: 0, held: false };
}

/** Shows a pending lower height that has held long enough. */
export function settleInlineDemoHeight(state: InlineDemoHeight, now: number): InlineDemoHeight {
  if (!state.pending || now - state.pending.since < INLINE_DEMO_HEIGHT_SETTLE_MS) return state;
  return { ...state, shown: state.pending.height, pending: null };
}

/** Milliseconds until the pending lower height is due, or `null` when none waits. */
export function inlineDemoHeightSettleDelay(state: InlineDemoHeight, now: number): number | null {
  return state.pending
    ? Math.max(0, state.pending.since + INLINE_DEMO_HEIGHT_SETTLE_MS - now)
    : null;
}

/** Forgets a pending lower height, for a run that ended before it showed. */
export function dropPendingInlineDemoHeight(state: InlineDemoHeight): InlineDemoHeight {
  return state.pending ? { ...state, pending: null } : state;
}

/** Takes a page height (CSS px) that main reported at `now`. */
export function reportInlineDemoHeight(
  previous: InlineDemoHeight,
  contentHeight: number,
  now: number,
): InlineDemoHeight {
  const state = settleInlineDemoHeight(previous, now);
  if (state.held) return state;
  const height = inlineDemoFrameHeight(contentHeight);
  const largest = Math.max(state.largest, height);
  if (state.shown === null) {
    return { ...state, shown: height, latest: height, largest };
  }

  const changed = height !== state.latest;
  const changedAt = changed
    ? [...state.changedAt.filter((at) => now - at <= INLINE_DEMO_JITTER_WINDOW_MS), now]
    : state.changedAt;
  const next = { ...state, latest: height, changedAt, largest };
  if (changedAt.length > INLINE_DEMO_JITTER_MAX_CHANGES) {
    return { ...next, shown: Math.max(state.shown, largest), pending: null, held: true };
  }
  if (height > state.shown) return { ...next, shown: height, pending: null };
  if (state.shown - height < INLINE_DEMO_HEIGHT_MIN_SHRINK) return { ...next, pending: null };
  return { ...next, pending: state.pending?.height === height ? state.pending : { height, since: now } };
}
