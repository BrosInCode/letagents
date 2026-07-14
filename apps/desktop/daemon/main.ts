import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import type { ProviderActionPort } from "./provider-action-port.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import type { DaemonManifestEntry, ObservedState, PolicyCondition } from "./types.js";

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs">;

export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly socket: DaemonControlSocket;

  constructor(paths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort) {
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.store = new ManifestStore(paths.manifestPath);
    this.audit = new AuditLog(paths.auditPath);
    this.socket = new DaemonControlSocket(paths.socketPath, async (request) => {
      await this.singleton.assertCurrent();
      if (request.method === "manifest.list") return (await this.store.load()).entries;
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }, async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); });
  }

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.manifestGeneration = (await this.store.load()).generation;
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.stop();
    await this.singleton.release();
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string): Promise<void> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const updated: DaemonManifestEntry = { ...entry, observed_state: to, condition, reconciliation: advanceReconciliationState(entry.reconciliation, to, Date.now()) };
    const next = await this.store.write(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate));
    this.manifestGeneration = next.generation;
    await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause, actor, generation: next.generation });
  }

  /**
   * The daemon owns this convergence entry point: manifest state is the source
   * of truth, and every retry deadline survives a daemon restart. P1e supplies
   * the real control-socket port; tests may inject a fake port directly.
   */
  async reconcile(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor = "reconciler") {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    const reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, input.nowMs);
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const persisted = { ...entry, reconciliation };
      const next = await this.store.write(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? persisted : candidate));
      this.manifestGeneration = next.generation;
    }

    const result = await new ProviderReconciler(this.providerPort).reconcile({
      ...input,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.failure_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs);
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state || target.condition !== entry.condition) {
      await this.transition(entryId, target.observedState, target.condition, result.decision.reason, actor);
    }
    return result;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new SupervisorDaemon();
  void daemon.start().catch((error) => { console.error(error); process.exitCode = 1; });
}
