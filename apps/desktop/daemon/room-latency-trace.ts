import { performance } from "node:perf_hooks";

type Operation = "authority" | "worker_binding_store" | "inbox_write" | "workspace_begin" | "workspace_settle" | "workspace_capture" | "silent_ack";
type Phase = "drain" | "generation" | "manifest" | "binding" | "credential_lookup" | "queue_wait" | "database" | "operation" | "remaining"
  | "lookup" | "location" | "capture" | "worker" | "projection" | "persistence" | "cleanup" | "authority";
export type RoomLatencySample = {
  operation: Operation;
  elapsed_ms: number;
  phases_ms: Partial<Record<Phase, number>>;
  event_loop_active_ms: number;
  event_loop_idle_ms: number;
};

const lastReport: Partial<Record<Operation, number>> = {};
let reportSample: ((sample: RoomLatencySample) => void) | null = null;

/** The packaged daemon has no stderr; its entrypoint supplies the local log. */
export function setRoomLatencyReporter(report: ((sample: RoomLatencySample) => void) | null): void {
  reportSample = report;
}

function reportSlowOperation(sample: RoomLatencySample): void {
  if (!reportSample) return;
  const now = performance.now();
  // A stalled host can slow every poll. Bound output to one sample per path
  // per ten seconds; retain no room content, identifiers, errors or credentials.
  if (now - (lastReport[sample.operation] ?? -Infinity) < 10_000) return;
  lastReport[sample.operation] = now;
  reportSample(sample);
}

/** Duration-only diagnostics. This never changes authority, retry or settlement. */
export class RoomLatencyTrace {
  private started = 0;
  private previous = 0;
  private loopStarted: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  private readonly phases: RoomLatencySample["phases_ms"] = {};
  private finished = false;
  private disabled = false;

  constructor(
    private readonly operation: Operation,
    private readonly now: () => number = () => performance.now(),
    private readonly report: (sample: RoomLatencySample) => void = reportSlowOperation,
  ) {
    try {
      this.started = this.previous = now();
      this.loopStarted = performance.eventLoopUtilization();
    } catch { this.disabled = true; }
  }

  mark(phase: Phase): void {
    if (this.disabled) return;
    try {
      const now = this.now();
      this.phases[phase] = (this.phases[phase] ?? 0) + now - this.previous;
      this.previous = now;
    } catch { this.disabled = true; }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.mark("remaining");
    const elapsed = this.previous - this.started;
    if (this.disabled || elapsed < 1_000) return;
    try {
      // These counters cover the whole interval, including unrelated work;
      // they distinguish a busy loop from idle time, not CPU ownership.
      const loop = performance.eventLoopUtilization(this.loopStarted);
      this.report({ operation: this.operation, elapsed_ms: Math.round(elapsed),
        phases_ms: Object.fromEntries(Object.entries(this.phases).map(([phase, ms]) => [phase, Math.round(ms)])),
        event_loop_active_ms: Math.round(loop.active), event_loop_idle_ms: Math.round(loop.idle) });
    } catch { /* Logging cannot prevent a result or release a different outcome. */ }
  }
}
