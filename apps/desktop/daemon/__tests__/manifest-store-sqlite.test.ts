import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "../types.js";

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
  await writeFile(env.legacyPath, storedManifest(manifest), { mode: 0o600 });
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    assert.deepEqual(await store.load(), manifest);
    await assert.rejects(() => readFile(env.legacyPath), { code: "ENOENT" });
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
    await store.close();
    const reopened = new ManifestStore(env.databasePath, env.legacyPath);
    assert.deepEqual(await reopened.load(), manifest);
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
  await writeFile(env.legacyPath, storedManifest(manifest));
  await mkdir(`${env.legacyPath}.migrated-backup`);
  const store = new ManifestStore(env.databasePath, env.legacyPath);
  try {
    await assert.rejects(() => store.load());
    await rm(`${env.legacyPath}.migrated-backup`, { recursive: true });
    assert.deepEqual(await store.load(), manifest);
    assert.equal(await readFile(`${env.legacyPath}.migrated-backup`, "utf8"), storedManifest(manifest));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("future SQLite schema versions are rejected without being downgraded", async () => {
  const env = await fixture();
  const database = new DatabaseSync(env.databasePath);
  database.exec("PRAGMA user_version = 3");
  database.close();
  const store = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(() => store.load(), /schema version 3/);
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
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
    database.prepare("UPDATE manifest_metadata SET schema_version = 3 WHERE singleton = 1").run();
    database.close();
    const reopened = new ManifestStore(env.databasePath);
    await assert.rejects(() => reopened.load(), /metadata schema version 3/);
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("v1 daemon state migrates transactionally to v2 and normalizes exit timestamps", async () => {
  const env = await fixture();
  const initial = new ManifestStore(env.databasePath);
  try {
    await initial.write(0, [entry]);
    await initial.close();

    const v1 = new DatabaseSync(env.databasePath);
    v1.exec("ALTER TABLE agent_configurations DROP COLUMN provider_launch_policy_undefined");
    v1.exec("ALTER TABLE runtime_deployments DROP COLUMN provider_process_identity_present");
    v1.exec("ALTER TABLE reconciliation_records ADD COLUMN exit_timestamps_json TEXT");
    v1.prepare("UPDATE reconciliation_records SET exit_timestamps_json = ? WHERE agent_id = ?").run("[101,202,303]", entry.id);
    v1.prepare("DELETE FROM reconciliation_exit_timestamps WHERE agent_id = ?").run(entry.id);
    v1.exec("UPDATE manifest_metadata SET schema_version = 1; PRAGMA user_version = 1");
    const v1ConfigurationColumns = (v1.prepare("PRAGMA table_info(agent_configurations)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(v1ConfigurationColumns.includes("provider_launch_policy_undefined"), false);
    assert.equal((v1.prepare("SELECT COUNT(*) AS count FROM reconciliation_exit_timestamps").get() as { count: number }).count, 0);
    v1.close();

    const migrated = new ManifestStore(env.databasePath);
    const state = await migrated.load();
    assert.equal(state.generation, 1, "migration preserves the manifest CAS generation");
    assert.deepEqual(state.entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    await migrated.close();

    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, 2);
    assert.equal((inspection.prepare("SELECT provider_launch_policy_undefined FROM agent_configurations WHERE agent_id = ?").get(entry.id) as { provider_launch_policy_undefined: number }).provider_launch_policy_undefined, 0);
    assert.equal((inspection.prepare("SELECT provider_process_identity_present FROM runtime_deployments WHERE agent_id = ?").get(entry.id) as { provider_process_identity_present: number }).provider_process_identity_present, 0);
    inspection.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.load()).entries[0]?.reconciliation?.exit_timestamps_ms, [101, 202, 303]);
    await reopened.close();
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
    assert.equal((partial.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.equal((partial.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, 2);
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
    await store.write(0, [entry, ...others]);
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
    assert.deepEqual(await store.getEntry(other.id), other);
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
