import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deleteAttachmentObject, isAttachmentStorageConfigured } from "./attachment-storage.js";

let running = false;
/** Committed deletion jobs survive storage outages and API restarts. */
export async function drainAttachmentDeletions(): Promise<void> {
  if (running || !isAttachmentStorageConfigured()) return;
  running = true;
  try {
    const { rows } = await db.execute<{ object_key: string }>(sql`SELECT object_key FROM attachment_deletion_queue ORDER BY created_at LIMIT 100`);
    for (const row of rows) {
      try {
        await deleteAttachmentObject(row);
        await db.execute(sql`DELETE FROM attachment_deletion_queue WHERE object_key=${row.object_key}`);
      } catch { /* Retain the durable job for the next sweep. */ }
    }
  } finally { running = false; }
}
