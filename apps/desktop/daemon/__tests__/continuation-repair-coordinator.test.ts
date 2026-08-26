import assert from "node:assert/strict";
import test from "node:test";

import {
  ContinuationRepairCoordinator,
  type ContinuationRepairRuntime,
} from "../continuation-repair-coordinator.js";
import { CONTINUATION_REPAIR_EXHAUSTED_ERROR } from "../continuation-repair-policy.js";
import type {
  ProviderActionHandle,
  ProviderContinuationRepairRequest,
  ProviderContinuationRepairResult,
} from "../provider-action-port.js";
import type { SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import type {
  ProviderContinuationRepair,
  SupervisedInboxItem,
} from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, WorkAttemptCheckpoint } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";

const connection = {
  kind: "codex_app_server" as const,
  url: "http://127.0.0.1:4242",
  pid: 4242,
  processIdentity: "provider-birth",
};

test("an unsupported provider fails without entering the per-entry lane", async () => {
  const harness = fixture({ repair: null });

  assert.equal(await harness.subject.restore(harness.input), "failed");
  assert.equal(harness.serializeCalls, 0);
  assert.deepEqual(harness.events, []);
});

test("handoff and daemon-generation mismatches return authority_changed before store reads", async () => {
  const handoff = fixture({ handoff: true });
  assert.equal(await handoff.subject.restore(handoff.input), "authority_changed");
  assert.deepEqual(handoff.events, ["serialize"]);

  const stale = fixture();
  stale.input.agent.daemonGeneration = 8;
  assert.equal(await stale.subject.restore(stale.input), "authority_changed");
  assert.deepEqual(stale.events, ["serialize"]);
});

test("process, work-attempt, binding, session, and credential mismatches all fence repair", async () => {
  const cases: Array<[string, (harness: Harness) => void]> = [
    ["missing process birth", (harness) => {
      harness.handle = { ...harness.handle!, providerConnection: { ...connection, processIdentity: " " } };
    }],
    ["invalid pid", (harness) => {
      harness.handle = { ...harness.handle!, pid: 0, providerConnection: { ...connection, pid: 0 } };
    }],
    ["handle work attempt", (harness) => { harness.handle = { ...harness.handle!, workAttemptId: "other" }; }],
    ["binding room", (harness) => { harness.binding = { ...harness.binding!, room_id: "other" }; }],
    ["binding work attempt", (harness) => { harness.binding = { ...harness.binding!, work_attempt_id: "other" }; }],
    ["binding execution generation", (harness) => { harness.binding = { ...harness.binding!, execution_generation_id: "other" }; }],
    ["binding session", (harness) => { harness.binding = { ...harness.binding!, agent_session_id: "other" }; }],
    ["memory bearer", (harness) => { harness.credential = "other-bearer"; }],
    ["provider connection", (harness) => {
      harness.entry = {
        ...harness.entry,
        provider_ref: { ...harness.entry.provider_ref!, provider_connection: { ...connection, processIdentity: "other" } },
      };
    }],
  ];

  for (const [name, mutate] of cases) {
    const harness = fixture();
    mutate(harness);
    assert.equal(await harness.subject.restore(harness.input), "authority_changed", name);
    assert.equal(harness.beginInputs.length, 0, `${name}: journal admission must remain fenced`);
    assert.equal(harness.repairRequests.length, 0, `${name}: provider must remain untouched`);
  }
});

test("a missing current continuation fails after authority verification without journal admission", async () => {
  const harness = fixture();
  harness.input.agent.providerContinuationId = null;

  assert.equal(await harness.subject.restore(harness.input), "failed");
  assert.equal(harness.beginInputs.length, 0);
  assert.equal(harness.repairRequests.length, 0);
});

