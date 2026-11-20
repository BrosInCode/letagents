/**
 * The hold every room poll may ask for: public deployments commonly end an
 * idle upstream request at 60 seconds, and some at 30.
 */
export const ROOM_POLL_FLOOR_HOLD_MS = 25_000;
/** The longest hold asked for. The server holds a poll for 180 seconds at most by default. */
export const ROOM_POLL_TARGET_HOLD_MS = 150_000;
/** How long holds stay at the proven time after a longer one was cut; doubled for each cut that follows. */
export const ROOM_POLL_PROBE_COOLDOWN_MS = 10 * 60_000;
export const ROOM_POLL_PROBE_COOLDOWN_MAX_MS = 60 * 60_000;

export type RoomPollHoldLimits = {
  floorMs?: number;
  targetMs?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
};

/** One poll's hold, and the proven time when the poll started. */
export type RoomPollAttempt = { readonly holdMs: number; readonly provenMs: number };

/**
 * How long a room poll asks one room server to hold it. It owns no request
 * and no timer: the poll takes a hold, then reports what happened.
 *
 * A server holds a poll until a message arrives, so a longer hold costs no
 * latency and saves requests. A proxy on the way may end a request that
 * stays open too long, and that limit is not known in advance. So a hold
 * goes only as far as twice the longest time a poll on this path stayed open
 * and was then answered (the proven time), and never past the target. From
 * the floor that is 50 s, 100 s, then 150 s.
 *
 * A hold above the proven time is a probe. A probe that fails after it
 * outlived the proven time has met the path's limit: holds stay at the
 * proven time for a cool-down, then one probes again. A poll that fails
 * earlier than a poll on this path once lived says the path changed (another
 * network, another proxy, a restarted server), and the proof starts again
 * from the floor. In both cases the poll is asked again at once with a hold
 * that is still proven, so nothing is shown and no message waits.
 */
export class RoomPollHold {
  private readonly floorMs: number;
  private readonly targetMs: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private provenMs: number;
  /** The proven time when a probe was last cut. No hold goes above it before `probeAfterMs`. */
  private ceilingMs: number | null = null;
  private probeAfterMs = Number.NEGATIVE_INFINITY;
  /** Rounds of cut probes since a probe last succeeded above the ceiling. */
  private cutRounds = 0;

  constructor(private readonly nowMs: () => number = () => performance.now(), limits: RoomPollHoldLimits = {}) {
    this.floorMs = limits.floorMs ?? ROOM_POLL_FLOOR_HOLD_MS;
    this.targetMs = Math.max(this.floorMs, limits.targetMs ?? ROOM_POLL_TARGET_HOLD_MS);
    this.cooldownMs = limits.cooldownMs ?? ROOM_POLL_PROBE_COOLDOWN_MS;
    this.maxCooldownMs = limits.maxCooldownMs ?? ROOM_POLL_PROBE_COOLDOWN_MAX_MS;
    this.provenMs = this.floorMs;
  }

  /**
   * The hold of the next poll, in whole milliseconds. `atFloor` is for a
   * poll whose answer must not wait on a long hold: it asks for the floor.
   */
  start(atFloor = false): RoomPollAttempt {
    if (atFloor) return { holdMs: this.floorMs, provenMs: this.provenMs };
    const limitMs = this.ceilingMs !== null && this.nowMs() < this.probeAfterMs ? this.ceilingMs : this.targetMs;
    return { holdMs: Math.min(2 * this.provenMs, limitMs), provenMs: this.provenMs };
  }

  /**
   * The poll was answered after it stayed open `openMs`. An answer that
   * came early, with a message or because the server holds for less, proves
   * only the time it took.
   */
  answered(attempt: RoomPollAttempt, openMs: number): void {
    this.provenMs = Math.max(this.provenMs, Math.floor(Math.min(openMs, attempt.holdMs)));
    if (this.ceilingMs !== null && this.provenMs > this.ceilingMs) {
      this.ceilingMs = null;
      this.cutRounds = 0;
    }
  }

  /**
   * The poll failed after it stayed open `openMs`: the request was cut,
   * answered with an error, or got no answer in time. Not for a refused
   * bearer or a poll its caller aborted; they say nothing about the path.
   *
   * Returns the poll to make again at once. Returns null when the failure
   * is no consequence of a long hold, because a poll at the floor would have
   * been open at that moment too: the caller reports it as before.
   */
  failed(attempt: RoomPollAttempt, openMs: number): RoomPollAttempt | null {
    if (attempt.holdMs <= this.floorMs || openMs < this.floorMs) return null;
    // Judged by the proven time the poll started with: polls of several
    // agents fail together, and the first one may already have reset it.
    const probeCut = attempt.holdMs > attempt.provenMs && openMs >= attempt.provenMs
      && attempt.provenMs === this.provenMs;
    if (probeCut) {
      // One limit cuts the probes of every agent: together they are one round.
      if (this.nowMs() >= this.probeAfterMs) {
        this.cutRounds += 1;
        this.probeAfterMs = this.nowMs() + Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** (this.cutRounds - 1));
      }
      this.ceilingMs = this.provenMs;
    } else {
      this.provenMs = this.floorMs;
    }
    return { holdMs: this.provenMs, provenMs: this.provenMs };
  }
}
