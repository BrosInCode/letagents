import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ActivityWriteBatcher, commitActivityBatch } from "../activity-write-batcher.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { projectStateWatchActivity } from "../state-watch-projection.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonActivityEvent, DaemonManifest, DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import {
  restoreEmptyExecutionDelegationV23Fixture,
  terminal,
  entry,
  fixture,
  seedTerminalExecution,
  storedManifest,
  withImportedRuntimeIdentity,
  removePostV5DeliveryTables,
  assertRoomScopedV9DeliveryShape,
} from "./helpers/manifest-store-sqlite-fixture.js";
import { supervisedAgentsOnly } from "../../electron/__tests__/platform.js";

test("SQLite manifest round-trips the flat wire projection from relational domain tables", { skip: supervisedAgentsOnly }, async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const undefinedPolicyEntry = { ...entry, id: "agent_2", provider_launch_policy: undefined };
    const saved = await store.write(0, [entry, undefinedPolicyEntry]);
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

test("SQLite manifest preserves the complete OpenCode server identity across reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const openModel: DaemonManifestEntry = {
    ...entry,
    id: "agent_open_model",
    provider: "open-model",
    model: "moonshotai/kimi-k3",
    provider_ref: {
      work_attempt_id: "attempt_open_model",
      provider_continuation_id: "session_open_model",
      execution_generation_id: "generation_open_model",
      provider_connection: {
        kind: "opencode_server",
        url: "http://127.0.0.1:52486",
        pid: 45550,
        processIdentity: "opencode-birth-45550",
        serverAuthPath: "/runtime/attempt_open_model/server-auth.json",
      },
    },
  };
  try {
    await store.write(0, [openModel]);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.getEntry(openModel.id))?.provider_ref, openModel.provider_ref);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("v13 state adds the OpenCode control reference before advancing version markers", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.write(0, [entry]);
    await initialized.close();
    const historical = new DatabaseSync(env.databasePath);
    historical.exec(`
      ALTER TABLE runtime_deployments DROP COLUMN provider_server_auth_path;
      UPDATE manifest_metadata SET schema_version=13 WHERE singleton=1;
      PRAGMA user_version=13;
    `);
    historical.close();

    const migrated = new ManifestStore(env.databasePath);
    await migrated.load();
    await migrated.close();
    const inspection = new DatabaseSync(env.databasePath);
    try {
      assert.equal(
        (inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        DAEMON_STATE_SCHEMA_VERSION,
      );
      assert.ok((inspection.prepare("PRAGMA table_info(runtime_deployments)").all() as Array<{ name: string }>)
        .some((column) => column.name === "provider_server_auth_path"));
    } finally {
      inspection.close();
    }
  } finally {
    await initialized.close().catch(() => undefined);
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
  const manifest: DaemonManifest = { generation: 41, entries: [entry] };
  const imported = { ...manifest, entries: manifest.entries.map(withImportedRuntimeIdentity) };
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
  const imported = { ...manifest, entries: manifest.entries.map(withImportedRuntimeIdentity) };
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
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  const database = new DatabaseSync(env.databasePath);
  database.exec(`PRAGMA user_version = ${futureVersion}`);
  database.close();
  const store = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(() => store.load(), new RegExp(`schema version ${futureVersion}`));
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, futureVersion);
    inspection.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("manifest metadata schema disagreement is rejected on reopen", async () => {
  const env = await fixture();
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  const initialized = new ManifestStore(env.databasePath);
  try {
    await initialized.load();
    await initialized.close();
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1").run(futureVersion);
    database.close();
    const reopened = new ManifestStore(env.databasePath);
    await assert.rejects(() => reopened.load(), new RegExp(`metadata schema version ${futureVersion}`));
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("contradictory SQLite and metadata version pairs reject before migration", async () => {
  const futureVersion = DAEMON_STATE_SCHEMA_VERSION + 1;
  for (const pair of [
    { userVersion: 1, metadataVersion: 2, pattern: /version pair is inconsistent/ },
    { userVersion: 2, metadataVersion: 1, pattern: /version pair is inconsistent/ },
    { userVersion: 1, metadataVersion: futureVersion, pattern: new RegExp(`metadata schema version ${futureVersion}`) },
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

test("physical v1-v4 databases retire incompatible Codex births while preserving the complete current shape", async () => {
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
      const retired = {
        ...expected,
        entries: expected.entries.map((candidate) => ({ ...candidate, desired_state: "stopped" as const })),
      };
      assert.deepEqual(await migrated.load(), retired, `v${version} preserves manifest data behind a stopped birth`);
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
      assert.deepEqual(await reopened.load(), retired, `v${version} second reopen is stable`);
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
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((inspection.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
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
    assert.equal((partial.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((partial.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as { schema_version: number }).schema_version, DAEMON_STATE_SCHEMA_VERSION);
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

test("targeted activity writes keep presentation-only events out of lifecycle fields and avoid full replacement", async () => {
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
    const recorded = await store.recordActivity(1, entry.id, nextEvent, {
      observedState: "idle",
      nativeLiveness: { state: "idle", observed_at: nextEvent.observed_at, detail: nextEvent.summary },
    }, 1);
    assert.equal(recorded.generation, 2);
    const result = { entry: (await store.getEntry(entry.id))! };
    assert.deepEqual(result.entry.activity, [nextEvent]);
    assert.equal(result.entry.observed_state, "idle");
    assert.equal(result.entry.native_liveness?.state, "idle");
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await store.getEntry(other.id), created.entries.find((candidate) => candidate.id === other.id));

    const presentationEvent = {
      ...nextEvent,
      sequence: 6,
      observed_at: "2026-07-19T00:05:00.000Z",
      summary: "Presentation-only event",
      status: "working" as const,
    };
    const presentation = await store.appendActivityOnly(2, entry.id, presentationEvent, 1);
    assert.equal(presentation.generation, 3);
    assert.deepEqual(presentation.entry.activity, [presentationEvent]);
    assert.equal(presentation.entry.observed_state, result.entry.observed_state);
    assert.deepEqual(presentation.entry.native_liveness, result.entry.native_liveness,
      "presentation-only persistence cannot acquire lifecycle or liveness authority");
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
    const appended = await store.appendActivityOnly(2, entry.id, event);
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

test("detached deployment identity survives full manifest writes and restart", async () => {
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

    const beforeFullWrite = await store.load();
    await store.write(2, beforeFullWrite.entries);
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
    // Only a predecessor may rebuild missing ingress configuration. Current
    // custody authority must instead fail closed if its column disappears.
    restoreEmptyExecutionDelegationV23Fixture(database);
    database.exec("ALTER TABLE agent_configurations DROP COLUMN polling_contract; UPDATE manifest_metadata SET schema_version=22; PRAGMA user_version=22");
    database.exec("ALTER TABLE agent_configurations DROP COLUMN delivery_mode; ALTER TABLE agent_configurations DROP COLUMN delivery_cutover_json; ALTER TABLE turn_control_journals DROP COLUMN provider_turn_id; ALTER TABLE turn_control_journals DROP COLUMN inbox_item_id; ALTER TABLE turn_control_journals DROP COLUMN correction_text; ALTER TABLE turn_control_journals DROP COLUMN correction_strategy; ALTER TABLE turn_control_journals DROP COLUMN operator_resolution");
    await store.close();

    const repaired = new ManifestStore(env.databasePath);
    const loaded = await repaired.load();
    const restored = loaded.entries[0]!;
    assert.equal(restored.delivery_mode ?? "mcp_polling", "mcp_polling", "old v6 rows safely default to legacy ingress before cutover");
    assert.equal(restored.turn_control?.provider_turn_id, undefined, "missing v6 extension does not shift booleans into the turn id");
    assert.equal(restored.turn_control?.inbox_item_id, undefined);
    assert.equal(restored.turn_control?.correction_text, undefined);
    assert.equal(restored.turn_control?.correction_strategy, undefined);
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

test("physical schema 39 gains explicit local routing without changing an existing cloud manifest", async () => {
  const env = await fixture();
  const original = new ManifestStore(env.databasePath);
  try {
    const expected = await original.write(0, [entry]);
    await original.close();
    const old = new DatabaseSync(env.databasePath);
    old.exec("ALTER TABLE agent_room_memberships DROP COLUMN local_room_id; UPDATE manifest_metadata SET schema_version=39; PRAGMA user_version=39");
    old.close();
    const migrated = new ManifestStore(env.databasePath);
    try {
      assert.deepEqual(await migrated.load(), expected);
      const inspection = new DatabaseSync(env.databasePath);
      assert.equal(inspection.prepare("SELECT local_room_id FROM agent_room_memberships WHERE agent_id=?").get(entry.id)?.local_room_id, null);
      assert.equal(inspection.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
      inspection.close();
    } finally { await migrated.close(); }
  } finally { await original.close(); await env.cleanup(); }
});

test("v43 saved-permission migration is atomic and current missing authority fails closed", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  const schema = new DaemonStateSchema();
  try {
    schema.createSchema(database);
    const closureSql = String(database.prepare("SELECT sql FROM sqlite_master WHERE name='execution_approval_request_closures'").get()!.sql)
      .replace("decision_id TEXT REFERENCES", "decision_id TEXT NOT NULL REFERENCES")
      .replace("dispatch_id TEXT,", "dispatch_id TEXT NOT NULL,");
    database.exec(`DROP TABLE execution_approval_request_closures; ${closureSql}`);
    database.exec(`DROP TABLE host_tool_rule_withdrawals; DROP TABLE host_tool_rule_decisions; DROP TABLE host_tool_rules;
      UPDATE manifest_metadata SET schema_version=43; PRAGMA user_version=43`);
    const fail = new DaemonStateSchema(() => { throw new Error("Interrupted permission migration"); });
    assert.throws(() => fail.createSchema(database), /Interrupted permission migration/);
    assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 43);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='host_tool_rules'").get(), undefined);
    schema.createSchema(database);
    assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM host_tool_rules").get()!.n, 0);
    database.exec("DROP TABLE host_tool_rule_withdrawals");
    assert.throws(() => schema.createSchema(database), /permission storage is missing or invalid/);
  } finally { database.close(); }
});

test("managed launch receipts survive reopening, reject relabeling, and legacy migration never invents provenance", async () => {
  const env = await fixture();
  let store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "managed-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const scope = { agentId: agent.id, executionGenerationId: "run_1", providerConnection: connection };
  const birth = { entry: agent, executionGenerationId: "run_1", providerConnection: connection, appliedRevision: 1,
    requestedAuthorityMode: "typed_shadow" as const, observedAtMs: 100, managedLaunchContract: "a".repeat(64) };
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const written = await store.write(0, [agent]);
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    await assert.rejects(store.checkpointProviderBirth(written.generation, birth, async () => { throw new Error("fenced"); }), /fenced/);
    assert.equal(await store.readManagedLaunchContract(scope), null, "a rejected birth has no receipt");
    const first = await store.checkpointProviderBirth(written.generation, birth);
    assert.equal(await store.readManagedLaunchContract(scope), birth.managedLaunchContract);
    await assert.rejects(store.checkpointProviderBirth(first.generation, { ...birth, managedLaunchContract: "b".repeat(64) }), /cannot change/);
    assert.equal((await store.load()).generation, first.generation);
    assert.equal(await store.readManagedLaunchContract({ ...scope, providerConnection: { ...connection, processIdentity: "other-birth" } }), null);
    await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session", agent_session_token: "test-token", api_url: "https://example.test" });
    const current = await store.validateManagedRuntimeReplacement({ ...scope, configurationRevision: 1, apiUrl: "https://example.test",
      roomId: agent.room_id, workAttemptId: "attempt_1", providerContinuationId: "thread_1" });
    current();
    await store.replaceEntry(first.generation, { ...first.entry, desired_state: "stopped" });
    assert.throws(current, /durable idle authority/);
    await store.close();
    store = new ManifestStore(env.databasePath);
    assert.equal(await store.readManagedLaunchContract(scope), birth.managedLaunchContract);
    await store.close();
    const legacy = new DatabaseSync(env.databasePath);
    legacy.exec("DROP TABLE managed_launch_contracts; PRAGMA user_version=45; UPDATE manifest_metadata SET schema_version=45");
    legacy.close();
    store = new ManifestStore(env.databasePath);
    assert.equal(await store.readManagedLaunchContract(scope), null, "upgrade must not label a surviving process as newly configured");
  } finally { await bindings.close(); await store.close(); await env.cleanup(); }
});


test("a birth committed while a two-entry batch is in flight keeps the other entry's events and skips the retired one", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "handoff-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const peer: DaemonManifestEntry = { ...entry, id: "agent_2", display_name: "Peer", observed_state: "working", turn_control: undefined,
    reconciliation: undefined, reconciliation_notices: undefined, activity: [] };
  const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => true, notifyStateChanged: () => {} });
  const diagnostics: number[] = [];
  const results: { skipped: number; written: number; retriedAfterConflict: boolean }[] = [];
  const batcher = new ActivityWriteBatcher({
    serialize: (operation) => authority.serializeManifestMutationWithoutFlush(operation),
    // Exactly as main.ts commits a batch.
    commit: async (items) => {
      const next = await commitActivityBatch({ store, items, expectedGeneration: authority.generation,
        fence: (commit) => authority.fenceAdmittedTransitionCommit(commit), mayWrite: (agentId) => batcher.mayWrite(agentId) });
      results.push({ skipped: next.skipped, written: next.written, retriedAfterConflict: next.retriedAfterConflict });
      authority.generation = next.generation;
    },
    diagnostic: (_error, dropped) => diagnostics.push(dropped),
  });
  // The retiring daemon's birth path: persistReturnedProviderForHandoff's commit
  // fence, which calls retirePendingActivity right after its commit.
  const retirePendingActivity = (entryId: string) => batcher.retireEntry(entryId);
  const late = (id: string, sequence: number, status: DaemonActivityEvent["status"]) => ({ agentId: id,
    event: { ...entry.activity![0]!, sequence, status, summary: `${id} ${status}` },
    runtimeUpdate: { observedState: status === "idle" ? "idle" as const : "working" as const,
      nativeLiveness: { state: status === "idle" ? "idle" as const : "active" as const, observed_at: "2026-07-19T00:05:00.000Z", detail: `${id} ${status}` } },
    limit: 200 });
  let releaseBirth!: () => void;
  const birthGate = new Promise<void>((resolve) => { releaseBirth = resolve; });
  let birthHoldsStore!: () => void;
  const birthStarted = new Promise<void>((resolve) => { birthHoldsStore = resolve; });
  try {
    authority.generation = (await store.write(0, [agent, peer])).generation;
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    // Admitted just before retirement began: a late working event for the
    // retiring entry, and the peer's final idle state.
    await batcher.serializeAdmission(async () => {
      batcher.admit(late(agent.id, 50, "working"));
      batcher.admit(late(peer.id, 60, "idle"));
    });
    const birth = store.checkpointProviderBirth(authority.generation, {
      entry: { ...agent, observed_state: "idle" }, executionGenerationId: "run_1", providerConnection: connection,
      appliedRevision: 1, requestedAuthorityMode: "typed_shadow", observedAtMs: 100, managedLaunchContract: "c".repeat(64),
    }, async (commit) => {
      birthHoldsStore();
      await birthGate;
      await authority.serializeManifestCommit(async () => { await commit(); retirePendingActivity(agent.id); });
    });
    await birthStarted;
    // The batch reads generation G and waits behind the birth on the store.
    const flushed = batcher.flush();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(results.length, 0, "the batch is in flight, not yet committed");
    releaseBirth();
    authority.generation = (await birth).generation;
    await flushed;
    assert.deepEqual(results, [{ skipped: 1, written: 1, retriedAfterConflict: true }],
      "one whole-batch retry after the conflict; mayWrite skipped the retired entry inside the transaction");
    assert.deepEqual(diagnostics, []);
    const saved = (await store.getEntry(agent.id))!;
    assert.equal(saved.observed_state, "idle", "the birth record keeps its state");
    assert.equal(saved.activity?.some((event) => event.sequence === 50), false, "the older event was not written after the birth");
    const savedPeer = (await store.getEntry(peer.id))!;
    assert.equal(savedPeer.observed_state, "idle", "the peer's final idle state survived the conflict");
    assert.equal(savedPeer.activity?.at(-1)?.sequence, 60);
  } finally { releaseBirth?.(); await batcher.close(); await store.close(); await env.cleanup(); }
});

test("a second generation conflict on the retry drops and reports the batch", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const peer: DaemonManifestEntry = { ...entry, turn_control: undefined, reconciliation: undefined, reconciliation_notices: undefined, activity: [] };
  try {
    const written = await store.write(0, [peer]);
    let conflicts = 0;
    // An out-of-lane writer that commits before every attempt.
    const racing = {
      readGeneration: () => store.readGeneration(),
      recordActivityBatch: async (...args: Parameters<ManifestStore["recordActivityBatch"]>) => {
        conflicts += 1;
        const current = await store.getEntry(peer.id);
        await store.replaceEntry(await store.readGeneration(), { ...current!, display_name: `Peer ${conflicts}` });
        return store.recordActivityBatch(...args);
      },
    };
    await assert.rejects(commitActivityBatch({ store: racing, expectedGeneration: written.generation,
      items: [{ agentId: peer.id, event: { ...entry.activity![0]!, sequence: 70 }, runtimeUpdate: null, limit: 200 }],
      fence: (commit) => commit(), mayWrite: () => true }), ManifestConflictError);
    assert.equal(conflicts, 2, "one whole-batch retry, then the conflict is final");
    assert.equal((await store.getEntry(peer.id))!.activity?.some((event) => event.sequence === 70), false);

    // In the batcher the final conflict drops the whole batch, with no per-event retry.
    const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => false, notifyStateChanged: () => {} },
      await store.readGeneration());
    const dropped: { error: unknown; count: number }[] = [];
    let attempts = 0;
    const batcher = new ActivityWriteBatcher({
      serialize: (operation) => authority.serializeManifestMutationWithoutFlush(operation),
      commit: async (items) => {
        attempts += 1;
        const next = await commitActivityBatch({ store: racing, items, expectedGeneration: authority.generation,
          fence: (commit) => authority.fenceAdmittedTransitionCommit(commit), mayWrite: () => true });
        authority.generation = next.generation;
      },
      diagnostic: (error, count) => dropped.push({ error, count }),
    });
    await batcher.serializeAdmission(async () => {
      batcher.admit({ agentId: peer.id, event: { ...entry.activity![0]!, sequence: 80 }, runtimeUpdate: null, limit: 200 });
      batcher.admit({ agentId: peer.id, event: { ...entry.activity![0]!, sequence: 81 }, runtimeUpdate: null, limit: 200 });
    });
    await batcher.close();
    assert.equal(attempts, 1, "no per-event retry after a conflict");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.count, 2);
    assert.ok(dropped[0]!.error instanceof ManifestConflictError);
  } finally { await store.close(); await env.cleanup(); }
});

test("a managed runtime replacement is refused while a working event is still pending", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "managed-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  let pending: { observedState: DaemonManifestEntry["observed_state"] | null } | null = null;
  store.setPendingActivityState(() => pending);
  const input = { agentId: agent.id, executionGenerationId: "run_1", providerConnection: connection, configurationRevision: 1,
    apiUrl: "https://example.test", roomId: agent.room_id, workAttemptId: "attempt_1", providerContinuationId: "thread_1" };
  try {
    const written = await store.write(0, [agent]);
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    await store.checkpointProviderBirth(written.generation, { entry: agent, executionGenerationId: "run_1", providerConnection: connection,
      appliedRevision: 1, requestedAuthorityMode: "typed_shadow", observedAtMs: 100, managedLaunchContract: "a".repeat(64) });
    await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session", agent_session_token: "test-token", api_url: "https://example.test" });
    pending = { observedState: "working" };
    await assert.rejects(store.validateManagedRuntimeReplacement(input), /durable idle authority/,
      "committed idle is not durable idle while a newer working event is pending");
    pending = { observedState: null };
    const assertDurable = await store.validateManagedRuntimeReplacement(input);
    assertDurable();
    // A working event admitted between the check and the native signal boundary.
    pending = { observedState: "working" };
    assert.throws(assertDurable, /durable idle authority/);
    pending = null;
    assertDurable();
  } finally { await bindings.close(); await store.close(); await env.cleanup(); }
});

test("scoped manifest reads hydrate only matching entries and prepared reads observe new commits", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const saved = await store.write(0, [
      { ...entry, id: "outside", room_id: "other-room" },
      { ...entry, id: "selected-z", room_id: "selected-room" },
      { ...entry, id: "selected-a", room_id: "selected-room" },
    ]);
    const expected = saved.entries.filter(value => value.room_id === "selected-room");
    assert.deepEqual(await store.listRoomEntries("selected-room"), expected);
    assert.deepEqual(await store.getEntry("selected-a"), expected[1]);
    assert.deepEqual(await store.listRoomEntries("missing-room"), []);
    assert.equal(await store.getEntry("missing-entry"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.prepare("UPDATE activity_events SET payload_json='invalid-json' WHERE agent_id=?").run("outside");
      assert.deepEqual(await store.listRoomEntries("selected-room"), expected,
        "an unrelated room payload must not be hydrated");
      assert.deepEqual(await store.getEntry("selected-a"), expected[1]);
      await assert.rejects(store.load(), /JSON/);
      database.prepare("UPDATE agent_profiles SET display_name=? WHERE agent_id=?").run("Changed elsewhere", "selected-a");
      assert.equal((await store.getEntry("selected-a"))?.display_name, "Changed elsewhere");
      assert.deepEqual((await store.listRoomEntries("selected-room")).map(value => value.id), ["selected-z", "selected-a"],
        "room reads preserve canonical sort order");
      assert.equal((await store.listRoomEntries("selected-room"))[1]?.display_name, "Changed elsewhere",
        "cached statements never cache authority results");
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("native activity records avoid history hydration and preserve transactional admission and retention", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const base = entry.activity![0]!;
    await store.write(0, [{ ...entry, observed_state: "recovering",
      activity: [{ ...base, sequence: 100 }, { ...base, sequence: 5 }] }]);
    assert.deepEqual(await store.getActivityState(entry.id), { observed_state: "recovering", last_sequence: 5 },
      "admission uses the last sort-order event, not the maximum sequence");
    assert.equal(await store.getActivityState("missing"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.prepare("UPDATE activity_events SET payload_json='invalid-json' WHERE agent_id=? AND sort_order=0").run(entry.id);
      const recorded = await store.recordActivity(1, entry.id, { ...base, sequence: 6 }, null, 2);
      assert.deepEqual(recorded, { generation: 2 });
      const current = (await store.getEntry(entry.id))!;
      assert.equal(current.observed_state, "recovering", "presentation-only records cannot alter lifecycle state");
      assert.deepEqual(current.native_liveness, entry.native_liveness);
      assert.deepEqual(current.activity?.map(event => event.sequence), [5, 6]);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 6 }, null), /not newer/);
      await assert.rejects(store.recordActivity(1, entry.id, { ...base, sequence: 7 }, null), ManifestConflictError);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 7 }, null, 2,
        async () => { throw new Error("fenced"); }), /fenced/);
      assert.deepEqual(await store.getEntry(entry.id), current);
      assert.equal((await store.load()).generation, 2);
      // A stale scalar admission cannot bypass the sequence check inside the write transaction.
      database.prepare("UPDATE activity_events SET sequence=9 WHERE agent_id=? AND sequence=6").run(entry.id);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 7 }, {
        observedState: "working", nativeLiveness: { state: "active" },
      }), /not newer than 9/);
      assert.equal((await store.getEntry(entry.id))?.observed_state, "recovering", "failed append rolls back runtime fields");
      assert.equal((await store.load()).generation, 2);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("state summary loads only the newest payload-free activity without changing full reads", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const activity = Array.from({ length: 200 }, (_, index) => ({ ...entry.activity![0]!,
      // Deliberately unsorted with ties: SQL must match the stable wire projection.
      sequence: (index * 31) % 47, summary: `event-${index}`, payload: { text: "x".repeat(8192) },
    }));
    await store.write(0, [{ ...entry, activity }]);
    const full = await store.load();
    const summary = await store.load("summary");
    assert.deepEqual(summary, { ...full, entries: full.entries.map(value => ({ ...value, activity: projectStateWatchActivity(value.activity) })) });
    assert.equal(summary.entries[0]!.activity!.length, 16);
    assert.equal(full.entries[0]!.activity!.length, 200);
    assert.deepEqual(await store.getEntry(entry.id), full.entries[0]);
    assert.deepEqual(await store.getEntry(entry.id, "summary"), summary.entries[0]);
    assert.equal(await store.getEntry("missing", "summary"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      // Invalid raw JSON proves the summary path never parses discarded payloads.
      database.exec("UPDATE activity_events SET payload_json='invalid-json'");
      assert.deepEqual(await store.load("summary"), summary);
      assert.deepEqual(await store.getEntry(entry.id, "summary"), summary.entries[0]);
      await assert.rejects(store.load(), /JSON/);
      await assert.rejects(store.getEntry(entry.id), /JSON/);
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT sequence,summary FROM activity_events
        WHERE agent_id=? ORDER BY sequence DESC,sort_order DESC LIMIT 16`).all(entry.id);
      assert.match(JSON.stringify(plan), /activity_events_summary/);
      assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("v47 efficiency migration installs exact read indexes atomically and rejects damaged current indexes", () => {
  const database = new DatabaseSync(":memory:");
  const schema = new DaemonStateSchema();
  const names = ["provider_continuation_repairs_agent_created", "provider_continuation_repairs_inbox_created", "activity_events_summary"];
  try {
    schema.createSchema(database);
    for (const name of names) database.exec(`DROP INDEX ${name}`);
    database.exec("UPDATE manifest_metadata SET schema_version=47; PRAGMA user_version=47");
    new DaemonStateSchema().validateV2Shape(database);
    const interrupted = new DaemonStateSchema(() => { throw new Error("efficiency migration interrupted"); });
    assert.throws(() => interrupted.createSchema(database), /efficiency migration interrupted/);
    assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 47);
    assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()!.schema_version, 47);
    for (const name of names) assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), undefined);
    schema.createSchema(database);
    schema.createSchema(database);
    schema.validateCurrentShape(database);
    for (const [column, index] of [["agent_id", names[0]], ["inbox_item_id", names[1]]]) {
      const plan = JSON.stringify(database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM provider_continuation_repairs
        WHERE ${column}=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).all("missing"));
      assert.ok(plan.includes(index!));
      assert.doesNotMatch(plan, /SCAN|TEMP B-TREE/);
    }
    database.exec(`DROP INDEX ${names[0]}; CREATE INDEX ${names[0]} ON provider_continuation_repairs(updated_at)`);
    assert.throws(() => schema.createSchema(database), /read index .* is missing or invalid/);
  } finally { database.close(); }
});

test("a Cursor prepared turn leaves a claimed notice's batch queued until the turn completes", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-10-01T07:00:00.000Z");
  const bindings = new WorkerBindingStore(env.legacyPath, undefined, env.databasePath);
  const continuation = "cursor-pending:notice-batch";
  const wrapper = { kind: "cursor_cli" as const, pid: 4813, processIdentity: "cursor-wrapper:4813:birth" };
  const cursor: DaemonManifestEntry = {
    ...entry, id: "cursor-notice-batch", room_id: "cursor-notice-room", provider: "cursor", condition: "none", delivery_mode: "daemon_inbox",
    provider_ref: { work_attempt_id: "cursor-notice-attempt", provider_continuation_id: continuation, provider_connection: null,
      execution_generation_id: "cursor-notice-generation" },
    work_attempt_id: "cursor-notice-attempt", turn_control: undefined, last_turn_control_sequence: 0,
  };
  const notice = (id: string) => ({ source_message_id: id, activation: { decision: "activate", reason: "explicit_mention", addressed: true },
    source_message: { id, sender: "letagents", source: "system", agent_identity: null, text: `Board intent bi_${id} was approved.` } });
  const live = async () => (await inbox.receipts(cursor.id)).filter((item) => !item.acknowledged_at).map((item) => item.source_message_id);
  try {
    const generation = (await store.write(0, [cursor])).generation;
    const worker = await bindings.bind({ entry_id: cursor.id, room_id: cursor.room_id, work_attempt_id: cursor.work_attempt_id!,
      execution_generation_id: cursor.provider_ref!.execution_generation_id, agent_session_id: "cursor-notice-worker",
      agent_session_token: "memory-only-test-token", api_url: "https://letagents.test" });
    await inbox.ingestPoll({ agent_id: cursor.id, room_id: cursor.room_id, last_observed_message_id: "msg_3",
      messages: [notice("msg_1"), notice("msg_2"), notice("msg_3")] });
    const head = (await inbox.claimHead(cursor.id))!;
    assert.deepEqual((head.activation.queued_notices as { notices: Array<{ id: string }> }).notices.map((row) => row.id), ["msg_2", "msg_3"]);
    await store.checkpointCursorPreparedTurn(generation, {
      agentId: cursor.id, roomId: cursor.room_id, inboxItemId: head.inbox_item_id, providerTurnId: "cursor-notice-turn",
      providerContinuationId: continuation, workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id, agentSessionId: worker.agent_session_id,
      credentialRef: worker.credential_ref, apiUrl: worker.api_url, expectedProviderContinuationId: continuation,
      expectedProviderConnection: null, providerConnection: wrapper, configurationRevision: 1,
      requestedAuthorityMode: "typed_shadow", observedAt: "2026-10-01T07:00:00.000Z",
    });
    assert.deepEqual(await live(), ["msg_1", "msg_2", "msg_3"], "a prepared turn can still be reset as not dispatched");
    // Delivery's terminal checkpoint for every provider: the idempotent turn start, then the normalized result.
    const authority = { work_attempt_id: cursor.work_attempt_id!, origin_execution_generation_id: cursor.provider_ref!.execution_generation_id,
      provider_continuation_id: continuation };
    await inbox.checkpointTurnStarted(head.inbox_item_id, "cursor-notice-turn", authority);
    await inbox.checkpointNormalizedTerminal({ inbox_item_id: head.inbox_item_id, agent_id: cursor.id,
      execution_generation_id: cursor.provider_ref!.execution_generation_id, provider_turn_id: "cursor-notice-turn",
      outcome: "no_reply", text: null, evidence: "stream",
      terminal_evidence: { turnId: "cursor-notice-turn", providerContinuationId: continuation, outcome: "no_reply", text: null, evidence: "stream" } });
    assert.deepEqual(await live(), ["msg_1"], "the completed Cursor turn settles the notices it carried");
  } finally {
    await inbox.close().catch(() => undefined);
    await bindings.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});
