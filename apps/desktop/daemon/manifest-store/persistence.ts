/**
 * Connection lifecycle: close, bulk write, standalone open and schema v1.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { DaemonStateSchema, openDaemonStateDatabase } from "../daemon-state-database.js";
import { MAX_PROJECTED_COMPLETED_ACTION_IDS } from "../reconciler-state.js";
import type { DaemonManifest } from "../types.js";
import { type PreMembershipRoomMoveCancellation, canonicalManifestEntry, storeMethods } from "./shared.js";

export const persistence = storeMethods({
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await this.initializing?.catch(() => undefined);
    this.reads.clear();
    this.stateWatchEntries = null;
    if (this.ownsDatabase) this.database?.close();
    this.database = null;
    this.ownsDatabase = false;
    this.initializing = null;
  },

  /**
   * Bulk manifest synchronization (primarily for test setup or full-set edits).
   * Production callers prefer per-agent `createEntry`, `replaceEntry`, and `removeEntry`.
   */
  async write(
    entries: DaemonManifest["entries"],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    roomMoveCancellation?: PreMembershipRoomMoveCancellation,
    expectedVersions: Readonly<Record<string, number>> | null = null,
  ): Promise<{ entries: DaemonManifest["entries"]; versions: Record<string, number> }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const normalizedEntries = entries.map(canonicalManifestEntry);
      let committed = false;
      let versions: Record<string, number> = {};
      const commit = async () => {
        if (committed) throw new Error("Manifest transaction was already committed.");
        database.exec("BEGIN IMMEDIATE");
        try {
          this.writeFence?.();
          if (roomMoveCancellation) this.failPreMembershipRoomMoves(database, roomMoveCancellation);
          versions = this.replaceEntries(database, normalizedEntries, expectedVersions);
          database.exec("COMMIT");
          committed = true;
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
          throw error;
        }
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
      return { entries: returnedEntries, versions };
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
      database = await openDaemonStateDatabase(this.path, async (opened) => {
        await this.secureDatabaseFiles();
        this.createSchema(opened);
      });
      this.database = database;
      this.ownsDatabase = true;
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
});
