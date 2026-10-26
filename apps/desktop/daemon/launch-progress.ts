import { firstOutputKind, type LaunchPhase } from "./turn-start-latency.js";

/**
 * Live start-up progress of each agent's latest provider launch, for the
 * desktop's start-up row. It follows the same marks as LaunchStartTrace
 * (turn-start-latency.ts) but is always on and keeps only the latest launch
 * of each agent, in memory.
 *
 * A view carries phase names, wall times, durations, how many launches are
 * ahead in the daemon-wide launch queue, and on failure the phase and one
 * recovery kind. It carries no room content, identifiers, error text or
 * credentials. No failure here may change a launch.
 */

export type LaunchFailureAction = "sign_in" | "install" | "retry";

export type LaunchProgressView = {
  /** 1, or one more than the failed launch this one retries. */
  attempt: number;
  started_at: string;
  state: "running" | "launched" | "failed";
  /** The phase in progress; null once the launch ended. */
  current: LaunchPhase | null;
  /** Phases in the order they ran; `ms` is null for the one in progress. */
  phases: Array<{ phase: LaunchPhase; started_at: string; ms: number | null }>;
  ended_at: string | null;
  /** The first visible output after this launch (text, reasoning or a tool). */
  first_output_at: string | null;
  failure: { phase: LaunchPhase; action: LaunchFailureAction } | null;
  /** Launches that start before this one, while it waits for a launch slot. */
  slot_ahead: number | null;
};

type Run = {
  attempt: number;
  startedAt: number;
  state: LaunchProgressView["state"];
  phases: Array<{ phase: LaunchPhase; startedAt: number; ms: number | null }>;
  endedAt: number | null;
  firstOutputAt: number | null;
  failure: LaunchProgressView["failure"];
  onChange: () => void;
};

const MAX_REMEMBERED_AGENTS = 128;

/** The phase that starts when `ended` ends. Process hands over to the bootstrap only at a native ready signal. */
const NEXT: Record<LaunchPhase, LaunchPhase | null> = {
  prepare: "slot_wait",
  slot_wait: "admission",
  admission: "process",
  process: "bootstrap",
  bootstrap: "install",
  install: null,
};

const INSTALL_PATTERN = /\bspawn\b[^\n]{0,200}\bENOENT\b|command not found|executable not found|not installed/i;
const SIGN_IN_PATTERN = /\b(?:HTTP|status|error|code)[ :=]*40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|unauthori[sz]ed|invalid api key|not (?:signed|logged) in|sign[ -]?in required|log ?in required|please (?:run|use) [^\n]{0,40}login|authentication (?:failed|required|error)/i;

/** One recovery kind from a launch error. The error text itself never leaves the daemon. */
export function launchFailureAction(error: unknown): LaunchFailureAction {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 3 || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") { texts.push(value); return; }
    if (typeof value !== "object") return;
    const record = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (record.code === "ENOENT") texts.push("spawn ENOENT");
    if (typeof record.message === "string") texts.push(record.message);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) for (const inner of record.errors) visit(inner, depth + 1);
  };
  try { visit(error, 0); } catch { return "retry"; }
  const text = texts.join("\n");
  if (INSTALL_PATTERN.test(text)) return "install";
  if (SIGN_IN_PATTERN.test(text)) return "sign_in";
  return "retry";
}

