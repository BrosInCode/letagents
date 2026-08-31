import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleAdministrationCoordinator,
  type LifecycleAdministrationPorts,
} from "../lifecycle-administration-coordinator.js";
import type { ProviderActionTerminal } from "../provider-action-port.js";
import type {
  DaemonManifestEntry,
  DaemonPurgeRecord,
  TaskWorkAttempt,
} from "../types.js";
import type {
  SupervisedWorkerMintState,
  SupervisedWorkerSession,
  WorkerSessionBinding,
} from "../worker-binding-store.js";

const DAEMON_GENERATION = 7;
const NOW_ISO = "2026-08-26T10:00:00.000Z";
const WORK_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

function entry(overrides: Partial<DaemonManifestEntry> = {}): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent One",
    provider: "codex",
    model: null,
    charter: "Handle room work.",
    desired_state: "stopped",
    observed_state: "stopped",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "user-1",
    created_at: NOW_ISO,
    ...overrides,
  };
}

function purgeRecord(overrides: Partial<DaemonPurgeRecord> = {}): DaemonPurgeRecord {
  return {
    operation_id: "purge:agent-1",
    request_id: "purge:agent-1",
    agent_id: "agent-1",
    daemon_generation: DAEMON_GENERATION,
    phase: "local_commit",
    external_revoke_required: false,
    attached_work_attempt_id: null,
    preserved_workspace_path: null,
    worker_session_attestation: "not_required",
    agent_session_id: null,
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function attempt(input: {
  id?: string;
  ephemeral?: boolean;
  state?: TaskWorkAttempt["state"];
  concluded?: boolean;
  liveExecution?: boolean;
} = {}): TaskWorkAttempt {
  const id = input.id ?? WORK_ATTEMPT_ID;
  const ephemeral = input.ephemeral ?? true;
  const state = input.state ?? "active";
  const concluded = input.concluded ?? false;
  return {
    work_attempt_id: id,
    task_id: "task-1",
    lease_id: "lease-1",
    current_lease_epoch: 1,
    epoch_history: [{ lease_id: "lease-1", epoch: 1, recorded_at: NOW_ISO }],
    workspace_path: `/tmp/${id}`,
    workspace_identity: {
      repo: ephemeral ? "room-only" : "repo",
      remote_url: ephemeral ? "letagents-ephemeral:fixture" : "https://example.com/repo.git",
      resolved_revision: ephemeral ? "0".repeat(40) : "a".repeat(40),
      bare_path: `/tmp/${id}`,
    },
    state,
    created_at: NOW_ISO,
    concluded_at: concluded ? NOW_ISO : null,
    conclusion_cause: concluded ? "fixture" : null,
    postmortem_diff: concluded ? "" : null,
    checkpoints: [],
    execution_generations: input.liveExecution === undefined
      ? []
      : [{
        execution_generation_id: EXECUTION_ID,
        work_attempt_id: id,
        started_at: NOW_ISO,
        actor: "daemon-provider",
        generation: 1,
        terminal: input.liveExecution ? null : {
          ended_at: NOW_ISO,
          exit_code: 0,
          signal: null,
          stdio_archive_ref: null,
          stdio_tail: "",
          terminal_cause: "stopped",
          actor: "daemon-provider",
          generation: 1,
          provider_continuation_id: "continuation-1",
        },
      }],
  };
}

function binding(sessionId = "session-1"): WorkerSessionBinding {
  return {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: WORK_ATTEMPT_ID,
    execution_generation_id: EXECUTION_ID,
    agent_session_id: sessionId,
    credential_ref: "credential-1",
    api_url: "https://letagents.chat",
    room_cursor: null,
    last_sequence: 0,
    last_observed_at_ms: Date.parse(NOW_ISO),
    updated_at: NOW_ISO,
  };
}

function session(sessionId = "session-1"): SupervisedWorkerSession {
  return {
    agent_id: "agent-1",
    room_id: "room-1",
    agent_session_id: sessionId,
    execution_generation_id: EXECUTION_ID,
    credential_ref: "credential-1",
    expires_at: null,
    updated_at: NOW_ISO,
  };
}

function mint(sessionId = "session-1"): SupervisedWorkerMintState {
  return {
    agent_id: "agent-1",
    room_id: "room-1",
    agent_instance_id: "instance-1",
    phase: "exact",
    agent_session_id: sessionId,
    updated_at: NOW_ISO,
  };
}

type Harness = ReturnType<typeof harness>;

function harness() {
  const events: string[] = [];
  let daemonGeneration = DAEMON_GENERATION;
  let manifestGeneration = 11;
  let currentEntry: DaemonManifestEntry | undefined = entry();
  let currentPurge: DaemonPurgeRecord | null = null;
  let pendingPurges: DaemonPurgeRecord[] = [];
  let currentBinding: WorkerSessionBinding | null = null;
  let currentSession: SupervisedWorkerSession | null = null;
  let currentMint: SupervisedWorkerMintState | null = null;
  let liveHandle = false;
  let workerAttestation: Awaited<ReturnType<LifecycleAdministrationPorts["store"]["durablePurgeWorkerSessionAttestation"]>> = {
    workerSessionAttestation: "none",
    agentSessionId: null,
  };
  const attempts = new Map<string, TaskWorkAttempt>();
  let stopRef: NonNullable<LifecycleAdministrationPorts["provider"]>["stopRef"];
  let commitPurgeError: Error | null = null;
  let desiredStateError: Error | null = null;
  let serializeEntryError: Error | null = null;
  let stopDeliveryError: Error | null = null;
  let concludeAttemptError: Error | null = null;
  let getEntryReads = 0;
  let getEntryHook: ((readCount: number) => void) | null = null;
  const recoveryRefusals: Array<{ message: string; error?: unknown }> = [];
  const orphanRetainedSets: string[][] = [];
  const serializedEntries: string[] = [];

  const terminal: ProviderActionTerminal = {
    endedAt: NOW_ISO,
    exitCode: 0,
    signal: null,
    terminalCause: "stopped",
    providerContinuationId: "continuation-1",
  };
  stopRef = async () => terminal;

  const ports: LifecycleAdministrationPorts = {
    store: {
      async load() {
        events.push("store:load");
        return {
          generation: manifestGeneration,
          entries: currentEntry ? [currentEntry] : [],
          legacy_lane_owners: [],
        };
      },
      async getEntry(entryId) {
        events.push(`store:get-entry:${entryId}`);
        getEntryReads += 1;
        getEntryHook?.(getEntryReads);
        return currentEntry?.id === entryId ? currentEntry : undefined;
      },
      async getAgentConfiguration(entryId) {
        if (currentEntry?.id !== entryId) return null;
        return {
          agent_id: currentEntry.id,
          provider: currentEntry.provider,
          model: currentEntry.model,
          charter: currentEntry.charter,
          permission_profile_id: currentEntry.permission_profile_id,
          delivery_mode: currentEntry.delivery_mode,
          polling_contract: null,
        };
      },
      async getPurge(operationId) {
        events.push(`store:get-purge:${operationId}`);
        return currentPurge?.operation_id === operationId ? currentPurge : null;
      },
      async pendingPurges() {
        events.push("store:pending-purges");
        return pendingPurges;
      },
      async durablePurgeWorkerSessionAttestation(entryId) {
        events.push(`store:attestation:${entryId}`);
        return workerAttestation;
      },
      async preparePurge(expectedGeneration, input) {
        events.push(`store:prepare-purge:${expectedGeneration}`);
        currentPurge = purgeRecord({
          operation_id: input.operationId,
          request_id: input.requestId,
          agent_id: input.agentId,
          daemon_generation: input.daemonGeneration,
          phase: input.externalRevokeRequired ? "revoking_credentials" : "local_commit",
          external_revoke_required: input.externalRevokeRequired,
          worker_session_attestation: input.workerSessionAttestation,
          agent_session_id: input.agentSessionId,
        });
        return { generation: expectedGeneration, created: true, purge: currentPurge };
      },
      async adoptPurgeDaemonGeneration(input) {
        events.push(`store:adopt:${input.expectedDaemonGeneration}->${input.daemonGeneration}`);
        currentPurge = { ...currentPurge!, daemon_generation: input.daemonGeneration };
        return currentPurge;
      },
      async repreparePurgeCredentials(input) {
        events.push("store:reprepare-credentials");
        currentPurge = {
          ...currentPurge!,
          phase: "revoking_credentials",
          worker_session_attestation: input.workerSessionAttestation,
          agent_session_id: input.agentSessionId,
        };
        return currentPurge;
      },
      async markPurgeCredentialsRevoked(input) {
        events.push(`store:credentials-revoked:${input.agentSessionId}`);
        currentPurge = { ...currentPurge!, phase: "local_commit" };
        return currentPurge;
      },
      async markPurgeGrantRevokedWithoutWorkerSession() {
        events.push("store:grant-revoked");
        currentPurge = { ...currentPurge!, phase: "local_commit" };
        return currentPurge;
      },
      async commitPurge(expectedGeneration, input, fence) {
        events.push(`store:commit-request:${expectedGeneration}:${input.operationId}`);
        if (commitPurgeError) throw commitPurgeError;
        await (fence ?? (async (commit) => commit()))(async () => {
          events.push("store:commit-purge");
          currentPurge = { ...currentPurge!, phase: "complete" };
          currentEntry = undefined;
          manifestGeneration += 1;
        });
        return { generation: manifestGeneration, purge: currentPurge! };
      },
    },
    bindings: {
      async get() {
        events.push("bindings:get");
        return currentBinding;
      },
      async supervisedWorkerSession() {
        events.push("bindings:session");
        return currentSession;
      },
      async supervisedWorkerMintState() {
        events.push("bindings:mint");
        return currentMint;
      },
      async retireSupervisedWorkerAuthority(_entryId, exactSessionId) {
        events.push(`bindings:retire:${exactSessionId ?? "none"}`);
        currentBinding = null;
        currentSession = null;
        currentMint = null;
      },
    },
    durability: {
      async getAttempt(workAttemptId) {
        events.push(`durability:get:${workAttemptId}`);
        const value = attempts.get(workAttemptId);
        if (!value) throw new Error(`missing attempt ${workAttemptId}`);
        return value;
      },
      async listAttempts() {
        events.push("durability:list");
        return [...attempts.values()];
      },
      async recordTerminal(workAttemptId, executionGenerationId, payload) {
        events.push(`durability:terminal:${executionGenerationId}`);
        const value = attempts.get(workAttemptId)!;
        const execution = value.execution_generations.find((candidate) =>
          candidate.execution_generation_id === executionGenerationId)!;
        execution.terminal = payload;
        return execution;
      },
      async releaseTerminalExecutionFence(_workAttemptId, executionGenerationId) {
        events.push(`durability:release-terminal:${executionGenerationId}`);
      },
      async concludeAttempt(workAttemptId, input) {
        events.push(`durability:conclude:${input.cause}`);
        if (concludeAttemptError) throw concludeAttemptError;
        const concluded = {
          ...attempts.get(workAttemptId)!,
          state: input.state,
          concluded_at: NOW_ISO,
          conclusion_cause: input.cause,
          postmortem_diff: "",
        } satisfies TaskWorkAttempt;
        attempts.set(workAttemptId, concluded);
        return concluded;
      },
      async garbageCollectEphemeralAttempt(workAttemptId) {
        events.push(`durability:gc:${workAttemptId}`);
        attempts.delete(workAttemptId);
        return true;
      },
    },
    authority: {
      currentDaemonGeneration: () => daemonGeneration,
      currentManifestGeneration: () => manifestGeneration,
      acceptManifestGeneration(generation) {
        events.push(`authority:accept-generation:${generation}`);
        manifestGeneration = generation;
      },
      async assertCurrent() {
        events.push("authority:assert");
      },
      async fenceCommit(commit) {
        events.push("authority:fence");
        await commit();
      },
      async serializeManifestMutation(operation) {
        events.push("authority:serialize-manifest");
        return operation();
      },
    },
    beginLifecycle(entryId) {
      events.push(`lifecycle:begin:${entryId}`);
      return () => events.push(`lifecycle:release:${entryId}`);
    },
    async serializeEntry(entryId, operation) {
      events.push(`entry:serialize:${entryId}`);
      serializedEntries.push(entryId);
      if (serializeEntryError) throw serializeEntryError;
      return operation();
    },
    async setDesiredStateExclusive(entryId) {
      events.push(`desired:stopped:${entryId}`);
      if (desiredStateError) throw desiredStateError;
      currentEntry = { ...currentEntry!, desired_state: "stopped" };
      return currentEntry;
    },
    async updateManifestEntry(entryId, update) {
      events.push(`manifest:update:${entryId}`);
      currentEntry = update(currentEntry!);
      return currentEntry;
    },
    async entryWithDerivedLiveness(projected) {
      events.push(`liveness:project:${projected.id}`);
      return projected;
    },
    async stopDelivery(entryId) {
      events.push(`delivery:stop:${entryId}`);
      if (stopDeliveryError) throw stopDeliveryError;
    },
    hasLiveHandle: () => liveHandle,
    provider: {
      stopRef: (ref, options) => stopRef!(ref, options),
    },
    runtimeCustody: {
      deleteLiveBinding(entryId) { events.push(`custody:live:${entryId}`); },
      deletePendingResumeBinding(entryId) { events.push(`custody:resume:${entryId}`); },
      deleteWorkerAuthorization(entryId) { events.push(`custody:auth:${entryId}`); },
      deleteHostGrant(entryId) { events.push(`custody:grant:${entryId}`); },
      deleteOpenModelCredential(entryId) { events.push(`custody:model:${entryId}`); },
    },
    deleteAgentStream(entryId) {
      events.push(`stream:delete:${entryId}`);
    },
    ephemeralProvisioner: {
      async garbageCollectOrphans(retainedAttemptIds) {
        const retained = [...retainedAttemptIds].sort();
        events.push(`workspace:gc-orphans:${retained.join(",")}`);
        orphanRetainedSets.push(retained);
        return [];
      },
    },
    nowMs: () => Date.parse(NOW_ISO),
    reportRecoveryRefusal(message, error) {
      recoveryRefusals.push(error === undefined ? { message } : { message, error });
    },
  };

  return {
    subject: new LifecycleAdministrationCoordinator(ports),
    events,
    attempts,
    recoveryRefusals,
    orphanRetainedSets,
    serializedEntries,
    setDaemonGeneration: (value: number) => { daemonGeneration = value; },
    setEntry: (value: DaemonManifestEntry | undefined) => { currentEntry = value; },
    getEntry: () => currentEntry,
    setPurge: (value: DaemonPurgeRecord | null) => { currentPurge = value; },
    getPurge: () => currentPurge,
    setPendingPurges: (value: DaemonPurgeRecord[]) => { pendingPurges = value; },
    setBinding: (value: WorkerSessionBinding | null) => { currentBinding = value; },
    setSession: (value: SupervisedWorkerSession | null) => { currentSession = value; },
    setMint: (value: SupervisedWorkerMintState | null) => { currentMint = value; },
    setLiveHandle: (value: boolean) => { liveHandle = value; },
    setAttestation: (value: typeof workerAttestation) => { workerAttestation = value; },
    setStopRef: (value: typeof stopRef) => { stopRef = value; },
    setCommitPurgeError: (value: Error | null) => { commitPurgeError = value; },
    setDesiredStateError: (value: Error | null) => { desiredStateError = value; },
    setSerializeEntryError: (value: Error | null) => { serializeEntryError = value; },
    setStopDeliveryError: (value: Error | null) => { stopDeliveryError = value; },
    setConcludeAttemptError: (value: Error | null) => { concludeAttemptError = value; },
    setGetEntryHook: (value: typeof getEntryHook) => { getEntryHook = value; },
  };
}

test("retire fences invalid coordinates before lifecycle admission and always releases admitted exclusion", async () => {
  const stale = harness();
  await assert.rejects(
    stale.subject.retireAgent("agent-1", DAEMON_GENERATION + 1),
    /stale or invalid lifecycle coordinates/,
  );
  assert.deepEqual(stale.events, []);

  const failed = harness();
  failed.setDesiredStateError(new Error("stop failed"));
  await assert.rejects(failed.subject.retireAgent("agent-1", DAEMON_GENERATION), /stop failed/);
  assert.deepEqual(failed.events, [
    "lifecycle:begin:agent-1",
    "desired:stopped:agent-1",
    "lifecycle:release:agent-1",
  ]);
});

test("retire of a non-inbox agent preserves identity without credential cleanup", async () => {
  const h = harness();
  h.setEntry(entry({ delivery_mode: "mcp_polling", desired_state: "running" }));

  const result = await h.subject.retireAgent("agent-1", DAEMON_GENERATION);

  assert.equal(result.outcome, "retired");
  assert.deepEqual(h.events, [
    "lifecycle:begin:agent-1",
    "desired:stopped:agent-1",
    "liveness:project:agent-1",
    "lifecycle:release:agent-1",
  ]);
});

test("retire requires the exact worker-session acknowledgement and cleans authority in order", async () => {
  const h = harness();
  h.setBinding(binding());
  h.setSession(session());
  h.setMint(mint());

  assert.deepEqual(await h.subject.retireAgent("agent-1", DAEMON_GENERATION), {
    outcome: "revocation_required",
    revocation_kind: "worker_session",
    agent_session_id: "session-1",
  });
  assert.equal(h.events.includes("bindings:retire:session-1"), false);

  h.events.length = 0;
  const result = await h.subject.retireAgent("agent-1", DAEMON_GENERATION, "session-1");
  assert.equal(result.outcome, "retired");
  assert.deepEqual(h.events.slice(-10), [
    "store:get-entry:agent-1",
    "delivery:stop:agent-1",
    "bindings:retire:session-1",
    "custody:live:agent-1",
    "custody:resume:agent-1",
    "custody:auth:agent-1",
    "custody:grant:agent-1",
    "manifest:update:agent-1",
    "liveness:project:agent-1",
    "lifecycle:release:agent-1",
  ]);
  assert.deepEqual(h.getEntry()?.workplace_liveness, {
    state: "stale",
    observed_at: NOW_ISO,
    detail: "Retired agent has no active room worker session.",
  });
});

test("retire refuses conflicting durable session identities without removing authority", async () => {
  const h = harness();
  h.setBinding(binding("session-binding"));
  h.setSession(session("session-record"));

  assert.deepEqual(await h.subject.retireAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Retirement found conflicting worker-session identities; no authority was removed.",
  });
  assert.equal(h.events.some((event) => event.startsWith("custody:")), false);
  assert.equal(h.events.some((event) => event.startsWith("bindings:retire")), false);
});

test("retire revokes latent grant authority even when no worker session was minted", async () => {
  const h = harness();

  assert.deepEqual(await h.subject.retireAgent("agent-1", DAEMON_GENERATION), {
    outcome: "revocation_required",
    revocation_kind: "grant_only",
  });
  h.events.length = 0;
  assert.equal(
    (await h.subject.retireAgent("agent-1", DAEMON_GENERATION, null, true)).outcome,
    "retired",
  );
  assert.ok(h.events.indexOf("bindings:retire:none") < h.events.indexOf("custody:grant:agent-1"));
});

test("retire swallows delivery-stop failure but rechecks daemon generation before cleanup", async () => {
  const stopped = harness();
  stopped.setBinding(binding());
  stopped.setSession(session());
  stopped.setMint(mint());
  stopped.setStopDeliveryError(new Error("delivery already detached"));

  assert.equal(
    (await stopped.subject.retireAgent("agent-1", DAEMON_GENERATION, "session-1")).outcome,
    "retired",
  );
  assert.ok(stopped.events.indexOf("delivery:stop:agent-1")
    < stopped.events.indexOf("bindings:retire:session-1"));

  const fenced = harness();
  fenced.setBinding(binding());
  fenced.setSession(session());
  fenced.setMint(mint());
  fenced.setGetEntryHook((readCount) => {
    if (readCount === 2) fenced.setDaemonGeneration(DAEMON_GENERATION + 1);
  });
  assert.deepEqual(
    await fenced.subject.retireAgent("agent-1", DAEMON_GENERATION, "session-1"),
    { outcome: "invalid", error: "Agent lifecycle changed before retirement cleanup." },
  );
  assert.equal(fenced.events.includes("delivery:stop:agent-1"), false);
  assert.equal(fenced.events.includes("bindings:retire:session-1"), false);
});

test("purge rejects nonterminal lifecycle and a live provider or bounded turn", async () => {
  const running = harness();
  running.setEntry(entry({ desired_state: "running", observed_state: "working" }));
  assert.deepEqual(await running.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge requires a fully stopped durable lifecycle.",
  });
  assert.equal(running.events.includes("authority:serialize-manifest"), false);

  const live = harness();
  live.setLiveHandle(true);
  assert.deepEqual(await live.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge requires no live provider or bounded delivery turn.",
  });
  assert.equal(live.events.includes("store:prepare-purge:11"), false);
});

