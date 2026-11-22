import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { DaemonStateSchema } from "../daemon-state-database.js";
import type { DelegatableApprovalAdmission } from "../host-approval-broker.js";
import {
  applyEffectJournalSchema,
  EffectClaimRefusedError,
  EffectExecutor,
  EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
  EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
  EXECUTION_APPROVAL_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
  executionApprovalCloseIdempotencyKey,
  executionApprovalPublishIdempotencyKey,
  getEffect,
  listActiveExecutionApprovalEffectsForAgent,
  listEffectsForAgent,
  retireObsoleteExecutionApprovalEffects,
} from "../effect-journal/index.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import { applyExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { ExecutionApprovalPublisher } from "../execution-approval-publisher.js";
import { ExecutionDelegationJournalError, type LocalExecutionDelegation } from "../execution-delegation-journal.js";
import { LifecycleAdministrationCoordinator } from "../lifecycle-administration-coordinator.js";
import { ManifestStore } from "../manifest-store.js";
import { RoomMoveCoordinator } from "../room-move-coordinator.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerRuntimeCustody, type CachedWorkerAuthorization, type InstalledHostGrant } from "../worker-runtime-custody.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { seedBoundedMcpEffectRow } from "./helpers/bounded-effect-seed.js";

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
  applyEffectJournalSchema(database);
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
  const diagnostics: string[] = [];
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
    diagnostic: (code: string) => { diagnostics.push(code); },
  };
  const publisher = new ExecutionApprovalPublisher(database, options);
  t.after(() => { publisher.close(); });
  return { database, custody, grant, worker, options, publisher, sent, closed, diagnostics,
    setDelegations(value: LocalExecutionDelegation[]) { delegations = value; },
    setNow(value: number) { currentNow = value; },
    setClosing(value: boolean) { closing = value; } };
}

function retryKeyCount(publisher: ExecutionApprovalPublisher, database?: DatabaseSync): number {
  const internalCount = (publisher as unknown as { acknowledgedCheckAt: Map<string, number> }).acknowledgedCheckAt.size;
  if (!database) return internalCount;
  return internalCount + listActiveExecutionApprovalEffectsForAgent(database, "agent").length;
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
      assert.equal(retryKeyCount(f.publisher, f.database), 0, "terminal records release retry bookkeeping and active effects");
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
    assert.equal(retryKeyCount(f.publisher, f.database), 0);
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

test("lost-response crash recovery replays publish and close effects under exact idempotency keys via EffectExecutor", async t => {
  const f = fixture(t);
  let currentNow = now;
  f.setNow(currentNow);
  f.setDelegations([delegation(1), delegation(2)]);

  // Pin both delegations by admitting once with publish held via a failure, then seed exact interrupted executing rows.
  f.options.publish = async () => { throw new Error("offline PRIVATE_RAW_ERROR"); };
  f.publisher.changed("agent");
  await f.publisher.flush();
  f.publisher.close();

  // Record 1 stays in `attempted` (simulating publish crash mid-HTTP); advance record 2 to `closing` (simulating close crash mid-HTTP).
  const pubId = "pub-crash-2";
  const pubDigest = sha("pub-crash-2");
  f.database.prepare(`
    UPDATE execution_approval_publications
    SET state = 'acknowledged', publication_id = ?, publication_digest = ?, published_at_ms = ?
    WHERE delegation_instance_id = 'delegation-2'
  `).run(pubId, pubDigest, now - 5_000);
  f.database.prepare(`
    UPDATE execution_approval_publications
    SET state = 'closing'
    WHERE delegation_instance_id = 'delegation-2'
  `).run();

  // Clear auto-prepared rows and insert predecessor generation-1 `executing` rows for both publish and close.
  f.database.exec("DELETE FROM effects;");
  const publishKey = executionApprovalPublishIdempotencyKey({
    roomId: "room",
    delegationInstanceId: "delegation-1",
    delegationRevision: 1,
    requestId: "request",
    requestVersion: 1,
    projectionSha256,
  });
  const closeKey = executionApprovalCloseIdempotencyKey({
    roomId: "room",
    delegationInstanceId: "delegation-2",
    delegationRevision: 2,
    requestId: "request",
    requestVersion: 1,
    publicationId: pubId,
    publicationDigest: pubDigest,
  });
  const ts = new Date(currentNow).toISOString();
  f.database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent', ?, ?, 1, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    "eff-crash-approval-publish",
    EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    publishKey,
    JSON.stringify({
      delegation_instance_id: "delegation-1",
      delegation_revision: 1,
      projection_sha256: projectionSha256,
      request_id: "request",
      request_version: 1,
      room_id: "room",
    }),
    ts,
    ts,
  );
  f.database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent', ?, ?, 1, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    "eff-crash-approval-close",
    EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
    closeKey,
    JSON.stringify({
      delegation_instance_id: "delegation-2",
      delegation_revision: 2,
      publication_digest: pubDigest,
      publication_id: pubId,
      request_id: "request",
      request_version: 1,
      room_id: "room",
    }),
    ts,
    ts,
  );

  // Successor generation 2 attaches to shared EffectExecutor and runs recoverOnStartup().
  let closing = false;
  f.custody.installHostGrant({ ...f.grant, daemonGeneration: 2 });
  f.custody.installWorkerAuthorization({ ...f.worker, daemonGeneration: 2 });
  const executor = new EffectExecutor({
    getDatabase: () => f.database,
    currentDaemonGeneration: () => 2,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => closing,
    nowMs: () => currentNow,
  });
  const successorSent: unknown[] = [];
  const successorClosed: unknown[] = [];
  const successor = new ExecutionApprovalPublisher(f.database, {
    ...f.options,
    daemonGeneration: () => 2,
    isClosing: () => closing,
    now: () => currentNow,
    effectExecutor: executor,
    publish: async (input) => {
      successorSent.push(input);
      return { status: "acknowledged", publicationId: "pub-1", publicationDigest: sha("pub-1"), publishedAtMs: currentNow };
    },
    closePublication: async (input) => {
      successorClosed.push(input);
      return { status: "closed", closedAtMs: currentNow };
    },
  });
  t.after(() => { closing = true; successor.close(); executor.fence(); });

  const recovery = await executor.recoverOnStartup();
  assert.deepEqual(recovery.requeuedIds.sort(), ["eff-crash-approval-close", "eff-crash-approval-publish"]);
  assert.equal(getEffect(f.database, "eff-crash-approval-publish")?.state, "prepared");
  assert.equal(getEffect(f.database, "eff-crash-approval-close")?.state, "prepared");

  await successor.flush();
  assert.equal(successorSent.length, 1);
  assert.equal(successorClosed.length, 1);
  assert.equal(
    f.database.prepare("SELECT state FROM execution_approval_publications WHERE delegation_instance_id='delegation-1'").get()!.state,
    "acknowledged",
  );
  assert.equal(
    f.database.prepare("SELECT state FROM execution_approval_publications WHERE delegation_instance_id='delegation-2'").get()!.state,
    "closed",
  );

  // Exact same rows reused (attempt_count = 2, epoch = 2, no duplicate rows).
  const completedPublish = getEffect(f.database, "eff-crash-approval-publish")!;
  const completedClose = getEffect(f.database, "eff-crash-approval-close")!;
  assert.equal(completedPublish.state, "completed");
  assert.equal(completedPublish.attempt_count, 2);
  assert.equal(completedPublish.epoch, 2);
  assert.equal(completedClose.state, "completed");
  assert.equal(completedClose.attempt_count, 2);
  assert.equal(completedClose.epoch, 2);
  assert.equal(listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND }).length, 1);
  assert.equal(listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND }).length, 1);

  // Subsequent flushes suppress duplicates.
  await successor.flush();
  assert.equal(successorSent.length, 1);
  assert.equal(successorClosed.length, 1);
});

