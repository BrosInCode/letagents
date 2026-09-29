import { isDeepStrictEqual } from "node:util";
import { ImmutableExecutionError, type WorkDurabilityStore } from "./durability-store.js";
import { DaemonFenceLostError } from "./singleton.js";
import type {
  ProviderActionHandle,
  ProviderActionTerminal,
} from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot, validatedNativeRuntimeDeath } from "./provider-action-port.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";
import { advanceReconciliationState } from "./reconciler-state.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  ObservedState,
  PolicyCondition,
  ReconciliationNotice,
} from "./types.js";

export type ProviderTerminalPorts = {
  authority: {
    assertCurrent(): Promise<void>;
    isClosing(): boolean;
    fenceCommit(commit: () => Promise<void>): Promise<void>;
  };
  currentDaemonGeneration(): number;
  nowMs(): number;
  liveHandles: Map<string, ProviderActionHandle>;
  manifest: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    load(): Promise<{ entries: DaemonManifestEntry[] }>;
  };
  durability: Pick<
    WorkDurabilityStore,
    "getAttempt" | "recordTerminal" | "releaseTerminalExecutionFence"
  >;
  runtimeCustody: {
    deletePendingResumeBinding(entryId: string): void;
  };
  streams: {
    remove(installation: ProviderInstallationToken): boolean;
    isLatestInstallation(installation: ProviderInstallationToken): boolean;
  };
  delivery: {
    start(entryId: string): Promise<void>;
  };
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  serializeManifest<T>(operation: () => Promise<T>): Promise<T>;
  transitionOnce(
    entryId: string,
    to: ObservedState,
    condition: PolicyCondition,
    cause: string,
    actor: string,
    reconciliation?: DaemonManifestEntry["reconciliation"],
    notice?: ReconciliationNotice["kind"],
    terminal?: ExecutionTerminalPayload,
    commitFence?: TerminalCommitFence,
  ): Promise<void>;
  requestConvergence(entryId: string): void;
  settleRuntimeApprovals(entryId: string, commitFence?: TerminalCommitFence): Promise<void>;
  diagnostic?(entryId: string, error: unknown): void;
};

export type TerminalCommitFence = (commit: () => Promise<void>) => Promise<void>;

type PlannedConfigurationReplacement = {
  settled: Promise<void>;
  cancelled: Promise<never>;
  failed: boolean;
  resolve(): void;
  reject(error: unknown): void;
};

type TerminalSettlement = {
  installation: ProviderInstallationToken;
  terminal: ProviderActionTerminal;
  daemonGeneration: number;
  replacement?: PlannedConfigurationReplacement;
  operation: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  admitted: boolean;
  reportedCanonicalDifference?: boolean;
};

class TerminalOwnerLostError extends Error {}

/** Owns terminal evidence, exact-handle retirement, and exit-state projection. */
export class ProviderTerminalCoordinator {
  private readonly pending = new Map<ProviderInstallationToken, TerminalSettlement>();
  private readonly completed = new WeakSet<ProviderInstallationToken>();
  private phase: "open" | "retiring" | "closed" = "open";
  private readonly plannedConfigurationReplacements = new Map<
    ProviderInstallationToken,
    PlannedConfigurationReplacement
  >();

  constructor(private readonly ports: ProviderTerminalPorts) {}

