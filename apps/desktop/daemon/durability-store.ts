import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExecutionGeneration, ExecutionTerminalPayload, TaskWorkAttempt, WorkAttemptCheckpoint, WorkAttemptState } from "./types.js";

const STORE_VERSION = 2;
const WORKSPACE_MARKER = ".letagents-work-attempt.json";
type StoredAttempts = { version: typeof STORE_VERSION; attempts: TaskWorkAttempt[]; checksum: string };
type LegacyStoredAttempts = { version: 1; attempts: TaskWorkAttempt[] };
type WorkspaceMarker = { version: 1; work_attempt_id: string; task_id: string };

export class AttemptNotFoundError extends Error {}
export class ImmutableExecutionError extends Error {}
export class CorruptAttemptStoreError extends Error {}

function checksum(attempts: TaskWorkAttempt[]): string {
  return createHash("sha256").update(JSON.stringify(attempts)).digest("hex");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function isStrictChild(root: string, candidate: string): boolean { return resolve(root) !== resolve(candidate) && isInside(root, candidate); }

const attemptStates = new Set<WorkAttemptState>(["active", "ambiguous", "quarantined", "unreviewed", "cleanly_concluded", "abandoned", "gc_pending", "garbage_collected"]);

function isTerminal(value: unknown): value is ExecutionTerminalPayload {
  if (!value || typeof value !== "object") return false;
  const terminal = value as Partial<ExecutionTerminalPayload>;
  return isIsoTime(terminal.ended_at) && (terminal.exit_code === null || Number.isInteger(terminal.exit_code))
    && (terminal.signal === null || typeof terminal.signal === "string") && (terminal.stdio_archive_ref === null || typeof terminal.stdio_archive_ref === "string")
    && typeof terminal.stdio_tail === "string" && typeof terminal.terminal_cause === "string" && terminal.terminal_cause.trim().length > 0
    && typeof terminal.actor === "string" && terminal.actor.trim().length > 0 && Number.isInteger(terminal.generation) && (terminal.generation ?? 0) > 0
    && (terminal.provider_continuation_id === null || typeof terminal.provider_continuation_id === "string");
}

function isExecution(value: unknown): value is ExecutionGeneration {
  if (!value || typeof value !== "object") return false;
  const execution = value as Partial<ExecutionGeneration>;
  return isUuid(execution.execution_generation_id) && isUuid(execution.work_attempt_id) && isIsoTime(execution.started_at)
    && typeof execution.actor === "string" && execution.actor.trim().length > 0 && Number.isInteger(execution.generation) && (execution.generation ?? 0) > 0
    && (execution.terminal === null || isTerminal(execution.terminal));
}

function isAttempt(value: unknown): value is TaskWorkAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<TaskWorkAttempt>;
  if (!(isUuid(attempt.work_attempt_id) && typeof attempt.task_id === "string" && attempt.task_id.trim() && typeof attempt.lease_id === "string" && attempt.lease_id.trim()
    && Number.isInteger(attempt.current_lease_epoch) && (attempt.current_lease_epoch ?? -1) >= 0 && typeof attempt.workspace_path === "string" && isAbsolute(attempt.workspace_path)
    && typeof attempt.state === "string" && attemptStates.has(attempt.state as WorkAttemptState) && isIsoTime(attempt.created_at) && (attempt.concluded_at === null || isIsoTime(attempt.concluded_at))
    && (attempt.conclusion_cause === null || typeof attempt.conclusion_cause === "string")
    && (attempt.postmortem_diff === null || typeof attempt.postmortem_diff === "string")
    && Array.isArray(attempt.epoch_history) && Array.isArray(attempt.checkpoints) && Array.isArray(attempt.execution_generations))) return false;
  const epochs = attempt.epoch_history as unknown[];
  const checkpoints = attempt.checkpoints as unknown[];
  const executions = attempt.execution_generations as unknown[];
  if (epochs.length === 0 || !epochs.every((epoch) => !!epoch && typeof epoch === "object" && typeof (epoch as { lease_id?: unknown }).lease_id === "string"
    && Number.isInteger((epoch as { epoch?: unknown }).epoch) && isIsoTime((epoch as { recorded_at?: unknown }).recorded_at))) return false;
  const lastEpoch = epochs.at(-1) as { lease_id: string; epoch: number };
  if (lastEpoch.lease_id !== attempt.lease_id || lastEpoch.epoch !== attempt.current_lease_epoch) return false;
  if (!checkpoints.every((checkpoint) => !!checkpoint && typeof checkpoint === "object" && isIsoTime((checkpoint as { at?: unknown }).at)
    && (((checkpoint as { room_cursor?: unknown }).room_cursor === null) || typeof (checkpoint as { room_cursor?: unknown }).room_cursor === "string")
    && (((checkpoint as { provider_continuation_id?: unknown }).provider_continuation_id === null) || typeof (checkpoint as { provider_continuation_id?: unknown }).provider_continuation_id === "string"))) return false;
  if (!executions.every(isExecution)) return false;
  const typedExecutions = executions as ExecutionGeneration[];
  if (new Set(typedExecutions.map((item) => item.execution_generation_id)).size !== typedExecutions.length) return false;
  if (typedExecutions.some((item, index) => item.work_attempt_id !== attempt.work_attempt_id || (index > 0 && item.generation <= typedExecutions[index - 1]!.generation)
    || (item.terminal && (item.terminal.actor !== item.actor || item.terminal.generation !== item.generation || Date.parse(item.terminal.ended_at) < Date.parse(item.started_at))))) return false;
  if (typedExecutions.filter((item) => item.terminal === null).length > 1) return false;
  return !(attempt.state === "cleanly_concluded" && (!attempt.concluded_at || !attempt.conclusion_cause || attempt.postmortem_diff === null));
}

