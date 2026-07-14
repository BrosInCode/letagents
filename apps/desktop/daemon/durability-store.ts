import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExecutionGeneration, ExecutionTerminalPayload, TaskWorkAttempt, WorkAttemptCheckpoint, WorkAttemptState } from "./types.js";

type StoredAttempts = { version: 1; attempts: TaskWorkAttempt[] };

export class AttemptNotFoundError extends Error {}
export class ImmutableExecutionError extends Error {}

/**
 * Durable supervisor-owned state. An attempt is deliberately distinct from a
 * process generation: a process can die or a lease can rebind without losing
 * its workspace, checkpoints, append-only execution history, or scratchpad.
 */
export class WorkDurabilityStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly path: string, readonly attemptsRoot: string, private readonly now: () => string = () => new Date().toISOString()) {}

  async createAttempt(input: { taskId: string; leaseId: string; leaseEpoch: number; workspacePath: string }): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const createdAt = this.now();
      const attempt: TaskWorkAttempt = {
        work_attempt_id: randomUUID(), task_id: input.taskId, lease_id: input.leaseId, current_lease_epoch: input.leaseEpoch,
        epoch_history: [{ lease_id: input.leaseId, epoch: input.leaseEpoch, recorded_at: createdAt }], workspace_path: input.workspacePath,
        state: "active", created_at: createdAt, concluded_at: null, conclusion_cause: null, postmortem_diff: null,
        checkpoints: [], execution_generations: [],
      };
      stored.attempts.push(attempt);
      return attempt;
    });
  }

  async getAttempt(workAttemptId: string): Promise<TaskWorkAttempt> {
    const attempt = (await this.load()).attempts.find((candidate) => candidate.work_attempt_id === workAttemptId);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
    return attempt;
  }

  async rebindAttempt(workAttemptId: string, leaseId: string, leaseEpoch: number): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at) throw new ImmutableExecutionError("A concluded work attempt cannot be rebound.");
      if (leaseEpoch <= attempt.current_lease_epoch) throw new ImmutableExecutionError("Lease epochs must advance monotonically.");
      attempt.lease_id = leaseId;
      attempt.current_lease_epoch = leaseEpoch;
      attempt.epoch_history.push({ lease_id: leaseId, epoch: leaseEpoch, recorded_at: this.now() });
      return attempt;
    });
  }

  async checkpoint(workAttemptId: string, checkpoint: Omit<WorkAttemptCheckpoint, "at"> & { at?: string }): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at) throw new ImmutableExecutionError("A concluded work attempt cannot be checkpointed.");
      attempt.checkpoints.push({ at: checkpoint.at ?? this.now(), room_cursor: checkpoint.room_cursor, provider_continuation_id: checkpoint.provider_continuation_id });
      return attempt;
    });
  }

  async startGeneration(workAttemptId: string, actor: string, generation: number): Promise<ExecutionGeneration> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at) throw new ImmutableExecutionError("A concluded work attempt cannot start a generation.");
      const execution: ExecutionGeneration = { execution_generation_id: randomUUID(), work_attempt_id: workAttemptId, started_at: this.now(), actor, generation, terminal: null };
      attempt.execution_generations.push(execution);
      return execution;
    });
  }

  async recordTerminal(workAttemptId: string, executionGenerationId: string, terminal: ExecutionTerminalPayload, maxStdioTailBytes = 64 * 1024): Promise<ExecutionGeneration> {
    return this.mutate((stored) => {
      const execution = this.required(stored, workAttemptId).execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
      if (!execution) throw new AttemptNotFoundError(`Unknown execution generation: ${executionGenerationId}`);
      if (execution.terminal) throw new ImmutableExecutionError("Execution terminal payloads are append-only and immutable.");
      if (terminal.generation !== execution.generation) throw new ImmutableExecutionError("Terminal generation does not match its execution record.");
      execution.terminal = { ...terminal, stdio_tail: Buffer.from(terminal.stdio_tail).subarray(-maxStdioTailBytes).toString("utf8") };
      return execution;
    });
  }

  async appendStdio(workAttemptId: string, line: string, maxBytes = 1024 * 1024): Promise<string> {
    const directory = join(this.attemptsRoot, workAttemptId);
    const path = join(directory, "stdio.log");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      if ((await stat(path)).size >= maxBytes) await rename(path, `${path}.${Date.now()}.archive`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  async concludeAttempt(workAttemptId: string, input: { state: Extract<WorkAttemptState, "cleanly_concluded" | "abandoned">; cause: string; postmortemDiff: string }): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at) throw new ImmutableExecutionError("Work attempts can conclude only once.");
      if (!input.cause.trim()) throw new ImmutableExecutionError("Work attempts require an explicit conclusion cause.");
      attempt.state = input.state;
      attempt.concluded_at = this.now();
      attempt.conclusion_cause = input.cause;
      attempt.postmortem_diff = input.postmortemDiff;
      return attempt;
    });
  }

  async markState(workAttemptId: string, state: Extract<WorkAttemptState, "ambiguous" | "quarantined" | "unreviewed">): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => { const attempt = this.required(stored, workAttemptId); attempt.state = state; return attempt; });
  }

  async garbageCollect(keepCleanlyConcluded: number): Promise<string[]> {
    const stored = await this.load();
    const removable = stored.attempts.filter((attempt) => attempt.state === "cleanly_concluded" && attempt.concluded_at && attempt.postmortem_diff !== null)
      .sort((a, b) => (b.concluded_at ?? "").localeCompare(a.concluded_at ?? ""))
      .slice(Math.max(0, keepCleanlyConcluded));
    for (const attempt of removable) await rm(attempt.workspace_path, { recursive: true, force: true });
    return removable.map((attempt) => attempt.work_attempt_id);
  }

  private async load(): Promise<StoredAttempts> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as StoredAttempts; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, attempts: [] }; throw error; }
  }

  private async mutate<T>(operation: (stored: StoredAttempts) => T): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const stored = await this.load();
      const result = operation(stored);
      await this.write(stored);
      return result;
    } finally { release(); }
  }

  private required(stored: StoredAttempts, id: string): TaskWorkAttempt {
    const attempt = stored.attempts.find((candidate) => candidate.work_attempt_id === id);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${id}`);
    return attempt;
  }

  private async write(stored: StoredAttempts): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
