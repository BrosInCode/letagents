import assert from "node:assert/strict";
import test from "node:test";
import { hostToolPolicyDigest } from "../host-tool-rules.js";

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
    // Room messages are delivered by the daemon, as for every agent the desktop app creates.
    delivery_mode: "daemon_inbox",
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
    async getActivityState(entryId) {
      events.push(`store:activity-state:${entryId}`);
      const current = manifest.entries.find((candidate) => candidate.id === entryId);
      return current ? { observed_state: current.observed_state,
        last_sequence: current.activity?.at(-1)?.sequence ?? -1 } : undefined;
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
    async appendActivityOnly(expectedGeneration, entryId, event, limit, commitFence) {
      events.push(`store:append-only:${event.sequence}:${limit}`);
      assert.equal(expectedGeneration, durableManifestGeneration,
        "activity-only append must use the durable manifest generation");
      let updated!: DaemonManifestEntry;
      await commitFence(async () => {
        events.push("store:commit-activity-only");
        const current = manifest.entries.find((candidate) => candidate.id === entryId)!;
        updated = {
          ...current,
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
    async recordActivity(expectedGeneration, entryId, event, runtimeUpdate, limit, commitFence) {
      events.push(`store:record:${event.sequence}:${limit}`);
      const next = runtimeUpdate
        ? await store.appendActivity(expectedGeneration, entryId, event,
          runtimeUpdate.observedState, runtimeUpdate.nativeLiveness, limit, commitFence)
        : await store.appendActivityOnly(expectedGeneration, entryId, event, limit, commitFence);
      return { generation: next.generation };
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

test("a new agent never shares a name with another agent saved for its room", async () => {
  const state = harness([entry({ id: "agent-1", display_name: "FieldMeadow", provider: "codex" })]);

  // A different provider used to be enough for the same name to be accepted.
  const twin = await state.subject.putManifestEntry(
    entry({ id: "agent-2", display_name: "fieldmeadow", provider: "claude-code" }),
  );
  assert.match(twin.display_name, /^[A-Za-z]+$/, "the assigned name is one mentionable word");
  assert.notEqual(twin.display_name.toLowerCase(), "fieldmeadow");
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "agent-2")?.display_name, twin.display_name);
  assert.equal(state.manifest.entries.find((candidate) => candidate.id === "agent-1")?.display_name, "FieldMeadow",
    "the holder is never renamed by a newcomer");

  // The same name in another room names a different agent to different people.
  const elsewhere = await state.subject.putManifestEntry(
    entry({ id: "agent-3", room_id: "room-2", display_name: "FieldMeadow", provider: "codex" }),
  );
  assert.equal(elsewhere.display_name, "FieldMeadow");

  // A free requested name is a suggestion the daemon accepts.
  const free = await state.subject.putManifestEntry(
    entry({ id: "agent-4", display_name: "CedarPeak", provider: "codex" }),
  );
  assert.equal(free.display_name, "CedarPeak");
});

test("a placeholder name is replaced, and no two replacements in a room collide", async () => {
  const state = harness();
  const names = new Set<string>();
  for (const [index, placeholder] of ["Supervised agent", "Codex supervised agent", "open-model supervised agent"].entries()) {
    const created = await state.subject.putManifestEntry(
      entry({ id: `agent-${index}`, display_name: placeholder, provider: "codex" }),
    );
    assert.match(created.display_name, /^[A-Za-z]+$/);
    assert.doesNotMatch(created.display_name, /supervised agent/i);
    names.add(created.display_name.toLowerCase());
  }
  assert.equal(names.size, 3);

  // A name a person chose is theirs, however it happens to end.
  for (const chosen of ["QA supervised agent", "Research Supervised Agent"]) {
    const created = await state.subject.putManifestEntry(
      entry({ id: `agent-${chosen}`, display_name: chosen, provider: "codex" }),
    );
    assert.equal(created.display_name, chosen);
  }
});

test("replaying a creation request returns the saved agent whatever name the replay carries", async () => {
  const state = harness([entry({ id: "agent-1", display_name: "FieldMeadow", provider: "codex" })]);
  const created = await state.subject.putManifestEntry(
    entry({ id: "agent-2", display_name: "FieldMeadow", provider: "claude-code" }),
  );
  assert.notEqual(created.display_name, "FieldMeadow");

  // The caller still holds the name it asked for; the room may also have
  // assigned another since. Neither makes this a different request.
  state.events.length = 0;
  const replay = await state.subject.putManifestEntry(
    entry({ id: "agent-2", display_name: "FieldMeadow", provider: "claude-code" }),
  );
  assert.equal(replay, created);
  assert.equal(state.events.some((event) => event.startsWith("store:write")), false);

  await assert.rejects(
    state.subject.putManifestEntry(entry({ id: "agent-2", display_name: "FieldMeadow", provider: "claude-code", charter: "Other work" })),
    /already bound to different agent parameters/,
    "every other creation parameter still fences a replay",
  );
});

test("manifest.put rejects caller-supplied polling custody before any write or convergence", async () => {
  for (const polling_contract of ["custodial_polling_v1", "unknown", null, undefined]) {
    const state = harness();
    const candidate = { ...entry(), polling_contract };
    await assert.rejects(() => state.subject.putManifestEntry(candidate),
      /Polling custody is daemon-owned/);
    assert.deepEqual(state.events, []);
    assert.equal(state.manifest.entries.length, 0);
  }
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

test("activity-only persistence sanitizes presentation without acquiring lifecycle authority", async () => {
  const prior = activity({ sequence: 5, status: "idle" });
  const nativeLiveness = { state: "idle" as const, observed_at: prior.observed_at, detail: "provider idle" };
  const state = harness([entry({
    activity: [prior],
    observed_state: "recovering",
    native_liveness: nativeLiveness,
  })]);

  const updated = await state.subject.appendActivityOnly("agent-1", activity({
    sequence: 6,
    status: "working",
    summary: "running token=abcdefghijklmnopqrstuvwxyz123456",
    payload: { api_key: "secret-value" },
  }));
  assert.equal(updated.observed_state, "recovering");
  assert.deepEqual(updated.native_liveness, nativeLiveness);
  assert.equal(updated.activity?.at(-1)?.payload_redacted, true);
  assert.equal(JSON.stringify(updated.activity?.at(-1)).includes("secret-value"), false);
  assert.equal(state.events.includes("store:append-only:6:200"), true);
  assert.equal(state.events.includes("store:commit-activity"), false,
    "presentation-only persistence cannot enter the lifecycle-bearing store path");
  assert.equal(state.events.filter((event) => event === "state:notify").length, 1);
});

test("a provider stream's event whose position a notice took meanwhile is written after the newest, not refused", async () => {
  for (const activityOnly of [false, true]) {
    const state = harness([entry({ observed_state: "idle", activity: Array.from({ length: 6 }, (_, sequence) => activity({ sequence })) })]);
    // The event read position 5 as the next free one; a notice has taken it since.
    await assert.rejects(state.subject.appendNativeActivity("agent-1", activity({ sequence: 5 }), activityOnly), /not newer than 5/,
      "an exact position is still admitted exactly");
    await state.subject.appendNativeActivity("agent-1", activity({ sequence: 5, summary: "stream event" }), activityOnly, "after_latest");
    assert.deepEqual(state.manifest.entries[0]!.activity!.slice(-2).map(event => [event.sequence, event.summary]),
      [[5, activity({ sequence: 5 }).summary], [6, "stream event"]]);
    // A position that is still free is kept as it is.
    await state.subject.appendNativeActivity("agent-1", activity({ sequence: 9, summary: "later event" }), activityOnly, "after_latest");
    assert.equal(state.manifest.entries[0]!.activity!.at(-1)!.sequence, 9);
  }
});

test("native activity keeps scalar admission, redaction, lifecycle ownership, and fencing without entry reads", async () => {
  for (const activityOnly of [false, true]) {
    const nativeLiveness = { state: "idle" as const, detail: "prior native evidence" };
    const state = harness([entry({ observed_state: "recovering", native_liveness: nativeLiveness,
      activity: Array.from({ length: 200 }, (_, sequence) => activity({ sequence })),
    })]);
    await assert.rejects(state.subject.appendNativeActivity("agent-1", activity({ sequence: 199 }), activityOnly), /not newer/);
    const result = await state.subject.appendNativeActivity("agent-1", activity({ sequence: 200, status: "working",
      payload: { api_key: "secret-value" },
    }), activityOnly);
    assert.equal(result, undefined);
    const saved = state.manifest.entries[0]!;
    assert.equal(saved.activity?.length, 200);
    assert.equal(saved.activity?.at(-1)?.payload_redacted, true);
    assert.equal(JSON.stringify(saved.activity?.at(-1)).includes("secret-value"), false);
    assert.equal(saved.observed_state, activityOnly ? "recovering" : "working");
    if (activityOnly) assert.deepEqual(saved.native_liveness, nativeLiveness);
    else assert.equal(saved.native_liveness?.state, "active");
    assert.equal(state.events.some(value => value.startsWith("store:get-entry")), false);
    assert.equal(state.events.includes("store:record:200:200"), true);
    assert.equal(state.events.filter(value => value === "state:notify").length, 1);
    state.setHandoffScheduled(true);
    await assert.rejects(state.subject.appendNativeActivity("agent-1", activity({ sequence: 201 }), activityOnly), /handoff fenced/);
    assert.equal(state.events.filter(value => value === "state:notify").length, 1);
    assert.equal(state.manifest.entries[0]?.activity?.at(-1)?.sequence, 200);
  }
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

const OWN_SETUP_KEY = "letagentsOwnerIsolation";
/** The stored form of "on", and of the revisions at which the choice changed. */
const OWN_SETUP_ON = { [OWN_SETUP_KEY]: false };
const changedAt = (...revisions: number[]) => Object.fromEntries(revisions.map((revision) => [`letagentsOwnerIsolationChangedAt${revision}`, false]));
/** The revision at which the access level (permission mode) was last changed. */
const permissionChangedAt = (revision: number) => ({ [`letagentsPermissionChangedAt${revision}`]: false });

test("the owner's own setup is turned on and off as its own revisioned change, and other edits keep it", async () => {
  const state = harness([entry({ provider: "codex" })]);
  const before = await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);
  assert.equal(before.home_harness, false, "a row with no value is off");
  assert.equal(before.home_harness_availability, "available");

  state.events.length = 0;
  const on = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 3, configuration: {}, homeHarness: true,
  });
  assert.equal(on.outcome, "updated");
  assert.equal(on.configuration?.home_harness, true);
  assert.equal(on.configuration?.config_revision, 4, "it applies at the next start, like a model or access change");
  assert.equal(on.configuration?.runtime_configuration_revision, 2);
  assert.equal(on.configuration?.home_harness_pending, true, "a process that is already running does not have it yet");
  assert.deepEqual(state.configuration?.provider_launch_policy,
    { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ...OWN_SETUP_ON, ...changedAt(4) });
  assert.equal(state.configuration?.model, "gpt-5.6", "nothing else about the agent changes");
  assert.equal(state.configuration?.charter, "Help the room");
  assert.ok(state.events.includes("authority:fence") && state.events.includes("state:notify"));

  // Asking for what is already saved changes nothing.
  state.events.length = 0;
  const again = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 4, configuration: {}, homeHarness: true,
  });
  assert.equal(again.outcome, "updated");
  assert.equal(again.configuration?.config_revision, 4);
  assert.equal(state.events.some((event) => event.startsWith("store:update-config")), false);

  // A model or access edit carries the choice forward.
  const edited = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 4,
    configuration: { model: "gpt-5.6-mini", reasoning_effort: "low", charter: "Help the room", permission_profile_id: "ask_before_write" },
  });
  assert.equal(edited.outcome, "updated");
  assert.equal(edited.configuration?.home_harness, true);
  assert.deepEqual(state.configuration?.provider_launch_policy, {
    approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, ...OWN_SETUP_ON, ...changedAt(4),
    // The access level changed in this save, which is recorded beside the choice and does not disturb it.
    ...permissionChangedAt(5),
  });
  assert.equal(edited.configuration?.home_harness_pending, true);

  const stale = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 4, configuration: {}, homeHarness: false,
  });
  assert.equal(stale.outcome, "conflict", "a stale revision changes nothing");
  assert.equal(state.configuration?.config_revision, 5);

  const off = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 5, configuration: {}, homeHarness: false,
  });
  assert.equal(off.outcome, "updated");
  assert.equal(off.configuration?.home_harness, false);
  assert.equal(Object.hasOwn(state.configuration!.provider_launch_policy as object, OWN_SETUP_KEY), false,
    "off stores no key, exactly like an agent that never had it");
  assert.equal(off.configuration?.home_harness_pending, false, "the running process never started with it, so nothing is left to stop");
});