test("automatic exhaustion is persisted once while manual repair bypasses exhaustion", async () => {
  const previous = repairRecord({
    phase: "committed",
    missing_continuation: "thread-old",
    replacement_continuation: "thread-current",
  });
  const automatic = fixture({
    continuation: "thread-current",
    previousRepair: previous,
  });

  assert.equal(await automatic.subject.restore(automatic.input), "failed");
  assert.deepEqual(automatic.exhaustions, [{
    inboxItemId: "inbox-1",
    repairId: "repair-1",
    error: CONTINUATION_REPAIR_EXHAUSTED_ERROR,
  }]);
  assert.equal(automatic.notifications, 1);
  assert.equal(automatic.repairRequests.length, 0);

  const alreadyExhausted = fixture({
    continuation: "thread-current",
    previousRepair: previous,
  });
  alreadyExhausted.input.item.last_error = CONTINUATION_REPAIR_EXHAUSTED_ERROR;
  assert.equal(await alreadyExhausted.subject.restore(alreadyExhausted.input), "failed");
  assert.equal(alreadyExhausted.exhaustions.length, 0);
  assert.equal(alreadyExhausted.notifications, 0);

  const manual = fixture({
    continuation: "thread-current",
    previousRepair: previous,
    beginRepair: repairRecord({
      missing_continuation: "thread-current",
      replacement_continuation: null,
      phase: "probing",
    }),
  });
  manual.input.manual = true;
  assert.equal(await manual.subject.restore(manual.input), "restored");
  assert.equal(manual.repairRequests[0]?.forceReplacement, true);
  assert.equal(manual.exhaustions.length, 0);
});

test("an automatic failed repair remains blocked unless its replacement is already durable", async () => {
  const failed = repairRecord({ phase: "failed", replacement_continuation: null });
  const blocked = fixture({ previousRepair: failed });
  assert.equal(await blocked.subject.restore(blocked.input), "failed");
  assert.equal(blocked.beginInputs.length, 0);

  const durable = fixture({
    continuation: "thread-replacement",
    previousRepair: repairRecord({
      phase: "failed",
      missing_continuation: "thread-old",
      replacement_continuation: "thread-replacement",
    }),
    beginRepair: repairRecord({
      phase: "replacement_created",
      missing_continuation: "thread-old",
      replacement_continuation: "thread-replacement",
    }),
  });
  assert.equal(await durable.subject.restore(durable.input), "restored");
  assert.equal(durable.repairRequests.length, 0, "a predecessor's fully durable replacement is never reprobed");
  assert.deepEqual(durable.commits, [{
    repairId: "repair-1",
    continuation: "thread-replacement",
    continuityReset: true,
  }]);
  assert.equal(durable.notifications, 0, "the predecessor reconciliation path preserves existing notification behavior");
});

test("a rematerialized continuation commits without checkpointing or promoting a handle", async () => {
  const harness = fixture();

  assert.equal(await harness.subject.restore(harness.input), "restored");
  assert.deepEqual(harness.beginInputs, [{
    agent_id: "agent-1",
    room_id: "room-1",
    inbox_item_id: "inbox-1",
    daemon_generation: 7,
    execution_generation_id: "execution-1",
    work_attempt_id: "attempt-1",
    expected_pid: 4242,
    expected_process_identity: "provider-birth",
    missing_continuation: "thread-old",
  }]);
  assert.deepEqual(harness.commits, [{
    repairId: "repair-1",
    continuation: "thread-old",
    continuityReset: false,
  }]);
  assert.equal(harness.durableCheckpoints.length, 0);
  assert.equal(harness.promotions.length, 0);
  assert.equal(harness.notifications, 1);
});

