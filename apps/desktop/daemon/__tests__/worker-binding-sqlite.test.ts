import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import { archiveRetiredRuntimes, prepareRetiredRuntimePlan } from "../runtime-recovery-journal.js";
import type { DaemonManifestEntry } from "../types.js";
import type { ProcessIdentity } from "../process-identity.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { assertOwnerPrivate } from "../../electron/__tests__/platform.js";
import { WAIT_SCALE } from "./helpers/daemon-fixture.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-binding-sqlite-"));
  const database = join(root, "daemon-state.sqlite");
  const legacy = join(root, "daemon-worker-bindings.json");
  return { root, database, legacy, cleanup: () => removeTestDirectory(root) };
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

test("reused binding reads observe cursor, epoch and credential replacement across independent writes", async () => {
  const env = await fixture();
  const store = new WorkerBindingStore(env.legacy, undefined, env.database);
  let raw: DatabaseSync | undefined;
  try {
    const first = await store.bind(input());
    assert.deepEqual(await store.get("agent_a"), first);
    assert.deepEqual(await store.list(), [first]);
    assert.equal(await store.credentialFor(first), "token-session_a");
    raw = new DatabaseSync(env.database);
    raw.prepare("UPDATE worker_session_bindings SET room_cursor='msg_42',binding_epoch=binding_epoch+1 WHERE entry_id='agent_a'").run();
    assert.equal((await store.get("agent_a"))?.room_cursor, "msg_42");
    assert.equal((await store.list())[0]?.room_cursor, "msg_42");
    assert.equal(await store.credentialFor(first), null, "prepared epoch reads must not cache credential authority");
    const second = await store.bind(input("agent_a", "run_2", "replacement"));
    assert.deepEqual(await store.list(), [second]);
    assert.equal(await store.credentialFor(first), null);
    assert.equal(await store.credentialFor(second), "token-replacement");
    await store.close();
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    try {
      assert.deepEqual(await reopened.get("agent_a"), second);
      assert.equal(await reopened.credentialFor(second), null, "connection reuse never persists an in-memory credential");
    } finally { await reopened.close(); }
    await assert.rejects(store.get("agent_a"), /closed/);
  } finally { raw?.close(); await store.close(); await env.cleanup(); }
});

test("publication fences keep presentation hints separate from exact rejected-binding invalidation", async () => {
  const env = await fixture();
  const hints: Array<string | false | undefined> = [];
  const store = new WorkerBindingStore(env.legacy, async (commit, notification) => {
    await commit();
    hints.push(notification?.captureAgentId);
  }, env.database);
  try {
    const first = await store.bind(input());
    assert.deepEqual(hints, ["agent_a"]);
    hints.length = 0;
    await store.publish("agent_a", Date.now(), async () => ({ accepted: true }));
    assert.deepEqual(hints, [false, false], "reservation and acceptance still cross their commit fences");
    assert.equal(await store.credentialFor(first), "token-session_a");
    hints.length = 0;
    await assert.rejects(store.publish("agent_a", Date.now(), async () => { throw new Error("offline"); }), /offline/);
    assert.deepEqual(hints, [false, false]);
    assert.ok(await store.get("agent_a"), "transport failure preserves exact binding authority");
    hints.length = 0;
    await store.publish("agent_a", Date.now(), async () => ({ accepted: false }));
    assert.deepEqual(hints, [false, "agent_a"], "explicit rejection refreshes capture for the potentially revoked agent");
    assert.equal(await store.get("agent_a"), null);
    assert.equal(await store.credentialFor(first), null);
    hints.length = 0;
    await store.compactRetainedPublications(1);
    assert.ok(hints.length > 0);
    assert.ok(hints.every((hint) => hint === false), "publication retention still crosses a presentation-only fence");
  } finally { await store.close(); await env.cleanup(); }
});

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

