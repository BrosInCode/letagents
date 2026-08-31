import type { NativeExecutionFact, NativeExecutionObservation } from "../../../shared/execution-protocol.js";

/** Structural observations only; no raw payloads, transcript replay, or control. */
export class ProviderExecutionObserver {
  private sequence = 0;
  private readonly listeners = new Set<(event: NativeExecutionObservation) => void>();

  constructor(private readonly now: () => string) {}

  subscribe(listener: (event: NativeExecutionObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(fact: NativeExecutionFact, nativeProcessIdentity?: string): void {
    const event = Object.freeze({ sequence: ++this.sequence, observedAtMs: Date.parse(this.now()), fact: Object.freeze({ ...fact }),
      ...(nativeProcessIdentity ? { nativeProcessIdentity } : {}) });
    for (const listener of this.listeners) {
      // Shadow observers cannot suppress native settlement or change a legacy
      // provider's lifecycle. Their journal owns gaps and ingestion failures.
      try { listener(event); } catch { /* observation only */ }
    }
  }
}

export function nativeExecutionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value);
}
