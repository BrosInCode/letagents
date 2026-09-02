import { apiFetch } from "./auth.js";
import { getOrCreateDesktopHostId } from "./agents/state.js";
import {
  DesktopSecureStorageUnavailableError,
  desktopSupervisorGrantInstallationId,
  getOrCreateDesktopSupervisorAgentIdentity,
  getOrProvisionDesktopSupervisorGrantForAgent,
  readDesktopSupervisorGrantAgentKeyForEntry,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
  revokeDesktopSupervisorGrantForEntry,
  revokeDesktopSupervisorGrantForEntryWithoutWorkerSession,
  type DesktopSupervisorGrantAuthority,
  type DesktopSupervisorGrantMetadata,
} from "./supervisor-grant.js";
import { onSupervisorDaemonGeneration, supervisorDaemonClient, type SupervisorDaemonClient } from "./supervisor-daemon.js";
import { getJoinedRoomInfo } from "./rooms/room-info.js";
import {
  getDesktopAgentProvider,
  supervisedDeliveryModeForProvider,
} from "./agents/provider-registry.js";
import { suggestLetAgentsCodename } from "./agents/codenames.js";
import { readOpenModelSettings, type StoredOpenModelSettings } from "./agents/open-model-settings.js";
import { assertRentalSafePermissionProfile } from "./agents/rental-permission-profiles.js";
import type { DesktopSupervisorCreateInput, DesktopSupervisorManifestEntry, DesktopSupervisorRoomMove } from "../ipc-types.js";

type GrantResponse = {
  grant_id: string;
  host_id: string;
  installation_id: string;
  allowed_room_ids: string[];
  allowed_agent_keys: string[];
  current_generation: number;
  expires_at: string;
  supervisor_grant: string;
  owner_account_id: string;
  scope_key: string;
};

function metadataOf(response: GrantResponse): DesktopSupervisorGrantMetadata {
  return {
    grantId: response.grant_id,
    hostId: response.host_id,
    installationId: response.installation_id,
    allowedRoomIds: response.allowed_room_ids,
    allowedAgentKeys: response.allowed_agent_keys,
    generation: response.current_generation,
    expiresAt: response.expires_at,
  };
}

function authorityOf(response: GrantResponse): DesktopSupervisorGrantAuthority {
  const ownerAccountId = response.owner_account_id.trim();
  const scopeKey = response.scope_key.trim();
  if (!ownerAccountId || !scopeKey) throw new Error("Supervisor grant authority provenance is incomplete.");
  return { ownerAccountId, scopeKey };
}

/** Main-process orchestration result; intentionally contains no bearer. */
export type SupervisedGrantPreparation = {
  entry: DesktopSupervisorManifestEntry;
  agentKey: string;
};

export type PreparedSupervisorGrant = {
  metadata: DesktopSupervisorGrantMetadata;
  /** Null when the issuing endpoint did not attest stable owner/scope provenance. */
  authority: DesktopSupervisorGrantAuthority | null;
  token: string;
};

export type SupervisorGrantCoordinatorOperations = {
  resolveIdentity: typeof getOrCreateDesktopSupervisorAgentIdentity;
  provision: typeof getOrProvisionDesktopSupervisorGrantForAgent;
  readEntryAgentKey: typeof readDesktopSupervisorGrantAgentKeyForEntry;
  readGrant: typeof readDesktopSupervisorGrantForAgent;
  replaceGrant: typeof replaceDesktopSupervisorGrantForAgent;
  revokeEntry: typeof revokeDesktopSupervisorGrantForEntry;
  revokeEntryWithoutWorkerSession: typeof revokeDesktopSupervisorGrantForEntryWithoutWorkerSession;
};

const defaultOperations: SupervisorGrantCoordinatorOperations = {
  resolveIdentity: getOrCreateDesktopSupervisorAgentIdentity,
  provision: getOrProvisionDesktopSupervisorGrantForAgent,
  readEntryAgentKey: readDesktopSupervisorGrantAgentKeyForEntry,
  readGrant: readDesktopSupervisorGrantForAgent,
  replaceGrant: replaceDesktopSupervisorGrantForAgent,
  revokeEntry: revokeDesktopSupervisorGrantForEntry,
  revokeEntryWithoutWorkerSession: revokeDesktopSupervisorGrantForEntryWithoutWorkerSession,
};

function hasGenericSupervisedDisplayName(
  displayName: string,
  providerId: DesktopSupervisorCreateInput["providerId"],
): boolean {
  const normalized = displayName.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const provider = getDesktopAgentProvider(providerId);
  return new Set([
    `${providerId} supervised agent`,
    `${provider?.name ?? providerId} supervised agent`,
  ].map((candidate) => candidate.toLocaleLowerCase())).has(normalized);
}

/**
 * Electron is the durable custodian for a host-grant bearer. The daemon owns
 * live provider processes and dynamic worker bearer rotation. This coordinator
 * only makes the former available over one exact local daemon generation.
 */
