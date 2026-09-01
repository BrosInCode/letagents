import { isDeepStrictEqual } from "node:util";

import type { ProviderConfigurationSnapshot, ProviderReasoningEffort } from "./provider-configuration.js";
import type {
  DaemonActivityEvent,
  DaemonAgentConfiguration,
  DaemonManifest,
  DaemonManifestEntry,
  DaemonPurgeRecord,
  LegacyLaneOwner,
} from "./types.js";

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type StoredAgentConfiguration = {
  provider: string;
  model: string | null;
  reasoning_effort: DaemonAgentConfiguration["reasoning_effort"];
  charter: string;
  permission_profile_id: string | null;
  provider_launch_policy: unknown;
  config_revision: number;
  runtime_configuration_revision: number;
  polling_contract?: DaemonAgentConfiguration["polling_contract"];
};

export type ManifestAdministrationStore = {
  load(): Promise<DaemonManifest>;
  getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  getPurge(operationId: string): Promise<DaemonPurgeRecord | null | undefined>;
  write(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    legacyLaneOwners: LegacyLaneOwner[] | undefined,
    commitFence: CommitFence,
  ): Promise<Pick<DaemonManifest, "generation">>;
  getAgentConfiguration(entryId: string): Promise<StoredAgentConfiguration | undefined>;
  updateAgentConfiguration(
    expectedGeneration: number,
    input: {
      agentId: string;
      expectedRevision: number;
      model: string | null;
      reasoningEffort: ProviderReasoningEffort;
      charter: string;
      permissionProfileId: string | null;
      providerLaunchPolicy: unknown;
    },
    commitFence: CommitFence,
  ): Promise<{
    generation: number;
    outcome: "updated" | "conflict" | "invalid";
    configuration?: StoredAgentConfiguration;
  }>;
  appendActivity(
    expectedGeneration: number,
    entryId: string,
    event: DaemonActivityEvent,
    observedState: DaemonManifestEntry["observed_state"],
    nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]>,
    limit: number,
    commitFence: CommitFence,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }>;
  appendActivityOnly(
    expectedGeneration: number,
    entryId: string,
    event: DaemonActivityEvent,
    limit: number,
    commitFence: CommitFence,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }>;
  updateWorkplaceLiveness(
    expectedGeneration: number,
    entryId: string,
    liveness: NonNullable<DaemonManifestEntry["workplace_liveness"]>,
    commitFence: CommitFence,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }>;
};

export type ManifestAdministrationAuthority = {
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  assertCurrent(): Promise<void>;
  currentDaemonGeneration(): number;
  currentManifestGeneration(): number;
  acceptManifestGeneration(generation: number): void;
  fenceCommit: CommitFence;
};

export type ManifestAdministrationPolicies = {
  projectCreateReplayParameters(entry: DaemonManifestEntry): unknown;
  providerSupportsConcurrentAgents(provider: string): boolean;
  deriveProviderConfiguration(input: {
    provider: string;
    model: string | null;
    reasoningEffort: ProviderReasoningEffort;
    permissionProfileId: string | null;
    configurationRevision: number;
  }, currentTrustedLaunchPolicy: unknown): ProviderConfigurationSnapshot;
  permissionProfilesForProvider(provider: string): unknown;
  sanitizeActivity(event: DaemonActivityEvent): DaemonActivityEvent;
  safeErrorDetail(error: unknown): string;
};

export type ManifestAdministrationCoordinatorOptions = {
  store: ManifestAdministrationStore;
  authority: ManifestAdministrationAuthority;
  policies: ManifestAdministrationPolicies;
  lanes: {
    liveOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[];
  };
  convergence: {
    request(entryId: string): void;
  };
};

export type UpdateAgentConfigurationInput = {
  entryId: string;
  daemonGeneration: number;
  expectedRevision: number;
  configuration: Record<string, unknown>;
};

/**
 * Owns non-lifecycle manifest administration. Provider execution, delivery,
 * retirement, purge execution, and recovery remain with the daemon; state
 * notification remains part of the injected commit fence so every successful
 * durable mutation emits exactly one notification at the original boundary.
 */
export class ManifestAdministrationCoordinator {
  constructor(private readonly options: ManifestAdministrationCoordinatorOptions) {}