  /**
   * Stop one exact installation as an intentional configuration replacement.
   * The reservation is installed before native stop so an onExit callback that
   * wins the race receives the same classification as the returned terminal.
   */
  async replaceConfiguration(
    installation: ProviderInstallationToken,
    stop: () => Promise<ProviderActionTerminal>,
  ): Promise<void> {
    if (this.phase !== "open" || this.ports.authority.isClosing() || !this.ports.streams.isLatestInstallation(installation)
      || this.ports.liveHandles.get(installation.entryId) !== installation.handle) {
      throw new Error("Provider installation changed before configuration replacement.");
    }
    if (this.plannedConfigurationReplacements.has(installation)) {
      throw new Error("Configuration replacement is already in progress.");
    }
    let resolve!: () => void, rejectSettlement!: (error: unknown) => void;
    let cancel!: (error: unknown) => void;
    const settled = new Promise<void>((accept, decline) => { resolve = accept; rejectSettlement = decline; });
    const cancelled = new Promise<never>((_accept, decline) => { cancel = decline; });
    void settled.catch(() => undefined);
    void cancelled.catch(() => undefined);
    const replacement: PlannedConfigurationReplacement = {
      settled, cancelled, failed: false, resolve,
      reject(error) { this.failed = true; rejectSettlement(error); cancel(error); },
    };
    this.plannedConfigurationReplacements.set(installation, replacement);
    try {
    let terminal: ProviderActionTerminal;
    try {
      terminal = await Promise.race([
        stop(),
        // Closing rejects the waiter promptly even if native stop never returns.
        // A successful onExit still waits for the native stop result as before.
        replacement.cancelled,
      ]);
    } catch (error) {
      if (replacement.failed) throw error;
      if (this.ports.streams.isLatestInstallation(installation)
        && this.ports.liveHandles.get(installation.entryId) === installation.handle) {
        if (this.plannedConfigurationReplacements.get(installation) === replacement) {
          this.plannedConfigurationReplacements.delete(installation);
        }
        replacement.resolve();
        throw error;
      }
      if (!this.pending.has(installation) && !this.completed.has(installation)) {
        this.plannedConfigurationReplacements.delete(installation);
        replacement.reject(error);
        throw error;
      }
      // onExit removed the exact live installation before stop rejected.
      // Its terminal handler remains the sole source of durable classification.
      await replacement.settled;
      return;
    }
    if (!this.pending.has(installation) && !this.completed.has(installation)
      && (this.phase !== "open" || !this.ports.streams.isLatestInstallation(installation)
        || this.ports.liveHandles.get(installation.entryId) !== installation.handle)) {
      const error = new TerminalOwnerLostError("Configuration replacement lost its exact installation before terminal admission.");
      this.plannedConfigurationReplacements.delete(installation);
      replacement.reject(error);
      throw error;
    }
    try { await this.handleTerminal(installation, terminal); }
    catch (error) {
      if (!this.pending.has(installation)) throw error;
      // A failed local attempt keeps its original replacement completion.
    }
    await replacement.settled;
    } finally {
      if (this.plannedConfigurationReplacements.get(installation) === replacement) {
        this.plannedConfigurationReplacements.delete(installation);
      }
    }
  }

