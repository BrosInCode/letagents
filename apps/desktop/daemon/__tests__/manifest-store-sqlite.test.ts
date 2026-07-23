import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { serializeDaemonDeploymentId } from "../manifest-entry-projection.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "../types.js";

test("Inspector configuration revisions are optimistic, durable, and do not alter the flat manifest", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
    const original = await store.getAgentConfiguration(entry.id);
    assert.equal(original?.config_revision, 1);
    assert.equal(original?.runtime_configuration_revision, 1);
    const updated = await store.updateAgentConfiguration(1, {
      agentId: entry.id, expectedRevision: 1, model: "gpt-next", reasoningEffort: "high",
      charter: "Use the new charter on future turns.", permissionProfileId: "read_only", providerLaunchPolicy: { approvalPolicy: "ask" },
    });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.configuration?.config_revision, 2);
    assert.equal(updated.configuration?.runtime_configuration_revision, 1);
    const conflict = await store.updateAgentConfiguration(2, {
      agentId: entry.id, expectedRevision: 1, model: "ignored", reasoningEffort: null,
      charter: "ignored", permissionProfileId: null, providerLaunchPolicy: {},
    });
    assert.equal(conflict.outcome, "conflict");
    assert.equal((await store.load()).generation, 2, "a revision conflict must not advance manifest generation");
    await store.replaceEntry(2, { ...entry, observed_state: "idle" });
    const afterLifecycleReplacement = await store.getAgentConfiguration(entry.id);
    assert.equal(afterLifecycleReplacement?.model, "gpt-next");
    assert.equal(afterLifecycleReplacement?.charter, "Use the new charter on future turns.");
    assert.equal(afterLifecycleReplacement?.config_revision, 2);
    assert.equal(afterLifecycleReplacement?.runtime_configuration_revision, 1);
    const manifest = await store.load();
    assert.equal(manifest.entries[0]?.model, "gpt-next");
    assert.equal(Object.hasOwn(manifest.entries[0]!, "config_revision"), false, "legacy manifest projection never leaks Inspector bookkeeping");
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("room-move journal is request-idempotent and exact-generation phase fenced", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
    const cursorDatabase = new DatabaseSync(env.databasePath);
    try {
      cursorDatabase.prepare("INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES(?,?,?,?)")
        .run(entry.id, entry.room_id, "msg_17", "2026-07-19T00:00:00.000Z");
    } finally { cursorDatabase.close(); }
    const coordinates = {
      operation_id: "move_1", request_id: "request_1", agent_id: entry.id, source_room_id: entry.room_id,
      destination_room_id: "room_2", daemon_generation: 7, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session_1", activating_inbox_item_id: null, provider_turn_id: null, effect_id: null, phase: "prepared" as const,
    };
    const prepared = await store.prepareRoomMove(coordinates);
    assert.equal(prepared.created, true);
    assert.equal(prepared.move.source_cursor_present, true);
    assert.equal(prepared.move.source_cursor, "msg_17");
    assert.equal(prepared.move.source_credentials_revoked, false);
    assert.equal((await store.prepareRoomMove(coordinates)).created, false);
    await assert.rejects(() => store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 8, expectedExecutionGenerationId: "run_1", from: ["prepared"], to: "waiting_for_current_turn" }), ManifestConflictError);
    const waiting = await store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 7, expectedExecutionGenerationId: "run_1", from: ["prepared"], to: "waiting_for_current_turn" });
    assert.equal(waiting.phase, "waiting_for_current_turn");
    const acknowledged = await store.advanceRoomMove({ operationId: "move_1", agentId: entry.id, expectedDaemonGeneration: 7, expectedExecutionGenerationId: "run_1", from: ["waiting_for_current_turn"], to: "waiting_for_current_turn", sourceCredentialsRevoked: true });
    assert.equal(acknowledged.source_credentials_revoked, true);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.equal((await reopened.pendingRoomMoves(entry.id))[0]?.operation_id, "move_1");
    assert.equal((await reopened.pendingRoomMoves(entry.id))[0]?.source_credentials_revoked, true);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge proves preconditions and deletes local agent rows atomically without touching its worktree", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const worktreeMarker = join(env.root, "preserved-worktree.txt");
  await writeFile(worktreeMarker, "keep");
  const attemptId = "attempt_purge";
  const executionId = "run_purge";
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_purge", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: worktreeMarker, work_attempt_id: attemptId,
    provider_ref: {
      ...entry.provider_ref!, work_attempt_id: attemptId, execution_generation_id: executionId,
    },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write(0, [stopped]);
    seedTerminalAttempt(env.databasePath, attemptId, executionId, worktreeMarker);
    const prepared = await store.preparePurge(1, { operationId: "purge_1", requestId: "purge_1", agentId: stopped.id, daemonGeneration: 3, externalRevokeRequired: false });
    assert.equal(prepared.purge.phase, "local_commit");
    assert.equal(prepared.purge.attached_work_attempt_id, attemptId);
    assert.equal(prepared.purge.preserved_workspace_path, worktreeMarker);
    await store.close(); // crash boundary after durable preparation
    const reopened = new ManifestStore(env.databasePath);
    const committed = await reopened.commitPurge(1, { operationId: "purge_1", agentId: stopped.id, daemonGeneration: 3 });
    assert.equal(committed.generation, 2);
    assert.equal(committed.purge.phase, "complete");
    assert.equal(await reopened.getEntry(stopped.id), undefined);
    assert.equal(await readFile(worktreeMarker, "utf8"), "keep");
    const database = new DatabaseSync(env.databasePath);
    try {
      for (const [table, column, value] of [
        ["agent_identities", "agent_id", stopped.id], ["worker_session_bindings", "entry_id", stopped.id], ["supervised_agent_inbox", "agent_id", stopped.id],
        ["work_attempts", "work_attempt_id", attemptId], ["work_attempt_lease_epochs", "work_attempt_id", attemptId],
        ["work_attempt_checkpoints", "work_attempt_id", attemptId], ["work_attempt_executions", "work_attempt_id", attemptId],
      ] as const) {
        assert.equal(Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value) as { count: number }).count), 0);
      }
      assert.equal((database.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id='purge_1'").get() as { phase: string }).phase, "complete");
    } finally { database.close(); }
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge generation adoption never substitutes for durable credential-revocation acknowledgement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_revoke", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: null, work_attempt_id: null, provider_ref: null, activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write(0, [stopped]);
    const prepared = await store.preparePurge(1, {
      operationId: "purge_revoke", requestId: "purge_revoke", agentId: stopped.id, daemonGeneration: 8, externalRevokeRequired: true,
    });
    assert.equal(prepared.purge.phase, "revoking_credentials");
    await store.close(); // daemon crashes after prepare but before Electron revoke
    const reopened = new ManifestStore(env.databasePath);
    const adopted = await reopened.adoptPurgeDaemonGeneration({
      operationId: "purge_revoke", agentId: stopped.id, expectedDaemonGeneration: 8, daemonGeneration: 9,
    });
    assert.equal(adopted.daemon_generation, 9);
    assert.equal(adopted.phase, "revoking_credentials", "generation N+1 must still require an explicit durable revoke acknowledgement");
    const acknowledged = await reopened.markPurgeCredentialsRevoked({
      operationId: "purge_revoke", agentId: stopped.id, expectedDaemonGeneration: 9,
    });
    assert.equal(acknowledged.phase, "local_commit");
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge commit rolls every agent and work-attempt deletion back on a late injected failure", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const worktreeMarker = join(env.root, "rollback-worktree");
  const attemptId = "attempt_rollback";
  const executionId = "run_rollback";
  const stopped: DaemonManifestEntry = {
    ...entry, id: "agent_rollback", desired_state: "stopped", observed_state: "stopped", condition: "none", last_error: null,
    workspace_path: worktreeMarker, work_attempt_id: attemptId,
    provider_ref: { ...entry.provider_ref!, work_attempt_id: attemptId, execution_generation_id: executionId },
    activity: [], turn_control: null, last_worker_binding: null,
    workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null },
  };
  try {
    await store.write(0, [stopped]);
    seedTerminalAttempt(env.databasePath, attemptId, executionId, worktreeMarker);
    await store.preparePurge(1, {
      operationId: "purge_rollback", requestId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2, externalRevokeRequired: false,
    });
    const injector = new DatabaseSync(env.databasePath);
    try {
      injector.exec(`CREATE TRIGGER inject_purge_rollback BEFORE DELETE ON agent_identities
        WHEN old.agent_id='agent_rollback' BEGIN SELECT RAISE(ABORT,'injected purge rollback'); END`);
    } finally { injector.close(); }
    await assert.rejects(
      () => store.commitPurge(1, { operationId: "purge_rollback", agentId: stopped.id, daemonGeneration: 2 }),
      /injected purge rollback/,
    );
    const database = new DatabaseSync(env.databasePath);
    try {
      assert.equal(Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as { generation: number }).generation), 1);
      assert.equal((database.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id='purge_rollback'").get() as { phase: string }).phase, "local_commit");
      for (const [table, column, value] of [
        ["agent_identities", "agent_id", stopped.id], ["work_attempts", "work_attempt_id", attemptId],
        ["work_attempt_lease_epochs", "work_attempt_id", attemptId], ["work_attempt_checkpoints", "work_attempt_id", attemptId],
        ["work_attempt_executions", "work_attempt_id", attemptId],
      ] as const) {
        assert.equal(Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value) as { count: number }).count), 1);
      }
    } finally { database.close(); }
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("purge rejection leaves generation, identity, and journal unchanged", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry]);
    await assert.rejects(() => store.preparePurge(1, { operationId: "purge_blocked", requestId: "purge_blocked", agentId: entry.id, daemonGeneration: 1, externalRevokeRequired: true }), /fully stopped/);
    assert.equal((await store.load()).generation, 1);
    assert.ok(await store.getEntry(entry.id));
    assert.equal(await store.getPurge("purge_blocked"), null);
  } finally { await store.close(); await env.cleanup(); }
});