  validateEntry(entry: DaemonManifestEntry): void {
    for (const field of ["id", "room_id", "display_name", "provider", "charter", "created_by", "created_at"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Manifest entry ${field} is required.`);
      }
    }
    if (!["running", "paused", "stopped"].includes(entry.desired_state)) {
      throw new Error("Invalid desired state.");
    }
  }

  isSupervisedLaneOwner(entry: DaemonManifestEntry): boolean {
    return !(entry.desired_state === "stopped" && entry.observed_state === "stopped");
  }

  competingSupervisedLaneOwner(
    entries: readonly DaemonManifestEntry[],
    entry: DaemonManifestEntry,
  ): DaemonManifestEntry | undefined {
    if (this.options.policies.providerSupportsConcurrentAgents(entry.provider)) return undefined;
    return entries.find((candidate) =>
      candidate.id !== entry.id
      && candidate.room_id === entry.room_id
      && candidate.provider === entry.provider
      && this.isSupervisedLaneOwner(candidate));
  }

  async quarantineDuplicateSupervisedLaneOwners(): Promise<void> {
    await this.options.authority.serialize(async () => {
      const manifest = await this.options.store.load();
      const ownersByLane = new Map<string, DaemonManifestEntry[]>();
      for (const entry of manifest.entries) {
        if (this.options.policies.providerSupportsConcurrentAgents(entry.provider)) continue;
        if (!this.isSupervisedLaneOwner(entry)) continue;
        const key = `${entry.room_id}\u0000${entry.provider}`;
        const owners = ownersByLane.get(key) ?? [];
        owners.push(entry);
        ownersByLane.set(key, owners);
      }
      const duplicateIds = new Set(
        [...ownersByLane.values()]
          .filter((owners) => owners.length > 1)
          .flatMap((owners) => owners.map((entry) => entry.id)),
      );
      if (!duplicateIds.size) return;
      const entries = manifest.entries.map((entry) => duplicateIds.has(entry.id)
        ? {
            ...entry,
            desired_state: "stopped" as const,
            last_error: "LetAgents found multiple supervised agents for this provider lane after restart and stopped them to prevent duplicate work.",
          }
        : entry);
      const next = await this.options.store.write(
        this.options.authority.currentManifestGeneration(),
        entries,
        manifest.legacy_lane_owners,
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
    });
  }

  async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (Object.hasOwn(entry, "polling_contract")) {
      throw new Error("Polling custody is daemon-owned and cannot be supplied to manifest.put.");
    }
    this.validateEntry(entry);
    const updated = await this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const purgeTombstone = await this.options.store.getPurge(`purge:${entry.id}`);
      if (purgeTombstone?.phase === "complete") {
        throw new Error(`Supervised entry '${entry.id}' was permanently purged. Start a genuinely new agent with a new creation request id.`);
      }
      const manifest = await this.options.store.load();
      const legacyOwners = this.options.lanes.liveOwners(manifest.legacy_lane_owners ?? []);
      const existing = manifest.entries.find((candidate) => candidate.id === entry.id);
      if (existing) {
        if (!isDeepStrictEqual(
          this.options.policies.projectCreateReplayParameters(existing),
          this.options.policies.projectCreateReplayParameters(entry),
        )) {
          throw new Error(`Supervised creation request '${entry.id}' is already bound to different agent parameters.`);
        }
        return existing;
      }
      if (entry.desired_state !== "stopped") {
        const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
        if (supervisedOwner) {
          throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
        }
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
      const next = await this.options.store.write(
        this.options.authority.currentManifestGeneration(),
        [...manifest.entries, nextEntry],
        legacyOwners,
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
      return nextEntry;
    });
    this.options.convergence.request(updated.id);
    return updated;
  }

  async setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry> {
    const normalized = displayName.trim();
    if (!id || !normalized || normalized.length > 120) {
      throw new Error("Agent naming requires an exact identity and display name.");
    }
    return this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const manifest = await this.options.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (entry.display_name === normalized) return entry;
      const updated = { ...entry, display_name: normalized };
      const next = await this.options.store.write(
        this.options.authority.currentManifestGeneration(),
        manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
        this.options.lanes.liveOwners(manifest.legacy_lane_owners ?? []),
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
      return updated;
    });
  }

  async appendActivity(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    if (!event || typeof event !== "object" || !event.observed_at) {
      throw new Error("A bounded activity event is required.");
    }
    const sanitizedEvent = this.options.policies.sanitizeActivity(event);
    return this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const entry = await this.options.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (sanitizedEvent.sequence <= lastSequence) {
        throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${lastSequence}.`);
      }
      const observedState = sanitizedEvent.status === "working" || sanitizedEvent.status === "reviewing"
        ? "working"
        : sanitizedEvent.status === "blocked" ? entry.observed_state : "idle";
      const nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> = {
        state: sanitizedEvent.status === "idle" ? "idle" : "active",
        observed_at: sanitizedEvent.observed_at,
        detail: sanitizedEvent.summary,
      };
      const next = await this.options.store.appendActivity(
        this.options.authority.currentManifestGeneration(),
        id,
        sanitizedEvent,
        observedState,
        nativeLiveness,
        200,
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
      return next.entry;
    });
  }

  async appendActivityOnly(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    if (!event || typeof event !== "object" || !event.observed_at) {
      throw new Error("A bounded activity event is required.");
    }
    const sanitizedEvent = this.options.policies.sanitizeActivity(event);
    return this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const entry = await this.options.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.activity?.at(-1)?.sequence ?? -1;
      if (sanitizedEvent.sequence <= lastSequence) {
        throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${lastSequence}.`);
      }
      const next = await this.options.store.appendActivityOnly(
        this.options.authority.currentManifestGeneration(),
        id,
        sanitizedEvent,
        200,
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
      return next.entry;
    });
  }

  async updateWorkplaceLiveness(
    id: string,
    state: "reachable" | "stale" | "unknown",
    detail: string | null,
    observedAt: string,
  ): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["reachable", "stale", "unknown"].includes(state)) {
      throw new Error("Invalid workplace liveness state.");
    }
    return this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const entry = await this.options.store.getEntry(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const workplaceLiveness: NonNullable<DaemonManifestEntry["workplace_liveness"]> = {
        state,
        observed_at: observedAt,
        detail,
      };
      const next = await this.options.store.updateWorkplaceLiveness(
        this.options.authority.currentManifestGeneration(),
        id,
        workplaceLiveness,
        this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
      return next.entry;
    });
  }

  async getAgentConfiguration(entryId: string, daemonGeneration: number) {
    if (!entryId || daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
      throw new Error("Agent configuration is fenced by a stale daemon generation.");
    }
    const configuration = await this.options.store.getAgentConfiguration(entryId);
    if (!configuration) throw new Error("The exact agent no longer exists.");
    return {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      ...configuration,
      supervised_permission_profiles: this.options.policies.permissionProfilesForProvider(configuration.provider),
    };
  }

  async updateAgentConfiguration(input: UpdateAgentConfigurationInput) {
    if (!input.entryId
      || input.daemonGeneration !== this.options.authority.currentDaemonGeneration()
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1) {
      return {
        outcome: "invalid" as const,
        error: "Configuration requires an exact agent, current daemon generation, and positive expected revision.",
      };
    }
    const effort = input.configuration.reasoning_effort;
    const model = input.configuration.model;
    const charter = input.configuration.charter;
    const profile = input.configuration.permission_profile_id;
    if (!Object.hasOwn(input.configuration, "model")
      || !Object.hasOwn(input.configuration, "reasoning_effort")
      || !Object.hasOwn(input.configuration, "charter")
      || !Object.hasOwn(input.configuration, "permission_profile_id")
      || Object.hasOwn(input.configuration, "provider_launch_policy")
      || (effort !== null && !["low", "medium", "high", "xhigh", "max"].includes(String(effort)))
      || (model !== null && (typeof model !== "string" || !model.trim() || model.length > 256))
      || typeof charter !== "string"
      || !charter.trim()
      || charter.length > 32_768
      || (profile !== null && (typeof profile !== "string" || !profile.trim() || profile.length > 128))) {
      return {
        outcome: "invalid" as const,
        error: "The selected provider does not accept this model, effort, charter, or permission profile. Native launch policy is managed by the desktop supervisor.",
      };
    }
    const currentConfiguration = await this.options.store.getAgentConfiguration(input.entryId);
    if (!currentConfiguration) {
      return { outcome: "invalid" as const, error: "The exact agent no longer exists." };
    }
    try {
      const normalized = this.options.policies.deriveProviderConfiguration({
        provider: currentConfiguration.provider,
        model: model === null ? null : (model as string).trim(),
        reasoningEffort: effort as ProviderReasoningEffort,
        permissionProfileId: profile === null ? null : (profile as string).trim(),
        configurationRevision: input.expectedRevision + 1,
      }, currentConfiguration.provider_launch_policy);
      return this.options.authority.serialize(async () => {
        await this.options.authority.assertCurrent();
        const result = await this.options.store.updateAgentConfiguration(
          this.options.authority.currentManifestGeneration(),
          {
            agentId: input.entryId,
            expectedRevision: input.expectedRevision,
            model: normalized.model,
            reasoningEffort: normalized.reasoningEffort,
            charter: charter.trim(),
            permissionProfileId: normalized.permissionProfileId,
            providerLaunchPolicy: normalized.launchPolicy,
          },
          this.options.authority.fenceCommit,
        );
        this.options.authority.acceptManifestGeneration(result.generation);
        if (result.outcome === "invalid") {
          return { outcome: "invalid" as const, error: "The exact agent no longer exists." };
        }
        return {
          outcome: result.outcome,
          configuration: await this.getAgentConfiguration(input.entryId, input.daemonGeneration),
        };
      });
    } catch (error) {
      return { outcome: "invalid" as const, error: this.options.policies.safeErrorDetail(error) };
    }
  }
}
