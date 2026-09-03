import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type { DelegatableApprovalAdmission } from "../host-approval-broker.js";
import { applyExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { ExecutionApprovalPublisher } from "../execution-approval-publisher.js";
import { ExecutionDelegationJournalError, type LocalExecutionDelegation } from "../execution-delegation-journal.js";
import { WorkerRuntimeCustody, type CachedWorkerAuthorization, type InstalledHostGrant } from "../worker-runtime-custody.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const now = Date.parse("2026-08-31T00:00:20.000Z");
const projectionJson = JSON.stringify({ version: 1, category: "file_change", path_scope: "workspace_relative",
  changes: [{ path: "src/app.ts", kind: "update", move_path: null, added_lines: 1, removed_lines: 0, diff_bytes: 7 }],
  totals: { file_count: 1, added_lines: 1, removed_lines: 0, diff_bytes: 7 } });
const projectionSha256 = sha(projectionJson);
const requestSha256 = sha("request");

function delegation(revision = 1): LocalExecutionDelegation {
  return { delegationInstanceId: `delegation-${revision}`, revision, ownerAccountId: "owner", hostId: "host",
    installationId: "installation", scopeKey: "owner", agentId: "agent", roomId: "room", agentKey: "owner/agent",
    approverAccountId: "approver", category: "file_change", riskCeiling: "low", grantId: "grant",
    scopeSha256: sha(`scope-${revision}`), createdAtMs: now - 1_000, expiresAtMs: now + 120_000, revokedAtMs: null };
}

function admission(): DelegatableApprovalAdmission {
  const request = { requestId: "request", requestVersion: 1, requestSha256, agentId: "agent", roomId: "room",
    executionGenerationId: "execution", runtimeGenerationId: "runtime", turnId: "turn",
    providerContinuationId: "continuation", providerTurnId: "provider-turn", connectionId: "connection",
    nativeRequestId: 7, kind: "file_change" as const, risk: "low" as const, recoveryBoundary: "connection" as const,
    createdAtMs: now - 1_000, expiresAtMs: now + 120_000, delegatable: true, state: "requested" as const,
    applicationCertainty: null };
  return {
    approval: { request, decision: null },
    projection: { requestId: request.requestId, requestVersion: request.requestVersion, requestSha256,
      agentId: request.agentId, roomId: request.roomId, executionGenerationId: request.executionGenerationId,
      turnId: request.turnId, producedAtMs: now - 500, value: JSON.parse(projectionJson), json: projectionJson,
      sha256: projectionSha256 },
    owned: { inboxItemId: "inbox", workAttemptId: "attempt", executionGenerationId: "execution", provider: "codex",
      providerConnection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "birth" },
      configurationRevision: 1 },
    sourceMessageId: "msg_1",
  };
}

function fixture(t: TestContext) {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const custody = new WorkerRuntimeCustody();
  const grant: InstalledHostGrant = { entryId: "agent", roomId: "room", agentKey: "owner/agent", grantId: "grant",
    supervisorGrant: "PRIVATE_GRANT", grantGeneration: 1, apiUrl: "https://letagents.test", daemonGeneration: 1,
    hostId: "host", installationId: "installation", ownerAccountId: "owner", scopeKey: "owner",
    expiresAt: new Date(now + 180_000).toISOString() };
  const worker: CachedWorkerAuthorization = { entryId: "agent", roomId: "room", agentKey: "owner/agent",
    workAttemptId: "attempt", grantId: "grant", grantGeneration: 1, daemonGeneration: 1,
    apiUrl: grant.apiUrl, agentSessionId: "session", bearer: "PRIVATE_WORKER", bearerId: "bearer",
    expiresAt: null, mintedAtMs: now - 1_000,
    agentSession: { session_id: "session", session_token: "PRIVATE_SESSION", room_id: "room", session_kind: "worker",
      runtime: "codex", actor_label: "Agent", agent_key: "owner/agent", agent_instance_id: "daemon:agent",
      display_name: "Agent", owner_label: "Owner", ide_label: "Desktop", created_at: "2026-08-31",
      updated_at: "2026-08-31", last_seen_at: "2026-08-31", ended_at: null } };
  custody.installHostGrant(grant); custody.installWorkerAuthorization(worker);
  let delegations: LocalExecutionDelegation[] = [];
  let closing = false;
  let currentNow = now;
  const sent: unknown[] = [];
  const closed: unknown[] = [];
  const options = {
    custody,
    approvals: { admitDelegatable: async (_agentId: string) => [admission()] },
    entries: {
      getExecutionApproval: async (_expected: unknown) => admission().approval,
      listExecutionDelegationsForApprovalPublication: async (_input: { agentId: string }) => delegations,
      readExecutionApprovalProjection: async (_expected: unknown) => admission().projection,
    },
    inbox: { get: async (_inboxItemId: string) => ({ inbox_item_id: "inbox", agent_id: "agent", room_id: "room", source_message_id: "msg_1" }) },
    authority: { validateExecutionDelegation: async (_input: unknown) => delegation() },
    daemonGeneration: () => 1,
    isClosing: () => closing,
    assertCurrent: async () => {},
    now: () => currentNow,
    publish: async (input: unknown) => { sent.push(input); return { status: "acknowledged" as const,
      publicationId: "publication", publicationDigest: sha("publication"), publishedAtMs: now - 10_000 }; },
    closePublication: async (input: unknown) => { closed.push(input); return { status: "closed" as const, closedAtMs: now }; },
    diagnostic: () => {},
  };
  const publisher = new ExecutionApprovalPublisher(database, options);
  t.after(() => { publisher.close(); });
  return { database, custody, grant, worker, options, publisher, sent, closed,
    setDelegations(value: LocalExecutionDelegation[]) { delegations = value; },
    setNow(value: number) { currentNow = value; },
    setClosing(value: boolean) { closing = value; } };
}

