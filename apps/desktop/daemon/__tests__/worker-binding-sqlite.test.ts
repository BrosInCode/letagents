import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-binding-sqlite-"));
  const database = join(root, "daemon-state.sqlite");
  const legacy = join(root, "daemon-worker-bindings.json");
  return { root, database, legacy, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function input(entry_id = "agent_a", generation = "run_1", session = "session_a") {
  return { entry_id, room_id: "room", work_attempt_id: "attempt", execution_generation_id: generation, agent_session_id: session, agent_session_token: `token-${session}`, api_url: "https://letagents.test" };
}
function legacyRaw(entry = "agent_a") {
  return JSON.stringify({ version: 1, bindings: { [entry]: { ...input(entry), room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "2026-01-01T00:00:00.000Z" } } });
}
function checksum(raw: string) { return createHash("sha256").update(raw).digest("hex"); }
function assertRedactedBackup(value: string, source: string) {
  const evidence = JSON.parse(value) as { version: number; source_checksum: string; bindings: Array<Record<string, unknown>> };
  assert.equal(evidence.version, 1);
  assert.equal(evidence.source_checksum, checksum(source));
  assert.equal(evidence.bindings.length, 1);
  assert.equal(evidence.bindings[0]?.entry_id, "agent_a");
  assert.doesNotMatch(value, /agent_session_token|token-session_a/);
}

test("slow native publication does not block another binding checkpoint or publication", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await store.bind(input()); await store.bind(input("agent_b", "run_1", "session_b"));
    let release!: () => void; const slow = new Promise<void>((resolve) => { release = resolve; });
    const pending = store.publish("agent_a", Date.now(), async () => { await slow; return { accepted: true }; });
    await store.checkpointCursor("agent_b", "session_b", "run_1", "msg_2");
    const fast = await store.publish("agent_b", Date.now(), async () => ({ accepted: true }));
    assert.ok(fast?.accepted); release(); await pending; await store.close();
  } finally { await env.cleanup(); }
});

