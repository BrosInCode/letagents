import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { repairAdHocFocusLineage, type RepairClient } from "../focus-rooms/lineage-repair.js";

const TEST_DB_URL = process.env.TEST_DB_URL || process.env.DB_URL;

const MIGRATED_DEFINITION = "CHECK ((((kind = 'main'::text) AND (parent_room_id IS NULL))))";

function makeClient(
  queries: string[],
  options: { failOnAddConstraint?: boolean; liveDefinition?: string | null; validated?: boolean } = {}
): RepairClient & { released: boolean } {
  return {
    released: false,
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (options.failOnAddConstraint && sql.includes('ADD CONSTRAINT "rooms_focus_lineage_check"')) {
        throw new Error("add constraint failed");
      }
      if (sql.includes("to_regclass('public.rooms')")) {
        return options.liveDefinition === null
          ? { rows: [] }
          : { rows: [{ definition: options.liveDefinition ?? "CHECK (old)", validated: options.validated ?? true }] };
      }
      if (sql.includes("rooms_focus_lineage_expected_check'")) {
        return { rows: [{ definition: MIGRATED_DEFINITION }] };
      }
      return { rows: [] };
    },
    release() {
      this.released = true;
    },
  };
}

const rewrites = (queries: string[]) =>
  queries.filter((sql) => /ALTER TABLE "rooms" (DROP|ADD) CONSTRAINT/.test(sql));

test("repairAdHocFocusLineage rolls back and releases the client when the repair fails", async () => {
  const queries: string[] = [];
  const client = makeClient(queries, { failOnAddConstraint: true });

  await assert.rejects(
    () => repairAdHocFocusLineage({ async connect() { return client; } }),
    /add constraint failed/
  );

  assert.equal(queries[0], "BEGIN");
  const changed = rewrites(queries);
  assert.match(changed[0] || "", /DROP CONSTRAINT/);
  assert.match(changed[1] || "", /ADD CONSTRAINT/);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

test("repairAdHocFocusLineage only reads when the definition already matches", async () => {
  const queries: string[] = [];
  const client = makeClient(queries, { liveDefinition: MIGRATED_DEFINITION });

  assert.equal(await repairAdHocFocusLineage({ async connect() { return client; } }), "unchanged");
  assert.deepEqual(rewrites(queries), []);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(client.released, true);
});

test("repairAdHocFocusLineage rewrites a constraint that is missing, different, or not validated", async () => {
  for (const options of [
    { liveDefinition: null },
    { liveDefinition: "CHECK (old)" },
    { liveDefinition: MIGRATED_DEFINITION, validated: false },
  ]) {
    const queries: string[] = [];
    const client = makeClient(queries, options);
    assert.equal(await repairAdHocFocusLineage({ async connect() { return client; } }), "repaired");
    assert.equal(rewrites(queries).length, 2);
    assert.equal(queries.at(-1), "COMMIT");
  }
});

test(
  "repairAdHocFocusLineage leaves a migrated database alone and takes no lock on rooms",
  { skip: TEST_DB_URL ? false : "set TEST_DB_URL to run DB-backed repair tests" },
  async () => {
    assert.ok(TEST_DB_URL);
    const pool = new Pool({ connectionString: TEST_DB_URL });
    const holder = new Pool({ connectionString: TEST_DB_URL, max: 1 });

    try {
      await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      const constraintOid = async () => (await pool.query<{ oid: string }>(
        "SELECT oid::text FROM pg_constraint WHERE conname = 'rooms_focus_lineage_check' AND conrelid = 'rooms'::regclass"
      )).rows[0]?.oid;
      const before = await constraintOid();
      assert.ok(before);

      // An open writer on rooms: ACCESS EXCLUSIVE would wait for it.
      const writer = await holder.connect();
      try {
        await writer.query("BEGIN");
        await writer.query('LOCK TABLE "rooms" IN ROW EXCLUSIVE MODE');
        const result = await Promise.race([
          repairAdHocFocusLineage(pool),
          new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("blocked"), 5_000)),
        ]);
        assert.equal(result, "unchanged");
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      assert.equal(await constraintOid(), before, "the constraint was not dropped and added again");
    } finally {
      await holder.end();
      await pool.end();
    }
  }
);

test(
  "repairAdHocFocusLineage updates an existing pushed schema without a migration journal",
  { skip: TEST_DB_URL ? false : "set TEST_DB_URL to run DB-backed repair tests" },
  async () => {
    assert.ok(TEST_DB_URL);
    const pool = new Pool({ connectionString: TEST_DB_URL });

    try {
      await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await pool.query(`
        CREATE TABLE "rooms" (
          "id" text PRIMARY KEY,
          "name" text,
          "display_name" text NOT NULL,
          "code" text,
          "kind" text DEFAULT 'main' NOT NULL,
          "parent_room_id" text,
          "focus_key" text,
          "source_task_id" text,
          "focus_status" text,
          "concluded_at" timestamp with time zone,
          "conclusion_summary" text,
          "conclusion_details" jsonb,
          "created_at" timestamp with time zone NOT NULL
        )
      `);
      await pool.query(`
        ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_lineage_check" CHECK ((
          "rooms"."kind" = 'main'
          AND "rooms"."parent_room_id" IS NULL
          AND "rooms"."focus_key" IS NULL
          AND "rooms"."source_task_id" IS NULL
          AND "rooms"."focus_status" IS NULL
          AND "rooms"."concluded_at" IS NULL
          AND "rooms"."conclusion_summary" IS NULL
          AND "rooms"."conclusion_details" IS NULL
        ) OR (
          "rooms"."kind" = 'focus'
          AND "rooms"."parent_room_id" IS NOT NULL
          AND "rooms"."focus_key" IS NOT NULL
          AND "rooms"."source_task_id" IS NOT NULL
          AND "rooms"."focus_status" IS NOT NULL
        ))
      `);
      await pool.query(`
        INSERT INTO "rooms" (
          "id",
          "display_name",
          "kind",
          "created_at"
        ) VALUES ('parent', 'Parent', 'main', now())
      `);

      await assert.rejects(
        () => pool.query(`
          INSERT INTO "rooms" (
            "id",
            "display_name",
            "kind",
            "parent_room_id",
            "focus_key",
            "source_task_id",
            "focus_status",
            "created_at"
          ) VALUES ('focus_before', 'Focus Before', 'focus', 'parent', 'focus-ad-hoc', NULL, 'active', now())
        `),
        /rooms_focus_lineage_check/
      );

      assert.equal(await repairAdHocFocusLineage(pool), "repaired");

      await pool.query(`
        INSERT INTO "rooms" (
          "id",
          "display_name",
          "kind",
          "parent_room_id",
          "focus_key",
          "source_task_id",
          "focus_status",
          "created_at"
        ) VALUES ('focus_after', 'Focus After', 'focus', 'parent', 'focus-ad-hoc', NULL, 'active', now())
      `);

      const journal = await pool.query<{ journal_table: string | null }>(
        "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS journal_table"
      );
      assert.equal(journal.rows[0]?.journal_table, null);
    } finally {
      await pool.end();
    }
  }
);
