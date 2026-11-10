import { realpath, rm } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { localFilesPath } from "../chat-storage/settings.js";
import { getLocalChatDatabase, type SqliteDatabase } from "./local-db.js";

export function prepareLocalDeletion(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS local_deleted_message_keys (room_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(room_id,key));
    CREATE TABLE IF NOT EXISTS local_attachment_deletion_queue (url TEXT PRIMARY KEY NOT NULL);`);
}

export function queueLocalAttachmentDeletion(database: SqliteDatabase, roomId: string, numbers?: number[], attachmentId?: string): void {
  prepareLocalDeletion(database);
  const numberClause = numbers ? ` AND message_number IN (${numbers.map(() => "?").join(",")})` : "";
  const attachmentClause = attachmentId ? " AND attachment_id=?" : "";
  const args = [roomId, ...(numbers ?? []), ...(attachmentId ? [attachmentId] : [])];
  database.prepare(`INSERT OR IGNORE INTO local_attachment_deletion_queue(url)
    SELECT url FROM local_chat_attachments WHERE room_id=?${numberClause}${attachmentClause} AND url LIKE 'file:%'`).run(...args);
}

let draining = false;
export async function drainLocalAttachmentDeletions(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
  const database = await getLocalChatDatabase();
  prepareLocalDeletion(database);
  const base = await realpath(localFilesPath).catch(() => null);
  for (const row of database.prepare("SELECT url FROM local_attachment_deletion_queue").all()) {
    const url = String(row.url);
    try {
      const path = await realpath(fileURLToPath(url)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (path && base) {
        const within = relative(base, path);
        if (within && !within.startsWith("..") && !isAbsolute(within)) await rm(path, { force: true });
      }
      database.prepare("DELETE FROM local_attachment_deletion_queue WHERE url=?").run(url);
    } catch { /* Retry from the next deletion/startup without losing the path. */ }
  }
  } finally { draining = false; }
}