test("a paused commit fence holds no SQLite writer lock for an independent store", { timeout: 5_000 * WAIT_SCALE }, async () => {
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

test("a child-process raw SQLite writer overlaps fenced binding commits", { timeout: 10_000 * WAIT_SCALE }, async () => {
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

test("synchronized fresh multi-process openers converge through WAL and schema v1 bootstrap contention", async () => {
  const env = await fixture(); try {
    const moduleUrl = new URL("../worker-binding-store.ts", import.meta.url).href;
    const script = `const {WorkerBindingStore}=await import(${JSON.stringify(moduleUrl)}); const [legacy,database]=process.argv.slice(1); process.send('ready'); await new Promise(resolve=>process.once('message', resolve)); const store=new WorkerBindingStore(legacy,undefined,database); await store.list(); await store.close(); process.send('done');`;
    for (let round = 0; round < 3; round += 1) {
      const children = Array.from({ length: 6 }, () => spawn(process.execPath, ["--conditions=letagents-source", "--import", "tsx", "--input-type=module", "-e", script, env.legacy, env.database], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`child readiness ${String(message)}`))))));
      for (const child of children) child.send("go");
      const stderr = children.map((child) => { let text = ""; child.stderr?.on("data", (chunk) => { text += String(chunk); }); return () => text; });
      await Promise.all(children.map((child, index) => new Promise<void>((resolve, reject) => child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`fresh opener exited ${code}: ${stderr[index]!().trim()}`))))));
    }
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

test("schema v1 validator rejects tampered worker_session_bindings schema", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.list(); await store.close();
    const db = new DatabaseSync(env.database); db.exec("ALTER TABLE worker_session_bindings ADD COLUMN generated TEXT GENERATED ALWAYS AS ('x') VIRTUAL"); db.close();
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /schema mismatch|unexpected|canonical/i);
  } finally { await env.cleanup(); }
});

