import { apiFetch } from "./auth.js";
import { getOrCreateDesktopHostId } from "./agents/state.js";
import {
  getOrCreateDesktopCodexAgentIdentity,
  getOrProvisionDesktopSupervisorGrantForAgent,
  readDesktopSupervisorGrantAgentKeyForEntry,
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
  type DesktopSupervisorGrantMetadata,
} from "./supervisor-grant.js";
import { supervisorDaemonClient, type SupervisorDaemonClient } from "./supervisor-daemon.js";
import { getJoinedRoomInfo } from "./rooms/room-info.js";
import type { DesktopSupervisorCreateInput, DesktopSupervisorManifestEntry } from "../ipc-types.js";

type GrantResponse = {
  grant_id: string;
  host_id: string;
  installation_id: string;
  allowed_room_ids: string[];
  allowed_agent_keys: string[];
  current_generation: number;
  expires_at: string;
  supervisor_grant: string;
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

/** Main-process orchestration result; intentionally contains no bearer. */
export type SupervisedGrantPreparation = {
  entry: DesktopSupervisorManifestEntry;
  agentKey: string;
};

export type SupervisorGrantCoordinatorOperations = {
  resolveIdentity: typeof getOrCreateDesktopCodexAgentIdentity;
  provision: typeof getOrProvisionDesktopSupervisorGrantForAgent;
  readEntryAgentKey: typeof readDesktopSupervisorGrantAgentKeyForEntry;
  readGrant: typeof readDesktopSupervisorGrantForAgent;
  replaceGrant: typeof replaceDesktopSupervisorGrantForAgent;
};

const defaultOperations: SupervisorGrantCoordinatorOperations = {
  resolveIdentity: getOrCreateDesktopCodexAgentIdentity,
  provision: getOrProvisionDesktopSupervisorGrantForAgent,
  readEntryAgentKey: readDesktopSupervisorGrantAgentKeyForEntry,
  readGrant: readDesktopSupervisorGrantForAgent,
  replaceGrant: replaceDesktopSupervisorGrantForAgent,
};

/**
 * Electron is the durable custodian for a host-grant bearer. The daemon owns
 * live provider processes and dynamic worker bearer rotation. This coordinator
 * only makes the former available over one exact local daemon generation.
 */
export class SupervisorGrantCoordinator {
  private readonly entryTails = new Map<string, Promise<void>>();

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
   * Fresh launch ordering is deliberate: resolve identity, provision and
   * encrypt a per-entry grant, persist a paused manifest, install to the exact
   * daemon generation, and only then allow the caller to activate ownership.
   */
  async createPausedAndInstall(input: DesktopSupervisorCreateInput): Promise<SupervisedGrantPreparation> {
    const entryId = `supervised_${input.creationRequestId?.trim() ?? ""}`;
    if (!/^supervised_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(entryId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    if (input.providerId !== "codex") {
      return { entry: await this.daemon.create(input), agentKey: "" };
    }
    return this.serialize(entryId, async () => {
      await this.daemon.ensureRunning();
      // Server grant scope is canonical while renderer inputs may be an alias,
      // invite code, or mixed-case Git identifier. Persist the canonical value
      // in the daemon manifest too so restart reuse compares like for like.
      const roomId = await this.resolveRoomId(input.roomIdentifier);
      const agentKey = await this.operations.resolveIdentity({ entryId, displayName: input.displayName }, { apiFetch: this.request });
      // Failure here occurs before the durable claim, hence cannot activate a
      // daemon-inbox worker without its scoped authority.
      const grant = await this.operations.provision({
        hostId: this.hostId(), entryId, agentKey, allowedRoomIds: [roomId],
      }, { apiFetch: this.request });
      const entry = await this.daemon.create({ ...input, roomIdentifier: roomId });
      // Re-read after the durable manifest write: a daemon successor may have
      // appeared while owner authority was being provisioned. No predecessor
      // received this fresh grant, so install directly into that successor.
      await this.install(entry, agentKey, grant, (await this.daemon.ensureRunning()).generation);
      return { entry, agentKey };
    });
  }

  /** Reinstall the encrypted grant after app/daemon recovery without restarting a provider. */
  async reconcileDesiredRunning(): Promise<void> {
    const status = await this.daemon.ensureRunning();
    const entries = await this.daemon.list(null);
    await Promise.all(entries
      .filter((entry) => entry.provider === "codex" && entry.deliveryMode === "daemon_inbox" && entry.desiredState === "running")
      .map((entry) => this.reconcileEntry(entry, status.generation)));
  }

  /** Install a paused entry before resume/restart activation. */
  async prepareEntryForActivation(entry: DesktopSupervisorManifestEntry): Promise<void> {
    if (entry.provider !== "codex" || entry.deliveryMode !== "daemon_inbox") return;
    const status = await this.daemon.ensureRunning();
    await this.reconcileEntry(entry, status.generation);
  }

  private async reconcileEntry(entry: DesktopSupervisorManifestEntry, daemonGeneration: number): Promise<void> {
    await this.serialize(entry.id, async () => {
      const agentKey = await this.operations.readEntryAgentKey(entry.id);
      if (!agentKey) {
        // Legacy entries can be recovered only from a durable mapping or by
        // creating a new explicit identity. Labels are never identity inputs.
        const created = await this.operations.resolveIdentity({ entryId: entry.id, displayName: entry.displayName }, { apiFetch: this.request });
        await this.provisionAndInstall(entry, created, daemonGeneration, true);
        return;
      }
      const stored = await this.operations.readGrant(agentKey);
      if (!stored || stored.entryId !== entry.id) {
        await this.provisionAndInstall(entry, agentKey, daemonGeneration, true);
        return;
      }
      if (!Number.isFinite(new Date(stored.metadata.expiresAt).getTime())
        || new Date(stored.metadata.expiresAt).getTime() <= Date.now()) {
        // A daemon can rotate its short-lived worker bearer on its own while
        // this host grant remains current. Once host authority expires, only
        // Electron may recover it, before the next worker rotation wedges.
        await this.provisionAndInstall(entry, agentKey, daemonGeneration, true);
        return;
      }
      if (stored.lastInstalledDaemonGeneration !== daemonGeneration) {
        const replacement = await this.handoffOrReprovision(entry, agentKey, stored, daemonGeneration);
        await this.install(entry, agentKey, replacement, daemonGeneration);
        return;
      }
      // Exact same daemon generation: reinstalling is safe/idempotent and
      // lets Electron recover from a lost in-memory daemon grant.
      await this.install(entry, agentKey, stored, daemonGeneration);
    });
  }

  private async provisionAndInstall(entry: DesktopSupervisorManifestEntry, agentKey: string, daemonGeneration: number, forceReprovision: boolean) {
    const grant = await this.operations.provision({
      hostId: this.hostId(), entryId: entry.id, agentKey, allowedRoomIds: [entry.roomId], forceReprovision,
    }, { apiFetch: this.request });
    await this.install(entry, agentKey, grant, daemonGeneration);
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
      // Persist the successor before it can cross the socket. If Electron dies
      // after this point, the next reconcile can safely retry its install.
      await this.operations.replaceGrant({
        agentKey, metadata, token: response.supervisor_grant, entryId: entry.id, lastInstalledDaemonGeneration: null,
      });
      return { metadata, token: response.supervisor_grant, entryId: entry.id, lastInstalledDaemonGeneration: null };
    } catch {
      // The handoff may have succeeded but its response was lost, or the old
      // bearer may be revoked. Owner-auth revoke/reprovision is the only safe
      // recovery; do not try an owner token in the daemon or fallback to it.
      return this.operations.provision({
        hostId: this.hostId(), entryId: entry.id, agentKey, allowedRoomIds: [entry.roomId], forceReprovision: true,
      }, { apiFetch: this.request });
    }
  }

  private async install(
    entry: DesktopSupervisorManifestEntry,
    agentKey: string,
    grant: { metadata: DesktopSupervisorGrantMetadata; token: string; entryId: string; lastInstalledDaemonGeneration: number | null },
    daemonGeneration: number,
  ): Promise<void> {
    const installed = await this.daemon.installHostGrant({
      entryId: entry.id, roomId: entry.roomId, agentKey,
      grantId: grant.metadata.grantId, supervisorGrant: grant.token,
      grantGeneration: grant.metadata.generation, daemonGeneration,
    });
    if (installed !== "installed") throw new Error("Background agent management changed generation before the host grant could be installed.");
    // Only a confirmed exact-generation socket install advances the durable
    // marker. This write contains encrypted storage only; the renderer and
    // manifest never see the bearer.
    await this.operations.replaceGrant({
      agentKey, metadata: grant.metadata, token: grant.token, entryId: entry.id,
      lastInstalledDaemonGeneration: daemonGeneration,
    });
  }
}

export const supervisorGrantCoordinator = new SupervisorGrantCoordinator();
