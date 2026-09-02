import type { WorkDurabilityStore } from "./durability-store.js";
import { deliveryDrainBlocksRuntime } from "./delivery-drain.js";
import type { ManifestStore } from "./manifest-store.js";
import {
  sameProviderActionConnectionSnapshot,
  type ProviderActionConnectionRef,
  type ProviderActionHandle,
} from "./provider-action-port.js";
import {
  isAllowedCursorProviderStateTransition,
  isIdleCursorConnection,
  isLiveCursorConnection,
} from "./provider-state-policy.js";
import { DaemonFenceLostError } from "./singleton.js";
import type {
  SupervisedAuthorityScope,
  SupervisedDeliveryAuthority,
  SupervisedIngressAgent,
} from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { PreparedRuntime } from "./execution-capture-coordinator.js";
import { lifecycleAuthorityModeForProvider } from "./lifecycle-authority-mode.js";

type ProviderCheckpointAuthority = {
  isHandoffScheduled: () => boolean;
  assertCurrent: () => Promise<void>;
  currentDaemonGeneration: () => number;
  currentManifestGeneration: () => number;
  acceptManifestGeneration: (generation: number) => void;
  fenceCommit: (commit: () => Promise<void>) => Promise<void>;
  fenceAdmittedTransitionCommit: (commit: () => Promise<void>) => Promise<void>;
};

export type ProviderCheckpointCoordinatorOptions = {
  store: ManifestStore;
  bindings: WorkerBindingStore;
  inbox: SupervisedAgentInboxStore;
  durability: WorkDurabilityStore;
  liveHandles: Map<string, ProviderActionHandle>;
  authority: ProviderCheckpointAuthority;
  serializeEntry: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
  serializeManifest: <T>(operation: () => Promise<T>) => Promise<T>;
  scheduleRecovery: (entryId: string, delayMs: number) => void;
  nowMs: () => number;
  observePreparedRuntime?: (runtime: PreparedRuntime) => void;
  activateCommittedCursorRuntime?: (input: {
    entry: NonNullable<Awaited<ReturnType<ManifestStore["getEntry"]>>>;
    handle: ProviderActionHandle,
    executionGenerationId: string,
    authorityMode?: ReturnType<typeof lifecycleAuthorityModeForProvider> | null;
  }) => void;
};

/**
 * Owns exact Cursor provider-state checkpoints and supervised-lane authority
 * validation. Every successful checkpoint revalidates the manifest, binding,
 * live handle, credential, and inbox turn under daemon serialization.
 */
export class ProviderCheckpointCoordinator {
  private readonly store: ManifestStore;
  private readonly bindings: WorkerBindingStore;
  private readonly inbox: SupervisedAgentInboxStore;
  private readonly durability: WorkDurabilityStore;
  private readonly liveHandles: Map<string, ProviderActionHandle>;
  private readonly authority: ProviderCheckpointAuthority;
  private readonly serializeEntry: ProviderCheckpointCoordinatorOptions["serializeEntry"];
  private readonly serializeManifest: ProviderCheckpointCoordinatorOptions["serializeManifest"];
  private readonly scheduleRecovery: ProviderCheckpointCoordinatorOptions["scheduleRecovery"];
  private readonly nowMs: () => number;
  private readonly observePreparedRuntime: ProviderCheckpointCoordinatorOptions["observePreparedRuntime"];
  private readonly activateCommittedCursorRuntime: ProviderCheckpointCoordinatorOptions["activateCommittedCursorRuntime"];

