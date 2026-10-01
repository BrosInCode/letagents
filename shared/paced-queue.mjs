/**
 * A bounded, priority-ordered admission queue for work that loads a shared
 * server or the machine. It exists so that "everything at once" (a desktop
 * start or a daemon handoff converging every agent together) becomes a few
 * at a time, most urgent first.
 *
 * Queue time is never part of the queued work: callers start their own
 * request timeouts and startup budgets after a slot is granted. Callers must
 * pace only leaf work that never waits for another slot of the same queue,
 * so a queue cannot deadlock on itself.
 */

export class PacedQueueClosedError extends Error {
  constructor(message = "Queued work was cancelled because its owner is shutting down.") {
    super(message);
    this.name = "PacedQueueClosedError";
  }
}

export class PacedQueue {
  #capacity;
  #reservedForUrgent;
  #leaseMs;
  #startJitterMs;
  #random;
  #setTimeout;
  #clearTimeout;
  #active = 0;
  #queue = [];
  #sequence = 0;
  #closedError = null;

  /**
   * Rank 0 is urgent work (a user's action). `reservedForUrgent` of the
   * `capacity` slots serve only it, so a queue full of background work can
   * never make a user wait for one of that work's slots to free up.
   */
  constructor({ capacity, reservedForUrgent = 0, leaseMs, startJitterMs = 0, random = Math.random, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("A paced queue needs a positive capacity.");
    if (!Number.isSafeInteger(reservedForUrgent) || reservedForUrgent < 0 || reservedForUrgent >= capacity) {
      throw new Error("A paced queue must leave background work at least one slot.");
    }
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("A paced queue needs a positive slot lease.");
    this.#capacity = capacity;
    this.#reservedForUrgent = reservedForUrgent;
    this.#leaseMs = leaseMs;
    this.#startJitterMs = startJitterMs;
    this.#random = random;
    this.#setTimeout = setTimer;
    this.#clearTimeout = clearTimer;
  }

  /**
   * Wait for a slot and return its idempotent release. `rank` (lower runs
   * first) is read only when the work has to queue. After a queued slot is
   * granted, `pauseWhenQueued` decides whether to wait a random pause of up
   * to the start jitter, so a released batch spreads out. Aborting `signal`
   * while queued removes the work from the queue and rejects.
   */
  async acquire(key, { rank = () => 0, pauseWhenQueued = () => true, signal } = {}) {
    if (this.#closedError) throw this.#closedError();
    signal?.throwIfAborted();
    // Room even for background work and nobody waiting: no rank needed.
    if (this.#queue.length === 0 && this.#active < this.#capacity - this.#reservedForUrgent) {
      this.#active += 1;
      return this.#lease();
    }
    const resolvedRank = await rank();
    if (this.#closedError) throw this.#closedError();
    signal?.throwIfAborted();
    let grant;
    let cancel;
    const admitted = new Promise((resolve, reject) => { grant = resolve; cancel = reject; });
    const waiter = { key, rank: resolvedRank, sequence: this.#sequence++, granted: false, grant, cancel };
    if (signal) {
      const abandon = () => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        cancel(signal.reason);
      };
      signal.addEventListener("abort", abandon, { once: true });
      waiter.grant = () => { signal.removeEventListener("abort", abandon); grant(); };
      waiter.cancel = (error) => { signal.removeEventListener("abort", abandon); cancel(error); };
    }
    this.#queue.push(waiter);
    this.#sort();
    // A slot may have been released while the rank was read, or this may be
    // urgent work entitled to a reserved slot.
    this.#pump();
    const waited = !waiter.granted;
    await admitted;
    const release = this.#lease();
    if (waited && this.#startJitterMs > 0 && pauseWhenQueued()) {
      const pauseMs = Math.floor(this.#random() * this.#startJitterMs);
      if (pauseMs > 0) await new Promise((resolve) => { this.#setTimeout(resolve, pauseMs); });
    }
    return release;
  }

  /** Move already-queued work for `key` forward to `rank`; never moves it back. */
  reprioritize(key, rank) {
    let changed = false;
    for (const waiter of this.#queue) {
      if (waiter.key === key && waiter.rank > rank) {
        waiter.rank = rank;
        changed = true;
      }
    }
    if (changed) {
      this.#sort();
      this.#pump();
    }
  }

  /** Cancel queued work and refuse new work; work already admitted runs on. */
  close(createError = () => new PacedQueueClosedError()) {
    this.#closedError = createError;
    for (const waiter of this.#queue.splice(0)) waiter.cancel(createError());
  }

  snapshot() {
    return { active: this.#active, queued: this.#queue.map((waiter) => waiter.key) };
  }

  /** Admit queued work from the front while it has a slot it may use. */
  #pump() {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      const limit = head.rank === 0 ? this.#capacity : this.#capacity - this.#reservedForUrgent;
      // The queue is ordered by rank, so nothing behind a blocked head may run either.
      if (this.#active >= limit) return;
      this.#queue.shift();
      this.#active += 1;
      head.granted = true;
      head.grant();
    }
  }

  #sort() {
    this.#queue.sort((left, right) => left.rank - right.rank || left.sequence - right.sequence);
  }

  #lease() {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#clearTimeout(timer);
      this.#active -= 1;
      this.#pump();
    };
    // Every queued operation keeps its own timeout; the lease only stops one
    // that never settles from holding its slot forever.
    const timer = this.#setTimeout(release, this.#leaseMs);
    timer?.unref?.();
    return release;
  }
}
