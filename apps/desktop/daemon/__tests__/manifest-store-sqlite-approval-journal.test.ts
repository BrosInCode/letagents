import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonProviderConnection } from "../types.js";
import type { AdmitExecutionApproval, ApprovalAuthority } from "../execution-approval-journal.js";
import type { ExecutionApprovalAdmissionPlan } from "../execution-approval-admission.js";
import { executionRuntimeStorageIdentity, executionStorageIdentity, ExecutionShadowStore } from "../execution-shadow-store.js";
import {
  seedApprovalJournalTurn,
  admitApproval,
  approvalJournalRequest,
  fixture,
} from "./helpers/manifest-store-sqlite-fixture.js";

test("approval journal versions preserve typed native identity and only supersede undispatched requests", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest();
    const first = await admitApproval(store, input, authority, async commit => commit());
    assert.equal(first.created, true);
    assert.deepEqual(await admitApproval(store, input, authority, async commit => commit()), { ...first, created: false });
    await assert.rejects(admitApproval(store, { ...input, requestSha256: "b".repeat(64) }, authority, async commit => commit()), { code: "identity_mismatch" });
    await assert.rejects(admitApproval(store, { ...input, requestId: "alias" }, authority, async commit => commit()), { code: "identity_mismatch" });
    const typed = approvalJournalRequest("string-request", "1");
    assert.equal((await admitApproval(store, typed.input, authority, async commit => commit())).approval.request.nativeRequestId, "1");
    assert.equal((await store.getExecutionApproval(expected))!.request.nativeRequestId, 1);
    await assert.rejects(admitApproval(store, { ...input, requestId: "skipped-first", nativeRequestId: 3, requestVersion: 2 }, authority, async commit => commit()), { code: "invalid_transition" });
    await store.selectHostApproval({ authority, expected, decisionId: "decision", actorId: "owner", decision: "allow_once", projectionSha256: "c".repeat(64), atMs: 110 }, async commit => commit());
    for (const change of [{ requestVersion: 2 }, { requestVersion: 3, requestSha256: "b".repeat(64) }]) {
      await assert.rejects(admitApproval(store, { ...input, ...change }, authority, async commit => commit()), { code: "invalid_transition" });
    }
    const next = { ...input, requestVersion: 2, requestSha256: "b".repeat(64), createdAtMs: 120 };
    const nextReference = { ...expected, requestVersion: 2, requestSha256: next.requestSha256 };
    assert.equal((await admitApproval(store, next, authority, async commit => commit())).created, true);
    const superseded = await store.getExecutionApproval(expected);
    assert.equal(superseded!.request.state, "superseded");
    assert.equal(superseded!.decision!.dispatchState, "lost");
    assert.equal(superseded!.decision!.applicationCertainty, "impossible");
    assert.deepEqual((await admitApproval(store, input, authority, async commit => commit())).approval, superseded, "old receipt never reopens the request");
    await assert.rejects(store.beginExecutionApprovalDispatch({ authority, expected, decisionId: "decision", dispatchId: "old-dispatch", projectionSha256: "c".repeat(64), atMs: 125 }, async commit => commit()), { code: "invalid_transition" });
    await store.selectHostApproval({ authority, expected: nextReference, decisionId: "next-decision", actorId: "owner", decision: "deny", projectionSha256: "d".repeat(64), atMs: 130 }, async commit => commit());
    assert.equal((await store.beginExecutionApprovalDispatch({ authority, expected: nextReference, decisionId: "next-decision", dispatchId: "dispatch", projectionSha256: "d".repeat(64), atMs: 140 }, async commit => commit())).dispatch, true);
    await assert.rejects(admitApproval(store, { ...next, requestVersion: 3, requestSha256: "e".repeat(64), createdAtMs: 150 }, authority, async commit => commit()), { code: "invalid_transition" });
    await assert.rejects(admitApproval(store, { ...input, requestId: "aliased-version", requestVersion: 2 }, authority, async commit => commit()), { code: "identity_mismatch" });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 3);
    assert.equal((await store.listExecutionApprovals("room")).length, 2, "superseded versions are not duplicate cards");
    assert.deepEqual((await store.listExecutionApprovals("room", 1)).map(value => [value.request.requestId, value.request.requestVersion]), [["request", 2]]);
    assert.deepEqual(await store.listExecutionApprovals("other-room"), []);
    await assert.rejects(store.listExecutionApprovals("room", 65), { code: "invalid_input" });
    const inbox = new SupervisedAgentInboxStore(env.databasePath, () => new Date(160).toISOString());
    let nextAuthority: ApprovalAuthority;
    try {
      await inbox.checkpointNormalizedTerminal({ inbox_item_id: authority.inboxItemId, agent_id: "agent", execution_generation_id: "generation",
        provider_turn_id: "native-turn", outcome: "no_reply", text: null, evidence: "stream", terminal_evidence: {} });
      await inbox.transition(authority.inboxItemId, "awaiting_result");
      await inbox.transition(authority.inboxItemId, "acknowledged_no_reply");
      const nextItem = await inbox.enqueueInitialMessage({ agent_id: "agent", room_id: "room", source_message_id: "next-message",
        source_message: { id: "next-message" }, activation: { kind: "deliver", reason: "direct_mention" } });
      await inbox.claimHead("agent");
      await inbox.checkpointTurnStarted(nextItem.inbox_item_id, "next-native-turn", { work_attempt_id: "workspace",
        origin_execution_generation_id: "generation", provider_continuation_id: "continuation" });
      nextAuthority = { ...authority, inboxItemId: nextItem.inbox_item_id };
    } finally { await inbox.close(); }
    const reused = { ...input, requestId: "next-request", turnId: executionStorageIdentity("turn", "agent", "continuation", "next-native-turn"), providerTurnId: "next-native-turn", createdAtMs: 160 };
    await assert.rejects(admitApproval(store, reused, nextAuthority!, async commit => commit()), { code: "identity_mismatch" },
      "native ID reuse across proven turns is refused, never adopted as the old occurrence");
    assert.equal(await store.getExecutionApproval({ ...expected, requestId: reused.requestId, turnId: reused.turnId, providerTurnId: reused.providerTurnId }), null);
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal rejects mismatched exact turns and content-bearing or delegated inputs", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest();
    for (const key of ["agentId", "roomId", "providerContinuationId", "providerTurnId"] as const) {
      await assert.rejects(admitApproval(store, { ...input, [key]: "other" }, authority, async commit => commit()), { code: "missing_turn" });
    }
    for (const extra of [{ command: "PRIVATE-CONTENT-NEVER-PERSIST" }, { reason: "PRIVATE-CONTENT-NEVER-PERSIST" }, { delegatable: true }, { kind: "question" }, { token: "PRIVATE-CONTENT-NEVER-PERSIST" }]) {
      await assert.rejects(admitApproval(store, { ...input, ...extra } as AdmitExecutionApproval, authority, async commit => commit()), (error: Error) => {
        assert.match(error.message, /invalid_input/); assert.doesNotMatch(error.message, /PRIVATE-CONTENT/); return true;
      });
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
    await admitApproval(store, input, authority, async commit => commit());
    for (const change of [
      ...["agentId", "roomId", "executionGenerationId", "runtimeGenerationId", "turnId", "providerContinuationId", "providerTurnId", "connectionId"].map(key => ({ [key]: "other" })),
      { nativeRequestId: "1" }, { requestSha256: "b".repeat(64) },
    ]) {
      const wrong = { ...expected, ...change };
      await assert.rejects(store.getExecutionApproval(wrong), { code: "identity_mismatch" });
      await assert.rejects(store.selectHostApproval({ authority, expected: wrong, decisionId: "decision", actorId: "owner", decision: "deny", projectionSha256: "c".repeat(64), atMs: 110 }, async commit => commit()), { code: "identity_mismatch" });
    }
    database.exec("UPDATE supervised_agent_inbox SET outcome='{}'");
    await assert.rejects(store.selectHostApproval({ authority, expected, decisionId: "decision", actorId: "owner", decision: "deny", projectionSha256: "c".repeat(64), atMs: 120 }, async commit => commit()), { code: "missing_turn" });
    assert.equal((await store.getExecutionApproval(expected))!.decision, null);
    assert.equal(database.prepare("SELECT delegatable FROM execution_approval_requests").get()!.delegatable, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()!.n, 0, "journal does not fabricate provider evidence");
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal admits one host decision and binds immutable presentation evidence", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath); const other = new ManifestStore(env.databasePath);
  await store.load(); await other.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest(); await admitApproval(store, input, authority, async commit => commit());
    const selection = { authority, expected, decisionId: "allow", actorId: "owner", decision: "allow_once" as const, projectionSha256: "b".repeat(64), atMs: 110 };
    await assert.rejects(store.selectHostApproval({ ...selection, source: "delegate" } as typeof selection, async commit => commit()), { code: "invalid_input" });
    for (const projectionSha256 of [undefined, null, "short", "G".repeat(64)]) {
      await assert.rejects(store.selectHostApproval({ ...selection, projectionSha256: projectionSha256 as string }, async commit => commit()), { code: "invalid_input" });
    }
    const choices = [selection, { ...selection, decisionId: "deny", actorId: "other-owner", decision: "deny" as const }];
    const competing = await Promise.allSettled([store.selectHostApproval(choices[0]!, async commit => commit()), other.selectHostApproval(choices[1]!, async commit => commit())]);
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter(result => result.status === "rejected" && result.reason.code === "decision_conflict").length, 1);
    const winner = choices[competing.findIndex(result => result.status === "fulfilled")]!;
    const chosen = await store.getExecutionApproval(expected);
    assert.deepEqual(await store.selectHostApproval(winner, async commit => commit()), chosen);
    await assert.rejects(store.selectHostApproval({ ...winner, projectionSha256: "c".repeat(64) }, async commit => commit()), { code: "decision_conflict" });
    assert.throws(() => database.exec("UPDATE execution_approval_decisions SET projection_sha256=NULL"), /immutable/);
    const dispatch = { authority, expected, decisionId: winner.decisionId, dispatchId: "dispatch", projectionSha256: "c".repeat(64), atMs: 120 };
    await assert.rejects(store.beginExecutionApprovalDispatch(dispatch, async commit => commit()), { code: "identity_mismatch" });
    assert.deepEqual(await store.getExecutionApproval(expected), chosen);
    const historical = approvalJournalRequest("historical", 2); await admitApproval(store, historical.input, authority, async commit => commit());
    database.exec(`INSERT INTO execution_approval_decisions(decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,
      turn_id,request_delegatable,request_sha256,decision,source,actor_id,dispatch_state,decided_at_ms)
      SELECT 'historical-decision',request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,0,request_sha256,
        'deny','host','owner','not_dispatched',110 FROM execution_approval_requests WHERE request_id='historical';
      UPDATE execution_approval_requests SET state='decision_recorded' WHERE request_id='historical'`);
    await assert.rejects(store.beginExecutionApprovalDispatch({ ...dispatch, expected: historical.expected, decisionId: "historical-decision" }, async commit => commit()), { code: "identity_mismatch" });
    assert.equal((await store.getExecutionApproval(historical.expected))!.decision!.projectionSha256, null);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions WHERE source='host' AND request_delegatable=0").get()!.n, 2);
  } finally { database.close(); await other.close(); await store.close(); await env.cleanup(); }
});

