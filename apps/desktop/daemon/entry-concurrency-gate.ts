export interface EntryConcurrencyGateOptions {
  isHandoffScheduled: () => boolean;
}

/**
 * Owns the process-local ordering and exclusion state shared by daemon entry
 * workflows. Durable authority remains outside this class; callers still
 * perform their exact manifest, singleton, and provider checks inside the
 * admitted operation.
 */
export class EntryConcurrencyGate {
  private readonly entryTicks = new Map<string, Promise<void>>();
  private readonly controlEpochs = new Map<string, number>();
  private readonly lifecycleEntries = new Set<string>();
  private readonly turnControlEntries = new Set<string>();
  private readonly activeRoomMoves = new Map<string, Promise<void>>();
  private readonly roomMoveExclusionWaiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: EntryConcurrencyGateOptions) {}

  /** Serialize all authority-changing work for one manifest entry. */
  async run<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.entryTicks.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.entryTicks.set(entryId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.entryTicks.get(entryId) === tail) this.entryTicks.delete(entryId);
    }
  }

  /** Read the synchronous fence observed by delayed provider-launch work. */
  currentControlEpoch(entryId: string): number {
    return this.controlEpochs.get(entryId) ?? 0;
  }

  /** Fence delayed launch work before the lifecycle caller crosses an await. */
  bumpControlEpoch(entryId: string): number {
    const next = this.currentControlEpoch(entryId) + 1;
    this.controlEpochs.set(entryId, next);
    return next;
  }

  isLifecycleActive(entryId: string): boolean {
    return this.lifecycleEntries.has(entryId);
  }

  /**
   * Announce lifecycle exclusion synchronously, then wake room-move callers
   * queued behind unrelated entry work. The lifecycle owner separately drains
   * only a room move that already entered its critical section.
   */
  beginLifecycle(entryId: string): () => void {
    if (this.lifecycleEntries.has(entryId) || this.turnControlEntries.has(entryId)) {
      throw new Error("This supervised entry already has an in-flight lifecycle or turn-control action.");
    }
    this.lifecycleEntries.add(entryId);
    this.wakeRoomMoveWaiters(entryId);
    return () => { this.lifecycleEntries.delete(entryId); };
  }

  /** Reserve the one process-local turn-control slot for an exact entry. */
  beginTurnControl(entryId: string): () => void {
    if (this.lifecycleEntries.has(entryId)) {
      throw new Error("Turn control is unavailable while a lifecycle action is in flight for this supervised entry.");
    }
    if (this.turnControlEntries.has(entryId)) {
      throw new Error("A turn-control action is already in flight for this exact supervised entry.");
    }
    this.turnControlEntries.add(entryId);
    return () => { this.turnControlEntries.delete(entryId); };
  }

  /**
   * Queue one room-move reconciliation on the shared entry lane. A lifecycle
   * edge or handoff can release the public caller while queued work remains
   * fenced; only work that entered `operation` is registered for draining.
   */
  async runRoomMove<T>(
    entryId: string,
    excludedValue: T,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.options.isHandoffScheduled() || this.lifecycleEntries.has(entryId)) {
      return excludedValue;
    }

    let exclude!: () => void;
    const excluded = new Promise<T>((resolve) => {
      exclude = () => resolve(excludedValue);
    });
    const waiters = this.roomMoveExclusionWaiters.get(entryId) ?? new Set<() => void>();
    waiters.add(exclude);
    this.roomMoveExclusionWaiters.set(entryId, waiters);

    const admitted = this.run(entryId, async () => {
      if (this.options.isHandoffScheduled() || this.lifecycleEntries.has(entryId)) {
        return excludedValue;
      }
      let settle!: () => void;
      const active = new Promise<void>((resolve) => { settle = resolve; });
      if (this.activeRoomMoves.has(entryId)) {
        throw new Error("Room-move reconciliation entered its critical section twice for one agent.");
      }
      this.activeRoomMoves.set(entryId, active);
      try {
        return await operation();
      } finally {
        settle();
        if (this.activeRoomMoves.get(entryId) === active) {
          this.activeRoomMoves.delete(entryId);
        }
      }
    });

    try {
      return await Promise.race([admitted, excluded]);
    } finally {
      waiters.delete(exclude);
      if (waiters.size === 0 && this.roomMoveExclusionWaiters.get(entryId) === waiters) {
        this.roomMoveExclusionWaiters.delete(entryId);
      }
    }
  }

  /** Wait only for room-move work already inside its bounded critical section. */
  async waitForActiveRoomMove(entryId: string): Promise<void> {
    await this.activeRoomMoves.get(entryId);
  }

  /** Wake every queued room-move caller, or only callers for one entry. */
  wakeRoomMoveWaiters(entryId?: string): void {
    const waiterSets = entryId === undefined
      ? this.roomMoveExclusionWaiters.values()
      : [this.roomMoveExclusionWaiters.get(entryId)];
    for (const waiters of waiterSets) {
      if (!waiters) continue;
      for (const waiter of waiters) waiter();
    }
  }

  /**
   * Fence queued callers first, then drain only room moves that had already
   * entered their critical section. New entries are observed until none remain.
   */
  async fenceAndDrainRoomMoves(): Promise<void> {
    this.wakeRoomMoveWaiters();
    while (this.activeRoomMoves.size > 0) {
      await Promise.all([...this.activeRoomMoves.values()]);
    }
  }
}
