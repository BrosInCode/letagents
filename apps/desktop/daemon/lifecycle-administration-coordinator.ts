import { schedulerErrorDetail } from "./daemon-error-policy.js";
import { isEphemeralWorkspaceMarker } from "./ephemeral-workspace-provisioner.js";
import type { ManifestStore } from "./manifest-store.js";
import type {
  ProviderActionPort,
  ProviderActionRef,
  ProviderActionTerminal,
} from "./provider-action-port.js";
import type {
  DaemonManifestEntry,
  DaemonManifestEntryView,
  ExecutionTerminalPayload,
  TaskWorkAttempt,
} from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type LifecycleAdministrationStore = Pick<ManifestStore,
  | "adoptPurgeDaemonGeneration"
  | "commitPurge"
  | "durablePurgeWorkerSessionAttestation"
  | "getEntry"
  | "getAgentConfiguration"
  | "getPurge"
  | "load"
  | "markPurgeCredentialsRevoked"
  | "markPurgeGrantRevokedWithoutWorkerSession"
  | "pendingPurges"
  | "preparePurge"
  | "repreparePurgeCredentials"
>;

export type LifecycleAdministrationBindings = Pick<WorkerBindingStore,
  | "get"
  | "retireSupervisedWorkerAuthority"
  | "supervisedWorkerMintState"
  | "supervisedWorkerSession"
>;

export type LifecycleAdministrationDurability = {
  getAttempt(workAttemptId: string): Promise<TaskWorkAttempt>;
  listAttempts(): Promise<TaskWorkAttempt[]>;
  recordTerminal(
    workAttemptId: string,
    executionGenerationId: string,
    terminal: ExecutionTerminalPayload,
  ): Promise<unknown>;
  releaseTerminalExecutionFence(workAttemptId: string, executionGenerationId: string): Promise<void>;
  concludeAttempt(workAttemptId: string, input: {
    state: "cleanly_concluded";
    cause: "room_only_agent_purged";
  }): Promise<TaskWorkAttempt>;
  garbageCollectEphemeralAttempt(workAttemptId: string): Promise<boolean>;
};

export type LifecycleAdministrationRuntimeCustody = {
  deleteLiveBinding(entryId: string): unknown;
  deletePendingResumeBinding(entryId: string): unknown;
  deleteWorkerAuthorization(entryId: string): unknown;
  deleteHostGrant(entryId: string): unknown;
  deleteOpenModelCredential(entryId: string): unknown;
};

export type LifecycleAdministrationAuthority = {
  currentDaemonGeneration(): number;
  currentManifestGeneration(): number;
  acceptManifestGeneration(generation: number): void;
  assertCurrent(): Promise<void>;
  fenceCommit: CommitFence;
  serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T>;
};

export type LifecycleAdministrationPorts = {
  store: LifecycleAdministrationStore;
  bindings: LifecycleAdministrationBindings;
  durability: LifecycleAdministrationDurability;
  authority: LifecycleAdministrationAuthority;
  beginLifecycle(entryId: string): () => void;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  setDesiredStateExclusive(entryId: string, desiredState: "stopped"): Promise<DaemonManifestEntry>;
  updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
  entryWithDerivedLiveness(entry: DaemonManifestEntry): Promise<DaemonManifestEntryView>;
  stopDelivery(entryId: string): Promise<void>;
  hasLiveHandle(entryId: string): boolean;
  provider?: Pick<ProviderActionPort, "stopRef">;
  runtimeCustody: LifecycleAdministrationRuntimeCustody;
  deleteAgentStream(entryId: string): unknown;
  ephemeralProvisioner: {
    garbageCollectOrphans(retainedAttemptIds: ReadonlySet<string>): Promise<string[]>;
  };
  nowMs?: () => number;
  reportRecoveryRefusal?: (message: string, error?: unknown) => void;
};

