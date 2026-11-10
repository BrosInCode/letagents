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
  options: { failOnAddConstraint?: boolean; failOnTempTable?: boolean; liveDefinition?: string | null; validated?: boolean } = {}
): RepairClient & { released: boolean } {
  return {
    released: false,
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (options.failOnAddConstraint && sql.includes('ADD CONSTRAINT "rooms_focus_lineage_check"')) {
        throw new Error("add constraint failed");
      }
      if (options.failOnTempTable && sql.includes("CREATE TEMP TABLE")) {
        throw new Error("permission denied to create temporary tables in database \"letagents\"");
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

test("repairAdHocFocusLineage falls back to the rewrite when the comparison cannot run", async () => {
  const queries: string[] = [];
  const logged: string[] = [];
  const client = makeClient(queries, { failOnTempTable: true, liveDefinition: MIGRATED_DEFINITION });

  assert.equal(
    await repairAdHocFocusLineage({ async connect() { return client; } }, (line) => logged.push(line)),
    "repaired"
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0] || "", /Could not compare rooms_focus_lineage_check \(permission denied to create temporary tables/);
  assert.equal(rewrites(queries).length, 2);
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(client.released, true);
});

test(
  "repairAdHocFocusLineage rewrites the constraint for a role without the right to create temporary tables",
  { skip: TEST_DB_URL ? false : "set TEST_DB_URL to run DB-backed repair tests" },
  async () => {
    assert.ok(TEST_DB_URL);
    const admin = new Pool({ connectionString: TEST_DB_URL });
    const role = `lineage_no_temp_${process.pid}`;
    const database = (await admin.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
    const quotedDatabase = `"${database.replace(/"/g, '""')}"`;
    let restricted: Pool | null = null;

    try {
      await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      await migrate(drizzle(admin), { migrationsFolder: resolve("drizzle") });

      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER PASSWORD 'lineage-no-temp'`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await admin.query(`ALTER TABLE "rooms" OWNER TO ${role}`);
      await admin.query(`REVOKE TEMPORARY ON DATABASE ${quotedDatabase} FROM PUBLIC`);

      const url = new URL(TEST_DB_URL);
      url.username = role;
      // CI connects over TCP with password authentication.
      url.password = "lineage-no-temp";
      restricted = new Pool({ connectionString: url.toString() });
      await assert.rejects(
        () => restricted!.query("CREATE TEMP TABLE probe (x int)"),
        /permission denied to create temporary tables/
      );

      const logged: string[] = [];
      assert.equal(await repairAdHocFocusLineage(restricted, (line) => logged.push(line)), "repaired");
      assert.equal(logged.length, 1);
      const check = await admin.query<{ validated: boolean }>(
        "SELECT convalidated AS validated FROM pg_constraint WHERE conname = 'rooms_focus_lineage_check' AND conrelid = 'rooms'::regclass"
      );
      assert.equal(check.rows[0]?.validated, true);
    } finally {
      await restricted?.end();
      await admin.query(`GRANT TEMPORARY ON DATABASE ${quotedDatabase} TO PUBLIC`);
      await admin.query("ALTER TABLE IF EXISTS \"rooms\" OWNER TO CURRENT_USER");
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  }
);

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