export class SupervisorGrantCoordinator {
  private readonly entryTails = new Map<string, Promise<void>>();
  private readonly displayNameTails = new Map<string, Promise<void>>();
  private reconciliation: Promise<void> | null = null;
  private requestedDaemonGeneration: number | null = null;
  private lastReconciledDaemonGeneration: number | null = null;
  private reconciliationEventSerial = 0;
  private credentialRecoveryPending = false;
  private secureStorageAvailable: boolean | null = null;

  constructor(
    private readonly daemon: SupervisorDaemonClient = supervisorDaemonClient,
    private readonly request: typeof apiFetch = apiFetch,
    private readonly hostId: () => string = getOrCreateDesktopHostId,
    private readonly operations: SupervisorGrantCoordinatorOperations = defaultOperations,
    private readonly resolveRoomId: (roomIdentifier: string) => Promise<string> = async (roomIdentifier) => {
      const roomId = (await getJoinedRoomInfo(roomIdentifier)).room_id?.trim();
      if (!roomId) throw new Error("LetAgents did not resolve a canonical room identity for this supervised agent.");
      return roomId;
    },
    private readonly resolveOpenModelSettings: () => Promise<StoredOpenModelSettings> = readOpenModelSettings,
  ) {}

  private async serialize<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.entryTails.get(entryId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.entryTails.set(entryId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      await current;
      if (this.entryTails.get(entryId) === current) this.entryTails.delete(entryId);
    }
  }