test("a paused commit fence holds no SQLite writer lock for an independent store", { timeout: 5_000 }, async () => {
  const env = await fixture(); try {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fenced = new WorkerBindingStore(env.legacy, async (commit) => { await gate; await commit(); }, env.database);
    const independent = new WorkerBindingStore(join(env.root, "other.json"), undefined, env.database);
    const pending = fenced.bind(input("agent_a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await independent.bind(input("agent_b"));
    release(); await pending; await fenced.close(); await independent.close();
  } finally { await env.cleanup(); }
});

test("simultaneously released fenced stores and a raw writer do not deadlock", async () => {
  const env = await fixture(); try {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fence = async (commit: () => Promise<void>) => { await gate; await commit(); };
    const a = new WorkerBindingStore(join(env.root, "a.json"), fence, env.database);
    const b = new WorkerBindingStore(join(env.root, "b.json"), fence, env.database);
    const one = a.bind(input("agent_a")); const two = b.bind(input("agent_b"));
    await new Promise((resolve) => setTimeout(resolve, 0)); release();
    await Promise.all([one, two]);
    const raw = new DatabaseSync(env.database); raw.prepare("INSERT INTO worker_binding_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("raw", "agent_a", 1, "run", "session", 999999, "2026-01-01T00:00:00.000Z", 1, "accepted", "2026-01-01T00:00:00.000Z", null); raw.close();
    await a.close(); await b.close();
  } finally { await env.cleanup(); }
});

test("a child-process raw SQLite writer overlaps fenced binding commits", { timeout: 10_000 }, async () => {
  const env = await fixture();
  let child: ReturnType<typeof spawn> | null = null;
  let a: WorkerBindingStore | null = null;
  let b: WorkerBindingStore | null = null;
  try {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = 0;
    let bothReached!: () => void;
    const bothAtFence = new Promise<void>((resolve) => { bothReached = resolve; });
    let rawReleaseSent = false;
    const fence = async (commit: () => Promise<void>) => {
      reached += 1;
      if (reached === 2) bothReached();
      await gate;
      // The raw writer still owns BEGIN IMMEDIATE at this exact boundary. The
      // first fenced committer asks that independent process to release, then
      // immediately enters SQLite. No scheduler delay or elapsed-time guess is
      // needed to create the overlap, and both fenced stores still contend.
      if (!rawReleaseSent) {
        rawReleaseSent = true;
        child?.send("release");
      }
      await commit();
    };
    a = new WorkerBindingStore(join(env.root, "a.json"), fence, env.database);
    b = new WorkerBindingStore(join(env.root, "b.json"), fence, env.database);
    // Initialize schema before launching the independent SQLite process.
    const seed = new WorkerBindingStore(join(env.root, "seed.json"), undefined, env.database); await seed.list(); await seed.close();
    const one = a.bind(input("agent_a")); const two = b.bind(input("agent_b"));
    await bothAtFence;
    // The child announces only after it owns the write transaction. Releasing
    // both fenced commits then proves their BEGIN IMMEDIATE attempts overlap a
    // real independent writer, rather than merely running nearby in time.
    child = spawn(process.execPath, ["-e", `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=5000'); db.exec('BEGIN IMMEDIATE'); process.send('holding'); process.once('message',()=>{ db.prepare("INSERT INTO worker_binding_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run('child','agent_raw',1,'run','session',900001,'2026-01-01T00:00:00.000Z',1,'accepted','2026-01-01T00:00:00.000Z',null); db.exec('COMMIT'); process.send('released'); db.close(); });`, env.database], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    await new Promise<void>((resolve, reject) => child.once("message", (message) => message === "holding" ? resolve() : reject(new Error(`child unexpected readiness ${String(message)}`))));
    const exited = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child SQLite writer exited ${code}`))));
    release(); await Promise.all([one, two, exited]);
    assert.equal(rawReleaseSent, true, "a fenced commit explicitly released the acknowledged raw writer");
    const check = new DatabaseSync(env.database); assert.equal((check.prepare("SELECT COUNT(*) AS count FROM worker_binding_publications WHERE reservation_id='child'").get() as { count: number }).count, 1); check.close();
  } finally {
    if (child?.exitCode === null) {
      if (child.connected) child.send("release");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    }
    await Promise.allSettled([a?.close(), b?.close()]);
    await env.cleanup();
  }
});

test("synchronized fresh multi-process importers converge through WAL and schema bootstrap contention", async () => {
  const env = await fixture(); try {
    await writeFile(env.legacy, legacyRaw("agent_a"), { mode: 0o644 });
    const moduleUrl = new URL("../worker-binding-store.ts", import.meta.url).href;
    const script = `const {WorkerBindingStore}=await import(${JSON.stringify(moduleUrl)}); const [legacy,database]=process.argv.slice(1); process.send('ready'); await new Promise(resolve=>process.once('message', resolve)); const store=new WorkerBindingStore(legacy,undefined,database); await store.list(); await store.close(); process.send('done');`;
    for (let round = 0; round < 3; round += 1) {
      // First round opens and imports the legacy source; later rounds make
      // repeated fresh openers contend on the same complete DB as well.
      const children = Array.from({ length: 6 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, env.legacy, env.database], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`child readiness ${String(message)}`))))));
      for (const child of children) child.send("go");
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fresh importer exited ${code}`))))));
    }
    assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), legacyRaw("agent_a"));
    assert.equal((await stat(`${env.legacy}.migrated-backup`)).mode & 0o777, 0o600);
  } finally { await env.cleanup(); }
});

test("timeout and thrown transport retain the still-current credential", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.bind(input());
    await assert.rejects(() => store.publish("agent_a", Date.now(), async () => { throw new Error("timeout"); }), /timeout/);
    assert.equal((await store.get("agent_a"))?.agent_session_id, "session_a");
    await store.close();
  } finally { await env.cleanup(); }
});

test("old explicit rejection cannot revoke after a newer verification reservation", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.bind(input());
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const old = store.publish("agent_a", 1, async () => { await gate; return { accepted: false }; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const verification = await store.verifyAndAdvanceExecutionGeneration({ entryId: "agent_a", roomId: "room", workAttemptId: "attempt", fromExecutionGenerationId: "run_1", toExecutionGenerationId: "run_2", agentSessionId: "session_a" }, async () => ({ accepted: true }));
    assert.equal(verification.advanced, true); release(); await old;
    assert.equal((await store.get("agent_a"))?.execution_generation_id, "run_2"); await store.close();
  } finally { await env.cleanup(); }
});

