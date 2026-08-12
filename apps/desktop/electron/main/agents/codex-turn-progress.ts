export const CODEX_EVENT_TURN_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const CODEX_EVENT_TURN_ABSOLUTE_TIMEOUT_MS = 60 * 60_000;
export const CODEX_EVENT_TURN_WAITING_AFTER_MS = 30_000;

export type CodexTurnTimeoutReason = "inactivity" | "absolute";
export type CodexTurnActivityState = "working" | "waiting";

export type CodexTurnProgressObservation = {
  source: string;
  fingerprint: string;
  observedAt: number;
};

export type CodexTurnProgressTrackerOptions = {
  startedAt: number;
  inactivityTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  waitingAfterMs?: number;
};

/**
 * Tracks observable forward progress for one Codex turn. Repeated snapshots do
 * not move the inactivity deadline; new runtime events and changed snapshots
 * do. Explicit external waits pause only the inactivity deadline, never the
 * absolute ceiling.
 */
export class CodexTurnProgressTracker {
  private readonly startedAt: number;
  private readonly inactivityTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly waitingAfterMs: number;
  private readonly fingerprints = new Map<string, string>();
  private readonly explicitWaitKeys = new Set<string>();
  private lastProgressAt: number;

  constructor(options: CodexTurnProgressTrackerOptions) {
    this.startedAt = options.startedAt;
    this.lastProgressAt = options.startedAt;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? CODEX_EVENT_TURN_INACTIVITY_TIMEOUT_MS;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? CODEX_EVENT_TURN_ABSOLUTE_TIMEOUT_MS;
    this.waitingAfterMs = options.waitingAfterMs ?? CODEX_EVENT_TURN_WAITING_AFTER_MS;
  }

  observeProgress(observation: CodexTurnProgressObservation): boolean {
    if (this.fingerprints.get(observation.source) === observation.fingerprint) {
      return false;
    }
    this.fingerprints.set(observation.source, observation.fingerprint);
    this.lastProgressAt = Math.max(this.lastProgressAt, observation.observedAt);
    return true;
  }

  beginExplicitWait(key: string, observation: CodexTurnProgressObservation): boolean {
    const progressed = this.observeProgress(observation);
    this.explicitWaitKeys.add(key);
    return progressed;
  }

  endExplicitWait(key: string, observation: CodexTurnProgressObservation): boolean {
    const progressed = this.observeProgress(observation);
    this.explicitWaitKeys.delete(key);
    return progressed;
  }

  replaceExplicitWaits(
    namespace: string,
    keys: Iterable<string>,
    observation: CodexTurnProgressObservation,
  ): boolean {
    const prefix = `${namespace}:`;
    for (const key of this.explicitWaitKeys) {
      if (key.startsWith(prefix)) {
        this.explicitWaitKeys.delete(key);
      }
    }
    for (const key of keys) {
      this.explicitWaitKeys.add(`${prefix}${key}`);
    }
    return this.observeProgress(observation);
  }

  hasExplicitWait(): boolean {
    return this.explicitWaitKeys.size > 0;
  }

  activityState(now: number): CodexTurnActivityState {
    return this.hasExplicitWait() || now - this.lastProgressAt >= this.waitingAfterMs
      ? "waiting"
      : "working";
  }

  timeoutReason(now: number): CodexTurnTimeoutReason | null {
    if (now - this.startedAt >= this.absoluteTimeoutMs) {
      return "absolute";
    }
    if (!this.hasExplicitWait() && now - this.lastProgressAt >= this.inactivityTimeoutMs) {
      return "inactivity";
    }
    return null;
  }

  lastProgressTimestamp(): number {
    return this.lastProgressAt;
  }
}
