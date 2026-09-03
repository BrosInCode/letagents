import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionDelegationDecisionIntent } from "../../../../shared/execution-delegation-decision.mjs";
import type { ExecutionApprovalProjectionRecord } from "../execution-approval-projection-journal.js";
import {
  ApprovalJournalError,
  type ApprovalAuthority,
  type ApprovalReference,
  type ExecutionApprovalRecord,
} from "../execution-approval-journal.js";
import {
  ExecutionDelegationDecisionCoordinator,
  type ExecutionDelegationDecisionCoordinatorOptions,
} from "../execution-delegation-decision-coordinator.js";
import { ExecutionApprovalPublisher } from "../execution-approval-publisher.js";
import { ExecutionDelegationCoordinator } from "../execution-delegation-coordinator.js";
import { NativeApprovalUnavailableError } from "../execution-approval-native-application.js";
import type { DaemonManifestEntry } from "../types.js";
import type { InstalledHostGrant } from "../worker-runtime-custody.js";

const expected = {
  requestId: "request-1", requestVersion: 2, requestSha256: "a".repeat(64), agentId: "agent-1", roomId: "room-1",
  executionGenerationId: "generation-1", runtimeGenerationId: "runtime-1", turnId: "turn-1",
  providerContinuationId: "continuation-1", providerTurnId: "provider-turn-1", connectionId: "connection-1", nativeRequestId: 1,
} satisfies ApprovalReference;
const entry = { id: expected.agentId, room_id: expected.roomId } as DaemonManifestEntry;
const grant = {
  entryId: entry.id, roomId: entry.room_id, agentKey: "owner/agent-1", grantId: "grant-2", supervisorGrant: "secret",
  grantGeneration: 2, apiUrl: "https://letagents.test", daemonGeneration: 7, hostId: "host-1",
  installationId: "installation-1", ownerAccountId: "owner-1", scopeKey: "owner",
  expiresAt: "2099-01-01T00:00:00.000Z",
} satisfies InstalledHostGrant;
const approvalAuthority = {
  inboxItemId: "inbox-1", workAttemptId: "attempt-1", executionGenerationId: expected.executionGenerationId,
  provider: "codex", providerConnection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311,
    processIdentity: "birth-1" }, configurationRevision: 1,
} satisfies ApprovalAuthority;

function intent(revision = 2): ExecutionDelegationDecisionIntent {
  return {
    decision_id: `decision-${revision}`, delegation_instance_id: "delegation-1", delegation_revision: revision,
    actor_account_id: "approver-1", request_id: expected.requestId, request_version: expected.requestVersion,
    request_sha256: expected.requestSha256, projection_sha256: "b".repeat(64), decision: "allow_once",
    decided_at: "2026-09-03T00:00:00.000Z", owner_account_id: grant.ownerAccountId!, room_id: grant.roomId,
    agent_key: grant.agentKey, approver_account_id: "approver-1", category: "file_change", risk_ceiling: "low",
    scope_sha256: revision === 2 ? "c".repeat(64) : "d".repeat(64),
  };
}

function approval(value: ExecutionDelegationDecisionIntent): ExecutionApprovalRecord {
  return {
    request: { ...expected, kind: "file_change", risk: "low", recoveryBoundary: "connection", createdAtMs: 1,
      expiresAtMs: 4_000_000_000_000, delegatable: true, state: "decision_recorded", applicationCertainty: null },
    decision: { decisionId: value.decision_id, actorId: value.actor_account_id, decision: value.decision,
      projectionSha256: value.projection_sha256, source: "delegate", delegationInstanceId: value.delegation_instance_id,
      delegationRevision: value.delegation_revision, delegationScopeSha256: value.scope_sha256,
      dispatchState: "not_dispatched", dispatchId: null, applicationCertainty: null,
      decidedAtMs: 2, dispatchStartedAtMs: null, resolvedAtMs: null },
  };
}

function projection(sha256 = "b".repeat(64)): ExecutionApprovalProjectionRecord {
  return { requestId: expected.requestId, requestVersion: expected.requestVersion, requestSha256: expected.requestSha256,
    agentId: expected.agentId, roomId: expected.roomId, executionGenerationId: expected.executionGenerationId,
    turnId: expected.turnId, producedAtMs: 1, value: { version: 1, changes: [], totals: { files: 0, additions: 0,
      deletions: 0, diff_bytes: 0 } }, json: "{}", sha256 } as ExecutionApprovalProjectionRecord;
}

type Overrides = Partial<Omit<ExecutionDelegationDecisionCoordinatorOptions, "entries" | "authority" | "approvals" | "remote">> & {
  entries?: Partial<ExecutionDelegationDecisionCoordinatorOptions["entries"]>;
  authority?: Partial<ExecutionDelegationDecisionCoordinatorOptions["authority"]>;
  approvals?: Partial<ExecutionDelegationDecisionCoordinatorOptions["approvals"]>;
  remote?: Partial<ExecutionDelegationDecisionCoordinatorOptions["remote"]>;
};

