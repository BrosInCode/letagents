import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AttemptNotFoundError, CorruptAttemptStoreError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-attempt-sqlite-"));
  return { root, json: join(root, "attempts.json"), database: join(root, "daemon-state.sqlite"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("corrupt legacy attempt state is quarantined and fails closed on every reopen", async () => {
  const env = await fixture();
  try {
    await writeFile(env.json, "{not-json");
    const first = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => first.getAttempt("00000000-0000-4000-8000-000000000001"), CorruptAttemptStoreError);
    await first.close();
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 1);
    inspection.close();
    const reopened = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => reopened.getAttempt("00000000-0000-4000-8000-000000000001"), /previously failed/);
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("malformed pre-existing v3 work tables are rejected without claiming success", async () => {
  const env = await fixture();
  try {
    const manifest = new ManifestStore(env.database);
    await manifest.load();
    await manifest.close();
    const database = new DatabaseSync(env.database);
    database.exec("DROP TABLE work_attempts; CREATE TABLE work_attempts(foo TEXT) STRICT");
    database.close();
    const store = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), /v3 table work_attempts is missing required columns/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("SQLite attempt initialization creates no JSON and keeps owner-only database permissions", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), AttemptNotFoundError);
    await store.close();
    await store.close();
    await assert.rejects(() => access(env.json));
    assert.equal((await stat(env.database)).mode & 0o777, 0o600);
    const inspection = new DatabaseSync(env.database);
    assert.equal(String((inspection.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase(), "wal");
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    inspection.close();
  } finally { await env.cleanup(); }
});

test("v2 to v3 migration rolls back attempt DDL and version markers when interrupted", async () => {
  const env = await fixture();
  try {
    const initial = new ManifestStore(env.database);
    await initial.load();
    await initial.close();
    const v2 = new DatabaseSync(env.database);
    v2.exec(`DROP TABLE work_attempt_checkpoints; DROP TABLE work_attempt_lease_epochs; DROP TABLE work_attempt_executions; DROP TABLE work_attempts;
      UPDATE manifest_metadata SET generation = 7, schema_version = 2; PRAGMA user_version = 2`);
    v2.close();
    const interrupted = new ManifestStore(env.database, undefined, undefined, () => { throw new Error("injected v3 interruption"); });
    await assert.rejects(() => interrupted.load(), /injected v3 interruption/);
    await interrupted.close();
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const metadata = inspection.prepare("SELECT generation, schema_version FROM manifest_metadata").get() as { generation: number; schema_version: number };
    assert.equal(metadata.generation, 7);
    assert.equal(metadata.schema_version, 2);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'work_attempts'").get() as { count: number }).count, 0);
    inspection.close();
  } finally { await env.cleanup(); }
});