test("turning the owner's own setup off is not reported as done while the process that started with it still runs", async () => {
  const state = harness([entry({ provider: "codex" })]);
  const toggle = async (homeHarness: boolean) => {
    const result = await state.subject.updateAgentConfiguration({
      entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: state.configuration!.config_revision, configuration: {}, homeHarness,
    });
    assert.equal(result.outcome, "updated");
    return result.configuration!;
  };
  /** The agent restarts: its new process starts with the saved configuration. */
  const restart = () => state.setConfiguration({ ...state.configuration!, runtime_configuration_revision: state.configuration!.config_revision });
  const read = () => state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);

  assert.deepEqual([(await toggle(true)).home_harness, (await read()).home_harness_pending], [true, true]);
  restart();
  assert.deepEqual([(await read()).home_harness, (await read()).home_harness_pending], [true, false], "now it runs with it");

  const off = await toggle(false);
  assert.deepEqual([off.home_harness, off.home_harness_pending], [false, true], "saved off, but the running process still has it");
  // An ordinary save in between changes neither the choice nor what is still running.
  const saved = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: state.configuration!.config_revision,
    configuration: { model: "gpt-5.6", reasoning_effort: "low", charter: "Help the room", permission_profile_id: "full_access" },
  });
  assert.deepEqual([saved.configuration?.home_harness, saved.configuration?.home_harness_pending], [false, true]);
  // Back on before any restart: the process has had it all along.
  const backOn = await toggle(true);
  assert.deepEqual([backOn.home_harness, backOn.home_harness_pending], [true, false]);
  const offAgain = await toggle(false);
  assert.deepEqual([offAgain.home_harness, offAgain.home_harness_pending], [false, true]);
  restart();
  assert.deepEqual([(await read()).home_harness, (await read()).home_harness_pending], [false, false], "only a restart ends it");
});

