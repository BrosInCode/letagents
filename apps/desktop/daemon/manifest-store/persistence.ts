/**
 * Connection lifecycle: close, the guarded write, database open and schema, legacy JSON import.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { readFile, rename } from "node:fs/promises";
import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "../daemon-state-database.js";
import { MAX_PROJECTED_COMPLETED_ACTION_IDS } from "../reconciler-state.js";
import type { DaemonManifest } from "../types.js";
import { type StoredManifest, type Row, type PreMembershipRoomMoveCancellation, ManifestConflictError, checksum, json, importedWithoutHomeHarness, canonicalManifestEntry, run, storeMethods } from "./shared.js";

export const persistence = storeMethods({
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await this.initializing?.catch(() => undefined);
    this.reads.clear();
    this.database?.close();
    this.database = null;
    this.initializing = null;
  },

  async write(
    expectedGeneration: number,
    entries: DaemonManifest["entries"],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    roomMoveCancellation?: PreMembershipRoomMoveCancellation,
  ): Promise<DaemonManifest> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const normalizedEntries = entries.map(canonicalManifestEntry);
      let committed = false;
      let transactionOpen = false;
      try {
        const commit = async () => {
          if (committed) throw new Error("Manifest transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const result = database.prepare(`
            UPDATE manifest_metadata SET generation = generation + 1
            WHERE singleton = 1 AND generation = ?
          `).run(expectedGeneration);
          if (Number(result.changes) !== 1) {
            const current = Number((this.reads.get(database, "generation").get() as Row).generation);
            throw new ManifestConflictError(`Manifest generation ${current} does not match expected ${expectedGeneration}.`);
          }
          if (roomMoveCancellation) this.failPreMembershipRoomMoves(database, roomMoveCancellation);
          this.replaceEntries(database, normalizedEntries);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");

        const persistedEntries = normalizedEntries.map((entry) => {
          const persisted = this.readEntryFromDatabase(database, entry.id);
          if (!persisted) throw new Error(`Daemon manifest entry disappeared after full replacement: ${entry.id}`);
          return persisted;
        });
        const returnedEntries = persistedEntries.map((entry) => entry.reconciliation
          ? {
            ...entry,
            reconciliation: {
              ...entry.reconciliation,
              completed_action_ids: entry.reconciliation.completed_action_ids.slice(-MAX_PROJECTED_COMPLETED_ACTION_IDS),
            },
          }
          : entry);
        const manifest: DaemonManifest = { generation: expectedGeneration + 1, entries: returnedEntries };
        return manifest;
      } catch (error) {
        if (transactionOpen) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
        }
        throw error;
      }
    });
  },

  async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("ManifestStore is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  },

  async initialize(): Promise<DatabaseSync> {
    let database: DatabaseSync | null = null;
    try {
      database = this.schemaPrepared
        ? await openPreparedDaemonStateDatabase(this.path)
        : await openDaemonStateDatabase(this.path, async (opened) => {
          await this.secureDatabaseFiles();
          this.createSchema(opened);
        });
      await this.importLegacyManifest(database);
      this.database = database;
      return database;
    } catch (error) {
      database?.close();
      this.initializing = null;
      throw error;
    }
  },

  createSchema(database: DatabaseSync): void {
    new DaemonStateSchema(this.schemaInitializationHook).createSchema(database);
  },
  async importLegacyManifest(database: DatabaseSync): Promise<void> {
    if (!this.legacyJsonPath) return;
    const migrationKey = `legacy-json:${this.legacyJsonPath}`;
    const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key = ?").get(migrationKey) as Row | undefined;
    if (failed) throw new Error(`Legacy daemon manifest migration is blocked after validation failure (${String(failed.reason)}); quarantined at ${String(failed.quarantined_path)}.`);
    const existing = database.prepare("SELECT checksum FROM migration_records WHERE migration_key = ?").get(migrationKey) as Row | undefined;
    if (existing) {
      await this.retainLegacyBackup(String(existing.checksum));
      return;
    }

    let source: string;
    try {
      source = await readFile(this.legacyJsonPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let stored: StoredManifest;
    try {
      stored = JSON.parse(source) as StoredManifest;
      if (!stored.manifest || stored.checksum !== checksum(stored.manifest)) throw new Error("checksum mismatch");
    } catch (error) {
      const quarantinedPath = `${this.legacyJsonPath}.corrupt-${Date.now()}`;
      run(database.prepare("INSERT OR REPLACE INTO migration_failures(migration_key, reason, failed_at, quarantined_path) VALUES (?, ?, ?, ?)"), migrationKey, String(error), new Date().toISOString(), quarantinedPath);
      await rename(this.legacyJsonPath, quarantinedPath);
      throw new Error(`Legacy daemon manifest failed checksum validation: ${String(error)}`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const current = Number((this.reads.get(database, "generation").get() as Row).generation);
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM agent_identities").get() as Row).count);
      if (current !== 0 || count !== 0) throw new Error("Refusing to import a legacy manifest into non-empty daemon state.");
      // An imported file is not the desktop app's signed choice, so no
      // imported agent starts with its owner's own setup turned on.
      this.replaceEntries(database, stored.manifest.entries.map(importedWithoutHomeHarness).map((entry) =>
        entry.provider === "codex" && entry.provider_ref
          ? { ...entry, desired_state: "stopped" as const }
          : entry), false);
      run(database.prepare("UPDATE manifest_metadata SET generation = ? WHERE singleton = 1"), stored.manifest.generation);
      run(database.prepare("INSERT INTO migration_records(migration_key, checksum, imported_at) VALUES (?, ?, ?)"), migrationKey, stored.checksum, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    await this.retainLegacyBackup(stored.checksum);
  },

  async retainLegacyBackup(expectedChecksum: string): Promise<void> {
    if (!this.legacyJsonPath) return;
    let source: string;
    try {
      source = await readFile(this.legacyJsonPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const stored = JSON.parse(source) as StoredManifest;
    if (stored.checksum !== expectedChecksum || !stored.manifest || checksum(stored.manifest) !== expectedChecksum) {
      throw new Error("Refusing to retain a legacy manifest backup whose checksum differs from the imported source.");
    }
    await rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated-backup`);
  },
});