function retryKeyCount(publisher: ExecutionApprovalPublisher): number {
  return (publisher as unknown as { attemptedAt: Map<string, number> }).attemptedAt.size;
}

function scheduledDelay(publisher: ExecutionApprovalPublisher): number {
  return (publisher as unknown as { scheduledFor: number }).scheduledFor - Date.now();
}

test("a delegation installed after permission admission gets a new bounded publication wake", async t => {
  const f = fixture(t);
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 0, "permission admission cannot invent a missing delegation");
  f.setDelegations([delegation()]);
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 1, "successful delegation reconciliation must re-admit the pending approval");
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
});

test("a transient pin failure requeues the exact agent and publishes once on the next pass", async t => {
  const f = fixture(t);
  f.setDelegations([delegation()]);
  const store = (f.publisher as unknown as {
    store: { pin(value: unknown): unknown };
  }).store;
  const originalPin = store.pin.bind(store);
  let pinAttempts = 0;
  t.mock.method(store, "pin", value => {
    pinAttempts += 1;
    if (pinAttempts === 1) throw new Error("database is locked");
    return originalPin(value);
  });

  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications").get()!.n, 0);

  f.setNow(now + 30_000);
  await f.publisher.flush();
  assert.equal(pinAttempts, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
});

test("a persistent pin failure remains on bounded admission backoff", async t => {
  const f = fixture(t);
  f.setDelegations([delegation()]);
  const store = (f.publisher as unknown as {
    store: { pin(value: unknown): unknown };
  }).store;
  let pinAttempts = 0;
  t.mock.method(store, "pin", () => {
    pinAttempts += 1;
    throw new Error("database is locked");
  });

  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(pinAttempts, 1);
  assert.ok(scheduledDelay(f.publisher) > 25_000, "persistent storage failure uses normal admission backoff");
  await f.publisher.flush();
  assert.equal(pinAttempts, 1, "manual or unrelated early passes cannot hot-loop the backed-off agent");
  f.setNow(now + 30_000);
  await f.publisher.flush();
  assert.equal(pinAttempts, 2);
  assert.ok(scheduledDelay(f.publisher) > 25_000);
  assert.equal(f.sent.length, 0);
});

test("an unexpected admission failure requeues the agent at the normal retry cadence", async t => {
  const f = fixture(t);
  f.setDelegations([delegation()]);
  let admissions = 0;
  f.options.approvals.admitDelegatable = async () => {
    admissions += 1;
    if (admissions === 1) throw new Error("database is locked");
    return [admission()];
  };

  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(admissions, 1);
  assert.ok(scheduledDelay(f.publisher) > 25_000, "unexpected admission failures do not create a hot retry loop");
  assert.equal(f.sent.length, 0);

  f.setNow(now + 30_000);
  await f.publisher.flush();
  assert.equal(admissions, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
});

test("a backed-off admission does not block a healthy pending agent", async t => {
  const f = fixture(t);
  const secondAgent = "agent-b";
  const secondGrant = { ...f.grant, entryId: secondAgent, agentKey: `owner/${secondAgent}`,
    grantId: "grant-b" };
  const secondWorker = { ...f.worker, entryId: secondAgent, agentKey: `owner/${secondAgent}`,
    workAttemptId: "attempt-b", grantId: "grant-b", agentSessionId: "session-b",
    agentSession: { ...f.worker.agentSession!, session_id: "session-b", agent_key: `owner/${secondAgent}`,
      agent_instance_id: `daemon:${secondAgent}` } };
  f.custody.installHostGrant(secondGrant);
  f.custody.installWorkerAuthorization(secondWorker);
  const base = admission();
  const secondRequest = { ...base.approval.request, requestId: "request-b", requestSha256: sha("request-b"),
    agentId: secondAgent };
  const secondAdmission: DelegatableApprovalAdmission = {
    approval: { request: secondRequest, decision: null },
    projection: { ...base.projection, requestId: secondRequest.requestId, requestSha256: secondRequest.requestSha256,
      agentId: secondAgent },
    owned: { ...base.owned, inboxItemId: "inbox-b", workAttemptId: "attempt-b" },
    sourceMessageId: "msg_2",
  };
  const secondDelegation = { ...delegation(), delegationInstanceId: "delegation-b", agentId: secondAgent,
    agentKey: `owner/${secondAgent}`, grantId: "grant-b" };
  let firstAdmissions = 0;
  f.options.approvals.admitDelegatable = async agentId => {
    if (agentId === "agent") {
      firstAdmissions += 1;
      return [base];
    }
    return [secondAdmission];
  };
  f.options.entries.listExecutionDelegationsForApprovalPublication = async input =>
    input.agentId === secondAgent ? [secondDelegation] : [delegation()];
  f.options.entries.getExecutionApproval = async expected =>
    (expected as { agentId?: string }).agentId === secondAgent ? secondAdmission.approval : base.approval;
  f.options.entries.readExecutionApprovalProjection = async expected =>
    (expected as { agentId?: string }).agentId === secondAgent ? secondAdmission.projection : base.projection;
  f.options.inbox.get = async inboxItemId => inboxItemId === "inbox-b"
    ? { inbox_item_id: "inbox-b", agent_id: secondAgent, room_id: "room", source_message_id: "msg_2" }
    : { inbox_item_id: "inbox", agent_id: "agent", room_id: "room", source_message_id: "msg_1" };
  const store = (f.publisher as unknown as { store: { pin(value: { agentId?: string }): unknown } }).store;
  const originalPin = store.pin.bind(store);
  t.mock.method(store, "pin", value => {
    if (value.agentId === "agent") throw new Error("database is locked");
    return originalPin(value);
  });

  f.publisher.changed("agent");
  f.publisher.changed(secondAgent);
  await f.publisher.flush();
  assert.equal(firstAdmissions, 1);
  assert.equal(f.sent.length, 0);
  assert.ok(scheduledDelay(f.publisher) < 5_000, "the healthy peer retains the coalesced wake");
  await f.publisher.flush();
  assert.equal(firstAdmissions, 1, "the failed agent remains ineligible until its retry deadline");
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT agent_id FROM execution_approval_publications").get()!.agent_id, secondAgent);
});

test("a never-attempted pin rechecks the exact local request before first upload", async t => {
  const f = fixture(t);
  f.setDelegations([delegation()]);
  (f.options.entries as { getExecutionApproval: () => Promise<unknown> }).getExecutionApproval = async () => null;
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "invalid");
});

test("server terminal and local immutable-origin mismatch stop retries", async t => {
  for (const scenario of [
    { name: "server conflict", result: { status: "conflict" }, state: "conflict" },
    { name: "server expiry", result: { status: "terminal", reason: "expired" }, state: "expired" },
    { name: "server invalid delegation", result: { status: "terminal", reason: "invalid_delegation" }, state: "invalid" },
  ] as const) await t.test(scenario.name, async t => {
      const f = fixture(t); f.setDelegations([delegation()]);
      (f.options as { publish: (input: unknown) => Promise<unknown> }).publish = async input => {
        f.sent.push(input); return scenario.result;
      };
      f.publisher.changed("agent"); await f.publisher.flush(); await f.publisher.flush();
      assert.equal(f.sent.length, 1);
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, scenario.state);
      assert.equal(retryKeyCount(f.publisher), 0, "terminal records release in-memory retry bookkeeping");
    });
  await t.test("origin replacement", async t => {
    const f = fixture(t); f.setDelegations([delegation()]);
    (f.options as { publish: (input: unknown) => Promise<unknown> }).publish = async input => {
      f.sent.push(input); throw new Error("offline");
    };
    f.publisher.changed("agent"); await f.publisher.flush(); assert.equal(f.sent.length, 1);
    const movedGrant = { ...f.grant, roomId: "moved", agentKey: "owner/moved" };
    const movedWorker = { ...f.worker, roomId: "moved", agentKey: "owner/moved",
      agentSession: { ...f.worker.agentSession!, room_id: "moved", agent_key: "owner/moved" } };
    f.custody.installHostGrant(movedGrant); f.custody.installWorkerAuthorization(movedWorker);
    f.setNow(now + 31_000);
    await f.publisher.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "invalid");
    assert.equal(retryKeyCount(f.publisher), 0);
  });
});

