import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DaemonStateSchema, openDaemonStateDatabase } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import {
  entriesOverPublicationRetention,
  partitionRetainedPublications,
  prunePublicationsForEntry,
  RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY,
} from "../worker-binding-retention.js";

type Row = Record<string, unknown>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-binding-retention-"));
  return {
    root,
    database: join(root, "daemon-state.sqlite"),
    legacy: join(root, "daemon-worker-bindings.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function openSchema(path: string): Promise<DatabaseSync> {
  return openDaemonStateDatabase(path, (opened) => new DaemonStateSchema().createSchema(opened));
}

/**
 * Reproduce the shape that grew on the measured machine: a long-lived entry
 * republishing the same worker binding every 30 s, across a handful of
 * execution generations, plus one reservation still in flight.
 */
function seedPublications(database: DatabaseSync, input: {
  entryId: string;
  rows: number;
  generations: number;
  reservedAtSequence?: number;
  startSequence?: number;
}): void {
  const insert = database.prepare(`INSERT INTO worker_binding_publications
    (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id,
     sequence, observed_at, observed_at_ms, state, created_at, finalized_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const start = input.startSequence ?? 1_700_000_000_000;
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < input.rows; index += 1) {
    const sequence = start + index;
    const generation = `exec_${Math.floor(index / Math.ceil(input.rows / input.generations))}`;
    const observedAt = new Date(sequence).toISOString();
    const reserved = input.reservedAtSequence === sequence;
    insert.run(
      `${input.entryId}:${sequence}`, input.entryId, generation, `session_${input.entryId}`,
      sequence, observedAt, sequence, reserved ? "reserved" : index % 17 === 0 ? "failed" : "accepted",
      observedAt, reserved ? null : observedAt,
    );
  }
  database.exec("COMMIT");
}

/** The exact query finalizePublication uses to decide whether it may revoke. */
function latestReservation(database: DatabaseSync, entryId: string): Row | undefined {
  return database.prepare(`SELECT reservation_id, sequence FROM (
    SELECT reservation_id, sequence FROM worker_binding_publications WHERE entry_id=?
    UNION ALL SELECT reservation_id, sequence FROM worker_generation_verifications WHERE entry_id=?
  ) ORDER BY sequence DESC LIMIT 1`).get(entryId, entryId) as Row | undefined;
}

function count(database: DatabaseSync, entryId: string): number {
  return Number((database.prepare("SELECT COUNT(*) AS c FROM worker_binding_publications WHERE entry_id=?")
    .get(entryId) as Row).c);
}

test("retention keeps the newest rows, every reservation, and one row per generation", () => {
  const rows = [
    { reservation_id: "r9", sequence: 9, state: "accepted", execution_generation_id: "exec_2", agent_session_id: "s" },
    { reservation_id: "r8", sequence: 8, state: "accepted", execution_generation_id: "exec_2", agent_session_id: "s" },
    { reservation_id: "r7", sequence: 7, state: "reserved", execution_generation_id: "exec_2", agent_session_id: "s" },
    { reservation_id: "r6", sequence: 6, state: "accepted", execution_generation_id: "exec_2", agent_session_id: "s" },
    { reservation_id: "r5", sequence: 5, state: "failed", execution_generation_id: "exec_1", agent_session_id: "s" },
    { reservation_id: "r4", sequence: 4, state: "accepted", execution_generation_id: "exec_1", agent_session_id: "s" },
    { reservation_id: "r3", sequence: 3, state: "accepted", execution_generation_id: "exec_1", agent_session_id: "other" },
    { reservation_id: "r2", sequence: 2, state: "accepted", execution_generation_id: "exec_0", agent_session_id: "s" },
    { reservation_id: "r1", sequence: 1, state: "accepted", execution_generation_id: "exec_0", agent_session_id: "s" },
  ];
  const { retainedIds, deletableIds } = partitionRetainedPublications(rows, 2);

  // Newest two, the in-flight reservation, and the newest row of each
  // (generation, session) pair the legacy predecessor union reads.
  assert.deepEqual(retainedIds, ["r9", "r8", "r7", "r5", "r3", "r2"]);
  assert.deepEqual(deletableIds, ["r6", "r4", "r1"]);
});

test("pruning a bloated journal preserves the latest-reservation lookup and the watermark maxima", async () => {
  const env = await fixture();
  try {
    const database = await openSchema(env.database);
    seedPublications(database, { entryId: "agent_a", rows: 40_000, generations: 4, reservedAtSequence: 1_700_000_012_345 });
    seedPublications(database, { entryId: "agent_b", rows: 10, generations: 1 });

    const before = {
      count: count(database, "agent_a"),
      latest: latestReservation(database, "agent_a"),
      max: database.prepare(`SELECT MAX(sequence) AS s, MAX(observed_at_ms) AS m, MAX(binding_epoch) AS e
        FROM worker_binding_publications WHERE entry_id=?`).get("agent_a") as Row,
      generations: database.prepare(`SELECT DISTINCT execution_generation_id, agent_session_id
        FROM worker_binding_publications WHERE entry_id=? ORDER BY execution_generation_id`).all("agent_a") as Row[],
    };
    assert.equal(before.count, 40_000);

    // Entries under the limit are not even considered.
    assert.deepEqual(entriesOverPublicationRetention(database), ["agent_a"]);

    let deleted = 0;
    for (let pass = 0; pass < 32; pass += 1) {
      database.exec("BEGIN IMMEDIATE");
      const result = prunePublicationsForEntry(database, "agent_a");
      database.exec("COMMIT");
      deleted += result.deleted;
      if (!result.truncated || result.deleted === 0) break;
    }

    const after = count(database, "agent_a");
    console.log(`worker_binding_publications: agent_a 40000 rows -> ${after} retained (${deleted} deleted)`);
    assert.ok(deleted > 39_000, `expected a bulk compaction, deleted only ${deleted}`);
    assert.ok(after < 100, `expected a small retained journal, saw ${after}`);
    assert.ok(after >= RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY);

    // Invariant 1: the "is my reservation still the latest" check is unchanged.
    assert.deepEqual(latestReservation(database, "agent_a"), before.latest);
    // Invariant 2: the v5 watermark derivation reads the same maxima.
    assert.deepEqual(
      database.prepare(`SELECT MAX(sequence) AS s, MAX(observed_at_ms) AS m, MAX(binding_epoch) AS e
        FROM worker_binding_publications WHERE entry_id=?`).get("agent_a"),
      before.max,
    );
    // Invariant 3: the legacy executionPredecessors union still sees every
    // distinct (execution generation, session) pair.
    assert.deepEqual(
      database.prepare(`SELECT DISTINCT execution_generation_id, agent_session_id
        FROM worker_binding_publications WHERE entry_id=? ORDER BY execution_generation_id`).all("agent_a"),
      before.generations,
    );
    // Invariant 4: an in-flight reservation is still finalizable by id.
    assert.equal(Number((database.prepare(`SELECT COUNT(*) AS c FROM worker_binding_publications
      WHERE entry_id=? AND state='reserved'`).get("agent_a") as Row).c), 1);
    // An entry under the limit is untouched.
    assert.equal(count(database, "agent_b"), 10);

    database.close();
  } finally { await env.cleanup(); }
});

test("pruning never removes the only row, and is a no-op under the retention limit", async () => {
  const env = await fixture();
  try {
    const database = await openSchema(env.database);
    seedPublications(database, { entryId: "agent_c", rows: 1, generations: 1 });
    database.exec("BEGIN IMMEDIATE");
    assert.deepEqual(prunePublicationsForEntry(database, "agent_c"), { deleted: 0, truncated: false });
    database.exec("COMMIT");
    assert.equal(count(database, "agent_c"), 1);

    seedPublications(database, { entryId: "agent_d", rows: 32, generations: 3, startSequence: 1_800_000_000_000 });
    database.exec("BEGIN IMMEDIATE");
    assert.equal(prunePublicationsForEntry(database, "agent_d").deleted, 0);
    database.exec("COMMIT");
    assert.equal(count(database, "agent_d"), 32);
    database.close();
  } finally { await env.cleanup(); }
});

test("the store compacts at open and keeps publishing correctly afterwards", async () => {
  const env = await fixture();
  try {
    const seeded = await openSchema(env.database);
    seedPublications(seeded, { entryId: "agent_a", rows: 5_000, generations: 3 });
    seeded.close();

    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await store.bind({
      entry_id: "agent_a", room_id: "room", work_attempt_id: "attempt",
      execution_generation_id: "run_live", agent_session_id: "session_live",
      agent_session_token: "token-session_live", api_url: "https://letagents.test",
    });

    const compaction = await store.compactRetainedPublications();
    assert.equal(compaction.entries, 1);
    assert.ok(compaction.deleted > 4_800, `expected a bulk compaction, deleted ${compaction.deleted}`);

    // A publication after compaction still reserves, finalizes, and advances.
    const published = await store.publish("agent_a", Date.now(), async () => ({ accepted: true }));
    assert.ok(published?.accepted);
    // A rejection after compaction still revokes the exact current authority,
    // which is only correct because the latest-reservation lookup survived.
    const rejected = await store.publish("agent_a", Date.now(), async () => ({ accepted: false }));
    assert.equal(rejected?.accepted, false);
    assert.equal(await store.get("agent_a"), null);
    await store.close();

    const inspection = new DatabaseSync(env.database);
    assert.ok(count(inspection, "agent_a") < 100, `journal stayed compact, saw ${count(inspection, "agent_a")}`);
    inspection.close();
  } finally { await env.cleanup(); }
});
