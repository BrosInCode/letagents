export interface RepairClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}

export interface RepairPool {
  connect(): Promise<RepairClient>;
}

export type LineageRepairResult = "unchanged" | "repaired";

/**
 * The lineage rule for rooms, as migration 0035 and schema/core.ts write it.
 * Unqualified column names, so that the same text also checks the scratch
 * table below.
 */
export const FOCUS_LINEAGE_CHECK_EXPRESSION = `(
  "kind" = 'main'
  AND "parent_room_id" IS NULL
  AND "focus_key" IS NULL
  AND "source_task_id" IS NULL
  AND "focus_status" IS NULL
  AND "concluded_at" IS NULL
  AND "conclusion_summary" IS NULL
  AND "conclusion_details" IS NULL
) OR (
  "kind" = 'focus'
  AND "parent_room_id" IS NOT NULL
  AND "focus_key" IS NOT NULL
  AND "focus_status" IS NOT NULL
)`;

function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows = (result as { rows?: Array<Record<string, unknown>> } | null)?.rows;
  return Array.isArray(rows) ? rows[0] : undefined;
}

/**
 * Make `rooms_focus_lineage_check` equal to the expected rule.
 *
 * A database built by the migrations already has it. Then this only reads
 * the catalog and a scratch temporary table, and takes no lock on `rooms`.
 * A database built another way (for example a pushed
 * schema without a migration journal) has a different rule; then the
 * constraint is dropped and added again, as before.
 *
 * Postgres prints both definitions with `pg_get_constraintdef`, so the
 * comparison does not depend on how the text was first written.
 */
export async function repairAdHocFocusLineage(db: RepairPool): Promise<LineageRepairResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const current = firstRow(await client.query(`
      SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
        FROM pg_constraint AS c
       WHERE c.conrelid = to_regclass('public.rooms')
         AND c.conname = 'rooms_focus_lineage_check'
    `));
    await client.query(`
      CREATE TEMP TABLE "rooms_focus_lineage_expected" (
        "kind" text,
        "parent_room_id" text,
        "focus_key" text,
        "source_task_id" text,
        "focus_status" text,
        "concluded_at" timestamp with time zone,
        "conclusion_summary" text,
        "conclusion_details" jsonb
      ) ON COMMIT DROP
    `);
    await client.query(`
      ALTER TABLE "rooms_focus_lineage_expected"
        ADD CONSTRAINT "rooms_focus_lineage_expected_check" CHECK (${FOCUS_LINEAGE_CHECK_EXPRESSION})
    `);
    const expected = firstRow(await client.query(`
      SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint AS c
       WHERE c.conrelid = 'pg_temp.rooms_focus_lineage_expected'::regclass
         AND c.conname = 'rooms_focus_lineage_expected_check'
    `));

    if (
      current?.validated === true
      && typeof current.definition === "string"
      && typeof expected?.definition === "string"
      && current.definition === expected.definition
    ) {
      await client.query("ROLLBACK");
      return "unchanged";
    }

    await client.query(`DROP TABLE "rooms_focus_lineage_expected"`);
    await client.query(`ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_focus_lineage_check"`);
    await client.query(
      `ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_lineage_check" CHECK (${FOCUS_LINEAGE_CHECK_EXPRESSION})`
    );
    await client.query("COMMIT");
    return "repaired";
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Failed to roll back focus lineage repair transaction.", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
