import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ExecutionDelegationDecisionIntent } from "../../../../shared/execution-delegation-decision.mjs";
import type { ApprovalAuthority, ApprovalReference } from "../execution-approval-journal.js";
import { selectDelegatedApproval } from "../execution-delegated-approval.js";
import type { ExecutionDelegationHostAuthority } from "../execution-delegation-journal.js";
import { executionRuntimeStorageIdentity, executionStorageIdentity, materializeExecutionIdentity } from "../execution-shadow-store.js";
import { applyExecutionStorageSchema } from "../execution-storage-schema.js";
import type { DaemonManifestEntry } from "../types.js";

const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "birth" };
const runtimeGenerationId = executionRuntimeStorageIdentity("agent", "generation", connection.kind, connection.pid, connection.processIdentity);
const turnId = executionStorageIdentity("turn", "agent", "continuation", "native-turn");
const expected: ApprovalReference = {
  requestId: "request", requestVersion: 1, requestSha256: "a".repeat(64), agentId: "agent", roomId: "room",
  executionGenerationId: "generation", runtimeGenerationId, turnId, providerContinuationId: "continuation",
  providerTurnId: "native-turn", connectionId: "connection", nativeRequestId: 1,
};
const approvalAuthority: ApprovalAuthority = {
  inboxItemId: "inbox", workAttemptId: "workspace", executionGenerationId: "generation", provider: "codex",
  providerConnection: connection, configurationRevision: 1,
};
const entry = {
  id: "agent", room_id: "room", provider: "codex", delivery_mode: "daemon_inbox", desired_state: "running",
  work_attempt_id: "workspace", runtime_configuration_revision: 1,
  provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
    provider_continuation_id: "continuation", provider_connection: connection },
} as DaemonManifestEntry;

function hostAuthority(): ExecutionDelegationHostAuthority {
  return {
    agentId: "agent", roomId: "room", agentKey: "owner/agent", grantId: "grant-2", grantGeneration: 2,
    daemonGeneration: 3, controlEpoch: 4, hostId: "host", installationId: "installation", ownerAccountId: "owner",
    scopeKey: "owner", expiresAtMs: 1_000,
  };
}