  /**
   * Friendly names are unique within one room, so repairs must observe names
   * committed by earlier repairs even when entry reconciliation runs in
   * parallel. This tail covers only the short identity/profile mutation.
   */
  private async serializeDisplayNameMutation<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.displayNameTails.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.displayNameTails.set(roomId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      await current;
      if (this.displayNameTails.get(roomId) === current) this.displayNameTails.delete(roomId);
    }
  }

  /**
   * Fresh launch ordering is deliberate: resolve identity, provision and
   * encrypt a per-entry grant, persist a paused manifest, install to the exact
   * daemon generation, and only then allow the caller to activate ownership.
   */
  async createPausedAndInstall(input: DesktopSupervisorCreateInput): Promise<SupervisedGrantPreparation> {
    const entryId = `supervised_${input.creationRequestId?.trim() ?? ""}`;
    if (!/^supervised_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(entryId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    if (supervisedDeliveryModeForProvider(input.providerId) !== "daemon_inbox") {
      return { entry: await this.daemon.create(input), agentKey: "" };
    }
    return this.serialize(entryId, async () => {
      await this.daemon.ensureRunning();
      // Server grant scope is canonical while renderer inputs may be an alias,
      // invite code, or mixed-case Git identifier. Persist the canonical value
      // in the daemon manifest too so restart reuse compares like for like.
      const roomId = await this.resolveRoomId(input.roomIdentifier);
      const prepared = await this.serializeDisplayNameMutation(roomId, async () => {
        const displayName = hasGenericSupervisedDisplayName(input.displayName, input.providerId)
          ? suggestLetAgentsCodename(
              (await this.daemon.list(roomId)).map((entry) => entry.displayName),
              input.creationRequestId ?? entryId,
            )
          : input.displayName.trim();
        const normalizedInput = { ...input, displayName };
        const agentKey = await this.operations.resolveIdentity({
          entryId,
          displayName,
          providerId: input.providerId,
        }, { apiFetch: this.request });
        // Failure here occurs before the durable claim, hence cannot activate a
        // daemon-inbox worker without its scoped authority.
        const grant = await this.operations.provision({
          hostId: this.hostId(), entryId, agentKey,
          roomScopes: [{ requestedRoomId: input.roomIdentifier, canonicalRoomId: roomId }],
        }, { apiFetch: this.request });
        const entry = await this.daemon.create({ ...normalizedInput, roomIdentifier: roomId });
        return { entry, agentKey, grant };
      });
      // Re-read after the durable manifest write: a daemon successor may have
      // appeared while owner authority was being provisioned. No predecessor
      // received this fresh grant, so install directly into that successor.
      await this.install(
        prepared.entry,
        prepared.agentKey,
        prepared.grant,
        (await this.daemon.ensureRunning()).generation,
        false,
        false,
        prepared.entry.charter,
      );
      return { entry: prepared.entry, agentKey: prepared.agentKey };
    });
  }

  /**
   * Rental admission is authorized by the accepted-session endpoint rather
   * than ordinary room participation. The caller obtains that one-session
   * grant in Electron main, and this method applies the same durable ordering
   * and exact-daemon-generation fence as a normal supervised launch.
   */
  async createRentalPausedAndInstall(input: DesktopSupervisorCreateInput & {
    agentKey: string;
    preparedGrant: PreparedSupervisorGrant;
  }): Promise<SupervisedGrantPreparation> {
    const entryId = `supervised_${input.creationRequestId?.trim() ?? ""}`;
    if (!/^supervised_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(entryId)) {
      throw new Error("A valid supervised rental creation request id is required.");
    }
    if (supervisedDeliveryModeForProvider(input.providerId) !== "daemon_inbox") {
      throw new Error("Rented agents require daemon-owned room delivery.");
    }
    assertRentalSafePermissionProfile(input.providerId, input.permissionProfileId);
    return this.serialize(entryId, async () => {
      await this.daemon.ensureRunning();
      const roomId = await this.resolveRoomId(input.roomIdentifier);
      const agentKey = input.agentKey.trim();
      const grant = input.preparedGrant;
      if (!agentKey || !grant.token.trim()) throw new Error("Rental launch authority is incomplete.");
      if (grant.metadata.allowedRoomIds.length !== 1
        || grant.metadata.allowedRoomIds[0] !== roomId
        || grant.metadata.allowedAgentKeys.length !== 1
        || grant.metadata.allowedAgentKeys[0] !== agentKey) {
        throw new Error("Rental launch authority does not match the selected room and agent.");
      }
      const entry = await this.serializeDisplayNameMutation(roomId, async () => {
        const displayName = hasGenericSupervisedDisplayName(input.displayName, input.providerId)
          ? suggestLetAgentsCodename(
              (await this.daemon.list(roomId)).map((candidate) => candidate.displayName),
              input.creationRequestId ?? entryId,
            )
          : input.displayName.trim();
        return this.daemon.create({ ...input, displayName, roomIdentifier: roomId });
      });
      await this.operations.replaceGrant({
        agentKey,
        metadata: grant.metadata,
        authority: grant.authority,
        token: grant.token,
        entryId: entry.id,
        lastInstalledDaemonGeneration: null,
      });
      await this.install(
        entry,
        agentKey,
        {
          metadata: grant.metadata,
          authority: grant.authority,
          token: grant.token,
          entryId: entry.id,
          lastInstalledDaemonGeneration: null,
        },
        (await this.daemon.ensureRunning()).generation,
        false,
        false,
        entry.charter,
      );
      return { entry, agentKey };
    });
  }

  /** Reinstall the encrypted grant after app/daemon recovery without restarting a provider. */
  async reconcileDesiredRunning(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const startedEventSerial = this.reconciliationEventSerial;
    this.credentialRecoveryPending = false;
    const operation = this.reconcileDesiredRunningOnce();
    this.reconciliation = operation;
    try {
      await operation;
    } catch (error) {
      // Seed startup recovery before the first native probe. Once probed,
      // a credential-specific write failure is not an availability transition:
      // otherwise every unchanged successful probe would retry that failure.
      if (error instanceof DesktopSecureStorageUnavailableError && this.secureStorageAvailable === null) {
        this.secureStorageAvailable = false;
      }
      throw error;
    } finally {
      if (this.reconciliation === operation) this.reconciliation = null;
      // A new generation or credential-recovery event may arrive while this
      // pass is failing. Keep one follow-up, but never retry just because the
      // previous pass failed: unchanged auth/API failures must not spin.
      if (this.reconciliationEventSerial > startedEventSerial) {
        queueMicrotask(() => this.startScheduledReconciliation());
      }
    }
  }

  scheduleReconciliation(status: { generation: number }): void {
    if (this.requestedDaemonGeneration === status.generation) return;
    this.requestedDaemonGeneration = status.generation;
    this.reconciliationEventSerial += 1;
    this.startScheduledReconciliation();
  }

  /** A successful login is a recovery wake, not proof that any grant was installed. */
  scheduleCredentialRecovery(): void {
    this.credentialRecoveryPending = true;
    this.reconciliationEventSerial += 1;
    this.startScheduledReconciliation();
  }

  observeSecureStorageAvailability(available: boolean): void {
    const recovered = this.secureStorageAvailable === false && available;
    this.secureStorageAvailable = available;
    if (recovered) this.scheduleCredentialRecovery();
  }

  private startScheduledReconciliation(): void {
    if (this.reconciliation
      || (!this.credentialRecoveryPending
        && this.requestedDaemonGeneration === this.lastReconciledDaemonGeneration)) return;
    void this.reconcileDesiredRunning().catch((error) => {
      // No bearer is interpolated into diagnostics. The daemon continues to
      // report its paused/auth-blocked state until a later recovery succeeds.
      console.warn(`Supervisor grant reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async reconcileDesiredRunningOnce(): Promise<void> {
    const status = await this.daemon.ensureRunning();
    this.requestedDaemonGeneration = status.generation;
    const entries = await this.daemon.list(null);
    await Promise.all(entries
      // A pre-admission desktop can have a live running provider, or a
      // deliberately stopped one, without a durable daemon-inbox cursor.
      // Both need a generation-fenced tail boundary on upgrade. This is
      // admission first: installHostGrant cannot converge a cursorless entry,
      // bootstrapRoomIngress writes the boundary before running convergence,
      // and stopped entries remain stopped.
      .filter((entry) => requiresSupervisorGrant(entry)
        && (entry.desiredState === "running" || entry.desiredState === "stopped"))
      .map((entry) => entry.desiredState === "stopped"
        ? this.retireStoppedEntry(entry.id, status.generation)
        : this.reconcileEntry(
            entry,
            status.generation,
            false,
            status.capabilities?.agentRoomMove === true,
          )));
    this.lastReconciledDaemonGeneration = status.generation;
  }

  /** Install authority and commit running state in one retirement-exclusion lane. */
  async activateEntry<T>(entry: DesktopSupervisorManifestEntry, activate: () => Promise<T>): Promise<T> {
    if (!requiresSupervisorGrant(entry)) return activate();
    return this.serialize(entry.id, async () => {
      const status = await this.daemon.ensureRunning();
      await this.reconcileEntryWithinEntryTail(
        entry,
        status.generation,
        false,
        status.capabilities?.agentRoomMove === true,
      );
      return activate();
    });
  }

  /**
   * Retire live room authority without deleting the saved daemon identity,
   * provider history, or worktree. The server revocation acknowledgement is
   * durable in Electron before the daemon removes its exact local binding.
   */
  async retireEntry(entryId: string, daemonGeneration: number): Promise<void> {
    await this.serialize(entryId, () => this.retireEntryWithinEntryTail(entryId, daemonGeneration));
  }

  /** Startup cleanup must not retire an entry resumed after its stale list snapshot. */
  private async retireStoppedEntry(entryId: string, daemonGeneration: number): Promise<void> {
    await this.serialize(entryId, async () => {
      const current = (await this.daemon.list(null)).find((entry) => entry.id === entryId);
      if (!current || current.desiredState !== "stopped") return;
      await this.retireEntryWithinEntryTail(entryId, daemonGeneration);
    });
  }

  private async retireEntryWithinEntryTail(entryId: string, daemonGeneration: number): Promise<void> {
    let result = await this.daemon.retireAgent(entryId, daemonGeneration);
    if (result.outcome === "invalid") throw new Error(result.error || "Agent retirement could not be completed.");
    if (result.outcome === "revocation_required") {
      if (result.revocationKind === "worker_session" && result.agentSessionId) {
        await this.operations.revokeEntry(entryId, result.agentSessionId, { apiFetch: this.request });
        result = await this.daemon.retireAgent(entryId, daemonGeneration, result.agentSessionId);
      } else if (result.revocationKind === "grant_only") {
        await this.operations.revokeEntryWithoutWorkerSession(entryId, { apiFetch: this.request });
        result = await this.daemon.retireAgent(entryId, daemonGeneration, null, true);
      } else {
        throw new Error("Agent retirement returned incomplete revocation coordinates.");
      }
    }
    if (result.outcome !== "retired") {
      throw new Error(result.error || "Agent retirement was not durably acknowledged.");
    }
  }

  /**
   * Restore owner authority without touching the saved provider generation.
   * The daemon's explicit recovery operation owns terminal proof, worker
   * session retirement, and successor convergence.
   */
  async prepareEntryForRuntimeRecovery(entry: DesktopSupervisorManifestEntry): Promise<void> {
    if (!requiresSupervisorGrant(entry)) {
      throw new Error("This supervised provider does not support runtime recovery.");
    }
    const status = await this.daemon.ensureRunning();
    await this.reconcileEntry(
      entry,
      status.generation,
      false,
      status.capabilities?.agentRoomMove === true,
      true,
    );
  }

  /**
   * Human-triggered credential repair. It deliberately reuses the existing
   * manifest entry and provider process: this operation only restores the
   * Electron-held grant and exact-generation daemon binding. Starting a new
   * provider from a continuation remains a separate, explicit lifecycle
   * choice rather than an accidental side effect of "Reconnect".
   */
  async reconnectEntry(entry: DesktopSupervisorManifestEntry): Promise<void> {
    if (!requiresSupervisorGrant(entry)) {
      throw new Error("This supervised provider does not support credential reconnection.");
    }
    // Reconnect is deliberately narrower than recovery. It can only rotate
    // credentials for the exact provider generation and worker binding the
    // manifest still proves live. A paused/unbound entry must be resumed by
    // the explicit desired-state action instead; this method must never turn
    // a helpful-looking button into an implicit replacement launch.
    if (!hasExactReconnectTarget(entry)) {
      throw new Error("This agent no longer has a live runtime to reconnect. Recover the saved agent to start it again.");
    }
    const status = await this.daemon.ensureRunning();
    await this.reconcileEntry(entry, status.generation, true, status.capabilities?.agentRoomMove === true);
  }

  /** Complete the external half of the daemon's durable purge journal. */
  async revokeEntryForPurge(entryId: string, agentSessionId: string): Promise<void> {
    await this.serialize(entryId, () => revokeDesktopSupervisorGrantForEntry(entryId, agentSessionId, { apiFetch: this.request }));
  }

  /** Revoke only the parent grant after the daemon durably proves no worker session was minted. */
  async revokeEntryForPurgeWithoutWorkerSession(entryId: string): Promise<void> {
    await this.serialize(entryId, () => revokeDesktopSupervisorGrantForEntryWithoutWorkerSession(entryId, { apiFetch: this.request }));
  }

  /**
   * Rotate owner authority to the canonical destination, durably acknowledge
   * revocation of the exact source session, then bind the destination bearer
   * into the same daemon generation. Every step is restart-idempotent.
   */
  async prepareRoomMoveDestination(move: DesktopSupervisorRoomMove): Promise<void> {
    await this.serialize(move.entryId, () => this.prepareRoomMoveDestinationWithinEntryTail(move));
  }

  /** Restore exact source-room owner authority before daemon compensation. */
  async prepareRoomMoveSourceRollback(move: DesktopSupervisorRoomMove): Promise<void> {
    await this.serialize(move.entryId, () => this.prepareRoomMoveSourceRollbackWithinEntryTail(move));
  }

  private async reconcileEntry(
    entry: DesktopSupervisorManifestEntry,
    daemonGeneration: number,
    credentialOnly = false,
    discoverPendingRoomMove = false,
    recoveryOnly = false,
  ): Promise<void> {
    await this.serialize(entry.id, () => this.reconcileEntryWithinEntryTail(
      entry,
      daemonGeneration,
      credentialOnly,
      discoverPendingRoomMove,
      recoveryOnly,
    ));
  }

  private async reconcileEntryWithinEntryTail(
    entry: DesktopSupervisorManifestEntry,
    daemonGeneration: number,
    credentialOnly = false,
    discoverPendingRoomMove = false,
    recoveryOnly = false,
  ): Promise<void> {
    entry = await this.repairGenericDisplayName(entry);
    // A room-move journal owns both membership and credential convergence.
    // In particular, a restart can expose destination membership while the
    // encrypted grant is still source-scoped. Generic scope repair would
    // DELETE that source grant without first ending its exact source worker
    // session, permanently bypassing the move's revocation handshake.
    if (discoverPendingRoomMove
      && await this.reconcilePendingRoomMoveWithinEntryTail(entry.id, daemonGeneration)) return;
    const agentKey = await this.operations.readEntryAgentKey(entry.id);
    if (!agentKey) {
      // Legacy entries can be recovered only from a durable mapping or by
      // creating a new explicit identity. Labels are never identity inputs.
      const created = await this.operations.resolveIdentity({
        entryId: entry.id,
        displayName: entry.displayName,
        providerId: entry.provider,
      }, { apiFetch: this.request });
      await this.provisionAndInstall(entry, created, daemonGeneration, true, credentialOnly, recoveryOnly);
      return;
    }
    const stored = await this.operations.readGrant(agentKey);
    if (!stored || stored.entryId !== entry.id || !this.grantExactlyScopes(stored, entry.roomId, agentKey)) {
      // A pre-case-preservation registry can contain a truthy but invalid
      // lowercase key. Re-resolve the deterministic server identity before
      // provisioning whenever no usable encrypted grant proves this local
      // mapping, so restart recovery converges on the exact canonical key.
      const resolved = await this.operations.resolveIdentity(
        { entryId: entry.id, displayName: entry.displayName, providerId: entry.provider },
        { apiFetch: this.request },
      );
      await this.provisionAndInstall(entry, resolved, daemonGeneration, true, credentialOnly, recoveryOnly);
      return;
    }
    if (!Number.isFinite(new Date(stored.metadata.expiresAt).getTime())
      || new Date(stored.metadata.expiresAt).getTime() <= Date.now()) {
      // A daemon can rotate its short-lived worker bearer on its own while
      // this host grant remains current. Once host authority expires, only
      // Electron may recover it, before the next worker rotation wedges.
      await this.provisionAndInstall(entry, agentKey, daemonGeneration, true, credentialOnly, recoveryOnly);
      return;
    }
    if (stored.lastInstalledDaemonGeneration !== daemonGeneration) {
      const replacement = await this.handoffOrReprovision(entry, agentKey, stored, daemonGeneration);
      await this.install(entry, agentKey, replacement, daemonGeneration, credentialOnly, recoveryOnly);
      return;
    }
    // Exact same daemon generation: reinstalling is safe/idempotent and lets
    // Electron recover from a lost in-memory daemon grant.
    await this.install(entry, agentKey, stored, daemonGeneration, credentialOnly, recoveryOnly);
  }

  /**
   * Builds that predated provider-neutral identity persisted labels such as
   * "Open Model supervised agent". Repair both the server-owned participant
   * and the daemon profile while preserving the durable entry and runtime.
   */
  private async repairGenericDisplayName(
    entry: DesktopSupervisorManifestEntry,
  ): Promise<DesktopSupervisorManifestEntry> {
    if (!hasGenericSupervisedDisplayName(entry.displayName, entry.provider)) return entry;
    return this.serializeDisplayNameMutation(entry.roomId, async () => {
      // Another reconciliation may have completed while this call waited.
      const currentEntries = await this.daemon.list(entry.roomId);
      const current = currentEntries.find((candidate) => candidate.id === entry.id) ?? entry;
      if (!hasGenericSupervisedDisplayName(current.displayName, current.provider)) return current;
      const displayName = suggestLetAgentsCodename(
        currentEntries
          .filter((candidate) => candidate.id !== current.id)
          .map((candidate) => candidate.displayName),
        current.id,
      );
      const previousAgentKey = await this.operations.readEntryAgentKey(current.id);
      const resolvedAgentKey = await this.operations.resolveIdentity({
        entryId: current.id,
        displayName,
        providerId: current.provider,
      }, { apiFetch: this.request });
      if (previousAgentKey && previousAgentKey !== resolvedAgentKey) {
        throw new Error("Agent naming repair resolved a different durable server identity.");
      }
      return this.daemon.setDisplayName(current.id, displayName);
    });
  }

  /**
   * Recover a daemon-owned move before ordinary generation reconciliation is
   * allowed to inspect or mutate a saved grant. Caller must hold entryTails.
   */
  private async reconcilePendingRoomMoveWithinEntryTail(
    entryId: string,
    daemonGeneration: number,
  ): Promise<boolean> {
    let move = await this.daemon.getCurrentRoomMove({ entryId, daemonGeneration });
    if (!move) return false;
    const coordinates = {
      operationId: move.operationId,
      entryId: move.entryId,
      daemonGeneration,
    };
    for (let step = 0; step < 6 && move; step += 1) {
      if (move.phase === "rotating_credentials") {
        await this.prepareRoomMoveDestinationWithinEntryTail(move);
        move = await this.daemon.commitRoomMove(coordinates);
        continue;
      }
      if (move.phase === "rollback_required") {
        move = await this.daemon.rollbackRoomMove({
          ...coordinates,
          error: move.error ?? "Resuming durable room-move rollback during credential reconciliation.",
        });
        await this.prepareRoomMoveSourceRollbackWithinEntryTail(move);
        move = await this.daemon.commitRoomMove(coordinates);
        continue;
      }
      if (move.phase === "active" || move.phase === "failed") return true;
      const previousPhase = move.phase;
      move = await this.daemon.commitRoomMove(coordinates);
      // Waiting for a current turn, an external join retry, or destination
      // ingress remains authoritative. Block generic grant repair until a
      // later move recovery trigger advances that durable phase.
      if (move.phase === previousPhase) return true;
    }
    return true;
  }

  private async prepareRoomMoveDestinationWithinEntryTail(move: DesktopSupervisorRoomMove): Promise<void> {
    if (move.phase !== "rotating_credentials" || !move.agentSessionId) {
      throw new Error("Room move is not waiting on an exact source-session credential rotation.");
    }
    const status = await this.daemon.ensureRunning();
    if (status.generation !== move.daemonGeneration) throw new Error("Background agent management changed generation during room-move credential rotation.");
    const destination = move.remoteRoomId ?? move.destinationRoomId;
    const entry = (await this.daemon.list(null)).find((candidate) => candidate.id === move.entryId);
    if (!entry || entry.roomId !== destination || entry.workAttemptId !== move.workAttemptId
      || entry.executionGenerationId !== move.executionGenerationId) {
      throw new Error("Room-move destination no longer matches the exact live provider generation.");
    }
    const { agentKey, grant } = await this.exactGrantForRoom(
      entry,
      destination,
      status.generation,
      false,
      move.agentSessionId,
    );
    try {
      await this.daemon.acknowledgeRoomMoveSourceRevocation({
        operationId: move.operationId, entryId: move.entryId, daemonGeneration: status.generation,
        sourceAgentSessionId: move.agentSessionId,
      });
    } catch (error) {
      // The socket response can be lost after the daemon commits the exact
      // acknowledgement. Read the durable journal before deciding that
      // destination preparation failed and needs source compensation.
      const recovered = await this.daemon.getRoomMove({
        operationId: move.operationId, entryId: move.entryId, daemonGeneration: status.generation,
      }).catch(() => null);
      if (!recovered?.sourceCredentialsRevoked) throw error;
    }
    await this.install(entry, agentKey, grant, status.generation, true);
  }

  private async prepareRoomMoveSourceRollbackWithinEntryTail(move: DesktopSupervisorRoomMove): Promise<void> {
    if (move.phase !== "rollback_required") throw new Error("Room move is not awaiting source-room rollback.");
    const status = await this.daemon.ensureRunning();
    if (status.generation !== move.daemonGeneration) throw new Error("Background agent management changed generation during room-move rollback.");
    const entry = (await this.daemon.list(null)).find((candidate) => candidate.id === move.entryId);
    if (!entry || entry.roomId !== move.sourceRoomId || entry.workAttemptId !== move.workAttemptId
      || entry.executionGenerationId !== move.executionGenerationId) {
      throw new Error("Room-move rollback no longer matches the exact source provider generation.");
    }
    const { agentKey, grant } = await this.exactGrantForRoom(
      entry,
      move.sourceRoomId,
      status.generation,
      true,
      move.agentSessionId ?? entry.agentSessionId ?? undefined,
    );
    await this.install(entry, agentKey, grant, status.generation, true);
  }

  private async provisionAndInstall(
    entry: DesktopSupervisorManifestEntry,
    agentKey: string,
    daemonGeneration: number,
    forceReprovision: boolean,
    credentialOnly = false,
    recoveryOnly = false,
  ) {
    const canonicalRoomId = await this.resolveRoomId(entry.roomId);
    const grant = await this.operations.provision({
      hostId: this.hostId(), entryId: entry.id, agentKey,
      roomScopes: [{ requestedRoomId: entry.roomId, canonicalRoomId }], forceReprovision,
    }, { apiFetch: this.request });
    await this.install(entry, agentKey, grant, daemonGeneration, credentialOnly, recoveryOnly);
  }

  private grantExactlyScopes(
    stored: NonNullable<Awaited<ReturnType<SupervisorGrantCoordinatorOperations["readGrant"]>>>,
    roomId: string,
    agentKey: string,
  ): boolean {
    return stored.metadata.allowedRoomIds.length === 1
      && stored.metadata.allowedRoomIds[0] === roomId
      && stored.metadata.allowedAgentKeys.length === 1
      && stored.metadata.allowedAgentKeys[0] === agentKey
      && Number.isFinite(Date.parse(stored.metadata.expiresAt))
      && Date.parse(stored.metadata.expiresAt) > Date.now();
  }

  private async exactGrantForRoom(
    entry: DesktopSupervisorManifestEntry,
    roomId: string,
    daemonGeneration: number,
    alwaysReprovision: boolean,
    sourceAgentSessionId?: string,
  ): Promise<{
    agentKey: string;
    grant: NonNullable<Awaited<ReturnType<SupervisorGrantCoordinatorOperations["readGrant"]>>>;
  }> {
    let agentKey = await this.operations.readEntryAgentKey(entry.id);
    if (!agentKey) {
      agentKey = await this.operations.resolveIdentity({
        entryId: entry.id,
        displayName: entry.displayName,
        providerId: entry.provider,
      }, { apiFetch: this.request });
    }
    const stored = await this.operations.readGrant(agentKey);
    // A matching destination scope is not revocation evidence. Move/rollback
    // calls carry the exact source session and must enter the ownership-aware
    // storage lifecycle even when a saved grant already covers the room.
    if (!alwaysReprovision && !sourceAgentSessionId
      && stored?.entryId === entry.id && this.grantExactlyScopes(stored, roomId, agentKey)) {
      return { agentKey, grant: stored };
    }
    const grant = await this.operations.provision({
      hostId: this.hostId(), entryId: entry.id, agentKey,
      roomScopes: [{ requestedRoomId: roomId, canonicalRoomId: roomId }],
      forceReprovision: true,
      sourceAgentSessionId,
    }, { apiFetch: this.request });
    if (grant.entryId !== entry.id || !this.grantExactlyScopes(grant, roomId, agentKey)) {
      throw new Error("Owner authority provisioning returned a grant outside the exact room-move scope.");
    }
    // Provision persists before returning. Retain this explicit write for
    // injected/fake operations and to make the handoff boundary obvious.
    await this.operations.replaceGrant({
      agentKey, metadata: grant.metadata, authority: grant.authority, token: grant.token, entryId: entry.id,
      lastInstalledDaemonGeneration: null,
    });
    return { agentKey, grant };
  }

  private async handoffOrReprovision(
    entry: DesktopSupervisorManifestEntry,
    agentKey: string,
    stored: NonNullable<Awaited<ReturnType<SupervisorGrantCoordinatorOperations["readGrant"]>>>,
    daemonGeneration: number,
  ) {
    try {
      const response = await this.request<GrantResponse>(`/supervisor-host-grants/${encodeURIComponent(stored.metadata.grantId)}/handoff`, {
        method: "POST",
        headers: { Authorization: `Bearer ${stored.token}` },
        body: JSON.stringify({ generation: stored.metadata.generation }),
      });
      const metadata = metadataOf(response);
      const authority = this.replacementAuthority(stored, metadata, authorityOf(response));
      // Persist the successor before it can cross the socket. If Electron dies
      // after this point, the next reconcile can safely retry its install.
      await this.operations.replaceGrant({
        agentKey, metadata, authority, token: response.supervisor_grant, entryId: entry.id, lastInstalledDaemonGeneration: null,
      });
      return { metadata, authority, token: response.supervisor_grant, entryId: entry.id, lastInstalledDaemonGeneration: null };
    } catch (error) {
      // The handoff may have succeeded but its response was lost, or the old
      // bearer may be revoked. Owner-auth revoke/reprovision is the only safe
      // recovery; do not try an owner token in the daemon or fallback to it.
      // Rental and legacy grants have no proven owner authority, so they
      // cannot enter that owner-authenticated recovery path.
      if (!stored.authority) throw error;
      const hostId = this.hostId();
      if (stored.metadata.hostId !== hostId
        || stored.metadata.installationId !== desktopSupervisorGrantInstallationId(hostId, entry.id)) {
        throw new Error("Saved supervisor grant does not match this desktop host installation.");
      }
      const canonicalRoomId = await this.resolveRoomId(entry.roomId);
      const replacement = await this.operations.provision({
        hostId, entryId: entry.id, agentKey,
        roomScopes: [{ requestedRoomId: entry.roomId, canonicalRoomId }], forceReprovision: true,
        expectedAuthority: stored.authority,
      }, { apiFetch: this.request });
      const authority = this.replacementAuthority(stored, replacement.metadata, replacement.authority);
      return { ...replacement, authority, entryId: entry.id, lastInstalledDaemonGeneration: null };
    }
  }

  private replacementAuthority(
    stored: NonNullable<Awaited<ReturnType<SupervisorGrantCoordinatorOperations["readGrant"]>>>,
    metadata: DesktopSupervisorGrantMetadata,
    authority: DesktopSupervisorGrantAuthority | null,
  ): DesktopSupervisorGrantAuthority | null {
    if (metadata.hostId !== stored.metadata.hostId
      || metadata.installationId !== stored.metadata.installationId) {
      throw new Error("Replacement supervisor grant changed its stable host authority coordinates.");
    }
    // Rental and legacy grants are intentionally delegation-ineligible. A
    // handoff may rotate their bearer, but it cannot manufacture provenance
    // that the issuing path never authenticated for local delegation use.
    if (!stored.authority) return null;
    if (!authority
      || authority.ownerAccountId !== stored.authority.ownerAccountId
      || authority.scopeKey !== stored.authority.scopeKey) {
      throw new Error("Replacement supervisor grant changed its stable owner authority coordinates.");
    }
    return authority;
  }

  private async install(
    entry: DesktopSupervisorManifestEntry,
    agentKey: string,
    grant: {
      metadata: DesktopSupervisorGrantMetadata;
      authority: DesktopSupervisorGrantAuthority | null;
      token: string;
      entryId: string | null;
      lastInstalledDaemonGeneration: number | null;
    },
    daemonGeneration: number,
    credentialOnly = false,
    recoveryOnly = false,
    initialMessage?: string,
  ): Promise<void> {
    if (credentialOnly && recoveryOnly) {
      throw new Error("Grant installation cannot be both reconnect-only and recovery-only.");
    }
    if (entry.provider === "open-model") {
      const settings = await this.resolveOpenModelSettings();
      const model = entry.model?.trim() || settings.model.trim();
      if (!settings.baseUrl.trim() || !model) {
        throw new Error("Configure an Open Model endpoint and model before activating this agent.");
      }
      const credential = await this.daemon.installOpenModelCredential({
        entryId: entry.id,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model,
        daemonGeneration,
      });
      if (credential !== "installed") {
        throw new Error("Background agent management changed generation before the Open Model credential could be installed.");
      }
    }
    const installed = await this.daemon.installHostGrant({
      entryId: entry.id, roomId: entry.roomId, agentKey,
      grantId: grant.metadata.grantId, supervisorGrant: grant.token,
      grantGeneration: grant.metadata.generation, daemonGeneration,
      hostId: grant.metadata.hostId, installationId: grant.metadata.installationId,
      ownerAccountId: grant.authority?.ownerAccountId ?? null,
      scopeKey: grant.authority?.scopeKey ?? null,
      expiresAt: grant.metadata.expiresAt,
      credentialOnly,
      recoveryOnly,
    });
    if (installed === "provider_unavailable") {
      throw new Error("The previous provider runtime is unavailable. Reconnect cannot start a replacement; create a new agent or explicitly recover it.");
    }
    if (installed !== "installed") throw new Error("Background agent management changed generation before the host grant could be installed.");
    // Establish the immutable first inbox boundary before a fresh paused
    // launch activates provider ownership. The same one-time admission also
    // repairs pre-upgrade running/stopped entries that have no cursor yet.
    // For an existing/recovered cursor this is a no-op and cannot move it
    // forward. Bootstrap admits the cursor before any running convergence and
    // never converges a stopped provider.
    if (entry.deliveryMode === "daemon_inbox" && !recoveryOnly) {
      const bootstrapped = await this.daemon.bootstrapRoomIngress(entry.id, daemonGeneration, initialMessage);
      if (bootstrapped === "stale") throw new Error("Background agent management changed generation before room delivery could be initialized.");
    }
    // Only a confirmed exact-generation socket install advances the durable
    // marker. This write contains encrypted storage only; the renderer and
    // manifest never see the bearer.
    await this.operations.replaceGrant({
      agentKey, metadata: grant.metadata, authority: grant.authority, token: grant.token, entryId: entry.id,
      lastInstalledDaemonGeneration: daemonGeneration,
    });
  }
}

function requiresSupervisorGrant(entry: DesktopSupervisorManifestEntry): boolean {
  return entry.deliveryMode === "daemon_inbox"
    || (entry.deliveryMode === "mcp_polling" && entry.pollingContract === "custodial_polling_v1");
}

function hasExactReconnectTarget(entry: DesktopSupervisorManifestEntry): boolean {
  return entry.desiredState === "running"
    && entry.observedState !== "failed"
    && entry.nativeLiveness.state !== "terminal"
    && !/saved OpenCode process is no longer running|previous provider runtime is unavailable/i.test(entry.lastError ?? "")
    && (Boolean(entry.providerPid) || entry.provider === "cursor")
    && Boolean(entry.workAttemptId)
    && Boolean(entry.executionGenerationId)
    && Boolean(entry.providerContinuationId);
}

export const supervisorGrantCoordinator = new SupervisorGrantCoordinator();
onSupervisorDaemonGeneration((status) => supervisorGrantCoordinator.scheduleReconciliation(status));