export type RetireAgentResult =
  | { outcome: "retired"; entry: DaemonManifestEntryView }
  | { outcome: "invalid"; error: string }
  | { outcome: "revocation_required"; revocation_kind: "grant_only" }
  | {
    outcome: "revocation_required";
    revocation_kind: "worker_session";
    agent_session_id: string;
  };

export type PurgeAgentResult =
  | { outcome: "invalid"; error: string }
  | {
    outcome: "revocation_required";
    operation_id: string;
    revocation_kind: "grant_only";
  }
  | {
    outcome: "revocation_required";
    operation_id: string;
    revocation_kind: "worker_session";
    agent_session_id: string;
  }
  | { outcome: "purged"; purged_work_attempt_id?: string };

/**
 * Owns destructive agent administration and crash recovery for purge and
 * room-only workspace collection. Provider reconciliation, manifest editing,
 * and credential custody remain explicit daemon-owned ports.
 */
export class LifecycleAdministrationCoordinator {
  private readonly nowMs: () => number;
  private readonly reportRecoveryRefusal: (message: string, error?: unknown) => void;

  constructor(private readonly ports: LifecycleAdministrationPorts) {
    this.nowMs = ports.nowMs ?? Date.now;
    this.reportRecoveryRefusal = ports.reportRecoveryRefusal ?? ((message, error) => {
      if (error === undefined) console.error(message);
      else console.error(message, error);
    });
  }

