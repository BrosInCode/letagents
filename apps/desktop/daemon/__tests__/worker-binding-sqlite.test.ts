import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("a paused commit fence holds no SQLite writer lock for an independent store", async () => {
  const env = await fixture(); try {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fenced = new WorkerBindingStore(env.legacy, async (commit) => { await gate; await commit(); }, env.database);
    const independent = new WorkerBindingStore(join(env.root, "other.json"), undefined, env.database);
    const pending = fenced.bind(input("agent_a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const raced = await Promise.race([
      independent.bind(input("agent_b")).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 150)),
    ]);
    assert.equal(raced, "completed"); release(); await pending; await fenced.close(); await independent.close();
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

test("v4 validator rejects malformed private columns and quarantine housekeeping retries", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database); await store.list(); await store.close();
    const db = new DatabaseSync(env.database); db.exec("ALTER TABLE worker_session_bindings ADD COLUMN intruder TEXT"); db.close();
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /invalid columns/);
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
    await assert.rejects(() => new WorkerBindingStore(env.legacy, undefined, env.database).list(), /rowid/);
  } finally { await env.cleanup(); }
});
