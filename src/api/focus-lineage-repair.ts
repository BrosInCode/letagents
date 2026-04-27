export interface RepairClient {
  query(sql: string): Promise<unknown>;
  release(): void;
}

export interface RepairPool {
  connect(): Promise<RepairClient>;
}

export async function repairAdHocFocusLineage(db: RepairPool): Promise<void> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_focus_lineage_check"`);
    await client.query(`
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
        AND "rooms"."focus_status" IS NOT NULL
      ))
    `);
    await client.query("COMMIT");
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