  constructor(options: ProviderCheckpointCoordinatorOptions) {
    this.store = options.store;
    this.bindings = options.bindings;
    this.inbox = options.inbox;
    this.durability = options.durability;
    this.liveHandles = options.liveHandles;
    this.authority = options.authority;
    this.serializeEntry = options.serializeEntry;
    this.serializeManifest = options.serializeManifest;
    this.scheduleRecovery = options.scheduleRecovery;
    this.nowMs = options.nowMs;
    this.observePreparedRuntime = options.observePreparedRuntime;
    this.activateCommittedCursorRuntime = options.activateCommittedCursorRuntime;
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  async checkpointPreparedTurn(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor"
      || providerConnection.kind !== "cursor_cli"
      || providerContinuationId !== agent.providerContinuationId
      || providerConnection.pid === null
      || !providerConnection.processIdentity?.trim()
      || !agent.handle) {
      throw new Error("Only an exact paused Cursor wrapper may cross the prepared-turn boundary.");
    }
    const expectedConnection = agent.providerConnection;
    if (!isIdleCursorConnection(expectedConnection)) {
      throw new DaemonFenceLostError("Cursor prepared turn did not begin from the exact idle runtime state.");
    }
    await this.serializeEntry(agent.agentId, () => this.serializeManifest(async () => {
      if (this.authority.isHandoffScheduled()) {
        throw new DaemonFenceLostError("Cursor prepared turn changed during daemon handoff.");
      }
      await this.authority.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.bindings.get(agent.agentId);
      const currentCredential = binding ? await this.bindings.credentialFor(binding) : null;
      if (!current
        || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || current.provider_ref.provider_continuation_id !== agent.providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, expectedConnection)
        || !binding
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)) {
        throw new DaemonFenceLostError("Cursor prepared turn no longer belongs to the exact supervised lane.");
      }
      const configuration = await this.store.getAgentConfiguration(agent.agentId);
      const configurationRevision = configuration?.runtime_configuration_revision;
      if (!Number.isSafeInteger(configurationRevision) || configurationRevision! < 1
        || (agent.handle.appliedConfigurationRevision !== undefined
          && agent.handle.appliedConfigurationRevision !== configurationRevision)) {
        throw new DaemonFenceLostError("Cursor prepared turn lost its exact applied configuration.");
      }
      agent.handle.appliedConfigurationRevision = configurationRevision;
      try {
        const checkpoint = await this.store.checkpointCursorPreparedTurn(
          this.authority.currentManifestGeneration(),
          {
            agentId: agent.agentId,
            roomId: agent.roomId,
            inboxItemId,
            providerTurnId,
            providerContinuationId,
            workAttemptId: agent.workAttemptId,
            executionGenerationId: agent.executionGenerationId,
            agentSessionId: agent.agentSessionId,
            credentialRef: binding.credential_ref,
            apiUrl: agent.apiUrl,
            expectedProviderContinuationId: agent.providerContinuationId!,
            expectedProviderConnection: expectedConnection,
            providerConnection,
            configurationRevision: configurationRevision!,
            requestedAuthorityMode: lifecycleAuthorityModeForProvider("cursor", "daemon_inbox"),
            observedAt: new Date(this.nowMs()).toISOString(),
          },
          (commit) => this.authority.fenceCommit(commit),
        );
        this.authority.acceptManifestGeneration(checkpoint.generation);
        agent.providerConnection = providerConnection;
        this.activateCommittedCursorRuntime?.({ entry: checkpoint.entry, handle: agent.handle,
          executionGenerationId: agent.executionGenerationId, authorityMode: checkpoint.authorityMode });
        this.observePrepared(agent, providerConnection, configurationRevision!);
      } catch (error) {
        // A commit fence may report failure after SQLite committed. The paired
        // manifest+inbox read proves whether the atomic boundary won.
        const [persisted, inbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.inbox.get(inboxItemId).catch(() => null),
          this.bindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.bindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && inbox?.agent_id === agent.agentId
          && inbox.room_id === agent.roomId
          && inbox.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)) {
          const manifest = await this.store.load();
          this.authority.acceptManifestGeneration(manifest.generation);
          agent.providerConnection = providerConnection;
          const authorityMode = await this.store.readRuntimeLifecycleAuthority({
            agentId: agent.agentId,
            executionGenerationId: agent.executionGenerationId,
            providerConnection,
            configurationRevision: configurationRevision!,
          });
          if (!authorityMode) throw error;
          this.activateCommittedCursorRuntime?.({ entry: persisted, handle: agent.handle,
            executionGenerationId: agent.executionGenerationId, authorityMode });
          this.observePrepared(agent, providerConnection, configurationRevision!);
          return;
        }
        throw error;
      }
    }));
  }

  private observePrepared(agent: SupervisedIngressAgent, connection: ProviderActionConnectionRef, revision: number | undefined): void {
    if (!agent.handle || revision === undefined) return;
    try {
      this.observePreparedRuntime?.({ agentId: agent.agentId, executionGenerationId: agent.executionGenerationId,
        handle: agent.handle, connection, configurationRevision: revision });
    } catch { /* A committed prepared turn never fails because optional capture did. */ }
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  async checkpointDynamicState(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor" || providerConnection.kind !== "cursor_cli"
      || !providerContinuationId.trim() || !agent.handle) {
      throw new Error("Only an exact live Cursor lane may checkpoint dynamic provider state.");
    }
    const completingAdmittedCursorState = isLiveCursorConnection(agent.providerConnection)
      && isAllowedCursorProviderStateTransition(
        agent.providerContinuationId,
        agent.providerConnection,
        providerContinuationId,
        providerConnection,
      );
    await this.serializeEntry(agent.agentId, () => this.serializeManifest(async () => {
      if (this.authority.isHandoffScheduled() && !completingAdmittedCursorState) {
        throw new DaemonFenceLostError("Cursor provider state changed during daemon handoff.");
      }
      await this.authority.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.bindings.get(agent.agentId);
      const currentCredential = binding ? await this.bindings.credentialFor(binding) : null;
      const currentProviderStateMatchesAgent = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === agent.providerContinuationId
        && sameProviderActionConnectionSnapshot(
          current.provider_ref.provider_connection ?? null,
          agent.providerConnection,
        ));
      const currentProviderStateMatchesCandidate = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === providerContinuationId
        && sameProviderActionConnectionSnapshot(
          current.provider_ref.provider_connection ?? null,
          providerConnection,
        ));
      const inbox = await this.inbox.get(inboxItemId);
      if (!current || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || (!currentProviderStateMatchesAgent && !currentProviderStateMatchesCandidate)
        || !inbox
        || inbox.agent_id !== agent.agentId
        || inbox.room_id !== agent.roomId
        || inbox.provider_turn_id !== providerTurnId
        || !["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
        || !binding
        || binding.entry_id !== agent.agentId
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)
        || !isAllowedCursorProviderStateTransition(
          agent.providerContinuationId,
          agent.providerConnection,
          providerContinuationId,
          providerConnection,
        )) {
        throw new DaemonFenceLostError("Cursor provider state no longer belongs to the exact supervised lane.");
      }
      try {
        let committedEntry = current;
        if (current.provider_ref.provider_continuation_id !== providerContinuationId
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, providerConnection)) {
          const checkpoint = await this.store.checkpointCursorProviderState(
            this.authority.currentManifestGeneration(),
            {
              agentId: agent.agentId,
              roomId: agent.roomId,
              inboxItemId,
              providerTurnId,
              workAttemptId: agent.workAttemptId,
              executionGenerationId: agent.executionGenerationId,
              agentSessionId: agent.agentSessionId,
              credentialRef: binding.credential_ref,
              apiUrl: agent.apiUrl,
              expectedProviderContinuationId: agent.providerContinuationId!,
              expectedProviderConnection: agent.providerConnection,
              providerContinuationId,
              providerConnection,
              observedAt: new Date().toISOString(),
            },
            (commit) => completingAdmittedCursorState
              ? this.authority.fenceAdmittedTransitionCommit(commit)
              : this.authority.fenceCommit(commit),
          );
          this.authority.acceptManifestGeneration(checkpoint.generation);
          committedEntry = checkpoint.entry;
        }
        this.activateCommittedCursorRuntime?.({ entry: committedEntry, handle: agent.handle,
          executionGenerationId: agent.executionGenerationId,
          ...(isIdleCursorConnection(providerConnection) ? { authorityMode: null } : {}) });
        // Manifest and live handle now agree. Advance the in-memory ingress
        // authority before the separate attempt checkpoint so a failure in the
        // latter cannot split manifest=new from agent/handle=old.
        agent.providerContinuationId = providerContinuationId;
        agent.providerConnection = providerConnection;
        const attempt = await this.durability.getAttempt(agent.workAttemptId);
        if (attempt.checkpoints.at(-1)?.provider_continuation_id !== providerContinuationId) {
          try {
            await this.durability.checkpoint(agent.workAttemptId, {
              room_cursor: null,
              provider_continuation_id: providerContinuationId,
            });
          } catch {
            // The manifest is the authoritative live runtime reference. A
            // secondary attempt-history checkpoint must not make the adapter
            // reap an already-authorized turn; convergence retries it.
            this.scheduleRecovery(agent.agentId, 1_000);
          }
        }
      } catch (error) {
        // An SQLite/filesystem boundary can report failure after committing.
        // Re-read the manifest and converge in-memory authority when the exact
        // new handle/ref is already durable; the next retry then only needs to
        // finish the idempotent attempt checkpoint.
        const [persisted, recoveredInbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.inbox.get(inboxItemId).catch(() => null),
          this.bindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.bindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && recoveredInbox?.agent_id === agent.agentId
          && recoveredInbox.room_id === agent.roomId
          && recoveredInbox.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(recoveredInbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)
          && isAllowedCursorProviderStateTransition(
            agent.providerContinuationId,
            agent.providerConnection,
            providerContinuationId,
            providerConnection,
          )) {
          const manifest = await this.store.load();
          this.authority.acceptManifestGeneration(manifest.generation);
          this.activateCommittedCursorRuntime?.({ entry: persisted, handle: agent.handle,
            executionGenerationId: agent.executionGenerationId,
            ...(isIdleCursorConnection(providerConnection) ? { authorityMode: null } : {}) });
          agent.providerContinuationId = providerContinuationId;
          agent.providerConnection = providerConnection;
          return;
        }
        throw error;
      }
    }));
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  async isExactAuthority(
    authority: SupervisedDeliveryAuthority,
    scope: SupervisedAuthorityScope = "settled_provider_state",
  ): Promise<boolean> {
    if (this.authority.isHandoffScheduled()) return false;
    if (deliveryDrainBlocksRuntime(await this.store.unresolvedDeliveryDrain(authority.agentId))) return false;
    try {
      await this.authority.assertCurrent();
    } catch {
      return false;
    }
    if (authority.daemonGeneration !== this.authority.currentDaemonGeneration()) return false;
    const entry = await this.store.getEntry(authority.agentId);
    const handle = this.liveHandles.get(authority.agentId);
    if (!entry
      || entry.id !== authority.agentId
      || entry.room_id !== authority.roomId
      || entry.desired_state !== "running"
      || entry.delivery_mode !== "daemon_inbox"
      || entry.provider !== authority.provider
      || entry.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.execution_generation_id !== authority.executionGenerationId) return false;
    const binding = await this.bindings.get(authority.agentId);
    if (!binding
      || binding.entry_id !== authority.agentId
      || binding.room_id !== authority.roomId
      || binding.api_url !== authority.apiUrl
      || binding.work_attempt_id !== authority.workAttemptId
      || binding.execution_generation_id !== authority.executionGenerationId
      || binding.agent_session_id !== authority.agentSessionId) return false;
    if ((await this.bindings.credentialFor(binding)) !== authority.bearer) return false;
    // Ingress authority deliberately survives loss of provider execution. A
    // bounded turn requires the exact live handle in addition to this route.
    if (!authority.handle) return true;
    if (!handle
      || handle !== authority.handle
      || handle.workAttemptId !== authority.workAttemptId) return false;
    if (scope === "lane_lease") return true;
    if (["failed", "stopping", "stopped"].includes(entry.observed_state)
      || ["failed", "stopping", "stopped"].includes(handle.observedState)) return false;
    if (handle.pid !== (authority.providerConnection?.pid ?? null)) return false;
    return entry.provider_ref?.provider_continuation_id === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref?.provider_connection ?? null,
        authority.providerConnection,
      )
      && handle.providerContinuationId === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        handle.providerConnection ?? null,
        authority.providerConnection,
      );
  }
}