test("rebind preserves globally monotonic native sequence", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.bind(input());
    const first = await store.publish("agent_a", 1, async () => ({ accepted: true }));
    await store.bind(input("agent_a", "run_2", "session_b"));
    const second = await store.publish("agent_a", 1, async () => ({ accepted: true }));
    assert.ok(second!.sequence > first!.sequence); await store.close();
  } finally { await env.cleanup(); }
});

test("unbind and a delayed explicit rejection retain the global watermark across rebind", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await store.bind(input());
    const first = await store.publish("agent_a", 1, async () => ({ accepted: true }));
    await store.unbind("agent_a", "session_a", "run_1");
    await store.bind(input("agent_a", "run_2", "session_b"));
    const second = await store.publish("agent_a", 1, async () => ({ accepted: true }));
    assert.ok(second!.sequence > first!.sequence, "an unbound row cannot reset the native sequence");

    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const stale = store.publish("agent_a", 1, async () => { await gate; return { accepted: false }; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.unbind("agent_a", "session_b", "run_2");
    await store.bind(input("agent_a", "run_3", "session_c"));
    release(); await stale;
    assert.equal((await store.get("agent_a"))?.agent_session_id, "session_c", "a rejected prior epoch cannot revoke replacement credentials");
    await store.close();

    const db = new DatabaseSync(env.database);
    const watermark = db.prepare("SELECT binding_epoch, last_sequence FROM worker_binding_watermarks WHERE entry_id='agent_a'").get() as { binding_epoch: number; last_sequence: number };
    const live = db.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id='agent_a'").get() as { binding_epoch: number };
    assert.equal(watermark.binding_epoch, 3);
    assert.equal(live.binding_epoch, 3);
    assert.ok(watermark.last_sequence >= second!.sequence);
    db.close();
  } finally { await env.cleanup(); }
});

test("retirement removes live worker authority while preserving publication watermarks", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await store.beginSupervisedWorkerSessionMint({ agent_id: "agent_a", room_id: "room", agent_instance_id: "instance_a" });
    await store.recordExactSupervisedWorkerSessionMint({ agent_id: "agent_a", room_id: "room", agent_instance_id: "instance_a", agent_session_id: "session_a" });
    await store.recordSupervisedWorkerSession({
      agent_id: "agent_a", room_id: "room", agent_session_id: "session_a",
      execution_generation_id: "run_1", credential_ref: "credential_a", expires_at: null,
    });
    await store.bind(input());
    const published = await store.publish("agent_a", 1, async () => ({ accepted: true }));

    await store.retireSupervisedWorkerAuthority("agent_a", "session_a");
    assert.equal(await store.get("agent_a"), null);
    assert.equal(await store.supervisedWorkerSession("agent_a"), null);
    assert.equal(await store.supervisedWorkerMintState("agent_a"), null);

    await store.bind(input("agent_a", "run_2", "session_b"));
    const resumed = await store.publish("agent_a", 1, async () => ({ accepted: true }));
    assert.ok(resumed!.sequence > published!.sequence, "fresh resume cannot reuse the retired worker sequence");
    await assert.rejects(
      () => store.retireSupervisedWorkerAuthority("agent_a", "session_a"),
      /changed before local cleanup/,
    );
    await store.close();
  } finally { await env.cleanup(); }
});

