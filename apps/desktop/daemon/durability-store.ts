import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExecutionGeneration, ExecutionTerminalPayload, TaskWorkAttempt, WorkAttemptCheckpoint, WorkAttemptState } from "./types.js";
import { assertCredentialFreeRemote, normalizeRemote, WORKSPACE_MARKER, type GitCommand, type WorkspaceMarker } from "./workspace-provisioner.js";
import { acquireWorkspaceFence, type WorkspaceFenceHandle } from "./workspace-fence.js";

const STORE_VERSION = 2;
type StoredAttempts = { version: typeof STORE_VERSION; attempts: TaskWorkAttempt[]; checksum: string };
type LegacyStoredAttempts = { version: 1; attempts: TaskWorkAttempt[] };

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

function isSafeSegment(value: unknown): value is string { return typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value); }
function isWorkspaceIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<TaskWorkAttempt["workspace_identity"]>;
  if (!(isSafeSegment(identity.repo) && typeof identity.remote_url === "string" && identity.remote_url.trim().length > 0
    && /^[0-9a-f]{40,64}$/i.test(identity.resolved_revision ?? "") && typeof identity.bare_path === "string" && isAbsolute(identity.bare_path))) return false;
  try { assertCredentialFreeRemote(identity.remote_url); return true; } catch { return false; }
}

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
    && Number.isInteger(attempt.current_lease_epoch) && (attempt.current_lease_epoch ?? -1) >= 0 && typeof attempt.workspace_path === "string" && isAbsolute(attempt.workspace_path) && isWorkspaceIdentity(attempt.workspace_identity)
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
  const requiresAttestedTerminal = attempt.state === "cleanly_concluded" || attempt.state === "gc_pending" || attempt.state === "garbage_collected";
  return !(requiresAttestedTerminal && (!attempt.concluded_at || !attempt.conclusion_cause || attempt.postmortem_diff === null || typedExecutions.some((item) => item.terminal === null)));
}

/**
 * Durable supervisor-owned state. The on-disk record is checksummed and
 * runtime-validated before it is ever used as authority for filesystem work.
 * A corrupt record is quarantined rather than interpreted as deletion input.
 */