test("duplicate suppression shares in-flight effects and refuses already-settled or expired claims", async t => {
  const f = fixture(t);
  let closing = false;
  let currentNow = now;
  const executor = new EffectExecutor({
    getDatabase: () => f.database,
    currentDaemonGeneration: () => 1,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => closing,
    nowMs: () => currentNow,
  });
  let started!: () => void;
  let release!: (value: { status: "acknowledged"; publicationId: string; publicationDigest: string; publishedAtMs: number }) => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const publisher = new ExecutionApprovalPublisher(f.database, {
    ...f.options,
    isClosing: () => closing,
    now: () => currentNow,
    effectExecutor: executor,
    publish: async (input) => {
      f.sent.push(input);
      started();
      return new Promise(resolve => { release = resolve; });
    },
  });
  t.after(() => { closing = true; publisher.close(); executor.fence(); });

  f.setDelegations([delegation(1)]);
  publisher.changed("agent");
  const flushing = publisher.flush();
  await inFlight;

  const [activeEffect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
  assert.ok(activeEffect);
  assert.equal(activeEffect.state, "executing");

  // Direct concurrent runEffect shares the single in-flight promise (zero duplicate HTTP).
  const shared = executor.runEffect(activeEffect.id);
  release({ status: "acknowledged", publicationId: "pub-shared", publicationDigest: sha("pub-shared"), publishedAtMs: currentNow });
  const [settled] = await Promise.all([shared, flushing]);
  assert.equal(settled.state, "completed");
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");

  // Seed a stale prepared publish effect for the already-acknowledged pin and confirm authorizeClaim refuses it with zero HTTP.
  const stale = await executor.prepare({
    agent_id: "agent",
    kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    idempotency_key: "eap:v1:stale-manual-probe",
    payload: activeEffect.payload,
    retryable: true,
    max_attempts: 1_000_000,
  });
  await assert.rejects(() => executor.runEffect(stale.effect.id), EffectClaimRefusedError);
  assert.equal(getEffect(f.database, stale.effect.id)?.state, "failed");
  assert.equal(f.sent.length, 1);
});

test("EffectExecutor handoff fenceAndDrain aborts in-flight approval HTTP, prevents secrets/projection leaks, and lets successor finish", async t => {
  const f = fixture(t);
  let generation = 1;
  let closing = false;
  const currentNow = now;
  const executor1 = new EffectExecutor({
    getDatabase: () => f.database,
    currentDaemonGeneration: () => generation,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => closing,
    nowMs: () => currentNow,
  });
  let started!: () => void;
  let release!: (value: { status: "acknowledged"; publicationId: string; publicationDigest: string; publishedAtMs: number }) => void;
  let observedSignal: AbortSignal | null = null;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const publisher1 = new ExecutionApprovalPublisher(f.database, {
    ...f.options,
    daemonGeneration: () => generation,
    isClosing: () => closing,
    now: () => currentNow,
    effectExecutor: executor1,
    publish: async (input) => {
      f.sent.push(input);
      observedSignal = input.signal;
      started();
      return new Promise(resolve => { release = resolve; });
    },
  });
  t.after(() => { closing = true; publisher1.close(); executor1.fence(); });

  f.setDelegations([delegation(1)]);
  publisher1.changed("agent");
  const flushing = publisher1.flush();
  await inFlight;
  assert.equal(f.sent.length, 1);

  const draining = executor1.fenceAndDrain();
  assert.equal(observedSignal!.aborted, true, "handoff fence aborts in-flight approval HTTP");
  release({ status: "acknowledged", publicationId: "pub-late", publicationDigest: sha("pub-late"), publishedAtMs: currentNow });
  await Promise.all([draining, flushing]);

  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
  const [requeued] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
  assert.equal(requeued?.state, "prepared", "aborted upload returns cleanly to prepared for successor recovery");
  await publisher1.flush();
  assert.equal(f.sent.length, 1);
  publisher1.close();

  // Successor generation 2 completes the exact prepared effect cleanly.
  generation = 2;
  f.custody.installHostGrant({ ...f.grant, daemonGeneration: 2 });
  f.custody.installWorkerAuthorization({ ...f.worker, daemonGeneration: 2 });
  const executor2 = new EffectExecutor({
    getDatabase: () => f.database,
    currentDaemonGeneration: () => generation,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => closing,
    nowMs: () => currentNow,
  });
  const publisher2 = new ExecutionApprovalPublisher(f.database, {
    ...f.options,
    daemonGeneration: () => generation,
    isClosing: () => closing,
    now: () => currentNow,
    effectExecutor: executor2,
    publish: async (input) => {
      f.sent.push(input);
      return { status: "acknowledged", publicationId: "pub-gen2", publicationDigest: sha("pub-gen2"), publishedAtMs: currentNow };
    },
  });
  t.after(() => { publisher2.close(); executor2.fence(); });

  await executor2.recoverOnStartup();
  await publisher2.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
  assert.equal(getEffect(f.database, requeued!.id)?.state, "completed");
  assert.equal(getEffect(f.database, requeued!.id)?.epoch, 2);

  // Secret and projection-content custody: zero tokens or workspace file paths in `effects`.
  const allEffects = JSON.stringify(f.database.prepare("SELECT payload, outcome, last_error FROM effects").all());
  assert.doesNotMatch(allEffects, /PRIVATE_GRANT|PRIVATE_WORKER|PRIVATE_SESSION|src\/app\.ts/);
});

test("failed approval publish and close settlements recover without restart and never touch live in-flight work", async t => {
  await t.test("publish Layer 1: completion write failure rolls back receipt and reschedules retry", async t => {
    const f = fixture(t);
    let currentNow = now;
    f.setNow(currentNow);
    f.setDelegations([delegation(1)]);
    f.database.exec(`
      CREATE TRIGGER fail_approval_publish_complete
      BEFORE UPDATE OF state ON effects
      WHEN NEW.kind = '${EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND}' AND NEW.state = 'completed'
      BEGIN SELECT RAISE(ABORT, 'simulated_publish_complete_failure'); END;
    `);
    f.publisher.changed("agent");
    await f.publisher.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
    assert.ok(f.diagnostics.includes("storage_unavailable"));
    assert.ok(!f.diagnostics.includes("publication_unavailable"));
    const [effect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
    assert.equal(effect?.state, "prepared");
    assert.equal(effect?.next_attempt_at_ms, currentNow + 30_000);
    assert.equal(effect?.last_error, "settlement_write_failed");

    f.database.exec("DROP TRIGGER fail_approval_publish_complete;");
    currentNow += 1_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.sent.length, 1, "backoff prevents immediate tight-loop spin");

    currentNow = now + 30_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.sent.length, 2, "recovered without restart after backoff");
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
    assert.equal(getEffect(f.database, effect!.id)?.state, "completed");
  });

  await t.test("publish Layer 2: full update outage leaves row executing and next flush recovers without restart", async t => {
    const f = fixture(t);
    let currentNow = now;
    f.setNow(currentNow);
    f.setDelegations([delegation(1)]);
    f.database.exec(`
      CREATE TRIGGER fail_approval_publish_all_updates
      BEFORE UPDATE ON effects
      WHEN OLD.kind = '${EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND}' AND OLD.state = 'executing'
      BEGIN SELECT RAISE(ABORT, 'simulated_publish_outage'); END;
    `);
    f.publisher.changed("agent");
    await f.publisher.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
    const [stuck] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
    assert.equal(stuck?.state, "executing");

    f.database.exec("DROP TRIGGER fail_approval_publish_all_updates;");
    currentNow += 1_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.sent.length, 1, "Layer 2 recovers row to prepared with 30s deadline");
    assert.equal(getEffect(f.database, stuck!.id)?.state, "prepared");
    assert.equal(getEffect(f.database, stuck!.id)?.next_attempt_at_ms, now + 30_000);

    currentNow = now + 30_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.sent.length, 2);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
    assert.equal(getEffect(f.database, stuck!.id)?.state, "completed");
  });

  await t.test("close Layer 2: full update outage leaves close row executing and next flush recovers without restart", async t => {
    const f = fixture(t);
    let currentNow = now;
    f.setNow(currentNow);
    f.setDelegations([delegation(1)]);
    f.publisher.changed("agent");
    await f.publisher.flush();
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");

    // Local request resolves so close becomes due.
    f.options.entries.getExecutionApproval = async () => {
      const base = admission().approval;
      return { ...base, request: { ...base.request, state: "superseded" as const } };
    };
    f.database.exec(`
      CREATE TRIGGER fail_approval_close_all_updates
      BEFORE UPDATE ON effects
      WHEN OLD.kind = '${EXECUTION_APPROVAL_CLOSE_EFFECT_KIND}' AND OLD.state = 'executing'
      BEGIN SELECT RAISE(ABORT, 'simulated_close_outage'); END;
    `);
    await f.publisher.flush();
    assert.equal(f.closed.length, 1);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "closing");
    const [stuckClose] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND });
    assert.equal(stuckClose?.state, "executing");

    f.database.exec("DROP TRIGGER fail_approval_close_all_updates;");
    currentNow += 1_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.closed.length, 1, "Layer 2 recovers close row to prepared with 30s deadline");
    assert.equal(getEffect(f.database, stuckClose!.id)?.state, "prepared");
    assert.equal(getEffect(f.database, stuckClose!.id)?.next_attempt_at_ms, now + 30_000);

    currentNow = now + 30_000;
    f.setNow(currentNow);
    await f.publisher.flush();
    assert.equal(f.closed.length, 2);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "closed");
    assert.equal(getEffect(f.database, stuckClose!.id)?.state, "completed");
  });

  await t.test("control: genuinely active in-flight executing approval upload is never recovered or duplicated", async t => {
    const f = fixture(t);
    let closing = false;
    let currentNow = now;
    const executor = new EffectExecutor({
      getDatabase: () => f.database,
      currentDaemonGeneration: () => 1,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => closing,
      nowMs: () => currentNow,
    });
    let started!: () => void;
    let release!: (value: { status: "acknowledged"; publicationId: string; publicationDigest: string; publishedAtMs: number }) => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const publisher = new ExecutionApprovalPublisher(f.database, {
      ...f.options,
      isClosing: () => closing,
      now: () => currentNow,
      effectExecutor: executor,
      publish: async (input) => {
        f.sent.push(input);
        started();
        return new Promise(resolve => { release = resolve; });
      },
    });
    t.after(() => { closing = true; publisher.close(); executor.fence(); });

    // Admit pin & mark attempted via one failed attempt first, then drive live execution directly on executor.
    f.setDelegations([delegation(1)]);
    let firstAttempt = true;
    const controlledPublisher = new ExecutionApprovalPublisher(f.database, {
      ...f.options,
      isClosing: () => closing,
      now: () => currentNow,
      publish: async () => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("offline");
        }
        return { status: "acknowledged", publicationId: "unused", publicationDigest: sha("unused"), publishedAtMs: currentNow };
      },
    });
    t.after(() => { controlledPublisher.close(); });
    controlledPublisher.changed("agent");
    await controlledPublisher.flush();
    controlledPublisher.close();
    const [prepared] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
    assert.equal(prepared?.state, "prepared");

    currentNow = now + 31_000;
    const activeRun = executor.runEffect(prepared!.id);
    await inFlight;
    assert.equal(executor.isEffectActive(prepared!.id), true);
    assert.equal(getEffect(f.database, prepared!.id)?.state, "executing");

    // Advance past RETRY_MS and run flush() while live upload is in flight.
    currentNow += 60_000;
    await publisher.flush();
    assert.equal(f.sent.length, 1, "flush never recovers or duplicates a genuinely live in-flight approval upload");
    assert.equal(getEffect(f.database, prepared!.id)?.state, "executing");

    release({ status: "acknowledged", publicationId: "pub-live", publicationDigest: sha("pub-live"), publishedAtMs: now });
    const settled = await activeRun;
    assert.equal(settled.state, "completed");
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
  });
});