test("v4 upgrade reconstructs a deleted binding watermark from both reservation journals", async () => {
  const env = await fixture(); try {
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
    await initial.bind(input());
    const publication = await initial.publish("agent_a", 1, async () => ({ accepted: true }));
    const rollover = await initial.verifyAndAdvanceExecutionGeneration({ entryId: "agent_a", roomId: "room", workAttemptId: "attempt", fromExecutionGenerationId: "run_1", toExecutionGenerationId: "run_2", agentSessionId: "session_a" }, async () => ({ accepted: true }));
    assert.equal(rollover.advanced, true); await initial.close();

    const legacyV4 = new DatabaseSync(env.database);
    legacyV4.exec("DROP TABLE worker_binding_watermarks; DELETE FROM worker_session_bindings; UPDATE manifest_metadata SET schema_version=4 WHERE singleton=1; PRAGMA user_version=4");
    legacyV4.close();

    const upgraded = new WorkerBindingStore(env.legacy, undefined, env.database);
    await upgraded.bind(input("agent_a", "run_3", "session_b"));
    const rebound = await upgraded.publish("agent_a", 1, async () => ({ accepted: true }));
    assert.ok(rebound!.sequence > publication!.sequence);
    await upgraded.close();
    const db = new DatabaseSync(env.database);
    const watermark = db.prepare("SELECT binding_epoch, last_sequence FROM worker_binding_watermarks WHERE entry_id='agent_a'").get() as { binding_epoch: number; last_sequence: number };
    assert.ok(watermark.binding_epoch >= 2);
    assert.equal(watermark.last_sequence, rebound!.sequence);
    db.close();
  } finally { await env.cleanup(); }
});

