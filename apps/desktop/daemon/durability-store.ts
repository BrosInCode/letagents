import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { ExecutionGeneration, ExecutionTerminalPayload, TaskWorkAttempt, WorkAttemptCheckpoint, WorkAttemptState } from "./types.js";
import { redactCredentialText } from "./credential-redaction.js";
import { isEphemeralWorkspaceMarker } from "./ephemeral-workspace-provisioner.js";
import { assertCredentialFreeRemote, normalizeRemote, WORKSPACE_MARKER, type GitCommand, type WorkspaceMarker } from "./workspace-provisioner.js";
import { acquireWorkspaceFence, WorkspaceFenceError, type WorkspaceFenceHandle } from "./workspace-fence.js";
import { ensureDaemonStateDatabase, openDaemonStateDatabase } from "./daemon-state-database.js";

const STORE_VERSION = 2;
type StoredAttempts = { version: typeof STORE_VERSION; attempts: TaskWorkAttempt[]; checksum: string };
type LegacyStoredAttempts = { version: 1; attempts: TaskWorkAttempt[] };

export class AttemptNotFoundError extends Error {}
export class ImmutableExecutionError extends Error {}
export class CorruptAttemptStoreError extends Error {}
export type GcQuiesce = (liveAttempts: TaskWorkAttempt[]) => Promise<() => Promise<void>>;
export type SupervisorFenceIdentity = { supervisor_id: string; supervisor_generation: number };
/** Lifecycle injection points used by the supervisor integration and adversarial tests. */
export type GcQuiescenceHooks = {
  before_release?: (attempt: TaskWorkAttempt, index: number) => Promise<void>;
  before_restore?: (attempt: TaskWorkAttempt, index: number) => Promise<void>;
};
/** Adversarial-test hooks around the durable legacy-migration failure fence. */
export type LegacyAttemptMigrationHooks = {
  after_source_read?: () => Promise<void> | void;
  after_failure_recorded?: () => Promise<void> | void;
  before_quarantine?: () => Promise<void> | void;
};

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