test("replacement checkpoints inbox and attempt state before manifest commit, then promotes before release", async () => {
  let harness!: Harness;
  const replacementHandle = providerHandle("thread-new");
  harness = fixture({
    repair: async (handle, request, options) => {
      harness.events.push("provider.repair");
      harness.repairRequests.push(request);
      await options.checkpointReplacement("thread-new");
      harness.events.push("provider.return");
      return {
        handle: replacementHandle,
        outcome: "replaced",
        previousProviderContinuationId: "thread-old",
        replacementProviderContinuationId: "thread-new",
      };
    },
  });

  assert.equal(await harness.subject.restore(harness.input), "replaced");
  assert.deepEqual(harness.repairRequests[0], {
    workAttemptId: "attempt-1",
    expectedProviderContinuationId: "thread-old",
    checkpointedReplacementProviderContinuationId: null,
    forceReplacement: false,
    cwd: "/workspace",
    launchPolicy: { sandbox: true },
    model: "gpt-test",
    reasoningEffort: "high",
  });
  assert.deepEqual(harness.durableCheckpoints, [{
    workAttemptId: "attempt-1",
    room_cursor: null,
    provider_continuation_id: "thread-new",
  }]);
  assert.equal(harness.entry.provider_ref?.provider_continuation_id, "thread-new");
  assert.deepEqual(harness.promotions, [{
    entryId: "agent-1",
    continuation: "thread-new",
    executionGenerationId: "execution-1",
  }]);
  assert.deepEqual(harness.events.slice(harness.events.indexOf("provider.repair")), [
    "provider.repair",
    "authority.assert",
    "inbox.checkpoint",
    "manifest.get",
    "runtime.getHandle",
    "durability.getAttempt",
    "durability.checkpoint",
    "manifest.update",
    "provider.return",
    "manifest.get",
    "runtime.promote",
    "inbox.commit",
    "notify",
  ]);
});

test("an already checkpointed replacement does not duplicate the work-attempt checkpoint", async () => {
  let harness!: Harness;
  harness = fixture({
    checkpoints: [checkpoint("thread-new")],
    repair: async (_handle, request, options) => {
      harness.repairRequests.push(request);
      await options.checkpointReplacement("thread-new");
      return {
        handle: providerHandle("thread-new"),
        outcome: "replaced",
        previousProviderContinuationId: "thread-old",
        replacementProviderContinuationId: "thread-new",
      };
    },
  });

  assert.equal(await harness.subject.restore(harness.input), "replaced");
  assert.equal(harness.durableCheckpoints.length, 0);
});

test("provider-result authority failures are redacted, journaled, and notified", async () => {
  const secret = "lasb_abcdefghijklmnopqrstuvwxyz";
  const harness = fixture({
    repair: async () => {
      throw new Error(`token=${secret}`);
    },
    failRejects: true,
  });

  assert.equal(await harness.subject.restore(harness.input), "failed");
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0]?.includes(secret), false);
  assert.equal(harness.failures[0], "Couldn't restore this agent's provider conversation. token=[REDACTED]");
  assert.equal(harness.notifications, 1);
});

test("a replacement cannot be promoted before its manifest continuation is durable", async () => {
  const harness = fixture({
    repair: async () => ({
      handle: providerHandle("thread-new"),
      outcome: "replaced",
      previousProviderContinuationId: "thread-old",
      replacementProviderContinuationId: "thread-new",
    }),
  });

  assert.equal(await harness.subject.restore(harness.input), "failed");
  assert.equal(harness.promotions.length, 0);
  assert.match(harness.failures[0] ?? "", /Replacement conversation was not durable before handle promotion/);
});

test("journal admission errors remain visible because only the admitted provider phase is failed", async () => {
  const harness = fixture({ beginRejects: true });

  await assert.rejects(() => harness.subject.restore(harness.input), /journal unavailable/);
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.notifications, 0);
});

type RepairFunction = NonNullable<ContinuationRepairRuntime["repair"]>;

type FixtureOptions = {
  handoff?: boolean;
  continuation?: string;
  previousRepair?: ProviderContinuationRepair | null;
  beginRepair?: ProviderContinuationRepair;
  repair?: RepairFunction | null;
  checkpoints?: WorkAttemptCheckpoint[];
  failRejects?: boolean;
  beginRejects?: boolean;
};

type Harness = ReturnType<typeof fixture>;

