import type { ManifestStore, PendingTypedLifecycleEffect, TypedLifecycleEffectInstallation } from "./manifest-store.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";

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
    await this.draining?.catch(() => undefined);
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.draining || this.options.isClosing()) return;
    const delay = Math.max(0, this.retryAfterMs - Date.now());
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
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

  private async drain(): Promise<void> {
    while (!this.closed && !this.options.isClosing()) {
      const next = this.dirty.values().next();
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