test("purge resolves absent identities only when their tombstone is absent or complete", async () => {
  const neverPrepared = harness();
  neverPrepared.setEntry(undefined);
  assert.deepEqual(await neverPrepared.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "purged",
  });

  const complete = harness();
  complete.setEntry(undefined);
  complete.setPurge(purgeRecord({
    phase: "complete",
    attached_work_attempt_id: WORK_ATTEMPT_ID,
  }));
  assert.deepEqual(await complete.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "purged",
    purged_work_attempt_id: WORK_ATTEMPT_ID,
  });

  const incomplete = harness();
  incomplete.setEntry(undefined);
  incomplete.setPurge(purgeRecord({ phase: "local_commit" }));
  assert.deepEqual(await incomplete.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge identity is absent but its journal is incomplete.",
  });
});

test("purge fences an unattached Cursor wrapper before preparing external revocation", async () => {
  const h = harness();
  const cursorAttempt = attempt({ liveExecution: true });
  h.attempts.set(WORK_ATTEMPT_ID, cursorAttempt);
  h.setEntry(entry({
    work_attempt_id: WORK_ATTEMPT_ID,
    provider_ref: {
      work_attempt_id: WORK_ATTEMPT_ID,
      execution_generation_id: EXECUTION_ID,
      provider_continuation_id: "continuation-1",
      provider_connection: {
        kind: "cursor_cli",
        pid: 4242,
        processIdentity: "cursor-birth",
      },
    },
  }));
  h.setAttestation({ workerSessionAttestation: "exact", agentSessionId: "session-1" });
  h.setStopRef(async (ref, options) => {
    h.events.push(`provider:stop-ref:${ref.workAttemptId}:${options?.actionId}`);
    return {
      endedAt: NOW_ISO,
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: "continuation-1",
    };
  });

  const result = await h.subject.purgeAgent("agent-1", DAEMON_GENERATION);

  assert.deepEqual(result, {
    outcome: "revocation_required",
    operation_id: "purge:agent-1",
    revocation_kind: "worker_session",
    agent_session_id: "session-1",
  });
  assert.deepEqual(h.events.slice(1, 8), [
    "store:get-entry:agent-1",
    `provider:stop-ref:${WORK_ATTEMPT_ID}:purge:agent-1:cursor-wrapper-fence:${EXECUTION_ID}`,
    `durability:get:${WORK_ATTEMPT_ID}`,
    `durability:terminal:${EXECUTION_ID}`,
    `durability:release-terminal:${EXECUTION_ID}`,
    "authority:serialize-manifest",
    "authority:assert",
  ]);
  assert.ok(h.events.indexOf(`durability:release-terminal:${EXECUTION_ID}`)
    < h.events.indexOf("store:prepare-purge:11"));
});