function intent(decisionId: string, revision: number, scopeSha256: string,
  decision: "allow_once" | "deny" = "allow_once"): ExecutionDelegationDecisionIntent {
  return {
    decision_id: decisionId, delegation_instance_id: "delegation", delegation_revision: revision,
    actor_account_id: "approver", request_id: expected.requestId, request_version: expected.requestVersion,
    request_sha256: expected.requestSha256, projection_sha256: "b".repeat(64), decision,
    decided_at: "2026-09-03T00:00:00.000Z", owner_account_id: "owner", room_id: "room", agent_key: "owner/agent",
    approver_account_id: "approver", category: "file_change", risk_ceiling: "low", scope_sha256: scopeSha256,
  };
}

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyExecutionStorageSchema(db);
  db.exec(`
    CREATE TABLE agent_configurations(agent_id TEXT PRIMARY KEY,config_revision INTEGER,runtime_configuration_revision INTEGER);
    CREATE TABLE work_attempt_executions(execution_generation_id TEXT,work_attempt_id TEXT,terminal_json TEXT);
    CREATE TABLE supervised_agent_inbox(inbox_item_id TEXT,agent_id TEXT,room_id TEXT,state TEXT,provider_turn_id TEXT,
      outcome TEXT,source_message_id TEXT,created_at TEXT,fifo_sequence INTEGER);
    CREATE TABLE supervised_agent_terminal_results(inbox_item_id TEXT);
    CREATE TABLE supervised_agent_provider_turn_bindings(inbox_item_id TEXT,agent_id TEXT,room_id TEXT,work_attempt_id TEXT,
      provider_continuation_id TEXT,provider_turn_id TEXT,origin_execution_generation_id TEXT);
    INSERT INTO agent_configurations VALUES('agent',1,1);
    INSERT INTO work_attempt_executions VALUES('generation','workspace',NULL);
    INSERT INTO supervised_agent_inbox VALUES('inbox','agent','room','awaiting_result','native-turn',NULL,'message',
      '1970-01-01T00:00:00.100Z',1);
    INSERT INTO supervised_agent_provider_turn_bindings VALUES('inbox','agent','room','workspace','continuation','native-turn','generation');
    PRAGMA foreign_keys=ON;
    BEGIN IMMEDIATE;
  `);
  materializeExecutionIdentity(db, {
    runtime: { agentId: "agent", executionGenerationId: "generation", runtimeGenerationId,
      provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 100 },
    message: { agentId: "agent", roomId: "room", executionGenerationId: "generation",
      sourceMessageId: "message", workspaceId: "workspace", createdAtMs: 100 },
    turn: { turnId, agentId: "agent", roomId: "room", executionGenerationId: "generation",
      runtimeGenerationId, providerContinuationId: "continuation", providerTurnId: "native-turn", createdAtMs: 100 },
  });
  db.prepare(`INSERT INTO execution_approval_requests(request_id,request_version,agent_id,room_id,execution_generation_id,
    runtime_generation_id,turn_id,provider_continuation_id,provider_turn_id,connection_id,native_request_id_type,native_request_id,
    kind,risk,delegatable,request_sha256,state,recovery_boundary,created_at_ms,expires_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'file_change','low',1,?,'requested','connection',100,900)`).run(
    expected.requestId, expected.requestVersion, expected.agentId, expected.roomId, expected.executionGenerationId,
    expected.runtimeGenerationId, expected.turnId, expected.providerContinuationId, expected.providerTurnId,
    expected.connectionId, "number", String(expected.nativeRequestId), expected.requestSha256,
  );
  for (const [revision, scope, grant] of [[1, "c".repeat(64), "grant-1"], [2, "d".repeat(64), "grant-2"]] as const) {
    db.prepare(`INSERT INTO execution_local_delegations(delegation_instance_id,revision,owner_id,host_id,installation_id,
      scope_key,agent_id,room_id,agent_key,approver_id,category,risk_ceiling,grant_id,scope_sha256,created_at_ms,expires_at_ms,revoked_at_ms)
      VALUES('delegation',?,'owner','host','installation','owner','agent','room','owner/agent','approver','file_change','low',?,?,100,800,NULL)`)
      .run(revision, grant, scope);
  }
  db.exec("COMMIT");
  return db;
}

function select(
  db: DatabaseSync,
  value: ExecutionDelegationDecisionIntent,
  locallyWitnessedProjectionSha256 = value.projection_sha256,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = selectDelegatedApproval(db, {
      intent: value, expected, locallyWitnessedProjectionSha256, approvalAuthority,
      authority: hostAuthority(), atMs: 200,
    }, entry);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("stale delegation intent cannot commit, the renewed revision can, and its exact replay is idempotent", () => {
  const db = fixture();
  try {
    assert.throws(() => select(db, intent("decision-stale", 1, "c".repeat(64))), /revision_conflict/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_approval_decisions").get()!.count, 0);

    const current = intent("decision-current", 2, "d".repeat(64));
    const recorded = select(db, current);
    assert.equal(recorded.decision?.source, "delegate");
    assert.equal(recorded.decision?.delegationRevision, 2);
    assert.equal(select(db, current).decision?.decisionId, "decision-current");
  } finally { db.close(); }
});

test("a server projection claim cannot replace the daemon's local projection witness", () => {
  const db = fixture();
  try {
    const remote = intent("decision-current", 2, "d".repeat(64));
    assert.throws(() => select(db, remote, "e".repeat(64)), /invalid_input/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_approval_decisions").get()!.count, 0);
  } finally { db.close(); }
});

test("one committed request version rejects every contradictory decision across delegation revisions", () => {
  const db = fixture();
  try {
    select(db, intent("decision-current", 2, "d".repeat(64)));
    assert.throws(() => select(db, intent("decision-other", 1, "c".repeat(64), "deny")), /decision_conflict/);
    const rows = db.prepare("SELECT decision_id,decision,source FROM execution_approval_decisions").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { decision_id: "decision-current", decision: "allow_once", source: "delegate" },
    ]);
  } finally { db.close(); }
});
