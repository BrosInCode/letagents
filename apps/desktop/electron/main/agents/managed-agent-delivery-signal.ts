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

/** Slow repair for a pause transition whose original acknowledgement was lost server-side. */
export const DESKTOP_DELIVERY_PAUSE_REPAIR_MS = 5 * 60_000;

export type DesktopDeliverySignalDecision =
  | { action: "send" }
  | { action: "skip"; reason: "terminal" | "backoff" | "unchanged" };

export type DesktopDeliverySignalState = "room_closed";

export interface DesktopDeliverySignalGeneration {
  readonly value: number;
}

export interface DesktopDeliverySignalLane {
  /** Retire prior outcomes and return the token for the next desired state. */
  advance(): DesktopDeliverySignalGeneration;
  /** Whether an asynchronous outcome still belongs to the desired state. */
  isCurrent(generation: DesktopDeliverySignalGeneration): boolean;
  /**
   * Serialize server mutations and coalesce an identical pending signal.
   * A newer generation skips queued stale work, while work already on the
   * wire finishes before the newer mutation begins.
   */
  run(
    generation: DesktopDeliverySignalGeneration,
    key: string,
    operation: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void>;
}

export interface DesktopDeliverySignalRecordResult {
  /** True once the session should stop signalling entirely (gone or exhausted). */
  terminal: boolean;
}

interface DesktopDeliverySignalEntry {
  failures: number;
  nextAttemptAt: number;
  terminal: boolean;
  acknowledgedState: DesktopDeliverySignalState | null;
  acknowledgedAt: number;
}

export interface DesktopDeliverySignalGuard {
  /** Decide whether a signal for this session may be sent right now. */
  beforeSend(sessionId: string, now?: number): DesktopDeliverySignalDecision;
  /** Skip a state transition the server has already acknowledged. */
  beforeStateChange(
    sessionId: string,
    state: DesktopDeliverySignalState,
    now?: number,
  ): DesktopDeliverySignalDecision;
  /** A signal succeeded — clear any backoff/failure bookkeeping. */
  recordSuccess(sessionId: string, state?: DesktopDeliverySignalState, now?: number): void;
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

export function createDesktopDeliverySignalLane(): DesktopDeliverySignalLane {
  let currentGeneration = 0;
  let tail = Promise.resolve();
  let pending: {
    generation: number;
    key: string;
    promise: Promise<void>;
  } | null = null;

  return {
    advance() {
      currentGeneration += 1;
      return { value: currentGeneration };
    },

    isCurrent(generation) {
      return generation.value === currentGeneration;
    },

    run(generation, key, operation) {
      if (
        pending
        && pending.generation === generation.value
        && pending.key === key
      ) return pending.promise;

      const isCurrent = () => generation.value === currentGeneration;
      const execution = tail
        .catch(() => undefined)
        .then(async () => {
          if (!isCurrent()) return;
          await operation(isCurrent);
        });
      tail = execution.catch(() => undefined);
      pending = { generation: generation.value, key, promise: execution };
      const clearPending = () => {
        if (pending?.promise === execution) pending = null;
      };
      execution.then(clearPending, clearPending);
      return execution;
    },
  };
}

function backoffDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  const delay = DESKTOP_DELIVERY_SIGNAL_BASE_BACKOFF_MS * 2 ** exponent;
  return Math.min(delay, DESKTOP_DELIVERY_SIGNAL_MAX_BACKOFF_MS);
}

export function createDesktopDeliverySignalGuard(): DesktopDeliverySignalGuard {
  const entries = new Map<string, DesktopDeliverySignalEntry>();

  const entryFor = (sessionId: string): DesktopDeliverySignalEntry | undefined => entries.get(sessionId);
  const decisionFor = (entry: DesktopDeliverySignalEntry | undefined, now: number): DesktopDeliverySignalDecision => {
    if (!entry) return { action: "send" };
    if (entry.terminal) return { action: "skip", reason: "terminal" };
    if (now < entry.nextAttemptAt) return { action: "skip", reason: "backoff" };
    return { action: "send" };
  };

  return {
    beforeSend(sessionId, now = Date.now()) {
      return decisionFor(entryFor(sessionId), now);
    },

    beforeStateChange(sessionId, state, now = Date.now()) {
      const entry = entryFor(sessionId);
      const decision = decisionFor(entry, now);
      if (decision.action === "skip") return decision;
      if (
        entry?.acknowledgedState === state
        && now - entry.acknowledgedAt < DESKTOP_DELIVERY_PAUSE_REPAIR_MS
      ) return { action: "skip", reason: "unchanged" };
      return { action: "send" };
    },

    recordSuccess(sessionId, state, now = Date.now()) {
      if (!state) {
        entries.delete(sessionId);
        return;
      }
      entries.set(sessionId, {
        failures: 0,
        nextAttemptAt: 0,
        terminal: false,
        acknowledgedState: state,
        acknowledgedAt: now,
      });
    },

    recordFailure(sessionId, status, now = Date.now()) {
      const entry = entries.get(sessionId) ?? {
        failures: 0,
        nextAttemptAt: 0,
        terminal: false,
        acknowledgedState: null,
        acknowledgedAt: 0,
      };
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