test("Cursor purge reports stop failures and missing execution evidence, but releases an already-terminal fence", async () => {
  const cursorEntry = (executionGenerationId = EXECUTION_ID) => entry({
    work_attempt_id: WORK_ATTEMPT_ID,
    provider_ref: {
      work_attempt_id: WORK_ATTEMPT_ID,
      execution_generation_id: executionGenerationId,
      provider_continuation_id: "continuation-1",
      provider_connection: {
        kind: "cursor_cli",
        pid: 4242,
        processIdentity: "cursor-birth",
      },
    },
  });

  const stopFailure = harness();
  stopFailure.setEntry(cursorEntry());
  stopFailure.setStopRef(async () => { throw new Error("wrapper refused stop"); });
  assert.deepEqual(await stopFailure.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge could not fence the unattached Cursor wrapper: wrapper refused stop",
  });

  const missingExecution = harness();
  missingExecution.setEntry(cursorEntry("missing-execution"));
  missingExecution.attempts.set(WORK_ATTEMPT_ID, attempt({ liveExecution: true }));
  assert.deepEqual(await missingExecution.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge could not fence the unattached Cursor wrapper: Cursor purge fence has no matching durable execution generation.",
  });

  const terminal = harness();
  terminal.setEntry(cursorEntry());
  terminal.attempts.set(WORK_ATTEMPT_ID, attempt({ liveExecution: false }));
  terminal.setPurge(purgeRecord({ phase: "complete" }));
  assert.equal((await terminal.subject.purgeAgent("agent-1", DAEMON_GENERATION)).outcome, "purged");
  assert.equal(terminal.events.includes(`durability:terminal:${EXECUTION_ID}`), false);
  assert.equal(terminal.events.includes(`durability:release-terminal:${EXECUTION_ID}`), true);
});

