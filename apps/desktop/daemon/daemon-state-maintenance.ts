import { statfs } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import { DaemonStateSchema } from "./daemon-state-database.js";
import { cloneStateDatabaseForCompaction } from "./state-recovery-backup.js";

const MIN_RECLAIM_BYTES = 64 * 1024 * 1024;

function reclaimWal(database: DatabaseSync): "compacted" | "checkpoint_busy" | "checkpoint_failed" {
  try {
    return Number(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy) === 0
      ? "compacted" : "checkpoint_busy";
  } catch { return "checkpoint_failed"; }
}

/** Startup-only maintenance. The caller owns the singleton until this returns,
 * and no runtime store may open or write between the snapshot and replacement.
 * A logical copy retains rowids that VACUUM is permitted to renumber. SQLite's
 * backup transaction replaces the destination atomically, including on crash;
 * no plaintext candidate or filesystem swap can orphan the destination's WAL. */
export async function compactDaemonStateDatabase(
  path: string,
  database: DatabaseSync,
  assertCurrent: () => Promise<void>,
): Promise<"not_needed" | "compacted" | "insufficient_space" | "checkpoint_busy" | "checkpoint_failed" | "copy_failed"> {
  const pageSize = Number(database.prepare("PRAGMA page_size").get()!.page_size);
  const pages = Number(database.prepare("PRAGMA page_count").get()!.page_count);
  const free = Number(database.prepare("PRAGMA freelist_count").get()!.freelist_count);
  if (free * pageSize < MIN_RECLAIM_BYTES || free < pages / 4) {
    const pending = database.prepare("SELECT reason FROM migration_failures WHERE migration_key='state-space-maintenance'").get();
    if (pending?.reason === "checkpoint_busy" || pending?.reason === "checkpoint_failed") {
      await assertCurrent();
      return reclaimWal(database);
    }
    return "not_needed";
  }
  await assertCurrent();
  // The compact copy lives in memory. Leave room for its destination journal
  // and checkpoint, as well as unrelated host writes while startup completes.
  let space;
  try { space = await statfs(path, { bigint: true }); }
  catch { return "copy_failed"; }
  if (space.bavail * space.bsize < BigInt((pages - free) * pageSize * 2 + MIN_RECLAIM_BYTES)) return "insufficient_space";
  let compact: DatabaseSync | undefined;
  try {
    compact = cloneStateDatabaseForCompaction(database);
    new DaemonStateSchema().validateCurrentShape(compact);
  } catch {
    compact?.close();
    return "copy_failed";
  }
  try {
    await assertCurrent();
    try { await backup(compact, path); }
    catch { return "copy_failed"; }
    // A completed backup has committed even if an existing reader prevents
    // immediate reclamation. Never delete WAL files to force a checkpoint.
    return reclaimWal(database);
  } finally { compact.close(); }
}