test("turning the owner's setup on and off again leaves every agent's own settings, and what its saved tool permissions are tied to, exactly as they were", async () => {
  // Each access level, in the short form Add Agent stores and in the full form a Save stores.
  const cases: Array<[string, string | null, Record<string, unknown>]> = [
    ["codex", "full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["codex", "full_access", {}],
    ["codex", null, {}],
    ["codex", "ask_before_write", {}],
    ["codex", "ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["codex", "auto_review", {}],
    ["codex", "auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }],
    ["claude-code", "read_only", { permissionMode: "dontAsk", dangerouslySkipPermissions: false }],
    ["claude-code", "read_only", { permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: ["Read", "Glob", "Grep"], allowedTools: ["mcp__letagents__*"], settingSources: "" }],
    ["claude-code", "ask_before_write", { permissionMode: "default" }],
    ["claude-code", "ask_before_write", { permissionMode: "default", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"], allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}" }],
    ["claude-code", "auto_review", { permissionMode: "auto" }],
    ["claude-code", "full_access", { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true }],
    ["claude-code", "full_access", { dangerouslySkipPermissions: true, permissionMode: "bypassPermissions", model: "kept-as-it-was" }],
  ];
  for (const [provider, profile, policy] of cases) {
    const name = `${provider}/${profile}/${JSON.stringify(policy)}`;
    const state = harness([entry({ provider })]);
    state.setConfiguration(storedConfiguration({ provider, reasoning_effort: null, permission_profile_id: profile, provider_launch_policy: policy }));
    const before = structuredClone(state.configuration!);
    const digest = () => hostToolPolicyDigest({ permission_profile_id: state.configuration!.permission_profile_id ?? undefined, provider_launch_policy: state.configuration!.provider_launch_policy });
    const digestBefore = digest();
    const toggle = async (homeHarness: boolean) => {
      const result = await state.subject.updateAgentConfiguration({
        entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: state.configuration!.config_revision, configuration: {}, homeHarness,
      });
      assert.equal(result.outcome, "updated", name);
    };
    await toggle(true);
    assert.notEqual(digest(), digestBefore, `${name}: on, the saved tool permissions are paused`);
    // On adds LetAgents' own keys and touches nothing else.
    const native = Object.fromEntries(Object.entries(state.configuration!.provider_launch_policy as Record<string, unknown>).filter(([key]) => !key.startsWith("letagents")));
    assert.equal(JSON.stringify(native), JSON.stringify(policy), `${name}: the provider's own options are not rewritten`);
    await toggle(false);
    assert.equal(digest(), digestBefore, `${name}: off again, they apply again`);
    const after = state.configuration!;
    assert.deepEqual(
      { model: after.model, reasoning_effort: after.reasoning_effort, charter: after.charter, permission_profile_id: after.permission_profile_id },
      { model: before.model, reasoning_effort: before.reasoning_effort, charter: before.charter, permission_profile_id: before.permission_profile_id }, name);
    // A second round trip, and one made before the agent ever restarted, change nothing either.
    await toggle(true); await toggle(false);
    assert.equal(digest(), digestBefore, `${name}: second round trip`);
  }
});

test("a value planted in a rental's stored settings is removed by its next ordinary save", async () => {
  for (const [id, provider, profile, native] of [
    ["supervised_rental_0123", "codex", "full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["supervised_rental_0123", "cursor", "sandboxed_write", { force: true, sandbox: "enabled" }],
    ["agent-1", "cursor", "sandboxed_write", { force: true, sandbox: "enabled" }],
  ] as const) {
    const state = harness([entry({ id, provider })]);
    state.setConfiguration(storedConfiguration({
      provider, reasoning_effort: null, model: null, permission_profile_id: profile,
      provider_launch_policy: { ...native, ...OWN_SETUP_ON, ...changedAt(2) },
    }));
    const saved = await state.subject.updateAgentConfiguration({
      entryId: id, daemonGeneration: DAEMON_GENERATION, expectedRevision: 3,
      configuration: { model: null, reasoning_effort: null, charter: "Help the room, carefully", permission_profile_id: profile },
    });
    assert.equal(saved.outcome, "updated", `${id}/${provider}`);
    assert.deepEqual(state.configuration?.provider_launch_policy, native, `${id}/${provider}: neither key survives the save`);
    assert.equal(saved.configuration?.home_harness, false);
    assert.equal(saved.configuration?.home_harness_pending, false);
  }
});

test("an ordinary configuration update cannot turn the owner's own setup on", async () => {
  const state = harness([entry({ provider: "codex" })]);
  const fields = { model: "gpt-5.6", reasoning_effort: "high", charter: "Help the room", permission_profile_id: "full_access" };
  for (const smuggled of [
    { ...fields, homeHarness: true },
    { ...fields, home_harness: true },
    { ...fields, ...OWN_SETUP_ON },
  ]) {
    const result = await state.subject.updateAgentConfiguration({
      entryId: "agent-1", daemonGeneration: DAEMON_GENERATION,
      expectedRevision: state.configuration!.config_revision, configuration: smuggled,
    });
    assert.equal(result.outcome, "updated");
    assert.equal(result.configuration?.home_harness, false, JSON.stringify(smuggled));
    assert.equal(Object.hasOwn(state.configuration!.provider_launch_policy as object, OWN_SETUP_KEY), false);
  }
  const policy = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: state.configuration!.config_revision,
    configuration: { ...fields, provider_launch_policy: OWN_SETUP_ON },
  });
  assert.equal(policy.outcome, "invalid");
  assert.equal((await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION)).home_harness, false);

  // A choice that is not exactly on or off is refused, not guessed.
  const unclear = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: state.configuration!.config_revision,
    configuration: {}, homeHarness: "true" as never,
  });
  assert.equal(unclear.outcome, "invalid");
  assert.equal((await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION)).home_harness, false);
});

