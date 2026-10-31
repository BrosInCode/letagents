// Shared fixtures for the manifest-store-sqlite-*.test.ts files that were split from manifest-store-sqlite.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_STATE_SCHEMA_VERSION } from "../../daemon-state-database.js";
import { serializeDaemonDeploymentId } from "../../manifest-entry-projection.js";
import { ManifestStore } from "../../manifest-store.js";
import type { ProviderActionHandle } from "../../provider-action-port.js";
import { SupervisedAgentInboxStore } from "../../supervised-agent-inbox-store.js";
import type { DaemonManifest, DaemonManifestEntry } from "../../types.js";
import { WorkerBindingStore } from "../../worker-binding-store.js";
import type { AdmitExecutionApproval, ApprovalAuthority, ApprovalReference } from "../../execution-approval-journal.js";
import type { ExecutionDelegationHostAuthority, RemoteExecutionDelegationRevision, ValidateExecutionDelegation } from "../../execution-delegation-journal.js";
import { executionRuntimeStorageIdentity, executionStorageIdentity } from "../../execution-shadow-store.js";
import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../../execution-storage-schema.js";
import { validateLegacyLifecycleProjectionLedgerSchema } from "../../lifecycle-projection-ledger.js";
import { removeTestDirectory } from "../../../electron/__tests__/harness.js";

export const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt_1",
  origin_execution_generation_id: "run_1",
  provider_continuation_id: "thread_1",
} as const;

export function restoreThreeProviderLifecycleProjectionFixture(database: DatabaseSync): void {
  const noDelete = String(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lifecycle_projection_total_no_delete'",
  ).get()!.sql);
  database.exec(`DROP TRIGGER lifecycle_projection_total_no_delete;
    DELETE FROM lifecycle_projection_totals WHERE provider='open-model';
    ${noDelete}`);
  const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()!.schema_version);
  database.enableDefensive?.(false); // Only the disposable three-provider legacy fixture.
  database.exec("PRAGMA writable_schema=ON");
  database.prepare(`UPDATE sqlite_master SET sql=replace(sql, ?, '')
    WHERE type='table' AND name IN ('lifecycle_projection_lanes','lifecycle_projection_totals')`).run(",'open-model'");
  database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
  database.enableDefensive?.(true);
  validateLegacyLifecycleProjectionLedgerSchema(database);
}

