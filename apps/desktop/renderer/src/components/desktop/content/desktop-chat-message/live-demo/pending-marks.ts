import { DEMO_MARK_RATE_LIMITED_TEXT, isLiveDemoAnchorPath, type DemoMark, type DemoMarkInput, type LiveDemoAnchor, type LiveDemoPoint } from "./protocol";

/** What a mark is, without where it is saved or who made it. Undo puts a deleted mark back from this. */
export type MarkBody =
  | { kind: "stroke"; points: LiveDemoPoint[] }
  /** `anchor`: the element under the pin, as the demo named it, for an agent that reads the pin. */
  | { kind: "pin"; at: LiveDemoPoint; text: string; anchor?: LiveDemoAnchor | null };

/**
 * A mark of yours that the server does not have yet. It is drawn dashed while it
 * waits, and saved when the link is back, so a bad link loses nothing.
 */
export interface PendingMark {
  key: number;
  /** The id the server saves it under. A save sent again names the same mark, so the server keeps one. */
  id: string;
  room: string;
  demo: string;
  body: MarkBody;
  /** A save failed at least once; the mark is shown as not saved. */
  waiting: boolean;
  attempts: number;
  /** Saves that failed while the connection said it was live: those are the ones that may never work. */
  liveFailures: number;
}

/** The wait before the next try, after `attempts` failed ones. */
export const PENDING_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
/** Failed saves while live after which a mark is given up (the server refuses it, say). */
export const PENDING_MAX_LIVE_FAILURES = 3;
/** Failed saves in all after which a mark is given up. */
export const PENDING_MAX_ATTEMPTS = 40;
/** The same once its card is gone (no one sees the mark wait any more). */
export const PENDING_MAX_ATTEMPTS_AWAY = 10;

/** The server refused for the pace of changes: wait and try again; it says nothing about the mark. */
export function isRateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DEMO_MARK_RATE_LIMITED_TEXT);
}

export function pendingRetryDelay(attempts: number): number {
  return PENDING_RETRY_MS[Math.min(Math.max(attempts, 1), PENDING_RETRY_MS.length) - 1];
}

export function markBody(mark: DemoMark): MarkBody {
  return mark.kind === "stroke"
    ? { kind: "stroke", points: mark.points.map(([x, y]) => [x, y]) }
    // An element path the server would now refuse (saved some other way) goes back without it, not refused.
    : { kind: "pin", at: [mark.at[0], mark.at[1]], text: mark.text,
      anchor: mark.anchor && isLiveDemoAnchorPath(mark.anchor.path) ? { ...mark.anchor } : null };
}

export function markInput(demo: string, body: MarkBody, id?: string): DemoMarkInput {
  const named = id === undefined ? {} : { id };
  return body.kind === "stroke"
    ? { ...named, demo, kind: "stroke", points: body.points, anchor: null }
    : { ...named, demo, kind: "pin", at: body.at, text: body.text, anchor: body.anchor ?? null };
}
