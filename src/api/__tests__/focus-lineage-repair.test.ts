import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import { repairAdHocFocusLineage, type RepairClient } from "../focus-lineage-repair.js";

const TEST_DB_URL = process.env.TEST_DB_URL || process.env.DB_URL;

function makeClient(
  queries: string[],
  options: { failOnAddConstraint?: boolean } = {}
): RepairClient & { released: boolean } {
  return {
    released: false,
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (options.failOnAddConstraint && sql.includes("ADD CONSTRAINT")) {
        throw new Error("add constraint failed");
      }
      return {};
    },
    release() {
      this.released = true;
    },
  };
}

test("repairAdHocFocusLineage rolls back and releases the client when the repair fails", async () => {
  const queries: string[] = [];
  const client = makeClient(queries, { failOnAddConstraint: true });

  await assert.rejects(
    () => repairAdHocFocusLineage({ async connect() { return client; } }),
    /add constraint failed/
  );

  assert.equal(queries[0], "BEGIN");
  assert.match(queries[1] || "", /DROP CONSTRAINT/);
  assert.match(queries[2] || "", /ADD CONSTRAINT/);
  assert.equal(queries[3], "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(client.released, true);
});

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

      await repairAdHocFocusLineage(pool);

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