  /** Retire preserves identity/history/worktree, but revokes live room authority. */
  async retireAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ): Promise<RetireAgentResult> {
    if (!entryId || daemonGeneration !== this.ports.authority.currentDaemonGeneration()
      || !(revokedAgentSessionId === null || Boolean(revokedAgentSessionId.trim()))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)) {
      throw new Error("Retire is fenced by stale or invalid lifecycle coordinates.");
    }
    const release = this.ports.beginLifecycle(entryId);
    try {
      const stoppedEntry = await this.ports.setDesiredStateExclusive(entryId, "stopped");
      if (!await this.requiresHostGrant(stoppedEntry)) {
        return {
          outcome: "retired",
          entry: await this.ports.entryWithDerivedLiveness(stoppedEntry),
        };
      }
      // Settle the shared mint/bind lane before choosing the exact revocation
      // coordinate. A late mint must not recreate authority after cleanup.
      return await this.ports.serializeEntry(entryId, async () => {
        let entry = await this.ports.store.getEntry(entryId);
        if (!entry || entry.desired_state !== "stopped") {
          return { outcome: "invalid", error: "Agent lifecycle changed before retirement cleanup." };
        }

        const [session, binding, mint] = await Promise.all([
          this.ports.bindings.supervisedWorkerSession(entryId),
          this.ports.bindings.get(entryId),
          this.ports.bindings.supervisedWorkerMintState(entryId),
        ]);
        const sessionIds = new Set<string>();
        if (session?.agent_session_id) sessionIds.add(session.agent_session_id);
        if (binding?.agent_session_id) sessionIds.add(binding.agent_session_id);
        if (mint?.phase === "exact" && mint.agent_session_id) sessionIds.add(mint.agent_session_id);
        if (sessionIds.size > 1) {
          return {
            outcome: "invalid",
            error: "Retirement found conflicting worker-session identities; no authority was removed.",
          };
        }
        const exactSessionId = sessionIds.size === 1 ? [...sessionIds][0]! : null;

        if (exactSessionId && revokedAgentSessionId !== exactSessionId) {
          if (revokedAgentSessionId) {
            return {
              outcome: "invalid",
              error: "Retirement acknowledgement belongs to a different worker session.",
            };
          }
          return {
            outcome: "revocation_required",
            revocation_kind: "worker_session",
            agent_session_id: exactSessionId,
          };
        }
        // Even a never-minted inbox agent retains a live parent grant in
        // Electron's encrypted registry, so latent mint authority is revoked.
        if (!exactSessionId && !grantRevokedWithoutWorkerSession) {
          return { outcome: "revocation_required", revocation_kind: "grant_only" };
        }
        if (!exactSessionId && revokedAgentSessionId) {
          return {
            outcome: "invalid",
            error: "Retirement no longer has the acknowledged worker session.",
          };
        }

        const current = await this.ports.store.getEntry(entryId);
        if (!current || current.desired_state !== "stopped"
          || daemonGeneration !== this.ports.authority.currentDaemonGeneration()) {
          return { outcome: "invalid", error: "Agent lifecycle changed before retirement cleanup." };
        }
        await this.ports.stopDelivery(entryId).catch(() => undefined);
        await this.ports.bindings.retireSupervisedWorkerAuthority(entryId, exactSessionId);
        this.ports.runtimeCustody.deleteLiveBinding(entryId);
        this.ports.runtimeCustody.deletePendingResumeBinding(entryId);
        this.ports.runtimeCustody.deleteWorkerAuthorization(entryId);
        this.ports.runtimeCustody.deleteHostGrant(entryId);
        entry = await this.ports.updateManifestEntry(entryId, (latest) => ({
          ...latest,
          last_worker_binding: null,
          workplace_liveness: {
            state: "stale",
            observed_at: new Date(this.nowMs()).toISOString(),
            detail: "Retired agent has no active room worker session.",
          },
        }));
        return {
          outcome: "retired",
          entry: await this.ports.entryWithDerivedLiveness(entry),
        };
      });
    } finally {
      release();
    }
  }

  /** Purge is intentionally stricter than retire and never removes a worktree. */
  async purgeAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ): Promise<PurgeAgentResult> {
    if (!entryId || daemonGeneration !== this.ports.authority.currentDaemonGeneration()) {
      throw new Error("Purge is fenced by a stale daemon generation.");
    }
    return this.ports.serializeEntry(entryId, async () => {
      const preflight = await this.ports.store.getEntry(entryId);
      if (preflight && (preflight.desired_state !== "stopped"
        || !["absent", "stopped", "failed"].includes(preflight.observed_state))) {
        return { outcome: "invalid", error: "Purge requires a fully stopped durable lifecycle." };
      }
      const cursorConnection = preflight?.provider_ref?.provider_connection?.kind === "cursor_cli"
        ? preflight.provider_ref.provider_connection
        : null;
      if (preflight && !this.ports.hasLiveHandle(entryId)
        && cursorConnection && cursorConnection.pid !== null) {
        if (!this.ports.provider?.stopRef) {
          return {
            outcome: "invalid",
            error: "Purge cannot prove the unattached Cursor wrapper is stopped.",
          };
        }
        try {
          const ref = this.providerRef(preflight);
          const terminal = await this.ports.provider.stopRef(ref, {
            actionId: `purge:${entryId}:cursor-wrapper-fence:${preflight.provider_ref!.execution_generation_id}`,
          });
          const attempt = await this.ports.durability.getAttempt(ref.workAttemptId);
          const execution = attempt.execution_generations.find((candidate) =>
            candidate.execution_generation_id === preflight.provider_ref!.execution_generation_id);
          if (!execution) {
            throw new Error("Cursor purge fence has no matching durable execution generation.");
          }
          if (!execution.terminal) {
            await this.ports.durability.recordTerminal(
              ref.workAttemptId,
              execution.execution_generation_id,
              {
                ...this.terminalPayload(terminal, execution.actor),
                actor: execution.actor,
                generation: execution.generation,
              },
            );
          }
          await this.ports.durability.releaseTerminalExecutionFence(
            ref.workAttemptId,
            execution.execution_generation_id,
          );
        } catch (error) {
          return {
            outcome: "invalid",
            error: `Purge could not fence the unattached Cursor wrapper: ${schedulerErrorDetail(error)}`,
          };
        }
      }
      return this.ports.authority.serializeManifestMutation(async () => {
        await this.ports.authority.assertCurrent();
        const operationId = `purge:${entryId}`;
        let purge = await this.ports.store.getPurge(operationId);
        const entry = await this.ports.store.getEntry(entryId);
        if (!entry) {
          return purge?.phase === "complete" || !purge
            ? {
              outcome: "purged",
              ...(purge?.attached_work_attempt_id
                ? { purged_work_attempt_id: purge.attached_work_attempt_id }
                : {}),
            }
            : {
              outcome: "invalid",
              error: "Purge identity is absent but its journal is incomplete.",
            };
        }
        if (this.ports.hasLiveHandle(entryId)) {
          return {
            outcome: "invalid",
            error: "Purge requires no live provider or bounded delivery turn.",
          };
        }
        if (!purge) {
          try {
            const externalRevokeRequired = await this.requiresHostGrant(entry);
            const evidence = externalRevokeRequired
              ? await this.ports.store.durablePurgeWorkerSessionAttestation(entryId)
              : { workerSessionAttestation: "not_required" as const, agentSessionId: null };
            purge = (await this.ports.store.preparePurge(
              this.ports.authority.currentManifestGeneration(),
              {
                operationId,
                requestId: operationId,
                agentId: entryId,
                daemonGeneration,
                externalRevokeRequired,
                workerSessionAttestation: evidence.workerSessionAttestation,
                agentSessionId: evidence.agentSessionId,
              },
            )).purge;
          } catch (error) {
            return { outcome: "invalid", error: schedulerErrorDetail(error) };
          }
        }
        if (purge.daemon_generation !== daemonGeneration) {
          purge = await this.ports.store.adoptPurgeDaemonGeneration({
            operationId,
            agentId: entryId,
            expectedDaemonGeneration: purge.daemon_generation,
            daemonGeneration,
          });
        }
        if (purge.phase === "reprepare_credentials") {
          const evidence = await this.ports.store.durablePurgeWorkerSessionAttestation(entryId);
          if (evidence.workerSessionAttestation === "unknown") {
            return {
              outcome: "invalid",
              error: "Purge credential recovery needs an exact retained worker session or durable proof that no worker session was minted.",
            };
          }
          purge = await this.ports.store.repreparePurgeCredentials({
            operationId,
            agentId: entryId,
            expectedDaemonGeneration: daemonGeneration,
            workerSessionAttestation: evidence.workerSessionAttestation,
            agentSessionId: evidence.agentSessionId,
          });
        }
        if (revokedAgentSessionId && purge.phase === "revoking_credentials") {
          purge = await this.ports.store.markPurgeCredentialsRevoked({
            operationId,
            agentId: entryId,
            expectedDaemonGeneration: daemonGeneration,
            agentSessionId: revokedAgentSessionId,
          });
        }
        if (grantRevokedWithoutWorkerSession && purge.phase === "revoking_credentials") {
          purge = await this.ports.store.markPurgeGrantRevokedWithoutWorkerSession({
            operationId,
            agentId: entryId,
            expectedDaemonGeneration: daemonGeneration,
          });
        }
        if (purge.phase === "revoking_credentials") {
          if (purge.worker_session_attestation === "exact" && purge.agent_session_id) {
            return {
              outcome: "revocation_required",
              operation_id: operationId,
              revocation_kind: "worker_session",
              agent_session_id: purge.agent_session_id,
            };
          }
          if (purge.worker_session_attestation === "none" && purge.agent_session_id === null) {
            return {
              outcome: "revocation_required",
              operation_id: operationId,
              revocation_kind: "grant_only",
            };
          }
          return {
            outcome: "invalid",
            error: "Purge revocation evidence is internally inconsistent.",
          };
        }
        if (purge.phase === "complete") return this.purgedResult(purge.attached_work_attempt_id);
        if (purge.phase !== "local_commit") {
          return {
            outcome: "invalid",
            error: purge.error ?? "Purge journal is not committable.",
          };
        }
        try {
          if (purge.attached_work_attempt_id) {
            await this.removeEphemeralWorkAttempt(purge.attached_work_attempt_id);
          }
          const committed = await this.ports.store.commitPurge(
            this.ports.authority.currentManifestGeneration(),
            { operationId, agentId: entryId, daemonGeneration },
            this.ports.authority.fenceCommit,
          );
          this.ports.authority.acceptManifestGeneration(committed.generation);
        } catch (error) {
          return { outcome: "invalid", error: schedulerErrorDetail(error) };
        }
        this.ports.runtimeCustody.deleteLiveBinding(entryId);
        this.ports.runtimeCustody.deleteWorkerAuthorization(entryId);
        this.ports.runtimeCustody.deleteHostGrant(entryId);
        this.ports.runtimeCustody.deleteOpenModelCredential(entryId);
        this.ports.deleteAgentStream(entryId);
        return this.purgedResult(purge.attached_work_attempt_id);
      });
    });
  }

  async recoverPreparedPurges(): Promise<void> {
    for (const purge of await this.ports.store.pendingPurges()) {
      if (purge.phase !== "local_commit") continue;
      await this.purgeAgent(
        purge.agent_id,
        this.ports.authority.currentDaemonGeneration(),
        null,
        false,
      ).catch(() => undefined);
    }
  }

  async removeEphemeralWorkAttempt(workAttemptId: string): Promise<boolean> {
    let attempt = await this.ports.durability.getAttempt(workAttemptId);
    if (!isEphemeralWorkspaceMarker(attempt.workspace_identity)) return false;
    if (!attempt.concluded_at && !["gc_pending", "garbage_collected"].includes(attempt.state)) {
      attempt = await this.ports.durability.concludeAttempt(workAttemptId, {
        state: "cleanly_concluded",
        cause: "room_only_agent_purged",
      });
    }
    if (attempt.state !== "garbage_collected") {
      await this.ports.durability.garbageCollectEphemeralAttempt(workAttemptId);
    }
    return true;
  }

  async recoverEphemeralWorkspaces(): Promise<void> {
    const manifest = await this.ports.store.load();
    const attached = new Set<string>();
    for (const entry of manifest.entries) {
      if (entry.work_attempt_id) attached.add(entry.work_attempt_id);
      if (entry.provider_ref?.work_attempt_id) attached.add(entry.provider_ref.work_attempt_id);
    }
    for (const purge of await this.ports.store.pendingPurges()) {
      if (purge.attached_work_attempt_id) attached.add(purge.attached_work_attempt_id);
    }
    for (const attempt of await this.ports.durability.listAttempts()) {
      if (!isEphemeralWorkspaceMarker(attempt.workspace_identity)
        || attached.has(attempt.work_attempt_id)) continue;
      if (attempt.execution_generations.some((generation) => generation.terminal === null)) {
        this.reportRecoveryRefusal(
          `Refusing to collect orphaned room-only attempt ${attempt.work_attempt_id}: live execution evidence remains.`,
        );
        continue;
      }
      await this.removeEphemeralWorkAttempt(attempt.work_attempt_id).catch((error) => {
        this.reportRecoveryRefusal(
          `Refusing to collect orphaned room-only attempt ${attempt.work_attempt_id}:`,
          error,
        );
      });
    }
    const retained = new Set(
      (await this.ports.durability.listAttempts()).map((attempt) => attempt.work_attempt_id),
    );
    await this.ports.ephemeralProvisioner.garbageCollectOrphans(retained);
  }

  private async requiresHostGrant(entry: DaemonManifestEntry): Promise<boolean> {
    if (entry.delivery_mode === "daemon_inbox") return true;
    const configuration = await this.ports.store.getAgentConfiguration(entry.id);
    if (!configuration) throw new Error("Agent credential custody configuration is unavailable.");
    return Boolean(configuration.polling_contract);
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

  private terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload {
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.ports.authority.currentDaemonGeneration(),
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  private purgedResult(attachedWorkAttemptId: string | null): PurgeAgentResult {
    return {
      outcome: "purged",
      ...(attachedWorkAttemptId
        ? { purged_work_attempt_id: attachedWorkAttemptId }
        : {}),
    };
  }
}