test("a lost upload response replays after restart and closes only after receipt reconciliation", async t => {
  const f = fixture(t); f.setDelegations([delegation()]);
  f.options.publish = async input => { f.sent.push(input); throw new Error("lost response"); };
  f.publisher.changed("agent"); await f.publisher.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");

  const rotatedGrant = { ...f.grant, grantId: "grant-2", grantGeneration: 2 };
  const rotatedWorker = { ...f.worker, grantId: "grant-2", grantGeneration: 2 };
  f.custody.installHostGrant(rotatedGrant); f.custody.installWorkerAuthorization(rotatedWorker);
  let delegationPreflights = 0;
  f.options.authority.validateExecutionDelegation = async () => {
    delegationPreflights += 1;
    throw new ExecutionDelegationJournalError("terminal");
  };
  let approvalReads = 0;
  f.options.entries.getExecutionApproval = async () => {
    approvalReads += 1;
    const resolved = admission().approval;
    return { ...resolved, request: { ...resolved.request, state: "superseded" as const } };
  };
  f.options.publish = async input => { f.sent.push(input); return { status: "acknowledged", publicationId: "publication",
    publicationDigest: sha("publication"), publishedAtMs: now }; };

  const closeDatabase = t.mock.method(f.database, "close", () => {});
  f.publisher.close();
  const restarted = new ExecutionApprovalPublisher(f.database, f.options);
  f.setNow(now + 31_000);
  await restarted.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
  assert.equal(delegationPreflights, 0, "durably attempted uploads bypass later delegation terminality");
  assert.equal(approvalReads, 0, "a possibly committed upload is reconciled before local resolution closes it");
  await restarted.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "closed");
  assert.equal(approvalReads, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.closed.length, 1);
  assert.equal(Object.hasOwn(f.closed[0] as object, "decision"), false);
  restarted.close(); closeDatabase.mock.restore(); f.database.close();
});

