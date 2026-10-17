import { performance } from "node:perf_hooks";

import { queuedDeliveryKind, type QueuedDeliveryKind } from "./queued-delivery-order.js";

/**
 * Duration-only timing from a room message's arrival in this daemon to the
 * agent's first visible output, and of the provider launches such a message
 * can wait on. It answers one question: where does a reply's start-up time
 * go, and how much of it is a cold start?
 *
 * Phases, in order, each measured from the previous mark (daemon clock):
 * - inbox_wait: inbox commit -> the delivery is admitted with a live handle.
 *   Includes waiting behind an older turn and waiting for a cold launch.
 * - context: archive, observed context and the fresh room context read.
 * - provider_entry: provider call -> its dispatch callback (Codex readiness).
 * - dispatch_checks: execution authority and task continuation checks.
 * - workspace_begin: the starting workspace snapshot.
 * - dispatch_intent: the durable dispatch intent.
 * - provider_start: dispatch -> the provider's exact turn id (Cursor starts
 *   its per-turn process here).
 * - turn_checkpoint: the daemon's own authority check and turn checkpoint.
 *   Claude takes this before its stdin write, Codex after its turn started.
 * - first_output: the first text, reasoning or tool event the live display
 *   shows, timed when the adapter observed it.
 * - turn_end: replaces first_output when the turn ends with no visible output.
 *
 * `server_to_inbox_ms` compares the server's message timestamp with this
 * machine's clock, so it is only as exact as the two clocks agree.
 *
 * Samples carry no room content, identifiers, errors or credentials. Nothing
 * is recorded until the daemon entrypoint installs a reporter, and no failure
 * here may change delivery, authority, retry or settlement.
 */

export type TurnStartPhase = "inbox_wait" | "context" | "provider_entry" | "dispatch_checks" | "workspace_begin"
  | "dispatch_intent" | "provider_start" | "turn_checkpoint" | "first_output" | "turn_end";
/**
 * prepare: authority, credentials and configuration before the launch slot.
 * slot_wait: the daemon-wide cold launch limit.
 * admission: the final launch checks.
 * process: the native process up to its own ready signal.
 * bootstrap: a remote model round trip after that signal (Claude's bootstrap).
 * install: persisting the handle and installing its stream.
 */
export type LaunchPhase = "prepare" | "slot_wait" | "admission" | "process" | "bootstrap" | "install";
export type FirstOutputKind = "text" | "reasoning" | "tool";

type Phases<Phase extends string> = Partial<Record<Phase, number>>;

export type LaunchLatencySample = {
  provider: string;
  launch: "fresh" | "resume";
  elapsed_ms: number;
  phases_ms: Phases<LaunchPhase>;
};

export type TurnStartLatencySample = {
  provider: string;
  source: QueuedDeliveryKind;
  /**
   * cold: the first turn after a launch, or a message that arrived with no
   * live process. per_turn_process: Cursor starts a new process every turn.
   */
  start: "warm" | "cold" | "per_turn_process";
  /**
   * 1 for the first dispatch. Higher when earlier attempts ended before the
   * provider call; their retry delay or a blocked wait is then in inbox_wait.
   */
  attempt: number;
  /** Another turn of this agent was running when the message arrived. */
  busy_at_arrival: boolean;
  /**
   * Arrival minus the end of this agent's previous turn. A long idle time can
   * expire the model's prompt cache even in a warm process.
   */
  idle_ms: number | null;
  outcome: "first_output" | "no_visible_output" | "failed";
  first_output: FirstOutputKind | null;
  elapsed_ms: number;
  server_to_inbox_ms: number | null;
  /** Adapter observation -> projection, inside first_output. */
  first_output_queue_ms: number | null;
  phases_ms: Phases<TurnStartPhase>;
  /** The launch this turn was the first turn after. */
  launch: (Omit<LaunchLatencySample, "provider"> & {
    /** How long this message waited for the launch to finish (0 when it came later). */
    waited_ms: number;
  }) | null;
};

export type StartLatencyRecord =
  | { event: "turn_start_latency"; sample: TurnStartLatencySample }
  | { event: "provider_launch_latency"; sample: LaunchLatencySample };

export type StartLatencyClock = { now(): number; wallNow(): number };

const defaultClock: StartLatencyClock = { now: () => performance.now(), wallNow: () => Date.now() };
const MAX_WAITING_MESSAGES = 1024;
const MAX_WAITING_MESSAGES_PER_AGENT = 64;
const MAX_REMEMBERED_AGENTS = 128;