export function restoreEmptyExecutionDelegationV23Fixture(database: DatabaseSync): void {
  database.exec("DROP TABLE IF EXISTS host_tool_rule_withdrawals; DROP TABLE IF EXISTS host_tool_rule_decisions; DROP TABLE IF EXISTS host_tool_rules");
  database.exec("DROP TABLE IF EXISTS execution_approval_request_closures");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 0);
  database.exec("DROP TRIGGER execution_approval_projection_immutable; DROP TABLE execution_approval_projections");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_local_delegations").get()!.n, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 0);
  const previous = new DatabaseSync(":memory:");
  try {
    applyExecutionStorageSchema(previous, 23);
    const definitions = previous.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name IN ('execution_local_delegations','execution_approval_decisions') AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`).all();
    database.exec("DROP TABLE execution_approval_decisions; DROP TABLE execution_local_delegations");
    for (const row of definitions) database.exec(String(row.sql));
  } finally { previous.close(); }
  validateExecutionStorageSchema(database, 23);
}

export async function seedApprovalJournalTurn(env: Awaited<ReturnType<typeof fixture>>, store: ManifestStore, database: DatabaseSync,
  provider: "codex" | "open-model" = "codex"): Promise<ApprovalAuthority> {
  const providerConnection: ApprovalAuthority["providerConnection"] = provider === "codex"
    ? { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "birth" }
    : { kind: "opencode_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "birth", serverAuthPath: "/test/auth" };
  await store.write(0, [{ ...entry, id: "agent", room_id: "room", provider, condition: "none", turn_control: undefined,
    reconciliation: undefined, reconciliation_notices: undefined, delivery_mode: "daemon_inbox", work_attempt_id: "workspace",
    provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation", provider_continuation_id: "continuation", provider_connection: providerConnection } }]);
  seedTerminalExecution(env.databasePath, "workspace", "generation");
  database.exec("PRAGMA foreign_keys=ON; UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='generation'");
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => new Date(100).toISOString());
  try {
    const item = await inbox.enqueueInitialMessage({ agent_id: "agent", room_id: "room", source_message_id: "message",
      source_message: { id: "message" }, activation: { kind: "deliver", reason: "direct_mention" } });
    await inbox.claimHead("agent");
    await inbox.checkpointTurnStarted(item.inbox_item_id, "native-turn", { work_attempt_id: "workspace",
      origin_execution_generation_id: "generation", provider_continuation_id: "continuation" });
    return { inboxItemId: item.inbox_item_id, workAttemptId: "workspace", executionGenerationId: "generation",
      provider, providerConnection, configurationRevision: 1 };
  } finally { await inbox.close(); }
}

export function admitApproval(store: ManifestStore, input: AdmitExecutionApproval, authority: ApprovalAuthority,
  fence: (commit: () => Promise<void>) => Promise<void>) {
  const { executionGenerationId: _generation, runtimeGenerationId: _runtime, turnId: _turn, ...request } = input;
  return store.admitExecutionApprovalPlan(
    { classification: "host_only", request: { ...request, risk: "high" }, authority },
    () => input.createdAtMs,
    fence,
  );
}

export function approvalJournalRequest(requestId = "request", nativeRequestId: string | number = 1, provider: "codex" | "open-model" = "codex"): { expected: ApprovalReference; input: AdmitExecutionApproval } {
  const expected: ApprovalReference = {
    requestId, requestVersion: 1, requestSha256: "a".repeat(64), agentId: "agent", roomId: "room",
    executionGenerationId: "generation", runtimeGenerationId: executionRuntimeStorageIdentity(
      "agent", "generation", provider === "codex" ? "codex_app_server" : "opencode_server", 4311, "birth",
    ), turnId: executionStorageIdentity("turn", "agent", "continuation", "native-turn"),
    providerContinuationId: "continuation", providerTurnId: "native-turn", connectionId: "connection", nativeRequestId,
  };
  return { expected, input: { ...expected, kind: "command", risk: "high", recoveryBoundary: "connection", createdAtMs: 100, expiresAtMs: 200 } };
}

export function localDelegationAuthority(overrides: Partial<ExecutionDelegationHostAuthority> = {}): ExecutionDelegationHostAuthority {
  return {
    agentId: "agent",
    roomId: "room",
    agentKey: "EmmyMay/agent",
    grantId: "host-grant-1",
    grantGeneration: 1,
    daemonGeneration: 1,
    controlEpoch: 0,
    hostId: "host-1",
    installationId: "installation-1",
    ownerAccountId: "owner-1",
    scopeKey: "owner",
    expiresAtMs: 1_000,
    ...overrides,
  };
}

export function localDelegationRevision(overrides: Partial<RemoteExecutionDelegationRevision> = {}): RemoteExecutionDelegationRevision {
  return {
    delegationInstanceId: "delegation-1",
    revision: 1,
    ownerAccountId: "owner-1",
    roomId: "room",
    agentKey: "EmmyMay/agent",
    approverAccountId: "approver-1",
    category: "file_change",
    riskCeiling: "low",
    scopeSha256: "a".repeat(64),
    createdAtMs: 100,
    expiresAtMs: 300,
    revokedAtMs: null,
    ...overrides,
  };
}

export function localDelegationInput(
  delegation: RemoteExecutionDelegationRevision,
  authority: ExecutionDelegationHostAuthority,
  atMs: number,
) {
  return { delegation, authority, atMs };
}

export function localDelegationValidation(
  authority: ExecutionDelegationHostAuthority,
  overrides: Partial<ValidateExecutionDelegation> = {},
): ValidateExecutionDelegation {
  return {
    delegationInstanceId: "delegation-1",
    revision: 1,
    agentId: "agent",
    approverAccountId: "approver-1",
    category: "file_change",
    risk: "low",
    scopeSha256: "a".repeat(64),
    authority,
    atMs: 150,
    ...overrides,
  };
}

export async function seedLocalDelegationManifest(store: ManifestStore): Promise<void> {
  await store.write(0, [{
    ...entry,
    id: "agent",
    room_id: "room",
    condition: "none",
    turn_control: undefined,
    reconciliation: undefined,
    reconciliation_notices: undefined,
  }]);
}

export const IMAGE_INPUT_UPDATE = (revision: number, imageInput: boolean) => ({
  agentId: entry.id, expectedRevision: revision, model: "model-a", reasoningEffort: null,
  charter: "Image input charter.", permissionProfileId: "read_only", providerLaunchPolicy: { approvalPolicy: "ask" }, imageInput,
});

export const terminal = {
  ended_at: "2026-07-19T00:03:00.000Z",
  exit_code: 17,
  signal: null,
  stdio_archive_ref: "archive://run-1",
  stdio_tail: "provider stopped",
  terminal_cause: "process_exit",
  actor: "provider",
  generation: 8,
  provider_continuation_id: "thread_1",
};

export const entry: DaemonManifestEntry = {
  id: "agent_1",
  room_id: "room_1",
  display_name: "MistyMorrow",
  provider: "codex",
  model: "gpt-5.6-codex",
  charter: "Investigate daemon stability.",
  desired_state: "running",
  observed_state: "working",
  condition: "coordination_blocked",
  last_error: null,
  permission_profile_id: "workspace-write",
  provider_launch_policy: { deliveryMode: "mcp_polling" },
  created_by: "user_1",
  created_at: "2026-07-19T00:00:00.000Z",
  source_repo_path: "/repo",
  workspace_path: "/worktrees/agent_1",
  work_attempt_id: "attempt_1",
  provider_ref: {
    work_attempt_id: "attempt_1",
    provider_continuation_id: "thread_1",
    provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: null },
    execution_generation_id: "run_1",
  },
  workplace_liveness: { state: "reachable", observed_at: "2026-07-19T00:01:00.000Z", detail: null },
  native_liveness: { state: "active", observed_at: "2026-07-19T00:01:01.000Z", detail: "streaming" },
  ready_reached_at: "2026-07-19T00:01:00.000Z",
  activity: [{
    observed_at: "2026-07-19T00:01:02.000Z",
    sequence: 4,
    provider: "codex",
    kind: "tool",
    method: "turn/product-path-delivery",
    summary: "Delivered room message",
    status: "working",
    payload: { message_id: "message_1" },
    payload_truncated: false,
    payload_redacted: true,
    durable_payload_ref: null,
  }],
  turn_control: {
    action_id: "action_1",
    action_sequence: 1,
    work_attempt_id: "attempt_1",
    execution_generation_id: "run_1",
    has_correction: true,
    status: "completed",
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "working",
    stages: ["delivered", "interrupting", "applied"],
    error: null,
    recorded_at: "2026-07-19T00:02:00.000Z",
    updated_at: "2026-07-19T00:02:01.000Z",
  },
  last_turn_control_sequence: 1,
  last_worker_binding: {
    agent_session_id: "session_1",
    work_attempt_id: "attempt_1",
    execution_generation_id: "run_1",
    updated_at: "2026-07-19T00:02:02.000Z",
  },
  reconciliation: {
    exit_timestamps_ms: [10, 20],
    consecutive_action_failures: 2,
    last_observed_state: "failed",
    next_restart_at_ms: 30,
    completed_action_ids: ["old_1", "old_2"],
    last_action_sequence: 9,
    pending_action: { id: "pending_1", sequence: 9, kind: "restart_with_resume", recorded_at_ms: 25 },
    last_terminal: terminal,
  },
  reconciliation_notices: [{
    at: "2026-07-19T00:03:01.000Z",
    kind: "coordination_escalation",
    cause: "provider process exited",
    terminal,
  }],
};

export async function fixture(): Promise<{ root: string; databasePath: string; legacyPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-manifest-sqlite-"));
  return {
    root,
    databasePath: join(root, "daemon-state.sqlite"),
    legacyPath: join(root, "daemon-manifest.json"),
    cleanup: () => removeTestDirectory(root),
  };
}

export function deliveryDrainCoordinates() {
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "codex:4311" };
  const agent: DaemonManifestEntry = {
    ...entry, condition: "none", delivery_mode: "daemon_inbox", turn_control: undefined, last_turn_control_sequence: 0,
    provider_ref: { ...entry.provider_ref!, provider_connection: connection },
  };
  const handle: ProviderActionHandle = { workAttemptId: "attempt_1", pid: 4311, providerContinuationId: "thread_1", providerConnection: { ...connection }, observedState: "idle" };
  return { agent, input: {
    requestId: "drain-request", operationId: "drain-operation", agentId: agent.id, roomId: agent.room_id,
    executionGenerationId: "run_1", handle,
    boundary: { state: "idle" as const, providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4311", latestProviderTurnId: null },
  } };
}

export function seedActiveDrainExecution(databasePath: string): void {
  seedTerminalExecution(databasePath, "attempt_1", "run_1");
  const database = new DatabaseSync(databasePath);
  try { database.exec("UPDATE work_attempt_executions SET terminal_json=NULL WHERE execution_generation_id='run_1'"); }
  finally { database.close(); }
}

export async function seedPollingActivationRuntime(env: Awaited<ReturnType<typeof fixture>>, store: ManifestStore,
  inbox: SupervisedAgentInboxStore, bindings: WorkerBindingStore): Promise<Parameters<ManifestStore["preparePollingActivation"]>[0]> {
  const { agent, input } = deliveryDrainCoordinates();
  await store.write(0, [agent]); seedActiveDrainExecution(env.databasePath);
  await inbox.ingestPoll({ agent_id: agent.id, room_id: agent.room_id, last_observed_message_id: "msg_47", messages: [] });
  await store.prepareDeliveryDrain(input); await store.markDeliveryDrainDispatch(input);
  await store.commitDeliveryDrain((await store.load()).generation, input, async commit => commit());
  const database = new DatabaseSync(env.databasePath);
  try {
    database.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='run_1'").run(JSON.stringify(terminal));
    database.prepare("INSERT INTO work_attempt_executions VALUES('run_2','attempt_1',?,'provider',9,NULL)").run(terminal.ended_at);
  } finally { database.close(); }
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4312", pid: 4312, processIdentity: "codex:4312" };
  const next = withRuntimeIdentity({ ...(await store.getEntry(agent.id))!,
    provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_2", provider_continuation_id: "thread_1", provider_connection: connection,
      custodial_launch_agent_session_id: "session_2" } });
  await store.replaceEntry((await store.load()).generation, next);
  await store.markRuntimeConfigurationApplied((await store.load()).generation, { agentId: agent.id, executionGenerationId: "run_2", appliedRevision: 2 });
  const binding = await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_2",
    agent_session_id: "session_2", agent_session_token: "test-token", api_url: "https://example.test" }, { roomCursor: "msg_47" });
  await bindings.recordSupervisedWorkerSession({ agent_id: agent.id, room_id: agent.room_id, execution_generation_id: "run_2",
    agent_session_id: binding.agent_session_id, credential_ref: binding.credential_ref, expires_at: "2099-01-01T00:00:00.000Z" });
  return { operationId: "activation", requestId: "activation-request", agentId: agent.id, roomId: agent.room_id,
    executionGenerationId: "run_2", reverseOperationId: input.operationId,
    handle: { workAttemptId: "attempt_1", pid: 4312, providerConnection: connection, providerContinuationId: "thread_1", observedState: "idle", appliedConfigurationRevision: 2 },
    boundary: { state: "idle", providerContinuationId: "thread_1", nativeProcessIdentity: "codex:4312", latestProviderTurnId: null } };
}

export function seedTerminalExecution(databasePath: string, workAttemptId: string, executionGenerationId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`INSERT OR IGNORE INTO work_attempts
      (work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      workAttemptId, "task_1", "lease_1", 1, `/workspace/${workAttemptId}`, "repo", "https://example.test/repo.git", "abc123", `/bare/${workAttemptId}`, "active", "2026-08-05T10:00:00.000Z",
    );
    database.prepare(`INSERT OR REPLACE INTO work_attempt_executions
      (execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json)
      VALUES (?,?,?,?,?,?)`).run(
      executionGenerationId, workAttemptId, "2026-08-05T10:00:00.000Z", "provider", 8, JSON.stringify(terminal),
    );
  } finally {
    database.close();
  }
}

