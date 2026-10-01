export class PacedQueueClosedError extends Error {
  constructor(message?: string);
}

export type PacedQueueOptions = {
  capacity: number;
  /** Slots only rank-0 (urgent) work may use. */
  reservedForUrgent?: number;
  leaseMs: number;
  startJitterMs?: number;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type PacedQueueAdmission = {
  rank?: () => number | Promise<number>;
  pauseWhenQueued?: () => boolean;
  signal?: AbortSignal;
};

export class PacedQueue {
  constructor(options: PacedQueueOptions);
  acquire(key: string, admission?: PacedQueueAdmission): Promise<() => void>;
  reprioritize(key: string, rank: number): void;
  close(createError?: () => Error): void;
  snapshot(): { active: number; queued: string[] };
}
