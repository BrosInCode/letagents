import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDaemonActivityEvent } from "../credential-redaction.js";
import { schedulerErrorDetail } from "../daemon-error-policy.js";
import {
  ManifestAdministrationCoordinator,
  type ManifestAdministrationCoordinatorOptions,
  type ManifestAdministrationStore,
  type StoredAgentConfiguration,
} from "../manifest-administration-coordinator.js";
import { projectDaemonCreateRequestReplayParameters } from "../manifest-entry-projection.js";
import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
} from "../provider-configuration.js";
import { DaemonFenceLostError } from "../singleton.js";
import { supervisedPermissionProfilesForProvider } from "../supervised-permission-profiles.js";
import type {
  DaemonActivityEvent,
  DaemonManifest,
  DaemonManifestEntry,
  LegacyLaneOwner,
} from "../types.js";

const DAEMON_GENERATION = 7;
const CREATED_AT = "2026-08-26T10:00:00.000Z";

function entry(overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent One",
    provider: "legacy-provider",
    model: null,
    reasoning_effort: null,
    charter: "Help the room",
    desired_state: "paused",
    observed_state: "idle",
    condition: "none",
    permission_profile_id: null,
    created_by: "owner",
    created_at: CREATED_AT,
    ...overrides,
  };
}

function activity(overrides: Partial<DaemonActivityEvent> = {}): DaemonActivityEvent {
  return {
    observed_at: CREATED_AT,
    sequence: 1,
    provider: "legacy-provider",
    kind: "tool_lifecycle",
    method: "read",
    summary: "working",
    status: "working",
    payload: { ok: true },
    payload_truncated: false,
    payload_redacted: false,
    durable_payload_ref: null,
    ...overrides,
  };
}

