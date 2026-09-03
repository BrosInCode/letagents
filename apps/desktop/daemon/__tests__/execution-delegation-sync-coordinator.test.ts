import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionDelegationSyncCoordinator,
  type ExecutionDelegationSyncOptions,
} from "../execution-delegation-sync-coordinator.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import type { DaemonManifestEntry } from "../types.js";
import type { InstalledHostGrant } from "../worker-runtime-custody.js";

const entry = { id: "agent-1", room_id: "room-1" } as DaemonManifestEntry;
const grant: InstalledHostGrant = {
  entryId: entry.id,
  roomId: entry.room_id,
  agentKey: "owner/agent-1",
  grantId: "grant-1",
  supervisorGrant: "secret",
  grantGeneration: 3,
  apiUrl: "https://letagents.test",
  daemonGeneration: 7,
  hostId: "host-1",
  installationId: "installation-1",
  ownerAccountId: "owner-1",
  scopeKey: "owner",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not met");
}

type SubjectOverrides = Partial<Omit<ExecutionDelegationSyncOptions, "authority">> & {
  authority?: Partial<ExecutionDelegationSyncOptions["authority"]>;
};

function subject(overrides: SubjectOverrides = {}) {
  const events: string[] = [];
  let currentGrant: InstalledHostGrant | null = grant;
  const { authority: authorityOverrides, ...optionOverrides } = overrides;
  const options: ExecutionDelegationSyncOptions = {
    entries: {
      getEntry: async (entryId) => entryId === entry.id ? entry : undefined,
      listRoomEntries: async (roomId) => roomId === entry.room_id ? [entry] : [],
      listExecutionDelegationInstanceIds: async (input) => {
        assert.deepEqual(input, {
          agentId: entry.id,
          roomId: grant.roomId,
          agentKey: grant.agentKey,
          ownerAccountId: grant.ownerAccountId,
          hostId: grant.hostId,
          installationId: grant.installationId,
        });
        return ["delegation-local"];
      },
    },
    authority: {
      currentHostGrant: () => currentGrant,
      syncExecutionDelegation: async ({ delegationInstanceId }) => { events.push(`sync:${delegationInstanceId}`); },
      ...authorityOverrides,
    },
    remote: {
      listExecutionDelegationIds: async ({ after }) => after === null
        ? { delegationInstanceIds: ["delegation-remote-a"], nextCursor: "delegation-remote-a" }
        : { delegationInstanceIds: ["delegation-remote-b"], nextCursor: null },
    },
    requestConvergence: (entryId) => { events.push(`converge:${entryId}`); },
    diagnostic: (_entryId, error) => { events.push(`diagnostic:${String(error)}`); },
    ...optionOverrides,
  };
  return {
    events,
    options,
    coordinator: new ExecutionDelegationSyncCoordinator(options),
    replaceGrant: () => { currentGrant = { ...grant, grantId: "grant-2" }; },
  };
}

test("sync pages server inventory, unions local identities, then converges", async () => {
  const harness = subject();
  await harness.coordinator.request(entry.id);
  assert.deepEqual(harness.events, [
    "sync:delegation-local",
    "sync:delegation-remote-a",
    "sync:delegation-remote-b",
    "converge:agent-1",
  ]);
});

test("bursts share one in-flight lane and schedule only one follow-up at a time", async () => {
  let remoteCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => [] },
    remote: {
      listExecutionDelegationIds: async () => {
        remoteCalls += 1;
        if (remoteCalls === 1) await blocked;
        return { delegationInstanceIds: [], nextCursor: null };
      },
    },
  });
  const first = harness.coordinator.request(entry.id);
  const second = harness.coordinator.request(entry.id);
  const third = harness.coordinator.request(entry.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(remoteCalls, 1);
  release();
  await Promise.all([first, second, third]);
  await waitUntil(() => harness.events.length === 2);
  assert.equal(remoteCalls, 2);
  assert.deepEqual(harness.events, ["converge:agent-1", "converge:agent-1"]);
});

test("room pointer bursts fan out through one room lane and one follow-up", async () => {
  let roomLists = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const harness = subject({
    entries: {
      getEntry: async () => entry,
      listRoomEntries: async () => {
        roomLists += 1;
        if (roomLists === 1) await blocked;
        return [entry];
      },
      listExecutionDelegationInstanceIds: async () => [],
    },
    remote: {
      listExecutionDelegationIds: async () => ({ delegationInstanceIds: [], nextCursor: null }),
    },
  });
  const first = harness.coordinator.requestRoom(entry.room_id);
  const second = harness.coordinator.requestRoom(entry.room_id);
  const third = harness.coordinator.requestRoom(entry.room_id);
  await waitUntil(() => roomLists === 1);
  release();
  await Promise.all([first, second, third]);
  await waitUntil(() => harness.events.length === 2);
  assert.equal(roomLists, 2);
  assert.deepEqual(harness.events, ["converge:agent-1", "converge:agent-1"]);
});