function subject(overrides: Overrides = {}) {
  const events: string[] = [];
  let currentGrant: InstalledHostGrant | null = grant;
  let currentIntent = intent();
  const options: ExecutionDelegationDecisionCoordinatorOptions = {
    entries: {
      getEntry: async (entryId) => entryId === entry.id ? entry : undefined,
      readExecutionApprovalProjection: async () => { events.push("projection"); return projection(); },
      ...overrides.entries,
    },
    authority: {
      currentHostGrant: () => currentGrant,
      syncExecutionDelegation: async ({ delegationInstanceId }) => { events.push(`sync:${delegationInstanceId}`); },
      recordDelegatedApproval: async ({ intent: selected }) => { events.push(`record:${selected.decision_id}`); return approval(selected); },
      ...overrides.authority,
    },
    approvals: {
      applyRecordedDecision: async (input, select) => {
        events.push(`apply:${input.decisionId}`);
        const selected = await select({ expected, presentation: { agentId: entry.id, displayName: "Agent", provider: "codex",
          title: "Change files", details: "details", denyScope: "request" }, approvalAuthority,
          approval: approval(currentIntent), assertCurrent: () => {} });
        events.push(`dispatch:${selected.decision?.decisionId}`);
      },
      ...overrides.approvals,
    },
    remote: {
      listExecutionDelegationDecisionIds: async () => ({ decisionIds: [currentIntent.decision_id], nextCursor: null }),
      getExecutionDelegationDecision: async () => { events.push(`get:${currentIntent.decision_id}`); return currentIntent; },
      ...overrides.remote,
    },
    diagnostic: overrides.diagnostic ?? ((_entryId, error) => { events.push(`diagnostic:${String(error)}`); }),
    nowMs: overrides.nowMs ?? (() => Date.parse("2026-09-03T12:00:00.000Z")),
    setRetryTimeout: overrides.setRetryTimeout,
    clearRetryTimeout: overrides.clearRetryTimeout,
  };
  return {
    events,
    coordinator: new ExecutionDelegationDecisionCoordinator(options),
    setIntent: (value: ExecutionDelegationDecisionIntent) => { currentIntent = value; },
    clearGrant: () => { currentGrant = null; },
    replaceGrant: () => { currentGrant = { ...grant, grantId: "grant-other" }; },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not met");
}

test("decision inventory exact-fetches, refreshes delegation authority, records, then reaches dispatch", async () => {
  let pages = 0;
  const harness = subject({ remote: {
    listExecutionDelegationDecisionIds: async ({ after }) => {
      pages += 1;
      return after === null ? { decisionIds: [], nextCursor: "next" }
        : { decisionIds: ["decision-2"], nextCursor: null };
    },
  } });
  await harness.coordinator.request(entry.id);
  assert.equal(pages, 2);
  assert.deepEqual(harness.events, ["get:decision-2", "sync:delegation-1", "apply:decision-2", "projection",
    "record:decision-2", "dispatch:decision-2"]);
});

test("no installed host grant and no native request are quiet do-nothing states", async () => {
  let remoteCalls = 0;
  const noGrant = subject({ remote: { listExecutionDelegationDecisionIds: async () => {
    remoteCalls += 1; return { decisionIds: [], nextCursor: null };
  } } });
  noGrant.clearGrant();
  await noGrant.coordinator.request(entry.id);
  assert.equal(remoteCalls, 0);
  const noNative = subject({ approvals: { applyRecordedDecision: async () => { throw new NativeApprovalUnavailableError(); } } });
  await noNative.coordinator.request(entry.id);
  assert.deepEqual(noNative.events, ["get:decision-2", "sync:delegation-1"]);
});

test("local projection mismatch refuses before delegated recording or dispatch", async () => {
  const harness = subject({ entries: { readExecutionApprovalProjection: async () => projection("e".repeat(64)) } });
  await harness.coordinator.request(entry.id);
  assert.deepEqual(harness.events.slice(0, 3), ["get:decision-2", "sync:delegation-1", "apply:decision-2"]);
  assert.equal(harness.events.some((event) => event.startsWith("record:")), false);
  assert.equal(harness.events.some((event) => event.startsWith("dispatch:")), false);
  assert.equal(harness.events.some((event) => event.includes("projection does not match local evidence")), true);
});

test("stale revision refuses and a later current revision applies without replaying the stale choice", async () => {
  let currentRevision = 2;
  const harness = subject({ authority: {
    recordDelegatedApproval: async ({ intent: selected }) => {
      if (selected.delegation_revision !== currentRevision) throw new ApprovalJournalError("decision_conflict");
      harness.events.push(`record:${selected.decision_id}`);
      return approval(selected);
    },
  } });
  harness.setIntent(intent(1));
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.some((event) => event.startsWith("dispatch:")), false);
  currentRevision = 2;
  harness.setIntent(intent(2));
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.filter((event) => event === "dispatch:decision-2").length, 1);
});