function legacyOwner(overrides: Partial<LegacyLaneOwner> = {}): LegacyLaneOwner {
  return {
    reservation_id: "legacy-1",
    room_id: "room-1",
    provider: "legacy-provider",
    owner_pid: 10,
    owner_process_identity: "birth-1",
    state: "active",
    session_id: "session-1",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function storedConfiguration(overrides: Partial<StoredAgentConfiguration> = {}): StoredAgentConfiguration {
  return {
    provider: "codex",
    model: "gpt-5.6",
    reasoning_effort: "high",
    charter: "Help the room",
    permission_profile_id: "full_access",
    provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    config_revision: 3,
    runtime_configuration_revision: 2,
    ...overrides,
  };
}

function harness(initialEntries: DaemonManifestEntry[] = []) {
  const events: string[] = [];
  let durableManifestGeneration = 4;
  let acceptedManifestGeneration = 4;
  let manifest: DaemonManifest = { generation: durableManifestGeneration, entries: initialEntries };
  let purgeComplete = false;
  let currentOwner = true;
  let handoffScheduled = false;
  let configuration: StoredAgentConfiguration | undefined = initialEntries.length
    ? storedConfiguration({ provider: initialEntries[0]!.provider })
    : undefined;
  let nextConfigurationOutcome: "updated" | "invalid" = "updated";

  const assertCurrent = async () => {
    events.push("authority:assert");
    if (!currentOwner) throw new Error("daemon owner changed");
  };

  const fence = async (commit: () => Promise<void>) => {
    events.push("authority:fence");
    if (handoffScheduled) {
      throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
    }
    await assertCurrent();
    if (handoffScheduled) {
      throw new DaemonFenceLostError("Supervisor handoff fenced a stale daemon-owned commit.");
    }
    await commit();
    events.push("state:notify");
  };
  const store: ManifestAdministrationStore = {
    async load() {
      events.push("store:load");
      return manifest;
    },
    async getEntry(entryId) {
      events.push(`store:get-entry:${entryId}`);
      return manifest.entries.find((candidate) => candidate.id === entryId);
    },
    async getPurge(operationId) {
      events.push(`store:get-purge:${operationId}`);
      return purgeComplete ? { phase: "complete" } as never : null;
    },
    async write(expectedGeneration, entries, legacyLaneOwners, commitFence) {
      events.push(`store:write:${expectedGeneration}`);
      assert.equal(expectedGeneration, durableManifestGeneration, "manifest write must use the durable generation");
      await commitFence(async () => {
        events.push("store:commit");
        durableManifestGeneration += 1;
        manifest = { generation: durableManifestGeneration, entries, legacy_lane_owners: legacyLaneOwners };
      });
      return { generation: durableManifestGeneration };
    },
    async getAgentConfiguration(entryId) {
      events.push(`store:get-config:${entryId}`);
      return configuration;
    },
    async updateAgentConfiguration(expectedGeneration, input, commitFence) {
      events.push(`store:update-config:${expectedGeneration}:${input.expectedRevision}`);
      assert.equal(expectedGeneration, durableManifestGeneration,
        "configuration update must use the durable manifest generation");
      if (nextConfigurationOutcome === "invalid") {
        return { generation: durableManifestGeneration, outcome: "invalid" };
      }
      if (!configuration) return { generation: durableManifestGeneration, outcome: "invalid" };
      if (input.expectedRevision !== configuration.config_revision) {
        return { generation: durableManifestGeneration, outcome: "conflict", configuration };
      }
      await commitFence(async () => {
        events.push("store:commit-config");
        durableManifestGeneration += 1;
        configuration = {
          ...configuration,
          model: input.model,
          reasoning_effort: input.reasoningEffort,
          charter: input.charter,
          permission_profile_id: input.permissionProfileId,
          provider_launch_policy: input.providerLaunchPolicy,
          config_revision: input.expectedRevision + 1,
        };
      });
      return { generation: durableManifestGeneration, outcome: "updated", configuration };
    },
    async appendActivity(expectedGeneration, entryId, event, observedState, nativeLiveness, limit, commitFence) {
      events.push(`store:append:${event.sequence}:${limit}`);
      assert.equal(expectedGeneration, durableManifestGeneration,
        "activity append must use the durable manifest generation");
      let updated!: DaemonManifestEntry;
      await commitFence(async () => {
        events.push("store:commit-activity");
        const current = manifest.entries.find((candidate) => candidate.id === entryId)!;
        updated = {
          ...current,
          observed_state: observedState,
          native_liveness: nativeLiveness,
          activity: [...(current.activity ?? []), event].slice(-limit),
        };
        durableManifestGeneration = expectedGeneration + 1;
        manifest = {
          ...manifest,
          generation: durableManifestGeneration,
          entries: manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate),
        };
      });
      return { generation: durableManifestGeneration, entry: updated };
    },
    async updateWorkplaceLiveness(expectedGeneration, entryId, liveness, commitFence) {
      events.push(`store:liveness:${liveness.state}`);
      assert.equal(expectedGeneration, durableManifestGeneration,
        "liveness update must use the durable manifest generation");
      let updated!: DaemonManifestEntry;
      await commitFence(async () => {
        events.push("store:commit-liveness");
        const current = manifest.entries.find((candidate) => candidate.id === entryId)!;
        updated = { ...current, workplace_liveness: liveness };
        durableManifestGeneration = expectedGeneration + 1;
        manifest = {
          ...manifest,
          generation: durableManifestGeneration,
          entries: manifest.entries.map((candidate) => candidate.id === entryId ? updated : candidate),
        };
      });
      return { generation: durableManifestGeneration, entry: updated };
    },
  };

  const options: ManifestAdministrationCoordinatorOptions = {
    store,
    authority: {
      serialize: async (operation) => {
        events.push("authority:serialize");
        await assertCurrent();
        return operation();
      },
      assertCurrent,
      currentDaemonGeneration: () => DAEMON_GENERATION,
      currentManifestGeneration: () => acceptedManifestGeneration,
      acceptManifestGeneration: (generation) => {
        events.push(`authority:accept:${generation}`);
        acceptedManifestGeneration = generation;
      },
      fenceCommit: fence,
    },
    policies: {
      projectCreateReplayParameters: projectDaemonCreateRequestReplayParameters,
      providerSupportsConcurrentAgents: providerSupportsConcurrentSupervisedAgents,
      deriveProviderConfiguration: deriveProviderConfigurationSnapshot,
      permissionProfilesForProvider: supervisedPermissionProfilesForProvider,
      sanitizeActivity: sanitizeDaemonActivityEvent,
      safeErrorDetail: schedulerErrorDetail,
    },
    lanes: {
      liveOwners: (owners) => {
        events.push("lanes:live");
        return [...owners];
      },
    },
    convergence: {
      request: (entryId) => { events.push(`convergence:${entryId}`); },
    },
  };

  return {
    subject: new ManifestAdministrationCoordinator(options),
    events,
    get manifest() { return manifest; },
    get configuration() { return configuration; },
    setConfiguration(next: StoredAgentConfiguration | undefined) { configuration = next; },
    setConfigurationOutcome(outcome: "updated" | "invalid") { nextConfigurationOutcome = outcome; },
    setPurgeComplete(value: boolean) { purgeComplete = value; },
    setCurrentOwner(value: boolean) { currentOwner = value; },
    setHandoffScheduled(value: boolean) { handoffScheduled = value; },
    setAcceptedManifestGeneration(generation: number) { acceptedManifestGeneration = generation; },
  };
}

test("entry validation and create replay preserve exact validation and convergence order", async () => {
  const invalid = harness();
  await assert.rejects(invalid.subject.putManifestEntry(entry({ room_id: "" })), /Manifest entry room_id is required\./);
  assert.deepEqual(invalid.events, []);

  const state = harness();
  const withHistory = entry({
    activity: Array.from({ length: 205 }, (_, index) => activity({ sequence: index })),
  });
  const created = await state.subject.putManifestEntry(withHistory);
  assert.equal(created.activity?.length, 200);
  assert.deepEqual(created.workplace_liveness, { state: "unknown", observed_at: null, detail: null });
  assert.deepEqual(created.native_liveness, { state: "unknown", observed_at: null, detail: null });
  assert.deepEqual(state.events, [
    "authority:serialize",
    "authority:assert",
    "authority:assert",
    "store:get-purge:purge:agent-1",
    "store:load",
    "lanes:live",
    "store:write:4",
    "authority:fence",
    "authority:assert",
    "store:commit",
    "state:notify",
    "authority:accept:5",
    "convergence:agent-1",
  ]);

  state.events.length = 0;
  const replay = await state.subject.putManifestEntry(withHistory);
  assert.equal(replay, created);
  assert.equal(state.events.includes("store:write:5"), false);
  assert.equal(state.events.at(-1), "convergence:agent-1");

  await assert.rejects(
    state.subject.putManifestEntry({ ...withHistory, room_id: "different-room" }),
    /already bound to different agent parameters/,
  );
});

test("put enforces purge, supervised, and live legacy lane ownership without overfencing stopped claims", async () => {
  const purged = harness();
  purged.setPurgeComplete(true);
  await assert.rejects(purged.subject.putManifestEntry(entry()), /was permanently purged/);

  const supervised = harness([entry({ id: "owner", desired_state: "running" })]);
  await assert.rejects(
    supervised.subject.putManifestEntry(entry({ id: "candidate", desired_state: "paused" })),
    /already owned by supervised entry 'owner'/,
  );

  const legacy = harness();
  (legacy.manifest as DaemonManifest).legacy_lane_owners = [legacyOwner()];
  await assert.rejects(
    legacy.subject.putManifestEntry(entry({ desired_state: "running" })),
    /already owned by legacy reservation 'legacy-1'/,
  );
  assert.equal((await legacy.subject.putManifestEntry(entry({ id: "stopped", desired_state: "stopped" }))).id, "stopped");
});

test("restart quarantine stops every duplicate non-concurrent lane owner and preserves concurrent providers", async () => {
  const state = harness([
    entry({ id: "left", desired_state: "running" }),
    entry({ id: "right", desired_state: "paused" }),
    entry({ id: "terminal", desired_state: "stopped", observed_state: "stopped" }),
    entry({ id: "codex-left", provider: "codex", desired_state: "running" }),
    entry({ id: "codex-right", provider: "codex", desired_state: "running" }),
  ]);

  await state.subject.quarantineDuplicateSupervisedLaneOwners();

  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "left")?.desired_state, "stopped");
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "right")?.desired_state, "stopped");
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "left")?.last_error,
    "LetAgents found multiple supervised agents for this provider lane after restart and stopped them to prevent duplicate work.");
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "terminal")?.last_error, undefined);
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "codex-left")?.desired_state, "running");
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "codex-right")?.desired_state, "running");
  assert.equal(state.events.filter((event) => event === "state:notify").length, 1);
});

