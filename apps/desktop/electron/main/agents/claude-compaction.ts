export type ClaudeStartupDeadline = "deadline" | "compaction_deadline" | "compaction_failed";

/** One child's observed compaction and two cumulative startup budgets. Progress
 * is presentation only; it never establishes a runtime or completes bootstrap. */
export class ClaudeCompaction {
  private activeSince: string | null = null;
  private closed = false;
  private sawCompaction = false;
  private readonly compactionBudget: number;
  private bootstrapping = true;
  private lastTick: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolveDeadline!: (reason: ClaudeStartupDeadline) => void;
  failure: ClaudeStartupDeadline | null = null;
  readonly deadline = new Promise<ClaudeStartupDeadline>(resolve => { this.resolveDeadline = resolve; });

  constructor(
    private readonly sessionId: string,
    private normalRemaining: number,
    private compactionRemaining: number,
    private readonly now: () => string,
    private readonly changed: () => void = () => {},
    private readonly monotonic: () => number = () => performance.now(),
  ) {
    this.compactionBudget = compactionRemaining;
    this.lastTick = monotonic();
    this.arm();
  }

  progress(): { state: "compacting"; startedAt: string } | null {
    return this.activeSince === null || this.closed ? null : { state: "compacting", startedAt: this.activeSince };
  }

  /** Called only after init has validated this exact continuation and workplace. */
  observe(message: Record<string, unknown>): void {
    if ((this.closed && !this.bootstrapping) || message.session_id !== this.sessionId || message.parent_tool_use_id != null
      || message.type !== "system") return;
    if (message.subtype === "status") {
      // Explicit outcome wins over status, including contradictory native frames.
      if (message.compact_result === "failed") {
        this.setActive(false);
        if (this.bootstrapping) this.fail("compaction_failed");
      } else if (this.closed) return;
      else if (message.compact_result === "success") this.setActive(false);
      else if (message.status === "compacting") this.setActive(true);
      else if (message.status === null || message.status === "requesting") this.setActive(false);
    } else if (message.subtype === "compact_boundary") this.setActive(false);
  }

  clear(): void { this.setActive(false); }

  diagnosticFields(): string[] {
    if (!this.sawCompaction) return [];
    const pending = this.bootstrapping && this.activeSince !== null && !this.failure
      ? Math.max(0, this.monotonic() - this.lastTick) : 0;
    return [`compaction_ms=${Math.max(0, Math.round(this.compactionBudget - this.compactionRemaining + pending))}`,
      `compaction_budget_ms=${this.compactionBudget}`];
  }

  finishBootstrap(): void {
    this.bootstrapping = false;
    this.cancelTimer();
    this.setActive(false);
  }

  /** Timer delivery can lag behind stdout; admission must also account elapsed time. */
  checkDeadline(): void { if (!this.closed) this.account(); }

  close(): void {
    this.account();
    this.cancelTimer();
    const wasActive = this.activeSince !== null;
    this.activeSince = null;
    this.closed = true;
    // Native exit can precede replay of an already-buffered explicit compaction
    // failure. Hide progress now, but retain that negative bootstrap evidence
    // until finishBootstrap; a closed child can never regain positive progress.
    if (wasActive) {
      try { this.changed(); } catch { /* presentation cannot change provider custody */ }
    }
  }

  private account(): void {
    const tick = this.monotonic();
    if (this.bootstrapping && !this.failure) {
      const elapsed = Math.max(0, tick - this.lastTick);
      if (this.activeSince === null) this.normalRemaining -= elapsed;
      else this.compactionRemaining -= elapsed;
      if (this.activeSince === null && this.normalRemaining <= 0) this.fail("deadline");
      else if (this.activeSince !== null && this.compactionRemaining <= 0) this.fail("compaction_deadline");
    }
    this.lastTick = tick;
  }

  private setActive(active: boolean): void {
    if (this.closed) return;
    this.account();
    const wasActive = this.activeSince !== null;
    this.activeSince = active && !this.failure ? this.activeSince ?? this.now() : null;
    this.sawCompaction ||= this.activeSince !== null;
    this.arm();
    if (wasActive !== (this.activeSince !== null)) {
      try { this.changed(); } catch { /* presentation cannot change provider custody */ }
    }
  }

  private arm(): void {
    this.cancelTimer();
    if (!this.bootstrapping || this.failure) return;
    const remaining = this.activeSince === null ? this.normalRemaining : this.compactionRemaining;
    // Ref'd: startup must remain bounded even when the child has no open handles.
    this.timer = setTimeout(() => {
      this.account();
      if (this.failure) this.setActive(false);
      else this.arm();
    }, Math.max(0, remaining));
  }

  private fail(reason: ClaudeStartupDeadline): void {
    if (this.failure) return;
    this.failure = reason;
    this.cancelTimer();
    this.resolveDeadline(reason);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