test("a rented agent and an agent app with no owner setup never get the owner's own setup", async () => {
  for (const [id, provider, availability, reason] of [
    ["supervised_rental_0123", "codex", "rental", /rented agent works for someone else/],
    ["supervised_rental_0123", "cursor", "rental", /rented agent works for someone else/],
    ["agent-1", "cursor", "unsupported", /no setup of yours/],
    ["agent-1", "open-model", "unsupported", /no setup of yours/],
  ] as const) {
    const state = harness([entry({ id, provider })]);
    // Even a stored value, however it got there, reads as off.
    state.setConfiguration(storedConfiguration({
      provider,
      permission_profile_id: provider === "cursor" ? "sandboxed_write" : "full_access",
      provider_launch_policy: provider === "cursor"
        ? { force: true, sandbox: "enabled", ...OWN_SETUP_ON }
        : provider === "open-model" ? { permission: { "*": "allow" }, ...OWN_SETUP_ON }
          : { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ...OWN_SETUP_ON },
    }));
    const current = await state.subject.getAgentConfiguration(id, DAEMON_GENERATION);
    assert.equal(current.home_harness, false, `${id}/${provider}`);
    assert.equal(current.home_harness_availability, availability);
    state.events.length = 0;
    const refused = await state.subject.updateAgentConfiguration({
      entryId: id, daemonGeneration: DAEMON_GENERATION, expectedRevision: 3, configuration: {}, homeHarness: true,
    });
    assert.equal(refused.outcome, "invalid");
    assert.match((refused as { error: string }).error, reason);
    assert.equal(state.events.some((event) => event.startsWith("store:update-config")), false, "nothing is written");
  }
});