test("purge adopts a recovered journal, reprepares exact credential evidence, and waits for grant acknowledgement", async () => {
  const h = harness();
  h.setPurge(purgeRecord({
    daemon_generation: DAEMON_GENERATION - 1,
    phase: "reprepare_credentials",
    external_revoke_required: true,
    worker_session_attestation: "unknown",
  }));
  h.setAttestation({ workerSessionAttestation: "none", agentSessionId: null });

  assert.deepEqual(await h.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "revocation_required",
    operation_id: "purge:agent-1",
    revocation_kind: "grant_only",
  });
  assert.ok(h.events.indexOf("store:adopt:6->7") < h.events.indexOf("store:reprepare-credentials"));

  h.events.length = 0;
  assert.equal(
    (await h.subject.purgeAgent("agent-1", DAEMON_GENERATION, null, true)).outcome,
    "purged",
  );
  assert.ok(h.events.indexOf("store:grant-revoked") < h.events.indexOf("authority:fence"));
});

test("purge refuses unknown credential recovery and internally inconsistent revocation evidence", async () => {
  const unknown = harness();
  unknown.setPurge(purgeRecord({
    phase: "reprepare_credentials",
    external_revoke_required: true,
    worker_session_attestation: "unknown",
  }));
  unknown.setAttestation({ workerSessionAttestation: "unknown", agentSessionId: null });
  assert.deepEqual(await unknown.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge credential recovery needs an exact retained worker session or durable proof that no worker session was minted.",
  });

  const inconsistent = harness();
  inconsistent.setPurge(purgeRecord({
    phase: "revoking_credentials",
    external_revoke_required: true,
    worker_session_attestation: "exact",
    agent_session_id: null,
  }));
  assert.deepEqual(await inconsistent.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "Purge revocation evidence is internally inconsistent.",
  });
});