test("v10 canonical validation rejects a malformed durable-operation index", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try { await store.write(0, [entry]); } finally { await store.close(); }
  const database = new DatabaseSync(env.databasePath);
  try {
    database.exec("DROP INDEX one_active_agent_room_move; CREATE UNIQUE INDEX one_active_agent_room_move ON agent_room_moves(agent_id,updated_at) WHERE phase NOT IN ('active','failed')");
  } finally { database.close(); }
  const reopened = new ManifestStore(env.databasePath);
  try { await assert.rejects(() => reopened.load(), /index one_active_agent_room_move is invalid/); }
  finally { await reopened.close(); await env.cleanup(); }
});

const terminal = {
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

const entry: DaemonManifestEntry = {
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

const owner: LegacyLaneOwner = {
  reservation_id: "reservation_1",
  room_id: "room_1",
  provider: "codex",
  owner_pid: 123,
  owner_process_identity: "birth-123",
  state: "active",
  session_id: "session_legacy",
  created_at: "2026-07-19T00:00:00.000Z",
  updated_at: "2026-07-19T00:00:01.000Z",
};

async function fixture(): Promise<{ root: string; databasePath: string; legacyPath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-manifest-sqlite-"));
  return {
    root,
    databasePath: join(root, "daemon-state.sqlite"),
    legacyPath: join(root, "daemon-manifest.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function storedManifest(manifest: DaemonManifest): string {
  const checksum = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return `${JSON.stringify({ manifest, checksum })}\n`;
}

function withRuntimeIdentity(item: DaemonManifestEntry): DaemonManifestEntry {
  const runId = item.provider_ref?.execution_generation_id;
  return runId ? { ...item, run_id: runId, deployment_id: serializeDaemonDeploymentId(item.id, runId) } : item;
}

function removePostV5DeliveryTables(database: DatabaseSync): void {
  database.exec(`
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

function assertRoomScopedV9DeliveryShape(database: DatabaseSync): void {
  assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
  assert.equal((database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, 10);
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as { sql: string };
  const observed = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_observed_messages'").get() as { sql: string };
  const publications = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as { sql: string };
  assert.match(inbox.sql, /UNIQUE\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(observed.sql, /PRIMARY KEY\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i);
  assert.match(publications.sql, /FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

function seedTerminalAttempt(databasePath: string, attemptId: string, executionId: string, workspacePath: string): void {
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

test("SQLite manifest round-trips the flat wire projection from relational domain tables", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const undefinedPolicyEntry = { ...entry, id: "agent_2", provider_launch_policy: undefined };
    const saved = await store.write(0, [entry, undefinedPolicyEntry], [owner]);
    assert.deepEqual(await store.load(), saved);
    assert.equal(Object.hasOwn(saved.entries[1]!, "provider_launch_policy"), false);

    const database = (store as unknown as { database: DatabaseSync }).database;
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM agent_identities").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM runtime_deployments").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM activity_events").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps").get() as { count: number }).count, 4);
    assert.equal((database.prepare("SELECT terminal_cause FROM reconciliation_notices WHERE agent_id = ?").get(entry.id) as { terminal_cause: string }).terminal_cause, terminal.terminal_cause);
    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(env.databasePath)).mode & 0o777, 0o600);

    await store.close();
    await assert.rejects(() => store.load(), /closed/);
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual(await reopened.load(), saved);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("SQLite manifest generation CAS serializes independent connections without losing agents", async () => {
  const env = await fixture();
  const first = new ManifestStore(env.databasePath);
  const second = new ManifestStore(env.databasePath);
  try {
    const entries = [entry, { ...entry, id: "agent_2", display_name: "OwlSolar" }];
    await first.write(0, entries);
    assert.equal((await second.load()).generation, 1);
    const results = await Promise.allSettled([
      first.write(1, entries.map((item) => ({ ...item, observed_state: "idle" as const }))),
      second.write(1, entries.map((item) => ({ ...item, observed_state: "paused" as const }))),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    const durable = await first.load();
    assert.equal(durable.generation, 2);
    assert.deepEqual(durable.entries.map((item) => item.id), ["agent_1", "agent_2"]);
    assert.equal(new Set(durable.entries.map((item) => item.observed_state)).size, 1);
  } finally {
    await first.close();
    await second.close();
    await env.cleanup();
  }
});

test("legacy JSON imports once after checksum validation and is retained as a backup", async () => {
  const env = await fixture();
  const manifest: DaemonManifest = { generation: 41, entries: [entry], legacy_lane_owners: [owner] };
  const imported = { ...manifest, entries: manifest.entries.map(withRuntimeIdentity) };
  await writeFile(env.legacyPath, storedManifest(manifest), { mode: 0o600 });
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    assert.deepEqual(await store.load(), imported);
    await assert.rejects(() => readFile(env.legacyPath), { code: "ENOENT" });
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
    await store.close();
    const reopened = new ManifestStore(env.databasePath, env.legacyPath);
    assert.deepEqual(await reopened.load(), imported);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("invalid legacy checksums quarantine the source and durably block empty startup", async () => {
  const env = await fixture();
  await writeFile(env.legacyPath, JSON.stringify({ manifest: { generation: 9, entries: [entry] }, checksum: "invalid" }));
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    await assert.rejects(() => store.load(), /checksum validation/);
    await assert.rejects(() => store.load(), /migration is blocked/);
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(env.root));
    assert.ok(names.some((name) => name.startsWith("daemon-manifest.json.corrupt-")));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("a post-commit backup failure retries idempotently without reimporting", async () => {
  const env = await fixture();
  const manifest: DaemonManifest = { generation: 7, entries: [entry] };
  const imported = { ...manifest, entries: manifest.entries.map(withRuntimeIdentity) };
  await writeFile(env.legacyPath, storedManifest(manifest));
  await mkdir(`${env.legacyPath}.migrated-backup`);
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    await assert.rejects(() => store.load());
    await rm(`${env.legacyPath}.migrated-backup`, { recursive: true });
    assert.deepEqual(await store.load(), imported);
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("future SQLite schema versions are rejected without being downgraded", async () => {
  const env = await fixture();
  const database = new DatabaseSync(env.databasePath);
  database.exec("PRAGMA user_version = 11");
  database.close();
  const store = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(() => store.load(), /schema version 11/);
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 11);
    inspection.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("manifest metadata schema disagreement is rejected on reopen", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.load();
    await initialized.close();
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE manifest_metadata SET schema_version = 11 WHERE singleton = 1").run();
    database.close();
    const reopened = new ManifestStore(env.databasePath);
    await assert.rejects(() => reopened.load(), /metadata schema version 11/);
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("contradictory SQLite and metadata version pairs reject before migration", async () => {
  for (const pair of [
    { userVersion: 1, metadataVersion: 2, pattern: /version pair is inconsistent/ },
    { userVersion: 2, metadataVersion: 1, pattern: /version pair is inconsistent/ },
    { userVersion: 1, metadataVersion: 11, pattern: /metadata schema version 11/ },
  ]) {
    const env = await fixture();
    const initialized = new ManifestStore(env.databasePath);
    try {
      await initialized.load();
      await initialized.close();
      const database = new DatabaseSync(env.databasePath);
      database.exec(`PRAGMA user_version = ${pair.userVersion}`);
      database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1").run(pair.metadataVersion);
      database.close();

      const rejected = new ManifestStore(env.databasePath);
      await assert.rejects(() => rejected.load(), pair.pattern);
      await rejected.close();

      const inspection = new DatabaseSync(env.databasePath);
      assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, pair.userVersion);
      assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, pair.metadataVersion);
      inspection.close();
    } finally {
      await initialized.close();
      await env.cleanup();
    }
  }
});

test("physical v1-v4 databases with no delivery tables advance to the complete v10 shape before stamping markers", async () => {
  for (const version of [1, 2, 3, 4]) {
    const env = await fixture();
    const initial = new ManifestStore(env.databasePath);
    try {
      const expected = await initial.write(0, [entry]);
      await initial.close();
      const historical = new DatabaseSync(env.databasePath);
      removePostV5DeliveryTables(historical);
      historical.exec(`UPDATE manifest_metadata SET schema_version = ${version} WHERE singleton = 1; PRAGMA user_version = ${version}`);
      assert.equal(
        (historical.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as { count: number }).count,
        0,
        `v${version} fixture has no delivery inbox table`,
      );
      historical.close();

      const migrated = new ManifestStore(env.databasePath);
      assert.deepEqual(await migrated.load(), expected, `v${version} preserves manifest data`);
      await migrated.close();

      const inspection = new DatabaseSync(env.databasePath);
      assertRoomScopedV9DeliveryShape(inspection);
      assert.equal(
        (inspection.prepare("SELECT run_id FROM runtime_deployments WHERE agent_id=?").get(entry.id) as { run_id: string }).run_id,
        entry.provider_ref?.execution_generation_id,
        `v${version} retains runtime identity`,
      );
      inspection.close();

      const reopened = new ManifestStore(env.databasePath);
      assert.deepEqual(await reopened.load(), expected, `v${version} second reopen is stable`);
      await reopened.close();
    } finally {
      await initial.close();
      await env.cleanup();
    }
  }
});

test("v1 daemon state migrates transactionally to v2 and normalizes exit timestamps", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    const invalid = { ...entry, id: "legacy_undefined", display_name: "Legacy Undefined" };
    await initial.write(0, [entry, invalid]);
    await initial.close();

    const v1 = new DatabaseSync(env.databasePath);
    v1.exec("ALTER TABLE agent_configurations DROP COLUMN provider_launch_policy_undefined");
    v1.exec("ALTER TABLE runtime_deployments DROP COLUMN provider_process_identity_present");
    v1.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    v1.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[101,202,303]", entry.id);
    v1.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    v1.prepare("UPDATE agent_configurations SET provider_launch_policy_present = 1, provider_launch_policy_json = NULL WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE agent_launch_intents SET source_repo_path_present = 0, source_repo_path = '/stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare(`
      UPDATE runtime_deployments
      SET workspace_path_present = 0, workspace_path = '/stale',
          work_attempt_id_present = 0, work_attempt_id = 'stale-attempt',
          provider_ref_present = 0, workplace_liveness_present = 1,
          workplace_liveness_state = NULL, workplace_liveness_observed_at = 'stale',
          native_liveness_present = 1, native_liveness_state = NULL,
          native_liveness_observed_at = 'stale', activity_present = 0
      WHERE agent_id = ?
    `).run(invalid.id);
    v1.prepare("UPDATE agent_lifecycle_states SET last_error_present = 0, last_error = 'stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE agent_readiness SET ready_reached_at_present = 0, ready_reached_at = 'stale' WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE turn_control_journals SET turn_control_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE retained_worker_bindings SET last_worker_binding_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE reconciliation_records SET reconciliation_present = 1, consecutive_action_failures = NULL, reconciliation_notices_present = 0 WHERE agent_id = ?").run(invalid.id);
    v1.prepare("UPDATE reconciliation_records SET terminal_actor = NULL WHERE agent_id = ?").run(entry.id);
    v1.prepare("UPDATE reconciliation_notices SET terminal_actor = NULL WHERE agent_id = ?").run(entry.id);
    v1.exec("UPDATE manifest_metadata SET schema_version = 1; PRAGMA user_version = 1");
    const v1ConfigurationColumns = (v1.prepare("PRAGMA table_info(agent_configurations)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(v1ConfigurationColumns.includes("provider_launch_policy_undefined"), false);
    assert.equal((v1.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps WHERE agent_id = ?").get(entry.id) as { count: number }).count, 0);
    v1.close();

    const migrated = new ManifestStore(env.databasePath);
    const state = await migrated.load();
    assert.equal(state.generation, 1, "migration preserves the manifest CAS generation");
    assert.deepEqual(state.entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    assert.equal(Object.hasOwn(state.entries[0]!.reconciliation!, "last_terminal"), false);
    assert.equal(Object.hasOwn(state.entries[0]!.reconciliation_notices![0]!, "terminal"), false);
    const normalized = state.entries.find((candidate) => candidate.id === invalid.id)!;
    for (const optional of [
      "provider_launch_policy", "source_repo_path", "workspace_path", "work_attempt_id",
      "provider_ref", "workplace_liveness", "native_liveness", "activity", "last_error",
      "ready_reached_at", "turn_control", "last_worker_binding", "reconciliation",
      "reconciliation_notices",
    ]) assert.equal(Object.hasOwn(normalized, optional), false, `${optional} is normalized to absence`);
    await migrated.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, 10);
    assert.equal((inspection.prepare("SELECT provider_launch_policy_undefined FROM agent_configurations WHERE agent_id = ?").get(entry.id) as { provider_launch_policy_undefined: number }).provider_launch_policy_undefined, 0);
    assert.equal((inspection.prepare("SELECT provider_process_identity_present FROM runtime_deployments WHERE agent_id = ?").get(entry.id) as { provider_process_identity_present: number }).provider_process_identity_present, 0);
    const preservedRuntime = inspection.prepare("SELECT deployment_id, run_id FROM runtime_deployments WHERE agent_id = ?").get(invalid.id) as { deployment_id: string; run_id: string };
    assert.equal(preservedRuntime.run_id, entry.provider_ref?.execution_generation_id);
    assert.ok(preservedRuntime.deployment_id, "migration preserves deployment identity independently from provider_ref presence");
    for (const table of ["activity_events", "turn_control_stages", "reconciliation_exit_timestamps", "reconciliation_completed_actions", "reconciliation_notices"]) {
      assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = ?`).get(invalid.id) as { count: number }).count, 0, `${table} stale children are removed`);
    }
    const normalizedColumns = inspection.prepare(`
      SELECT runtime.workspace_path, runtime.work_attempt_id, runtime.provider_work_attempt_id,
             runtime.workplace_liveness_state, runtime.native_liveness_state,
             lifecycle.last_error, readiness.ready_reached_at,
             turn_journal.action_id, binding.binding_agent_session_id,
             reconciliation.consecutive_action_failures
      FROM runtime_deployments runtime
      JOIN agent_lifecycle_states lifecycle USING (agent_id)
      JOIN agent_readiness readiness USING (agent_id)
      JOIN turn_control_journals turn_journal USING (agent_id)
      JOIN retained_worker_bindings binding USING (agent_id)
      JOIN reconciliation_records reconciliation USING (agent_id)
      WHERE runtime.agent_id = ?
    `).get(invalid.id) as Record<string, unknown>;
    assert.ok(Object.values(normalizedColumns).every((value) => value === null), "absent optional projections retain no stale payload columns");
    inspection.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    await reopened.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("v2 backfills legacy exit timestamps when normalized table exists but agent rows are absent", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    await initial.write(0, [entry]);
    await initial.close();
    const partial = new DatabaseSync(env.databasePath);
    partial.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    partial.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[111,222]", entry.id);
    partial.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    assert.equal((partial.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps WHERE agent_id = ?").get(entry.id) as { count: number }).count, 0);
    partial.close();

    const repaired = new ManifestStore(env.databasePath);
    assert.deepEqual((await repaired.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [111, 222]);
    await repaired.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("SELECT exit_timestamps_json FROM reconciliation_records WHERE agent_id = ?").get(entry.id) as { exit_timestamps_json: string | null }).exit_timestamps_json, null);
    inspection.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[333]", entry.id);
    inspection.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [111, 222]);
    await reopened.close();
    const finalInspection = new DatabaseSync(env.databasePath);
    assert.equal((finalInspection.prepare("SELECT exit_timestamps_json FROM reconciliation_records WHERE agent_id = ?").get(entry.id) as { exit_timestamps_json: string }).exit_timestamps_json, "[333]", "newer normalized rows are not overwritten by stale legacy JSON");
    finalInspection.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("partially migrated v2 state is repaired transactionally before reads", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    await initial.write(0, [entry]);
    await initial.close();

    const partial = new DatabaseSync(env.databasePath);
    partial.exec("ALTER TABLE runtime_deployments DROP COLUMN provider_process_identity_present");
    partial.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    partial.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[404,505]", entry.id);
    partial.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    assert.equal((partial.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 10);
    assert.equal((partial.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, 10);
    partial.close();

    const repaired = new ManifestStore(env.databasePath);
    const state = await repaired.load();
    assert.equal(state.generation, 1);
    assert.equal(state.entries.length, 1);
    assert.deepEqual(state.entries[0]?.reconciliation?.exit_timestamps_ms, [404, 505]);
    await repaired.close();

    const inspection = new DatabaseSync(env.databasePath);
    const runtimeColumns = (inspection.prepare("PRAGMA table_info(runtime_deployments)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(runtimeColumns.includes("provider_process_identity_present"), true);
    assert.equal((inspection.prepare("SELECT provider_process_identity_present FROM runtime_deployments WHERE agent_id = ?").get(entry.id) as { provider_process_identity_present: number }).provider_process_identity_present, 0);
    assert.equal((inspection.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as { generation: number }).generation, 1);
    inspection.close();
  } finally {
    await initial.close();
    await env.cleanup();
  }
});

test("all explicit optional undefined fields normalize to absence without fabricated state", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const minimal: DaemonManifestEntry = {
    id: "minimal_agent",
    room_id: "room_minimal",
    display_name: "Minimal",
    provider: "codex",
    model: null,
    charter: "Only required state.",
    desired_state: "paused",
    observed_state: "absent",
    condition: "none",
    permission_profile_id: null,
    created_by: "user_1",
    created_at: "2026-07-19T00:00:00.000Z",
    last_error: undefined,
    provider_launch_policy: undefined,
    source_repo_path: undefined,
    workspace_path: undefined,
    work_attempt_id: undefined,
    provider_ref: undefined,
    workplace_liveness: undefined,
    native_liveness: undefined,
    ready_reached_at: undefined,
    activity: undefined,
    turn_control: undefined,
    last_worker_binding: undefined,
    reconciliation: undefined,
    reconciliation_notices: undefined,
  };
  try {
    const saved = await store.write(0, [minimal]);
    const persisted = (await store.load()).entries[0]!;
    assert.deepEqual(persisted, saved.entries[0]);
    for (const optional of [
      "last_error", "provider_launch_policy", "source_repo_path", "workspace_path", "work_attempt_id",
      "provider_ref", "workplace_liveness", "native_liveness", "ready_reached_at", "activity",
      "turn_control", "last_worker_binding", "reconciliation", "reconciliation_notices",
    ]) assert.equal(Object.hasOwn(persisted, optional), false, `${optional} remains absent`);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted activity writes leave every unrelated agent row untouched and avoid full replacement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const others = Array.from({ length: 23 }, (_, index) => ({
      ...entry,
      id: `agent_other_${index}`,
      display_name: `Other Agent ${index}`,
    }));
    const other = others[0]!;
    const created = await store.write(0, [entry, ...others]);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = [
      "agent_identities", "agent_profiles", "agent_room_memberships", "agent_configurations",
      "agent_launch_intents", "runtime_deployments", "activity_events", "agent_lifecycle_states",
      "agent_readiness", "turn_control_journals", "turn_control_stages", "retained_worker_bindings",
      "reconciliation_records", "reconciliation_exit_timestamps", "reconciliation_completed_actions",
      "reconciliation_notices",
    ];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id <> ? ORDER BY agent_id, rowid`).all(entry.id),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the activity path"); };

    const nextEvent = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T00:04:00.000Z", summary: "Targeted event" };
    const result = await store.appendActivity(1, entry.id, nextEvent, "idle", {
      state: "idle", observed_at: nextEvent.observed_at, detail: nextEvent.summary,
    }, 1);
    assert.equal(result.generation, 2);
    assert.deepEqual(result.entry.activity, [nextEvent]);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await store.getEntry(other.id), created.entries.find((candidate) => candidate.id === other.id));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted batch replacement updates multiple agents in one generation without touching unrelated rows", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      ...entry,
      id: `batch_agent_${index}`,
      display_name: `Batch Agent ${index}`,
    }));
    await store.write(0, entries);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = [
      "agent_identities", "agent_profiles", "agent_room_memberships", "agent_configurations",
      "agent_launch_intents", "runtime_deployments", "activity_events", "agent_lifecycle_states",
      "agent_readiness", "turn_control_journals", "turn_control_stages", "retained_worker_bindings",
      "reconciliation_records", "reconciliation_exit_timestamps", "reconciliation_completed_actions",
      "reconciliation_notices",
    ];
    const changedIds = [entries[0]!.id, entries[1]!.id];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id NOT IN (?, ?) ORDER BY agent_id, rowid`).all(...changedIds),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the targeted batch path"); };

    const result = await store.replaceEntriesBatch(1, [
      { ...entries[0]!, reconciliation: { ...entries[0]!.reconciliation!, next_restart_at_ms: 101 } },
      { ...entries[1]!, reconciliation: { ...entries[1]!.reconciliation!, next_restart_at_ms: 202 } },
    ]);
    assert.equal(result.generation, 2, "the batch increments generation once");
    assert.deepEqual(result.entries.map((item) => item.reconciliation?.next_restart_at_ms), [101, 202]);
    assert.deepEqual(snapshot(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("permission housekeeping failure aborts initialization without changing generation", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    assert.deepEqual(await initialized.load(), { generation: 0, entries: [] });
    await initialized.close();

    const failing = new ManifestStore(env.databasePath, undefined, async () => {
      throw new Error("injected permission failure");
    });
    await assert.rejects(() => failing.load(), /injected permission failure/);
    await failing.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as { generation: number }).generation, 0);
    inspection.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.equal((await reopened.write(0, [entry])).generation, 1);
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("fresh schema creation rolls back every DDL statement when initialization fails", async () => {
  const env = await fixture();
  const failing = new ManifestStore(env.databasePath, undefined, undefined, () => {
    throw new Error("injected schema initialization failure");
  });
  try {
    await assert.rejects(() => failing.load(), /injected schema initialization failure/);
    await failing.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'manifest_metadata'").get() as { count: number }).count, 0);
    inspection.close();

    const recovered = new ManifestStore(env.databasePath);
    assert.deepEqual(await recovered.load(), { generation: 0, entries: [] });
    await recovered.close();
  } finally {
    await failing.close();
    await env.cleanup();
  }
});

test("targeted writes return their committed projection without any post-commit getEntry", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const initial = await store.write(0, [entry]);
    const raw = store as unknown as { getEntry: () => never };
    raw.getEntry = () => { throw new Error("injected post-commit read failure"); };

    const replaced = await store.replaceEntry(1, { ...initial.entries[0]!, observed_state: "idle" });
    assert.equal(replaced.generation, 2);
    assert.equal(replaced.entry.observed_state, "idle");
    const event = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T01:00:00.000Z" };
    const appended = await store.appendActivity(2, entry.id, event, "working", { state: "active", observed_at: event.observed_at, detail: "working" });
    assert.equal(appended.generation, 3);
    assert.equal(appended.entry.activity?.at(-1)?.sequence, 5);
    const live = await store.updateWorkplaceLiveness(3, entry.id, { state: "reachable", observed_at: event.observed_at, detail: "online" });
    assert.equal(live.generation, 4);
    const batched = await store.replaceEntriesBatch(4, [{ ...live.entry, condition: "none" }]);
    assert.equal(batched.generation, 5);
    assert.equal(batched.entries[0]?.condition, "none");
    assert.equal((await store.load()).generation, 5);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted projection failure occurs before commit and rolls back generation", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const before = await store.write(0, [entry]);
    const raw = store as unknown as {
      readEntryFromDatabase: (database: DatabaseSync, agentId: string) => DaemonManifestEntry | undefined;
    };
    const original = raw.readEntryFromDatabase.bind(store);
    raw.readEntryFromDatabase = () => { throw new Error("injected projection failure"); };
    await assert.rejects(
      () => store.updateWorkplaceLiveness(1, entry.id, { state: "stale", observed_at: null, detail: "stale" }),
      /injected projection failure/,
    );
    raw.readEntryFromDatabase = original;
    assert.deepEqual(await store.load(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("detached deployment identity survives lane-owner full writes and restart", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const neverLaunched: DaemonManifestEntry = {
      ...entry,
      id: "never_launched",
      display_name: "Never Launched",
      provider_ref: undefined,
      work_attempt_id: undefined,
    };
    const created = await store.write(0, [entry, neverLaunched]);
    const launched = created.entries[0]!;
    assert.equal(launched.run_id, entry.provider_ref?.execution_generation_id);
    assert.ok(launched.deployment_id);
    assert.equal(Object.hasOwn(created.entries[1]!, "run_id"), false);

    const detached = await store.replaceEntry(1, { ...launched, provider_ref: undefined });
    assert.equal(Object.hasOwn(detached.entry, "provider_ref"), false);
    assert.equal(detached.entry.run_id, launched.run_id);
    assert.equal(detached.entry.deployment_id, launched.deployment_id);

    const beforeLaneChange = await store.load();
    await store.write(2, beforeLaneChange.entries, [owner]);
    await store.close();

    const reopened = new ManifestStore(env.databasePath);
    const durable = await reopened.load();
    assert.equal(durable.entries[0]?.run_id, launched.run_id);
    assert.equal(durable.entries[0]?.deployment_id, launched.deployment_id);
    assert.equal(Object.hasOwn(durable.entries[0]!, "provider_ref"), false);
    assert.equal(Object.hasOwn(durable.entries[1]!, "run_id"), false);
    const database = (reopened as unknown as { database: DatabaseSync }).database;
    const unlaunchedRuntime = database.prepare("SELECT run_id, deployment_id FROM runtime_deployments WHERE agent_id = ?").get(neverLaunched.id) as { run_id: null; deployment_id: null };
    assert.equal(unlaunchedRuntime.run_id, null);
    assert.equal(unlaunchedRuntime.deployment_id, null);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("v6 repair adds bounded delivery columns without shifting exact turn or cutover identities", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const seeded: DaemonManifestEntry = {
      ...entry,
      delivery_mode: "daemon_inbox",
      delivery_cutover: {
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        provider_continuation_id: "thread_1",
        provider_turn_id: "turn_cutover_exact",
        phase: "uncertain",
        error: "exact turn state unknown",
        updated_at: "2026-07-19T00:02:03.000Z",
      },
      turn_control: { ...entry.turn_control!, provider_turn_id: "turn_legacy_poll" },
    };
    await store.write(0, [seeded]);
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec("ALTER TABLE agent_configurations DROP COLUMN delivery_mode; ALTER TABLE agent_configurations DROP COLUMN delivery_cutover_json; ALTER TABLE turn_control_journals DROP COLUMN provider_turn_id");
    await store.close();

    const repaired = new ManifestStore(env.databasePath);
    const loaded = await repaired.load();
    const restored = loaded.entries[0]!;
    assert.equal(restored.delivery_mode ?? "mcp_polling", "mcp_polling", "old v6 rows safely default to legacy ingress before cutover");
    assert.equal(restored.turn_control?.provider_turn_id, undefined, "missing v6 extension does not shift booleans into the turn id");
    assert.equal(restored.turn_control?.has_correction, true);
    assert.equal(restored.turn_control?.status, "completed");
    assert.equal(restored.delivery_cutover, undefined);
    await repaired.replaceEntry(loaded.generation, {
      ...restored,
      delivery_mode: "daemon_inbox",
      delivery_cutover: {
        work_attempt_id: "attempt_1",
        execution_generation_id: "run_1",
        provider_continuation_id: "thread_1",
        provider_turn_id: "turn_repaired_cutover",
        phase: "prepared",
        error: null,
        updated_at: "2026-07-19T00:02:04.000Z",
      },
      turn_control: { ...restored.turn_control!, provider_turn_id: "turn_repaired_exact" },
    });
    const roundTrip = await repaired.load();
    assert.equal(roundTrip.entries[0]?.delivery_mode, "daemon_inbox");
    assert.equal(roundTrip.entries[0]?.turn_control?.provider_turn_id, "turn_repaired_exact");
    assert.equal(roundTrip.entries[0]?.turn_control?.has_correction, true);
    assert.equal(roundTrip.entries[0]?.turn_control?.status, "completed");
    assert.deepEqual(roundTrip.entries[0]?.delivery_cutover, {
      work_attempt_id: "attempt_1",
      execution_generation_id: "run_1",
      provider_continuation_id: "thread_1",
      provider_turn_id: "turn_repaired_cutover",
      phase: "prepared",
      error: null,
      updated_at: "2026-07-19T00:02:04.000Z",
    });
    await repaired.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});