function fixture(options: FixtureOptions = {}) {
  const continuation = options.continuation ?? "thread-old";
  const events: string[] = [];
  const repairRequests: ProviderContinuationRepairRequest[] = [];
  const commits: Array<{ repairId: string; continuation: string; continuityReset: boolean }> = [];
  const exhaustions: Array<{ inboxItemId: string; repairId: string; error: string }> = [];
  const durableCheckpoints: Array<{ workAttemptId: string; room_cursor: null; provider_continuation_id: string }> = [];
  const promotions: Array<{ entryId: string; continuation: string | null; executionGenerationId: string }> = [];
  const failures: string[] = [];
  const beginInputs: unknown[] = [];
  let notifications = 0;
  let serializeCalls = 0;
  let credential = "worker-bearer";
  let entry = manifestEntry(continuation);
  let handle: ProviderActionHandle | undefined = providerHandle(continuation);
  let binding: WorkerSessionBinding | null = workerBinding();
  let checkpoints = options.checkpoints ?? [];
  const beginRepair = options.beginRepair ?? repairRecord({ missing_continuation: continuation });
  let harness!: {
    subject: ContinuationRepairCoordinator;
    input: { agent: SupervisedIngressAgent; item: SupervisedInboxItem; manual: boolean };
    events: string[];
    repairRequests: ProviderContinuationRepairRequest[];
    commits: typeof commits;
    exhaustions: typeof exhaustions;
    durableCheckpoints: typeof durableCheckpoints;
    promotions: typeof promotions;
    failures: string[];
    beginInputs: unknown[];
    notifications: number;
    serializeCalls: number;
    credential: string | null;
    entry: DaemonManifestEntry;
    handle: ProviderActionHandle | undefined;
    binding: WorkerSessionBinding | null;
  };
  const defaultRepair: RepairFunction = async (currentHandle, request) => {
    events.push("provider.repair");
    repairRequests.push(request);
    return {
      handle: currentHandle,
      outcome: "rematerialized",
      previousProviderContinuationId: request.expectedProviderContinuationId,
      replacementProviderContinuationId: request.expectedProviderContinuationId,
    };
  };
  const repair = options.repair === null ? undefined : options.repair ?? defaultRepair;
  const subject = new ContinuationRepairCoordinator({
    authority: {
      isHandoffScheduled: () => options.handoff ?? false,
      currentGeneration: () => 7,
      assertCurrent: async () => { events.push("authority.assert"); },
    },
    serializeEntry: async (_entryId, operation) => {
      serializeCalls += 1;
      events.push("serialize");
      return operation();
    },
    inbox: {
      latest: async () => { events.push("inbox.latest"); return options.previousRepair ?? null; },
      exhaust: async (inboxItemId, repairId, error) => {
        events.push("inbox.exhaust");
        exhaustions.push({ inboxItemId, repairId, error });
      },
      begin: async (input) => {
        events.push("inbox.begin");
        beginInputs.push(input);
        if (options.beginRejects) throw new Error("journal unavailable");
        return beginRepair;
      },
      checkpointReplacement: async (_repairId, replacementContinuation) => {
        events.push("inbox.checkpoint");
        return { ...beginRepair, replacement_continuation: replacementContinuation, phase: "replacement_created" };
      },
      commit: async (repairId, authoritativeContinuation, continuityReset) => {
        events.push("inbox.commit");
        commits.push({ repairId, continuation: authoritativeContinuation, continuityReset });
      },
      fail: async (_repairId, error) => {
        events.push("inbox.fail");
        failures.push(error);
        if (options.failRejects) throw new Error("failure journal unavailable");
      },
    },
    manifest: {
      getEntry: async () => { events.push("manifest.get"); return entry; },
      updateEntry: async (_entryId, update) => {
        events.push("manifest.update");
        entry = update(entry);
        if (harness) harness.entry = entry;
        return entry;
      },
    },
    bindings: {
      get: async () => { events.push("bindings.get"); return binding; },
      credentialFor: async () => { events.push("bindings.credential"); return credential; },
    },
    durability: {
      getAttempt: async () => {
        events.push("durability.getAttempt");
        return { checkpoints };
      },
      checkpoint: async (workAttemptId, next) => {
        events.push("durability.checkpoint");
        durableCheckpoints.push({
          workAttemptId,
          room_cursor: null,
          provider_continuation_id: next.provider_continuation_id!,
        });
        checkpoints = [...checkpoints, checkpoint(next.provider_continuation_id)];
      },
    },
    runtime: {
      getHandle: () => { events.push("runtime.getHandle"); return handle; },
      repair,
      promote: async (entryId, nextHandle, executionGenerationId) => {
        events.push("runtime.promote");
        promotions.push({ entryId, continuation: nextHandle.providerContinuationId, executionGenerationId });
        handle = nextHandle;
        if (harness) harness.handle = handle;
      },
    },
    notifyStateChanged: () => {
      events.push("notify");
      notifications += 1;
      if (harness) harness.notifications = notifications;
    },
  });
  harness = {
    subject,
    input: { agent: ingressAgent(continuation), item: inboxItem(), manual: false },
    events,
    repairRequests,
    commits,
    exhaustions,
    durableCheckpoints,
    promotions,
    failures,
    beginInputs,
    notifications,
    serializeCalls,
    credential,
    entry,
    handle,
    binding,
  };
  // Keep mutable test-facing authority fields synchronized with port closures.
  Object.defineProperties(harness, {
    serializeCalls: { get: () => serializeCalls },
    credential: { get: () => credential, set: (value: string | null) => { credential = value; } },
    entry: { get: () => entry, set: (value: DaemonManifestEntry) => { entry = value; } },
    handle: { get: () => handle, set: (value: ProviderActionHandle | undefined) => { handle = value; } },
    binding: { get: () => binding, set: (value: WorkerSessionBinding | null) => { binding = value; } },
  });
  return harness;
}