test("display naming trims, avoids no-op commits, and keeps legacy-owner cleanup in the write", async () => {
  const state = harness([entry()]);
  (state.manifest as DaemonManifest).legacy_lane_owners = [legacyOwner()];

  const renamed = await state.subject.setDisplayName("agent-1", "  Renamed  ");
  assert.equal(renamed.display_name, "Renamed");
  assert.equal(state.events.includes("lanes:live"), true);
  assert.equal(state.events.filter((event) => event === "state:notify").length, 1);

  state.events.length = 0;
  assert.equal((await state.subject.setDisplayName("agent-1", "Renamed")), renamed);
  assert.equal(state.events.some((event) => event.startsWith("store:write")), false);
  await assert.rejects(state.subject.setDisplayName("agent-1", " "), /Agent naming requires an exact identity/);
});

test("serialized admission asserts current ownership and the commit fence blocks handoff before mutation or notification", async () => {
  const staleOwner = harness([entry()]);
  staleOwner.setCurrentOwner(false);
  await assert.rejects(
    staleOwner.subject.setDisplayName("agent-1", "Renamed"),
    /daemon owner changed/,
  );
  assert.deepEqual(staleOwner.events, ["authority:serialize", "authority:assert"]);

  const fenced = harness([entry()]);
  fenced.setHandoffScheduled(true);
  await assert.rejects(
    fenced.subject.appendActivity("agent-1", activity()),
    /Supervisor handoff fenced a stale daemon-owned commit/,
  );
  assert.equal(fenced.events.includes("authority:fence"), true);
  assert.equal(fenced.events.includes("store:commit-activity"), false);
  assert.equal(fenced.events.includes("state:notify"), false);
  assert.equal(fenced.events.some((event) => event.startsWith("authority:accept")), false);
});