test("purge commits ephemeral cleanup before its fenced identity deletion, then clears process custody", async () => {
  const h = harness();
  h.attempts.set(WORK_ATTEMPT_ID, attempt());
  h.setEntry(entry({ work_attempt_id: WORK_ATTEMPT_ID }));
  h.setPurge(purgeRecord({ attached_work_attempt_id: WORK_ATTEMPT_ID }));

  assert.deepEqual(await h.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "purged",
    purged_work_attempt_id: WORK_ATTEMPT_ID,
  });
  const expectedOrder = [
    `durability:get:${WORK_ATTEMPT_ID}`,
    "durability:conclude:room_only_agent_purged",
    `durability:gc:${WORK_ATTEMPT_ID}`,
    "store:commit-request:11:purge:agent-1",
    "authority:fence",
    "store:commit-purge",
    "authority:accept-generation:12",
    "custody:live:agent-1",
    "custody:auth:agent-1",
    "custody:grant:agent-1",
    "custody:model:agent-1",
    "stream:delete:agent-1",
  ];
  assert.deepEqual(h.events.slice(-expectedOrder.length), expectedOrder);
});

test("a failed purge commit leaves process custody intact for recovery", async () => {
  const h = harness();
  h.setPurge(purgeRecord());
  h.setCommitPurgeError(new Error("database unavailable"));

  assert.deepEqual(await h.subject.purgeAgent("agent-1", DAEMON_GENERATION), {
    outcome: "invalid",
    error: "database unavailable",
  });
  assert.equal(h.events.some((event) => event.startsWith("custody:")), false);
  assert.equal(h.events.includes("stream:delete:agent-1"), false);
});

