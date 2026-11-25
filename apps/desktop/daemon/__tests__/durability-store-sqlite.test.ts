import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DAEMON_STATE_USER_VERSION } from "../daemon-state-database.js";
import { AttemptNotFoundError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestStore } from "../manifest-store.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { assertOwnerPrivate } from "../../electron/__tests__/platform.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-attempt-sqlite-"));
  return { root, json: join(root, "attempts.json"), database: join(root, "daemon-state.sqlite"), cleanup: () => removeTestDirectory(root) };
}

test("malformed work_attempts table is rejected without claiming success", async () => {
  const env = await fixture();
  try {
    const manifest = new ManifestStore(env.database);
    await manifest.load();
    await manifest.close();
    const database = new DatabaseSync(env.database);
    database.exec("DROP TABLE work_attempts; CREATE TABLE work_attempts(foo TEXT) STRICT");
    database.close();
    const store = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), /schema mismatch/i);
    await store.close();
  } finally { await env.cleanup(); }
});

test("schema v1 validation rejects malformed live-execution authority indexes and non-STRICT execution tables", async () => {
  for (const corruption of ["index", "expression-index", "nocase-desc-index", "table"] as const) {
    const env = await fixture();
    try {
      const manifest = new ManifestStore(env.database);
      await manifest.load();
      await manifest.close();
      const database = new DatabaseSync(env.database);
      if (corruption === "index") database.exec("DROP INDEX one_live_work_attempt_execution; CREATE INDEX one_live_work_attempt_execution ON work_attempt_executions(work_attempt_id) WHERE terminal_json IS NULL");
      else if (corruption === "expression-index") database.exec("DROP INDEX one_live_work_attempt_execution; CREATE UNIQUE INDEX one_live_work_attempt_execution ON work_attempt_executions(work_attempt_id, lower(actor)) WHERE terminal_json IS NULL");
      else if (corruption === "nocase-desc-index") database.exec("DROP INDEX one_live_work_attempt_execution; CREATE UNIQUE INDEX one_live_work_attempt_execution ON work_attempt_executions(work_attempt_id COLLATE NOCASE DESC) WHERE terminal_json IS NULL");
      else database.exec(`DROP TABLE work_attempt_executions; CREATE TABLE work_attempt_executions(
        execution_generation_id TEXT, work_attempt_id TEXT, started_at TEXT, actor TEXT, generation INTEGER, terminal_json TEXT
      ); CREATE UNIQUE INDEX one_live_work_attempt_execution ON work_attempt_executions(work_attempt_id) WHERE terminal_json IS NULL`);
      database.close();
      const store = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
      await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), /schema mismatch/i);
      await store.close();
    } finally { await env.cleanup(); }
  }
});

test("SQLite attempt initialization creates no JSON and keeps owner-only database permissions", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), AttemptNotFoundError);
    await store.close();
    await store.close();
    await assert.rejects(() => access(env.json));
    await assertOwnerPrivate(env.database, "file");
    const inspection = new DatabaseSync(env.database);
    assert.equal(String((inspection.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase(), "wal");
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_USER_VERSION);
    inspection.close();
  } finally { await env.cleanup(); }
});
