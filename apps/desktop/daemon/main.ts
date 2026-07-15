import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AuditLog } from "./audit-log.js";
import { DaemonControlSocket } from "./control-socket.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { ManifestStore } from "./manifest-store.js";
import { assertMacOS } from "./platform.js";
import type { ProviderActionHandle, ProviderActionPort, ProviderActionRef, ProviderActionStreamEvent, ProviderActionTerminal } from "./provider-action-port.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import { advanceReconciliationState, beginReconciliationAction, completeReconciliationAction, recordReconciliationActionFailure } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { DAEMON_IMPLEMENTATION_VERSION, DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DesiredState, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";

type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath">>;
type LiveBindingIdentity = { agentSessionId: string; executionGenerationId: string; updatedAt: string };

export type DaemonReconcileInput = Omit<ReconcilerExecutionInput, "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

class ReplacementListenerInstallError extends Error {}

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
  private readonly providerCallbacks = new Set<Promise<void>>();
  private readonly liveBindingIdentities = new Map<string, LiveBindingIdentity>();
  private manifestCommit: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date().toISOString();
  private handoffScheduled = false;

  constructor(paths: DaemonPaths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort, private readonly autoConverge = providerPort?.constructor.name === "CodexProviderActionPort", private readonly nativeHeartbeatIntervalMs = 15_000, private readonly controlRequestBarrier?: (request: DaemonRequest) => Promise<void>) {
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
      if (request.method === "attempt.read") return this.readAttempt(String(this.paramsRecord(request.params).id ?? ""));
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }, async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); });
  }

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
    this.manifestGeneration = (await this.store.load()).generation;
    await this.recoverOrphanedLegacyReservations();
    await this.socket.start();
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  async stop(): Promise<void> {
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
    this.requestConvergence(id);
    return updated;
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
      const identity = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return Boolean(identity) && identity === expectedIdentity;
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
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (event.sequence <= lastSequence) throw new Error(`Native activity sequence ${event.sequence} is not newer than ${lastSequence}.`);
      const updated: DaemonManifestEntry = {
        ...entry,
        observed_state: event.status === "working" || event.status === "reviewing" ? "working" : event.status === "blocked" ? entry.observed_state : "idle",
        native_liveness: { state: event.status === "idle" ? "idle" : "active", observed_at: event.observed_at, detail: event.summary },
        activity: [...(entry.activity ?? []), event].slice(-200),
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
    const now = Date.now();
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
      .then(() => this.convergeManifestEntry(entryId))
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
      entry = await this.ensureWorkAttempt(entry);
      let handle = this.liveHandles.get(entry.id) ?? null;
      if (!handle && entry.provider_ref) {
        handle = await this.attachLiveProvider(entry);
      }
      if (handle) {
        if (entry.observed_state !== handle.observedState) {
          await this.transition(entry.id, handle.observedState, "none", "reattached durable provider handle", "daemon-convergence");
        }
        return;
      }

      await this.transition(entry.id, entry.provider_ref ? "recovering" : "starting", "none", entry.provider_ref ? "recovering durable provider continuation" : "starting daemon-owned provider", "daemon-convergence");
      const attempt = await this.durability.getAttempt(entry.work_attempt_id!);
      const generationNumber = attempt.execution_generations.reduce((max, candidate) => Math.max(max, candidate.generation), 0) + 1;
      const execution = await this.durability.startGeneration(attempt.work_attempt_id, "daemon-provider", generationNumber);
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
      };
      try {
        const ref = entry.provider_ref ? this.providerRef(entry) : null;
        const capabilities = await this.providerPort.capabilities(attempt.work_attempt_id, entry.provider);
        handle = ref && capabilities.resume
          ? await this.providerPort.resume(ref, { ...spawn, resumeFrom: ref })
          : await this.providerPort.spawn(spawn);
        await this.persistProviderHandle(entry.id, handle, execution.execution_generation_id);
        await this.durability.checkpoint(attempt.work_attempt_id, { room_cursor: null, provider_continuation_id: handle.providerContinuationId });
        await this.installProviderHandle(entry.id, handle, execution.execution_generation_id);
        await this.transition(entry.id, handle.observedState, "none", ref ? "provider resumed under daemon authority" : "provider launched under daemon authority", "daemon-convergence");
      } catch (error) {
        const terminal = this.terminalPayload({
          endedAt: new Date().toISOString(), exitCode: null, signal: null,
          terminalCause: "protocol_error", providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
        }, "daemon-provider");
        await this.durability.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, generation: generationNumber, actor: "daemon-provider" }).catch(() => undefined);
        throw error;
      }
      return;
    }

    let handle = this.liveHandles.get(entry.id) ?? null;
    if (!handle && entry.provider_ref) {
      handle = await this.attachLiveProvider(entry);
    }
    if (handle) {
      await this.transition(entry.id, "stopping", entry.condition, `desired state changed to ${entry.desired_state}`, "daemon-convergence");
      await this.providerPort.stop(handle, { actionId: `manifest:${entry.id}:${entry.desired_state}:${Date.now()}` });
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
    const handle = await this.providerPort!.attach(this.providerRef(entry));
    if (!handle) return null;
    await this.durability.recoverExecutionFence(ref.work_attempt_id);
    await this.installProviderHandle(entry.id, handle, ref.execution_generation_id);
    return handle;
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
      const status = current.observedState === "idle" ? "idle" : "working";
      this.trackProviderCallback(this.publishNativeActivity(entryId, "native_harness.heartbeat", status).then(() => undefined).catch(() => undefined));
    }, this.nativeHeartbeatIntervalMs);
    heartbeat.unref();
    this.liveDisposers.set(entryId, [disposeExit, disposeStream, () => clearInterval(heartbeat)]);
  }

  private async handleProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    const idle = /(?:completed|finished|idle|stopped|interrupted)$/i.test(event.method);
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    // Provider-local stream counters may restart when a replacement daemon
    // attaches. Persist a daemon-global monotonic sequence for the manifest.
    const sequence = Math.max((entry.activity?.at(-1)?.sequence ?? 0) + 1, event.sequence);
    const status = idle ? "idle" : "working";
    await this.appendActivity(entryId, {
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
    await this.publishNativeActivity(entryId, event.method, status, event.observedAt).catch(() => undefined);
  }

  private enqueueProviderStream(entryId: string, handle: ProviderActionHandle, event: ProviderActionStreamEvent): Promise<void> {
    const previous = this.providerStreamQueues.get(entryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.handleProviderStream(entryId, handle, event)).finally(() => {
      if (this.providerStreamQueues.get(entryId) === next) this.providerStreamQueues.delete(entryId);
    });
    this.providerStreamQueues.set(entryId, next);
    return next;
  }

  private async bindWorkerSession(input: { entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_session_token: string; api_url: string }): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    const attempt = await this.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const binding = await this.workerBindings.bind(input);
    this.liveBindingIdentities.set(input.entry_id, {
      agentSessionId: binding.agent_session_id,
      executionGenerationId: binding.execution_generation_id,
      updatedAt: binding.updated_at,
    });
    await this.updateManifestEntry(input.entry_id, (current) => ({
      ...current,
      last_worker_binding: {
        agent_session_id: binding.agent_session_id,
        work_attempt_id: binding.work_attempt_id,
        execution_generation_id: binding.execution_generation_id,
        updated_at: binding.updated_at,
      },
    }));
    await this.publishNativeActivity(input.entry_id, "native_harness.bound", "working");
    return { bound: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  private async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
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
          method: method.slice(0, 160),
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

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
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
      }
      if (this.liveHandles.get(entryId)) return;
      if (terminalBinding) {
        await this.workerBindings.unbind(entryId, terminalBinding.agentSessionId, terminalBinding.executionGenerationId);
      }
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
    const nextReconciliation = reconciliation ?? advanceReconciliationState(entry.reconciliation, to, Date.now());
    const noticeKind = notice ?? (condition === "quarantined" ? "quarantine_death" : condition === "coordination_blocked" ? "coordination_escalation" : undefined);
    const notices = [...(entry.reconciliation_notices ?? [])];
    if (noticeKind) notices.push({ at: new Date().toISOString(), kind: noticeKind, cause, terminal: terminal ?? nextReconciliation.last_terminal ?? undefined });
    const lastError = to === "failed" || condition !== "none"
      ? cause
      : (["working", "idle", "stopped"].includes(to) ? null : entry.last_error ?? null);
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
      await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause, actor, generation: next.generation });
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
        await this.transitionOnce(entryId, entry.observed_state, "quarantined", `late provider terminal: ${terminal.terminalCause}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, Date.now()), last_terminal: payload }, "quarantine_death", payload);
        return;
      }
      const intentional = entry.desired_state === "stopped" || entry.desired_state === "paused";
      const observedState = entry.desired_state === "paused" ? "paused" : intentional ? "stopped" : "failed";
      const reconciliation = { ...advanceReconciliationState(entry.reconciliation, observedState, Date.now()), last_terminal: payload };
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
          await this.transitionOnce(entryId, entry.observed_state, entry.condition, `stale terminal from superseded provider handle pid=${staleHandle.pid ?? "unknown"}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, Date.now()), last_terminal: payload }, "coordination_escalation", payload);
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
