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
  /** The daemon stopped waiting for this entry's exit, of the execution generation `exitId`, to be recorded in full; its owner is told. */
  exitUnsettled?(entryId: string, exitId: string): void;
};

/**
 * How long recording an exit may take. Until an exit is recorded its entry
 * has no runtime and is given no other, so the wait has an end: after
 * `settleMs` one last attempt is made that records the exit without the steps
 * that keep failing; that attempt has `lastAttemptMs`, and after it the daemon
 * stops waiting, whatever was recorded. An agent is then at most
 * `settleMs + lastAttemptMs + recordMs`, 27 seconds, without a process on
 * this account. That is inside the 30 seconds an app update waits for exits
 * to be recorded, so an update is not deferred by an exit that cannot be.
 */
export const EXIT_SETTLEMENT_BOUNDS = { settleMs: 15_000, lastAttemptMs: 8_000, recordMs: 4_000 };
/** The line an owner reads in the agent's activity when an exit could not be recorded in full. */
export const EXIT_UNSETTLED_NOTICE = "LetAgents could not finish recording how this agent's last process ended, so it stopped waiting and carried on. Some of that process's last activity, or an approval it was waiting for, may be missing.";

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
  /** Ends the wait: first for the ordinary attempts, then for the last one. */
  deadline: ReturnType<typeof setTimeout> | null;
  /** Rejected when the wait ends, so that a step that never returns is left behind. */
  cut: { promise: Promise<never>; reject(error: unknown): void };
  /** The ordinary attempts ran out of time; `last` once the last attempt has begun. */
  overdue: false | "due" | "last";
  /** The exit was recorded without a step that kept failing. */
  incomplete: boolean;
  /** Set once the daemon has stopped waiting; resolves when it has let the entry go. */
  abandoned: Promise<void> | null;
  /** Resolves when the settlement has ended, recorded or not. */
  ended: Promise<void>;
  end(): void;
};

class TerminalOwnerLostError extends Error {}
class TerminalSettlementOverdueError extends Error {}

function settlementCut(): TerminalSettlement["cut"] {
  let reject!: (error: unknown) => void;
  const promise = new Promise<never>((_resolve, decline) => { reject = decline; });
  void promise.catch(() => undefined);
  return { promise, reject };
}

/** Owns terminal evidence, exact-handle retirement, and exit-state projection. */
export class ProviderTerminalCoordinator {
  private readonly pending = new Map<ProviderInstallationToken, TerminalSettlement>();
  private readonly completed = new WeakSet<ProviderInstallationToken>();
  private phase: "open" | "retiring" | "closed" = "open";
  /** Entries whose convergence was turned away while their exit was being settled. */
  private readonly convergenceOwed = new Set<string>();
  /** Entries an owner's recovery has taken over from their exit's recording, until it ends. */
  private readonly recoveries = new Map<string, number>();
  private readonly plannedConfigurationReplacements = new Map<
    ProviderInstallationToken,
    PlannedConfigurationReplacement
  >();

  /** Tests shorten these. */
  bounds = { ...EXIT_SETTLEMENT_BOUNDS };

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

  /**
   * Whether this entry's runtime has exited and that exit is not yet recorded.
   * Until it is, the entry has no runtime and its generation has no terminal:
   * attaching would take the exited runtime back, and launching would find a
   * generation that still looks live. An entry whose caller is turned away
   * is converged again when the settlement ends.
   */
  settling(entryId: string): boolean {
    if (this.recoveries.has(entryId)) {
      this.convergenceOwed.add(entryId);
      return true;
    }
    for (const installation of this.pending.keys()) {
      if (installation.entryId !== entryId) continue;
      this.convergenceOwed.add(entryId);
      return true;
    }
    return false;
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
      deadline: null, cut: settlementCut(), overdue: false, incomplete: false, abandoned: null,
      ended: Promise.resolve(), end: () => {},
    };
    owner.ended = new Promise<void>((resolve) => { owner.end = resolve; });
    this.pending.set(installation, owner);
    owner.deadline = setTimeout(() => this.settlementOverdue(owner), this.bounds.settleMs);
    owner.deadline.unref();
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
    if (owner.abandoned) return owner.abandoned;
    if (owner.operation) return owner.operation;
    if (owner.timer) { clearTimeout(owner.timer); owner.timer = null; }
    const operation = this.within(owner, this.settleOnce(owner)).then(
      () => {
        const told = owner.incomplete && this.pending.get(owner.installation) === owner && this.phase === "open";
        this.finishSettlement(owner);
        if (told) try { this.ports.exitUnsettled?.(owner.installation.entryId, owner.installation.executionGenerationId); } catch { /* Telling the owner is optional. */ }
      },
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
    if (owner.overdue === "last") { this.abandonSettlement(owner, error); return; }
    // Retain the obligation while this owner remains valid and has time left.
    // Retrying local bookkeeping never sends native work again.
    if (owner.overdue === "due") owner.overdue = "last";
    const delay = owner.overdue ? 0 : Math.min(30_000, 25 * 2 ** Math.min(owner.failures++, 11));
    owner.timer = setTimeout(() => {
      owner.timer = null;
      void this.attemptSettlement(owner).catch(() => undefined);
    }, delay);
    owner.timer.unref();
  }