test("recorded work not ready keeps the durable attempt retryable until publication succeeds", async t => {
  const f = fixture(t); f.setDelegations([delegation()]);
  let workReady = false;
  f.options.publish = async input => {
    f.sent.push(input);
    if (!workReady) throw new Error("Execution approval publication work custody failed with HTTP 409.");
    return { status: "acknowledged", publicationId: "publication",
      publicationDigest: sha("publication"), publishedAtMs: now };
  };
  f.publisher.changed("agent"); await f.publisher.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
  workReady = true; f.setNow(now + 31_000); await f.publisher.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
});

test("an expired attempted upload without authority becomes terminal and prunable after restart", async t => {
  const f = fixture(t); f.setDelegations([delegation()]);
  f.options.publish = async input => { f.sent.push(input); throw new Error("lost response"); };
  f.publisher.changed("agent"); await f.publisher.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
  const closeDatabase = t.mock.method(f.database, "close", () => {});
  f.publisher.close();
  f.custody.deleteHostGrant("agent"); f.custody.deleteWorkerAuthorization("agent");
  f.setNow(now + 121_000);
  const restarted = new ExecutionApprovalPublisher(f.database, f.options);
  await restarted.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "expired");
  assert.equal(f.database.prepare("DELETE FROM execution_approval_publications").run().changes, 1);
  restarted.close(); closeDatabase.mock.restore(); f.database.close();
});

test("one pass publishes at most four immutable pins and close fences a late receipt", async t => {
  const f = fixture(t);
  f.setDelegations(Array.from({ length: 6 }, (_, index) => delegation(index + 1)));
  f.publisher.changed("agent"); await f.publisher.flush();
  assert.equal(f.sent.length, 4);
  await f.publisher.flush(); assert.equal(f.sent.length, 6);

  const late = fixture(t); late.setDelegations([delegation()]);
  let release!: (value: { status: "acknowledged"; publicationId: string; publicationDigest: string; publishedAtMs: number }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  (late.options as { publish: (input: unknown) => Promise<unknown> }).publish = async input => {
    late.sent.push(input); started(); return new Promise(resolve => { release = resolve as typeof release; });
  };
  late.publisher.changed("agent"); const pending = late.publisher.flush(); await ready;
  const close = t.mock.method(late.database, "close", () => {});
  late.publisher.close();
  assert.equal((late.sent[0] as { signal: AbortSignal }).signal.aborted, true);
  release({ status: "acknowledged", publicationId: "late", publicationDigest: sha("late"), publishedAtMs: now });
  await pending;
  assert.equal(late.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
  close.mock.restore(); late.database.close();
});