test("activity sanitization precedes sequence admission and persists exact bounded projections", async () => {
  const prior = activity({ sequence: 5, status: "idle" });
  const state = harness([entry({ activity: [prior], observed_state: "idle" })]);

  await assert.rejects(
    state.subject.appendActivity("agent-1", activity({ sequence: 5 })),
    /Native activity sequence 5 is not newer than 5/,
  );

  const updated = await state.subject.appendActivity("agent-1", activity({
    sequence: 6,
    status: "blocked",
    summary: "blocked token=abcdefghijklmnopqrstuvwxyz123456",
    payload: { api_key: "secret-value" },
  }));
  assert.equal(updated.observed_state, "idle", "blocked activity preserves observed state");
  assert.equal(updated.native_liveness?.state, "active");
  assert.equal(updated.activity?.at(-1)?.payload_redacted, true);
  assert.equal(JSON.stringify(updated.activity?.at(-1)).includes("secret-value"), false);
  assert.equal(state.events.includes("store:append:6:200"), true);
  assert.equal(state.events.filter((event) => event === "state:notify").length, 1);
});

test("workplace liveness preserves validation order, CAS adoption, and the exact persisted axis", async () => {
  const state = harness([entry()]);
  await assert.rejects(
    state.subject.updateWorkplaceLiveness("", "reachable", null, CREATED_AT),
    /Manifest entry id is required/,
  );
  await assert.rejects(
    state.subject.updateWorkplaceLiveness("agent-1", "bad" as never, null, CREATED_AT),
    /Invalid workplace liveness state/,
  );

  const updated = await state.subject.updateWorkplaceLiveness("agent-1", "reachable", "online", CREATED_AT);
  assert.deepEqual(updated.workplace_liveness, {
    state: "reachable",
    observed_at: CREATED_AT,
    detail: "online",
  });
  assert.equal(state.events.includes("authority:accept:5"), true);
  assert.equal(state.events.filter((event) => event === "state:notify").length, 1);
});

