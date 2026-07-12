// Paces the desktop delivery "signal" calls (desktop-heartbeat / desktop-pause)
// a managed worker fires at the room API. PR #715 wired those signals but left
// a pause-spam caveat: on a 404 the caller neither backed off nor gave up, so a
// worker whose session the server no longer recognised hammered the same failing
// POST several times a second, forever. This guard turns that into two rules:
//
//   • A "gone" response (404/410) is terminal — the delivery lease no longer
//     exists server-side, so we stop signalling for that session for good.
//   • Transient failures fall behind bounded exponential backoff and give up
//     after a capped run of consecutive failures.
//
// It is deliberately a pure, side-effect-free state machine so the retry policy
// can be unit-tested without the network / cloud-session plumbing.

/** HTTP statuses that mean the delivery lease is gone and must never be retried. */
const TERMINAL_SIGNAL_STATUSES = new Set([404, 410]);

/** Give up (treat as terminal) after this many consecutive transient failures. */
export const DESKTOP_DELIVERY_SIGNAL_MAX_TRANSIENT_FAILURES = 8;

/** First transient retry waits this long; each further failure doubles it. */
export const DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS = 1_000;

/** Backoff never grows past this ceiling. */
export const DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS = 5 * 60_000;

export type DesktopDeliverySignalDecision =
  | { action: "send" }
  | { action: "skip"; reason: "terminal" | "backoff" };

export interface DesktopDeliverySignalRecordResult {
  /** True once the session should stop signalling entirely (gone or exhausted). */
  terminal: boolean;
}

interface DesktopDeliverySignalEntry {
  failures: number;
  nextAttemptAt: number;
  terminal: boolean;
}

export interface DesktopDeliverySignalGuard {
  /** Decide whether a signal for this session may be sent right now. */
  beforeSend(sessionId: string, now?: number): DesktopDeliverySignalDecision;
  /** A signal succeeded — clear any backoff/failure bookkeeping. */
  recordSuccess(sessionId: string): void;
  /** A signal failed with the given HTTP status (null when non-HTTP). */
  recordFailure(
    sessionId: string,
    status: number | null,
    now?: number,
  ): DesktopDeliverySignalRecordResult;
  /** Reset a session so a genuine resume can signal again from a clean slate. */
  reset(sessionId: string): void;
  /** Drop all bookkeeping for a session that is being torn down. */
  forget(sessionId: string): void;
  /** Whether this session has already been marked terminal. */
  isTerminal(sessionId: string): boolean;
}

export function isTerminalDesktopDeliverySignalStatus(status: number | null): boolean {
  return status !== null && TERMINAL_SIGNAL_STATUSES.has(status);
}

function backoffDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  const delay = DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS * 2 ** exponent;
  return Math.min(delay, DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS);
}

export function createDesktopDeliverySignalGuard(): DesktopDeliverySignalGuard {
  const entries = new Map<string, DesktopDeliverySignalEntry>();

  return {
    beforeSend(sessionId, now = Date.now()) {
      const entry = entries.get(sessionId);
      if (!entry) return { action: "send" };
      if (entry.terminal) return { action: "skip", reason: "terminal" };
      if (now < entry.nextAttemptAt) return { action: "skip", reason: "backoff" };
      return { action: "send" };
    },

    recordSuccess(sessionId) {
      entries.delete(sessionId);
    },

    recordFailure(sessionId, status, now = Date.now()) {
      const entry = entries.get(sessionId) ?? { failures: 0, nextAttemptAt: 0, terminal: false };
      if (isTerminalDesktopDeliverySignalStatus(status)) {
        entry.terminal = true;
        entries.set(sessionId, entry);
        return { terminal: true };
      }
      entry.failures += 1;
      if (entry.failures >= DESKTOP_DELIVERY_SIGNAL_MAX_TRANSIENT_FAILURES) {
        entry.terminal = true;
        entries.set(sessionId, entry);
        return { terminal: true };
      }
      entry.nextAttemptAt = now + backoffDelayMs(entry.failures);
      entries.set(sessionId, entry);
      return { terminal: false };
    },

    reset(sessionId) {
      entries.delete(sessionId);
    },

    forget(sessionId) {
      entries.delete(sessionId);
    },

    isTerminal(sessionId) {
      return entries.get(sessionId)?.terminal ?? false;
    },
  };
}