test("an agent that collects its own room messages cannot be given the owner's own setup, and a stored value is taken out at its next save", async () => {
  for (const [provider, profile, native] of [
    ["codex", "full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["claude-code", "ask_before_write", { permissionMode: "default", dangerouslySkipPermissions: false }],
  ] as const) {
    for (const deliveryMode of ["mcp_polling", undefined] as const) {
      const state = harness([entry({ provider })]);
      const stored = storedConfiguration({
        provider, reasoning_effort: null, model: null, permission_profile_id: profile,
        provider_launch_policy: { ...native, ...OWN_SETUP_ON, ...changedAt(2) },
      });
      if (deliveryMode) stored.delivery_mode = deliveryMode; else delete stored.delivery_mode;
      state.setConfiguration(stored);
      // Settings shows it as off, with the reason, and never as waiting for a restart.
      const read = await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);
      assert.deepEqual([read.home_harness, read.home_harness_pending, read.home_harness_availability], [false, false, "polling"], `${provider}/${deliveryMode}`);
      // The desktop app's own signed request is refused, and nothing is written.
      state.events.length = 0;
      const refused = await state.subject.updateAgentConfiguration({
        entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 3, configuration: {}, homeHarness: true,
      });
      assert.equal(refused.outcome, "invalid");
      assert.match((refused as { error: string }).error, /it fetches its own messages, so LetAgents can't reliably switch your setup off again/);
      assert.equal(state.events.some((event) => event.startsWith("store:update-config")), false);
      // An ordinary save removes what was stored.
      const saved = await state.subject.updateAgentConfiguration({
        entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 3,
        configuration: { model: null, reasoning_effort: null, charter: "Help the room, carefully", permission_profile_id: profile },
      });
      assert.equal(saved.outcome, "updated");
      assert.equal(Object.keys(state.configuration!.provider_launch_policy as object).some((key) => key.startsWith("letagents")), false);
    }
  }
});

test("a Codex agent that collects its own room messages cannot be saved as Read-only: the level is listed as unavailable with the reason, and the save says it", async () => {
  const NEEDS_DELIVERY = "Read-only access is for a Codex agent that LetAgents delivers room messages to. "
    + "This agent collects its own room messages, so LetAgents cannot hold it to the room tools that Read-only allows. Choose another access level for this agent.";
  type Listed = { id: string; status: string; detail: string | null };
  const save = (state: ReturnType<typeof harness>, profile: string) => state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 3,
    configuration: { model: null, reasoning_effort: null, charter: "Help the room, carefully", permission_profile_id: profile },
  });
  const usual = supervisedPermissionProfilesForProvider("codex") as Listed[];
  for (const deliveryMode of ["mcp_polling", undefined] as const) {
    const state = harness([entry({ provider: "codex" })]);
    const stored = storedConfiguration({ model: null, reasoning_effort: null });
    if (deliveryMode) stored.delivery_mode = deliveryMode; else delete stored.delivery_mode;
    state.setConfiguration(stored);
    // Where the access levels are offered: Read-only cannot be chosen, and says why. Every other level is as it was.
    const listed = (await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION)).supervised_permission_profiles as Listed[];
    assert.deepEqual(listed.map((profile) => (profile.id === "read_only" ? [profile.status, profile.detail] : profile)),
      usual.map((profile) => (profile.id === "read_only" ? ["gated", NEEDS_DELIVERY] : profile)), String(deliveryMode));
    // Where it is saved: refused in the same words, and nothing is written.
    state.events.length = 0;
    const refused = await save(state, "read_only");
    assert.deepEqual([refused.outcome, (refused as { error?: string }).error], ["invalid", NEEDS_DELIVERY], String(deliveryMode));
    assert.equal(state.events.some((event) => event.startsWith("store:update-config")), false, "nothing is written");
    assert.equal(state.configuration!.permission_profile_id, "full_access");
    // Another level is saved as before.
    assert.equal((await save(state, "ask_before_write")).outcome, "updated");
    assert.equal(state.configuration!.permission_profile_id, "ask_before_write");
  }
  // An agent the background service delivers room messages to: Read-only is offered and saved.
  const delivered = harness([entry({ provider: "codex" })]);
  delivered.setConfiguration(storedConfiguration({ model: null, reasoning_effort: null }));
  assert.deepEqual((await delivered.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION)).supervised_permission_profiles, usual);
  assert.equal((await save(delivered, "read_only")).outcome, "updated");
  assert.equal(delivered.configuration!.permission_profile_id, "read_only");
  // Read-only for another provider is another thing, and is not touched.
  const claude = harness([entry({ provider: "claude-code" })]);
  claude.setConfiguration(storedConfiguration({ provider: "claude-code", model: null, reasoning_effort: null, permission_profile_id: "ask_before_write",
    provider_launch_policy: { permissionMode: "default", dangerouslySkipPermissions: false }, delivery_mode: "mcp_polling" }));
  assert.deepEqual((await claude.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION)).supervised_permission_profiles, supervisedPermissionProfilesForProvider("claude-code"));
  assert.equal((await save(claude, "read_only")).outcome, "updated");
});