test("activity, liveness, and configuration stores reject a stale accepted manifest generation before fencing", async () => {
  const staleActivity = harness([entry()]);
  staleActivity.setAcceptedManifestGeneration(3);
  await assert.rejects(
    staleActivity.subject.appendActivity("agent-1", activity()),
    /activity append must use the durable manifest generation/,
  );
  assert.equal(staleActivity.events.includes("authority:fence"), false);
  assert.equal(staleActivity.events.includes("state:notify"), false);

  const staleLiveness = harness([entry()]);
  staleLiveness.setAcceptedManifestGeneration(3);
  await assert.rejects(
    staleLiveness.subject.updateWorkplaceLiveness("agent-1", "reachable", null, CREATED_AT),
    /liveness update must use the durable manifest generation/,
  );
  assert.equal(staleLiveness.events.includes("authority:fence"), false);
  assert.equal(staleLiveness.events.includes("state:notify"), false);

  const staleConfiguration = harness([entry({ provider: "codex" })]);
  staleConfiguration.setAcceptedManifestGeneration(3);
  await assert.rejects(
    staleConfiguration.subject.updateAgentConfiguration({
      entryId: "agent-1",
      daemonGeneration: DAEMON_GENERATION,
      expectedRevision: 3,
      configuration: {
        model: "gpt-5.6-mini",
        reasoning_effort: "medium",
        charter: "Updated charter",
        permission_profile_id: "full_access",
      },
    }),
    /configuration update must use the durable manifest generation/,
  );
  assert.equal(staleConfiguration.events.includes("authority:fence"), false);
  assert.equal(staleConfiguration.events.includes("state:notify"), false);
});

test("configuration keeps daemon and revision fences, trusted-policy derivation, and post-commit readback", async () => {
  const state = harness([entry({ provider: "codex" })]);
  const current = await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);
  assert.equal(current.config_revision, 3);
  assert.ok(Array.isArray(current.supervised_permission_profiles));
  await assert.rejects(
    state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION - 1),
    /fenced by a stale daemon generation/,
  );

  state.events.length = 0;
  const result = await state.subject.updateAgentConfiguration({
    entryId: "agent-1",
    daemonGeneration: DAEMON_GENERATION,
    expectedRevision: 3,
    configuration: {
      model: " gpt-5.6-mini ",
      reasoning_effort: "medium",
      charter: " Updated charter ",
      permission_profile_id: " full_access ",
    },
  });
  assert.equal(result.outcome, "updated");
  assert.equal(result.configuration?.config_revision, 4);
  assert.equal(state.configuration?.model, "gpt-5.6-mini");
  assert.equal(state.configuration?.charter, "Updated charter");
  assert.deepEqual(state.events, [
    "store:get-config:agent-1",
    "authority:serialize",
    "authority:assert",
    "authority:assert",
    "store:update-config:4:3",
    "authority:fence",
    "authority:assert",
    "store:commit-config",
    "state:notify",
    "authority:accept:5",
    "store:get-config:agent-1",
  ]);

  const invalid = await state.subject.updateAgentConfiguration({
    entryId: "agent-1",
    daemonGeneration: DAEMON_GENERATION,
    expectedRevision: 4,
    configuration: {
      model: "gpt-5.6",
      reasoning_effort: "high",
      charter: "x",
      permission_profile_id: "full_access",
      provider_launch_policy: {},
    },
  });
  assert.deepEqual(invalid, {
    outcome: "invalid",
    error: "The selected provider does not accept this model, effort, charter, or permission profile. Native launch policy is managed by the desktop supervisor.",
  });

  state.events.length = 0;
  const conflict = await state.subject.updateAgentConfiguration({
    entryId: "agent-1",
    daemonGeneration: DAEMON_GENERATION,
    expectedRevision: 3,
    configuration: {
      model: null,
      reasoning_effort: "high",
      charter: "Another",
      permission_profile_id: "full_access",
    },
  });
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.configuration?.config_revision, 4);
  assert.equal(state.events.includes("authority:fence"), false,
    "a revision conflict never enters the commit fence");
  assert.equal(state.events.includes("store:commit-config"), false);
  assert.equal(state.events.includes("state:notify"), false,
    "a revision conflict must not notify state watchers");
  assert.equal(state.events.includes("authority:accept:5"), true,
    "the unchanged durable generation is still adopted exactly as production does");
});