  /**
   * The ordinary attempts have had their time. Whatever step is still
   * running is left behind, and one last attempt records the exit without
   * the steps that are not needed to give the entry a runtime again.
   */
  private settlementOverdue(owner: TerminalSettlement): void {
    if (this.pending.get(owner.installation) !== owner || owner.overdue) return;
    owner.overdue = "due";
    const cut = owner.cut;
    owner.cut = settlementCut();
    owner.deadline = setTimeout(() => this.abandonSettlement(owner,
      new TerminalSettlementOverdueError("The agent's last process ended, but LetAgents could not finish recording that in time. It stopped waiting and starts the agent again.")), this.bounds.lastAttemptMs);
    owner.deadline.unref();
    cut.reject(new TerminalSettlementOverdueError("The exit was not recorded in time; one last attempt follows."));
    if (owner.operation) return; // Its failure starts the last attempt.
    owner.overdue = "last";
    void this.attemptSettlement(owner).catch(() => undefined);
  }

  /**
   * The exit could not be recorded, or not in time. The daemon stops waiting:
   * it saves the terminal it was given if it still can, tells the owner, and
   * lets the entry converge. Convergence then finds the saved process gone
   * and treats it as it does after a daemon restart.
   */
  private abandonSettlement(owner: TerminalSettlement, error: unknown): void {
    if (this.pending.get(owner.installation) !== owner || owner.abandoned) return;
    if (owner.timer) { clearTimeout(owner.timer); owner.timer = null; }
    if (owner.deadline) { clearTimeout(owner.deadline); owner.deadline = null; }
    const cut = owner.cut;
    owner.cut = settlementCut();
    cut.reject(error);
    const give = setTimeout(() => owner.cut.reject(error), this.bounds.recordMs);
    give.unref();
    owner.abandoned = this.within(owner, this.recordAbandonedTerminal(owner)).catch(() => undefined).then(() => {
      clearTimeout(give);
      if (this.pending.get(owner.installation) !== owner) return;
      const entryId = owner.installation.entryId;
      try { this.ports.diagnostic?.(entryId, error); } catch { /* A diagnostic cannot change the outcome. */ }
      // Whether or not a pass was turned away meanwhile, the entry is converged now.
      this.convergenceOwed.add(entryId);
      this.finishSettlement(owner, error);
      if (this.phase !== "open") return;
      try { this.ports.exitUnsettled?.(entryId, owner.installation.executionGenerationId); } catch { /* Telling the owner is not what lets the entry continue. */ }
    });
  }

  /** Outside the entry's queue: the terminal of an ended process is a fact, and the queue may be what never answered. */
  private async recordAbandonedTerminal(owner: TerminalSettlement): Promise<void> {
    const { installation } = owner;
    if (!installation.workAttemptId) return;
    const attempt = await this.ports.durability.getAttempt(installation.workAttemptId);
    const execution = attempt.execution_generations.find(candidate => candidate.execution_generation_id === installation.executionGenerationId);
    if (!execution || execution.terminal) return;
    await this.ports.durability.recordTerminal(installation.workAttemptId, installation.executionGenerationId,
      { ...this.terminalPayload(owner.terminal, execution.actor, installation.providerConnection), generation: execution.generation },
      undefined, this.fence(owner));
  }

  /** A step of a settlement, for as long as that settlement is waited for. */
  private within<T>(owner: TerminalSettlement, step: Promise<T>): Promise<T> {
    void step.catch(() => undefined);
    return Promise.race([step, owner.cut.promise]);
  }

