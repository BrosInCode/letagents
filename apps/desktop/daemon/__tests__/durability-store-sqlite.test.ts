import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("concurrent legacy importers serialize one valid record without poisoning migration state", async () => {
  const env = await fixture();
  const children: ChildProcess[] = [];
  try {
    const checksum = createHash("sha256").update("[]").digest("hex");
    await writeFile(env.json, JSON.stringify({ version: 2, attempts: [], checksum }));
    const schema = new ManifestStore(env.database);
    await schema.load();
    await schema.close();

    const count = 8;
    const moduleUrl = new URL("../durability-store.ts", import.meta.url).href;
    const childSource = `
      (async () => {
        const { AttemptNotFoundError, WorkDurabilityStore } = await import(${JSON.stringify(moduleUrl)});
        const store = new WorkDurabilityStore(
          process.env.ATTEMPTS_JSON, process.env.ATTEMPTS_ROOT, undefined, process.env.WORKTREES,
          undefined, undefined, undefined, undefined, undefined, process.env.DATABASE_PATH,
          { after_source_read: () => {
            process.send({ kind: "ready" });
            return new Promise((resolve) => process.once("message", (message) => {
              if (message === "go") resolve();
            }));
          } },
        );
        try {
          await store.getAttempt("00000000-0000-4000-8000-000000000001");
          throw new Error("empty legacy import unexpectedly returned an attempt");
        } catch (error) {
          if (!(error instanceof AttemptNotFoundError)) throw error;
        } finally {
          await store.close();
        }
        process.send({ kind: "done" });
      })().catch((error) => process.send({ kind: "error", error: error?.stack ?? String(error) }));
    `;
    const completions: Promise<void>[] = [];
    let ready = 0;
    for (let index = 0; index < count; index += 1) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
        cwd: process.cwd(),
        env: { ...process.env, ATTEMPTS_JSON: env.json, DATABASE_PATH: env.database, ATTEMPTS_ROOT: join(env.root, `attempt-data-${index}`), WORKTREES: join(env.root, `worktrees-${index}`) },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      completions.push(new Promise<void>((resolveChild, rejectChild) => {
        let stderr = "";
        let settled = false;
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", rejectChild);
        child.on("message", (message: { kind: "ready" | "done" | "error"; error?: string }) => {
          if (message.kind === "ready") {
            ready += 1;
            if (ready === count) {
              for (const candidate of children) candidate.send?.("go");
            }
          } else if (message.kind === "done") {
            settled = true;
            resolveChild();
          } else {
            settled = true;
            rejectChild(new Error(message.error));
          }
        });
        child.once("exit", (code) => { if (!settled) rejectChild(new Error(`legacy import child exited ${code}: ${stderr}`)); });
      }));
    }
    await Promise.all(completions);

    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_records").get() as { count: number }).count, 1);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 0);
    inspection.close();
  } finally {
    for (const child of children) child.kill();
    await env.cleanup();
  }
});

test("a migration failure-record INSERT error leaves the corrupt source in place for a safe retry", async () => {
  const env = await fixture();
  try {
    await writeFile(env.json, "{not-json");
    const schema = new ManifestStore(env.database);
    await schema.load();
    await schema.close();
    const sabotage = new DatabaseSync(env.database);
    sabotage.exec(`CREATE TRIGGER reject_attempt_migration_failure BEFORE INSERT ON migration_failures
      BEGIN SELECT RAISE(ABORT, 'injected migration failure insert'); END`);
    sabotage.close();

    const first = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => first.getAttempt("00000000-0000-4000-8000-000000000001"), /injected migration failure insert/);
    await first.close();
    assert.equal((await stat(env.json)).isFile(), true);
    assert.equal((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")), false);

    const repair = new DatabaseSync(env.database);
    assert.equal((repair.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 0);
    repair.exec("DROP TRIGGER reject_attempt_migration_failure");
    repair.close();
    const retried = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => retried.getAttempt("00000000-0000-4000-8000-000000000001"), CorruptAttemptStoreError);
    await retried.close();
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));
  } finally { await env.cleanup(); }
});

test("a quarantine rename failure remains durably blocked and retries housekeeping on reopen", async () => {
  const env = await fixture();
  try {
    await writeFile(env.json, "{not-json");
    const first = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database, {
      before_quarantine: () => { throw new Error("injected quarantine rename failure"); },
    });
    await assert.rejects(() => first.getAttempt("00000000-0000-4000-8000-000000000001"), CorruptAttemptStoreError);
    await first.close();
    assert.equal((await stat(env.json)).isFile(), true);
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 1);
    inspection.close();

    const reopened = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => reopened.getAttempt("00000000-0000-4000-8000-000000000001"), /previously failed/);
    await reopened.close();
    await assert.rejects(() => access(env.json));
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));
  } finally { await env.cleanup(); }
});

test("a crash after recording migration failure reopens blocked before quarantine housekeeping", async () => {
  const env = await fixture();
  try {
    await writeFile(env.json, "{not-json");
    const first = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database, {
      after_failure_recorded: () => { throw new Error("injected post-record crash"); },
    });
    await assert.rejects(() => first.getAttempt("00000000-0000-4000-8000-000000000001"), /injected post-record crash/);
    await first.close();
    assert.equal((await stat(env.json)).isFile(), true);
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 1);
    inspection.close();

    const reopened = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => reopened.getAttempt("00000000-0000-4000-8000-000000000001"), /previously failed/);
    await reopened.close();
    await assert.rejects(() => access(env.json));
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
    await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), /v3 table work_attempts/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("v3 validation rejects malformed live-execution authority indexes and non-STRICT execution tables", async () => {
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
      await assert.rejects(() => store.getAttempt("00000000-0000-4000-8000-000000000001"), /v3/);
      await store.close();
    } finally { await env.cleanup(); }
  }
});

test("post-commit backup EISDIR is retried without poisoning a valid import", async () => {
  const env = await fixture();
  try {
    const checksum = createHash("sha256").update("[]").digest("hex");
    await writeFile(env.json, JSON.stringify({ version: 2, attempts: [], checksum }));
    await mkdir(`${env.json}.migrated-backup`);
    const first = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => first.getAttempt("00000000-0000-4000-8000-000000000001"), AttemptNotFoundError);
    await first.close();
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_records").get() as { count: number }).count, 1);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 0);
    inspection.close();
    await rm(`${env.json}.migrated-backup`, { recursive: true });
    const reopened = new WorkDurabilityStore(env.json, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, env.database);
    await assert.rejects(() => reopened.getAttempt("00000000-0000-4000-8000-000000000001"), AttemptNotFoundError);
    await reopened.close();
    await assert.rejects(() => access(env.json));
    assert.equal((await stat(`${env.json}.migrated-backup`)).isFile(), true);
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
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
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