function manifestEntry(continuation: string): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: "room-1",
    display_name: "Agent",
    provider: "codex",
    model: "gpt-test",
    reasoning_effort: "high",
    charter: "Test",
    desired_state: "running",
    observed_state: "working",
    condition: "none",
    permission_profile_id: null,
    provider_launch_policy: { sandbox: true },
    created_by: "test",
    created_at: "2026-08-26T00:00:00.000Z",
    workspace_path: "/workspace",
    work_attempt_id: "attempt-1",
    provider_ref: {
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
      provider_continuation_id: continuation,
      provider_connection: connection,
    },
  };
}

function providerHandle(continuation: string): ProviderActionHandle {
  return {
    workAttemptId: "attempt-1",
    pid: connection.pid,
    providerContinuationId: continuation,
    providerConnection: connection,
    observedState: "working",
  };
}

function workerBinding(): WorkerSessionBinding {
  return {
    entry_id: "agent-1",
    room_id: "room-1",
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    credential_ref: "credential-1",
    api_url: "https://letagents.test",
    room_cursor: null,
    last_sequence: 0,
    last_observed_at_ms: 0,
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

function ingressAgent(continuation: string): SupervisedIngressAgent {
  return {
    agentId: "agent-1",
    roomId: "room-1",
    provider: "codex",
    apiUrl: "https://letagents.test",
    agentSessionId: "session-1",
    bearer: "worker-bearer",
    handle: providerHandle(continuation),
    workAttemptId: "attempt-1",
    providerContinuationId: continuation,
    providerConnection: connection,
    executionGenerationId: "execution-1",
    daemonGeneration: 7,
  };
}

function inboxItem(): SupervisedInboxItem {
  return {
    inbox_item_id: "inbox-1",
    agent_id: "agent-1",
    room_id: "room-1",
    source_message_id: "message-1",
    source_message: {},
    activation: {},
    fifo_sequence: 1,
    state: "blocked",
    attempt_count: 0,
    action_id: "action-1",
    reply_client_message_id: "reply-1",
    provider_turn_id: null,
    outcome: null,
    last_error: null,
    failure_code: "provider_continuation_missing",
    blocked_by_inbox_item_id: null,
    next_attempt_at_ms: null,
    terminal_reason: null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    acknowledged_at: null,
  };
}

function repairRecord(overrides: Partial<ProviderContinuationRepair> = {}): ProviderContinuationRepair {
  return {
    repair_id: "repair-1",
    agent_id: "agent-1",
    room_id: "room-1",
    inbox_item_id: "inbox-1",
    daemon_generation: 7,
    execution_generation_id: "execution-1",
    work_attempt_id: "attempt-1",
    expected_pid: connection.pid,
    expected_process_identity: connection.processIdentity,
    missing_continuation: "thread-old",
    replacement_continuation: null,
    phase: "probing",
    attempt_count: 1,
    last_error: null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function checkpoint(providerContinuationId: string | null): WorkAttemptCheckpoint {
  return {
    at: "2026-08-26T00:00:00.000Z",
    room_cursor: null,
    provider_continuation_id: providerContinuationId,
  };
}