test("a new agent cannot be created with the owner's own setup already on", async () => {
  const state = harness();
  for (const value of [false, true, "false", null]) {
    await assert.rejects(
      state.subject.putManifestEntry(entry({
        id: "supervised_new", provider: "codex",
        provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, [OWN_SETUP_KEY]: value },
      })),
      /turned on in the desktop app and cannot be supplied to manifest\.put/,
    );
  }
  // Nor with the key nested, in a history of changes, or carried on an own `__proto__` as JSON text can.
  for (const policy of [
    { approvalPolicy: "never", nested: OWN_SETUP_ON },
    { approvalPolicy: "never", ...changedAt(1) },
    // The record of a changed access level is the daemon's own too: a caller that could write one could make it restart the agent for ever.
    { approvalPolicy: "never", ...permissionChangedAt(99_999_999) },
    JSON.parse(`{"approvalPolicy":"never","__proto__":{"${OWN_SETUP_KEY}":false}}`),
    JSON.parse(`{"approvalPolicy":"never","sandboxPolicy":{"__proto__":{"${OWN_SETUP_KEY}":false}}}`),
    // Any spelling of a key LetAgents keeps for itself, and the escaped and repeated forms JSON text allows.
    { approvalPolicy: "never", LetagentsOwnerIsolation: false },
    { approvalPolicy: "never", "letagents-owner-isolation": false },
    { approvalPolicy: "never", letagentsHomeHarness: true },
    JSON.parse('{"approvalPolicy":"never","letagents\\u004fwnerIsolation":false}'),
    JSON.parse('{"approvalPolicy":"never","letagentsOwnerIsolation":true,"letagentsOwnerIsolation":false}'),
  ]) {
    await assert.rejects(
      state.subject.putManifestEntry(entry({ id: "supervised_new", provider: "codex", provider_launch_policy: policy })),
      /turned on in the desktop app and cannot be supplied to manifest\.put/, JSON.stringify(policy),
    );
  }
  assert.deepEqual(state.manifest.entries, []);
  assert.equal(state.events.includes("store:load"), false, "the request is refused before anything is read or written");
});