export class WorkDurabilityStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly workspaceRoot: string;
  // Retained for the lifetime of a live execution, including its terminal /
  // rebind / successor-generation handoff.  The on-disk PID record lets a new
  // daemon recover after a crash without treating a live predecessor as stale.
  private readonly executionFences = new Map<string, WorkspaceFenceHandle>();
  private readonly supervisorIdentity = `supervisor-${randomUUID()}`;

  constructor(readonly path: string, readonly attemptsRoot: string, private readonly now: () => string = () => new Date().toISOString(), workspaceRoot = join(dirname(attemptsRoot), "worktrees"), private readonly beforeGcDelete?: (attempt: TaskWorkAttempt) => Promise<void>, private readonly git?: GitCommand) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  static mintWorkAttemptId(): string { return randomUUID(); }
  async createAttempt(input: { taskId: string; leaseId: string; leaseEpoch: number; workspacePath: string; workAttemptId: string }): Promise<TaskWorkAttempt> {
    this.assertWorkspacePath(input.workspacePath);
    if (!input.taskId.trim() || !input.leaseId.trim() || !Number.isInteger(input.leaseEpoch) || input.leaseEpoch < 0) throw new ImmutableExecutionError("Task, lease, and non-negative epoch are required.");
    const workAttemptId = input.workAttemptId;
    this.assertAttemptId(workAttemptId);
    const identity = await this.verifyProvisionedMarker(input.workspacePath, workAttemptId, input.taskId);
    await this.assertExactWorkspaceLayout(input.workspacePath, identity.repo, workAttemptId);
    const attempt = await this.mutate((stored) => {
      if (stored.attempts.some((candidate) => candidate.work_attempt_id === workAttemptId)) throw new ImmutableExecutionError("Work attempt ID already exists.");
      if (stored.attempts.some((candidate) => resolve(candidate.workspace_path) === resolve(input.workspacePath))) throw new ImmutableExecutionError("Workspace path is already bound to a work attempt.");
      const createdAt = this.now();
      const attempt: TaskWorkAttempt = {
        work_attempt_id: workAttemptId, task_id: input.taskId, lease_id: input.leaseId, current_lease_epoch: input.leaseEpoch,
        epoch_history: [{ lease_id: input.leaseId, epoch: input.leaseEpoch, recorded_at: createdAt }], workspace_path: input.workspacePath,
        workspace_identity: identity,
        state: "active", created_at: createdAt, concluded_at: null, conclusion_cause: null, postmortem_diff: null,
        checkpoints: [], execution_generations: [],
      };
      stored.attempts.push(attempt);
      return attempt;
    });
    return attempt;
  }

  async getAttempt(workAttemptId: string): Promise<TaskWorkAttempt> {
    this.assertAttemptId(workAttemptId);
    const attempt = (await this.load()).attempts.find((candidate) => candidate.work_attempt_id === workAttemptId);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
    return attempt;
  }

  async rebindAttempt(workAttemptId: string, leaseId: string, leaseEpoch: number): Promise<TaskWorkAttempt> {
    const rebound = await this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot be rebound.");
      if (!Number.isInteger(leaseEpoch) || leaseEpoch <= attempt.current_lease_epoch) throw new ImmutableExecutionError("Lease epochs must advance monotonically.");
      attempt.lease_id = leaseId;
      attempt.current_lease_epoch = leaseEpoch;
      attempt.epoch_history.push({ lease_id: leaseId, epoch: leaseEpoch, recorded_at: this.now() });
      return attempt;
    });
    // A retained supervisor-generation handle deliberately survives rebind.
    // Releasing before the successor is started would reopen the handoff race.
    return rebound;
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
    const attempt = await this.getAttempt(workAttemptId);
    await this.ensureExecutionFence(attempt);
    try { return await this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot start a generation.");
      if (!actor.trim() || !Number.isInteger(generation) || generation < 1) throw new ImmutableExecutionError("Generation actor and number are required.");
      if (attempt.execution_generations.some((item) => item.terminal === null)) throw new ImmutableExecutionError("Only one execution generation may be live.");
      const prior = attempt.execution_generations.reduce((max, item) => Math.max(max, item.generation), 0);
      if (generation <= prior) throw new ImmutableExecutionError("Execution generations must be unique and strictly monotonic.");
      const execution: ExecutionGeneration = { execution_generation_id: randomUUID(), work_attempt_id: workAttemptId, started_at: this.now(), actor, generation, terminal: null };
      attempt.execution_generations.push(execution);
      return execution;
    }); } catch (error) { await this.releaseExecutionFence(workAttemptId); throw error; }
  }

  async recordTerminal(workAttemptId: string, executionGenerationId: string, terminal: ExecutionTerminalPayload, maxStdioTailBytes = 64 * 1024): Promise<ExecutionGeneration> {
    if (!isTerminal(terminal)) throw new ImmutableExecutionError("Terminal payload has an invalid runtime schema.");
    if (!Number.isInteger(maxStdioTailBytes) || maxStdioTailBytes < 0) throw new ImmutableExecutionError("Terminal stdio limit must be a non-negative integer.");
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
        if (info.size >= maxBytes) await this.archiveWithoutClobber(logPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await appendFile(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return logPath;
    });
  }

  async concludeAttempt(workAttemptId: string, input: { state: Extract<WorkAttemptState, "cleanly_concluded" | "abandoned">; cause: string; postmortemDiff?: string; maxPostmortemBytes?: number }): Promise<TaskWorkAttempt> {
    this.assertAttemptId(workAttemptId);
    const current = await this.getAttempt(workAttemptId);
    if (input.state === "cleanly_concluded" && current.execution_generations.some((generation) => generation.terminal === null)) throw new ImmutableExecutionError("Clean conclusion requires terminal attestation for every execution generation.");
    await this.ensureExecutionFence(current);
    // A caller-supplied diff is test/backfill input only when no Git runner was
    // configured. In production the daemon capture below is authoritative.
    const postmortemDiff = this.git ? await this.capturePostmortemDiff(workAttemptId, input.maxPostmortemBytes) : input.postmortemDiff;
    if (postmortemDiff === undefined) throw new ImmutableExecutionError("Daemon Git postmortem capture is required for conclusion.");
    try { return await this.mutate((stored) => {
      const attempt = this.required(stored, workAttemptId);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("Work attempts can conclude only once.");
      if (!input.cause.trim()) throw new ImmutableExecutionError("Work attempts require an explicit conclusion cause.");
      if (input.state === "cleanly_concluded" && attempt.execution_generations.some((generation) => generation.terminal === null)) throw new ImmutableExecutionError("Clean conclusion requires terminal attestation for every execution generation.");
      attempt.state = input.state;
      attempt.concluded_at = this.now();
      attempt.conclusion_cause = input.cause;
      attempt.postmortem_diff = postmortemDiff;
      return attempt;
    }); } finally { await this.releaseExecutionFence(workAttemptId); }
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
      const retrying = stored.attempts.filter((attempt) => attempt.state === "gc_pending");
      const concluded = stored.attempts.filter((attempt) => attempt.state === "cleanly_concluded" && attempt.concluded_at && attempt.postmortem_diff !== null)
        .sort((a, b) => (b.concluded_at ?? "").localeCompare(a.concluded_at ?? ""))
        .slice(Math.max(0, keepCleanlyConcluded));
      for (const attempt of concluded) attempt.state = "gc_pending";
      return [...retrying, ...concluded].map((attempt) => ({ ...attempt }));
    });
    const removed: string[] = [];
    for (const attempt of reserved) {
      try {
        await this.beforeGcDelete?.(attempt);
        try { await lstat(attempt.workspace_path); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.finishGarbageCollection(attempt.work_attempt_id);
          removed.push(attempt.work_attempt_id);
          continue;
        }
        const fence = await acquireWorkspaceFence(attempt.workspace_path, `gc:${attempt.work_attempt_id}`, attempt.current_lease_epoch, "exclusive");
        try {
          try { await lstat(attempt.workspace_path); }
          catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await this.finishGarbageCollection(attempt.work_attempt_id);
            continue;
          }
          await this.verifyWorkspaceForDeletion(attempt);
          await rm(attempt.workspace_path, { recursive: true, force: false });
          await this.finishGarbageCollection(attempt.work_attempt_id);
        } finally { await fence.release(); }
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
    if (new Set(stored.attempts.map((attempt) => attempt.work_attempt_id)).size !== stored.attempts.length
      || new Set(stored.attempts.map((attempt) => resolve(attempt.workspace_path))).size !== stored.attempts.length) return false;
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
    await this.assertExactWorkspaceLayout(attempt.workspace_path, attempt.workspace_identity.repo, attempt.work_attempt_id, root);
    const marker = await this.verifyProvisionedMarker(attempt.workspace_path, attempt.work_attempt_id, attempt.task_id);
    if (marker.repo !== attempt.workspace_identity.repo || marker.remote_url !== attempt.workspace_identity.remote_url
      || marker.resolved_revision !== attempt.workspace_identity.resolved_revision || marker.bare_path !== attempt.workspace_identity.bare_path) {
      throw new ImmutableExecutionError("Workspace marker does not match the durable Git identity.");
    }
    await this.verifyWorkspaceGit(attempt);
  }

  private async finishGarbageCollection(workAttemptId: string): Promise<void> {
    await this.mutate((stored) => {
      const current = this.required(stored, workAttemptId);
      if (current.state === "garbage_collected") return current; // a crashed/restarted collector already completed it
      if (current.state !== "gc_pending") throw new ImmutableExecutionError("GC reservation was lost.");
      current.state = "garbage_collected";
      return current;
    });
  }

  private async verifyProvisionedMarker(workspacePath: string, workAttemptId: string, taskId: string): Promise<TaskWorkAttempt["workspace_identity"]> {
    const markerPath = join(workspacePath, WORKSPACE_MARKER);
    let markerInfo;
    try { markerInfo = await lstat(markerPath); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ImmutableExecutionError("Workspace marker is missing or unsafe.");
      throw error;
    }
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new ImmutableExecutionError("Workspace marker is missing or unsafe.");
    const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    const typed = marker as Partial<WorkspaceMarker>;
    const valid = marker && typeof marker === "object" && typed.version === 1 && typed.work_attempt_id === workAttemptId && typed.task_id === taskId
      && isSafeSegment(typed.repo) && typeof typed.remote_url === "string" && typed.remote_url.trim().length > 0
      && typeof typed.resolved_revision === "string" && /^[0-9a-f]{40,64}$/i.test(typed.resolved_revision)
      && typeof typed.bare_path === "string" && isAbsolute(typed.bare_path);
    if (!valid) throw new ImmutableExecutionError("Workspace marker does not match the durable attempt identity.");
    try { assertCredentialFreeRemote(typed.remote_url!); } catch (error) { throw new ImmutableExecutionError((error as Error).message); }
    return { repo: typed.repo!, remote_url: normalizeRemote(typed.remote_url!), resolved_revision: typed.resolved_revision!, bare_path: resolve(typed.bare_path!) };
  }

  private async assertExactWorkspaceLayout(workspacePath: string, repo: string, workAttemptId: string, root?: string): Promise<void> {
    const canonicalRoot = root ?? await this.managedRealDirectory(this.workspaceRoot, false);
    const expectedPath = resolve(canonicalRoot, repo, workAttemptId);
    if ((await realpath(workspacePath)) !== expectedPath || (await realpath(dirname(workspacePath))) === canonicalRoot) {
      throw new ImmutableExecutionError("Workspace does not use the exact daemon worktree layout.");
    }
  }

  private async verifyWorkspaceGit(attempt: TaskWorkAttempt): Promise<void> {
    if (!this.git) throw new ImmutableExecutionError("A Git identity verifier is required before garbage collection.");
    const identity = attempt.workspace_identity;
    const expectedBare = await realpath(identity.bare_path);
    const common = await this.queryGit(["-C", attempt.workspace_path, "rev-parse", "--git-common-dir"]);
    const commonPath = isAbsolute(common) ? common : resolve(attempt.workspace_path, common);
    if ((await realpath(commonPath)) !== expectedBare) throw new ImmutableExecutionError("Workspace Git common directory does not match durable identity.");
    if (normalizeRemote(await this.queryGit(["-C", attempt.workspace_path, "remote", "get-url", "origin"])) !== identity.remote_url) throw new ImmutableExecutionError("Workspace Git remote does not match durable identity.");
    const head = await this.queryGit(["-C", attempt.workspace_path, "rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== identity.resolved_revision) throw new ImmutableExecutionError("Workspace Git HEAD does not match durable identity.");
    await this.queryGit(["-C", attempt.workspace_path, "cat-file", "-e", `${head}^{commit}`]);
  }

  private async queryGit(args: string[]): Promise<string> {
    const result = await this.git?.(args);
    if (typeof result !== "string" || !result.trim()) throw new ImmutableExecutionError(`Git identity query failed: ${args.join(" ")}`);
    return result.trim();
  }

  private async capturePostmortemDiff(workAttemptId: string, maxBytes = 512 * 1024): Promise<string> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new ImmutableExecutionError("Postmortem capture limit must be a positive integer.");
    const attempt = await this.getAttempt(workAttemptId);
    if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot capture a postmortem diff.");
    await this.verifyWorkspaceForDeletion(attempt);
    const status = await this.captureGit(["-C", attempt.workspace_path, "status", "--porcelain"]);
    const diff = await this.captureGit(["-C", attempt.workspace_path, "diff", "--binary", "--no-ext-diff"]);
    const untracked = await this.captureUntrackedContents(attempt.workspace_path);
    const captured = this.limitPostmortem(`status --porcelain\n${status}\n\ndiff --binary\n${diff}\n\nuntracked contents\n${untracked}`, maxBytes);
    const root = await this.managedRealDirectory(this.attemptsRoot, true);
    const directory = join(root, workAttemptId);
    await this.ensureManagedDirectory(directory, root, true);
    const target = join(directory, "postmortem.diff");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(captured, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    return captured;
  }

  private async ensureExecutionFence(attempt: TaskWorkAttempt): Promise<void> {
    if (this.executionFences.has(attempt.work_attempt_id)) return;
    this.executionFences.set(attempt.work_attempt_id, await acquireWorkspaceFence(attempt.workspace_path, this.supervisorIdentity, attempt.current_lease_epoch, "shared"));
  }

  private async releaseExecutionFence(workAttemptId: string): Promise<void> {
    const held = this.executionFences.get(workAttemptId);
    if (!held) return;
    this.executionFences.delete(workAttemptId);
    await held.release();
  }

  private async captureGit(args: string[]): Promise<string> {
    if (!this.git) throw new ImmutableExecutionError("A Git identity verifier is required for postmortem capture.");
    const result = await this.git(args);
    if (result !== undefined && typeof result !== "string") throw new ImmutableExecutionError(`Git postmortem capture returned an invalid result: ${args.join(" ")}`);
    return result ?? "";
  }

  private async captureUntrackedContents(workspacePath: string): Promise<string> {
    const names = await this.captureGit(["-C", workspacePath, "ls-files", "--others", "--exclude-standard", "-z"]);
    const entries: string[] = [];
    for (const name of names.split("\0").filter(Boolean)) {
      const path = resolve(workspacePath, name);
      if (!isStrictChild(workspacePath, path) || !isInside(workspacePath, path)) throw new ImmutableExecutionError("Git returned an unsafe untracked path.");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new ImmutableExecutionError("Untracked postmortem input must be a regular file.");
      entries.push(`--- ${name} (base64)\n${(await readFile(path)).toString("base64")}`);
    }
    return entries.join("\n");
  }

  private limitPostmortem(value: string, maxBytes: number): string {
    const data = Buffer.from(value, "utf8");
    if (data.length <= maxBytes) return value;
    const suffix = "\n[postmortem output truncated]\n";
    return `${data.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))).toString("utf8")}${suffix}`;
  }

  private async archiveWithoutClobber(logPath: string): Promise<void> {
    for (let tries = 0; tries < 16; tries += 1) {
      const archive = `${logPath}.${randomUUID()}.archive`;
      try {
        // link() is exclusive: EEXIST proves another archive owns this name. Only then remove the old name.
        await link(logPath, archive);
        await rm(logPath, { force: false });
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new ImmutableExecutionError("Could not reserve a unique stdio archive name.");
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
