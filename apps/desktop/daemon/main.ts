import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import type { ProviderActionAttachTerminal, ProviderActionHandle, ProviderActionPort, ProviderActionRef, ProviderActionStreamEvent, ProviderActionTerminal, ProviderTurnControlResult } from "./provider-action-port.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState, beginReconciliationAction, completeReconciliationAction, recordReconciliationActionFailure, rememberCompletedControlAction } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { DAEMON_IMPLEMENTATION_VERSION, DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DesiredState, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";

type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath">>;
type LiveBindingIdentity = { agentSessionId: string; executionGenerationId: string; updatedAt: string };
type PendingResumeBinding = {
  roomId: string;
  workAttemptId: string;
  predecessorExecutionGenerationId: string;
  successorExecutionGenerationId: string;
  agentSessionId: string;
  providerContinuationId: string;
};
type SupervisedWaitEvidence = { roomCursor: string; agentSessionId: string };
type RecoveryClock = {
  nowMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};
type DaemonTurnControlResult = ProviderTurnControlResult & {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  duplicate: boolean;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
};

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

class ReplacementListenerInstallError extends Error {}

function providerStreamLifecycle(event: ProviderActionStreamEvent): "failed" | "terminal" | "idle" | "working" {
  const method = event.method.trim();
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  const nestedStatus = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
    const record = value as Record<string, unknown>;
    return [value, record.type, record.status];
  };
  const statuses = [
    payload.status,
    payload.subtype,
    payload.threadStatus,
    payload.turnStatus,
    (payload.thread as Record<string, unknown> | undefined)?.status,
    (payload.turn as Record<string, unknown> | undefined)?.status,
    (payload.latestTurn as Record<string, unknown> | undefined)?.status,
  ].flatMap(nestedStatus);
  const failedStatus = statuses.some((value) => typeof value === "string" && /^(?:systemError|error|error_during_execution|failed)$/i.test(value));
  const failedMethod = /(?:^|\/)(?:failed|systemError|error_during_execution)$/i.test(method);
  const failedResult = /^result(?:\/|$)/i.test(method) && (payload.is_error === true || failedStatus);
  if (failedMethod
    || failedResult
    || failedStatus && /^(?:result|turn|thread)(?:\/|$)/i.test(method)
    || event.kind === "error" && /^(?:result|turn|thread)(?:\/|$)/i.test(method)) return "failed";
  if (/^(?:result(?:\/success)?|turn\/completed|thread\/completed)$/i.test(method)) return "terminal";
  if (/(?:completed|finished|idle|stopped|interrupted)$/i.test(method)) return "idle";
  return "working";
}

/**
 * Recognize a structured LetAgents room wait across native provider payloads.
 * Free text is deliberately ignored: only an actual tool-use envelope (Claude)
 * or an MCP tool lifecycle event (Codex and compatible adapters) can make the
 * supervised worker project as quietly polling.
 */
export function isSupervisedWaitProviderEvent(event: ProviderActionStreamEvent): boolean {
  const isWaitName = (value: unknown): boolean => typeof value === "string"
    && (value === "wait_for_messages" || value === "mcp__letagents__wait_for_messages");
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && isWaitName(record.name)) return true;
    if (/mcpToolCall/i.test(event.method)) {
      if ([record.tool, record.name, record.toolName, record.tool_name].some(isWaitName)) return true;
    }
    return Object.values(record).some((child) => visit(child, depth + 1));
  };
  return visit(event.payload, 0);
}

/**
 * Compatibility cursor evidence for the currently published MCP runtime.
 * Its explicit wait cursor is the worker's assertion that every earlier room
 * message was consumed, even when that runtime predates the daemon checkpoint
 * RPC. Newer runtimes also call the RPC; checkpointing is idempotent below.
 */
export function supervisedWaitEvidenceFromProviderEvent(event: ProviderActionStreamEvent): SupervisedWaitEvidence | null {
  const visit = (value: unknown, depth: number): SupervisedWaitEvidence | null => {
    if (depth > 8 || !value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const cursor = visit(item, depth + 1);
        if (cursor) return cursor;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const input = record.input;
    const name = typeof record.name === "string" ? record.name : "";
    if (record.type === "tool_use"
      && (name === "wait_for_messages" || name === "mcp__letagents__wait_for_messages")
      && input && typeof input === "object" && !Array.isArray(input)) {
      const cursor = (input as Record<string, unknown>).after_message_id;
      const agentSessionId = (input as Record<string, unknown>).agent_session_id;
      if (typeof cursor === "string" && /^msg_\d+$/.test(cursor)
        && typeof agentSessionId === "string" && agentSessionId.trim()) {
        return { roomCursor: cursor, agentSessionId: agentSessionId.trim() };
      }
    }
    for (const child of Object.values(record)) {
      const cursor = visit(child, depth + 1);
      if (cursor) return cursor;
    }
    return null;
  };
  return visit(event.payload, 0);
}

export function supervisedWaitCursorFromProviderEvent(event: ProviderActionStreamEvent): string | null {
  return supervisedWaitEvidenceFromProviderEvent(event)?.roomCursor ?? null;
}

const PS_LONG_START_PREFIX = /^\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}/;

/**
 * Compare the stable birth portion of a process identity. Electron records the
 * owner identity as `ps -o lstart=` (start time only) via defaultGetProcessIdentity
 * because argv/command is mutable; the daemon must therefore compare on that same
 * stable start-time prefix rather than whole-string equality, or a live owner reads
 * dead and its reservation is dropped before activate. Accepting a legacy prefix
 * (pre-2.0.12 identities also appended argv/command) keeps a live upgrade safe.
 * This mirrors sameProcessBirthIdentity in electron/main/agents/provider-evidence.ts;
 * the daemon tsconfig rootDir forbids importing it, so keep the two in sync.
 */
export function sameProcessBirthIdentity(current: string, recorded: string): boolean {
  // When ps output does not match the expected start-time prefix (unexpected/
  // malformed), fall back to exact-match rather than treating everything as equal.
  // This deliberately errs toward "not the same process"; isProcessOwnerLive's outer
  // kill(0) EPERM/ESRCH check is the safety net for genuinely-live-but-unreadable pids.
  const stable = (value: string) => value.trim().match(PS_LONG_START_PREFIX)?.[0].replace(/\s+/g, " ") ?? value.trim();
  return stable(current) === stable(recorded);
}

export class SupervisorDaemon {
  private manifestGeneration = 0;
  private readonly singleton: DaemonSingleton;
  private readonly store: ManifestStore;
  private readonly audit: AuditLog;
  private readonly durability: WorkDurabilityStore;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly gitCommand: GitCommand;
  private readonly workerBindings: WorkerBindingStore;
  private readonly socket: DaemonControlSocket;
  private readonly reconciliationTicks = new Map<string, Promise<void>>();
  private readonly scheduledConvergence = new Map<string, Promise<{ dispose: () => Promise<void> }>>();
  private readonly scheduledConvergenceCancels = new Map<string, () => void>();
  private manifestMutation: Promise<void> = Promise.resolve();
  private readonly liveHandles = new Map<string, ProviderActionHandle>();
  private readonly liveDisposers = new Map<string, Array<() => void>>();
  private readonly convergenceRequests = new Map<string, Promise<void>>();
  private readonly providerStreamQueues = new Map<string, Promise<void>>();
  private readonly cursorCheckpointQueues = new Map<string, Promise<void>>();
  private readonly providerCallbacks = new Set<Promise<void>>();
  private readonly terminalFenceRequests = new WeakMap<ProviderActionHandle, Promise<void>>();
  private readonly turnControlRequests = new Map<string, Promise<DaemonTurnControlResult>>();
  private readonly turnControlActiveEntries = new Set<string>();
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly liveBindingIdentities = new Map<string, LiveBindingIdentity>();
  private readonly pendingResumeBindings = new Map<string, PendingResumeBinding>();
  private readonly nowMs: () => number;
  private readonly setRecoveryTimeout: typeof setTimeout;
  private readonly clearRecoveryTimeout: typeof clearTimeout;
  private manifestCommit: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  private handoffScheduled = false;