/**
 * Durable supervisor-owned state. The on-disk record is checksummed and
 * runtime-validated before it is ever used as authority for filesystem work.
 * A corrupt record is quarantined rather than interpreted as deletion input.
 */
export class WorkDurabilityStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly workspaceRoot: string;

  constructor(readonly path: string, readonly attemptsRoot: string, private readonly now: () => string = () => new Date().toISOString(), workspaceRoot = join(dirname(attemptsRoot), "worktrees"), private readonly beforeGcDelete?: (attempt: TaskWorkAttempt) => Promise<void>) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  static mintWorkAttemptId(): string { return randomUUID(); }
  async createAttempt(input: { taskId: string; leaseId: string; leaseEpoch: number; workspacePath: string; workAttemptId?: string }): Promise<TaskWorkAttempt> {
    this.assertWorkspacePath(input.workspacePath);
    const workAttemptId = input.workAttemptId ?? WorkDurabilityStore.mintWorkAttemptId();
    this.assertAttemptId(workAttemptId);
    const attempt = await this.mutate((stored) => {
      const createdAt = this.now();
      const attempt: TaskWorkAttempt = {
        work_attempt_id: workAttemptId, task_id: input.taskId, lease_id: input.leaseId, current_lease_epoch: input.leaseEpoch,
        epoch_history: [{ lease_id: input.leaseId, epoch: input.leaseEpoch, recorded_at: createdAt }], workspace_path: input.workspacePath,
        state: "active", created_at: createdAt, concluded_at: null, conclusion_cause: null, postmortem_diff: null,
        checkpoints: [], execution_generations: [],
      };
      stored.attempts.push(attempt);
      return attempt;
    });
    await this.bindWorkspaceMarker(attempt);
    return attempt;
  }

  async getAttempt(workAttemptId: string): Promise<TaskWorkAttempt> {
    this.assertAttemptId(workAttemptId);
    const attempt = (await this.load()).attempts.find((candidate) => candidate.work_attempt_id === workAttemptId);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
    return attempt;
  }

  async rebindAttempt(workAttemptId: string, leaseId: string, leaseEpoch: number): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot be rebound.");
      if (!Number.isInteger(leaseEpoch) || leaseEpoch <= attempt.current_lease_epoch) throw new ImmutableExecutionError("Lease epochs must advance monotonically.");
      attempt.lease_id = leaseId;
      attempt.current_lease_epoch = leaseEpoch;
      attempt.epoch_history.push({ lease_id: leaseId, epoch: leaseEpoch, recorded_at: this.now() });
      return attempt;
    });
  }

  async checkpoint(workAttemptId: string, checkpoint: Omit<WorkAttemptCheckpoint, "at"> & { at?: string }): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot be checkpointed.");
      attempt.checkpoints.push({ at: checkpoint.at ?? this.now(), room_cursor: checkpoint.room_cursor, provider_continuation_id: checkpoint.provider_continuation_id });
      return attempt;
    });
  }

  async startGeneration(workAttemptId: string, actor: string, generation: number): Promise<ExecutionGeneration> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot start a generation.");
      if (!actor.trim() || !Number.isInteger(generation) || generation < 1) throw new ImmutableExecutionError("Generation actor and number are required.");
      if (attempt.execution_generations.some((item) => item.terminal === null)) throw new ImmutableExecutionError("Only one execution generation may be live.");
      const prior = attempt.execution_generations.reduce((max, item) => Math.max(max, item.generation), 0);
      if (generation <= prior) throw new ImmutableExecutionError("Execution generations must be unique and strictly monotonic.");
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
      if (terminal.generation !== execution.generation || terminal.actor !== execution.actor) throw new ImmutableExecutionError("Terminal identity must match its execution record.");
      if (!terminal.terminal_cause.trim() || !isIsoTime(terminal.ended_at) || Date.parse(terminal.ended_at) < Date.parse(execution.started_at)) {
        throw new ImmutableExecutionError("Terminal cause and a non-regressing end time are required.");
      }
      execution.terminal = { ...terminal, stdio_tail: Buffer.from(terminal.stdio_tail).subarray(-maxStdioTailBytes).toString("utf8") };
      return execution;
    });
  }

  async appendStdio(workAttemptId: string, line: string, maxBytes = 1024 * 1024): Promise<string> {
    this.assertAttemptId(workAttemptId);
    return this.exclusive(async () => {
      const stored = await this.load();
      this.required(stored, workAttemptId);
      const root = await this.managedRealDirectory(this.attemptsRoot, true);
      const directory = join(root, workAttemptId);
      await this.ensureManagedDirectory(directory, root, true);
      const logPath = join(directory, "stdio.log");
      try {
        const info = await lstat(logPath);
        if (info.isSymbolicLink() || !info.isFile()) throw new ImmutableExecutionError("Stdio log must be a regular daemon-owned file.");
        if (info.size >= maxBytes) await rename(logPath, `${logPath}.${randomUUID()}.archive`);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await appendFile(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return logPath;
    });
  }

  async concludeAttempt(workAttemptId: string, input: { state: Extract<WorkAttemptState, "cleanly_concluded" | "abandoned">; cause: string; postmortemDiff: string }): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("Work attempts can conclude only once.");
      if (!input.cause.trim()) throw new ImmutableExecutionError("Work attempts require an explicit conclusion cause.");
      attempt.state = input.state;
      attempt.concluded_at = this.now();
      attempt.conclusion_cause = input.cause;
      attempt.postmortem_diff = input.postmortemDiff;
      return attempt;
    });
  }

  async markState(workAttemptId: string, state: Extract<WorkAttemptState, "ambiguous" | "quarantined" | "unreviewed">): Promise<TaskWorkAttempt> {
    return this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("GC reservation prevents state changes; retry after recovery.");
      attempt.state = state;
      return attempt;
    });
  }

  async garbageCollect(keepCleanlyConcluded: number): Promise<string[]> {
    const reserved = await this.mutate((stored) => {
      const candidates = stored.attempts.filter((attempt) => (attempt.state === "cleanly_concluded" && attempt.concluded_at && attempt.postmortem_diff !== null) || attempt.state === "gc_pending")
        .sort((a, b) => (b.concluded_at ?? "").localeCompare(a.concluded_at ?? ""))
        .slice(Math.max(0, keepCleanlyConcluded));
      for (const attempt of candidates) attempt.state = "gc_pending";
      return candidates.map((attempt) => ({ ...attempt }));
    });
    const removed: string[] = [];
    for (const attempt of reserved) {
      try {
        await this.beforeGcDelete?.(attempt);
        try { await lstat(attempt.workspace_path); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.mutate((stored) => { const current = this.required(stored, attempt.work_attempt_id); if (current.state !== "gc_pending") throw new ImmutableExecutionError("GC reservation was lost."); current.state = "garbage_collected"; return current; });
          removed.push(attempt.work_attempt_id);
          continue;
        }
        await this.verifyWorkspaceForDeletion(attempt);
        await rm(attempt.workspace_path, { recursive: true, force: false });
        await this.mutate((stored) => { const current = this.required(stored, attempt.work_attempt_id); if (current.state !== "gc_pending") throw new ImmutableExecutionError("GC reservation was lost."); current.state = "garbage_collected"; return current; });
        removed.push(attempt.work_attempt_id);
      } catch (error) {
        console.error(`Refusing to garbage collect work attempt ${attempt.work_attempt_id}:`, error);
        await this.mutate((stored) => { const current = this.required(stored, attempt.work_attempt_id); if (current.state === "gc_pending") current.state = "unreviewed"; return current; });
      }
    }
    return removed;
  }

  private async load(): Promise<StoredAttempts> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (this.validLegacy(parsed)) {
        // A v1 file predates integrity protection. Preserve live/recoverable
        // attempts, but never inherit a legacy clean conclusion as GC authority.
        const migrated: StoredAttempts = {
          version: STORE_VERSION,
          attempts: parsed.attempts.map((attempt) => (attempt.state === "cleanly_concluded" || attempt.state === "abandoned" ? { ...attempt, state: "unreviewed" } : attempt)),
          checksum: "",
        };
        migrated.checksum = checksum(migrated.attempts);
        await this.write(migrated);
        return migrated;
      }
      if (!this.valid(parsed)) throw new CorruptAttemptStoreError("Attempt store has an invalid schema or integrity checksum.");
      return parsed;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      if (error instanceof CorruptAttemptStoreError || error instanceof SyntaxError) {
        await this.quarantine();
        return this.empty();
      }
      throw error;
    }
  }

  private valid(value: unknown): value is StoredAttempts {
    if (!value || typeof value !== "object") return false;
    const stored = value as Partial<StoredAttempts>;
    if (stored.version !== STORE_VERSION || !Array.isArray(stored.attempts) || typeof stored.checksum !== "string" || !stored.attempts.every(isAttempt)) return false;
    const expected = Buffer.from(checksum(stored.attempts));
    const actual = Buffer.from(stored.checksum);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private validLegacy(value: unknown): value is LegacyStoredAttempts {
    return !!value && typeof value === "object" && (value as Partial<LegacyStoredAttempts>).version === 1
      && Array.isArray((value as Partial<LegacyStoredAttempts>).attempts) && (value as LegacyStoredAttempts).attempts.every(isAttempt);
  }

  private empty(): StoredAttempts { return { version: STORE_VERSION, attempts: [], checksum: checksum([]) }; }

  private async quarantine(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await rename(this.path, `${this.path}.corrupt.${Date.now()}.${randomUUID()}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Unable to quarantine corrupt attempt store ${this.path}:`, error);
    }
  }

  private async mutate<T>(operation: (stored: StoredAttempts) => T): Promise<T> {
    return this.exclusive(async () => {
      const stored = await this.load();
      const result = operation(stored);
      stored.checksum = checksum(stored.attempts);
      await this.write(stored);
      return result;
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private required(stored: StoredAttempts, id: string): TaskWorkAttempt {
    this.assertAttemptId(id);
    const attempt = stored.attempts.find((candidate) => candidate.work_attempt_id === id);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${id}`);
    return attempt;
  }

  private assertAttemptId(id: string): void { if (!isUuid(id)) throw new AttemptNotFoundError("Work attempt identifiers must be UUIDs."); }

  private assertWorkspacePath(path: string): void {
    const candidate = resolve(path);
    if (!isStrictChild(this.workspaceRoot, candidate)) throw new ImmutableExecutionError("Workspace must remain inside the daemon-owned workspace root.");
  }

  private async managedRealDirectory(path: string, create: boolean): Promise<string> {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ImmutableExecutionError("Daemon directory must be a non-symlink directory.");
    return realpath(path);
  }

  private async ensureManagedDirectory(path: string, root: string, create: boolean): Promise<void> {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ImmutableExecutionError("Attempt directory must be a non-symlink directory.");
    if (!isInside(root, await realpath(path))) throw new ImmutableExecutionError("Attempt directory escaped the daemon root.");
  }

  private async verifyWorkspaceForDeletion(attempt: TaskWorkAttempt): Promise<void> {
    this.assertWorkspacePath(attempt.workspace_path);
    const root = await this.managedRealDirectory(this.workspaceRoot, false);
    const info = await lstat(attempt.workspace_path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ImmutableExecutionError("Refusing to delete a non-directory or symlink workspace.");
    if (!isStrictChild(root, await realpath(attempt.workspace_path))) throw new ImmutableExecutionError("Workspace escaped daemon ownership root.");
    const markerPath = join(attempt.workspace_path, WORKSPACE_MARKER);
    const markerInfo = await lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new ImmutableExecutionError("Workspace marker is missing or unsafe.");
    const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    const valid = marker && typeof marker === "object" && (marker as Partial<WorkspaceMarker>).version === 1
      && (marker as Partial<WorkspaceMarker>).work_attempt_id === attempt.work_attempt_id && (marker as Partial<WorkspaceMarker>).task_id === attempt.task_id;
    if (!valid) throw new ImmutableExecutionError("Workspace marker does not match the durable attempt identity.");
  }

  private async bindWorkspaceMarker(attempt: TaskWorkAttempt): Promise<void> {
    const markerPath = join(attempt.workspace_path, WORKSPACE_MARKER);
    try {
      const info = await lstat(markerPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new ImmutableExecutionError("Workspace marker is unsafe.");
      const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!marker || typeof marker !== "object" || (marker as { work_attempt_id?: unknown }).work_attempt_id !== attempt.work_attempt_id) throw new ImmutableExecutionError("Workspace marker does not match the supervisor-minted attempt ID.");
      await writeFile(markerPath, `${JSON.stringify({ ...(marker as Record<string, unknown>), version: 1, task_id: attempt.task_id })}\n`, { mode: 0o600 });
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
