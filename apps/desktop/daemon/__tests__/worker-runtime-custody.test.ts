import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkerRuntimeCustody,
  type CachedWorkerAuthorization,
  type InstalledHostGrant,
  type InstalledOpenModelCredential,
  type PendingResumeBinding,
} from "../worker-runtime-custody.js";

const NOW_MS = Date.parse("2026-08-26T10:00:00.000Z");

function hostGrant(overrides: Partial<InstalledHostGrant> = {}): InstalledHostGrant {
  return {
    entryId: "entry-1",
    roomId: "room-1",
    agentKey: "agent-1",
    grantId: "grant-1",
    supervisorGrant: "supervisor-secret",
    grantGeneration: 3,
    apiUrl: "https://letagents.chat",
    daemonGeneration: 7,
    hostId: "host-1",
    installationId: "installation-1",
    ownerAccountId: "account-1",
    scopeKey: "owner",
    expiresAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function workerAuthorization(
  overrides: Partial<CachedWorkerAuthorization> = {},
): CachedWorkerAuthorization {
  return {
    entryId: "entry-1",
    roomId: "room-1",
    agentKey: "agent-1",
    workAttemptId: "attempt-1",
    grantId: "grant-1",
    grantGeneration: 3,
    daemonGeneration: 7,
    apiUrl: "https://letagents.chat",
    agentSessionId: "session-1",
    bearer: "worker-secret",
    bearerId: "bearer-1",
    expiresAt: new Date(NOW_MS + 60_001).toISOString(),
    mintedAtMs: NOW_MS,
    ...overrides,
  };
}

function openModelCredential(): InstalledOpenModelCredential {
  return {
    entryId: "entry-1",
    apiKey: "model-secret",
    baseUrl: "https://models.example.com",
    model: "model-1",
    daemonGeneration: 7,
  };
}

function pendingResumeBinding(): PendingResumeBinding {
  return {
    roomId: "room-1",
    workAttemptId: "attempt-1",
    predecessorExecutionGenerationId: "execution-1",
    successorExecutionGenerationId: "execution-2",
    agentSessionId: "session-1",
    providerContinuationId: "continuation-1",
  };
}

test("owns live and pending resume identities by entry and exact execution generation", () => {
  const custody = new WorkerRuntimeCustody();
  const live = {
    agentSessionId: "session-1",
    executionGenerationId: "execution-2",
    updatedAt: "2026-08-26T10:00:00.000Z",
  };
  const pending = pendingResumeBinding();

  custody.installLiveBinding("entry-1", live);
  custody.installPendingResumeBinding("entry-1", pending);

  assert.equal(custody.liveBinding("entry-1"), live);
  assert.equal(custody.liveBindingForGeneration("entry-1", "execution-2"), live);
  assert.equal(custody.liveBindingForGeneration("entry-1", "execution-1"), null);
  assert.equal(custody.pendingResumeBinding("entry-1"), pending);
  assert.equal(custody.hasPendingResumeBinding("entry-1"), true);

  assert.equal(custody.deleteLiveBinding("entry-1"), true);
  assert.equal(custody.deletePendingResumeBinding("entry-1"), true);
  assert.equal(custody.liveBinding("entry-1"), undefined);
  assert.equal(custody.hasPendingResumeBinding("entry-1"), false);
});

test("returns a host grant only for the exact entry, room, daemon generation, and live handoff state", () => {
  const custody = new WorkerRuntimeCustody();
  const grant = hostGrant();
  custody.installHostGrant(grant);

  assert.equal(custody.currentHostGrant({ entryId: "entry-1", roomId: "room-1" }, 7, false), grant);
  assert.equal(custody.currentHostGrant({ entryId: "entry-1", roomId: "room-2" }, 7, false), null);
  assert.equal(custody.currentHostGrant({ entryId: "entry-1", roomId: "room-1" }, 8, false), null);
  assert.equal(custody.currentHostGrant({ entryId: "entry-1", roomId: "room-1" }, 7, true), null);
  assert.equal(custody.currentHostGrant({ entryId: "entry-2", roomId: "room-1" }, 7, false), null);
});

test("replacement and revocation are fenced by exact host-grant object identity", () => {
  const custody = new WorkerRuntimeCustody();
  const stale = hostGrant();
  const current = hostGrant({ supervisorGrant: "replacement-secret", expiresAt: "2026-08-28T10:00:00.000Z" });
  const later = hostGrant({ supervisorGrant: "later-secret", expiresAt: "2026-08-29T10:00:00.000Z" });
  custody.installHostGrant(stale);

  assert.equal(custody.replaceHostGrantIfCurrent("entry-1", stale, current), true);
  assert.equal(custody.replaceHostGrantIfCurrent("entry-1", stale, later), false);
  assert.equal(custody.hostGrant("entry-1"), current);

  custody.installOpenModelCredential(openModelCredential());
  custody.installWorkerAuthorization(workerAuthorization());
  assert.equal(custody.destroyHostGrantIfCurrent("entry-1", stale), false);
  assert.equal(custody.hostGrant("entry-1"), current);
  assert.notEqual(custody.openModelCredential("entry-1"), undefined);
  assert.notEqual(custody.workerAuthorization("entry-1"), undefined);

  assert.equal(custody.destroyHostGrantIfCurrent("entry-1", current), true);
  assert.equal(custody.hostGrant("entry-1"), undefined);
  assert.equal(custody.openModelCredential("entry-1"), undefined);
  assert.equal(custody.workerAuthorization("entry-1"), undefined);
});

test("returns Open Model credentials only for the active daemon generation", () => {
  const custody = new WorkerRuntimeCustody();
  const credential = openModelCredential();
  custody.installOpenModelCredential(credential);

  assert.equal(custody.currentOpenModelCredential("entry-1", 7), credential);
  assert.equal(custody.currentOpenModelCredential("entry-1", 8), null);
  assert.equal(custody.currentOpenModelCredential("entry-2", 7), null);
});

test("worker authorization freshness uses strict expiry and fallback boundaries", () => {
  const grant = hostGrant();
  const scope = { entryId: "entry-1", roomId: "room-1", workAttemptId: "attempt-1" };

  const freshCustody = new WorkerRuntimeCustody();
  const fresh = workerAuthorization({ expiresAt: new Date(NOW_MS + 60_001).toISOString() });
  freshCustody.installWorkerAuthorization(fresh);
  assert.equal(freshCustody.currentWorkerAuthorization(scope, grant, NOW_MS), fresh);

  const boundaryCustody = new WorkerRuntimeCustody();
  boundaryCustody.installWorkerAuthorization(workerAuthorization({
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
  }));
  assert.equal(boundaryCustody.currentWorkerAuthorization(scope, grant, NOW_MS), null);
  assert.equal(boundaryCustody.workerAuthorization("entry-1"), undefined);

  const fallbackFreshCustody = new WorkerRuntimeCustody();
  const fallbackFresh = workerAuthorization({ expiresAt: null, mintedAtMs: NOW_MS - 119_999 });
  fallbackFreshCustody.installWorkerAuthorization(fallbackFresh);
  assert.equal(fallbackFreshCustody.currentWorkerAuthorization(scope, grant, NOW_MS), fallbackFresh);

  const invalidExpiryCustody = new WorkerRuntimeCustody();
  const invalidExpiry = workerAuthorization({ expiresAt: "not-a-date", mintedAtMs: NOW_MS - 119_999 });
  invalidExpiryCustody.installWorkerAuthorization(invalidExpiry);
  assert.equal(invalidExpiryCustody.currentWorkerAuthorization(scope, grant, NOW_MS), invalidExpiry);

  const fallbackBoundaryCustody = new WorkerRuntimeCustody();
  fallbackBoundaryCustody.installWorkerAuthorization(workerAuthorization({
    expiresAt: null,
    mintedAtMs: NOW_MS - 120_000,
  }));
  assert.equal(fallbackBoundaryCustody.currentWorkerAuthorization(scope, grant, NOW_MS), null);
});

test("worker authorization rejects and destroys every stale grant or entry scope", () => {
  const cases: Array<[string, Partial<CachedWorkerAuthorization>]> = [
    ["room", { roomId: "room-2" }],
    ["agent key", { agentKey: "agent-2" }],
    ["grant id", { grantId: "grant-2" }],
    ["grant generation", { grantGeneration: 4 }],
    ["daemon generation", { daemonGeneration: 8 }],
    ["API URL", { apiUrl: "https://other.example.com" }],
  ];
  const scope = { entryId: "entry-1", roomId: "room-1", workAttemptId: "attempt-1" };

  for (const [label, override] of cases) {
    const custody = new WorkerRuntimeCustody();
    custody.installWorkerAuthorization(workerAuthorization(override));
    assert.equal(custody.currentWorkerAuthorization(scope, hostGrant(), NOW_MS), null, label);
    assert.equal(custody.workerAuthorization("entry-1"), undefined, label);
  }
});

test("a pre-attempt worker authorization is claimed once by the first durable attempt", () => {
  const custody = new WorkerRuntimeCustody();
  const cached = workerAuthorization({ workAttemptId: null });
  custody.installWorkerAuthorization(cached);

  assert.equal(custody.currentWorkerAuthorization({
    entryId: "entry-1",
    roomId: "room-1",
    workAttemptId: "attempt-1",
  }, hostGrant(), NOW_MS), cached);
  assert.equal(cached.workAttemptId, "attempt-1");

  assert.equal(custody.currentWorkerAuthorization({
    entryId: "entry-1",
    roomId: "room-1",
    workAttemptId: "attempt-2",
  }, hostGrant(), NOW_MS), null);
  assert.equal(custody.workerAuthorization("entry-1"), undefined);
});

test("handoff and final destruction preserve the original secret-drain boundary", () => {
  const custody = new WorkerRuntimeCustody();
  const live = {
    agentSessionId: "session-1",
    executionGenerationId: "execution-2",
    updatedAt: "2026-08-26T10:00:00.000Z",
  };
  custody.installLiveBinding("entry-1", live);
  custody.installPendingResumeBinding("entry-1", pendingResumeBinding());
  custody.installHostGrant(hostGrant());
  custody.installOpenModelCredential(openModelCredential());
  custody.installWorkerAuthorization(workerAuthorization());

  custody.destroyOwnerCredentials();
  assert.equal(custody.hostGrant("entry-1"), undefined);
  assert.equal(custody.openModelCredential("entry-1"), undefined);
  assert.notEqual(custody.workerAuthorization("entry-1"), undefined);
  assert.equal(custody.liveBinding("entry-1"), live);
  assert.equal(custody.hasPendingResumeBinding("entry-1"), true);

  custody.destroyAllCredentials();
  assert.equal(custody.workerAuthorization("entry-1"), undefined);
  assert.equal(custody.liveBinding("entry-1"), live);
  assert.equal(custody.hasPendingResumeBinding("entry-1"), true);
});