export function storedManifest(manifest: DaemonManifest): string {
  const checksum = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return `${JSON.stringify({ manifest, checksum })}\n`;
}

export function withRuntimeIdentity(item: DaemonManifestEntry): DaemonManifestEntry {
  const runId = item.provider_ref?.execution_generation_id;
  return runId ? { ...item, run_id: runId, deployment_id: serializeDaemonDeploymentId(item.id, runId) } : item;
}

export function withImportedRuntimeIdentity(item: DaemonManifestEntry): DaemonManifestEntry {
  const imported = withRuntimeIdentity(item);
  return imported.provider === "codex" && imported.provider_ref
    ? { ...imported, desired_state: "stopped" }
    : imported;
}

export function removePostV5DeliveryTables(database: DatabaseSync): void {
  database.exec(`
    -- Physical v1-v4 databases cannot contain the later v13 repair journal.
    DROP TABLE IF EXISTS provider_continuation_repairs;
    DROP TABLE IF EXISTS supervised_agent_provider_turn_bindings;
    DROP TABLE IF EXISTS supervised_agent_publications;
    DROP TABLE IF EXISTS supervised_agent_history_boundaries;
    DROP TABLE IF EXISTS supervised_agent_pruned_sources;
    DROP TABLE IF EXISTS supervised_agent_effects;
    DROP TABLE IF EXISTS supervised_agent_ingress_health;
    DROP TABLE IF EXISTS supervised_agent_observed_messages;
    DROP TABLE IF EXISTS supervised_agent_terminal_results;
    DROP TABLE IF EXISTS supervised_agent_inbox_events;
    DROP TABLE IF EXISTS supervised_agent_ingress_cursors;
    DROP TABLE IF EXISTS supervised_agent_inbox;
  `);
}

