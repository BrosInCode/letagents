import { isDeepStrictEqual } from "node:util";

import {
  HOME_HARNESS_ON,
  agentUsesHomeHarness,
  entryLaunchPolicy,
  homeHarnessAvailability,
  homeHarnessDiffersFromSaved,
  namesHomeHarness,
  storedHomeHarness,
  storedLaunchPolicy,
  withoutHomeHarness,
  type ProviderConfigurationSnapshot,
  type ProviderReasoningEffort,
} from "./provider-configuration.js";
import { describeProfilesWithOwnerSetup } from "./supervised-permission-profiles.js";
import type {
  DaemonActivityEvent,
  DaemonAgentConfiguration,
  DaemonManifest,
  DaemonManifestEntry,
  DaemonPurgeRecord,
  LegacyLaneOwner,
} from "./types.js";
import {
  agentDisplayNameKey,
  isPlaceholderAgentDisplayName,
  suggestFreeAgentCodename,
} from "../../../shared/agent-codenames.mjs";

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
  /** How room messages reach the agent. Absent is read as the older polling delivery. */
  delivery_mode?: string;
};

export type ManifestAdministrationStore = {
  load(): Promise<DaemonManifest>;
  getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  getActivityState(entryId: string): Promise<{
    observed_state: DaemonManifestEntry["observed_state"]; last_sequence: number;
  } | undefined>;
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
  recordActivity(
    expectedGeneration: number,
    entryId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit: number,
    commitFence: CommitFence,
  ): Promise<{ generation: number }>;
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
  /**
   * Whether this agent may use the owner's own provider setup. The control
   * router sets it only for a request the desktop app signed; it is never
   * read from `configuration`, which any local caller can supply.
   */
  homeHarness?: boolean;
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

  /**
   * The requested name is a suggestion. This is the one place that reads the
   * names saved for a room and saves another in the same step, so it is where
   * a name is decided: a placeholder, or a name another agent in the room
   * already answers to, is replaced from the shared pool.
   */
  assignDisplayName(entries: readonly DaemonManifestEntry[], entry: DaemonManifestEntry): string {
    const held = entries
      .filter((candidate) => candidate.id !== entry.id && candidate.room_id === entry.room_id)
      .map((candidate) => candidate.display_name);
    const requested = entry.display_name.trim();
    const requestedKey = agentDisplayNameKey(requested);
    const taken = held.some((name) => agentDisplayNameKey(name) === requestedKey);
    if (!taken && !isPlaceholderAgentDisplayName(requested, entry.provider)) return requested;
    return suggestFreeAgentCodename(held, entry.id) ?? requested;
  }

  async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (Object.hasOwn(entry, "polling_contract")) {
      throw new Error("Polling custody is daemon-owned and cannot be supplied to manifest.put.");
    }
    if (namesHomeHarness(entry.provider_launch_policy)) {
      throw new Error("An agent's use of its owner's own setup is turned on in the desktop app and cannot be supplied to manifest.put.");
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
        // The name is assigned here, and the room may since have assigned
        // another, so a replay is the same request whatever name it carries.
        if (!isDeepStrictEqual(
          this.options.policies.projectCreateReplayParameters(existing),
          this.options.policies.projectCreateReplayParameters({ ...entry, display_name: existing.display_name }),
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
        display_name: this.assignDisplayName(manifest.entries, entry),
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
      const entry = await this.options.store.getActivityState(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.last_sequence;
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
      const entry = await this.options.store.getActivityState(id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
      const lastSequence = entry.last_sequence;
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

  /** Preserve native event admission without hydrating an unused history result. */
  async appendNativeActivity(id: string, event: DaemonActivityEvent, activityOnly: boolean): Promise<void> {
    if (!event || typeof event !== "object" || !event.observed_at) {
      throw new Error("A bounded activity event is required.");
    }
    const sanitizedEvent = this.options.policies.sanitizeActivity(event);
    return this.options.authority.serialize(async () => {
      await this.options.authority.assertCurrent();
      const state = await this.options.store.getActivityState(id);
      if (!state) throw new Error(`Unknown daemon manifest entry: ${id}`);
      if (sanitizedEvent.sequence <= state.last_sequence) {
        throw new Error(`Native activity sequence ${sanitizedEvent.sequence} is not newer than ${state.last_sequence}.`);
      }
      const observedState = sanitizedEvent.status === "working" || sanitizedEvent.status === "reviewing"
        ? "working" : sanitizedEvent.status === "blocked" ? state.observed_state : "idle";
      const next = await this.options.store.recordActivity(
        this.options.authority.currentManifestGeneration(), id, sanitizedEvent,
        activityOnly ? null : { observedState, nativeLiveness: {
          state: sanitizedEvent.status === "idle" ? "idle" : "active",
          observed_at: sanitizedEvent.observed_at, detail: sanitizedEvent.summary,
        } }, 200, this.options.authority.fenceCommit,
      );
      this.options.authority.acceptManifestGeneration(next.generation);
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
    const agent = { id: entryId, provider: configuration.provider, deliveryMode: configuration.delivery_mode };
    const availability = homeHarnessAvailability(agent);
    const homeHarness = agentUsesHomeHarness(agent, configuration.provider_launch_policy);
    const profiles = this.options.policies.permissionProfilesForProvider(configuration.provider);
    return {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      ...configuration,
      supervised_permission_profiles: homeHarness ? describeProfilesWithOwnerSetup(configuration.provider, profiles) : profiles,
      home_harness: homeHarness,
      // A running process started before the last change still runs the way it started.
      home_harness_pending: availability === "available"
        && homeHarnessDiffersFromSaved(configuration.provider_launch_policy, configuration.runtime_configuration_revision),
      home_harness_availability: availability,
    };
  }

  /**
   * Turn the owner's own provider setup on or off for one agent. Reached only
   * through the desktop app's signed request. The change is a new
   * configuration revision, so it applies the next time the agent starts.
   */
  private async setHomeHarness(input: UpdateAgentConfigurationInput) {
    if (typeof input.homeHarness !== "boolean") {
      return { outcome: "invalid" as const, error: "Choose whether this agent may use your own setup." };
    }
    const current = await this.options.store.getAgentConfiguration(input.entryId);
    if (!current) return { outcome: "invalid" as const, error: "The exact agent no longer exists." };
    const availability = homeHarnessAvailability({ id: input.entryId, provider: current.provider, deliveryMode: current.delivery_mode });
    if (availability !== "available") {
      return {
        outcome: "invalid" as const,
        error: availability === "rental"
          ? "A rented agent works for someone else and cannot use your own setup."
          : availability === "polling"
            ? "Not available for this agent: it fetches its own messages, so LetAgents can't reliably switch your setup off again."
            : "This agent app has no setup of yours to use.",
      };
    }
    if (storedHomeHarness(current.provider_launch_policy) === input.homeHarness) {
      return { outcome: "updated" as const, configuration: await this.getAgentConfiguration(input.entryId, input.daemonGeneration) };
    }
    try {
      const policy = withoutHomeHarness(current.provider_launch_policy);
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("The agent's saved launch settings cannot be read.");
      // Checked as the next start will derive it, so a choice that could not launch is refused here.
      this.options.policies.deriveProviderConfiguration({
        provider: current.provider,
        model: current.model,
        reasoningEffort: current.reasoning_effort ?? null,
        permissionProfileId: current.permission_profile_id,
        configurationRevision: input.expectedRevision + 1,
      }, input.homeHarness ? { ...policy, ...HOME_HARNESS_ON } : policy);
      return this.options.authority.serialize(async () => {
        await this.options.authority.assertCurrent();
        const result = await this.options.store.updateAgentConfiguration(
          this.options.authority.currentManifestGeneration(),
          {
            agentId: input.entryId,
            expectedRevision: input.expectedRevision,
            // Nothing but LetAgents' own keys changes: the model, the access
            // level and the provider's own options stay exactly as stored, so
            // turning this off again leaves the agent's settings as they were.
            model: current.model,
            reasoningEffort: current.reasoning_effort ?? null,
            charter: current.charter,
            permissionProfileId: current.permission_profile_id,
            providerLaunchPolicy: storedLaunchPolicy(
              { launchPolicy: policy as Record<string, unknown>, ...(input.homeHarness ? { homeHarness: true as const } : {}) },
              {
                policy: current.provider_launch_policy,
                runtimeRevision: current.runtime_configuration_revision,
                changedAt: input.expectedRevision + 1,
              },
            ),
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
    if (Object.hasOwn(input, "homeHarness")) return this.setHomeHarness(input);
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
      // A rental or an agent app with no owner setup never keeps the key, however it got there.
      const trustedPolicy = entryLaunchPolicy(
        { id: input.entryId, provider: currentConfiguration.provider, deliveryMode: currentConfiguration.delivery_mode },
        currentConfiguration.provider_launch_policy,
      );
      const normalized = this.options.policies.deriveProviderConfiguration({
        provider: currentConfiguration.provider,
        model: model === null ? null : (model as string).trim(),
        reasoningEffort: effort as ProviderReasoningEffort,
        permissionProfileId: profile === null ? null : (profile as string).trim(),
        configurationRevision: input.expectedRevision + 1,
      }, trustedPolicy);
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
            // An edit to the model or access level keeps the owner's choice.
            providerLaunchPolicy: storedLaunchPolicy(normalized, { policy: trustedPolicy }),
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