  terminalPayload(
    terminal: ProviderActionTerminal,
    actor: string,
    connection?: ProviderActionHandle["providerConnection"],
  ): ExecutionTerminalPayload {
    const death = validatedNativeRuntimeDeath(terminal, connection);
    return {
      ...(death ? { native_runtime_death: death } : {}),
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.ports.currentDaemonGeneration(),
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  async handleTerminal(
    installation: ProviderInstallationToken,
    terminal: ProviderActionTerminal,
  ): Promise<void> {
    const existing = this.pending.get(installation);
    if (existing) return this.attemptSettlement(existing);
    if (this.phase === "closed" || this.completed.has(installation)
      || !this.ports.streams.isLatestInstallation(installation)
      || this.ports.liveHandles.get(installation.entryId) !== installation.handle) return;
    const owner: TerminalSettlement = {
      installation, terminal: structuredClone(terminal),
      daemonGeneration: this.ports.currentDaemonGeneration(),
      replacement: this.plannedConfigurationReplacements.get(installation),
      operation: null, timer: null, failures: 0, admitted: this.phase === "retiring",
    };
    this.pending.set(installation, owner);
    try {
      if (!this.ports.streams.remove(installation)) {
        this.finishSettlement(owner, new TerminalOwnerLostError("Terminal removal lost its installation."));
        return;
      }
    } catch (error) {
      // Listener cleanup may throw after revocation. Keep only the exact
      // inert owner, never the dead handle's operational authority.
      this.failedSettlement(owner, error);
      throw error;
    }
    try { this.terminalPayload(owner.terminal, "daemon-provider", installation.providerConnection); }
    catch (error) { this.finishSettlement(owner, error); throw error; }
    return this.attemptSettlement(owner);
  }

  private owns(owner: TerminalSettlement): boolean {
    return this.phase !== "closed" && this.pending.get(owner.installation) === owner
      && owner.daemonGeneration === this.ports.currentDaemonGeneration()
      && (!this.ports.authority.isClosing() || owner.admitted)
      && this.ports.streams.isLatestInstallation(owner.installation)
      && !this.ports.liveHandles.has(owner.installation.entryId);
  }

  private assertOwner(owner: TerminalSettlement): void {
    if (!this.owns(owner)) throw new TerminalOwnerLostError("Terminal settlement lost its exact installation authority.");
  }

  private fence(owner: TerminalSettlement): TerminalCommitFence {
    return commit => this.ports.authority.fenceCommit(async () => {
      this.assertOwner(owner);
      await commit();
    });
  }

  private attemptSettlement(owner: TerminalSettlement): Promise<void> {
    if (owner.operation) return owner.operation;
    if (owner.timer) { clearTimeout(owner.timer); owner.timer = null; }
    const operation = this.settleOnce(owner).then(
      () => this.finishSettlement(owner),
      error => {
        this.failedSettlement(owner, error);
        // Emergency close cancels observer work without poisoning its drain.
        // Replacement callers were rejected separately; real failures stay visible.
        if (this.phase === "closed" && error instanceof TerminalOwnerLostError) return;
        throw error;
      },
    );
    owner.operation = operation;
    void operation.finally(() => { if (owner.operation === operation) owner.operation = null; }).catch(() => undefined);
    return operation;
  }

  private failedSettlement(owner: TerminalSettlement, error: unknown): void {
    this.ports.diagnostic?.(owner.installation.entryId, error);
    // A throwing listener disposer must not bypass native identity validation.
    try { this.terminalPayload(owner.terminal, "daemon-provider", owner.installation.providerConnection); }
    catch (invalid) { this.finishSettlement(owner, invalid); return; }
    if (!this.owns(owner) || error instanceof TerminalOwnerLostError
      || error instanceof DaemonFenceLostError || error instanceof ImmutableExecutionError) {
      this.finishSettlement(owner, error);
      return;
    }
    if (owner.timer) return;
    // Retain the obligation while this owner remains valid; only the delay is
    // capped. Retrying local bookkeeping never sends native work again.
    const delay = Math.min(30_000, 25 * 2 ** Math.min(owner.failures++, 11));
    owner.timer = setTimeout(() => {
      owner.timer = null;
      void this.attemptSettlement(owner).catch(() => undefined);
    }, delay);
    owner.timer.unref();
  }

  private finishSettlement(owner: TerminalSettlement, error?: unknown): void {
    if (this.pending.get(owner.installation) !== owner) return;
    if (owner.timer) clearTimeout(owner.timer);
    this.pending.delete(owner.installation);
    this.completed.add(owner.installation);
    const replacement = owner.replacement;
    if (replacement) {
      if (error === undefined) replacement.resolve(); else replacement.reject(error);
    }
  }

  private async settleOnce(owner: TerminalSettlement): Promise<void> {
    const { installation, replacement } = owner;
    const { entryId, handle, executionGenerationId } = installation;
    let shouldStartDelivery = false;
    await this.ports.serializeEntry(entryId, async () => {
      this.assertOwner(owner);
      await this.ports.authority.assertCurrent();
      this.assertOwner(owner);
      const entry = (await this.ports.manifest.load()).entries.find(candidate => candidate.id === entryId);
      this.assertOwner(owner);
      if (!entry || !this.matchesInstallation(entry, installation)) {
        throw new TerminalOwnerLostError("Terminal settlement lost its saved provider coordinates.");
      }
      this.ports.runtimeCustody.deletePendingResumeBinding(entryId);
      let terminal = owner.terminal;
      if (entry.work_attempt_id) {
        const attempt = await this.ports.durability.getAttempt(entry.work_attempt_id);
        this.assertOwner(owner);
        const execution = attempt.execution_generations.find(candidate => candidate.execution_generation_id === executionGenerationId);
        if (!execution) throw new TerminalOwnerLostError("Terminal execution is no longer present.");
        const expected = { ...this.terminalPayload(terminal, execution.actor, installation.providerConnection), generation: execution.generation };
        if (execution.terminal) {
          // stopRef and onExit can observe the same installation differently.
          // Finish from its immutable committed result without enriching it.
          const saved = execution.terminal;
          if (saved.actor !== execution.actor || saved.generation !== execution.generation
            || saved.provider_continuation_id !== installation.providerContinuationId
            || saved.provider_continuation_id !== expected.provider_continuation_id) {
            throw new ImmutableExecutionError("Committed terminal does not match its exact execution identity.");
          }
          terminal = { endedAt: saved.ended_at, exitCode: saved.exit_code, signal: saved.signal,
            terminalCause: saved.terminal_cause as ProviderActionTerminal["terminalCause"],
            providerContinuationId: saved.provider_continuation_id,
            ...(saved.native_runtime_death ? { nativeRuntimeDeath: saved.native_runtime_death } : {}) };
          try { validatedNativeRuntimeDeath(terminal, installation.providerConnection); }
          catch { throw new ImmutableExecutionError("Committed native death does not match its exact provider installation."); }
          if (!owner.reportedCanonicalDifference && (saved.ended_at !== expected.ended_at
            || saved.exit_code !== expected.exit_code || saved.signal !== expected.signal
            || saved.terminal_cause !== expected.terminal_cause
            || !isDeepStrictEqual(saved.native_runtime_death, expected.native_runtime_death))) {
            owner.reportedCanonicalDifference = true;
            try { this.ports.diagnostic?.(entryId, new Error("Exact installation has differing terminal observations; retaining its committed result.")); }
            catch { /* A diagnostic cannot change the settlement outcome. */ }
          }
        } else {
          await this.ports.durability.recordTerminal(entry.work_attempt_id, executionGenerationId, expected, undefined, this.fence(owner));
        }
        this.assertOwner(owner);
        await this.ports.settleRuntimeApprovals(entryId, this.fence(owner));
        this.assertOwner(owner);
        if (entry.desired_state === "stopped") {
          await this.ports.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId, this.fence(owner));
          this.assertOwner(owner);
        }
      }
      await this.observeExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle,
        installation, Boolean(replacement), this.fence(owner));
      this.assertOwner(owner);
      if (!replacement && !owner.admitted) {
        this.ports.requestConvergence(entryId);
        shouldStartDelivery = entry.desired_state === "running";
      }
    });
    if (shouldStartDelivery && this.owns(owner)) void this.ports.delivery.start(entryId).catch(() => undefined);
  }