export function assertRoomScopedV9DeliveryShape(database: DatabaseSync): void {
  assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
  assert.equal((database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as { sql: string };
  const observed = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_observed_messages'").get() as { sql: string };
  const publications = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as { sql: string };
  assert.match(inbox.sql, /UNIQUE\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(observed.sql, /PRIMARY KEY\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(publications.sql, /FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

export function seedTerminalAttempt(databasePath: string, attemptId: string, executionId: string, workspacePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`INSERT INTO work_attempts(
      work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,
      workspace_resolved_revision,workspace_bare_path,state,created_at,concluded_at,conclusion_cause,postmortem_diff
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      attemptId, `task_${attemptId}`, `lease_${attemptId}`, 1, workspacePath, "repo", "https://github.com/example/repo.git",
      "a".repeat(40), join(workspacePath, ".bare"), "cleanly_concluded", "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:03:00.000Z", "provider stopped", "",
    );
    database.prepare("INSERT INTO work_attempt_lease_epochs VALUES(?,?,?,?,?)").run(attemptId, 0, `lease_${attemptId}`, 1, "2026-07-19T00:00:00.000Z");
    database.prepare("INSERT INTO work_attempt_checkpoints VALUES(?,?,?,?,?)").run(attemptId, 0, "2026-07-19T00:01:00.000Z", "message_1", "thread_1");
    database.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,?,?,?)").run(
      executionId, attemptId, "2026-07-19T00:01:00.000Z", "provider", 1,
      JSON.stringify({ ...terminal, actor: "provider", generation: 1 }),
    );
  } finally { database.close(); }
}