test("terminal approval effects stay bounded per agent and local terminalize cancels active prepared effects atomically", async t => {
  const f = fixture(t);
  let currentNow = now;
  f.setNow(currentNow);
  const seedCount = EXECUTION_APPROVAL_RETAINED_TERMINAL_EFFECTS_PER_AGENT + 20;
  f.database.exec("BEGIN IMMEDIATE");
  const insert = f.database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent', ?, ?, 1, 'completed', '{"seeded":true}', '{"status":"acknowledged"}', 1, 1, 1000000, NULL, NULL, ?, ?)
  `);
  for (let i = 0; i < seedCount; i += 1) {
    const ts = new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString();
    insert.run(`eff-appr-old-${i}`, EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, `eap:v1:seed-${i}`, ts, ts);
  }
  f.database.prepare(`
    INSERT INTO execution_approval_publications (
      agent_id, room_id, api_origin, agent_key, agent_instance_id, host_id, installation_id, source_session_id,
      source_message_id, inbox_item_id, work_attempt_id, delegation_instance_id, delegation_revision,
      delegation_scope_sha256, approver_account_id, request_id, request_version, request_sha256,
      execution_generation_id, runtime_generation_id, turn_id, provider_continuation_id, provider_turn_id,
      connection_id, native_request_id_type, native_request_id, projection_sha256, produced_at_ms, expires_at_ms,
      state, publication_id, publication_digest, published_at_ms, closed_at_ms
    ) VALUES (
      'agent', 'room', 'https://letagents.test', 'owner/agent', 'daemon:agent', 'host', 'installation', 'session',
      'msg_1', 'inbox', 'attempt', 'delegation-keep', 1,
      ?, 'approver', 'request-keep', 1, ?,
      'execution', 'runtime', 'turn', 'continuation', 'provider-turn',
      'connection', 'number', '7', ?, ?, ?,
      'attempted', NULL, NULL, NULL, NULL
    )
  `).run(sha("scope-keep"), sha("request-keep"), projectionSha256, now - 500, now + 600_000);
  f.database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-appr-active-keep', 'agent', ?, ?, 1, 'prepared', ?, NULL, 1, 1, 1000000, ?, 'publication_unavailable', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(
    EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    executionApprovalPublishIdempotencyKey({
      roomId: "room",
      delegationInstanceId: "delegation-keep",
      delegationRevision: 1,
      requestId: "request-keep",
      requestVersion: 1,
      projectionSha256,
    }),
    JSON.stringify({
      room_id: "room",
      delegation_instance_id: "delegation-keep",
      delegation_revision: 1,
      request_id: "request-keep",
      request_version: 1,
      projection_sha256: projectionSha256,
    }),
    now + 500_000,
  );
  f.database.exec("COMMIT");

  // Fail once so delegation-1 has a prepared effect, then expire it locally with a rollback check first.
  f.setDelegations([delegation(1)]);
  f.options.publish = async (input) => { f.sent.push(input); throw new Error("offline"); };
  f.publisher.changed("agent");
  await f.publisher.flush();
  const activeBefore = listActiveExecutionApprovalEffectsForAgent(f.database, "agent").filter(e => e.id !== "eff-appr-active-keep");
  assert.equal(activeBefore.length, 1);
  assert.equal(activeBefore[0]!.state, "prepared");

  // Block effect cancellation on expiry: domain row MUST roll back to `attempted` atomically too.
  currentNow = now + 121_000;
  f.setNow(currentNow);
  f.database.exec(`
    CREATE TRIGGER fail_cancel_on_expire
    BEFORE UPDATE OF state ON effects
    WHEN NEW.state = 'failed'
    BEGIN SELECT RAISE(ABORT, 'simulated_cancel_failure'); END;
  `);
  await f.publisher.flush();
  assert.equal(
    f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request'").get()!.state,
    "attempted",
    "domain expiry rolls back when atomic effect cancellation fails",
  );
  assert.equal(getEffect(f.database, activeBefore[0]!.id)?.state, "prepared");

  // Drop trigger: expiry commits atomically, cancels the prepared effect, and prunes terminal rows to the cap.
  f.database.exec("DROP TRIGGER fail_cancel_on_expire;");
  await f.publisher.flush();
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request'").get()!.state, "expired");
  assert.equal(getEffect(f.database, activeBefore[0]!.id)?.state, "failed");
  assert.equal(getEffect(f.database, "eff-appr-active-keep")?.state, "prepared", "unrelated active prepared effect is never pruned");
  assert.equal(getEffect(f.database, "eff-appr-old-0"), null, "oldest terminal approval effects are pruned");
  const terminalCount = Number((f.database.prepare(`
    SELECT COUNT(*) AS n FROM effects
    WHERE agent_id = 'agent' AND kind IN (?, ?) AND state IN ('completed', 'failed')
  `).get(EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, EXECUTION_APPROVAL_CLOSE_EFFECT_KIND) as { n: number }).n);
  assert.equal(terminalCount, EXECUTION_APPROVAL_RETAINED_TERMINAL_EFFECTS_PER_AGENT);
});

test("durable retry backoff survives restart, atomic attempt admission rolls back on insert failure, and future-epoch executing rows stay fenced", async t => {
  const f = fixture(t);
  let currentNow = now;
  f.setNow(currentNow);
  f.setDelegations([delegation(1)]);

  // 1. Failed effect INSERT rolls back `open -> attempted` atomically with zero HTTP.
  f.database.exec(`
    CREATE TRIGGER fail_approval_effect_insert
    BEFORE INSERT ON effects
    WHEN NEW.kind = '${EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND}'
    BEGIN SELECT RAISE(ABORT, 'simulated_insert_failure'); END;
  `);
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "open",
    "open -> attempted rolls back atomically when effect admission fails");
  assert.equal(listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND }).length, 0);
  assert.ok(f.diagnostics.includes("storage_unavailable"));
  f.database.exec("DROP TRIGGER fail_approval_effect_insert;");

  // 2. Durable 30s retry backoff survives restart at t + 5s without hammering offline API.
  f.options.publish = async (input) => { f.sent.push(input); throw new Error("offline PRIVATE_RAW"); };
  await f.publisher.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted");
  const [backedOff] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
  assert.equal(backedOff?.state, "prepared");
  assert.equal(backedOff?.next_attempt_at_ms, now + 30_000);

  const closeDatabase = t.mock.method(f.database, "close", () => {});
  f.publisher.close();
  currentNow = now + 5_000;
  f.setNow(currentNow);
  f.options.publish = async (input) => {
    f.sent.push(input);
    return { status: "acknowledged", publicationId: "pub-after-backoff", publicationDigest: sha("pub-after-backoff"), publishedAtMs: currentNow };
  };
  const restarted = new ExecutionApprovalPublisher(f.database, f.options);
  t.after(() => { restarted.close(); closeDatabase.mock.restore(); f.database.close(); });
  await restarted.flush();
  assert.equal(f.sent.length, 1, "durable backoff survives restart at t + 5s");

  // 3. Future-epoch executing row is never recovered or terminalized even past expiry.
  f.database.prepare(`
    UPDATE effects
    SET state = 'executing', epoch = 99, attempt_count = 2, next_attempt_at_ms = NULL
    WHERE id = ?
  `).run(backedOff!.id);
  currentNow = now + 125_000;
  f.setNow(currentNow);
  await restarted.flush();
  assert.equal(f.sent.length, 1, "future-epoch executing row is never replayed by stale generation");
  assert.equal(getEffect(f.database, backedOff!.id)?.state, "executing");
  assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "attempted",
    "future-epoch executing row is never locally terminalized");
  const allEffects = JSON.stringify(f.database.prepare("SELECT payload, outcome, last_error FROM effects").all());
  assert.doesNotMatch(allEffects, /PRIVATE_RAW|PRIVATE_GRANT|PRIVATE_WORKER|PRIVATE_SESSION/);
});

test("dispatch custody removed or replaced during EffectExecutor's final pre-settlement await never commits a stale receipt", async t => {
  type PublisherInternals = {
    pendingPublishSettlements: Map<string, unknown>;
    pendingCloseSettlements: Map<string, unknown>;
  };

  for (const mode of ["removed", "replaced"] as const) {
    await t.test(`publish — custody ${mode} during final pre-settlement await`, async t => {
      const f = fixture(t);
      let currentNow = now;
      f.setNow(currentNow);
      f.setDelegations([delegation(1)]);
      const internals = f.publisher as unknown as PublisherInternals;
      let intercepted = false;
      f.options.assertCurrent = async () => {
        if (!intercepted && internals.pendingPublishSettlements.size > 0) {
          intercepted = true;
          if (mode === "removed") {
            f.custody.deleteHostGrant("agent");
            f.custody.deleteWorkerAuthorization("agent");
          } else {
            f.custody.installHostGrant({ ...f.grant, grantId: "grant-rotated", grantGeneration: 2 });
            f.custody.installWorkerAuthorization({ ...f.worker, grantId: "grant-rotated", grantGeneration: 2 });
          }
        }
      };

      f.publisher.changed("agent");
      await f.publisher.flush();
      assert.equal(intercepted, true, "test must intercept EffectExecutor's pre-settlement assertAuthority await");
      assert.equal(f.sent.length, 1);
      assert.equal(
        f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state,
        "attempted",
        `stale publish receipt must not commit after custody is ${mode} before settlement`,
      );
      const [effect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND });
      assert.equal(effect?.state, "prepared");
      assert.equal(effect?.last_error, "authority_changed_before_settlement");

      // Reinstall valid custody (if removed) and verify reconciliation replays and commits cleanly.
      if (mode === "removed") {
        f.custody.installHostGrant(f.grant);
        f.custody.installWorkerAuthorization(f.worker);
      }
      await f.publisher.flush();
      assert.equal(f.sent.length, 2);
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
      assert.equal(getEffect(f.database, effect!.id)?.state, "completed");
    });

    await t.test(`close — custody ${mode} during final pre-settlement await`, async t => {
      const f = fixture(t);
      let currentNow = now;
      f.setNow(currentNow);
      f.setDelegations([delegation(1)]);
      f.publisher.changed("agent");
      await f.publisher.flush();
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");

      f.options.entries.getExecutionApproval = async () => {
        const base = admission().approval;
        return { ...base, request: { ...base.request, state: "superseded" as const } };
      };
      const internals = f.publisher as unknown as PublisherInternals;
      let intercepted = false;
      f.options.assertCurrent = async () => {
        if (!intercepted && internals.pendingCloseSettlements.size > 0) {
          intercepted = true;
          if (mode === "removed") {
            f.custody.deleteHostGrant("agent");
            f.custody.deleteWorkerAuthorization("agent");
          } else {
            f.custody.installHostGrant({ ...f.grant, grantId: "grant-rotated", grantGeneration: 2 });
            f.custody.installWorkerAuthorization({ ...f.worker, grantId: "grant-rotated", grantGeneration: 2 });
          }
        }
      };

      await f.publisher.flush();
      assert.equal(intercepted, true, "test must intercept EffectExecutor's pre-settlement assertAuthority await");
      assert.equal(f.closed.length, 1);
      assert.equal(
        f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state,
        "closing",
        `stale close receipt must not commit after custody is ${mode} before settlement`,
      );
      const [closeEffect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND });
      assert.equal(closeEffect?.state, "prepared");
      assert.equal(closeEffect?.last_error, "authority_changed_before_settlement");

      if (mode === "removed") {
        f.custody.installHostGrant(f.grant);
        f.custody.installWorkerAuthorization(f.worker);
      }
      await f.publisher.flush();
      assert.equal(f.closed.length, 2);
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "closed");
      assert.equal(getEffect(f.database, closeEffect!.id)?.state, "completed");
    });
  }

  await t.test("control — unchanged custody during final pre-settlement await commits publish and close normally", async t => {
    const f = fixture(t);
    f.setDelegations([delegation(1)]);
    const internals = f.publisher as unknown as PublisherInternals;
    let sawPublishPreSettle = false;
    let sawClosePreSettle = false;
    f.options.assertCurrent = async () => {
      if (internals.pendingPublishSettlements.size > 0) sawPublishPreSettle = true;
      if (internals.pendingCloseSettlements.size > 0) sawClosePreSettle = true;
    };

    f.publisher.changed("agent");
    await f.publisher.flush();
    assert.equal(sawPublishPreSettle, true);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");

    f.options.entries.getExecutionApproval = async () => {
      const base = admission().approval;
      return { ...base, request: { ...base.request, state: "superseded" as const } };
    };
    await f.publisher.flush();
    assert.equal(sawClosePreSettle, true);
    assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "closed");
  });
});

async function fullLifecycleFixture(t: TestContext, options?: { startImmediately?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "approval-lifecycle-"));
  const dbPath = join(dir, "daemon-state.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
  new DaemonStateSchema().createSchema(database);

  const manifestStore = new ManifestStore(dbPath);
  manifestStore.attachDatabase(database);
  const inboxStore = new SupervisedAgentInboxStore(dbPath);
  inboxStore.attachDatabase(database);
  const bindingStore = new WorkerBindingStore(dbPath, undefined, dbPath);
  bindingStore.attachDatabase(database);

  const custody = new WorkerRuntimeCustody();
  const grant: InstalledHostGrant = {
    entryId: "agent", roomId: "room", agentKey: "owner/agent", grantId: "grant",
    supervisorGrant: "PRIVATE_GRANT", grantGeneration: 1, apiUrl: "https://letagents.test", daemonGeneration: 1,
    hostId: "host", installationId: "installation", ownerAccountId: "owner", scopeKey: "owner",
    expiresAt: new Date(now + 180_000).toISOString(),
  };
  const worker: CachedWorkerAuthorization = {
    entryId: "agent", roomId: "room", agentKey: "owner/agent",
    workAttemptId: "attempt", grantId: "grant", grantGeneration: 1, daemonGeneration: 1,
    apiUrl: grant.apiUrl, agentSessionId: "session", bearer: "PRIVATE_WORKER", bearerId: "bearer",
    expiresAt: null, mintedAtMs: now - 1_000,
    agentSession: {
      session_id: "session", session_token: "PRIVATE_SESSION", room_id: "room", session_kind: "worker",
      runtime: "codex", actor_label: "Agent", agent_key: "owner/agent", agent_instance_id: "daemon:agent",
      display_name: "Agent", owner_label: "Owner", ide_label: "Desktop", created_at: "2026-08-31",
      updated_at: "2026-08-31", last_seen_at: "2026-08-31", ended_at: null,
    },
  };
  custody.installHostGrant(grant);
  custody.installWorkerAuthorization(worker);

  let currentNow = now;
  let closing = false;
  let delegations: LocalExecutionDelegation[] = [delegation(1)];
  let admissions: DelegatableApprovalAdmission[] = [admission()];
  const approvalsByRequest = new Map<string, ReturnType<typeof admission>["approval"]>([
    ["request", admission().approval],
  ]);
  const projectionsByRequest = new Map<string, ReturnType<typeof admission>["projection"]>([
    ["request", admission().projection],
  ]);
  const sent: unknown[] = [];
  const closed: unknown[] = [];

  const executor = new EffectExecutor({
    getDatabase: () => database,
    currentDaemonGeneration: () => 1,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    isClosing: () => closing,
    nowMs: () => currentNow,
    nowIso: () => new Date(currentNow).toISOString(),
  });

  const publisherOptions: ConstructorParameters<typeof ExecutionApprovalPublisher>[1] = {
    custody,
    approvals: { admitDelegatable: async () => admissions },
    entries: {
      getExecutionApproval: async (expected: { requestId: string }) => approvalsByRequest.get(expected.requestId) ?? null,
      listExecutionDelegationsForApprovalPublication: async () => delegations,
      readExecutionApprovalProjection: async (expected: { requestId: string }) => projectionsByRequest.get(expected.requestId) ?? null,
    },
    inbox: { get: async () => ({ inbox_item_id: "inbox", agent_id: "agent", room_id: "room", source_message_id: "msg_1" }) },
    authority: { validateExecutionDelegation: async () => delegations[0] ?? delegation(1) },
    daemonGeneration: () => 1,
    isClosing: () => closing,
    assertCurrent: async () => {},
    assertWriteFence: () => {},
    effectExecutor: executor,
    startImmediately: options?.startImmediately ?? false,
    now: () => currentNow,
    publish: async (input) => {
      sent.push(input);
      return { status: "acknowledged" as const, publicationId: "publication", publicationDigest: sha("publication"), publishedAtMs: now - 10_000 };
    },
    closePublication: async (input) => {
      closed.push(input);
      return { status: "closed" as const, closedAtMs: currentNow };
    },
    diagnostic: () => {},
  };
  const publisher = ExecutionApprovalPublisher.attach(database, publisherOptions);

  t.after(async () => {
    publisher.close();
    await manifestStore.close().catch(() => undefined);
    database.close();
    await removeTestDirectory(dir);
  });

  return {
    dbPath,
    database,
    manifestStore,
    inboxStore,
    bindingStore,
    custody,
    grant,
    worker,
    executor,
    publisher,
    publisherOptions,
    sent,
    closed,
    approvalsByRequest,
    projectionsByRequest,
    getNow: () => currentNow,
    setNow: (value: number) => { currentNow = value; },
    setClosing: (value: boolean) => { closing = value; },
    setDelegations: (value: LocalExecutionDelegation[]) => { delegations = value; },
    setAdmissions: (value: DelegatableApprovalAdmission[]) => { admissions = value; },
  };
}

test("real LifecycleAdministrationCoordinator purge retires refused approval publish and close retries, respects blockers and live executions, and prevents later uploads", async t => {
  for (const mode of ["publish", "close"] as const) {
    await t.test(`refused ${mode} -> stop -> retire -> purge -> 0 later uploads`, async t => {
      const f = await fullLifecycleFixture(t);
      await f.manifestStore.write([{
        id: "agent",
        room_id: "room",
        display_name: "Agent",
        provider: "codex",
        model: null,
        charter: "Handle approvals.",
        desired_state: "running",
        observed_state: "idle",
        condition: "none",
        permission_profile_id: null,
        delivery_mode: "daemon_inbox",
        created_by: "user-1",
        created_at: new Date(now).toISOString(),
        last_worker_binding: {
          agent_session_id: "session",
          work_attempt_id: "attempt",
          execution_generation_id: "execution",
          updated_at: new Date(now).toISOString(),
        },
      }]);

      const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
      const lifecycle = new LifecycleAdministrationCoordinator({
        store: f.manifestStore,
        bindings: f.bindingStore,
        durability: {
          getAttempt: async () => { throw new Error("unused"); },
          listAttempts: async () => [],
          recordTerminal: async () => {},
          releaseTerminalExecutionFence: async () => {},
          concludeAttempt: async () => { throw new Error("unused"); },
          garbageCollectEphemeralAttempt: async () => false,
        },
        authority: {
          currentDaemonGeneration: () => 1,
          assertCurrent: async () => {},
          fenceCommit: async (commit) => { await commit(); },
          serializeManifestMutation: async (operation) => operation(),
        },
        beginLifecycle: (entryId) => gate.beginLifecycle(entryId),
        serializeEntry: async (_entryId, operation) => operation(),
        setDesiredStateExclusive: async (entryId, desiredState) => {
          const loaded = await f.manifestStore.getEntryWithVersion(entryId);
          assert.ok(loaded);
          return (await f.manifestStore.replaceEntry(loaded.version, { ...loaded.entry, desired_state: desiredState, observed_state: "stopped" })).entry;
        },
        updateManifestEntry: async (entryId, update) => {
          const loaded = await f.manifestStore.getEntryWithVersion(entryId);
          assert.ok(loaded);
          return (await f.manifestStore.replaceEntry(loaded.version, update(loaded.entry))).entry;
        },
        entryWithDerivedLiveness: async (e) => ({ ...e, liveness: "stopped", inbox_summary: null, room_move: null } as never),
        stopDelivery: async () => {},
        hasLiveHandle: () => false,
        runtimeCustody: f.custody,
        deleteAgentStream: () => {},
        reconcileApprovalPublicationsForPurge: (entryId) => { f.publisher.recoverInactiveExecutingForAgent(entryId); },
        ephemeralProvisioner: { garbageCollectOrphans: async () => [] },
        nowMs: () => f.getNow(),
      });

      let releaseInFlight!: () => void;
      let inFlightStarted!: () => void;
      const inFlightRunning = new Promise<void>(resolve => { inFlightStarted = resolve; });
      const inFlightGate = new Promise<void>(resolve => { releaseInFlight = resolve; });

      if (mode === "publish") {
        f.publisherOptions.publish = async (input) => {
          f.sent.push(input);
          if (f.sent.length === 1) throw new Error("503 unavailable");
          inFlightStarted();
          await inFlightGate;
          throw new Error("503 unavailable");
        };
        f.publisher.changed("agent");
        await f.publisher.flush();
        assert.equal(f.sent.length, 1);
      } else {
        f.publisher.changed("agent");
        await f.publisher.flush();
        assert.equal(f.sent.length, 1);
        assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, "acknowledged");
        const resolvedApproval = {
          ...admission().approval,
          request: { ...admission().approval.request, state: "superseded" as const },
        };
        f.approvalsByRequest.set("request", resolvedApproval);
        f.publisherOptions.closePublication = async (input) => {
          f.closed.push(input);
          if (f.closed.length === 1) throw new Error("503 unavailable");
          inFlightStarted();
          await inFlightGate;
          throw new Error("503 unavailable");
        };
        await f.publisher.flush();
        assert.equal(f.closed.length, 1);
      }

      const kind = mode === "publish" ? EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND : EXECUTION_APPROVAL_CLOSE_EFFECT_KIND;
      const expectedPubState = mode === "publish" ? "attempted" : "closing";
      const [effect] = listEffectsForAgent(f.database, "agent", { kind, states: ["prepared"] });
      assert.ok(effect);
      const deadline = effect.next_attempt_at_ms!;
      assert.equal(deadline, now + 30_000);
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, expectedPubState);

      // 1. Stop + temporary missing authority preserves prepared retry and exact deadline across flush().
      const loadedRunning = await f.manifestStore.getEntryWithVersion("agent");
      assert.ok(loadedRunning);
      await f.manifestStore.replaceEntry(loadedRunning.version, {
        ...loadedRunning.entry,
        desired_state: "stopped",
        observed_state: "stopped",
      });
      f.custody.deleteHostGrant("agent");
      f.custody.deleteWorkerAuthorization("agent");
      f.setNow(now + 10_000);
      await f.publisher.flush();
      assert.equal(getEffect(f.database, effect.id)?.state, "prepared", "missing authority must preserve retry");
      assert.equal(getEffect(f.database, effect.id)?.next_attempt_at_ms, deadline);
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, expectedPubState);

      // 2. Unrelated prepared blocker blocks purge and rolls back approval effect + publication changes.
      seedBoundedMcpEffectRow(f.database, {
        id: "eff-unrelated-block",
        agent_id: "agent",
        room_id: "room",
        execution_generation_id: "gen-1",
        provider_turn_id: "turn-1",
        mcp_request_id: "req-mcp-1",
        tool_name: "send_message",
        request: {},
        mutation: true,
        state: "prepared",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      });
      const blockedByMcp = await lifecycle.purgeAgent("agent", 1, "session", false);
      assert.equal(blockedByMcp.outcome, "invalid");
      assert.match(blockedByMcp.error, /blocker/);
      assert.equal(getEffect(f.database, effect.id)?.state, "prepared", "failed purge must roll back approval retirement");
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, expectedPubState);
      f.database.prepare("DELETE FROM effects WHERE id='eff-unrelated-block'").run();

      // 3. Genuinely active in-flight executing upload strictly blocks purge even with reconcileApprovalPublicationsForPurge.
      f.custody.installHostGrant(f.grant);
      f.custody.installWorkerAuthorization(f.worker);
      f.setNow(deadline);
      const flushInFlight = f.publisher.flush();
      await inFlightRunning;
      assert.equal(getEffect(f.database, effect.id)?.state, "executing");
      assert.equal(f.executor.isEffectActive(effect.id), true);

      const blockedByActive = await lifecycle.purgeAgent("agent", 1, "session", false);
      assert.equal(blockedByActive.outcome, "invalid");
      assert.match(blockedByActive.error, /blocker/);
      assert.equal(getEffect(f.database, effect.id)?.state, "executing", "active executing upload must remain executing");
      assert.equal(f.database.prepare("SELECT state FROM execution_approval_publications").get()!.state, expectedPubState);

      // Let the in-flight attempt fail with 503 -> returns to prepared with a new +30s retry deadline.
      releaseInFlight();
      await flushInFlight;
      assert.equal(getEffect(f.database, effect.id)?.state, "prepared");
      const callsBeforePurge = mode === "publish" ? f.sent.length : f.closed.length;

      // 4. Authorized stop/retire/purge retires prepared effect, terminalizes+deletes publication, and succeeds.
      f.custody.deleteHostGrant("agent");
      f.custody.deleteWorkerAuthorization("agent");
      const purged = await lifecycle.purgeAgent("agent", 1, "session", false);
      assert.deepEqual(purged, { outcome: "purged" });
      assert.equal(await f.manifestStore.getEntry("agent"), undefined);
      assert.equal(Number((f.database.prepare("SELECT COUNT(*) AS n FROM effects WHERE agent_id='agent'").get() as { n: number }).n), 0);
      assert.equal(Number((f.database.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications WHERE agent_id='agent'").get() as { n: number }).n), 0);

      // 5. After purge, even if authority were re-installed and clock advances past retry deadline, 0 later uploads happen.
      f.custody.installHostGrant(f.grant);
      f.custody.installWorkerAuthorization(f.worker);
      f.publisherOptions.publish = async (input) => { f.sent.push(input); return { status: "acknowledged", publicationId: "p2", publicationDigest: sha("p2"), publishedAtMs: f.getNow() }; };
      f.publisherOptions.closePublication = async (input) => { f.closed.push(input); return { status: "closed", closedAtMs: f.getNow() }; };
      f.setNow(deadline + 60_000);
      await f.publisher.flush();
      assert.equal(mode === "publish" ? f.sent.length : f.closed.length, callsBeforePurge, "purged agent must never upload again");
    });
  }
});

test("real RoomMoveCoordinator rollback preserves approval publish and close retries across intermediate boundaries while terminal active move retires them", async t => {
  const f = await fullLifecycleFixture(t);
  await f.manifestStore.write([{
    id: "agent",
    room_id: "room",
    display_name: "Agent",
    provider: "codex",
    model: null,
    charter: "Handle approvals.",
    desired_state: "running",
    observed_state: "working",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "user-1",
    created_at: new Date(now).toISOString(),
    work_attempt_id: "attempt",
    provider_ref: {
      work_attempt_id: "attempt",
      provider_continuation_id: "continuation",
      provider_connection: null,
      execution_generation_id: "execution",
    },
    last_worker_binding: {
      agent_session_id: "session",
      work_attempt_id: "attempt",
      execution_generation_id: "execution",
      updated_at: new Date(now).toISOString(),
    },
  }]);
  await f.bindingStore.bind({
    entry_id: "agent",
    room_id: "room",
    work_attempt_id: "attempt",
    execution_generation_id: "execution",
    agent_session_id: "session",
    api_url: f.grant.apiUrl,
    agent_session_token: "source-bearer",
  });

  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  const coordinator = new RoomMoveCoordinator({
    store: f.manifestStore,
    inbox: f.inboxStore,
    bindings: f.bindingStore,
    runtimeCustody: f.custody,
    deliveryHttp: {
      joinRoom: async ({ roomId }) => ({ roomId }),
      latest: async () => ({ messages: [{ id: "msg_99" }] }),
    },
    authority: {
      currentGeneration: () => 1,
      isHandoffScheduled: () => false,
      assertCurrent: async () => {},
      ownsDaemonGeneration: async (gen) => gen === 1,
      fenceCommit: async (commit) => { await commit(); },
    },
    entryConcurrency: gate,
    serializeEntry: async (_entryId, operation) => operation(),
    updateManifestEntry: async (entryId, update) => {
      const loaded = await f.manifestStore.getEntryWithVersion(entryId);
      assert.ok(loaded);
      return (await f.manifestStore.replaceEntry(loaded.version, update(loaded.entry))).entry;
    },
    currentHandle: () => ({
      workAttemptId: "attempt",
      providerContinuationId: "continuation",
      providerConnection: null,
      executionGenerationId: "execution",
    } as never),
    pauseIngress: () => {},
    restartDelivery: async () => {},
    scheduleRecovery: () => {},
    nowIso: () => new Date(f.getNow()).toISOString(),
  });

  // Seed two approvals: req-1 reaches closing+503 retry, req-2 reaches attempted+503 retry.
  const adm1 = admission();
  const adm2Base = admission();
  const adm2: DelegatableApprovalAdmission = {
    ...adm2Base,
    approval: {
      ...adm2Base.approval,
      request: { ...adm2Base.approval.request, requestId: "request-2", requestSha256: sha("request-2") },
    },
    projection: { ...adm2Base.projection, requestId: "request-2", requestSha256: sha("request-2") },
  };
  f.approvalsByRequest.set("request", adm1.approval);
  f.projectionsByRequest.set("request", adm1.projection);
  f.approvalsByRequest.set("request-2", adm2.approval);
  f.projectionsByRequest.set("request-2", adm2.projection);

  // Publish request-1 successfully first so it becomes acknowledged, then resolve it so close enters retry.
  f.setAdmissions([adm1]);
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 1);

  f.approvalsByRequest.set("request", {
    ...adm1.approval,
    request: { ...adm1.approval.request, state: "superseded" as const },
  });
  f.setAdmissions([adm2]);
  f.publisherOptions.publish = async (input) => { f.sent.push(input); throw new Error("503 unavailable"); };
  f.publisherOptions.closePublication = async (input) => { f.closed.push(input); throw new Error("503 unavailable"); };
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(f.closed.length, 1);

  const [pubEffect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, states: ["prepared"] });
  const [closeEffect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND, states: ["prepared"] });
  assert.ok(pubEffect && closeEffect);
  const deadline = now + 30_000;
  assert.equal(pubEffect.next_attempt_at_ms, deadline);
  assert.equal(closeEffect.next_attempt_at_ms, deadline);

  // Boundary 1: rotating_credentials (agents.room_id='room-2') + missing custody -> both retries & publications survive.
  const preparedMove = await coordinator.prepareInspector({
    entryId: "agent", destinationRoomId: "room-2", requestId: "ap-rb-1", daemonGeneration: 1,
  });
  const rotatingMove = await coordinator.commitInspector({
    operationId: preparedMove.operation_id, entryId: "agent", daemonGeneration: 1,
  });
  assert.equal(rotatingMove.phase, "rotating_credentials");
  assert.equal((await f.manifestStore.getEntry("agent"))?.room_id, "room-2");
  f.custody.deleteHostGrant("agent");
  f.custody.deleteWorkerAuthorization("agent");
  f.setNow(now + 2_000);
  await f.publisher.flush();
  assert.equal(getEffect(f.database, pubEffect.id)?.state, "prepared");
  assert.equal(getEffect(f.database, pubEffect.id)?.next_attempt_at_ms, deadline);
  assert.equal(getEffect(f.database, closeEffect.id)?.state, "prepared");
  assert.equal(getEffect(f.database, closeEffect.id)?.next_attempt_at_ms, deadline);

  // Direct atomic-guard test: retireObsoleteExecutionApprovalEffects skips requireNoPendingRoomMove while move is non-terminal.
  const skippedAtomic = retireObsoleteExecutionApprovalEffects(f.database, () => {}, {
    agentId: "agent",
    expectedEpoch: 1,
    retirements: [
      { id: pubEffect.id, error: "room_moved", requireNoPendingRoomMove: true },
      { id: closeEffect.id, error: "room_moved", requireNoPendingRoomMove: true },
    ],
    nowIso: new Date(f.getNow()).toISOString(),
  });
  assert.deepEqual(skippedAtomic, []);
  assert.equal(getEffect(f.database, pubEffect.id)?.state, "prepared");
  assert.equal(getEffect(f.database, closeEffect.id)?.state, "prepared");

  // Boundary 2: rollback_required restores agents.room_id='room' while destination custody is still live -> both survive.
  const rollbackMove = await coordinator.rollbackInspector({
    operationId: rotatingMove.operation_id, entryId: "agent", daemonGeneration: 1, detail: "destination mint failed",
  });
  assert.equal(rollbackMove.phase, "rollback_required");
  assert.equal((await f.manifestStore.getEntry("agent"))?.room_id, "room");
  f.custody.installHostGrant({ ...f.grant, roomId: "room-2" });
  f.custody.installWorkerAuthorization({
    ...f.worker,
    roomId: "room-2",
    agentSession: { ...f.worker.agentSession!, room_id: "room-2" },
  });
  f.setNow(now + 4_000);
  await f.publisher.flush();
  assert.equal(getEffect(f.database, pubEffect.id)?.state, "prepared", "publish retry survives rollback_required with live dest custody");
  assert.equal(getEffect(f.database, closeEffect.id)?.state, "prepared", "close retry survives rollback_required with live dest custody");
  assert.equal(
    (f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request-2'").get() as { state: string }).state,
    "attempted",
  );
  assert.equal(
    (f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request'").get() as { state: string }).state,
    "closing",
  );

  // Compensation completes (`failed`) -> restore source custody -> both publish and close succeed at deadline!
  const failedMove = await coordinator.commitInspector({
    operationId: rollbackMove.operation_id, entryId: "agent", daemonGeneration: 1,
  });
  assert.equal(failedMove.phase, "failed");
  f.custody.installHostGrant(f.grant);
  f.custody.installWorkerAuthorization(f.worker);
  f.publisherOptions.publish = async (input) => {
    f.sent.push(input);
    return { status: "acknowledged", publicationId: "pub-2", publicationDigest: sha("pub-2"), publishedAtMs: f.getNow() };
  };
  f.publisherOptions.closePublication = async (input) => {
    f.closed.push(input);
    return { status: "closed", closedAtMs: f.getNow() };
  };
  f.setNow(deadline);
  await f.publisher.flush();
  assert.equal(f.sent.length, 3, "publish retry succeeds after room-move rollback");
  assert.equal(f.closed.length, 2, "close retry succeeds after room-move rollback");
  assert.equal(getEffect(f.database, pubEffect.id)?.state, "completed");
  assert.equal(getEffect(f.database, closeEffect.id)?.state, "completed");
  assert.equal(
    (f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request-2'").get() as { state: string }).state,
    "acknowledged",
  );
  assert.equal(
    (f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request'").get() as { state: string }).state,
    "closed",
  );

  // Terminal `active` room move atomically retires source-room approval retries and invalidates source-room publications.
  f.approvalsByRequest.set("request-2", {
    ...adm2.approval,
    request: { ...adm2.approval.request, state: "superseded" as const },
  });
  f.publisherOptions.closePublication = async (input) => { f.closed.push(input); throw new Error("503 unavailable"); };
  await f.publisher.flush();
  const [closeMove2] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND, states: ["prepared"] });
  assert.ok(closeMove2);

  const okPrepared = await coordinator.prepareInspector({
    entryId: "agent", destinationRoomId: "room-2", requestId: "ap-ok-1", daemonGeneration: 1,
  });
  const okRotating = await coordinator.commitInspector({
    operationId: okPrepared.operation_id, entryId: "agent", daemonGeneration: 1,
  });
  await coordinator.acknowledgeSourceRevocation({
    operationId: okRotating.operation_id, entryId: "agent", daemonGeneration: 1, sourceAgentSessionId: "session",
  });
  f.custody.installHostGrant({ ...f.grant, roomId: "room-2" });
  await f.bindingStore.bind({
    entry_id: "agent",
    room_id: "room-2",
    work_attempt_id: "attempt",
    execution_generation_id: "execution",
    agent_session_id: "session-dest",
    api_url: f.grant.apiUrl,
    agent_session_token: "dest-bearer",
  });
  const activeMove = await coordinator.commitInspector({
    operationId: okRotating.operation_id, entryId: "agent", daemonGeneration: 1,
  });
  assert.equal(activeMove.phase, "active");
  assert.equal(getEffect(f.database, closeMove2.id)?.state, "failed");
  assert.equal(getEffect(f.database, closeMove2.id)?.last_error, "room_moved");
  assert.equal(
    (f.database.prepare("SELECT state FROM execution_approval_publications WHERE request_id='request-2'").get() as { state: string }).state,
    "invalid",
  );
});

test("downgrade/reupgrade stranded prepared approval effects, recoverInactiveExecutingForAgent, and startImmediately=false", async t => {
  const f = await fullLifecycleFixture(t, { startImmediately: false });
  assert.equal((f.publisher as unknown as { scheduled: unknown }).scheduled, null, "startImmediately=false must not arm timer before start()");

  // 1. Seed a publication that an older build (.17) already closed directly while a prepared effect stayed in effects.
  f.setDelegations([delegation(1)]);
  f.publisherOptions.publish = async (input) => { f.sent.push(input); throw new Error("503 unavailable"); };
  f.publisher.changed("agent");
  await f.publisher.flush();
  assert.equal(f.sent.length, 1);
  const [pubEffect] = listEffectsForAgent(f.database, "agent", { kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, states: ["prepared"] });
  assert.ok(pubEffect);

  // Older build acknowledges and closes the publication row without touching effects.
  f.database.prepare(`
    UPDATE execution_approval_publications
    SET state='acknowledged', publication_id='pub-old', publication_digest=?, published_at_ms=?
    WHERE agent_id='agent' AND request_id='request'
  `).run(sha("pub-old"), now + 100);
  f.database.prepare("UPDATE execution_approval_publications SET state='closing' WHERE agent_id='agent' AND request_id='request'").run();
  f.database.prepare("UPDATE execution_approval_publications SET state='closed', closed_at_ms=? WHERE agent_id='agent' AND request_id='request'").run(now + 200);

  // Even though no open execution_approval_publications rows remain, flush() discovers 'agent' via effects UNION and retires the stranded row with 0 HTTP calls.
  f.publisherOptions.publish = async (input) => { f.sent.push(input); return { status: "acknowledged", publicationId: "dup", publicationDigest: sha("dup"), publishedAtMs: now }; };
  await f.publisher.flush();
  assert.equal(f.sent.length, 1, "downgrade/reupgrade must not send a duplicate upload");
  assert.equal(getEffect(f.database, pubEffect.id)?.state, "failed");
  assert.equal(getEffect(f.database, pubEffect.id)?.last_error, "publication_closed");

  // 2. recoverInactiveExecutingForAgent recovers an orphaned executing row while leaving genuinely active executing rows untouched.
  f.database.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-orphan-exec', 'agent', ?, 'eap:v1:orphan-exec', 1, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
    JSON.stringify({
      room_id: "room", delegation_instance_id: "delegation-1", delegation_revision: 1,
      request_id: "request", request_version: 1, projection_sha256: projectionSha256,
    }),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  assert.equal(f.publisher.recoverInactiveExecutingForAgent("agent"), 1);
  assert.equal(getEffect(f.database, "eff-orphan-exec")?.state, "prepared");
  assert.equal(getEffect(f.database, "eff-orphan-exec")?.last_error, "recovered_inactive_executing_effect");

  // 3. start() arms the timer once startup recovery completes.
  f.publisher.start();
  assert.notEqual((f.publisher as unknown as { scheduled: unknown }).scheduled, null);
});