test("a wake received during a failed pass still runs one follow-up", async () => {
  let remoteCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => [] },
    remote: {
      listExecutionDelegationIds: async () => {
        remoteCalls += 1;
        if (remoteCalls === 1) {
          await blocked;
          throw new Error("inventory unavailable");
        }
        return { delegationInstanceIds: [], nextCursor: null };
      },
    },
  });
  const first = harness.coordinator.request(entry.id);
  const coalesced = harness.coordinator.request(entry.id);
  release();
  await assert.rejects(first, /inventory unavailable/);
  await assert.rejects(coalesced, /inventory unavailable/);
  await waitUntil(() => remoteCalls === 2);
  await waitUntil(() => harness.events.includes("converge:agent-1"));
  assert.deepEqual(harness.events, ["converge:agent-1"]);
});

test("fence aborts and drains a blocked inventory pass", async () => {
  let observedSignal: AbortSignal | undefined;
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => [] },
    remote: {
      listExecutionDelegationIds: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    },
  });
  const request = harness.coordinator.request(entry.id);
  await waitUntil(() => observedSignal !== undefined);
  await harness.coordinator.fenceAndDrain();
  assert.equal(observedSignal?.aborted, true);
  await assert.rejects(request, /aborted/);
  await harness.coordinator.request(entry.id);
  assert.deepEqual(harness.events, []);
});

test("fence drains a sync queued behind shared entry work without waiting for that work", async () => {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  let releaseBlocker!: () => void;
  const blocker = gate.run(entry.id, () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
  let syncCalls = 0;
  let exactRan = false;
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => ["delegation-local"] },
    remote: {
      listExecutionDelegationIds: async () => ({ delegationInstanceIds: [], nextCursor: null }),
    },
    authority: {
      syncExecutionDelegation: async ({ signal }) => {
        syncCalls += 1;
        await gate.run(entry.id, async () => { exactRan = true; }, signal);
      },
    },
  });
  const request = harness.coordinator.request(entry.id);
  await waitUntil(() => syncCalls === 1);
  await harness.coordinator.fenceAndDrain();
  await assert.rejects(request, (error) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(exactRan, false);
  releaseBlocker();
  await blocker;
});

test("a replaced host grant rejects the pass after converging completed exact reads", async () => {
  const harness = subject({
    authority: { syncExecutionDelegation: async () => { harness.replaceGrant(); } },
  });
  await assert.rejects(harness.coordinator.request(entry.id), /authority changed/i);
  assert.deepEqual(harness.events, ["converge:agent-1"]);
});

test("a later exact-read failure still converges an earlier committed revision", async () => {
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => ["delegation-a", "delegation-b"] },
    remote: {
      listExecutionDelegationIds: async () => ({ delegationInstanceIds: [], nextCursor: null }),
    },
    authority: {
      syncExecutionDelegation: async ({ delegationInstanceId }) => {
        harness.events.push(`sync:${delegationInstanceId}`);
        if (delegationInstanceId === "delegation-b") throw new Error("exact read unavailable");
      },
    },
  });
  await assert.rejects(harness.coordinator.request(entry.id), /exact read unavailable/);
  assert.deepEqual(harness.events, [
    "sync:delegation-a",
    "sync:delegation-b",
    "converge:agent-1",
  ]);
});

test("a runaway inventory fails loudly at the per-pass page cap", async () => {
  let remoteCalls = 0;
  const harness = subject({
    entries: { getEntry: async () => entry, listRoomEntries: async () => [entry], listExecutionDelegationInstanceIds: async () => [] },
    remote: {
      listExecutionDelegationIds: async () => {
        remoteCalls += 1;
        return {
          delegationInstanceIds: [`delegation-${String(remoteCalls).padStart(4, "0")}`],
          nextCursor: `cursor-${remoteCalls}`,
        };
      },
    },
  });
  await assert.rejects(harness.coordinator.request(entry.id), /exceeded 100 pages/i);
  assert.equal(remoteCalls, 100);
  assert.deepEqual(harness.events, []);
});

test("an oversized identity union fails before exact reconciliation", async () => {
  const harness = subject({
    entries: {
      getEntry: async () => entry,
      listRoomEntries: async () => [entry],
      listExecutionDelegationInstanceIds: async () => Array.from({ length: 10_001 }, (_, index) => `delegation-${index}`),
    },
  });
  await assert.rejects(harness.coordinator.request(entry.id), /exceeded 10000 identities/i);
  assert.deepEqual(harness.events, []);
});