  constructor(paths: DaemonPaths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort, private readonly autoConverge = providerPort?.constructor.name === "CodexProviderActionPort", private readonly nativeHeartbeatIntervalMs = 15_000, private readonly controlRequestBarrier?: (request: DaemonRequest) => Promise<void>, recoveryClock: RecoveryClock = {}) {
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.store = new ManifestStore(paths.manifestPath);
    this.audit = new AuditLog(paths.auditPath);
    const root = paths.workspaceRoot ?? dirname(paths.manifestPath);
    const gitCommand = createGitCommand(root);
    this.gitCommand = gitCommand;
    this.durability = new WorkDurabilityStore(
      paths.attemptsPath ?? `${paths.manifestPath}.attempts`,
      paths.attemptsRoot ?? `${paths.manifestPath}.attempt-data`,
      undefined,
      `${root}/worktrees`,
      undefined,
      gitCommand,
    );
    this.provisioner = new WorkspaceProvisioner(root, gitCommand);
    this.workerBindings = new WorkerBindingStore(
      paths.workerBindingsPath ?? `${paths.manifestPath}.worker-bindings`,
      (commit) => this.fenceDaemonCommit(commit),
    );
    this.socket = new DaemonControlSocket(paths.socketPath, async (request) => {
      await this.singleton.assertCurrent();
      await this.controlRequestBarrier?.(request);
      if (request.method === "daemon.negotiate") return this.status();
      if (request.method === "daemon.status") return this.status();
      if (request.method === "daemon.prepare_handoff") {
        this.scheduleHandoff();
        return { accepted: true, generation: this.singleton.currentGeneration };
      }
      if (request.method === "manifest.list") return this.entriesWithDerivedLiveness((await this.store.load()).entries);
      if (request.method === "manifest.put") return this.putManifestEntry(this.paramsEntry(request.params));
      if (request.method === "manifest.set_desired_state") {
        const params = this.paramsRecord(request.params);
        const updated = await this.setDesiredState(String(params.id ?? ""), String(params.desired_state ?? "") as DesiredState);
        return this.entryWithDerivedLiveness(updated);
      }
      if (request.method === "manifest.control_turn") {
        const params = this.paramsRecord(request.params);
        return this.controlTurn({
          entryId: String(params.id ?? ""),
          workAttemptId: String(params.work_attempt_id ?? ""),
          executionGenerationId: String(params.execution_generation_id ?? ""),
          actionId: String(params.action_id ?? ""),
          correction: typeof params.correction === "string" ? params.correction : null,
        });
      }
      if (request.method === "manifest.resolve_turn_control") {
        const params = this.paramsRecord(request.params);
        return this.resolveTurnControl({
          entryId: String(params.id ?? ""),
          workAttemptId: String(params.work_attempt_id ?? ""),
          executionGenerationId: String(params.execution_generation_id ?? ""),
          actionId: String(params.action_id ?? ""),
          resolution: String(params.resolution ?? "") as "not_applied" | "applied",
        });
      }
      if (request.method === "lane.reserve_legacy") {
        const params = this.paramsRecord(request.params);
        return this.reserveLegacyLane({
          reservation_id: String(params.reservation_id ?? ""),
          room_id: String(params.room_id ?? ""),
          provider: String(params.provider ?? ""),
          owner_pid: Number(params.owner_pid ?? 0),
          owner_process_identity: String(params.owner_process_identity ?? ""),
        });
      }
      if (request.method === "lane.activate_legacy") {
        const params = this.paramsRecord(request.params);
        return this.activateLegacyLane(String(params.reservation_id ?? ""), String(params.session_id ?? ""));
      }
      if (request.method === "lane.release_legacy") {
        const params = this.paramsRecord(request.params);
        return this.releaseLegacyLane({
          reservation_id: typeof params.reservation_id === "string" ? params.reservation_id : null,
          session_id: typeof params.session_id === "string" ? params.session_id : null,
          room_id: typeof params.room_id === "string" ? params.room_id : null,
          provider: typeof params.provider === "string" ? params.provider : null,
        });
      }
      if (request.method === "manifest.append_activity") {
        const params = this.paramsRecord(request.params);
        return this.appendActivity(String(params.id ?? ""), params.event as DaemonActivityEvent);
      }
      if (request.method === "manifest.update_workplace_liveness") {
        const params = this.paramsRecord(request.params);
        return this.updateWorkplaceLiveness(
          String(params.id ?? ""),
          String(params.state ?? "unknown") as "reachable" | "stale" | "unknown",
          typeof params.detail === "string" ? params.detail : null,
          typeof params.observed_at === "string" ? params.observed_at : new Date().toISOString(),
        );
      }
      if (request.method === "supervisor.bind_worker_session") {
        const params = this.paramsRecord(request.params);
        return this.bindWorkerSession({
          entry_id: String(params.entry_id ?? ""),
          room_id: String(params.room_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""),
          execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""),
          agent_session_token: String(params.agent_session_token ?? ""),
          api_url: String(params.api_url ?? ""),
        });
      }
      if (request.method === "supervisor.checkpoint_worker_cursor") {
        const params = this.paramsRecord(request.params);
        return this.checkpointWorkerCursor({
          entry_id: String(params.entry_id ?? ""),
          work_attempt_id: String(params.work_attempt_id ?? ""),
          execution_generation_id: String(params.execution_generation_id ?? ""),
          agent_session_id: String(params.agent_session_id ?? ""),
          room_cursor: String(params.room_cursor ?? ""),
        });
      }
      if (request.method === "attempt.read") return this.readAttempt(String(this.paramsRecord(request.params).id ?? ""));
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }, async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); });
    this.nowMs = recoveryClock.nowMs ?? Date.now;
    this.setRecoveryTimeout = recoveryClock.setTimeout ?? setTimeout;
    this.clearRecoveryTimeout = recoveryClock.clearTimeout ?? clearTimeout;
  }

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
    this.manifestGeneration = (await this.store.load()).generation;
    await this.recoverTurnControls();
    await this.recoverOrphanedLegacyReservations();
    await this.socket.start();
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  private async recoverTurnControls(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const recoveredAt = new Date().toISOString();
      let changed = false;
      const entries = manifest.entries.map((entry) => {
        if (entry.turn_control?.status !== "prepared" && entry.turn_control?.status !== "dispatching") return entry;
        changed = true;
        const wasPrepared = entry.turn_control.status === "prepared";
        return {
          ...entry,
          turn_control: {
            ...entry.turn_control,
            status: wasPrepared ? "retryable" as const : "uncertain" as const,
            error: wasPrepared
              ? "Supervisor restarted before native dispatch; the correction is safe to retry."
              : "Supervisor restarted after native dispatch began; verify the provider outcome before resolving the action.",
            updated_at: recoveredAt,
          },
        };
      });
      if (!changed) return;
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.recoveryTimers.values()) this.clearRecoveryTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.all([...this.scheduledConvergence.values()].map(async (scheduled) => (await scheduled).dispose()));
    await Promise.all([...this.convergenceRequests.values()]);
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) dispose();
    this.liveDisposers.clear();
    await Promise.all([...this.providerCallbacks]);
    await this.socket.stop();
    await this.serializeManifestCommit(() => this.singleton.release());
  }

  /**
   * Version handoff must release daemon authority independently of provider or
   * network callback latency. Provider work survives; only this daemon's
   * observers and control authority are detached.
   */
  private async stopForHandoff(): Promise<void> {
    for (const cancel of this.scheduledConvergenceCancels.values()) cancel();
    this.scheduledConvergenceCancels.clear();
    for (const scheduled of this.scheduledConvergence.values()) {
      void scheduled.then(({ dispose }) => dispose()).catch(() => undefined);
    }
    this.scheduledConvergence.clear();
    for (const disposers of this.liveDisposers.values()) for (const dispose of disposers) dispose();
    this.liveDisposers.clear();
    await this.socket.stop();
    await this.serializeManifestCommit(() => this.singleton.release());
    // Existing convergence/provider callbacks are generation-fenced below.
    // Do not await them: a wedged native transport must not block an upgrade.
    this.convergenceRequests.clear();
    this.providerCallbacks.clear();
  }

  private status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      generation: this.singleton.currentGeneration,
      pid: process.pid,
      started_at: this.startedAt,
    };
  }

  private scheduleHandoff(): void {
    if (this.handoffScheduled) return;
    this.handoffScheduled = true;
    setTimeout(() => { void this.stopForHandoff().catch(() => undefined); }, 25).unref();
  }

  private paramsRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Daemon request params must be an object.");
    return value as Record<string, unknown>;
  }

  private paramsEntry(value: unknown): DaemonManifestEntry {
    const params = this.paramsRecord(value);
    const entry = params.entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("manifest.put requires an entry.");
    return entry as DaemonManifestEntry;
  }

  private validateEntry(entry: DaemonManifestEntry): void {
    for (const field of ["id", "room_id", "display_name", "provider", "charter", "created_by", "created_at"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`Manifest entry ${field} is required.`);
    }
    if (!["running", "paused", "stopped"].includes(entry.desired_state)) throw new Error("Invalid desired state.");
  }

  private async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    this.validateEntry(entry);
    const updated = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const existing = manifest.entries.find((candidate) => candidate.id === entry.id);
      if (existing) {
        const creationIdentity = (candidate: DaemonManifestEntry) => ({
          id: candidate.id,
          room_id: candidate.room_id,
          display_name: candidate.display_name,
          provider: candidate.provider,
          model: candidate.model,
          charter: candidate.charter,
          permission_profile_id: candidate.permission_profile_id,
          provider_launch_policy: candidate.provider_launch_policy ?? null,
          created_by: candidate.created_by,
          source_repo_path: candidate.source_repo_path ?? null,
        });
        if (!isDeepStrictEqual(creationIdentity(existing), creationIdentity(entry))) {
          throw new Error(`Supervised creation request '${entry.id}' is already bound to different agent parameters.`);
        }
        // A retry after a lost response must observe the durable entry as it is
        // now. It must never rewind running lifecycle state back to the paused
        // creation claim supplied by the retried request.
        return existing;
      }
      if (entry.desired_state !== "stopped") {
        // A paused supervised entry may atomically become the pending transfer
        // claim while one legacy engine is still running. It cannot activate
        // until that exact legacy reservation has been released.
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && entry.desired_state === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const nextEntry: DaemonManifestEntry = {
        ...entry,
        workplace_liveness: entry.workplace_liveness ?? { state: "unknown", observed_at: null, detail: null },
        native_liveness: entry.native_liveness ?? { state: "unknown", observed_at: null, detail: null },
        activity: (entry.activity ?? []).slice(-200),
      };
      const entries = [...manifest.entries, nextEntry];
      const next = await this.writeManifest(this.manifestGeneration, entries, legacyOwners);
      this.manifestGeneration = next.generation;
      return nextEntry;
    });
    this.requestConvergence(updated.id);
    return updated;
  }

  private async setDesiredState(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    const updated = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (desiredState !== "stopped") {
        const legacyOwner = legacyOwners.find((candidate) =>
          candidate.room_id === entry.room_id && candidate.provider === entry.provider);
        if (legacyOwner && desiredState === "running") {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
        }
      }
      const updated = { ...entry, desired_state: desiredState };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === id ? updated : candidate), legacyOwners);
      this.manifestGeneration = next.generation;
      return updated;
    });
    if (desiredState !== "running") this.clearRecoveryConvergence(id);
    this.requestConvergence(id);
    return updated;
  }

  private controlTurn(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    for (const [field, value] of Object.entries({
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
    })) {
      if (!value.trim()) throw new Error(`Turn control ${field} is required.`);
    }
    const requestKey = `${input.entryId}:${input.actionId}`;
    const existing = this.turnControlRequests.get(requestKey);
    if (existing) return existing;
    if (this.turnControlActiveEntries.has(input.entryId)) {
      throw new Error("A turn-control action is already in flight for this exact supervised entry.");
    }
    this.turnControlActiveEntries.add(input.entryId);
    const operation = this.controlTurnOnce(input).finally(() => {
      this.turnControlRequests.delete(requestKey);
      this.turnControlActiveEntries.delete(input.entryId);
    });
    this.turnControlRequests.set(requestKey, operation);
    return operation;
  }

  private async resolveTurnControl(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    resolution: "not_applied" | "applied";
  }): Promise<DaemonManifestEntryView> {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || !input.actionId) {
      throw new Error("Exact turn-control resolution identity is required.");
    }
    if (input.resolution !== "not_applied" && input.resolution !== "applied") {
      throw new Error("Turn-control resolution must be 'not_applied' or 'applied'.");
    }
    const updated = await this.updateManifestEntry(input.entryId, (current) => {
      const control = current.turn_control;
      if (!control
        || control.action_id !== input.actionId
        || control.work_attempt_id !== input.workAttemptId
        || control.execution_generation_id !== input.executionGenerationId
        || current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn-control resolution identity is stale or belongs to another execution.");
      }
      if (control.status !== "uncertain") {
        throw new Error("Only an uncertain turn-control outcome requires operator resolution.");
      }
      const updatedAt = new Date().toISOString();
      const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
        observed_at: updatedAt,
        sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "turn_lifecycle",
        method: "supervisor/resolve-turn-control",
        summary: input.resolution === "not_applied"
          ? "Operator verified the ambiguous native effect was not applied; retry enabled"
          : "Operator verified the ambiguous native effect was applied",
        status: current.observed_state === "working" ? "working" : "idle",
        payload: { action_id: control.action_id, resolution: input.resolution },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      })].slice(-200);
      if (input.resolution === "not_applied") {
        return {
          ...current,
          activity,
          turn_control: {
            ...control,
            status: "retryable",
            stages: [],
            error: "Operator verified that the prior native effect was not applied; retry is enabled.",
            updated_at: updatedAt,
          },
        };
      }
      return {
        ...current,
        activity,
        reconciliation: rememberCompletedControlAction(
          advanceReconciliationState(current.reconciliation, current.observed_state, this.nowMs()),
          control.action_id,
        ),
        turn_control: {
          ...control,
          status: "completed",
          interrupted: true,
          resumed: control.has_correction,
          state: current.observed_state === "working" ? "working" : "idle",
          stages: ["already_applied"],
          error: "Operator verified that the prior native effect was applied.",
          updated_at: updatedAt,
        },
      };
    });
    return this.entryWithDerivedLiveness(updated);
  }

  private async controlTurnOnce(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    actionId: string;
    correction: string | null;
  }): Promise<DaemonTurnControlResult> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entryId}`);
    const ref = entry.provider_ref;
    if (entry.desired_state !== "running") throw new Error("Turn control requires desired_state=running.");
    if (entry.condition !== "none" || (entry.observed_state !== "working" && entry.observed_state !== "idle")) {
      throw new Error("Turn control requires a healthy working or idle supervised entry.");
    }
    if (!entry.work_attempt_id || entry.work_attempt_id !== input.workAttemptId || ref?.work_attempt_id !== input.workAttemptId) {
      throw new Error("Turn control work attempt is stale or belongs to a different entry.");
    }
    if (!ref || ref.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control execution generation is stale or incomplete.");
    }
    const reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs());
    const capabilities = await this.providerPort?.capabilities(input.workAttemptId, entry.provider);
    const capability = capabilities?.turnControl ?? "unsupported";
    const correction = input.correction?.trim() || null;
    const existingControl = entry.turn_control;
    const retryingControl = existingControl?.action_id === input.actionId
      && existingControl.status === "retryable";
    if (existingControl?.action_id === input.actionId) {
      if (existingControl.work_attempt_id !== input.workAttemptId
        || existingControl.execution_generation_id !== input.executionGenerationId
        || existingControl.has_correction !== Boolean(correction)) {
        throw new Error("Turn control action id was reused with different fenced input.");
      }
      if (existingControl.status === "completed") {
        return {
          entryId: input.entryId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          actionId: input.actionId,
          capability: existingControl.capability,
          interrupted: existingControl.interrupted === true,
          resumed: existingControl.resumed === true,
          state: existingControl.state ?? (entry.observed_state === "working" ? "working" : "idle"),
          duplicate: true,
          stages: ["already_applied"],
        };
      }
      if (!retryingControl) {
        throw new Error("Turn control was durably dispatched but its provider outcome is unresolved; it was not replayed.");
      }
    }
    if (existingControl
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status !== "completed"
      && existingControl.status !== "retryable") {
      throw new Error(`Turn control action '${existingControl.action_id}' is unresolved; refusing a second action on the same execution generation.`);
    }
    if (reconciliation.completed_action_ids.includes(input.actionId)) {
      return {
        entryId: input.entryId,
        workAttemptId: input.workAttemptId,
        executionGenerationId: input.executionGenerationId,
        actionId: input.actionId,
        capability,
        interrupted: false,
        resumed: Boolean(input.correction?.trim()),
        state: entry.observed_state === "working" ? "working" : "idle",
        duplicate: true,
        stages: ["already_applied"],
      };
    }
    if (!this.providerPort?.controlTurn || capability === "unsupported") {
      throw new Error(`Provider '${entry.provider}' does not support supervised turn control.`);
    }
    const binding = await this.workerBindings.get(entry.id);
    if (!binding
      || binding.room_id !== entry.room_id
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control requires the exact active worker binding for this execution generation.");
    }
    const attempt = await this.durability.getAttempt(input.workAttemptId);
    const execution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === input.executionGenerationId);
    if (!execution || execution.terminal) throw new Error("Turn control execution generation is no longer live.");
    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle) handle = await this.attachLiveProvider(entry);
    if (!handle
      || handle.workAttemptId !== input.workAttemptId
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Turn control could not resolve the exact live provider continuation.");
    }
    const recordedAt = new Date().toISOString();
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn control was superseded before durable acceptance.");
      }
      if (current.turn_control?.action_id === input.actionId && current.turn_control.status !== "retryable") return current;
      if (current.turn_control
        && current.turn_control.work_attempt_id === input.workAttemptId
        && current.turn_control.execution_generation_id === input.executionGenerationId
        && current.turn_control.status !== "completed"
        && current.turn_control.status !== "retryable") {
        throw new Error(`Turn control action '${current.turn_control.action_id}' became unresolved before dispatch.`);
      }
      return {
        ...current,
        turn_control: {
          action_id: input.actionId,
          work_attempt_id: input.workAttemptId,
          execution_generation_id: input.executionGenerationId,
          has_correction: Boolean(correction),
          status: "prepared",
          capability,
          interrupted: null,
          resumed: null,
          state: null,
          stages: [],
          error: null,
          recorded_at: recordedAt,
          updated_at: recordedAt,
        },
      };
    });
    let providerResult: ProviderTurnControlResult;
    let dispatchMarked = false;
    try {
      providerResult = await this.providerPort.controlTurn(handle, correction, {
        actionId: input.actionId,
        markDispatched: async () => {
          if (dispatchMarked) return;
          await this.updateManifestEntry(entry.id, (current) => {
            if (current.turn_control?.action_id !== input.actionId
              || current.work_attempt_id !== input.workAttemptId
              || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
              throw new Error("Turn control lost its durable prepared journal before native dispatch.");
            }
            return {
              ...current,
              turn_control: {
                ...current.turn_control,
                status: "dispatching",
                updated_at: new Date().toISOString(),
              },
            };
          });
          dispatchMarked = true;
        },
      });
      if ((providerResult.interrupted || providerResult.resumed) && !dispatchMarked) {
        throw new Error("Provider reported a turn-control effect without marking native dispatch.");
      }
    } catch (error) {
      const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      await this.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
        ? {
          ...current,
          turn_control: {
            ...current.turn_control,
            status: outcome === "not_applied" ? "retryable" : dispatchMarked ? "uncertain" : "retryable",
            error: message,
            updated_at: new Date().toISOString(),
          },
        }
        : current);
      throw error;
    }
    const stages: DaemonTurnControlResult["stages"] = ["delivered"];
    if (providerResult.interrupted) stages.push("interrupting");
    stages.push("applied");
    if (providerResult.resumed) stages.push("resumed");
    const observedAt = new Date().toISOString();
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId) {
        throw new Error("Turn control completed after its execution generation was superseded.");
      }
      const nextReconciliation = rememberCompletedControlAction(
        advanceReconciliationState(current.reconciliation, providerResult.state, this.nowMs()),
        input.actionId,
      );
      const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
        observed_at: observedAt,
        sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "turn_lifecycle",
        method: correction ? "supervisor/steer" : "supervisor/stop-turn",
        summary: correction ? "Human correction applied; same continuation resumed" : "Active turn interrupted; worker remains available",
        status: providerResult.state === "working" ? "working" : "idle",
        payload: { action_id: input.actionId, capability, stages },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      })].slice(-200);
      return {
        ...current,
        observed_state: providerResult.state,
        native_liveness: {
          state: providerResult.state === "working" ? "active" : "idle",
          observed_at: observedAt,
          detail: correction ? "human correction resumed on the same continuation" : "turn interrupted; worker available",
        },
        activity,
        reconciliation: nextReconciliation,
        turn_control: {
          action_id: input.actionId,
          work_attempt_id: input.workAttemptId,
          execution_generation_id: input.executionGenerationId,
          has_correction: Boolean(correction),
          status: "completed",
          capability,
          interrupted: providerResult.interrupted,
          resumed: providerResult.resumed,
          state: providerResult.state,
          stages,
          error: null,
          recorded_at: current.turn_control?.action_id === input.actionId
            ? current.turn_control.recorded_at
            : recordedAt,
          updated_at: observedAt,
        },
      };
    });
    return {
      entryId: input.entryId,
      workAttemptId: input.workAttemptId,
      executionGenerationId: input.executionGenerationId,
      actionId: input.actionId,
      duplicate: false,
      stages,
      ...providerResult,
    };
  }

  private async reserveLegacyLane(input: { reservation_id: string; room_id: string; provider: string; owner_pid: number; owner_process_identity: string }): Promise<LegacyLaneOwner> {
    for (const [field, value] of Object.entries({ reservation_id: input.reservation_id, room_id: input.room_id, provider: input.provider })) {
      if (!value.trim()) throw new Error(`Legacy lane ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.owner_pid) || input.owner_pid < 1) throw new Error("Legacy lane owner_pid is required.");
    if (!input.owner_process_identity.trim()) throw new Error("Legacy lane owner_process_identity is required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const duplicate = legacyOwners.find((candidate) => candidate.reservation_id === input.reservation_id);
      if (duplicate) {
        if (duplicate.room_id !== input.room_id || duplicate.provider !== input.provider) {
          throw new Error(`Legacy reservation '${input.reservation_id}' is already bound to another lane.`);
        }
        if (duplicate.owner_pid !== input.owner_pid || duplicate.owner_process_identity !== input.owner_process_identity) {
          throw new Error(`Legacy reservation '${input.reservation_id}' belongs to another Electron process.`);
        }
        return duplicate;
      }
      const supervisedOwner = manifest.entries.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider && candidate.desired_state !== "stopped");
      if (supervisedOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
      }
      const legacyOwner = legacyOwners.find((candidate) =>
        candidate.room_id === input.room_id && candidate.provider === input.provider);
      if (legacyOwner) {
        throw new Error(`Provider lane '${input.room_id}/${input.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
      }
      const now = new Date().toISOString();
      const owner: LegacyLaneOwner = {
        ...input,
        state: "reserved",
        session_id: null,
        created_at: now,
        updated_at: now,
      };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, [...legacyOwners, owner]);
      this.manifestGeneration = next.generation;
      return owner;
    });
  }

  private liveLegacyLaneOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[] {
    return owners.filter((owner) => owner.state === "active" || this.isProcessOwnerLive(owner.owner_pid, owner.owner_process_identity));
  }

  private isProcessOwnerLive(pid: number, expectedIdentity: string): boolean {
    try {
      // Read the start-time-only identity to match how Electron records the owner
      // (defaultGetProcessIdentity). Compare the stable birth prefix, not the whole
      // string — a live owner whose recorded identity omits the mutable command must
      // still read live, or its reservation is wrongly pruned before activate.
      const identity = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return Boolean(identity) && sameProcessBirthIdentity(identity, expectedIdentity);
    } catch (error) {
      try {
        process.kill(pid, 0);
        // Unknown evidence fails closed: retain the fence until a later
        // reconciliation can prove absence or birth-identity mismatch.
        return true;
      } catch (killError) {
        return (killError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  }

  private async recoverOrphanedLegacyReservations(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const live = this.liveLegacyLaneOwners(owners);
      if (live.length === owners.length) return;
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, live);
      this.manifestGeneration = next.generation;
    });
  }

  private async activateLegacyLane(reservationId: string, sessionId: string): Promise<LegacyLaneOwner> {
    if (!reservationId.trim() || !sessionId.trim()) throw new Error("Legacy reservation and session ids are required.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
      const owner = legacyOwners.find((candidate) => candidate.reservation_id === reservationId);
      if (!owner) throw new Error(`Unknown legacy lane reservation: ${reservationId}`);
      if (owner.state === "active" && owner.session_id !== sessionId) {
        throw new Error(`Legacy reservation '${reservationId}' is already active for another session.`);
      }
      const updated: LegacyLaneOwner = { ...owner, state: "active", session_id: sessionId, updated_at: new Date().toISOString() };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, legacyOwners
        .map((candidate) => candidate.reservation_id === reservationId ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async releaseLegacyLane(input: { reservation_id: string | null; session_id: string | null; room_id: string | null; provider: string | null }): Promise<{ released: boolean }> {
    const reservationId = input.reservation_id?.trim() || null;
    const sessionId = input.session_id?.trim() || null;
    const roomId = input.room_id?.trim() || null;
    const provider = input.provider?.trim() || null;
    if (!reservationId && !sessionId && !(roomId && provider)) {
      throw new Error("Legacy reservation_id, session_id, or complete room/provider lane is required.");
    }
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const owners = manifest.legacy_lane_owners ?? [];
      const retained = owners.filter((candidate) => !(
        (reservationId && candidate.reservation_id === reservationId)
        || (sessionId && candidate.session_id === sessionId)
        || (roomId && provider && candidate.room_id === roomId && candidate.provider === provider)
      ));
      if (retained.length === owners.length) return { released: false };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries, retained);
      this.manifestGeneration = next.generation;
      return { released: true };
    });
  }

  private async appendActivity(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    if (!event || typeof event !== "object" || !event.observed_at) throw new Error("A bounded activity event is required.");
    const sanitizedEvent = sanitizeDaemonActivityEvent(event);
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (sanitizedEvent.sequence <= lastSequence) throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${lastSequence}.`);
      const updated: DaemonManifestEntry = {
        ...entry,
        observed_state: sanitizedEvent.status === "working" || sanitizedEvent.status === "reviewing" ? "working" : sanitizedEvent.status === "blocked" ? entry.observed_state : "idle",
        native_liveness: { state: sanitizedEvent.status === "idle" ? "idle" : "active", observed_at: sanitizedEvent.observed_at, detail: sanitizedEvent.summary },
        activity: [...(entry.activity ?? []), sanitizedEvent].slice(-200),
      };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === id ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["reachable", "stale", "unknown"].includes(state)) throw new Error("Invalid workplace liveness state.");
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const updated: DaemonManifestEntry = { ...entry, workplace_liveness: { state, observed_at: observedAt, detail } };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === id ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  private async entriesWithDerivedLiveness(entries: DaemonManifestEntry[]): Promise<DaemonManifestEntryView[]> {
    const bindings = new Map((await this.workerBindings.list()).map((binding) => [binding.entry_id, binding]));
    return Promise.all(entries.map((entry) => this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null)));
  }

  private async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    const now = this.nowMs();
    const staleAfterMs = 90_000;
    const derive = <T extends string>(axis: { state: T; observed_at: string | null; detail: string | null } | undefined, staleStates: string[]) => {
      if (!axis?.observed_at || !staleStates.includes(axis.state)) return axis;
      const observed = Date.parse(axis.observed_at);
      return Number.isFinite(observed) && now - observed > staleAfterMs
        ? { ...axis, state: "stale" }
        : axis;
    };
    const binding = projectedBinding === undefined ? await this.workerBindings.get(entry.id) : projectedBinding;
    const bindingMatchesCurrentGeneration = Boolean(
      binding &&
      entry.desired_state === "running" &&
      ["starting", "working", "idle", "recovering"].includes(entry.observed_state) &&
      binding.room_id === entry.room_id &&
      binding.work_attempt_id === entry.work_attempt_id &&
      binding.execution_generation_id === entry.provider_ref?.execution_generation_id,
    );
    return {
      ...entry,
      workplace_liveness: derive(entry.workplace_liveness, ["reachable"]) as DaemonManifestEntry["workplace_liveness"],
      native_liveness: derive(entry.native_liveness, ["active", "idle"]) as DaemonManifestEntry["native_liveness"],
      worker_binding: bindingMatchesCurrentGeneration && binding ? {
        agent_session_id: binding.agent_session_id,
        work_attempt_id: binding.work_attempt_id,
        execution_generation_id: binding.execution_generation_id,
        updated_at: binding.updated_at,
      } : null,
    };
  }

  private async readAttempt(id: string) {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
    const attempt = entry.work_attempt_id ? await this.durability.getAttempt(entry.work_attempt_id) : null;
    const lastGeneration = attempt?.execution_generations.at(-1) ?? null;
    return {
      entry_id: entry.id,
      work_attempt_id: attempt?.work_attempt_id ?? null,
      workspace_path: attempt?.workspace_path ?? null,
      last_terminal: lastGeneration?.terminal ?? null,
      restart_count: Math.max(0, (attempt?.execution_generations.length ?? 0) - 1),
      execution_generations: attempt?.execution_generations ?? [],
      checkpoints: attempt?.checkpoints ?? [],
      activity: entry.activity ?? [],
    };
  }

  /** Queue convergence without making a control-socket caller wait for launch. */
  private requestConvergence(entryId: string): void {
    if (this.handoffScheduled || !this.providerPort || !this.autoConverge) return;
    const previous = this.convergenceRequests.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      // Direct manifest convergence and the legacy reconciliation scheduler
      // both mutate provider authority for this entry. They must share one
      // serialization lane; otherwise a pause/resume edge can observe the
      // durable generation before its provider handle is installed and mint a
      // second live generation.
      .then(() => this.serializeEntryTick(entryId, () => this.convergeManifestEntry(entryId)))
      .catch(async (error) => {
        await this.recordSchedulerFailure(entryId, error, "daemon-convergence").catch(() => undefined);
      })
      .finally(() => {
        if (this.convergenceRequests.get(entryId) === next) this.convergenceRequests.delete(entryId);
      });
    this.convergenceRequests.set(entryId, next);
  }

  private async convergeManifestEntry(entryId: string): Promise<void> {
    if (this.handoffScheduled || !this.providerPort) return;
    let entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    if (!this.providerPort) throw new Error(`No daemon provider port is available for ${entry.provider}.`);

    if (entry.desired_state === "running") {
      if (entry.condition === "quarantined") return;
      if (entry.observed_state === "failed") {
        const now = this.nowMs();
        const exitsInWindow = (entry.reconciliation?.exit_timestamps_ms ?? [])
          .filter((at) => at >= now - CRASH_LOOP_WINDOW_MS).length;
        if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
          await this.transition(
            entry.id,
            "failed",
            "quarantined",
            "crash-loop threshold reached before provider restart",
            "daemon-convergence",
          );
          return;
        }
        const restartAt = entry.reconciliation?.next_restart_at_ms;
        if (typeof restartAt === "number" && restartAt > now) {
          this.scheduleRecoveryConvergence(entry.id, restartAt - now);
          return;
        }
      }
      entry = await this.ensureWorkAttempt(entry);
      let handle = this.liveHandles.get(entry.id) ?? null;
      if (!handle && entry.provider_ref) {
        handle = await this.attachLiveProvider(entry);
        entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId) ?? entry;
      }
      if (handle) {
        if (entry.observed_state !== handle.observedState) {
          await this.transition(entry.id, handle.observedState, entry.condition, "reattached durable provider handle", "daemon-convergence");
        }
        if (["failed", "idle", "stopped"].includes(handle.observedState)) {
          await this.fenceTerminalProviderHandleOnce(
            handle,
            `manifest:${entry.id}:reattached-terminal:${entry.provider_ref?.execution_generation_id ?? "unknown"}`,
          );
        }
        return;
      }

      const attempt = await this.durability.getAttempt(entry.work_attempt_id!);
      const activeExecution = attempt.execution_generations.find((candidate) => candidate.terminal === null);
      if (activeExecution) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "durable execution generation remains live without an attachable provider handle",
          "daemon-convergence",
        );
        return;
      }
      await this.transition(entry.id, entry.provider_ref ? "recovering" : "starting", "none", entry.provider_ref ? "recovering durable provider continuation" : "starting daemon-owned provider", "daemon-convergence");
      const generationNumber = attempt.execution_generations.reduce((max, candidate) => Math.max(max, candidate.generation), 0) + 1;
      const execution = await this.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", generationNumber);
      const priorBinding = entry.provider_ref ? await this.workerBindings.get(entry.id) : null;
      const resumeWorker = priorBinding
        && priorBinding.room_id === entry.room_id
        && priorBinding.work_attempt_id === attempt.work_attempt_id
        ? {
          agentSessionId: priorBinding.agent_session_id,
          roomCursor: priorBinding.room_cursor ?? null,
        }
        : null;
      const devMcpServerEntryPath = devMcpServerEntryFromEnv() ?? undefined;
      const spawn = {
        workAttemptId: attempt.work_attempt_id,
        roomId: entry.room_id,
        cwd: attempt.workspace_path,
        launchPolicy: entry.provider_launch_policy ?? {},
        provider: entry.provider,
        agentDisplayName: entry.display_name,
        actionId: `manifest:${entry.id}:generation:${generationNumber}`,
        supervisorEntryId: entry.id,
        supervisorSocketPath: this.socket.path,
        supervisorExecutionGenerationId: execution.execution_generation_id,
        ...(resumeWorker ? { supervisorWorkerSession: resumeWorker } : {}),
        ...(devMcpServerEntryPath && entry.provider === "codex" ? { devMcpServerEntryPath } : {}),
      };
      const ref = entry.provider_ref ? this.providerRef(entry) : null;
      let resumed = false;
      try {
        const capabilities = await this.providerPort.capabilities(attempt.work_attempt_id, entry.provider);
        resumed = Boolean(ref && capabilities.resume);
        handle = resumed
          ? await this.providerPort.resume(ref!, { ...spawn, resumeFrom: ref })
          : await this.providerPort.spawn(spawn);
        await this.persistProviderHandle(entry.id, handle, execution.execution_generation_id);
        await this.durability.checkpoint(attempt.work_attempt_id, { room_cursor: null, provider_continuation_id: handle.providerContinuationId });
        await this.installProviderHandle(entry.id, handle, execution.execution_generation_id);
      } catch (error) {
        const terminal = this.terminalPayload({
          endedAt: new Date().toISOString(), exitCode: null, signal: null,
          terminalCause: "protocol_error", providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
        }, "daemon-provider");
        try {
          await this.durability.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, generation: generationNumber, actor: "daemon-provider" });
          await this.durability.releaseTerminalExecutionFence(attempt.work_attempt_id, execution.execution_generation_id);
        } catch (cleanupError) {
          const launchMessage = error instanceof Error ? error.message : "unknown provider launch failure";
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "unknown failed-launch cleanup failure";
          throw new Error(`Provider launch failed (${launchMessage}) and durable cleanup failed (${cleanupMessage}).`, { cause: error });
        }
        throw error;
      }
      if (["failed", "idle", "stopped"].includes(handle.observedState)) {
        // A provider can finish the bootstrap turn before spawn/resume
        // returns and before the daemon has installed its stream listener.
        // The handle state is still authoritative: a persistent polling
        // worker that already failed or completed has no live delivery
        // loop. Fence it after installing the exit listener so the normal
        // terminal callback can persist the edge and mint a bounded resume
        // generation instead of parking forever on a terminal live handle.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entry.id}:returned-terminal:${generationNumber}`,
        );
        return;
      }
      if (priorBinding && !resumed) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "fresh provider generation cannot inherit a terminal worker credential; awaiting exact bind",
          "daemon-convergence",
        );
        return;
      }
      if (resumed && priorBinding) {
        try {
          await this.stageWorkerBindingAfterResume(entry, priorBinding, execution.execution_generation_id, handle);
        } catch (error) {
          await this.transition(
            entry.id,
            "recovering",
            "coordination_blocked",
            `resumed provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
            "daemon-convergence",
          );
          return;
        }
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
        return;
      }
      await this.transition(entry.id, handle.observedState, "none", resumed ? "provider resumed under daemon authority" : "provider launched under daemon authority", "daemon-convergence");
      return;
    }

    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle && entry.provider_ref) {
      handle = await this.attachLiveProvider(entry);
    }
    if (handle) {
      await this.transition(entry.id, "stopping", entry.condition, `desired state changed to ${entry.desired_state}`, "daemon-convergence");
      await this.providerPort.stop(handle, { actionId: `manifest:${entry.id}:${entry.desired_state}:${this.nowMs()}` });
      return;
    }
    await this.transition(entry.id, entry.desired_state === "paused" ? "paused" : "stopped", "none", "desired state converged without a live provider", "daemon-convergence");
  }

  private providerRef(entry: DaemonManifestEntry): ProviderActionRef {
    const ref = entry.provider_ref;
    if (!ref) throw new Error("Manifest entry has no durable provider ref.");
    return {
      workAttemptId: ref.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id,
      provider: entry.provider,
      providerConnection: ref.provider_connection,
    };
  }

  /**
   * Attach only when the manifest's exact execution generation is still live.
   * A provider transport (for example a long-lived app-server) can remain
   * reachable after an intentional worker stop, but that transport is not
   * authority to resurrect the terminal generation. A later desired=running
   * transition must instead mint a successor generation and use resume/spawn.
   */
  private async attachLiveProvider(entry: DaemonManifestEntry): Promise<ProviderActionHandle | null> {
    const ref = entry.provider_ref;
    if (!ref) return null;
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === ref.execution_generation_id);
    if (!execution) throw new Error("Manifest provider reference has no matching durable execution generation.");
    if (execution.terminal) return null;
    const attachment = await this.providerPort!.attach(this.providerRef(entry));
    if (!attachment) return null;
    if (this.isAttachTerminal(attachment)) {
      const terminal = attachment.terminal;
      if (terminal.providerContinuationId && terminal.providerContinuationId !== ref.provider_continuation_id) {
        throw new Error("Provider attach terminal evidence belongs to a different durable continuation.");
      }
      await this.durability.recordTerminal(ref.work_attempt_id, execution.execution_generation_id, {
        ...this.terminalPayload(terminal, execution.actor),
        actor: execution.actor,
        generation: execution.generation,
      });
      // A no-handle attach result used to strand this generation forever. The
      // explicit terminal evidence proves the writer absent (or fenced), so it
      // is now safe to release workspace authority before bounded resume.
      await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, execution.execution_generation_id);
      // Keep the private credential on its durably terminal generation. It is
      // no longer projected or allowed to publish, but a later exact native
      // resume needs it for verify-before-rollover compatibility with workers
      // that cannot bind again after their saved provider session resumes.
      return null;
    }
    const handle = attachment;
    await this.durability.recoverExecutionFence(ref.work_attempt_id);
    await this.installProviderHandle(entry.id, handle, ref.execution_generation_id);
    const binding = await this.workerBindings.get(entry.id);
    if (binding && binding.execution_generation_id !== ref.execution_generation_id) {
      try {
        await this.stageWorkerBindingAfterResume(entry, binding, ref.execution_generation_id, handle);
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          "reattached resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
      } catch (error) {
        await this.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          `reattached provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
          "daemon-convergence",
        );
      }
    }
    return handle;
  }

  private isAttachTerminal(
    attachment: ProviderActionHandle | ProviderActionAttachTerminal,
  ): attachment is ProviderActionAttachTerminal {
    return "state" in attachment && attachment.state === "terminal";
  }

  private async ensureWorkAttempt(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (entry.work_attempt_id) {
      await this.durability.getAttempt(entry.work_attempt_id);
      return entry;
    }
    const sourcePath = entry.source_repo_path?.trim() || entry.workspace_path?.trim();
    if (!sourcePath) throw new Error("A source repository is required to provision a supervised work attempt.");
    const remote = String(await this.gitCommand(["-C", sourcePath, "remote", "get-url", "origin"])).trim();
    const revision = String(await this.gitCommand(["-C", sourcePath, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const repo = repositoryStorageKey(remote);
    const workAttemptId = randomUUID();
    const provisioned = await this.provisioner.provision({ repo, workAttemptId, taskId: entry.id, remoteUrl: remote, revision });
    const attempt = await this.durability.createAttempt({ taskId: entry.id, leaseId: entry.id, leaseEpoch: 0, workspacePath: provisioned.path, workAttemptId });
    return this.updateManifestEntry(entry.id, (current) => ({ ...current, source_repo_path: sourcePath, workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id }));
  }

  private async persistProviderHandle(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): Promise<void> {
    if (!handle.providerContinuationId) throw new Error("Provider launch did not return a durable continuation id.");
    await this.updateManifestEntry(entryId, (current) => ({
      ...current,
      provider_ref: {
        work_attempt_id: handle.workAttemptId,
        provider_continuation_id: handle.providerContinuationId!,
        provider_connection: handle.providerConnection ?? null,
        execution_generation_id: executionGenerationId,
      },
    }));
  }

  private async installProviderHandle(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): Promise<void> {
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    this.liveHandles.set(entryId, handle);
    const binding = await this.workerBindings.get(entryId);
    const currentBinding = this.liveBindingIdentities.get(entryId);
    if (binding?.execution_generation_id === executionGenerationId) {
      if (!currentBinding || binding.updated_at >= currentBinding.updatedAt) {
        this.liveBindingIdentities.set(entryId, {
          agentSessionId: binding.agent_session_id,
          executionGenerationId: binding.execution_generation_id,
          updatedAt: binding.updated_at,
        });
      }
    } else if (currentBinding?.executionGenerationId !== executionGenerationId) {
      this.liveBindingIdentities.delete(entryId);
    }
    const disposeExit = await this.providerPort!.onExit(handle, (terminal) => {
      const bindingIdentity = this.liveBindingIdentities.get(entryId);
      this.trackProviderCallback(this.handleProviderTerminal(entryId, handle, executionGenerationId, bindingIdentity, terminal));
    });
    const disposeStream = this.providerPort!.onStream
      ? await this.providerPort!.onStream!(handle, (event) => { this.trackProviderCallback(this.enqueueProviderStream(entryId, handle, event)); })
      : () => {};
    const heartbeat = setInterval(() => {
      const current = this.liveHandles.get(entryId);
      if (!current) return;
      this.trackProviderCallback((async () => {
        const manifestEntry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
        if (!manifestEntry || this.liveHandles.get(entryId) !== current) return;
        if (this.liveBindingIdentities.get(entryId)?.executionGenerationId !== manifestEntry.provider_ref?.execution_generation_id) return;
        if (!["working", "idle"].includes(manifestEntry.observed_state)) return;
        if (!["working", "idle"].includes(current.observedState)) return;
        const status = current.observedState === "idle" ? "idle" : "working";
        await this.publishNativeActivity(entryId, "native_harness.heartbeat", status);
      })().catch(() => undefined));
    }, this.nativeHeartbeatIntervalMs);
    heartbeat.unref();
    this.liveDisposers.set(entryId, [disposeExit, disposeStream, () => clearInterval(heartbeat)]);
  }

  private async stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const ref = entry.provider_ref;
    if (!ref
      || priorBinding.entry_id !== entry.id
      || priorBinding.room_id !== entry.room_id
      || priorBinding.work_attempt_id !== ref.work_attempt_id
      || handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Resumed provider does not match the durable worker continuation identity.");
    }
    const attempt = await this.durability.getAttempt(ref.work_attempt_id);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === priorBinding.execution_generation_id,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) {
      throw new Error("Worker binding predecessor execution is not durably terminal.");
    }
    if (predecessor.terminal.provider_continuation_id !== ref.provider_continuation_id) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    this.pendingResumeBindings.set(entry.id, {
      roomId: entry.room_id,
      workAttemptId: ref.work_attempt_id,
      predecessorExecutionGenerationId: priorBinding.execution_generation_id,
      successorExecutionGenerationId,
      agentSessionId: priorBinding.agent_session_id,
      providerContinuationId: ref.provider_continuation_id,
    });
  }

  /**
   * Published MCP runtimes before bind-on-wait cannot present their credential
   * again after a native session resume. The first exact wait event proves the
   * saved worker-session identity. While the credential still belongs to its
   * terminal predecessor, verify it with the API; only an accepted response is
   * allowed to atomically advance the private binding and public projection.
   */
  private async restoreWorkerBindingFromWait(
    entryId: string,
    evidence: SupervisedWaitEvidence,
  ): Promise<boolean> {
    const pending = this.pendingResumeBindings.get(entryId);
    if (!pending || evidence.agentSessionId !== pending.agentSessionId) return false;
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    const handle = this.liveHandles.get(entryId);
    if (!entry || !handle
      || entry.room_id !== pending.roomId
      || entry.work_attempt_id !== pending.workAttemptId
      || entry.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
      || entry.provider_ref.provider_continuation_id !== pending.providerContinuationId
      || handle.workAttemptId !== pending.workAttemptId
      || handle.providerContinuationId !== pending.providerContinuationId) {
      throw new Error("Resumed wait evidence does not match the staged provider continuation.");
    }
    const attempt = await this.durability.getAttempt(pending.workAttemptId);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.predecessorExecutionGenerationId,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) throw new Error("Worker binding predecessor execution is not durably terminal.");
    if (predecessor.terminal.provider_continuation_id !== pending.providerContinuationId) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    const method = "native_harness.resumed_binding";
    const result = await this.workerBindings.verifyAndAdvanceExecutionGeneration({
      entryId,
      roomId: pending.roomId,
      workAttemptId: pending.workAttemptId,
      fromExecutionGenerationId: pending.predecessorExecutionGenerationId,
      toExecutionGenerationId: pending.successorExecutionGenerationId,
      agentSessionId: pending.agentSessionId,
    }, async ({ binding, sequence, observed_at }) => {
      const roomPath = binding.room_id.split("/").map(encodeURIComponent).join("/");
      const endpoint = `${binding.api_url}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(binding.agent_session_id)}/native-activity`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_session_id: binding.agent_session_id,
          agent_session_token: binding.agent_session_token,
          observed_at,
          sequence,
          method,
          status: "working",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Native activity endpoint rejected resumed credential verification with HTTP ${response.status}.`);
      const payload = await response.json() as { accepted?: boolean };
      return { accepted: payload.accepted !== false };
    });
    if (!result.accepted) throw new Error("Native activity endpoint rejected the retained worker credential.");
    const verified = result.binding;
    this.liveBindingIdentities.set(entry.id, {
      agentSessionId: verified.agent_session_id,
      executionGenerationId: verified.execution_generation_id,
      updatedAt: verified.updated_at,
    });
    await this.updateManifestEntry(entry.id, (current) => {
      if (current.work_attempt_id !== pending.workAttemptId
        || current.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
        || current.provider_ref.provider_continuation_id !== pending.providerContinuationId) {
        throw new Error("Manifest moved while restoring the resumed worker binding.");
      }
      return {
        ...current,
        observed_state: "working" as const,
        condition: "none" as const,
        last_error: null,
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: verified.updated_at,
          detail: "exact persisted worker session restored after native resume",
        },
        last_worker_binding: {
          agent_session_id: verified.agent_session_id,
          work_attempt_id: verified.work_attempt_id,
          execution_generation_id: verified.execution_generation_id,
          updated_at: verified.updated_at,
        },
      };
    });
    this.pendingResumeBindings.delete(entryId);
    return true;
  }

  private async handleProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    const observedLifecycle = providerStreamLifecycle(event);
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    // A terminal native failure is sticky for the installed execution. Late
    // deltas and heartbeats from that same handle are evidence, not recovery.
    const lifecycle = entry.observed_state === "failed" ? "failed" : observedLifecycle;
    // Provider-local stream counters may restart when a replacement daemon
    // attaches. Persist a daemon-global monotonic sequence for the manifest.
    const sequence = Math.max((entry.activity?.at(-1)?.sequence ?? 0) + 1, event.sequence);
    const quietlyPolling = isSupervisedWaitProviderEvent(event);
    const status: DaemonActivityEvent["status"] = lifecycle === "failed"
      ? "blocked"
      : lifecycle === "terminal" || quietlyPolling ? "idle" : lifecycle;
    const sanitizedEvent = sanitizeDaemonActivityEvent({
      observed_at: event.observedAt,
      sequence,
      provider: event.provider,
      kind: event.kind,
      method: event.method,
      summary: `${event.provider} · ${event.method}`.slice(0, 500),
      status,
      payload: event.payload,
      payload_truncated: event.payloadTruncated,
      payload_redacted: event.payloadRedacted,
      durable_payload_ref: event.durablePayloadRef,
    });
    await this.appendActivity(entryId, sanitizedEvent);
    const waitEvidence = supervisedWaitEvidenceFromProviderEvent(event);
    if (waitEvidence) {
      const pending = this.pendingResumeBindings.get(entryId);
      if (pending && waitEvidence.agentSessionId === pending.agentSessionId) {
        try {
          await this.serializeEntryTick(entryId, () => this.restoreWorkerBindingFromWait(entryId, waitEvidence));
        } catch (error) {
          await this.serializeEntryTick(entryId, () => this.transition(
            entryId,
            "recovering",
            "coordination_blocked",
            `resumed provider credential verification failed: ${error instanceof Error ? error.message : "unknown credential verification failure"}`,
            "daemon-provider-stream",
          ));
          return;
        }
      }
      if (!this.pendingResumeBindings.has(entryId)) {
        await this.checkpointObservedWaitCursor(entry, waitEvidence.roomCursor, waitEvidence.agentSessionId);
      }
    }
    if (lifecycle === "failed" && entry.observed_state !== "failed") {
      await this.transition(entryId, "failed", entry.condition, `provider stream terminal failure: ${sanitizedEvent.method}`, "daemon-provider-stream");
    }
    const liveBinding = this.liveBindingIdentities.get(entryId);
    if (liveBinding?.executionGenerationId === entry.provider_ref?.execution_generation_id) {
      await this.publishNativeActivity(entryId, sanitizedEvent.method, lifecycle === "working" && !quietlyPolling ? "working" : "idle", event.observedAt).catch(() => undefined);
    }
    if ((lifecycle === "failed" || lifecycle === "terminal")
      && this.liveHandles.get(entryId) === handle
      && !["stopping", "stopped"].includes(handle.observedState)) {
      try {
        // A persistent polling turn ending (successfully or with a native
        // terminal error) means delivery ended. Fence that native process so
        // the terminal callback can mint a bounded resume generation.
        await this.fenceTerminalProviderHandleOnce(
          handle,
          `manifest:${entryId}:terminal-turn:${event.sequence}`,
        );
      } catch (error) {
        await this.transition(
          entryId,
          "failed",
          "coordination_blocked",
          `failed to fence terminal provider turn: ${error instanceof Error ? error.message : "unknown error"}`,
          "daemon-provider-stream",
        );
      }
    }
  }

  private async checkpointObservedWaitCursor(entry: DaemonManifestEntry, roomCursor: string, agentSessionId: string): Promise<void> {
    await this.serializeCursorCheckpoint(entry.id, async () => {
      const executionGenerationId = entry.provider_ref?.execution_generation_id;
      if (!entry.work_attempt_id || !executionGenerationId) return;
      const binding = await this.workerBindings.get(entry.id);
      if (!binding
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.agent_session_id !== agentSessionId
        || binding.execution_generation_id !== executionGenerationId) return;
      const checkpoint = await this.workerBindings.checkpointCursorMonotonic(
        entry.id,
        binding.agent_session_id,
        executionGenerationId,
        roomCursor,
      );
      if (!checkpoint.advanced) return;
      await this.durability.checkpoint(entry.work_attempt_id, {
        room_cursor: roomCursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
    });
  }

  private enqueueProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    const previous = this.providerStreamQueues.get(entryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.handleProviderStream(entryId, handle, event)).finally(() => {
      if (this.providerStreamQueues.get(entryId) === next) this.providerStreamQueues.delete(entryId);
    });
    this.providerStreamQueues.set(entryId, next);
    return next;
  }

  private serializeCursorCheckpoint<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.cursorCheckpointQueues.get(entryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      if (this.cursorCheckpointQueues.get(entryId) === tail) this.cursorCheckpointQueues.delete(entryId);
    });
    this.cursorCheckpointQueues.set(entryId, tail);
    return result;
  }

  private fenceTerminalProviderHandleOnce(handle: ProviderActionHandle, actionId: string): Promise<void> {
    const existing = this.terminalFenceRequests.get(handle);
    if (existing) return existing;
    const operation = this.providerPort!
      .stop(handle, { actionId })
      .then(() => undefined);
    this.terminalFenceRequests.set(handle, operation);
    return operation;
  }

  private scheduleRecoveryConvergence(entryId: string, delayMs: number): void {
    if (this.recoveryTimers.has(entryId)) return;
    const timer = this.setRecoveryTimeout(() => {
      this.recoveryTimers.delete(entryId);
      this.requestConvergence(entryId);
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.recoveryTimers.set(entryId, timer);
  }

  private clearRecoveryConvergence(entryId: string): void {
    const timer = this.recoveryTimers.get(entryId);
    if (!timer) return;
    this.clearRecoveryTimeout(timer);
    this.recoveryTimers.delete(entryId);
  }

  private async bindWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const currentBinding = await this.workerBindings.get(input.entry_id);
    const normalizedApiUrl = new URL(input.api_url).origin;
    const exactCurrentBinding = Boolean(currentBinding
      && currentBinding.execution_generation_id === input.execution_generation_id
      && currentBinding.agent_session_id === input.agent_session_id
      && currentBinding.agent_session_token === input.agent_session_token
      && currentBinding.api_url === normalizedApiUrl);
    const binding = exactCurrentBinding && currentBinding
      ? currentBinding
      : await this.workerBindings.bind(input);
    this.liveBindingIdentities.set(input.entry_id, {
      agentSessionId: binding.agent_session_id,
      executionGenerationId: binding.execution_generation_id,
      updatedAt: binding.updated_at,
    });
    this.pendingResumeBindings.delete(input.entry_id);
    await this.updateManifestEntry(input.entry_id, (current) => ({
      ...current,
      // A successful exact-generation bind proves that an ambiguous live
      // provider has its MCP control route. Restore workplace reachability on
      // fresh and persisted-idempotent binds; clear only the coordination
      // latch, while quarantine and native terminal failures stay authoritative.
      workplace_liveness: {
        state: "reachable" as const,
        observed_at: new Date().toISOString(),
        detail: exactCurrentBinding
          ? "exact supervised worker session binding confirmed"
          : "supervised worker session bound",
      },
      ...(current.desired_state === "running" && current.condition === "coordination_blocked"
        ? {
          observed_state: "working" as const,
          condition: "none" as const,
          last_error: null,
        }
        : {}),
      last_worker_binding: {
        agent_session_id: binding.agent_session_id,
        work_attempt_id: binding.work_attempt_id,
        execution_generation_id: binding.execution_generation_id,
        updated_at: binding.updated_at,
      },
    }));
    if (!exactCurrentBinding || entry.workplace_liveness?.state !== "reachable") {
      await this.publishNativeActivity(input.entry_id, "native_harness.bound", "working");
    }
    return { bound: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  private async checkpointWorkerCursor(input: { entry_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; room_cursor: string }): Promise<{ checkpointed: true; entry_id: string; room_cursor: string }> {
    return this.serializeCursorCheckpoint(input.entry_id, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
      if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker cursor work attempt does not match the supervised manifest entry.");
      const attempt = await this.durability.getAttempt(input.work_attempt_id);
      const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
      if (!execution || execution.terminal) throw new Error("Worker cursor execution generation is absent or terminal.");
      const currentBinding = await this.workerBindings.get(input.entry_id);
      if (!currentBinding
        || currentBinding.agent_session_id !== input.agent_session_id
        || currentBinding.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
      }
      if (currentBinding.room_cursor === input.room_cursor) {
        return { checkpointed: true, entry_id: input.entry_id, room_cursor: input.room_cursor };
      }
      await this.workerBindings.checkpointCursor(
        input.entry_id,
        input.agent_session_id,
        input.execution_generation_id,
        input.room_cursor,
      );
      await this.durability.checkpoint(input.work_attempt_id, {
        room_cursor: input.room_cursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
      return { checkpointed: true, entry_id: input.entry_id, room_cursor: input.room_cursor };
    });
  }

  private async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const publication = await this.workerBindings.publish(entryId, observedMs, async ({ binding, sequence, observed_at }) => {
      const roomPath = binding.room_id.split("/").map(encodeURIComponent).join("/");
      const endpoint = `${binding.api_url}/rooms/${roomPath}/agent-sessions/${encodeURIComponent(binding.agent_session_id)}/native-activity`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_session_id: binding.agent_session_id,
          agent_session_token: binding.agent_session_token,
          observed_at,
          sequence,
          method: safeMethod,
          status,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Native activity endpoint rejected the daemon bridge with HTTP ${response.status}.`);
      const result = await response.json() as { accepted?: boolean };
      return { accepted: result.accepted !== false };
    });
    if (!publication) return false;
    if (!publication.accepted) throw new Error("Native activity endpoint rejected a stale daemon observation.");
    return true;
  }

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, _terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    this.pendingResumeBindings.delete(entryId);
    this.liveHandles.delete(entryId);
    this.liveBindingIdentities.delete(entryId);
    for (const dispose of this.liveDisposers.get(entryId) ?? []) dispose();
    this.liveDisposers.delete(entryId);
    await this.serializeEntryTick(entryId, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
      const successorHandle = this.liveHandles.get(entryId);
      if (successorHandle && successorHandle !== handle) return;
      if (entry?.work_attempt_id) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (this.liveHandles.get(entryId)) return;
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
        if (execution && !execution.terminal) {
          await this.durability.recordTerminal(entry.work_attempt_id, execution.execution_generation_id, {
            ...this.terminalPayload(terminal, execution.actor),
            generation: execution.generation,
          });
        }
        if (entry.desired_state === "stopped") {
          await this.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId);
        }
      }
      if (this.liveHandles.get(entryId)) return;
      // Do not erase the terminal binding here. installProviderHandle removed its
      // live publication authority above; retaining the owner-only (0600)
      // private credential is what permits an exact successor to verify and
      // roll it forward after an intentional stop/start or daemon replacement.
      await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
      this.requestConvergence(entryId);
    });
  }

  private trackProviderCallback(operation: Promise<void>): void {
    this.providerCallbacks.add(operation);
    void operation.finally(() => this.providerCallbacks.delete(operation));
  }

  private async updateManifestEntry(entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<DaemonManifestEntry> {
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(entry);
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate));
      this.manifestGeneration = next.generation;
      return updated;
    });
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.serializeManifestMutation(() => this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload): Promise<void> {
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const safeCause = redactCredentialText(cause).value;
    const safeActor = redactCredentialText(actor).value;
    const sanitizeTerminal = (value: ExecutionTerminalPayload | undefined): ExecutionTerminalPayload | undefined => value ? {
      ...value,
      signal: value.signal === null ? null : redactCredentialText(value.signal).value,
      stdio_archive_ref: value.stdio_archive_ref === null ? null : redactCredentialText(value.stdio_archive_ref).value,
      stdio_tail: redactCredentialText(value.stdio_tail, 64 * 1024).value,
      terminal_cause: redactCredentialText(value.terminal_cause).value,
      actor: redactCredentialText(value.actor).value,
      provider_continuation_id: value.provider_continuation_id === null ? null : redactCredentialText(value.provider_continuation_id).value,
    } : undefined;
    const candidateReconciliation = reconciliation ?? advanceReconciliationState(entry.reconciliation, to, this.nowMs());
    const nextReconciliation = {
      ...candidateReconciliation,
      last_terminal: sanitizeTerminal(candidateReconciliation.last_terminal),
    };
    const safeTerminal = sanitizeTerminal(terminal);
    const noticeKind = notice ?? (condition === "quarantined" ? "quarantine_death" : condition === "coordination_blocked" ? "coordination_escalation" : undefined);
    const notices = (entry.reconciliation_notices ?? []).map((candidate) => ({
      ...candidate,
      cause: redactCredentialText(candidate.cause).value,
      terminal: sanitizeTerminal(candidate.terminal),
    }));
    if (noticeKind) notices.push({ at: new Date().toISOString(), kind: noticeKind, cause: safeCause, terminal: safeTerminal ?? nextReconciliation.last_terminal ?? undefined });
    const lastError = to === "failed" || condition !== "none"
      ? safeCause
      : (["working", "idle", "stopped"].includes(to) ? null : entry.last_error === null || entry.last_error === undefined ? null : redactCredentialText(entry.last_error).value);
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate));
    this.manifestGeneration = next.generation;
    await this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause: safeCause, actor: safeActor, generation: next.generation });
    });
  }

  /**
   * The daemon owns this convergence entry point: manifest state is the source
   * of truth, and every retry deadline survives a daemon restart. P1e supplies
   * the real control-socket port; tests may inject a fake port directly.
   */
  async reconcile(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor = "reconciler") {
    return this.serializeEntryTick(entryId, () => this.serializeManifestMutation(() => this.reconcileOnce(entryId, input, watchdogThresholdMs, actor)));
  }

  private async reconcileOnce(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor: string) {
    if (!this.providerPort) throw new Error("Provider action port is unavailable");
    await this.singleton.assertCurrent();
    const manifest = await this.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    let reconciliation = advanceReconciliationState(entry.reconciliation, entry.observed_state, input.nowMs);
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const persisted = { ...entry, reconciliation };
      const next = await this.writeManifest(this.manifestGeneration, manifest.entries.map((candidate) => candidate.id === entryId ? persisted : candidate));
      this.manifestGeneration = next.generation;
    }

    let redispatchPending = false;
    let redispatchKind: "poke" | "restart_fresh" | "restart_with_resume" | "stop" | undefined;
    let redispatchActionId = input.reconciliationActionId;
    let redispatchActionSequence = input.reconciliationActionSequence;
    if (reconciliation.pending_action) {
      const pending = reconciliation.pending_action;
      const attachment = await this.providerPort.attachAction(pending.id, input.workAttemptId);
      if (attachment.state === "attached") {
        reconciliation = completeReconciliationAction(reconciliation, pending.id);
        await this.transitionOnce(entryId, attachment.handle.observedState, entry.condition, "reconciled pending provider action", actor, reconciliation);
      }
      if (attachment.state === "absent") { redispatchPending = true; redispatchActionId = pending.id; redispatchActionSequence = pending.sequence; redispatchKind = pending.kind; }
      if (attachment.state === "ambiguous") {
        await this.transitionOnce(entryId, "recovering", "coordination_blocked", `pending provider action ambiguous: ${attachment.reason}`, actor, reconciliation);
        return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: `pending provider action ambiguous: ${attachment.reason}` }, disposition: "held" as const };
      }
      if (attachment.state === "attached") return {
        decision: { action: "hold_coordination" as const, observedState: attachment.handle.observedState, condition: entry.condition, reason: "pending provider action attached; await next convergence tick" },
        disposition: "held" as const,
      };
    }

    if (redispatchPending && entry.desired_state === "stopped" && redispatchKind !== "stop") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      redispatchPending = false;
      redispatchKind = undefined;
      redispatchActionId = input.reconciliationActionId;
      redispatchActionSequence = input.reconciliationActionSequence;
      await this.transitionOnce(entryId, entry.observed_state, entry.condition, "cancelled pending provider action because desired state is stopped", actor, reconciliation);
    }
    if (redispatchPending && entry.condition === "quarantined") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      await this.transitionOnce(entryId, entry.observed_state, "quarantined", "cancelled pending provider action because entry is quarantined", actor, reconciliation);
      return { decision: { action: "quarantine" as const, observedState: entry.observed_state, condition: "quarantined" as const, reason: "quarantined entry cannot redispatch pending provider action" }, disposition: "held" as const };
    }
    if (redispatchPending && ["restart_fresh", "restart_with_resume"].includes(redispatchKind ?? "") && input.activeLease) {
      await this.transitionOnce(entryId, "recovering", "coordination_blocked", "pending provider action awaits fenced lease rebind", actor, reconciliation);
      return { decision: { action: "hold_coordination" as const, observedState: "recovering" as const, condition: "coordination_blocked" as const, reason: "pending provider action awaits fenced lease rebind" }, disposition: "held" as const };
    }

    const result = await new ProviderReconciler(this.providerPort).reconcile({
      ...input,
      actionId: redispatchActionId,
      forcedAction: redispatchKind,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.exit_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs, {
      beforeAction: async (kind) => {
        if (redispatchPending) return;
        reconciliation = beginReconciliationAction(reconciliation, { id: redispatchActionId, sequence: redispatchActionSequence, kind, recorded_at_ms: input.nowMs });
        await this.transitionOnce(entryId, entry.observed_state, entry.condition, `persisted ${kind} action intent`, actor, reconciliation);
      },
    });
    const finalReconciliation = result.disposition === "failed"
      ? recordReconciliationActionFailure(reconciliation, redispatchActionId, input.nowMs)
      : result.disposition === "executed"
        ? completeReconciliationAction(reconciliation, redispatchActionId)
        : reconciliation;
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state || target.condition !== entry.condition || JSON.stringify(finalReconciliation) !== JSON.stringify(reconciliation)) {
      await this.transitionOnce(entryId, target.observedState, target.condition, result.decision.reason, actor, finalReconciliation);
    }
    return result;
  }

  private async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reconciliationTicks.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.reconciliationTicks.set(entryId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.reconciliationTicks.get(entryId) === tail) this.reconciliationTicks.delete(entryId);
    }
  }

  /** Provider terminal callback: records an actual exit edge before the next tick. */
  async observeProviderExit(entryId: string, terminal: ProviderActionTerminal, actor = "provider", expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeEntryTick(entryId, () => this.observeProviderExitOnce(entryId, terminal, actor, expectedExecutionGenerationId, expectedHandle));
  }

  private async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      const payload = this.terminalPayload(terminal, actor);
      if (entry.condition === "quarantined") {
        // A stale child cannot unquarantine the entry, but its immutable death
        // evidence must still reach the durable operator inbox.
        await this.transitionOnce(entryId, entry.observed_state, "quarantined", `late provider terminal: ${terminal.terminalCause}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "quarantine_death", payload);
        return;
      }
      const intentional = entry.desired_state === "stopped" || entry.desired_state === "paused";
      const observedState = entry.desired_state === "paused" ? "paused" : intentional ? "stopped" : "failed";
      const reconciliation = { ...advanceReconciliationState(entry.reconciliation, observedState, this.nowMs()), last_terminal: payload };
      await this.transitionOnce(entryId, observedState, "none", `provider terminal: ${terminal.terminalCause}`, actor, reconciliation);
    });
  }

  /** Starts periodic convergence and joins provider onExit to the same durable path. */
  async scheduleConvergence(entryId: string, handle: ProviderActionHandle, input: () => DaemonReconcileInput, watchdogThresholdMs: number, intervalMs: number, actor = "reconciler"): Promise<() => Promise<void>> {
    const providerPort = this.providerPort;
    if (!providerPort) throw new Error("Provider action port is unavailable");
    const existing = this.scheduledConvergence.get(entryId);
    if (existing) return (await existing).dispose;
    let resolveReservation!: (control: { dispose: () => Promise<void> }) => void;
    const reservation = new Promise<{ dispose: () => Promise<void> }>((resolve) => { resolveReservation = resolve; });
    this.scheduledConvergence.set(entryId, reservation);
    let timer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe = () => {};
    try {
      let stopped = false;
      let currentHandle = handle;
      let currentHandleGeneration = 0;
      let listenerInstalledGeneration = 0;
      let listenerInstallTail: Promise<void> = Promise.resolve();
      const activeCallbacks = new Set<Promise<void>>();
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        unsubscribe();
        if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
        if (this.scheduledConvergenceCancels.get(entryId) === cancel) this.scheduledConvergenceCancels.delete(entryId);
      };
      this.scheduledConvergenceCancels.set(entryId, cancel);
      const trackCallback = (operation: Promise<void>) => {
        activeCallbacks.add(operation);
        void operation.then(() => activeCallbacks.delete(operation), () => activeCallbacks.delete(operation));
      };
      const recordError = async (error: unknown) => this.recordSchedulerFailure(entryId, error, actor);
      const sameHandle = (left: ProviderActionHandle, right: ProviderActionHandle) => left.workAttemptId === right.workAttemptId && left.pid === right.pid && left.providerContinuationId === right.providerContinuationId;
      const recordStaleExit = async (staleHandle: ProviderActionHandle, terminal: ProviderActionTerminal) => {
        const payload = this.terminalPayload(terminal, actor);
        await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
          const manifest = await this.store.load();
          const entry = manifest.entries.find((candidate) => candidate.id === entryId);
          if (!entry) return;
          await this.transitionOnce(entryId, entry.observed_state, entry.condition, `stale terminal from superseded provider handle pid=${staleHandle.pid ?? "unknown"}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "coordination_escalation", payload);
        }));
      };
      const installExitListener = async (nextHandle: ProviderActionHandle, generation: number) => {
        let nextUnsubscribe: () => void;
        try { nextUnsubscribe = await providerPort.onExit(nextHandle, (terminal) => {
          const operation = (async () => {
            try {
              if (generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) {
                await recordStaleExit(nextHandle, terminal);
                return;
              }
              await this.observeProviderExit(entryId, terminal, actor);
              await tick();
            } catch (error) {
              try { await recordError(error); } catch { /* A fenced daemon cannot persist after losing authority. */ }
            }
          })();
          trackCallback(operation);
        }); } catch (error) {
          if (generation > 1) throw new ReplacementListenerInstallError(error instanceof Error ? error.message : "replacement listener installation failed");
          throw error;
        }
        if (stopped || generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) { nextUnsubscribe(); return; }
        const previousUnsubscribe = unsubscribe;
        unsubscribe = nextUnsubscribe;
        listenerInstalledGeneration = generation;
        previousUnsubscribe();
      };
      const enqueueExitListenerInstall = (nextHandle: ProviderActionHandle, generation: number) => {
        const operation = listenerInstallTail.then(() => installExitListener(nextHandle, generation));
        listenerInstallTail = operation.catch(() => undefined);
        return operation;
      };
      const queueExitListenerInstall = (nextHandle: ProviderActionHandle) => {
        // Promotion is intentionally before the await inside `onExit`: a late
        // terminal from the superseded child is evidence, never a new restart.
        currentHandle = nextHandle;
        currentHandleGeneration += 1;
        const generation = currentHandleGeneration;
        return enqueueExitListenerInstall(nextHandle, generation);
      };
      let tickTail: Promise<void> = Promise.resolve();
      const tick = () => {
        const operation = tickTail.then(async () => {
          if (stopped) return;
          if (listenerInstalledGeneration !== currentHandleGeneration) await enqueueExitListenerInstall(currentHandle, currentHandleGeneration);
          const result = await this.reconcile(entryId, { ...input(), handle: currentHandle }, watchdogThresholdMs, actor);
          if (!stopped && result.replacementHandle) await queueExitListenerInstall(result.replacementHandle);
        });
        // A failed action is durably escalated by the caller, but must not
        // prevent the next convergence edge from observing the new handle.
        tickTail = operation.catch(() => undefined);
        return operation;
      };
      timer = setInterval(() => {
        trackCallback(tick().catch(async (error) => { try { await recordError(error); } catch { /* See terminal callback. */ } }));
      }, intervalMs);
      await queueExitListenerInstall(handle);
      // A replacement may already exist when its listener bridge transiently
      // fails. Keep the scheduler alive: the next serialized tick retries the
      // same promoted handle instead of launching another child.
      try { await tick(); } catch (error) {
        if (error instanceof ReplacementListenerInstallError) await recordError(error);
        else throw error;
      }
      const dispose = async () => {
        cancel();
        await Promise.all([...activeCallbacks]);
      };
      resolveReservation({ dispose });
      return dispose;
    } catch (error) {
      this.scheduledConvergenceCancels.get(entryId)?.();
      try { await this.recordSchedulerFailure(entryId, error, actor); } catch { /* Preserve the original setup failure for the caller. */ }
      resolveReservation({ dispose: async () => {} });
      if (this.scheduledConvergence.get(entryId) === reservation) this.scheduledConvergence.delete(entryId);
      throw error;
    }
  }

  private async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestMutation;
    let release!: () => void;
    this.manifestMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.singleton.assertCurrent();
      return await operation();
    } finally { release(); }
  }

  private writeManifest(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    legacyOwners?: LegacyLaneOwner[],
  ) {
    return this.store.write(expectedGeneration, entries, legacyOwners, (commit) => this.fenceDaemonCommit(commit));
  }

  private fenceDaemonCommit(commit: () => Promise<void>): Promise<void> {
    return this.serializeManifestCommit(async () => {
      if (this.handoffScheduled) throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
      await this.singleton.assertCurrent();
      await commit();
    });
  }

  private async serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.manifestCommit;
    let release!: () => void;
    this.manifestCommit = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload {
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.singleton.currentGeneration,
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  private async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown scheduler failure";
    await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const condition = entry.condition === "quarantined" ? "quarantined" : "coordination_blocked";
      await this.transitionOnce(entryId, entry.observed_state, condition, `convergence scheduler failure: ${message}`, actor, undefined, "coordination_escalation");
    }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { ProviderActionPortRouter } = await import("./provider-action-port-router.js");
    const daemon = new SupervisorDaemon(defaultDaemonPaths(), process.platform, new ProviderActionPortRouter(), true);
    await daemon.start();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