function seedCustodyExecution(database: DatabaseSync, id = "run_1", generation = 1, attempt = "attempt") {
  const task = attempt === "attempt" ? "supervised-agent" : attempt;
  database.prepare(`INSERT OR IGNORE INTO work_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    attempt, task, task, 0, attempt === "attempt" ? "/fixture/workspace" : `/fixture/${attempt}`, "repo", "remote", "revision", "/fixture/bare", "active", "2026-09-22T00:00:00Z", null, null, null);
  database.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,?,?,?)").run(id, attempt, "2026-09-22T00:00:00Z", "provider", generation, "{}");
}
const custodyBinding = { entry_id: "agent_a", room_id: "room", api_url: "https://letagents.test", grant_id: "grant-a",
  work_attempt_id: "attempt", execution_generation_id: "run_1", agent_session_id: "session_a", agent_key: "owner/agent-a" };

test("pre-spawn worker custody survives overwrite, unbind and daemon reopen without requiring a heartbeat", async () => {
  const env = await fixture();
  let store = new WorkerBindingStore(env.legacy, undefined, env.database);
  try {
    await store.list();
    const db = new DatabaseSync(env.database);
    seedCustodyExecution(db); seedCustodyExecution(db, "run_2", 2);
    db.close();
    await store.recordExecutionBinding(custodyBinding);
    await store.recordExecutionBinding(custodyBinding);
    await assert.rejects(store.recordExecutionBinding({ ...custodyBinding, agent_key: "other-agent" }), /immutable/);
    await assert.rejects(store.recordExecutionBinding({ ...custodyBinding, work_attempt_id: "other-attempt" }), /different attempt/);
    await store.recordExecutionBinding({ ...custodyBinding, execution_generation_id: "run_2", agent_session_id: "session_b" });
    await store.bind(input("agent_a", "run_2", "session_b"));
    await store.unbind("agent_a");
    await store.close();
    store = new WorkerBindingStore(env.legacy, undefined, env.database);
    const history = await store.executionPredecessors("agent_a", "attempt", "room");
    assert.equal(history.length, 2);
    assert.deepEqual(history.find(record => record.agent_session_id === "session_a")?.authority, custodyBinding);
    assert.deepEqual(await store.executionPredecessors("agent_a", "different-attempt", "room"), []);
    const check = new DatabaseSync(env.database);
    assert.equal(check.prepare("SELECT count(*) AS n FROM worker_binding_publications").get()!.n, 0);
    assert.deepEqual({ ...check.prepare("SELECT task_id,lease_id,current_lease_epoch FROM work_attempts").get()! },
      { task_id: "supervised-agent", lease_id: "supervised-agent", current_lease_epoch: 0 });
    check.close();
  } finally { await store.close(); await env.cleanup(); }
});

test("legacy custody retains unknown generations and only marks exact completed recovery as proven", async () => {
  const env = await fixture();
  const store = new WorkerBindingStore(env.legacy, undefined, env.database);
  try {
    await store.list();
    const db = new DatabaseSync(env.database);
    seedCustodyExecution(db); seedCustodyExecution(db, "run_2", 2);
    db.prepare("INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,'resume','complete',?,?,?,?)")
      .run("recovery-1", "agent_a", "room", "run_1", "birth-1", JSON.stringify({ work_attempt_id: "attempt" }), null, "now", "now");
    db.close();
    for (const generation of ["run_1", "run_2"]) {
      await store.bind(input("agent_a", generation));
      await store.publish("agent_a", Date.now(), async () => ({ accepted: true }));
    }
    await store.unbind("agent_a");
    const history = await store.executionPredecessors("agent_a", "attempt", "room");
    assert.equal(history.length, 2, "an unrecovered generation cannot disappear from the death-proof obligation");
    assert.equal(history.find(record => record.execution_generation_id === "run_1")?.legacy_recovery_complete, true);
    assert.equal(history.find(record => record.execution_generation_id === "run_2")?.legacy_recovery_complete, false);
    assert.ok(history.every(record => record.authority === null), "legacy evidence never invents a launch grant/API receipt");
    assert.ok((await store.executionPredecessors("agent_a", "attempt", "different-room")).every(record => !record.legacy_recovery_complete));
  } finally { await store.close(); await env.cleanup(); }
});

test("explicit recovery covers publication-only and both verification predecessors before lease continuity", async () => {
  const env = await fixture();
  const store = new WorkerBindingStore(env.legacy, undefined, env.database);
  let db: DatabaseSync | undefined;
  try {
    await store.list();
    db = new DatabaseSync(env.database);
    const shadow = new ExecutionShadowStore(db);
    const birth = "Tue Sep 22 01:00:00 2026";
    const runtimes = new Map<string, string>();
    for (const [index, id] of ["published", "verified-from", "verified-to", "current", "other-entry", "other-attempt", "already-bound"].entries()) {
      seedCustodyExecution(db, id, index + 1, id === "other-attempt" ? "other-attempt" : "attempt");
      const pid = 44001 + index;
      const runtime = executionRuntimeStorageIdentity("agent_a", id, "codex_app_server", pid, birth);
      runtimes.set(id, runtime);
      shadow.registerRuntime({ agentId: "agent_a", executionGenerationId: id, runtimeGenerationId: runtime,
        provider: "codex", authorityMode: "typed", configRevision: 1, createdAtMs: 100 });
      if (index < 3) db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id=?").run(JSON.stringify({
        actor: "provider", generation: index + 1, ended_at: "2026-09-22T02:00:00Z", terminal_cause: "crashed",
        provider_continuation_id: "saved-conversation", native_runtime_death: { kind: "codex_app_server", pid, processIdentity: birth },
      }), id);
    }
    // These reservations have no observer, turn or pending inbox. They still
    // belong to the previous session's native-death proof obligation.
    const publish = (reservation: string, owner: string, execution: string, sequence: number) => db!.prepare(
      "INSERT INTO worker_binding_publications VALUES(?,?,1,?,'old-session',?,'now',100,'failed','now',NULL)")
      .run(reservation, owner, execution, sequence);
    publish("publication", "agent_a", "published", 1);
    publish("unrelated-entry", "agent_b", "other-entry", 1);
    publish("unrelated-attempt", "agent_a", "other-attempt", 2);
    publish("exact-custody", "agent_a", "already-bound", 3);
    await store.recordExecutionBinding({ ...custodyBinding, execution_generation_id: "already-bound", agent_session_id: "old-session" });
    db.prepare("INSERT INTO worker_generation_verifications VALUES('verification','agent_a',1,'verified-from','verified-to','old-session',1,'now',100,'lost_race','now',NULL)").run();
    const entry = { id: "agent_a", room_id: "room", provider: "codex", work_attempt_id: "attempt", desired_state: "running",
      provider_ref: { work_attempt_id: "attempt", execution_generation_id: "current", provider_continuation_id: "saved-conversation",
        provider_connection: { kind: "codex_app_server", pid: 44004, processIdentity: birth } } } as DaemonManifestEntry;
    const request = { operationId: "explicit-restart", entryId: "agent_a", roomId: "room", mode: "resume" as const,
      executionGenerationId: "current", runtimeGenerationId: runtimes.get("current")! };
    let predecessorState: "gone" | "live" | "unknown" = "gone";
    const identity: ProcessIdentity = {
      probe: () => { if (predecessorState !== "live") throw Object.assign(new Error(predecessorState), { code: predecessorState === "gone" ? "ESRCH" : "EPERM" }); },
      readBirthIdentity: () => birth, sameBirthIdentity: (actual, expected) => actual === expected,
    };
    const plan = prepareRetiredRuntimePlan(db, request, entry, [], identity);
    assert.deepEqual(plan.evidence.map(value => value.executionGenerationId).sort(), ["published", "verified-from", "verified-to"],
      "worker history must be included even with no unresolved execution work; unrelated entry/attempt are excluded");
    assert.equal(plan.observerJson, null, "no observation is fabricated for worker-only history");
    for (const state of ["live", "unknown"] as const) {
      predecessorState = state;
      assert.throws(() => prepareRetiredRuntimePlan(db!, request, entry, [], identity), /not been proven gone/);
    }
    predecessorState = "gone";
    const exactTerminal = db.prepare("SELECT terminal_json FROM work_attempt_executions WHERE execution_generation_id='published'").get()!.terminal_json;
    db.prepare("UPDATE work_attempt_executions SET terminal_json='{}' WHERE execution_generation_id='published'").run();
    assert.throws(() => prepareRetiredRuntimePlan(db!, request, entry, [], identity), /no exact retired execution record/);
    db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='published'").run(exactTerminal);
    db.exec("BEGIN IMMEDIATE");
    archiveRetiredRuntimes(db, request, { ...entry, desired_state: "paused" }, plan, identity);
    db.exec("COMMIT");
    const history = await store.executionPredecessors("agent_a", "attempt", "room");
    assert.equal(history.length, 4);
    const legacy = history.filter(record => record.execution_generation_id !== "already-bound");
    assert.ok(legacy.every(record => record.legacy_recovery_complete && record.authority === null),
      "completed exact retirement is consumable by lease continuity without inventing historical launch authority");
    assert.equal(history.find(record => record.execution_generation_id === "already-bound")?.authority?.grant_id, "grant-a");
    assert.ok((await store.executionPredecessors("agent_a", "attempt", "different-room")).every(record => !record.legacy_recovery_complete));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM worker_execution_bindings").get()!.n, 1, "only the existing exact receipt remains");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries").get()!.n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()!.n, 0);
    assert.deepEqual(prepareRetiredRuntimePlan(db, request, entry, [], identity).evidence, [], "complete archives are immutable and not repeated");
  } finally { db?.close(); await store.close(); await env.cleanup(); }
});