test("an agent that uses its owner's Claude settings is told so beside each access level", async () => {
  const state = harness([entry({ provider: "claude-code" })]);
  state.setConfiguration(storedConfiguration({
    provider: "claude-code", reasoning_effort: null, permission_profile_id: "ask_before_write",
    provider_launch_policy: { permissionMode: "default", dangerouslySkipPermissions: false, ...OWN_SETUP_ON },
  }));
  const on = await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);
  assert.equal(on.home_harness, true);
  const details = (on.supervised_permission_profiles as Array<{ detail: string | null }>).map((profile) => profile.detail ?? "").join(" ");
  assert.doesNotMatch(details, /Other Claude settings do not apply/);
  assert.match(details, /Your own Claude Code allow rules apply too, and can let the agent act without asking you/);
  state.setConfiguration(storedConfiguration({
    provider: "claude-code", reasoning_effort: null, permission_profile_id: "ask_before_write",
    provider_launch_policy: { permissionMode: "default", dangerouslySkipPermissions: false },
  }));
  const off = await state.subject.getAgentConfiguration("agent-1", DAEMON_GENERATION);
  assert.match((off.supervised_permission_profiles as Array<{ detail: string | null }>).map((profile) => profile.detail ?? "").join(" "),
    /Other Claude settings do not apply/);
});