  /** Reversible update preparation; an error leaves every retained owner live. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()].map(owner => this.attemptSettlement(owner)));
    this.assertNoReplacement();
  }

  beginRetirement(): void {
    if (this.phase === "closed") throw new TerminalOwnerLostError("Terminal settlement is closed.");
    this.assertNoReplacement();
    this.phase = "retiring";
    for (const owner of this.pending.values()) owner.admitted = true;
  }

  cancelRetirement(): void {
    if (this.phase !== "retiring") return;
    this.phase = "open";
    for (const owner of this.pending.values()) owner.admitted = false;
  }

  async drainAndClose(detach: () => void): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()].map(owner => this.attemptSettlement(owner)));
    this.assertNoReplacement();
    // No await between closing admission and detaching callbacks. Already
    // retained terminals must finish; later observations belong to no old owner.
    this.phase = "closed";
    detach();
  }

  private assertNoReplacement(): void {
    if (this.plannedConfigurationReplacements.size) {
      throw new Error("Update deferred: an agent configuration replacement is still stopping its original process.");
    }
  }

  close(): void {
    this.phase = "closed";
    for (const owner of this.pending.values()) this.finishSettlement(owner, new TerminalOwnerLostError("Daemon terminal settlement closed."));
    for (const replacement of this.plannedConfigurationReplacements.values()) {
      replacement.reject(new TerminalOwnerLostError("Daemon configuration replacement closed."));
    }
    this.plannedConfigurationReplacements.clear();
  }

  private matchesInstallation(
    entry: DaemonManifestEntry,
    installation: ProviderInstallationToken,
  ): boolean {
    return entry.work_attempt_id === installation.workAttemptId
      && entry.provider_ref?.work_attempt_id === installation.workAttemptId
      && entry.provider_ref.provider_continuation_id === installation.providerContinuationId
      && entry.provider_ref.execution_generation_id === installation.executionGenerationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref.provider_connection,
        installation.providerConnection,
      );
  }

  async observeExit(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor = "provider",
    expectedExecutionGenerationId?: string,
    expectedHandle?: ProviderActionHandle,
  ): Promise<void> {
    await this.ports.serializeEntry(entryId, () =>
      this.observeExitOnce(
        entryId,
        terminal,
        actor,
        expectedExecutionGenerationId,
        expectedHandle,
      ));
  }

  async observeExitOnce(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor: string,
    expectedExecutionGenerationId?: string,
    expectedHandle?: ProviderActionHandle,
    expectedInstallation?: ProviderInstallationToken,
    plannedConfigurationReplacement = false,
    commitFence?: TerminalCommitFence,
  ): Promise<void> {
    await this.ports.serializeManifest(async () => {
      if (expectedInstallation
        && !this.ports.streams.isLatestInstallation(expectedInstallation)) return;
      const manifest = await this.ports.manifest.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId
        && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.ports.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      if (expectedInstallation && !this.matchesInstallation(entry, expectedInstallation)) return;
      const payload = this.terminalPayload(terminal, actor, expectedInstallation?.providerConnection ?? expectedHandle?.providerConnection ?? entry.provider_ref?.provider_connection);
      if (entry.condition === "quarantined") {
        if (commitFence && isDeepStrictEqual(entry.reconciliation?.last_terminal, payload)) return;
        await this.ports.transitionOnce(
          entryId,
          entry.observed_state,
          "quarantined",
          `late provider terminal: ${terminal.terminalCause}`,
          actor,
          {
            ...advanceReconciliationState(
              entry.reconciliation,
              entry.observed_state,
              this.ports.nowMs(),
            ),
            last_terminal: payload,
          },
          "quarantine_death",
          payload,
          commitFence,
        );
        return;
      }
      const control = entry.turn_control;
      const completedStopTurn = entry.desired_state === "running"
        && terminal.terminalCause === "stopped"
        && control?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && control?.status === "completed"
        && control?.has_correction === false
        && control?.interrupted === true
        && control?.resumed === false
        && control?.state === "idle";
      const intentional = plannedConfigurationReplacement
        || entry.desired_state === "stopped"
        || entry.desired_state === "paused"
        || completedStopTurn;
      const observedState = plannedConfigurationReplacement
        ? "recovering"
        : completedStopTurn
          ? "idle"
          : entry.desired_state === "paused"
            ? "paused"
            : intentional
              ? "stopped"
              : "failed";
      const reconciliation = {
        ...advanceReconciliationState(entry.reconciliation, observedState, this.ports.nowMs()),
        last_terminal: payload,
      };
      if (commitFence && entry.observed_state === observedState && entry.condition === "none"
        && isDeepStrictEqual(entry.reconciliation?.last_terminal, payload)) return;
      await this.ports.transitionOnce(
        entryId,
        observedState,
        "none",
        plannedConfigurationReplacement
          ? "provider terminal completed intentional configuration replacement"
          : completedStopTurn
            ? "provider terminal completed intentional stop-turn"
            : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
        undefined,
        undefined,
        commitFence,
      );
    });
  }
}
