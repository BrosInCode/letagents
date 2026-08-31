import { randomUUID } from "node:crypto";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../../../shared/execution-protocol.js";

const MAX_RETAINED_OBSERVATIONS = 256;
const MAX_RETAINED_BYTES = 256 * 1024;
type Subscription = {
  listener: (event: NativeExecutionObservation) => void;
  lastDeliveredSequence: number;
  draining: boolean;
};

/** Bounded structural replay only; no raw payloads, transcript replay, or control. */
export class ProviderExecutionObserver {
  private readonly sourceId = randomUUID();
  private sequence = 0;
  private readonly listeners = new Set<Subscription>();
  private readonly history = new Map<number, { event: NativeExecutionObservation; bytes: number }>();
  private retainedBytes = 0;

  constructor(private readonly now: () => string) {}

  subscribe(listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    const subscription = { listener, lastDeliveredSequence: 0, draining: false };
    this.listeners.add(subscription);
    this.drain(subscription);
    return Object.freeze({
      sourceId: this.sourceId,
      position: () => ({ firstRetainedSequence: this.history.keys().next().value ?? this.sequence + 1, latestSequence: this.sequence }),
      dispose: () => { this.listeners.delete(subscription); },
    });
  }

  emit(fact: NativeExecutionFact, nativeProcessIdentity?: string): void {
    const event = Object.freeze({ sourceId: this.sourceId, sequence: ++this.sequence, observedAtMs: Date.parse(this.now()), fact: Object.freeze({ ...fact }),
      ...(nativeProcessIdentity ? { nativeProcessIdentity } : {}) });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    // Never relabel a retained suffix as complete history. Oversized facts
    // also consume their original position. position() exposes a dropped tail;
    // the next retained observation exposes any interior gap.
    if (bytes > MAX_RETAINED_BYTES) return;
    this.history.set(event.sequence, { event, bytes });
    this.retainedBytes += bytes;
    while (this.history.size > MAX_RETAINED_OBSERVATIONS || this.retainedBytes > MAX_RETAINED_BYTES) {
      const oldest = this.history.entries().next().value!;
      this.retainedBytes -= oldest[1].bytes;
      this.history.delete(oldest[0]);
    }
    for (const subscription of this.listeners) this.drain(subscription);
  }

  private drain(subscription: Subscription): void {
    if (subscription.draining) return;
    subscription.draining = true;
    try {
      // Replay and live delivery share this cursor. A callback can emit another
      // fact or unsubscribe without overtaking older facts for any listener.
      // No per-listener queue can grow beyond the shared retained history.
      for (const { event } of this.history.values()) {
        if (!this.listeners.has(subscription)) break;
        if (event.sequence <= subscription.lastDeliveredSequence) continue;
        subscription.lastDeliveredSequence = event.sequence;
        // Shadow observers cannot suppress native settlement or change legacy
        // lifecycle. Their journal owns gaps and ingestion failures.
        try { subscription.listener(event); } catch { /* observation only */ }
      }
    } finally {
      subscription.draining = false;
    }
  }
}

export function nativeExecutionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value);
}