export class LaunchProgress {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly wallNow: () => number = () => Date.now()) {}

  /** A provider launch began; it replaces the agent's earlier launch. */
  begin(agentId: string, onChange: () => void = () => {}): void {
    try {
      const now = this.wallNow();
      const previous = this.runs.get(agentId);
      this.runs.delete(agentId);
      this.runs.set(agentId, {
        attempt: previous?.state === "failed" ? previous.attempt + 1 : 1,
        startedAt: now, state: "running", phases: [{ phase: "prepare", startedAt: now, ms: null }],
        endedAt: null, firstOutputAt: null, failure: null, onChange,
      });
      // Ended launches go first; a running one is dropped only when every remembered launch is running.
      for (const [key, run] of this.runs) {
        if (this.runs.size <= MAX_REMEMBERED_AGENTS) break;
        if (run.state !== "running") this.runs.delete(key);
      }
      while (this.runs.size > MAX_REMEMBERED_AGENTS) this.runs.delete(this.runs.keys().next().value!);
      this.changed(agentId);
    } catch { /* Progress never changes a launch. */ }
  }

  /** `phase` ended; the next one starts. A phase that is not the current one is ignored. */
  mark(agentId: string, phase: LaunchPhase, next: LaunchPhase | null = NEXT[phase]): void {
    const run = this.running(agentId);
    const current = run?.phases.at(-1);
    if (!run || !current || current.phase !== phase || current.ms !== null) return;
    const now = this.wallNow();
    current.ms = Math.max(0, now - current.startedAt);
    if (next) run.phases.push({ phase: next, startedAt: now, ms: null });
    else { run.state = "launched"; run.endedAt = now; }
    this.changed(agentId);
  }

  /** The provider call returned: it ends the process phase, or the bootstrap after a native ready signal. */
  markProcessReturned(agentId: string): void {
    const current = this.running(agentId)?.phases.at(-1);
    // No native ready signal: the whole call was the process start, with no bootstrap.
    if (current?.phase === "process") this.mark(agentId, "process", "install");
    else if (current?.phase === "bootstrap") {
      this.mark(agentId, "bootstrap");
    }
  }

  fail(agentId: string, error: unknown): void {
    const run = this.running(agentId);
    const current = run?.phases.at(-1);
    if (!run || !current) return;
    const now = this.wallNow();
    if (current.ms === null) current.ms = Math.max(0, now - current.startedAt);
    run.state = "failed";
    run.endedAt = now;
    run.failure = { phase: current.phase, action: launchFailureAction(error) };
    this.changed(agentId);
  }

  /**
   * The launch call returned. One that neither finished nor failed (it found
   * nothing to launch, or handed over) is forgotten; the manifest tells the rest.
   */
  settle(agentId: string): void {
    const run = this.running(agentId);
    if (!run) return;
    this.runs.delete(agentId);
    try { run.onChange(); } catch { /* A listener failure is not the launch's failure. */ }
  }

  /** A projected live-display event; the first after a finished launch is its first output. */
  observeOutput(agentId: string, method: string): void {
    const run = this.runs.get(agentId);
    if (!run || run.state !== "launched" || run.firstOutputAt !== null || !firstOutputKind(method)) return;
    run.firstOutputAt = this.wallNow();
    this.changed(agentId);
  }

  view(agentId: string, launchQueue?: { active: number; queued: readonly string[] } | null): LaunchProgressView | null {
    const run = this.runs.get(agentId);
    if (!run) return null;
    const iso = (ms: number) => new Date(ms).toISOString();
    const current = run.state === "running" ? run.phases.at(-1)!.phase : null;
    let slotAhead: number | null = null;
    if (current === "slot_wait" && launchQueue) {
      const index = launchQueue.queued.indexOf(agentId);
      if (index >= 0) slotAhead = launchQueue.active + index;
    }
    return {
      attempt: run.attempt,
      started_at: iso(run.startedAt),
      state: run.state,
      current,
      phases: run.phases.map((entry) => ({ phase: entry.phase, started_at: iso(entry.startedAt), ms: entry.ms === null ? null : Math.round(entry.ms) })),
      ended_at: run.endedAt === null ? null : iso(run.endedAt),
      first_output_at: run.firstOutputAt === null ? null : iso(run.firstOutputAt),
      failure: run.failure,
      slot_ahead: slotAhead,
    };
  }

  private running(agentId: string): Run | null {
    const run = this.runs.get(agentId);
    return run?.state === "running" ? run : null;
  }

  private changed(agentId: string): void {
    try { this.runs.get(agentId)?.onChange(); } catch { /* A listener failure is not the launch's failure. */ }
  }
}

/** The daemon's single instance. */
export const launchProgress = new LaunchProgress();