  /**
   * An operator's recovery takes the entry over: it proves the process gone
   * and saves its terminal itself. A settlement that was still waiting gives
   * way to it at once, its waiting step let go of. Until the returned
   * function is called the entry is held as that settlement held it, so no
   * convergence pass races the recovery for the entry's runtime.
   */
  supersede(entryId: string): () => void {
    this.recoveries.set(entryId, (this.recoveries.get(entryId) ?? 0) + 1);
    for (const owner of [...this.pending.values()]) {
      if (owner.installation.entryId !== entryId) continue;
      owner.cut.reject(new TerminalOwnerLostError("Terminal settlement was superseded by a runtime recovery."));
      this.finishSettlement(owner, new TerminalOwnerLostError("Terminal settlement was superseded by a runtime recovery."));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.recoveries.get(entryId) ?? 1) - 1;
      if (left > 0) { this.recoveries.set(entryId, left); return; }
      this.recoveries.delete(entryId);
      // The recovery converges the entry itself as it ends.
      this.convergenceOwed.delete(entryId);
    };
  }

  private finishSettlement(owner: TerminalSettlement, error?: unknown): void {
    if (this.pending.get(owner.installation) !== owner) return;
    if (owner.timer) clearTimeout(owner.timer);
    if (owner.deadline) clearTimeout(owner.deadline);
    this.pending.delete(owner.installation);
    owner.end();
    this.completed.add(owner.installation);
    const replacement = owner.replacement;
    if (replacement) {
      if (error === undefined) replacement.resolve(); else replacement.reject(error);
    }
    // A pass that was turned away is owed, unless a planned replacement
    // completed: its owner converges the entry once it has released its
    // exclusion, as it always has.
    const entryId = owner.installation.entryId;
    if (this.convergenceOwed.delete(entryId) && this.phase === "open" && !(replacement && error === undefined)) {
      this.ports.requestConvergence(entryId);
    }
  }

  private async settleOnce(owner: TerminalSettlement): Promise<void> {
    const { installation, replacement } = owner;
    const { entryId, handle, executionGenerationId } = installation;
    let shouldStartDelivery = false;
    // Every step is waited for only as long as the settlement is: a step that
    // never returns must not keep the entry's queue, or the entry, for ever.
    const within = <T>(step: Promise<T>) => this.within(owner, step);
    await this.ports.serializeEntry(entryId, async () => {
      this.assertOwner(owner);
      await within(this.ports.authority.assertCurrent());
      this.assertOwner(owner);
      const entry = (await within(this.ports.manifest.load())).entries.find(candidate => candidate.id === entryId);
      this.assertOwner(owner);
      if (!entry || !this.matchesInstallation(entry, installation)) {
        throw new TerminalOwnerLostError("Terminal settlement lost its saved provider coordinates.");
      }
      this.ports.runtimeCustody.deletePendingResumeBinding(entryId);
      let terminal = owner.terminal;
      if (entry.work_attempt_id) {
        const attempt = await within(this.ports.durability.getAttempt(entry.work_attempt_id));
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
          await within(this.ports.durability.recordTerminal(entry.work_attempt_id, executionGenerationId, expected, undefined, this.fence(owner)));
        }
        this.assertOwner(owner);
        try {
          const approvals = this.ports.settleRuntimeApprovals(entryId, this.fence(owner));
          // The last attempt gives this step half its time, and goes on without it.
          await within(owner.overdue ? Promise.race([approvals, new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("Closing the ended runtime's approvals did not finish in time.")), this.bounds.lastAttemptMs / 2).unref();
          })]) : approvals);
        } catch (error) {
          // The last attempt records the exit without this step. The approvals
          // of an ended runtime are closed again when its successor starts.
          if (!owner.overdue || !this.owns(owner) || error instanceof TerminalOwnerLostError
            || error instanceof DaemonFenceLostError || error instanceof TerminalSettlementOverdueError) throw error;
          owner.incomplete = true;
          try { this.ports.diagnostic?.(entryId, error); } catch { /* A diagnostic cannot change the settlement outcome. */ }
        }
        this.assertOwner(owner);
        if (entry.desired_state === "stopped") {
          await within(this.ports.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId, this.fence(owner)));
          this.assertOwner(owner);
        }
      }
      await within(this.observeExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle,
        installation, Boolean(replacement), this.fence(owner)));
      this.assertOwner(owner);
      if (!replacement && !owner.admitted) {
        // This is the convergence a pass that was turned away is owed.
        this.convergenceOwed.delete(entryId);
        this.ports.requestConvergence(entryId);
        shouldStartDelivery = entry.desired_state === "running";
      }
    });
    if (shouldStartDelivery && this.owns(owner)) void this.ports.delivery.start(entryId).catch(() => undefined);
  }

  /** Reversible update preparation; an error leaves every retained owner live. */
  async drain(): Promise<void> {
    await this.settleAll();
    this.assertNoReplacement();
  }

  /**
   * Each exit is tried once more now. One that fails is tried again on its
   * own schedule, and its wait ends within the bound whether it is recorded
   * or not: an update or a retirement waits for that end, as it does for a
   * step that never returns, instead of failing on the first attempt that fails.
   */
  private async settleAll(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()].map(async (owner) => {
      await this.attemptSettlement(owner).catch(() => undefined);
      await owner.ended;
    }));
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
    await this.settleAll();
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