const attemptStates = new Set<WorkAttemptState>(["active", "ambiguous", "coordination_blocked", "quarantined", "unreviewed", "cleanly_concluded", "abandoned", "gc_pending", "garbage_collected"]);

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
  if (epochs.some((epoch, index) => index > 0 && Number((epoch as { epoch: number }).epoch) <= Number((epochs[index - 1] as { epoch: number }).epoch))) return false;
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
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private closed = false;
  private readonly databasePath: string;

  constructor(readonly path: string, readonly attemptsRoot: string, private readonly now: () => string = () => new Date().toISOString(), workspaceRoot = join(dirname(attemptsRoot), "worktrees"), private readonly beforeGcDelete?: (attempt: TaskWorkAttempt) => Promise<void>, private readonly git?: GitCommand, private readonly quiesceForGc?: GcQuiesce, private supervisorFence?: SupervisorFenceIdentity, private readonly quiescenceHooks?: GcQuiescenceHooks, databasePath?: string, private readonly migrationHooks?: LegacyAttemptMigrationHooks) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.databasePath = databasePath ?? join(dirname(path), "daemon-state.sqlite");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    await this.initializing?.catch(() => undefined);
    const database = this.database;
    this.database = null;
    this.initializing = null;
    database?.close();
  }

  /** Bind the store to the P1a fence after the singleton generation is acquired. */
  bindSupervisorFence(identity: SupervisorFenceIdentity): void {
    if (this.executionFences.size > 0) throw new ImmutableExecutionError("Cannot replace the supervisor fence while executions are live.");
    this.supervisorFence = identity;
  }

  static mintWorkAttemptId(): string { return randomUUID(); }
  async createAttempt(input: { taskId: string; leaseId: string; leaseEpoch: number; workspacePath: string; workAttemptId: string }): Promise<TaskWorkAttempt> {
    this.assertWorkspacePath(input.workspacePath);
    if (!input.taskId.trim() || !input.leaseId.trim() || !Number.isInteger(input.leaseEpoch) || input.leaseEpoch < 0) throw new ImmutableExecutionError("Task, lease, and non-negative epoch are required.");
    const workAttemptId = input.workAttemptId;
    this.assertAttemptId(workAttemptId);
    const identity = await this.verifyProvisionedMarker(input.workspacePath, workAttemptId, input.taskId);
    await this.assertExactWorkspaceLayout(input.workspacePath, identity.repo, workAttemptId);
    const attempt = await this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
      if (database.prepare("SELECT 1 FROM work_attempts WHERE work_attempt_id = ?").get(workAttemptId)) throw new ImmutableExecutionError("Work attempt ID already exists.");
      if (database.prepare("SELECT 1 FROM work_attempts WHERE workspace_path = ?").get(resolve(input.workspacePath))) throw new ImmutableExecutionError("Workspace path is already bound to a work attempt.");
      const createdAt = this.now();
      const attempt: TaskWorkAttempt = {
        work_attempt_id: workAttemptId, task_id: input.taskId, lease_id: input.leaseId, current_lease_epoch: input.leaseEpoch,
        epoch_history: [{ lease_id: input.leaseId, epoch: input.leaseEpoch, recorded_at: createdAt }], workspace_path: input.workspacePath,
        workspace_identity: identity,
        state: "active", created_at: createdAt, concluded_at: null, conclusion_cause: null, postmortem_diff: null,
        checkpoints: [], execution_generations: [],
      };
      this.persistAttempt(database, attempt);
      database.exec("COMMIT");
      return attempt;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
    return attempt;
  }

  async getAttempt(workAttemptId: string): Promise<TaskWorkAttempt> {
    this.assertAttemptId(workAttemptId);
    const database = await this.getDatabase();
    const attempt = this.readAttempt(database, workAttemptId);
    if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
    return attempt;
  }

  async listAttempts(): Promise<TaskWorkAttempt[]> {
    return (await this.load()).attempts;
  }

  async rebindAttempt(workAttemptId: string, leaseId: string, leaseEpoch: number): Promise<TaskWorkAttempt> {
    return this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
      const attempt = this.readAttempt(database, workAttemptId);
      if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot be rebound.");
      if (!Number.isInteger(leaseEpoch) || leaseEpoch <= attempt.current_lease_epoch) throw new ImmutableExecutionError("Lease epochs must advance monotonically.");
      const recordedAt = this.now();
      database.prepare("UPDATE work_attempts SET lease_id = ?, current_lease_epoch = ? WHERE work_attempt_id = ?").run(leaseId, leaseEpoch, workAttemptId);
      database.prepare("INSERT INTO work_attempt_lease_epochs VALUES (?, ?, ?, ?, ?)").run(workAttemptId, attempt.epoch_history.length, leaseId, leaseEpoch, recordedAt);
      const rebound = this.readAttempt(database, workAttemptId)!;
      database.exec("COMMIT");
      return rebound;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async checkpoint(workAttemptId: string, checkpoint: Omit<WorkAttemptCheckpoint, "at"> & { at?: string }): Promise<TaskWorkAttempt> {
    return this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
      const attempt = this.readAttempt(database, workAttemptId);
      if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot be checkpointed.");
      database.prepare("INSERT INTO work_attempt_checkpoints VALUES (?, ?, ?, ?, ?)").run(workAttemptId, attempt.checkpoints.length, checkpoint.at ?? this.now(), checkpoint.room_cursor, checkpoint.provider_continuation_id);
      const updated = this.readAttempt(database, workAttemptId)!;
      database.exec("COMMIT");
      return updated;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async startGeneration(workAttemptId: string, actor: string, generation: number): Promise<ExecutionGeneration> {
    const attempt = await this.getAttempt(workAttemptId);
    await this.ensureExecutionFence(attempt);
    try { return await this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
      const attempt = this.readAttempt(database, workAttemptId);
      if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("A non-live work attempt cannot start a generation.");
      if (!actor.trim() || !Number.isInteger(generation) || generation < 1) throw new ImmutableExecutionError("Generation actor and number are required.");
      if (attempt.execution_generations.some((item) => item.terminal === null)) throw new ImmutableExecutionError("Only one execution generation may be live.");
      const prior = attempt.execution_generations.reduce((max, item) => Math.max(max, item.generation), 0);
      if (generation <= prior) throw new ImmutableExecutionError("Execution generations must be unique and strictly monotonic.");
      const execution: ExecutionGeneration = { execution_generation_id: randomUUID(), work_attempt_id: workAttemptId, started_at: this.now(), actor, generation, terminal: null };
      database.prepare("INSERT INTO work_attempt_executions VALUES (?, ?, ?, ?, ?, NULL)").run(execution.execution_generation_id, workAttemptId, execution.started_at, actor, generation);
      database.exec("COMMIT");
      return execution;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    }); } catch (error) { await this.releaseExecutionFence(workAttemptId); throw error; }
  }

  /**
   * Re-establish the current supervisor generation's shared workspace fence
   * when a replacement daemon attaches to an already-live provider. The
   * execution generation remains the same; only filesystem authority moves
   * to the replacement supervisor process.
   */
  async recoverExecutionFence(workAttemptId: string): Promise<void> {
    const attempt = await this.getAttempt(workAttemptId);
    if (!attempt.execution_generations.some((generation) => generation.terminal === null)) {
      throw new ImmutableExecutionError("Only a live execution generation can recover its workspace fence.");
    }
    await this.ensureExecutionFence(attempt);
  }

  async recordTerminal(workAttemptId: string, executionGenerationId: string, terminal: ExecutionTerminalPayload, maxStdioTailBytes = 64 * 1024): Promise<ExecutionGeneration> {
    if (!isTerminal(terminal)) throw new ImmutableExecutionError("Terminal payload has an invalid runtime schema.");
    if (!Number.isInteger(maxStdioTailBytes) || maxStdioTailBytes < 0) throw new ImmutableExecutionError("Terminal stdio limit must be a non-negative integer.");
    return this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
      const attempt = this.readAttempt(database, workAttemptId);
      if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
      const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
      if (!execution) throw new AttemptNotFoundError(`Unknown execution generation: ${executionGenerationId}`);
      if (execution.terminal) throw new ImmutableExecutionError("Execution terminal payloads are append-only and immutable.");
      if (terminal.generation !== execution.generation || terminal.actor !== execution.actor) throw new ImmutableExecutionError("Terminal identity must match its execution record.");
      if (!terminal.terminal_cause.trim() || !isIsoTime(terminal.ended_at) || Date.parse(terminal.ended_at) < Date.parse(execution.started_at)) {
        throw new ImmutableExecutionError("Terminal cause and a non-regressing end time are required.");
      }
      const redacted: ExecutionTerminalPayload = {
        ...terminal,
        stdio_archive_ref: terminal.stdio_archive_ref === null ? null : redactCredentialText(terminal.stdio_archive_ref).value,
        stdio_tail: Buffer.from(redactCredentialText(terminal.stdio_tail, Number.MAX_SAFE_INTEGER).value).subarray(-maxStdioTailBytes).toString("utf8"),
        terminal_cause: redactCredentialText(terminal.terminal_cause).value,
        actor: redactCredentialText(terminal.actor).value,
        provider_continuation_id: terminal.provider_continuation_id === null ? null : redactCredentialText(terminal.provider_continuation_id).value,
      };
      const updated = database.prepare("UPDATE work_attempt_executions SET terminal_json = ? WHERE execution_generation_id = ? AND work_attempt_id = ? AND terminal_json IS NULL").run(JSON.stringify(redacted), executionGenerationId, workAttemptId);
      if (Number(updated.changes) !== 1) throw new ImmutableExecutionError("Execution terminal payloads are append-only and immutable.");
      database.exec("COMMIT");
      return { ...execution, terminal: redacted };
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  /**
   * Drop retained workspace authority only after the caller has proved the
   * exact generation terminal and knows no provider process can still write.
   * Failed launches and an intentional desired=stopped terminal use this path;
   * pause/resume and reattachable successor handoffs deliberately retain it.
   */
  async releaseTerminalExecutionFence(workAttemptId: string, executionGenerationId: string): Promise<void> {
    const attempt = await this.getAttempt(workAttemptId);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
    if (!execution?.terminal) throw new ImmutableExecutionError("An execution fence can be released only after durable terminal attestation.");
    if (attempt.execution_generations.some((candidate) => candidate.terminal === null)) {
      throw new ImmutableExecutionError("An execution fence cannot be released while another execution generation is live.");
    }
    await this.releaseExecutionFence(workAttemptId);
  }

  async appendStdio(workAttemptId: string, line: string, maxBytes = 1024 * 1024): Promise<string> {
    this.assertAttemptId(workAttemptId);
    return this.exclusive(async () => {
      await this.getAttempt(workAttemptId);
      line = redactCredentialText(line, Number.MAX_SAFE_INTEGER).value;
      const root = await this.managedRealDirectory(this.attemptsRoot, true);
      const directory = join(root, workAttemptId);
      await this.ensureManagedDirectory(directory, root, true);
      const logPath = join(directory, "stdio.log");
      let followsCredentialPrefix = false;
      try {
        const info = await lstat(logPath);
        if (info.isSymbolicLink() || !info.isFile()) throw new ImmutableExecutionError("Stdio log must be a regular daemon-owned file.");
        const tail = (await readFile(logPath, "utf8")).slice(-512);
        followsCredentialPrefix = /(?:authorization|proxy[_-]?authorization)\s*[:=]\s*(?:bearer|basic)?\s*$|(?:cookie|credential|password|secret|api[_-]?key|(?:[a-z0-9_.-]*[_-])?token)\s*[:=]\s*$/i.test(tail);
        if (info.size >= maxBytes) await this.archiveWithoutClobber(logPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (followsCredentialPrefix && line.trim()) line = "[REDACTED]";
      await appendFile(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      return logPath;
    });
  }

  async concludeAttempt(workAttemptId: string, input: { state: Extract<WorkAttemptState, "cleanly_concluded" | "abandoned">; cause: string; postmortemDiff?: string; maxPostmortemBytes?: number }): Promise<TaskWorkAttempt> {
    this.assertAttemptId(workAttemptId);
    const current = await this.getAttempt(workAttemptId);
    if (current.execution_generations.some((generation) => generation.terminal === null)) {
      throw new ImmutableExecutionError("Concluding an attempt requires terminal attestation for every execution generation.");
    }
    await this.ensureExecutionFence(current);
    try {
      // A caller-supplied diff is test/backfill input only when no Git runner
      // was configured. In production the daemon capture below is authoritative.
      const postmortemDiff = this.git ? await this.capturePostmortemDiff(workAttemptId, input.maxPostmortemBytes) : input.postmortemDiff;
      if (postmortemDiff === undefined) throw new ImmutableExecutionError("Daemon Git postmortem capture is required for conclusion.");
      return await this.mutateAttempt(workAttemptId, (attempt) => {
      if (attempt.concluded_at || attempt.state === "gc_pending" || attempt.state === "garbage_collected") throw new ImmutableExecutionError("Work attempts can conclude only once.");
      if (!input.cause.trim()) throw new ImmutableExecutionError("Work attempts require an explicit conclusion cause.");
      if (attempt.execution_generations.some((generation) => generation.terminal === null)) throw new ImmutableExecutionError("Concluding an attempt requires terminal attestation for every execution generation.");
      attempt.state = input.state;
      attempt.concluded_at = this.now();
      attempt.conclusion_cause = input.cause;
      attempt.postmortem_diff = postmortemDiff;
      return attempt;
      });
    } finally { await this.releaseExecutionFence(workAttemptId); }
  }

  async markState(workAttemptId: string, state: Extract<WorkAttemptState, "ambiguous" | "coordination_blocked" | "quarantined" | "unreviewed">): Promise<TaskWorkAttempt> {
    return this.mutateAttempt(workAttemptId, (attempt) => {
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
        const collected = await this.collectReservedAttempt(attempt);
        if (collected) removed.push(attempt.work_attempt_id);
      } catch (error) {
        console.error(`Refusing to garbage collect work attempt ${attempt.work_attempt_id}:`, error);
        // A live fence/quiescence is temporary backpressure, not evidence that
        // the durable record is unsafe. Keep the reservation for a later
        // bounded retry; integrity/identity failures still become unreviewed.
        if (error instanceof WorkspaceFenceError) continue;
        await this.mutate((stored) => { const current = this.required(stored, attempt.work_attempt_id); if (current.state === "gc_pending") current.state = "unreviewed"; return current; });
      }
    }
    return removed;
  }

  /** Delete one concluded room-only attempt without collecting unrelated repositories. */
  async garbageCollectEphemeralAttempt(workAttemptId: string): Promise<boolean> {
    this.assertAttemptId(workAttemptId);
    const reserved = await this.mutateAttempt(workAttemptId, (attempt) => {
      if (!isEphemeralWorkspaceMarker(attempt.workspace_identity)) {
        throw new ImmutableExecutionError("Targeted room-only GC requires an ephemeral workspace identity.");
      }
      if (attempt.state === "garbage_collected") return { ...attempt };
      if (attempt.state !== "gc_pending") {
        if (!attempt.concluded_at
          || !["cleanly_concluded", "abandoned"].includes(attempt.state)
          || attempt.postmortem_diff === null) {
          throw new ImmutableExecutionError("Targeted room-only GC requires a concluded attempt with a postmortem.");
        }
        attempt.state = "gc_pending";
      }
      return { ...attempt };
    });
    if (reserved.state === "garbage_collected") return true;
    try {
      return await this.collectReservedAttempt(reserved);
    } catch (error) {
      if (!(error instanceof WorkspaceFenceError)) {
        await this.mutateAttempt(workAttemptId, (attempt) => {
          if (attempt.state === "gc_pending") attempt.state = "unreviewed";
          return attempt;
        });
      }
      throw error;
    }
  }

  private async load(): Promise<StoredAttempts> {
    const database = await this.getDatabase();
    return this.loadFromDatabase(database);
  }

  private async collectReservedAttempt(attempt: TaskWorkAttempt): Promise<boolean> {
    await this.beforeGcDelete?.(attempt);
    try { await lstat(attempt.workspace_path); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.finishGarbageCollection(attempt.work_attempt_id);
      return true;
    }
    const collect = async () => {
      const fence = await acquireWorkspaceFence(
        attempt.workspace_path,
        `gc:${attempt.work_attempt_id}`,
        attempt.current_lease_epoch,
        "exclusive",
      );
      try {
        try { await lstat(attempt.workspace_path); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.finishGarbageCollection(attempt.work_attempt_id);
          return true;
        }
        await this.verifyWorkspaceForDeletion(attempt);
        await rm(attempt.workspace_path, { recursive: true, force: false });
        await this.finishGarbageCollection(attempt.work_attempt_id);
        return true;
      } finally { await fence.release(); }
    };
    // Room-only attempts never share Git metadata, so unrelated rental
    // workspaces do not need to be quiesced to delete this exact directory.
    return isEphemeralWorkspaceMarker(attempt.workspace_identity)
      ? collect()
      : this.withRepositoryGcQuiescence(attempt, collect);
  }

  private loadFromDatabase(database: DatabaseSync): StoredAttempts {
    const attempts = (database.prepare("SELECT * FROM work_attempts ORDER BY created_at, work_attempt_id").all() as Record<string, unknown>[]).map((row): TaskWorkAttempt => {
      const workAttemptId = String(row.work_attempt_id);
      const epoch_history = (database.prepare("SELECT lease_id, epoch, recorded_at FROM work_attempt_lease_epochs WHERE work_attempt_id = ? ORDER BY sort_order").all(workAttemptId) as Record<string, unknown>[])
        .map((epoch) => ({ lease_id: String(epoch.lease_id), epoch: Number(epoch.epoch), recorded_at: String(epoch.recorded_at) }));
      const checkpoints = (database.prepare("SELECT at, room_cursor, provider_continuation_id FROM work_attempt_checkpoints WHERE work_attempt_id = ? ORDER BY sort_order").all(workAttemptId) as Record<string, unknown>[])
        .map((checkpoint) => ({ at: String(checkpoint.at), room_cursor: checkpoint.room_cursor === null ? null : String(checkpoint.room_cursor), provider_continuation_id: checkpoint.provider_continuation_id === null ? null : String(checkpoint.provider_continuation_id) }));
      const execution_generations = (database.prepare("SELECT * FROM work_attempt_executions WHERE work_attempt_id = ? ORDER BY generation").all(workAttemptId) as Record<string, unknown>[])
        .map((execution): ExecutionGeneration => ({ execution_generation_id: String(execution.execution_generation_id), work_attempt_id: workAttemptId, started_at: String(execution.started_at), actor: String(execution.actor), generation: Number(execution.generation), terminal: execution.terminal_json === null ? null : JSON.parse(String(execution.terminal_json)) as ExecutionTerminalPayload }));
      return {
        work_attempt_id: workAttemptId, task_id: String(row.task_id), lease_id: String(row.lease_id), current_lease_epoch: Number(row.current_lease_epoch),
        epoch_history, workspace_path: String(row.workspace_path),
        workspace_identity: { repo: String(row.workspace_repo), remote_url: String(row.workspace_remote_url), resolved_revision: String(row.workspace_resolved_revision), bare_path: String(row.workspace_bare_path) },
        state: String(row.state) as WorkAttemptState, created_at: String(row.created_at), concluded_at: row.concluded_at === null ? null : String(row.concluded_at),
        conclusion_cause: row.conclusion_cause === null ? null : String(row.conclusion_cause), postmortem_diff: row.postmortem_diff === null ? null : String(row.postmortem_diff), checkpoints, execution_generations,
      };
    });
    const stored = { version: STORE_VERSION, attempts, checksum: checksum(attempts) } as StoredAttempts;
    if (!attempts.every(isAttempt)) throw new CorruptAttemptStoreError("SQLite work attempt state has an invalid schema.");
    return stored;
  }

  private async importLegacyAttempts(database: DatabaseSync): Promise<void> {
    const migrationKey = `attempts-json:${resolve(this.path)}`;
    type LegacySource = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "valid"; attempts: TaskWorkAttempt[]; checksum: string };
    let source: LegacySource;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (this.validLegacy(parsed)) {
        // A v1 file predates integrity protection. Preserve live/recoverable
        // attempts, but never inherit a legacy clean conclusion as GC authority.
        source = {
          kind: "valid",
          attempts: parsed.attempts.map((attempt) => (attempt.state === "cleanly_concluded" || attempt.state === "abandoned" ? { ...attempt, state: "unreviewed" } : attempt)),
          checksum: checksum(parsed.attempts),
        };
      } else if (this.valid(parsed)) {
        source = { kind: "valid", attempts: parsed.attempts, checksum: parsed.checksum };
      } else {
        source = { kind: "invalid", reason: "Attempt store has an invalid schema or integrity checksum." };
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") source = { kind: "missing" };
      else source = { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
    }

    await this.migrationHooks?.after_source_read?.();
    type MigrationOutcome = { kind: "success" } | { kind: "previous_failure"; reason: string; quarantinedPath: string } | { kind: "new_failure"; reason: string; quarantinedPath: string };
    let outcome: MigrationOutcome = { kind: "success" };
    database.exec("BEGIN IMMEDIATE");
    try {
      // Both decisions are authoritative only while holding the writer lock.
      // A concurrent winner may have committed between our source read and
      // this point, in which case a matching checksum is an idempotent no-op.
      const priorFailure = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key = ?").get(migrationKey) as { reason: string; quarantined_path: string } | undefined;
      if (priorFailure) {
        outcome = { kind: "previous_failure", reason: priorFailure.reason, quarantinedPath: priorFailure.quarantined_path };
      } else {
        const existing = database.prepare("SELECT checksum FROM migration_records WHERE migration_key = ?").get(migrationKey) as { checksum?: unknown } | undefined;
        let failureReason: string | undefined;
        if (source.kind === "invalid") failureReason = source.reason;
        else if (existing && source.kind === "valid" && String(existing.checksum) !== source.checksum) failureReason = "Legacy attempts source changed after it was migrated.";
        else if (!existing && source.kind === "valid") {
          database.exec("SAVEPOINT legacy_attempt_import");
          try {
            for (const attempt of source.attempts) this.persistAttempt(database, attempt, true);
            database.prepare("INSERT INTO migration_records(migration_key, checksum, imported_at) VALUES (?, ?, ?)").run(migrationKey, source.checksum, this.now());
            database.exec("RELEASE legacy_attempt_import");
          } catch (error: unknown) {
            database.exec("ROLLBACK TO legacy_attempt_import");
            database.exec("RELEASE legacy_attempt_import");
            failureReason = error instanceof Error ? error.message : String(error);
          }
        }
        if (failureReason) {
          const quarantinedPath = `${this.path}.corrupt.${Date.now()}.${randomUUID()}`;
          database.prepare("INSERT INTO migration_failures(migration_key, reason, failed_at, quarantined_path) VALUES (?, ?, ?, ?)").run(migrationKey, failureReason, this.now(), quarantinedPath);
          outcome = { kind: "new_failure", reason: failureReason, quarantinedPath };
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    if (outcome.kind !== "success") {
      if (outcome.kind === "new_failure") await this.migrationHooks?.after_failure_recorded?.();
      await this.quarantineLegacySource(outcome.quarantinedPath);
      if (outcome.kind === "previous_failure") {
        throw new CorruptAttemptStoreError(`Legacy attempt migration previously failed: ${outcome.reason} (${outcome.quarantinedPath})`);
      }
      throw new CorruptAttemptStoreError(`Legacy attempt migration failed closed: ${outcome.reason}`);
    }

    if (source.kind === "valid") {
      try { await rename(this.path, `${this.path}.migrated-backup`); }
      catch (error: unknown) {
        // The SQLite transaction is already authoritative. Backup retention is
        // idempotent housekeeping and is retried on the next open.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Unable to retain migrated attempt JSON backup ${this.path}:`, error);
      }
    }
  }

  private async quarantineLegacySource(quarantinedPath: string): Promise<void> {
    try {
      await this.migrationHooks?.before_quarantine?.();
      await rename(this.path, quarantinedPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A durable migration_failures row already blocks every reopen. Keep
        // quarantine as retryable, non-authoritative housekeeping.
        console.error(`Unable to quarantine failed attempt JSON ${this.path}:`, error);
      }
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

  private async mutate<T>(operation: (stored: StoredAttempts) => T): Promise<T> {
    return this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const stored = this.loadFromDatabase(database);
        const before = new Map(stored.attempts.map((attempt) => [attempt.work_attempt_id, JSON.stringify(attempt)]));
        const result = operation(stored);
        for (const attempt of stored.attempts) {
          if (before.get(attempt.work_attempt_id) !== JSON.stringify(attempt)) this.persistAttempt(database, attempt);
        }
        database.exec("COMMIT");
        return result;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  /** Hot-path mutation: one attempt and its children, never a database-wide scan. */
  private async mutateAttempt<T>(workAttemptId: string, operation: (attempt: TaskWorkAttempt) => T): Promise<T> {
    return this.exclusive(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const attempt = this.readAttempt(database, workAttemptId);
        if (!attempt) throw new AttemptNotFoundError(`Unknown work attempt: ${workAttemptId}`);
        const result = operation(attempt);
        this.persistAttempt(database, attempt);
        database.exec("COMMIT");
        return result;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
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
    await this.mutateAttempt(workAttemptId, (current) => {
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
    if (isEphemeralWorkspaceMarker(attempt.workspace_identity)) {
      if ((await realpath(attempt.workspace_path)) !== await realpath(attempt.workspace_identity.bare_path)) {
        throw new ImmutableExecutionError("Ephemeral workspace identity does not match its canonical directory.");
      }
      return;
    }
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
    const ephemeral = isEphemeralWorkspaceMarker(attempt.workspace_identity);
    const status = ephemeral ? "non-Git ephemeral workspace" : await this.captureGit(["-C", attempt.workspace_path, "status", "--porcelain"]);
    const diff = ephemeral ? "not applicable" : await this.captureGit(["-C", attempt.workspace_path, "diff", "--binary", "--no-ext-diff"]);
    // Room-only workspaces intentionally have no Git index from which to
    // derive a trustworthy untracked-file set. Their durable output is the
    // visible room transcript; teardown must not pretend the cwd is a repo.
    const untracked = ephemeral
      ? "not captured for room-only workspace"
      : await this.captureUntrackedContents(attempt.workspace_path);
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
    if (!this.supervisorFence || !this.supervisorFence.supervisor_id.trim() || !Number.isSafeInteger(this.supervisorFence.supervisor_generation) || this.supervisorFence.supervisor_generation < 1) {
      throw new ImmutableExecutionError("A monotonic P1a supervisor identity and generation are required for execution fencing.");
    }
    this.executionFences.set(attempt.work_attempt_id, await acquireWorkspaceFence(attempt.workspace_path, this.supervisorFence.supervisor_id, this.supervisorFence.supervisor_generation, "shared"));
  }

  private async releaseExecutionFence(workAttemptId: string): Promise<void> {
    const held = this.executionFences.get(workAttemptId);
    if (!held) return;
    this.executionFences.delete(workAttemptId);
    await held.release();
  }

  /**
   * GC may need exclusive repository authority while unrelated attempts are
   * still executing. The supervisor callback first checkpoints/pauses their
   * filesystem activity (not the process or its room work), then this method
   * drops only those retained shared records, collects, restores them, and
   * resumes the generations. Without that explicit acknowledgement we fail
   * closed rather than make a long-lived agent silently unsafe or starve GC.
   */
  private async withRepositoryGcQuiescence<T>(candidate: TaskWorkAttempt, operation: () => Promise<T>): Promise<T> {
    const repository = dirname(candidate.workspace_path);
    const held = [...this.executionFences.entries()].filter(([, fence]) => fence.mode === "shared" && dirname(fence.workspacePath) === repository);
    if (held.length === 0) return operation();
    if (!this.quiesceForGc) throw new WorkspaceFenceError("Live repository generations require a supervisor quiescence acknowledgement before GC.");
    const attempts = await Promise.all(held.map(([id]) => this.getAttempt(id)));
    const resume = await this.quiesceForGc(attempts);
    let restored = false;
    try {
      for (const [index, [id, fence]] of held.entries()) {
        await this.quiescenceHooks?.before_release?.(attempts[index]!, index);
        await fence.release();
        this.executionFences.delete(id);
      }
      try { return await operation(); }
      finally {
        for (const [index, attempt] of attempts.entries()) {
          await this.quiescenceHooks?.before_restore?.(attempt, index);
          await this.ensureExecutionFence(await this.getAttempt(attempt.work_attempt_id));
        }
        restored = true;
      }
    } catch (error) {
      await this.blockQuiescedAttempts(attempts);
      throw error;
    } finally {
      // Never resume a process unless every original retained handle has been
      // restored. A partial failure remains coordination-blocked for P1d.
      if (restored) {
        try { await resume(); }
        catch (error) { await this.blockQuiescedAttempts(attempts); throw error; }
      }
    }
  }

  private async blockQuiescedAttempts(attempts: TaskWorkAttempt[]): Promise<void> {
    await this.mutate((stored) => {
      for (const attempt of attempts) {
        const current = this.required(stored, attempt.work_attempt_id);
        if (current.state === "active") current.state = "coordination_blocked";
      }
      return stored;
    });
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

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("WorkDurabilityStore is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = this.initializeDatabase();
    return this.initializing;
  }

  private async initializeDatabase(): Promise<DatabaseSync> {
    // The neutral state-schema owner serializes all daemon-state upgrades.
    await ensureDaemonStateDatabase(this.databasePath);
    let database: DatabaseSync | null = null;
    try {
      database = await openDaemonStateDatabase(this.databasePath, () => {});
      await this.importLegacyAttempts(database);
      this.database = database;
      return database;
    } catch (error) { if (this.database === database) this.database = null; database?.close(); this.initializing = null; throw error; }
  }

  private readAttempt(database: DatabaseSync, id: string): TaskWorkAttempt | undefined {
    const row = database.prepare("SELECT * FROM work_attempts WHERE work_attempt_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const workAttemptId = String(row.work_attempt_id);
    const epoch_history = (database.prepare("SELECT lease_id, epoch, recorded_at FROM work_attempt_lease_epochs WHERE work_attempt_id = ? ORDER BY sort_order").all(workAttemptId) as Record<string, unknown>[])
      .map((epoch) => ({ lease_id: String(epoch.lease_id), epoch: Number(epoch.epoch), recorded_at: String(epoch.recorded_at) }));
    const checkpoints = (database.prepare("SELECT at, room_cursor, provider_continuation_id FROM work_attempt_checkpoints WHERE work_attempt_id = ? ORDER BY sort_order").all(workAttemptId) as Record<string, unknown>[])
      .map((checkpoint) => ({ at: String(checkpoint.at), room_cursor: checkpoint.room_cursor === null ? null : String(checkpoint.room_cursor), provider_continuation_id: checkpoint.provider_continuation_id === null ? null : String(checkpoint.provider_continuation_id) }));
    const execution_generations = (database.prepare("SELECT * FROM work_attempt_executions WHERE work_attempt_id = ? ORDER BY generation").all(workAttemptId) as Record<string, unknown>[])
      .map((execution): ExecutionGeneration => ({ execution_generation_id: String(execution.execution_generation_id), work_attempt_id: workAttemptId, started_at: String(execution.started_at), actor: String(execution.actor), generation: Number(execution.generation), terminal: execution.terminal_json === null ? null : JSON.parse(String(execution.terminal_json)) as ExecutionTerminalPayload }));
    const attempt: TaskWorkAttempt = { work_attempt_id: workAttemptId, task_id: String(row.task_id), lease_id: String(row.lease_id), current_lease_epoch: Number(row.current_lease_epoch), epoch_history,
      workspace_path: String(row.workspace_path), workspace_identity: { repo: String(row.workspace_repo), remote_url: String(row.workspace_remote_url), resolved_revision: String(row.workspace_resolved_revision), bare_path: String(row.workspace_bare_path) },
      state: String(row.state) as WorkAttemptState, created_at: String(row.created_at), concluded_at: row.concluded_at === null ? null : String(row.concluded_at), conclusion_cause: row.conclusion_cause === null ? null : String(row.conclusion_cause), postmortem_diff: row.postmortem_diff === null ? null : String(row.postmortem_diff), checkpoints, execution_generations };
    if (!isAttempt(attempt)) throw new CorruptAttemptStoreError(`SQLite work attempt ${id} has an invalid durable shape.`);
    return attempt;
  }

  private persistAttempt(database: DatabaseSync, attempt: TaskWorkAttempt, importOnly = false): void {
    if (!isAttempt(attempt)) throw new CorruptAttemptStoreError("Refusing to persist an invalid work attempt.");
    const exists = database.prepare("SELECT 1 FROM work_attempts WHERE work_attempt_id = ?").get(attempt.work_attempt_id);
    if (importOnly && exists) throw new ImmutableExecutionError(`Duplicate legacy work attempt: ${attempt.work_attempt_id}`);
    if (importOnly) {
      const workspace = database.prepare("SELECT work_attempt_id FROM work_attempts WHERE workspace_path = ?").get(resolve(attempt.workspace_path)) as { work_attempt_id?: unknown } | undefined;
      if (workspace) throw new ImmutableExecutionError(`Duplicate legacy workspace: ${attempt.workspace_path}`);
    }
    database.prepare(`INSERT INTO work_attempts(
      work_attempt_id, task_id, lease_id, current_lease_epoch, workspace_path,
      workspace_repo, workspace_remote_url, workspace_resolved_revision, workspace_bare_path,
      state, created_at, concluded_at, conclusion_cause, postmortem_diff
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_attempt_id) DO UPDATE SET task_id=excluded.task_id, lease_id=excluded.lease_id,
      current_lease_epoch=excluded.current_lease_epoch, workspace_path=excluded.workspace_path,
      workspace_repo=excluded.workspace_repo, workspace_remote_url=excluded.workspace_remote_url,
      workspace_resolved_revision=excluded.workspace_resolved_revision, workspace_bare_path=excluded.workspace_bare_path,
      state=excluded.state, created_at=excluded.created_at, concluded_at=excluded.concluded_at,
      conclusion_cause=excluded.conclusion_cause, postmortem_diff=excluded.postmortem_diff
    `).run(attempt.work_attempt_id, attempt.task_id, attempt.lease_id, attempt.current_lease_epoch, resolve(attempt.workspace_path), attempt.workspace_identity.repo, attempt.workspace_identity.remote_url, attempt.workspace_identity.resolved_revision, attempt.workspace_identity.bare_path, attempt.state, attempt.created_at, attempt.concluded_at, attempt.conclusion_cause, attempt.postmortem_diff);
    database.prepare("DELETE FROM work_attempt_lease_epochs WHERE work_attempt_id = ?").run(attempt.work_attempt_id);
    database.prepare("DELETE FROM work_attempt_checkpoints WHERE work_attempt_id = ?").run(attempt.work_attempt_id);
    database.prepare("DELETE FROM work_attempt_executions WHERE work_attempt_id = ?").run(attempt.work_attempt_id);
    const epoch = database.prepare("INSERT INTO work_attempt_lease_epochs VALUES (?, ?, ?, ?, ?)");
    attempt.epoch_history.forEach((item, index) => epoch.run(attempt.work_attempt_id, index, item.lease_id, item.epoch, item.recorded_at));
    const checkpoint = database.prepare("INSERT INTO work_attempt_checkpoints VALUES (?, ?, ?, ?, ?)");
    attempt.checkpoints.forEach((item, index) => checkpoint.run(attempt.work_attempt_id, index, item.at, item.room_cursor, item.provider_continuation_id));
    const execution = database.prepare("INSERT INTO work_attempt_executions VALUES (?, ?, ?, ?, ?, ?)");
    attempt.execution_generations.forEach((item) => execution.run(item.execution_generation_id, attempt.work_attempt_id, item.started_at, item.actor, item.generation, item.terminal === null ? null : JSON.stringify(item.terminal)));
  }

  private async write(stored: StoredAttempts): Promise<void> {
    const database = await this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try { for (const attempt of stored.attempts) this.persistAttempt(database, attempt); database.exec("COMMIT"); }
    catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }
}