test("prepared purge recovery replays only local commits and swallows replay failures", async () => {
  const h = harness();
  h.setEntry(undefined);
  h.setPendingPurges([
    purgeRecord({ agent_id: "agent-local", operation_id: "purge:agent-local" }),
    purgeRecord({
      agent_id: "agent-revoke",
      operation_id: "purge:agent-revoke",
      phase: "revoking_credentials",
    }),
    purgeRecord({ agent_id: "agent-failed", operation_id: "purge:agent-failed", phase: "failed" }),
  ]);
  h.setSerializeEntryError(new Error("replay lane unavailable"));

  await h.subject.recoverPreparedPurges();

  assert.deepEqual(h.serializedEntries, ["agent-local"]);
});

test("ephemeral attempt removal is idempotent and refuses durable Git workspaces", async () => {
  const durable = harness();
  durable.attempts.set(WORK_ATTEMPT_ID, attempt({ ephemeral: false }));
  assert.equal(await durable.subject.removeEphemeralWorkAttempt(WORK_ATTEMPT_ID), false);
  assert.equal(durable.events.some((event) => event.startsWith("durability:gc")), false);

  const ephemeral = harness();
  ephemeral.attempts.set(WORK_ATTEMPT_ID, attempt({ state: "gc_pending", concluded: true }));
  assert.equal(await ephemeral.subject.removeEphemeralWorkAttempt(WORK_ATTEMPT_ID), true);
  assert.equal(ephemeral.events.includes("durability:conclude:room_only_agent_purged"), false);
  assert.equal(ephemeral.events.includes(`durability:gc:${WORK_ATTEMPT_ID}`), true);

  const collected = harness();
  collected.attempts.set(WORK_ATTEMPT_ID, attempt({
    state: "garbage_collected",
    concluded: true,
  }));
  assert.equal(await collected.subject.removeEphemeralWorkAttempt(WORK_ATTEMPT_ID), true);
  assert.equal(await collected.subject.removeEphemeralWorkAttempt(WORK_ATTEMPT_ID), true);
  assert.equal(collected.events.some((event) => event.startsWith("durability:conclude")), false);
  assert.equal(collected.events.some((event) => event.startsWith("durability:gc")), false);
});