test("bursts coalesce one pass plus one lost-wake follow-up", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const harness = subject({ remote: { listExecutionDelegationDecisionIds: async () => {
    calls += 1;
    if (calls === 1) await blocked;
    return { decisionIds: [], nextCursor: null };
  } } });
  const first = harness.coordinator.request(entry.id);
  const second = harness.coordinator.request(entry.id);
  await waitUntil(() => calls === 1);
  release();
  await Promise.all([first, second]);
  await waitUntil(() => calls === 2);
  assert.equal(calls, 2);
});

test("fence aborts and drains an in-flight decision inventory", async () => {
  let signal: AbortSignal | undefined;
  const harness = subject({ remote: { listExecutionDelegationDecisionIds: async (input) => {
    signal = input.signal;
    await new Promise<never>((_resolve, reject) => input.signal?.addEventListener("abort",
      () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  } } });
  const request = harness.coordinator.request(entry.id);
  await waitUntil(() => signal !== undefined);
  await harness.coordinator.fenceAndDrain();
  assert.equal(signal?.aborted, true);
  await assert.rejects(request, /aborted/);
  await harness.coordinator.request(entry.id);
});

test("a replaced host grant refuses the completed pass", async () => {
  const harness = subject({ approvals: { applyRecordedDecision: async () => { harness.replaceGrant(); } } });
  await assert.rejects(harness.coordinator.request(entry.id), /authority changed/);
});

test("a stale exact-fetched intent is rejected before delegation refresh or native selection", async () => {
  const harness = subject();
  harness.setIntent({ ...intent(), decided_at: "2026-09-02T12:00:00.000Z" });
  await harness.coordinator.request(entry.id);
  assert.deepEqual(harness.events.slice(0, 1), ["get:decision-2"]);
  assert.equal(harness.events.some((event) => event.startsWith("sync:")), false);
  assert.equal(harness.events.some((event) => event.startsWith("apply:")), false);
  assert.equal(harness.events.some((event) => event.includes("no longer applicable")), true);
});

test("a transient exact-fetch failure redrives the coalesced lane without another external wake", async () => {
  let reads = 0;
  const retries: (() => void)[] = [];
  const delays: number[] = [];
  const harness = subject({
    remote: { getExecutionDelegationDecision: async () => {
      reads += 1;
      if (reads < 4) throw new Error("temporary read failure");
      return intent();
    } },
    setRetryTimeout: (callback, delayMs) => {
      retries.push(callback);
      delays.push(delayMs);
      return { unref() {} };
    },
    clearRetryTimeout: () => {},
  });
  await assert.rejects(harness.coordinator.request(entry.id), /temporary read failure/);
  for (let index = 0; index < 3; index += 1) {
    await waitUntil(() => retries.length > index);
    retries[index]!();
  }
  await waitUntil(() => harness.events.includes("dispatch:decision-2"));
  assert.deepEqual(delays, [250, 1_000, 4_000]);
  assert.equal(reads, 4);
  await harness.coordinator.fenceAndDrain();
});

test("a later native-request wake applies a decision that arrived first", async () => {
  let nativeAvailable = false;
  let harness!: ReturnType<typeof subject>;
  harness = subject({ approvals: { applyRecordedDecision: async (_input, select) => {
    if (!nativeAvailable) throw new NativeApprovalUnavailableError();
    const selected = await select({ expected, presentation: { agentId: entry.id, displayName: "Agent", provider: "codex",
      title: "Change files", details: "details", denyScope: "request" }, approvalAuthority,
      approval: approval(intent()), assertCurrent: () => {} });
    harness.events.push(`dispatch:${selected.decision?.decisionId}`);
  } } });
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.some((event) => event.startsWith("dispatch:")), false);
  nativeAvailable = true;
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.filter((event) => event === "dispatch:decision-2").length, 1);
});

test("a later decision wake applies to an already-observed native request", async () => {
  let decisionIds: string[] = [];
  const harness = subject({ remote: { listExecutionDelegationDecisionIds: async () => ({
    decisionIds, nextCursor: null,
  }) } });
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.length, 0);
  decisionIds = [intent().decision_id];
  await harness.coordinator.request(entry.id);
  assert.equal(harness.events.filter((event) => event === "dispatch:decision-2").length, 1);
});