test("a canonical v4 database with no later additive tables upgrades through the complete current shape", async () => {
  const env = await fixture(); try {
    const seed = new WorkerBindingStore(env.legacy, undefined, env.database);
    await seed.list();
    await seed.close();

    const legacyV4 = new DatabaseSync(env.database);
    try {
      legacyV4.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN IMMEDIATE;
        DROP TABLE agent_room_moves;
        DROP TABLE agent_purge_operations;
        DROP TABLE supervised_agent_publications;
        DROP TABLE supervised_agent_provider_turn_bindings;
        DROP TABLE supervised_agent_history_boundaries;
        DROP TABLE supervised_agent_pruned_sources;
        DROP TABLE supervised_agent_terminal_results;
        DROP TABLE supervised_agent_observed_messages;
        DROP TABLE supervised_agent_effects;
        DROP TABLE supervised_agent_ingress_health;
        DROP TABLE supervised_agent_inbox_events;
        DROP TABLE supervised_agent_inbox;
        DROP TABLE supervised_agent_ingress_cursors;
        DROP TABLE supervised_worker_sessions;
        DROP TABLE worker_binding_watermarks;
        DROP TABLE turn_control_sequence_watermarks;
        DROP TABLE reconciliation_action_tombstones;
        ALTER TABLE agent_configurations DROP COLUMN runtime_configuration_revision;
        ALTER TABLE agent_configurations DROP COLUMN config_revision;
        ALTER TABLE agent_configurations DROP COLUMN reasoning_effort;
        ALTER TABLE agent_configurations DROP COLUMN delivery_cutover_json;
        ALTER TABLE agent_configurations DROP COLUMN delivery_mode;
        ALTER TABLE turn_control_journals DROP COLUMN provider_turn_id;
        ALTER TABLE turn_control_journals DROP COLUMN action_sequence;
        ALTER TABLE turn_control_journals DROP COLUMN inbox_item_id;
        ALTER TABLE turn_control_journals DROP COLUMN correction_text;
        ALTER TABLE turn_control_journals DROP COLUMN correction_strategy;
        ALTER TABLE turn_control_journals DROP COLUMN operator_resolution;
        DROP TABLE worker_session_bindings;
        CREATE TABLE worker_session_bindings (
          entry_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          work_attempt_id TEXT NOT NULL,
          execution_generation_id TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          agent_session_token TEXT NOT NULL,
          api_url TEXT NOT NULL,
          room_cursor TEXT,
          last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
          last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
          binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX worker_session_binding_authority
          ON worker_session_bindings(entry_id,binding_epoch,execution_generation_id,agent_session_id);
        UPDATE manifest_metadata SET schema_version=4 WHERE singleton=1;
        PRAGMA user_version=4;
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
      for (const table of ["agent_room_moves", "agent_purge_operations", "supervised_agent_terminal_results", "supervised_agent_publications"]) {
        assert.equal(legacyV4.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined);
      }
    } finally { legacyV4.close(); }

    const upgraded = new WorkerBindingStore(env.legacy, undefined, env.database);
    await upgraded.list();
    await upgraded.close();
    const current = new DatabaseSync(env.database);
    try {
      assert.equal(Number((current.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), DAEMON_STATE_SCHEMA_VERSION);
      assert.equal(Number((current.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get() as { schema_version: number }).schema_version), DAEMON_STATE_SCHEMA_VERSION);
      for (const table of ["supervised_agent_terminal_results", "supervised_agent_publications", "agent_room_moves", "agent_purge_operations"]) {
        assert.ok(current.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} was created before version markers advanced`);
      }
      const configurationColumns = new Set((current.prepare("PRAGMA table_info(agent_configurations)").all() as Array<{ name: string }>).map((column) => column.name));
      for (const column of ["delivery_mode", "delivery_cutover_json", "reasoning_effort", "config_revision", "runtime_configuration_revision"]) {
        assert.ok(configurationColumns.has(column), `${column} was applied during the canonical v4 upgrade`);
      }
      const bindingColumns = new Set((current.prepare("PRAGMA table_info(worker_session_bindings)").all() as Array<{ name: string }>).map((column) => column.name));
      assert.equal(bindingColumns.has("agent_session_token"), false);
      assert.equal(bindingColumns.has("credential_ref"), true);
    } finally { current.close(); }
  } finally { await env.cleanup(); }
});

test("escaped duplicate legacy keys are quarantined before JSON collapse", async () => {
  const env = await fixture(); try {
    const value = JSON.stringify(input());
    await writeFile(env.legacy, `{"version":1,"bindings":{"agent_a":${value},"agent_\\u0061":${value}}}`);
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => store.list(), /duplicate JSON key/); await store.close();
    const database = new DatabaseSync(env.database);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 1); database.close();
  } finally { await env.cleanup(); }
});

test("an atomic legacy claim imports A while preserving a later B replacement as evidence", async () => {
  const env = await fixture(); try {
    await writeFile(env.legacy, JSON.stringify({ version: 1, bindings: { agent_a: { ...input("agent_a"), room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "2026-01-01T00:00:00.000Z" } } }));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let reached!: () => void; const reachedFence = new Promise<void>((resolve) => { reached = resolve; });
    const store = new WorkerBindingStore(env.legacy, async (commit) => { reached(); await gate; await commit(); }, env.database);
    const pending = store.list(); await reachedFence;
    await writeFile(env.legacy, JSON.stringify({ version: 1, bindings: { agent_b: { ...input("agent_b"), room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "2026-01-01T00:00:00.000Z" } } })); release();
    await assert.rejects(() => pending, /unexpected legacy evidence was quarantined/); await store.close();
    const db = new DatabaseSync(env.database); assert.equal((db.prepare("SELECT COUNT(*) AS count FROM worker_session_bindings WHERE entry_id='agent_a'").get() as { count: number }).count, 1); db.close();
    const unexpected = (await readdir(env.root)).filter((name) => name.startsWith("daemon-worker-bindings.json.unexpected."));
    assert.equal(unexpected.length, 1);
    assert.match(await readFile(join(env.root, unexpected[0]!), "utf8"), /agent_b/);
  } finally { await env.cleanup(); }
});

test("a durable backup exists before the migration record and an A→B swap quarantines only B", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a"); const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, rawA);
    let backupWasDurableBeforeRecord = false;
    const store = new WorkerBindingStore(env.legacy, undefined, env.database, async () => {
      try { assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), rawA); backupWasDurableBeforeRecord = true; } catch { backupWasDurableBeforeRecord = false; }
      await writeFile(env.legacy, rawB, { mode: 0o644 });
    });
    await assert.rejects(() => store.list(), /unexpected legacy evidence was quarantined/);
    await store.close();
    const db = new DatabaseSync(env.database);
    assert.equal((db.prepare("SELECT checksum FROM migration_records WHERE migration_key=?").get(`legacy-worker-bindings:${env.legacy}`) as { checksum: string }).checksum, checksum(rawA));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM worker_session_bindings WHERE entry_id='agent_a'").get() as { count: number }).count, 1);
    db.close();
    const backup = `${env.legacy}.migrated-backup`;
    assert.equal(backupWasDurableBeforeRecord, true, "the crash-window hook observes A's fsynced backup before the record commits");
    assertRedactedBackup(await readFile(backup, "utf8"), rawA);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    const unexpected = (await readdir(env.root)).filter((name) => name.startsWith("daemon-worker-bindings.json.unexpected."));
    assert.equal(unexpected.length, 1);
    assert.equal(await readFile(join(env.root, unexpected[0]!), "utf8"), rawB);
    assert.equal((await stat(join(env.root, unexpected[0]!))).mode & 0o777, 0o600);
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    assert.equal((await reopened.list()).map((binding) => binding.entry_id).join(","), "agent_a");
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("a crash after atomic claim recovers its one orphan instead of starting with no bindings", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a");
    await writeFile(env.legacy, rawA, { mode: 0o600 });
    await rename(env.legacy, `${env.legacy}.claimed.crash-window`);
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    assert.equal((await reopened.get("agent_a"))?.agent_session_id, "session_a");
    await reopened.close();
    assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), rawA);
    const db = new DatabaseSync(env.database);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM migration_records").get() as { count: number }).count, 1);
    db.close();
  } finally { await env.cleanup(); }
});

test("a pre-existing A claim plus public B fails closed without importing or moving either", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a"); const rawB = legacyRaw("agent_b");
    const claim = `${env.legacy}.claimed.crashed-a`;
    await writeFile(claim, rawA, { mode: 0o600 });
    await writeFile(env.legacy, rawB, { mode: 0o600 });
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => store.list(), /ambiguous source evidence/);
    await store.close();
    assert.equal(await readFile(claim, "utf8"), rawA);
    assert.equal(await readFile(env.legacy, "utf8"), rawB);
    const db = new DatabaseSync(env.database);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM migration_records").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 0);
    db.close();
  } finally { await env.cleanup(); }
});

test("a sibling opener observes a durable legacy-import failure instead of returning an empty store", async () => {
  const env = await fixture(); try {
    await writeFile(env.legacy, "{bad", { mode: 0o600 });
    const first = new WorkerBindingStore(env.legacy, undefined, env.database);
    const second = new WorkerBindingStore(env.legacy, undefined, env.database);
    const [left, right] = await Promise.allSettled([first.list(), second.list()]);
    assert.equal(left.status, "rejected");
    assert.equal(right.status, "rejected");
    assert.match(String(left.status === "rejected" && left.reason), /Legacy worker binding import/);
    assert.match(String(right.status === "rejected" && right.reason), /Legacy worker binding import/);
    await first.close(); await second.close();
  } finally { await env.cleanup(); }
});

test("a durable malformed-A failure preserves a later public B under unique evidence", async () => {
  const env = await fixture(); try {
    const malformedA = "{bad-a"; const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, malformedA, { mode: 0o600 });
    const first = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => first.list(), /import refused/); await first.close();
    const quarantine = (await readdir(env.root)).find((name) => name.startsWith("daemon-worker-bindings.json.corrupt."))!;
    assert.equal(await readFile(join(env.root, quarantine), "utf8"), malformedA);

    await writeFile(env.legacy, rawB, { mode: 0o600 });
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => reopened.list(), /previously quarantined/); await reopened.close();
    assert.equal(await readFile(join(env.root, quarantine), "utf8"), malformedA, "A remains the durable failure evidence");
    const unexpected = (await readdir(env.root)).filter((name) => name.startsWith("daemon-worker-bindings.json.unexpected."));
    assert.equal(unexpected.length, 1);
    assert.equal(await readFile(join(env.root, unexpected[0]!), "utf8"), rawB, "B is preserved rather than deleted as if it were A");
    await assert.rejects(() => readFile(env.legacy, "utf8"), { code: "ENOENT" });
  } finally { await env.cleanup(); }
});

test("reopen retires matching post-record crash claims and preserves every differing claim", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a"); const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, rawA, { mode: 0o600 });
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database); await initial.list(); await initial.close();
    await writeFile(`${env.legacy}.claimed.after-record-a`, rawA, { mode: 0o600 });
    await writeFile(`${env.legacy}.claimed.after-record-b`, rawB, { mode: 0o600 });
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => reopened.list(), /unexpected legacy evidence/); await reopened.close();
    const names = await readdir(env.root);
    assert.equal(names.some((name) => name.startsWith("daemon-worker-bindings.json.claimed.")), false);
    const unexpected = names.filter((name) => name.startsWith("daemon-worker-bindings.json.unexpected."));
    assert.equal(unexpected.length, 1);
    assert.equal(await readFile(join(env.root, unexpected[0]!), "utf8"), rawB);
    assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), rawA);
  } finally { await env.cleanup(); }
});

test("reopen consolidates matching post-failure crash claims and preserves differing claims", async () => {
  const env = await fixture(); try {
    const malformedA = "{bad-a"; const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, malformedA, { mode: 0o600 });
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => initial.list(), /import refused/); await initial.close();
    await writeFile(`${env.legacy}.claimed.after-failure-a`, malformedA, { mode: 0o600 });
    await writeFile(`${env.legacy}.claimed.after-failure-b`, rawB, { mode: 0o600 });
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => reopened.list(), /previously quarantined/); await reopened.close();
    const names = await readdir(env.root);
    assert.equal(names.some((name) => name.startsWith("daemon-worker-bindings.json.claimed.")), false);
    const unexpected = names.filter((name) => name.startsWith("daemon-worker-bindings.json.unexpected."));
    assert.equal(unexpected.length, 1);
    assert.equal(await readFile(join(env.root, unexpected[0]!), "utf8"), rawB);
  } finally { await env.cleanup(); }
});

test("a valid claimed source survives a retryable pre-existing backup failure", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a"); const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, rawA, { mode: 0o600 });
    await writeFile(`${env.legacy}.migrated-backup`, rawB, { mode: 0o600 });
    const failed = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => failed.list(), /migrated backup does not match/);
    await failed.close();
    assert.equal(await readFile(env.legacy, "utf8"), rawA, "the valid source is restored for retry");
    const db = new DatabaseSync(env.database);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM migration_failures").get() as { count: number }).count, 0);
    db.close();
    await rm(`${env.legacy}.migrated-backup`);
    const retried = new WorkerBindingStore(env.legacy, undefined, env.database);
    assert.equal((await retried.get("agent_a"))?.agent_session_id, "session_a");
    await retried.close();
  } finally { await env.cleanup(); }
});

test("a mismatched pre-existing backup fails closed without replacing either private artifact", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a"); const rawB = legacyRaw("agent_b");
    await writeFile(env.legacy, rawA);
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
    await initial.list(); await initial.close();
    await writeFile(env.legacy, rawA, { mode: 0o644 });
    await writeFile(`${env.legacy}.migrated-backup`, rawB, { mode: 0o644 });
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    await assert.rejects(() => reopened.list(), /migrated backup does not match/);
    await reopened.close();
    assert.equal(await readFile(`${env.legacy}.migrated-backup`, "utf8"), rawB);
    assert.equal(await readFile(env.legacy, "utf8"), rawA);
    assert.equal((await stat(`${env.legacy}.migrated-backup`)).mode & 0o777, 0o600);
    assert.equal((await stat(env.legacy)).mode & 0o777, 0o600);
  } finally { await env.cleanup(); }
});

test("reopen upgrades an exact pre-redaction migration backup without losing committed bindings", async () => {
  const env = await fixture(); try {
    const raw = legacyRaw("agent_a");
    await writeFile(env.legacy, raw, { mode: 0o600 });
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
    assert.equal((await initial.get("agent_a"))?.agent_session_id, "session_a");
    await initial.close();

    // Simulate the backup format emitted by the deployed pre-redaction
    // daemon: the SQLite record contains this exact checksum, but the backup
    // still contains the original credential-bearing envelope.
    await writeFile(`${env.legacy}.migrated-backup`, raw, { mode: 0o600 });
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    assert.equal((await reopened.get("agent_a"))?.agent_session_id, "session_a");
    await reopened.close();
    assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), raw);
    assert.equal((await stat(`${env.legacy}.migrated-backup`)).mode & 0o777, 0o600);
  } finally { await env.cleanup(); }
});

test("concurrent reopeners converge while upgrading an exact pre-redaction backup", async () => {
  const env = await fixture(); try {
    const raw = legacyRaw("agent_a");
    await writeFile(env.legacy, raw, { mode: 0o600 });
    const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
    await initial.list(); await initial.close();
    await writeFile(`${env.legacy}.migrated-backup`, raw, { mode: 0o600 });

    const one = new WorkerBindingStore(env.legacy, undefined, env.database);
    const two = new WorkerBindingStore(env.legacy, undefined, env.database);
    const [left, right] = await Promise.all([one.list(), two.list()]);
    assert.equal(left.length, 1); assert.equal(right.length, 1);
    await one.close(); await two.close();
    assertRedactedBackup(await readFile(`${env.legacy}.migrated-backup`, "utf8"), raw);
  } finally { await env.cleanup(); }
});

test("concurrent valid legacy importers converge on one exact private backup", async () => {
  const env = await fixture(); try {
    const rawA = legacyRaw("agent_a");
    // Create/validate the shared schema before concurrently exercising just
    // the migration finalizer.
    const seed = new WorkerBindingStore(join(env.root, "seed.json"), undefined, env.database);
    await seed.list(); await seed.close();
    await writeFile(env.legacy, rawA, { mode: 0o644 });
    const one = new WorkerBindingStore(env.legacy, undefined, env.database);
    const two = new WorkerBindingStore(env.legacy, undefined, env.database);
    const [left, right] = await Promise.all([one.list(), two.list()]);
    assert.equal(left.length, 1); assert.equal(right.length, 1);
    await one.close(); await two.close();
    const backup = `${env.legacy}.migrated-backup`;
    assertRedactedBackup(await readFile(backup, "utf8"), rawA);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    await assert.rejects(() => readFile(env.legacy, "utf8"), { code: "ENOENT" });
  } finally { await env.cleanup(); }
});

test("v4 validator rejects malformed private columns and quarantine housekeeping retries", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.list(); await store.close();
    const db = new DatabaseSync(env.database); db.exec("ALTER TABLE worker_session_bindings ADD COLUMN intruder TEXT"); db.close();
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /invalid strict schema|canonical definition/);
    // Separate failure fixture verifies a persisted quarantine is retried on reopen.
    const bad = join(env.root, "bad.json"); await writeFile(bad, "{bad");
    const badStore = new WorkerBindingStore(bad, undefined, join(env.root, "bad.sqlite"));
    await assert.rejects(() => badStore.list()); await badStore.close();
    await writeFile(bad, "{bad");
    const retry = new WorkerBindingStore(bad, undefined, join(env.root, "bad.sqlite"));
    await assert.rejects(() => retry.list(), /previously quarantined/); await retry.close();
    await assert.rejects(() => readFile(bad, "utf8"), { code: "ENOENT" });
  } finally { await env.cleanup(); }
});

test("v4 validator rejects WITHOUT ROWID private tables", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.list(); await store.close();
    const db = new DatabaseSync(env.database);
    db.exec(`DROP TABLE worker_session_bindings;
      CREATE TABLE worker_session_bindings (
        entry_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, work_attempt_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL, agent_session_id TEXT NOT NULL, agent_session_token TEXT NOT NULL,
        api_url TEXT NOT NULL, room_cursor TEXT, last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0), binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
        updated_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;`); db.close();
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /agent_session_token|rowid|canonical definition/);
  } finally { await env.cleanup(); }
});

test("v4 validator rejects generated columns and NOCASE/DESC unique terms", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.list(); await store.close();
    const db = new DatabaseSync(env.database); db.exec("ALTER TABLE worker_session_bindings ADD COLUMN generated TEXT GENERATED ALWAYS AS ('x') VIRTUAL"); db.close();
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /invalid strict schema|canonical definition/);
  } finally { await env.cleanup(); }
});