test("a change to the access level is recorded against its revision and asks for the agent to be restarted; no other edit does", async () => {
  // Open Model cannot use the owner's setup: its stored policy is read without any key of LetAgents' own.
  const state = harness([entry({ provider: "open-model" })]);
  state.setConfiguration(storedConfiguration({ provider: "open-model", model: "qwen/qwen3-coder", reasoning_effort: null,
    permission_profile_id: "full_access", provider_launch_policy: { permission: { "*": "allow" } } }));
  const save = (expectedRevision: number, permission: string, extra: Record<string, unknown> = {}) => state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision,
    configuration: { model: "qwen/qwen3-coder", reasoning_effort: null, charter: "Help the room", permission_profile_id: permission, ...extra },
  });
  const requests = () => state.events.filter((event) => event.startsWith("convergence:"));

  state.events.length = 0;
  assert.equal((await save(3, "ask_before_write")).outcome, "updated");
  assert.deepEqual(state.configuration?.provider_launch_policy, { permission: { "*": "allow", edit: "ask", bash: "ask" }, ...permissionChangedAt(4) });
  assert.deepEqual(requests(), ["convergence:agent-1"], "a running agent is asked to take the new level as soon as it is idle");

  // Another edit while the agent has not restarted yet keeps the record, even though this agent's policy is read without it.
  state.events.length = 0;
  assert.equal((await save(4, "ask_before_write", { model: "qwen/other" })).outcome, "updated");
  assert.equal(state.configuration?.model, "qwen/other");
  assert.deepEqual(state.configuration?.provider_launch_policy, { permission: { "*": "allow", edit: "ask", bash: "ask" }, ...permissionChangedAt(4) },
    "the process that started before revision 4 still runs the old level, so the record stays");
  assert.deepEqual(requests(), [], "no other edit asks for a restart");

  // A later change replaces the record: it is the latest that decides.
  state.events.length = 0;
  assert.equal((await save(5, "auto_review")).outcome, "updated");
  assert.deepEqual(state.configuration?.provider_launch_policy, { permission: { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" }, ...permissionChangedAt(6) });
  assert.deepEqual(requests(), ["convergence:agent-1"]);

  // Nothing is recorded, or asked for, when nothing changed or nothing was saved.
  state.events.length = 0;
  assert.equal((await save(6, "auto_review", { charter: "Another" })).outcome, "updated");
  assert.equal((await save(6, "full_access")).outcome, "conflict", "a stale revision saves nothing");
  state.setConfigurationOutcome("invalid");
  assert.equal((await save(7, "full_access")).outcome, "invalid");
  assert.deepEqual(requests(), []);
  assert.deepEqual(state.configuration?.provider_launch_policy, { permission: { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" }, ...permissionChangedAt(6) });
});

test("an agent that never had its access level saved is changed from the level it would have started with", async () => {
  // No level is saved: Codex starts with full access, so choosing full access changes nothing.
  const state = harness([entry({ provider: "codex" })]);
  state.setConfiguration(storedConfiguration({ permission_profile_id: null, provider_launch_policy: {} }));
  const save = (expectedRevision: number, permission: string) => state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision,
    configuration: { model: "gpt-5.6", reasoning_effort: "high", charter: "Help the room", permission_profile_id: permission },
  });
  state.events.length = 0;
  assert.equal((await save(3, "full_access")).outcome, "updated");
  assert.equal(Object.keys(state.configuration!.provider_launch_policy as object).some((key) => key.startsWith("letagentsPermission")), false);
  assert.deepEqual(state.events.filter((event) => event.startsWith("convergence:")), []);
  assert.equal((await save(4, "ask_before_write")).outcome, "updated");
  assert.deepEqual(state.events.filter((event) => event.startsWith("convergence:")), ["convergence:agent-1"]);
});

test("the owner's own setup is saved beside a change to the access level without disturbing it", async () => {
  const state = harness([entry({ provider: "codex" })]);
  await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 3,
    configuration: { model: "gpt-5.6", reasoning_effort: "high", charter: "Help the room", permission_profile_id: "ask_before_write" },
  });
  assert.deepEqual(state.configuration?.provider_launch_policy, {
    approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, ...permissionChangedAt(4),
  });
  state.events.length = 0;
  const on = await state.subject.updateAgentConfiguration({
    entryId: "agent-1", daemonGeneration: DAEMON_GENERATION, expectedRevision: 4, configuration: {}, homeHarness: true,
  });
  assert.equal(on.outcome, "updated");
  assert.deepEqual(state.configuration?.provider_launch_policy, {
    approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, ...OWN_SETUP_ON, ...changedAt(5), ...permissionChangedAt(4),
  }, "the record of the access level survives the switch");
  assert.deepEqual(state.events.filter((event) => event.startsWith("convergence:")), [], "the switch has its own restart");
});