test("shutdown waits for an admitted decision application to settle", async () => {
  let applicationStarted!: () => void;
  let releaseApplication!: () => void;
  const started = new Promise<void>((resolve) => { applicationStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseApplication = resolve; });
  const harness = subject({ approvals: { applyRecordedDecision: async () => {
    applicationStarted();
    await blocked;
  } } });
  const request = harness.coordinator.request(entry.id);
  await started;
  let drained = false;
  const drain = harness.coordinator.fenceAndDrain().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseApplication();
  await Promise.all([request, drain]);
  assert.equal(drained, true);
});

test("delegation lifecycle eagerly starts, wakes, and fences approval publication", async t => {
  const events: string[] = [];
  const publisher = {
    changed: (entryId: string) => { events.push(`publication:changed:${entryId}`); },
    close: () => { events.push("publication:closed"); },
  };
  t.mock.method(ExecutionApprovalPublisher, "open", () => {
    events.push("publication:opened");
    return publisher as unknown as ExecutionApprovalPublisher;
  });
  const coordinator = new ExecutionDelegationCoordinator({
    entries: {
      getEntry: async () => entry, getExecutionApproval: async () => null, listRoomEntries: async () => [entry],
      listExecutionDelegationInstanceIds: async () => [], listExecutionDelegationsForApprovalPublication: async () => [],
      readExecutionApprovalProjection: async () => projection(),
    },
    authority: {
      currentHostGrant: () => grant, installHostGrant: async () => ({ status: "installed" as const }),
      syncExecutionDelegation: async () => {}, recordDelegatedApproval: async ({ intent: selected }) => approval(selected),
      validateExecutionDelegation: async () => {},
    },
    approvals: { admitDelegatable: async () => [], applyRecordedDecision: async () => {} },
    remote: {
      listExecutionDelegationIds: async () => ({ delegationInstanceIds: [], nextCursor: null }),
      listExecutionDelegationDecisionIds: async () => ({ decisionIds: [], nextCursor: null }),
      getExecutionDelegationDecision: async () => null,
    },
    approvalPublication: {
      path: "state.sqlite", custody: { hostGrant: () => null, workerAuthorization: () => null },
      inbox: { get: async () => null }, daemonGeneration: () => 7, isClosing: () => false, assertCurrent: async () => {},
    },
    requestConvergence: () => {}, diagnostic: () => {},
  });

  coordinator.start(); coordinator.start();
  assert.equal(events.filter(event => event === "publication:opened").length, 1);
  coordinator.requestDecisions(entry.id);
  assert.equal(events.filter(event => event === `publication:changed:${entry.id}`).length, 1);
  await coordinator.fenceAndDrain();
  assert.equal(events.filter(event => event === "publication:closed").length, 1);
  coordinator.start(); coordinator.requestDecisions(entry.id);
  assert.equal(events.filter(event => event === "publication:opened").length, 1);
  assert.equal(events.filter(event => event === `publication:changed:${entry.id}`).length, 1);
});

test("room wakes reconcile decisions even when grant inventory fails", async () => {
  const events: string[] = [];
  const coordinator = new ExecutionDelegationCoordinator({
    entries: {
      getEntry: async () => entry,
      getExecutionApproval: async () => null,
      listRoomEntries: async () => [entry],
      listExecutionDelegationInstanceIds: async () => [],
      listExecutionDelegationsForApprovalPublication: async () => [],
      readExecutionApprovalProjection: async () => projection(),
    },
    authority: {
      currentHostGrant: () => grant,
      installHostGrant: async () => ({ status: "installed" as const }),
      syncExecutionDelegation: async () => { events.push("decision:delegation-refreshed"); },
      recordDelegatedApproval: async ({ intent: selected }) => approval(selected),
      validateExecutionDelegation: async () => {},
    },
    approvals: {
      admitDelegatable: async () => [],
      applyRecordedDecision: async (_input, select) => {
        await select({ expected, presentation: { agentId: entry.id, displayName: "Agent", provider: "codex",
          title: "Change files", details: "details", denyScope: "request" }, approvalAuthority,
        approval: approval(intent()), assertCurrent: () => {} });
        events.push("decision:applied");
      },
    },
    remote: {
      listExecutionDelegationIds: async () => { throw new Error("grant inventory unavailable"); },
      listExecutionDelegationDecisionIds: async () => ({ decisionIds: [intent().decision_id], nextCursor: null }),
      getExecutionDelegationDecision: async () => intent(),
    },
    requestConvergence: () => {},
    diagnostic: (domain, _entryId, error) => { events.push(`${domain}:${String(error)}`); },
  });
  coordinator.requestRoom(entry.room_id);
  await waitUntil(() => events.includes("decision:applied") && events.some((event) => event.startsWith("grant:Error")));
  assert.equal(events.includes("decision:delegation-refreshed"), true);
  await coordinator.fenceAndDrain();
});