test("approval journal requires ownership fences and rolls back both tables without rewriting the manifest", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest();
    const selection = { authority, expected, decisionId: "decision", actorId: "owner", decision: "allow_once" as const, projectionSha256: "b".repeat(64), atMs: 110 };
    const dispatch = { authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: selection.projectionSha256, atMs: 120 };
    for (const operation of [
      () => admitApproval(store, input, authority, undefined as never), () => store.selectHostApproval(selection, undefined as never),
      () => store.beginExecutionApprovalDispatch(dispatch, undefined as never),
      () => store.recordExecutionApprovalOutcome({ expected, decisionId: "decision", dispatchId: "dispatch", evidence: "dispatch_uncertain", atMs: 125 }, undefined as never),
      () => store.loseExecutionApproval({ expected, atMs: 130 }, undefined as never),
    ]) await assert.rejects(operation(), /ownership commit fence/);
    await assert.rejects(admitApproval(store, input, authority, async () => {}), /without committing/);
    assert.equal(await store.getExecutionApproval(expected), null);
    await admitApproval(store, input, authority, async commit => commit());
    database.exec("CREATE TRIGGER fail_approval_request AFTER UPDATE ON execution_approval_requests BEGIN SELECT RAISE(ABORT,'approval rollback'); END");
    await assert.rejects(store.selectHostApproval(selection, async commit => commit()), /approval rollback/);
    assert.equal((await store.getExecutionApproval(expected))!.request.state, "requested");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 0);
    database.exec("DROP TRIGGER fail_approval_request");
    const decided = await store.selectHostApproval(selection, async commit => commit());
    database.exec("CREATE TRIGGER fail_approval_request AFTER UPDATE ON execution_approval_requests BEGIN SELECT RAISE(ABORT,'approval rollback'); END");
    await assert.rejects(store.beginExecutionApprovalDispatch(dispatch, async commit => commit()), /approval rollback/);
    await assert.rejects(store.loseExecutionApproval({ expected, atMs: 125 }, async commit => commit()), /approval rollback/);
    await assert.rejects(admitApproval(store, { ...input, requestVersion: 2, requestSha256: "c".repeat(64), createdAtMs: 125 }, authority, async commit => commit()), /approval rollback/);
    assert.deepEqual(await store.getExecutionApproval(expected), decided);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 1);
    database.exec("DROP TRIGGER fail_approval_request");
    assert.equal((await store.beginExecutionApprovalDispatch(dispatch, async commit => commit())).dispatch, true);

    const workspace = join(env.root, "approval-workspace");
    await mkdir(workspace);
    database.prepare("UPDATE work_attempts SET workspace_path=? WHERE work_attempt_id=?")
      .run(workspace, authority.workAttemptId);
    const source = { request: { id: 2 }, changes: [
      { path: "src/new.ts", kind: { type: "add" as const }, diff: "+export const value = 1;\n" },
    ] };
    const requestSha256 = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const projected = approvalJournalRequest("projected", 2);
    const projectedExpected = { ...projected.expected, requestSha256 };
    const { executionGenerationId: _generation, runtimeGenerationId: _runtime, turnId: _turn, ...projectedRequest } = {
      ...projected.input, ...projectedExpected, kind: "file_change" as const, risk: "low" as const,
    };
    const projection = await store.prepareExecutionApprovalProjection(
      { requestSha256, workAttemptId: authority.workAttemptId }, source,
    );
    database.exec("CREATE TRIGGER fail_approval_projection BEFORE INSERT ON execution_approval_projections BEGIN SELECT RAISE(ABORT,'projection rollback'); END");
    await assert.rejects(store.admitExecutionApprovalPlan({
      classification: "delegatable_file_change", request: projectedRequest, authority, projection,
    }, () => 110, async commit => commit()), /projection rollback/);
    assert.equal(await store.getExecutionApproval(projectedExpected), null,
      "projection failure rolls back the request classification in the same transaction");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 0);
    database.exec("DROP TRIGGER fail_approval_projection");
    assert.equal((await store.load()).generation, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("delegatable approval admission rejects OpenCode below the broker boundary", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database, "open-model");
    const workspace = join(env.root, "opencode-approval-workspace");
    await mkdir(workspace);
    database.prepare("UPDATE work_attempts SET workspace_path=? WHERE work_attempt_id=?")
      .run(workspace, authority.workAttemptId);
    const source = { request: { id: 3 }, changes: [
      { path: "src/new.ts", kind: { type: "add" as const }, diff: "+export const value = 1;\n" },
    ] };
    const requestSha256 = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const request = approvalJournalRequest("opencode-projected", 3, "open-model");
    const { executionGenerationId: _generation, runtimeGenerationId: _runtime, turnId: _turn, ...admissionRequest } = {
      ...request.input, ...request.expected, requestSha256, kind: "file_change" as const, risk: "low" as const,
    };
    const projection = await store.prepareExecutionApprovalProjection(
      { requestSha256, workAttemptId: authority.workAttemptId }, source,
    );
    const invalidPlan = {
      classification: "delegatable_file_change", request: admissionRequest, authority, projection,
    } as unknown as ExecutionApprovalAdmissionPlan;
    await assert.rejects(store.admitExecutionApprovalPlan(
      invalidPlan, () => 110, async commit => commit(),
    ), { code: "invalid_input" });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 0);
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal restart never grants another dispatch permit or treats a Codex send as acknowledgement", async () => {
  const env = await fixture(); let store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest(); await admitApproval(store, input, authority, async commit => commit());
    const selection = { authority, expected, decisionId: "decision", actorId: "owner", decision: "allow_once" as const, projectionSha256: "b".repeat(64), atMs: 110 };
    await store.selectHostApproval(selection, async commit => commit());
    const dispatch = { authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: selection.projectionSha256, atMs: 120 };
    await assert.rejects(store.beginExecutionApprovalDispatch(dispatch, async commit => {
      await commit(); throw new Error("dispatch receipt response lost");
    }), /dispatch receipt response lost/);
    assert.equal((await store.getExecutionApproval(expected))!.decision!.dispatchState, "dispatching",
      "a failure after commit preserves intent; retry must not grant a second dispatch");
    const outcome = { expected, decisionId: "decision", dispatchId: "dispatch", atMs: 130 };
    for (const evidence of [null, "sent_unacknowledged", "dispatch_uncertain"] as const) {
      if (evidence) await store.recordExecutionApprovalOutcome({ ...outcome, evidence }, async commit => commit());
      const before = await store.getExecutionApproval(expected);
      await store.close(); store = new ManifestStore(env.databasePath);
      assert.deepEqual(await store.getExecutionApproval(expected), before);
      assert.deepEqual(await store.beginExecutionApprovalDispatch(dispatch, async commit => commit()), { dispatch: false, approval: before });
      await assert.rejects(store.beginExecutionApprovalDispatch({ ...dispatch, dispatchId: "retry" }, async commit => commit()), { code: "decision_conflict" });
      await assert.rejects(store.recordExecutionApprovalOutcome({ ...outcome, evidence: "native_processed" }, async commit => commit()), { code: "invalid_transition" });
      assert.deepEqual((await admitApproval(store, input, authority, async commit => commit())).approval, before);
      assert.deepEqual(await store.selectHostApproval(selection, async commit => commit()), before);
    }
    const lost = await store.loseExecutionApproval({ expected, atMs: 140 }, async commit => commit());
    assert.equal(lost.request.state, "lost"); assert.equal(lost.request.applicationCertainty, "unknown");
    assert.equal(lost.decision!.dispatchState, "lost"); assert.equal(lost.decision!.applicationCertainty, "unknown");
    assert.equal((await store.beginExecutionApprovalDispatch(dispatch, async commit => commit())).dispatch, false);
    await assert.rejects(store.recordExecutionApprovalOutcome({ ...outcome, evidence: "sent_unacknowledged", atMs: 150 }, async commit => commit()), { code: "invalid_transition" });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 1);
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal accepts exact OpenCode processing evidence without deciding sibling permissions", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database, "open-model");
    const { input, expected } = approvalJournalRequest("request", 1, "open-model"); await admitApproval(store, input, authority, async commit => commit());
    const sibling = approvalJournalRequest("sibling", 2, "open-model"); await admitApproval(store, sibling.input, authority, async commit => commit());
    const untouched = await store.getExecutionApproval(sibling.expected);
    const dispatch = { authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: "b".repeat(64), atMs: 120 };
    await store.selectHostApproval({ authority, expected, decisionId: "decision", actorId: "owner", decision: "deny", projectionSha256: dispatch.projectionSha256, atMs: 110 }, async commit => commit());
    await store.beginExecutionApprovalDispatch(dispatch, async commit => commit());
    const outcome = { expected, decisionId: "decision", dispatchId: "dispatch", atMs: 130 };
    await store.recordExecutionApprovalOutcome({ ...outcome, evidence: "dispatch_uncertain" }, async commit => commit());
    const uncertain = await store.getExecutionApproval(expected);
    database.exec("CREATE TRIGGER fail_approval_resolution AFTER UPDATE ON execution_approval_requests BEGIN SELECT RAISE(ABORT,'acknowledgement rollback'); END");
    await assert.rejects(store.recordExecutionApprovalOutcome({ ...outcome, evidence: "native_processed" }, async commit => commit()), /acknowledgement rollback/);
    assert.deepEqual(await store.getExecutionApproval(expected), uncertain);
    database.exec("DROP TRIGGER fail_approval_resolution");
    for (const change of [{ decisionId: "other" }, { dispatchId: "other" }, { expected: sibling.expected }]) {
      await assert.rejects(store.recordExecutionApprovalOutcome({ ...outcome, ...change, evidence: "native_processed" }, async commit => commit()), { code: "identity_mismatch" });
    }
    const resolved = await store.recordExecutionApprovalOutcome({ ...outcome, evidence: "native_processed" }, async commit => commit());
    assert.equal(resolved.request.state, "resolved"); assert.equal(resolved.decision!.dispatchState, "acknowledged");
    assert.deepEqual(await store.recordExecutionApprovalOutcome({ ...outcome, evidence: "native_processed" }, async commit => commit()), resolved);
    assert.deepEqual(await store.getExecutionApproval(sibling.expected), untouched, "session-wide reject cannot fabricate sibling acknowledgement or loss");
    await assert.rejects(store.loseExecutionApproval({ expected, atMs: 140 }, async commit => commit()), { code: "invalid_transition" });
    await assert.rejects(store.recordExecutionApprovalOutcome({ ...outcome, evidence: "dispatch_uncertain", atMs: 140 }, async commit => commit()), { code: "invalid_transition" });
    assert.equal((await store.beginExecutionApprovalDispatch(dispatch, async commit => commit())).dispatch, false);
    assert.deepEqual(await store.getExecutionApproval(expected), resolved);
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal accepts exact Codex execution evidence but never a socket send as acknowledgement", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest();
    await admitApproval(store, input, authority, async commit => commit());
    const selection = { authority, expected, decisionId: "decision", actorId: "owner", decision: "allow_once" as const,
      projectionSha256: "b".repeat(64), atMs: 110 };
    await store.selectHostApproval(selection, async commit => commit());
    const dispatch = { authority, expected, decisionId: "decision", dispatchId: "dispatch",
      projectionSha256: selection.projectionSha256, atMs: 120 };
    await store.beginExecutionApprovalDispatch(dispatch, async commit => commit());
    const outcome = { expected, decisionId: "decision", dispatchId: "dispatch", atMs: 130 };
    await store.recordExecutionApprovalOutcome({ ...outcome, evidence: "sent_unacknowledged" }, async commit => commit());
    await assert.rejects(
      store.recordExecutionApprovalOutcome({ ...outcome, evidence: "native_processed" }, async commit => commit()),
      { code: "invalid_transition" },
    );
    const resolved = await store.recordExecutionApprovalOutcome(
      { ...outcome, evidence: "exact_native_execution" }, async commit => commit(),
    );
    assert.equal(resolved.request.state, "resolved");
    assert.equal(resolved.decision!.dispatchState, "acknowledged");
    assert.deepEqual(
      await store.recordExecutionApprovalOutcome({ ...outcome, evidence: "exact_native_execution" }, async commit => commit()),
      resolved,
    );
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal records impossible pre-dispatch loss and refuses expiry without silently denying", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    for (const decided of [false, true]) {
      const { input, expected } = approvalJournalRequest(decided ? "decided" : "requested", decided ? 2 : 1);
      await admitApproval(store, input, authority, async commit => commit());
      const selection = { authority, expected, decisionId: "decision", actorId: "owner", decision: "deny" as const, projectionSha256: "b".repeat(64), atMs: 110 };
      if (decided) await store.selectHostApproval(selection, async commit => commit());
      const lost = await store.loseExecutionApproval({ expected, atMs: 120 }, async commit => commit());
      assert.equal(lost.request.applicationCertainty, "impossible");
      assert.equal(lost.decision?.applicationCertainty ?? null, decided ? "impossible" : null);
      assert.deepEqual(await store.loseExecutionApproval({ expected, atMs: 130 }, async commit => commit()), lost);
      assert.deepEqual((await admitApproval(store, input, authority, async commit => commit())).approval, lost);
      await assert.rejects(store.beginExecutionApprovalDispatch({ authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: selection.projectionSha256, atMs: 130 }, async commit => commit()));
    }
    const { input, expected } = approvalJournalRequest("expired", 3); await admitApproval(store, input, authority, async commit => commit());
    const selection = { authority, expected, decisionId: "expiry-decision", actorId: "owner", decision: "allow_once" as const, projectionSha256: "c".repeat(64), atMs: 200 };
    await assert.rejects(store.selectHostApproval(selection, async commit => commit()), { code: "expired" });
    assert.equal((await store.getExecutionApproval(expected))!.decision, null);
    assert.equal((await store.getExecutionApproval(expected))!.request.state, "requested");
    const selected = await store.selectHostApproval({ ...selection, atMs: 190 }, async commit => commit());
    await assert.rejects(store.beginExecutionApprovalDispatch({ authority, expected, decisionId: selection.decisionId, dispatchId: "expiry-dispatch", projectionSha256: selection.projectionSha256, atMs: 200 }, async commit => commit()), { code: "expired" });
    assert.deepEqual(await store.getExecutionApproval(expected), selected, "expiry is refusal, not an invented deny or dispatch");
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal snapshots caller inputs before awaiting the ownership fence", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest(); const original = structuredClone(input);
    const admission = await admitApproval(store, input, authority, async commit => {
      input.roomId = "other-room"; input.nativeRequestId = "other-native-id";
      await Promise.resolve(); await commit();
    });
    assert.deepEqual(admission.approval.request, {
      ...original,
      delegatable: false,
      state: "requested",
      applicationCertainty: null,
      closedAtMs: null,
    });
    const selection = { authority, expected: { ...expected }, decisionId: "decision", actorId: "owner", decision: "allow_once" as const, projectionSha256: "b".repeat(64), atMs: 110 };
    const selected = await store.selectHostApproval(selection, async commit => {
      selection.expected.connectionId = "replacement"; selection.actorId = "other"; selection.projectionSha256 = "c".repeat(64);
      await Promise.resolve(); await commit();
    });
    assert.equal(selected.decision!.actorId, "owner"); assert.equal(selected.decision!.projectionSha256, "b".repeat(64));
    const dispatch = { authority, expected: { ...expected }, decisionId: "decision", dispatchId: "dispatch", projectionSha256: "b".repeat(64), atMs: 120 };
    const started = await store.beginExecutionApprovalDispatch(dispatch, async commit => {
      dispatch.expected.providerTurnId = "replacement-turn"; dispatch.dispatchId = "replacement-dispatch";
      await Promise.resolve(); await commit();
    });
    assert.equal(started.dispatch, true); assert.equal(started.approval.decision!.dispatchId, "dispatch");
    assert.equal((await store.getExecutionApproval(expected))!.request.providerTurnId, "native-turn");
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal materializes atomically without capture and preserves lagging observer projections", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath); const other = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database); await other.load();
    const { input, expected } = approvalJournalRequest();
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_turns").get()!.n, 0);
    database.exec("CREATE TRIGGER fail_approval_admission AFTER INSERT ON execution_approval_requests BEGIN SELECT RAISE(ABORT,'admission rollback'); END");
    await assert.rejects(admitApproval(store, input, authority, async commit => commit()), /admission rollback/);
    for (const table of ["execution_generations", "execution_runtime_generations", "execution_message_attempts", "execution_attempt_generations", "execution_turns", "execution_approval_requests"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
    }
    database.exec("DROP TRIGGER fail_approval_admission");
    const competing = await Promise.all([admitApproval(store, input, authority, async commit => commit()), admitApproval(other, input, authority, async commit => commit())]);
    assert.deepEqual(competing.map(value => value.created).sort(), [false, true]);
    assert.equal(database.prepare("SELECT state FROM execution_turns").get()!.state, "none", "identity admission does not synthesize a turn-start fact");
    assert.equal(database.prepare("SELECT authority_mode FROM execution_runtime_generations").get()!.authority_mode, "typed",
      "approval-first daemon-owned Codex materialization uses typed authority");
    const shadow = new ExecutionShadowStore(database);
    assert.equal(shadow.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: expected.runtimeGenerationId,
      provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: 100 }), "typed",
      "a later capture request preserves the approval-materialized typed birth");
    const attemptId = shadow.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message", executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
    shadow.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation", runtimeGenerationId: expected.runtimeGenerationId,
      attemptId, turnId: expected.turnId, providerContinuationId: "continuation", providerTurnId: "native-turn", createdAtMs: 100 });
    shadow.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: expected.runtimeGenerationId, observerRuntimeGenerationId: expected.runtimeGenerationId,
      daemonGenerationId: "9", sourceId: "observer", expectedEpoch: 0, boundAtMs: 100 });
    const observer = database.prepare("SELECT * FROM execution_observers").get();
    database.exec("UPDATE execution_turns SET state='lost',ended_at_ms=105; UPDATE execution_runtime_generations SET runtime_state='exited',ended_at_ms=105");
    const before = database.prepare("SELECT * FROM execution_turns").get();
    const sibling = approvalJournalRequest("sibling", 2);
    await admitApproval(store, sibling.input, authority, async commit => commit());
    await store.selectHostApproval({ authority, expected, decisionId: "decision", actorId: "owner", decision: "allow_once", projectionSha256: "b".repeat(64), atMs: 110 }, async commit => commit());
    assert.equal((await store.beginExecutionApprovalDispatch({ authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: "b".repeat(64), atMs: 120 }, async commit => commit())).dispatch, true);
    assert.deepEqual(database.prepare("SELECT * FROM execution_turns").get(), before);
    assert.deepEqual(database.prepare("SELECT * FROM execution_observers").get(), observer);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_message_attempts").get()!.n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()!.n, 0);
    assert.deepEqual(await store.readLatestExecutionApproval("request"), await store.getExecutionApproval(expected));
  } finally { database.close(); await other.close(); await store.close(); await env.cleanup(); }
});

