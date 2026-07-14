import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import type { ProviderActionHandle, ProviderActionPort, ProviderActionTerminal } from "./provider-action-port.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState, beginReconciliationAction, completeReconciliationAction, recordReconciliationActionFailure } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import type { DaemonManifestEntry, ObservedState, PolicyCondition } from "./types.js";

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly socket: DaemonControlSocket;
  private readonly reconciliationTicks = new Map<string, Promise<void>>();
  private manifestMutation: Promise<void> = Promise.resolve();

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

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.serializeManifestMutation(() => this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const notices = [...(entry.reconciliation_notices ?? [])];
    if (condition === "quarantined") notices.push({ at: new Date().toISOString(), kind: "quarantine_death", cause });
    if (condition === "coordination_blocked") notices.push({ at: new Date().toISOString(), kind: "coordination_escalation", cause });
    const updated: DaemonManifestEntry = { ...entry, observed_state: to, condition, reconciliation: reconciliation ?? advanceReconciliationState(entry.reconciliation, to, Date.now()), reconciliation_notices: notices.slice(-32) };
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
    return this.serializeEntryTick(entryId, () => this.serializeManifestMutation(() => this.reconcileOnce(entryId, input, watchdogThresholdMs, actor)));
  }

  private async reconcileOnce(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor: string) {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    let reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, input.nowMs);
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const persisted = { ...entry, reconciliation };
      const next = await this.store.write(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? persisted : candidate));
      this.manifestGeneration = next.generation;
    }

    if (reconciliation.pending_action) {
      const attached = await this.providerPort.attachAction?.(reconciliation.pending_action.id, input.workAttemptId);
      if (attached) {
        reconciliation = completeReconciliationAction(reconciliation, reconciliation.pending_action.id);
        await this.transitionOnce(entryId, attached.observedState, entry.condition, "reconciled pending provider action", actor, reconciliation);
      }
      return {
        decision: { action: "hold_coordination" as const, observedState: attached?.observedState ?? "recovering", condition: "coordination_blocked" as const, reason: attached ? "pending provider action attached; await next convergence tick" : "pending provider action requires attach reconciliation" },
        disposition: "held" as const,
      };
    }

    const result = await new ProviderReconciler(this.providerPort).reconcile({
      ...input,
      actionId: input.reconciliationActionId,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.exit_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs, {
      beforeAction: async (kind) => {
        reconciliation = beginReconciliationAction(reconciliation, { id: input.reconciliationActionId, sequence: input.reconciliationActionSequence, kind, recorded_at_ms: input.nowMs });
        await this.transitionOnce(entryId, entry.observed_state, entry.condition, `persisted ${kind} action intent`, actor, reconciliation);
      },
    });
    const finalReconciliation = result.disposition === "failed"
      ? recordReconciliationActionFailure(reconciliation, input.reconciliationActionId, input.nowMs)
      : result.disposition === "executed"
        ? completeReconciliationAction(reconciliation, input.reconciliationActionId)
        : reconciliation;
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state || target.condition !== entry.condition || JSON.stringify(finalReconciliation) !== JSON.stringify(reconciliation)) {
      await this.transitionOnce(entryId, target.observedState, target.condition, result.decision.reason, actor, finalReconciliation);
    }
    return result;
  }

  private async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reconciliationTicks.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.reconciliationTicks.set(entryId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.reconciliationTicks.get(entryId) === tail) this.reconciliationTicks.delete(entryId);
    }
  }

  /** Provider terminal callback: records an actual exit edge before the next tick. */
  async observeProviderExit(entryId: string, terminal: ProviderActionTerminal, actor = "provider"): Promise<void> {
    await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
      await this.transitionOnce(entryId, "failed", "none", `provider terminal: ${terminal.terminalCause}`, actor);
    }));
  }

  /** Starts periodic convergence and joins provider onExit to the same durable path. */
  async scheduleConvergence(entryId: string, handle: ProviderActionHandle, input: () => DaemonReconcileInput, watchdogThresholdMs: number, intervalMs: number, actor = "reconciler"): Promise<() => Promise<void>> {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    let stopped = false;
    const tick = async () => { if (!stopped) await this.reconcile(entryId, input(), watchdogThresholdMs, actor); };
    const timer = setInterval(() => { void tick().catch(() => undefined); }, intervalMs);
    const unsubscribe = await this.providerPort.onExit(handle, (terminal) => { void this.observeProviderExit(entryId, terminal, actor).then(tick).catch(() => undefined); });
    await tick();
    return async () => { stopped = true; clearInterval(timer); unsubscribe(); };
  }

  private async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestMutation;
    let release!: () => void;
    this.manifestMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new SupervisorDaemon();
  void daemon.start().catch((error) => { console.error(error); process.exitCode = 1; });
}