type Arrival = {
  agentId: string;
  at: number;
  source: QueuedDeliveryKind;
  busy: boolean;
  liveHandle: boolean;
  serverToInboxMs: number | null;
  attempt: number;
};

type CompletedLaunch = { finishedAt: number; sample: LaunchLatencySample; used: boolean };

function round(value: number): number {
  return Math.round(value);
}

function wallTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The projected live-display methods; see isAgentInspectorLiveDisplayEvent. */
export function firstOutputKind(method: string): FirstOutputKind | null {
  if (method === "item/agentMessage/delta") return "text";
  if (method === "reasoning/summaryTextDelta" || method === "item/reasoning/summaryTextDelta") return "reasoning";
  if (method === "item/toolCall/updated") return "tool";
  return null;
}

class SequentialMarks<Phase extends string> {
  readonly phases: Phases<Phase> = {};
  private previous: number;

  constructor(readonly startedAt: number, private readonly now: () => number) {
    this.previous = startedAt;
  }

  /** `at` may be an earlier observation; a phase never ends before the previous mark. */
  mark(phase: Phase, at = this.now()): number {
    const end = Math.max(at, this.previous);
    this.phases[phase] = (this.phases[phase] ?? 0) + end - this.previous;
    this.previous = end;
    return end;
  }

  rounded(): Phases<Phase> {
    return Object.fromEntries(Object.entries(this.phases).map(([phase, ms]) => [phase, round(ms as number)])) as Phases<Phase>;
  }
}

export class LaunchStartTrace {
  private readonly marks: SequentialMarks<LaunchPhase>;
  private done = false;

  constructor(
    private readonly owner: TurnStartLatency,
    private readonly agentId: string,
    private readonly provider: string,
    private readonly clock: StartLatencyClock,
  ) {
    this.marks = new SequentialMarks(clock.now(), () => clock.now());
  }

  mark(phase: LaunchPhase): void {
    if (this.done) return;
    try { this.marks.mark(phase); } catch { this.done = true; }
  }

  /** The process phase ends at the native ready signal when the provider gives one. */
  markProcessReturned(): void {
    this.mark(this.marks.phases.process === undefined ? "process" : "bootstrap");
  }

  complete(launch: "fresh" | "resume"): void {
    if (this.done) return;
    this.done = true;
    try {
      const finishedAt = this.clock.now();
      this.owner.launchCompleted(this.agentId, finishedAt, {
        provider: this.provider,
        launch,
        elapsed_ms: round(finishedAt - this.marks.startedAt),
        phases_ms: this.marks.rounded(),
      });
    } catch { /* Diagnostics never change a launch. */ }
  }
}

export class TurnStartTrace {
  private readonly marks: SequentialMarks<TurnStartPhase>;
  private providerCalledWallMs: number | null = null;
  private providerEndedAt: number | null = null;
  private providerOutcome: string | null = null;
  private launch: CompletedLaunch | null = null;
  private outputOpen = true;
  private emitted = false;
  private closed = false;

  constructor(
    private readonly owner: TurnStartLatency,
    readonly agentId: string,
    private readonly inboxItemId: string,
    private readonly provider: string,
    private readonly arrival: Arrival,
    private readonly clock: StartLatencyClock,
  ) {
    this.marks = new SequentialMarks(arrival.at, () => clock.now());
    this.marks.mark("inbox_wait");
  }

  mark(phase: TurnStartPhase): void {
    if (this.closed || this.emitted || this.providerEndedAt !== null) return;
    try { this.marks.mark(phase); } catch { this.close(); }
  }

  /**
   * Called right before the provider call. Output observed earlier belongs to
   * another turn, and a launch that finished earlier is the one this turn ran on.
   */
  providerCalled(): void {
    if (this.closed) return;
    this.mark("context");
    try {
      this.providerCalledWallMs = this.clock.wallNow();
      this.launch = this.owner.takeLaunch(this.agentId);
    } catch { this.close(); }
  }

  /** A new launch replaced this turn's process; its output is not this turn's. */
  processReplaced(): void {
    this.outputOpen = false;
  }

  /**
   * The provider returned its result. The display queue can still hold this
   * turn's first output, so the sample waits for end().
   */
  providerEnded(outcome: string): void {
    if (this.closed || this.providerEndedAt !== null) return;
    try {
      this.providerEndedAt = this.clock.now();
      this.providerOutcome = outcome;
    } catch { this.close(); }
  }