test("runtime lifecycle authority lookup reads only the exact frozen native birth", async () => {
  const env = await fixture(); let store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  const base = { agentId: "agent", executionGenerationId: "generation", configurationRevision: 3 };
  const births = [
    { providerConnection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex-birth" }, provider: "codex", mode: "legacy" },
    { providerConnection: { kind: "claude_cli", pid: 4312, processIdentity: "claude-birth" }, provider: "claude-code", mode: "typed_shadow" },
    { providerConnection: { kind: "cursor_cli", pid: 4313, processIdentity: "cursor-birth-a" }, provider: "cursor", mode: "typed" },
    { providerConnection: { kind: "opencode_server", url: "http://127.0.0.1:4314", pid: 4314, processIdentity: "opencode-birth", serverAuthPath: "/test/auth" }, provider: "open-model", mode: "typed_shadow" },
  ] as const satisfies ReadonlyArray<{ providerConnection: DaemonProviderConnection; provider: "codex" | "claude-code" | "cursor" | "open-model"; mode: "legacy" | "typed_shadow" | "typed" }>;
  const input = { ...base, providerConnection: births[2].providerConnection };
  try {
    const shadow = new ExecutionShadowStore(database);
    for (const [index, birth] of births.entries()) {
      const runtimeGenerationId = executionRuntimeStorageIdentity(base.agentId, base.executionGenerationId,
        birth.providerConnection.kind, birth.providerConnection.pid!, birth.providerConnection.processIdentity!);
      shadow.registerRuntime({ agentId: base.agentId, executionGenerationId: base.executionGenerationId, runtimeGenerationId,
        provider: birth.provider, authorityMode: birth.mode, configRevision: base.configurationRevision, createdAtMs: 100 + index });
      assert.equal(await store.readRuntimeLifecycleAuthority({ ...base, providerConnection: birth.providerConnection }), birth.mode);
    }
    const runtimeGenerationId = executionRuntimeStorageIdentity(input.agentId, input.executionGenerationId,
      input.providerConnection.kind, input.providerConnection.pid, input.providerConnection.processIdentity);
    const runtime = { agentId: input.agentId, executionGenerationId: input.executionGenerationId, runtimeGenerationId,
      provider: "cursor" as const, configRevision: input.configurationRevision };
    assert.equal(shadow.registerRuntime({ ...runtime, authorityMode: "legacy", createdAtMs: 101 }), "typed",
      "later policy requests cannot relabel the birth");
    assert.equal(await store.readRuntimeLifecycleAuthority(input), "typed");
    const queuedChild = structuredClone(input);
    const queuedRead = store.readRuntimeLifecycleAuthority(queuedChild);
    queuedChild.providerConnection.processIdentity = "cursor-birth-typed_shadow";
    assert.equal(await queuedRead, "typed", "a queued child-A lookup cannot borrow the mutable child-B birth");

    for (const mismatch of [
      { ...input, agentId: "other-agent" },
      { ...input, executionGenerationId: "other-generation" },
      { ...input, providerConnection: { ...input.providerConnection, kind: "claude_cli" as const } },
      { ...input, providerConnection: { ...input.providerConnection, pid: input.providerConnection.pid + 1 } },
      { ...input, providerConnection: { ...input.providerConnection, processIdentity: "cursor-birth-b" } },
      { ...input, configurationRevision: 4 },
      { ...input, providerConnection: { ...input.providerConnection, pid: null } },
      { ...input, providerConnection: { ...input.providerConnection, processIdentity: null } },
    ]) assert.equal(await store.readRuntimeLifecycleAuthority(mismatch), null, "another identity cannot borrow the frozen mode");

    await store.close(); store = new ManifestStore(env.databasePath); await store.load();
    assert.equal(await store.readRuntimeLifecycleAuthority(input), "typed", "restart reads the same durable frozen row");
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.prepare("UPDATE execution_runtime_generations SET authority_mode='unknown' WHERE runtime_generation_id=?").run(runtimeGenerationId);
    database.exec("PRAGMA ignore_check_constraints=OFF");
    assert.equal(await store.readRuntimeLifecycleAuthority(input), null, "malformed authority fails closed without policy inference");
    database.prepare("DELETE FROM execution_runtime_generations WHERE runtime_generation_id=?").run(runtimeGenerationId);
    assert.equal(await store.readRuntimeLifecycleAuthority(input), null, "missing authority fails closed without materialization");
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal rechecks operational checkpoint and configuration at selection, dispatch, and final send", async () => {
  const env = await fixture(); const store = new ManifestStore(env.databasePath);
  await store.load(); const database = new DatabaseSync(env.databasePath);
  try {
    const authority = await seedApprovalJournalTurn(env, store, database);
    const { input, expected } = approvalJournalRequest(); await admitApproval(store, input, authority, async commit => commit());
    database.exec("UPDATE execution_turns SET state='active'");
    const selection = { authority, expected, decisionId: "decision", actorId: "owner", decision: "deny" as const, projectionSha256: "b".repeat(64), atMs: 110 };
    const dispatch = { authority, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: "b".repeat(64), atMs: 120 };
    const changes = [
      ["supervised_agent_provider_turn_bindings", "work_attempt_id", "other", "workspace"],
      ["supervised_agent_provider_turn_bindings", "origin_execution_generation_id", "other", "generation"],
      ["supervised_agent_provider_turn_bindings", "provider_continuation_id", "other", "continuation"],
      ["supervised_agent_provider_turn_bindings", "provider_turn_id", "other", "native-turn"],
      ["supervised_agent_inbox", "state", "blocked", "dispatching"],
      ["supervised_agent_inbox", "outcome", "{}", null],
      ["runtime_deployments", "provider_process_identity", "other", "birth"],
      ["runtime_deployments", "provider_connection_url", "http://127.0.0.1:9999", "http://127.0.0.1:4311"],
      ["agent_configurations", "runtime_configuration_revision", 2, 1],
      ["agent_configurations", "delivery_mode", "mcp_polling", "daemon_inbox"],
      ["agent_launch_intents", "desired_state", "paused", "running"],
      ["work_attempt_executions", "terminal_json", "{}", null],
    ] as const;
    for (const selected of [false, true]) {
      if (selected) await store.selectHostApproval(selection, async commit => commit());
      for (const [table, column, changed, original] of changes) {
        const assertNativeWrite = await store.validateExecutionApprovalAuthority(expected, authority);
        database.prepare(`UPDATE ${table} SET ${column}=?`).run(changed);
        assert.throws(assertNativeWrite, { code: "missing_turn" }, "final native callback rechecks after earlier async validation");
        await assert.rejects(store.validateExecutionApprovalAuthority(expected, authority), { code: "missing_turn" });
        await assert.rejects(selected ? store.beginExecutionApprovalDispatch(dispatch, async commit => commit())
          : store.selectHostApproval(selection, async commit => commit()), { code: "missing_turn" });
        assert.equal((await store.getExecutionApproval(expected))!.decision?.dispatchId ?? null, null);
        database.prepare(`UPDATE ${table} SET ${column}=?`).run(original);
        await store.validateExecutionApprovalAuthority(expected, authority);
      }
    }
    // A saved edit ahead of the applied revision waits for the next start. The live runtime keeps its authority
    // for a decision a person chose, but not for one that depends on the configuration in force. The journal
    // reads who chose from the stored decision, so the authority itself says nothing about it.
    const automatic = approvalJournalRequest("automatic", 3);
    await admitApproval(store, automatic.input, authority, async commit => commit());
    await store.selectHostApproval({ authority, expected: automatic.expected, decisionId: "automatic-decision", actorId: "automatic-review",
      decision: "allow_once", projectionSha256: "b".repeat(64), atMs: 111 }, async commit => commit());
    const assertNativeWriteAfterSave = await store.validateExecutionApprovalAuthority(expected, authority);
    database.exec("UPDATE agent_configurations SET config_revision=2");
    assertNativeWriteAfterSave();
    await store.validateExecutionApprovalAuthority(expected, authority);
    await assert.rejects(store.validateExecutionApprovalAuthority(automatic.expected, authority), { code: "missing_turn" });
    await assert.rejects(store.validateExecutionApprovalAuthority(expected, { ...authority, ownerAnswer: true } as typeof authority), { code: "invalid_input" });
    database.exec("UPDATE agent_configurations SET config_revision=1");
    await store.validateExecutionApprovalAuthority(automatic.expected, authority);
    await assert.rejects(store.beginExecutionApprovalDispatch(dispatch, async commit => {
      database.exec("UPDATE supervised_agent_inbox SET outcome='{}'"); await commit();
    }), { code: "missing_turn" }, "post-inspection checkpoint change is rechecked inside the committed intent");
    database.exec("UPDATE supervised_agent_inbox SET outcome=NULL");
    const assertNativeWrite = await store.validateExecutionApprovalAuthority(expected, authority);
    const inbox = new SupervisedAgentInboxStore(env.databasePath, () => new Date(125).toISOString());
    try {
      await inbox.checkpointNormalizedTerminal({ inbox_item_id: authority.inboxItemId, agent_id: "agent", execution_generation_id: "generation",
        provider_turn_id: "native-turn", outcome: "unreadable", text: null, evidence: "none", terminal_evidence: {} });
      database.exec("UPDATE supervised_agent_inbox SET outcome=NULL");
      await assert.rejects(store.beginExecutionApprovalDispatch(dispatch, async commit => commit()), { code: "missing_turn" }, "terminal journal is authority even if the inbox outcome was lost");
      assert.throws(assertNativeWrite, { code: "missing_turn" });
      await store.close();
      assert.throws(assertNativeWrite, /store is unavailable/);
    } finally { await inbox.close(); }
  } finally { database.close(); await store.close(); await env.cleanup(); }
});

test("approval journal never fabricates an original native birth after generation recovery", async () => {
  for (const captured of [false, true]) {
    const env = await fixture(); const store = new ManifestStore(env.databasePath);
    await store.load(); const database = new DatabaseSync(env.databasePath);
    try {
      const authority = await seedApprovalJournalTurn(env, store, database);
      const { input, expected } = approvalJournalRequest();
      if (captured) {
        const shadow = new ExecutionShadowStore(database);
        shadow.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: expected.runtimeGenerationId,
          provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: 100 });
        shadow.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message", executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
      }
      const attempt = database.prepare("SELECT attempt_id FROM execution_message_attempts").get();
      database.exec(`UPDATE work_attempt_executions SET terminal_json='{}';
        INSERT INTO work_attempt_executions VALUES('successor','workspace','1970-01-01T00:00:00.105Z','provider',9,NULL)`);
      database.prepare("UPDATE runtime_deployments SET provider_execution_generation_id='successor',run_id='successor',deployment_id=?")
        .run(serializeDaemonDeploymentId("agent", "successor"));
      const recovered = { ...authority, executionGenerationId: "successor" };
      if (!captured) {
        await assert.rejects(admitApproval(store, input, recovered, async commit => commit()), { code: "missing_turn" });
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_runtime_generations").get()!.n, 0);
      } else {
        const result = await admitApproval(store, input, recovered, async commit => commit());
        assert.equal(database.prepare("SELECT authority_mode FROM execution_runtime_generations").get()!.authority_mode, "typed",
          "approval admission preserves the captured exact birth's frozen mode");
        assert.equal(result.approval.request.executionGenerationId, "generation");
        assert.equal(result.approval.request.runtimeGenerationId, expected.runtimeGenerationId);
        assert.deepEqual(database.prepare("SELECT attempt_id FROM execution_message_attempts").get(), attempt);
        await store.selectHostApproval({ authority: recovered, expected, decisionId: "decision", actorId: "owner", decision: "deny", projectionSha256: "b".repeat(64), atMs: 110 }, async commit => commit());
        assert.equal((await store.beginExecutionApprovalDispatch({ authority: recovered, expected, decisionId: "decision", dispatchId: "dispatch", projectionSha256: "b".repeat(64), atMs: 120 }, async commit => commit())).dispatch, true);
      }
    } finally { database.close(); await store.close(); await env.cleanup(); }
  }
});
