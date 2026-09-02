import type { ManifestStore, PendingTypedLifecycleEffect, TypedLifecycleEffectInstallation } from "./manifest-store.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";
import type { ObservedState } from "./types.js";

type Options = {
  store: Pick<ManifestStore, "listPendingTypedLifecycleEffects" | "applyTypedLifecycleEffect">;
  currentInstallation(agentId: string): ProviderInstallationToken | undefined;
  authority: {
    serialize<T>(operation: () => Promise<T>): Promise<T>;
    assertCurrent(): Promise<void>;
    currentManifestGeneration(): number;
    acceptManifestGeneration(generation: number): void;
    fenceCommit(commit: () => Promise<void>): Promise<void>;
  };
  isClosing(): boolean;
  nowMs(): number;
  diagnostic(agentId: string, error: unknown): void;
  changed?(agentId: string, observedState: ObservedState | null): void;
};

const BATCH_SIZE = 32;
const RETRY_MS = 1_000;

/**
 * Restart-safe consumer for the deliberately narrow typed turn projection.
 * It owns no provider, delivery, process-terminal, or remote-publication side
 * effect. The SQLite disposition is the retry queue; changed() is only a hint.
 */
export class TypedLifecycleEffectCoordinator {
  private readonly dirty = new Set<string | null>();
  private scheduled: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private settlementTail: Promise<void> = Promise.resolve();
  private closed = false;
  private retryAfterMs = 0;
  private scanAfterFactSequence = 0;

  constructor(private readonly options: Options) {}

  start(): void { this.changed(); }

  changed(agentId?: string): void {
    if (this.closed || this.options.isClosing()) return;
    this.dirty.add(agentId ?? null);
    this.schedule();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dirty.clear();
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    await this.settlementTail;
    await this.draining?.catch(() => undefined);
  }

  /** Drain one exact provider birth now; callers use this as an identity-retirement barrier. */
  settle(agentId: string): Promise<void> {
    const settlement = this.settlementTail.then(() => this.settleTarget(agentId));
    this.settlementTail = settlement.catch(() => undefined);
    return settlement;
  }

  private async settleTarget(agentId: string): Promise<void> {
    if (this.closed || this.options.isClosing()) throw new Error("Typed lifecycle settlement is unavailable.");
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    await this.draining;
    // The completed background drain may have scheduled its successor in its
    // finally block while this barrier was waiting. Retake the scheduler slot
    // before installing the exact-agent drain so no timer can overwrite it.
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    if (this.closed || this.options.isClosing()) throw new Error("Typed lifecycle settlement is unavailable.");
    this.retryAfterMs = 0;
    this.dirty.add(agentId);
    const draining = this.drain(agentId);
    this.draining = draining;
    try {
      await draining;
    } finally {
      if (this.draining === draining) this.draining = null;
      if (this.dirty.size) this.schedule();
    }
    if ((await this.options.store.listPendingTypedLifecycleEffects(agentId, 1)).length) {
      throw new Error("Typed lifecycle effect did not settle before provider identity retirement.");
    }
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.draining || this.options.isClosing()) return;
    const delay = Math.max(0, this.retryAfterMs - Date.now());
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (this.draining) {
        // The active drain owns rescheduling from its finally block.
        return;
      }
      this.retryAfterMs = 0;
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (this.dirty.size) this.schedule();
      });
    }, delay);
    this.scheduled.unref();
  }

  private retry(agentId: string | null): void {
    this.dirty.add(agentId);
    this.retryAfterMs = Math.max(this.retryAfterMs, Date.now() + RETRY_MS);
  }

  private report(agentId: string, error: unknown): void {
    try { this.options.diagnostic(agentId, error); } catch { /* diagnostics never own retry */ }
  }

  private async drain(targetAgentId?: string): Promise<void> {
    while (!this.closed && !this.options.isClosing()) {
      const next = targetAgentId === undefined
        ? this.dirty.values().next()
        : this.dirty.has(targetAgentId)
          ? { done: false as const, value: targetAgentId }
          : { done: true as const, value: undefined };
      if (next.done) return;
      const agentId = next.value;
      this.dirty.delete(agentId);
      let effects: PendingTypedLifecycleEffect[];
      try {
        effects = await this.options.store.listPendingTypedLifecycleEffects(
          agentId ?? undefined,
          BATCH_SIZE,
          agentId === null ? this.scanAfterFactSequence : 0,
        );
      } catch (error) {
        this.report(agentId ?? "*", error);
        this.retry(agentId);
        return;
      }
      let progressed = false;
      let retry = false;
      const changedAgentIds = new Set<string>();
      const manifestStates = new Map<string, ObservedState>();
      for (const effect of effects) {
        if (this.closed || this.options.isClosing()) return;
        try {
          const token = this.options.currentInstallation(effect.agentId);
          const installation = this.installation(token);
          const result = await this.options.authority.serialize(async () => {
            await this.options.authority.assertCurrent();
            const applied = await this.options.store.applyTypedLifecycleEffect(
              this.options.authority.currentManifestGeneration(),
              effect,
              installation,
              this.options.authority.fenceCommit,
            );
            if (applied.generation !== this.options.authority.currentManifestGeneration()) {
              this.options.authority.acceptManifestGeneration(applied.generation);
            }
            return applied;
          });
          progressed ||= result.disposition !== "pending";
          if (result.disposition !== "pending") changedAgentIds.add(effect.agentId);
          if (result.disposition === "applied" && result.entry) {
            manifestStates.set(effect.agentId, result.entry.observed_state);
          }
        } catch (error) {
          this.report(effect.agentId, error);
          this.retry(effect.agentId);
          retry = true;
        }
      }
      if (agentId === null) {
        if (effects.length) this.scanAfterFactSequence = effects.at(-1)!.factSequence;
        if (effects.length === BATCH_SIZE) this.dirty.add(null);
        else this.scanAfterFactSequence = 0;
      } else if (effects.length === BATCH_SIZE && progressed) this.dirty.add(agentId);
      if (retry) return;
      if (agentId !== null) changedAgentIds.add(agentId);
      for (const changedAgentId of changedAgentIds) {
        try {
          this.options.changed?.(changedAgentId, manifestStates.get(changedAgentId) ?? null);
        } catch { /* admission hints own no effect authority */ }
      }
    }
  }

  private installation(token: ProviderInstallationToken | undefined): TypedLifecycleEffectInstallation | null {
    if (!token || token.authorityMode !== "typed"
      || token.providerConnection.pid === null || !token.providerConnection.processIdentity) return null;
    return {
      agentId: token.entryId,
      executionGenerationId: token.executionGenerationId,
      workAttemptId: token.workAttemptId,
      providerContinuationId: token.providerContinuationId,
      providerConnection: structuredClone(token.providerConnection),
      configurationRevision: token.configurationRevision,
      authorityMode: "typed",
      disposedAtMs: this.options.nowMs(),
    };
  }
}