  /**
   * Times the first output at the adapter's own observation, not at its later
   * projection; the difference is reported as first_output_queue_ms.
   * @returns whether this event was this turn's first visible output.
   */
  observeOutput(kind: FirstOutputKind, observedAt: unknown): boolean {
    if (this.closed || this.emitted || !this.outputOpen || this.providerCalledWallMs === null) return false;
    try {
      const now = this.clock.now();
      const wallNow = this.clock.wallNow();
      const observedWall = wallTime(observedAt);
      if (observedWall !== null && observedWall < this.providerCalledWallMs) return false;
      const queueMs = observedWall === null ? null : Math.max(0, wallNow - observedWall);
      const observed = now - (queueMs ?? 0);
      if (this.providerEndedAt !== null && observed > this.providerEndedAt) return false;
      const at = this.marks.mark("first_output", observed);
      this.emit("first_output", kind, queueMs === null ? null : round(queueMs), at);
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  /** Ends this attempt. One that never reached its provider is measured again on retry. */
  end(): void {
    if (this.closed) return;
    try {
      if (this.providerCalledWallMs === null) {
        this.owner.restoreArrival(this.inboxItemId, { ...this.arrival, attempt: this.arrival.attempt + 1 });
      } else {
        const endedAt = this.providerEndedAt ?? this.clock.now();
        if (!this.emitted) {
          const at = this.marks.mark("turn_end", endedAt);
          const answered = this.providerOutcome === "reply" || this.providerOutcome === "no_reply"
            || this.providerOutcome === "unreadable";
          this.emit(answered ? "no_visible_output" : "failed", null, null, at);
        }
        this.owner.turnEnded(this.agentId, endedAt);
      }
    } catch { /* Diagnostics never change an outcome. */ }
    this.close();
  }

  private emit(outcome: TurnStartLatencySample["outcome"], kind: FirstOutputKind | null, queueMs: number | null, at: number): void {
    this.emitted = true;
    const launch = this.launch;
    const previousEnd = this.owner.previousTurnEnd(this.agentId);
    const start: TurnStartLatencySample["start"] = this.provider === "cursor"
      ? "per_turn_process"
      : launch || !this.arrival.liveHandle ? "cold" : "warm";
    this.owner.report({
      event: "turn_start_latency",
      sample: {
        provider: this.provider,
        source: this.arrival.source,
        start,
        attempt: this.arrival.attempt,
        busy_at_arrival: this.arrival.busy,
        idle_ms: this.arrival.busy ? 0 : previousEnd === null ? null : round(Math.max(0, this.arrival.at - previousEnd)),
        outcome,
        first_output: kind,
        elapsed_ms: round(at - this.arrival.at),
        server_to_inbox_ms: this.arrival.serverToInboxMs,
        first_output_queue_ms: queueMs,
        phases_ms: this.marks.rounded(),
        launch: launch ? {
          launch: launch.sample.launch,
          elapsed_ms: launch.sample.elapsed_ms,
          phases_ms: launch.sample.phases_ms,
          waited_ms: round(Math.max(0, launch.finishedAt - this.arrival.at)),
        } : null,
      },
    });
  }

  private close(): void {
    this.closed = true;
    this.owner.release(this);
  }
}

export class TurnStartLatency {
  private reporter: ((record: StartLatencyRecord) => void) | null = null;
  private readonly arrivals = new Map<string, Arrival>();
  private readonly active = new Map<string, TurnStartTrace>();
  private readonly launches = new Map<string, CompletedLaunch>();
  private readonly turnEnds = new Map<string, number>();

  constructor(private readonly clock: StartLatencyClock = defaultClock) {}

  /** Only the daemon entrypoint installs a reporter; without one nothing is kept. */
  setReporter(reporter: ((record: StartLatencyRecord) => void) | null): void {
    this.reporter = reporter;
    if (!reporter) {
      this.arrivals.clear();
      this.active.clear();
      this.launches.clear();
      this.turnEnds.clear();
    }
  }

  /** A message newly committed to this agent's inbox. */
  received(input: {
    agentId: string;
    item: { inbox_item_id: string; source_message_id: string; source_message: unknown };
    busy: boolean;
    liveHandle: boolean;
  }): void {
    if (!this.reporter) return;
    try {
      const { item } = input;
      const server = wallTime((item.source_message as { timestamp?: unknown } | null)?.timestamp);
      this.rememberArrival(item.inbox_item_id, {
        agentId: input.agentId,
        at: this.clock.now(),
        source: queuedDeliveryKind(item.source_message_id, item.source_message),
        busy: input.busy,
        liveHandle: input.liveHandle,
        serverToInboxMs: server === null ? null : round(this.clock.wallNow() - server),
        attempt: 1,
      });
    } catch { /* Diagnostics never change intake. */ }
  }

  /** A fresh delivery admitted with a live handle. Recovered turns are not measured. */
  begin(agentId: string, inboxItemId: string, provider: string): TurnStartTrace | null {
    if (!this.reporter) return null;
    const arrival = this.arrivals.get(inboxItemId);
    if (!arrival || arrival.agentId !== agentId) return null;
    this.arrivals.delete(inboxItemId);
    try {
      const trace = new TurnStartTrace(this, agentId, inboxItemId, provider, arrival, this.clock);
      this.active.set(agentId, trace);
      return trace;
    } catch {
      return null;
    }
  }

  /**
   * A turn without a trace (an initial message, a recovery, a continuation)
   * reached its provider. It is still the first turn after a launch.
   */
  unmeasuredTurnStarted(agentId: string): void {
    if (this.reporter) this.takeLaunch(agentId);
  }

  unmeasuredTurnEnded(agentId: string): void {
    if (!this.reporter) return;
    try { this.turnEnded(agentId, this.clock.now()); } catch { /* Diagnostics never change an outcome. */ }
  }

  /** A projected live-display event of this agent's current installation. */
  observeOutput(agentId: string, method: string, observedAt: unknown): void {
    const kind = firstOutputKind(method);
    if (!kind) return;
    this.active.get(agentId)?.observeOutput(kind, observedAt);
  }

  beginLaunch(agentId: string, provider: string): LaunchStartTrace | null {
    if (!this.reporter) return null;
    this.active.get(agentId)?.processReplaced();
    try { return new LaunchStartTrace(this, agentId, provider, this.clock); } catch { return null; }
  }

  launchCompleted(agentId: string, finishedAt: number, sample: LaunchLatencySample): void {
    if (!this.reporter) return;
    this.remember(this.launches, agentId, { finishedAt, sample, used: false }, MAX_REMEMBERED_AGENTS);
    this.report({ event: "provider_launch_latency", sample });
  }

  /** The agent's latest launch, once: only the first turn after it is its cold start. */
  takeLaunch(agentId: string): CompletedLaunch | null {
    const launch = this.launches.get(agentId);
    if (!launch || launch.used) return null;
    launch.used = true;
    return launch;
  }

  turnEnded(agentId: string, at: number): void {
    if (this.reporter) this.remember(this.turnEnds, agentId, at, MAX_REMEMBERED_AGENTS);
  }

  previousTurnEnd(agentId: string): number | null {
    return this.turnEnds.get(agentId) ?? null;
  }

  restoreArrival(inboxItemId: string, arrival: Arrival): void {
    if (this.reporter) this.rememberArrival(inboxItemId, arrival);
  }

  release(trace: TurnStartTrace): void {
    if (this.active.get(trace.agentId) === trace) this.active.delete(trace.agentId);
  }

  report(record: StartLatencyRecord): void {
    try { this.reporter?.(record); } catch { /* A sink failure is not the operation's failure. */ }
  }

  /** Arrivals that never begin (batched or settled without a turn) age out per agent. */
  private rememberArrival(inboxItemId: string, arrival: Arrival): void {
    this.remember(this.arrivals, inboxItemId, arrival, MAX_WAITING_MESSAGES);
    let sameAgent = 0;
    for (const value of this.arrivals.values()) if (value.agentId === arrival.agentId) sameAgent += 1;
    for (const [key, value] of this.arrivals) {
      if (sameAgent <= MAX_WAITING_MESSAGES_PER_AGENT) break;
      if (value.agentId !== arrival.agentId) continue;
      this.arrivals.delete(key);
      sameAgent -= 1;
    }
  }

  private remember<Value>(map: Map<string, Value>, key: string, value: Value, limit: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value!);
  }
}

/** The daemon's single instance; see setTurnStartLatencyReporter. */
export const turnStartLatency = new TurnStartLatency();

export function setTurnStartLatencyReporter(reporter: ((record: StartLatencyRecord) => void) | null): void {
  turnStartLatency.setReporter(reporter);
}