test("workspace recovery keeps attachments, refuses live executions, collects safe orphans, and fences filesystem GC", async () => {
  const h = harness();
  const attachedRuntime = "33333333-3333-4333-8333-333333333333";
  const attachedProvider = "44444444-4444-4444-8444-444444444444";
  const attachedPurge = "55555555-5555-4555-8555-555555555555";
  const liveOrphan = "66666666-6666-4666-8666-666666666666";
  const safeOrphan = "77777777-7777-4777-8777-777777777777";
  const durableOrphan = "88888888-8888-4888-8888-888888888888";
  h.setEntry(entry({
    work_attempt_id: attachedRuntime,
    provider_ref: {
      work_attempt_id: attachedProvider,
      execution_generation_id: EXECUTION_ID,
      provider_continuation_id: "continuation-1",
      provider_connection: null,
    },
  }));
  h.setPendingPurges([purgeRecord({ attached_work_attempt_id: attachedPurge })]);
  for (const candidate of [attachedRuntime, attachedProvider, attachedPurge]) {
    h.attempts.set(candidate, attempt({ id: candidate }));
  }
  h.attempts.set(liveOrphan, attempt({ id: liveOrphan, liveExecution: true }));
  h.attempts.set(safeOrphan, attempt({ id: safeOrphan, liveExecution: false }));
  h.attempts.set(durableOrphan, attempt({ id: durableOrphan, ephemeral: false }));

  await h.subject.recoverEphemeralWorkspaces();

  assert.equal(h.attempts.has(safeOrphan), false);
  assert.equal(h.attempts.has(liveOrphan), true);
  assert.deepEqual(h.recoveryRefusals, [{
    message: `Refusing to collect orphaned room-only attempt ${liveOrphan}: live execution evidence remains.`,
  }]);
  assert.deepEqual(h.orphanRetainedSets, [[
    attachedProvider,
    attachedPurge,
    attachedRuntime,
    durableOrphan,
    liveOrphan,
  ].sort()]);
});

test("workspace recovery reports an orphan whose ephemeral attempt cleanup throws", async () => {
  const h = harness();
  const orphan = "99999999-9999-4999-8999-999999999999";
  const cleanupError = new Error("attempt conclusion failed");
  h.attempts.set(orphan, attempt({ id: orphan, liveExecution: false }));
  h.setConcludeAttemptError(cleanupError);

  await h.subject.recoverEphemeralWorkspaces();

  assert.deepEqual(h.recoveryRefusals, [{
    message: `Refusing to collect orphaned room-only attempt ${orphan}:`,
    error: cleanupError,
  }]);
  assert.deepEqual(h.orphanRetainedSets, [[orphan]]);
});
