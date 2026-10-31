/**
 * The ManifestStore class: fields, constructor, ensureDatabase, and the method composition.
 *
 * Modules:
 * - entry-reads.ts: Manifest and entry reads, runtime lifecycle authority, and typed lifecycle effects.
 * - approvals.ts: Execution approvals, host tool rules, managed-runtime checks and execution delegation.
 * - delivery-and-polling.ts: Delivery drains, agent configuration reads, live sharing, and custodial polling activation and offers.
 * - room-moves-and-purges.ts: Room-move and purge journals.
 * - entries-and-recovery.ts: Agent configuration updates, entry replacement, provider birth checkpoints and runtime recovery.
 * - turn-control.ts: Turn-control preparation, target checkpoints and commit.
 * - cursor-turns.ts: Cursor prepared-turn and provider-state checkpoints.
 * - activity.ts: Batch entry replacement and removal, runtime configuration, activity writes and workplace liveness.
 * - persistence.ts: Connection lifecycle: close, the guarded write, database open and schema, legacy JSON import.
 * - projections.ts: Entry rows to and from the decomposed domain projection tables.
 * - write-paths.ts: Pre-membership room-move failure, journal and targeted write paths, serialization and file permissions.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { PreparedReadStatements } from "../prepared-reads.js";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonManifestEntry } from "../types.js";
import { MANIFEST_READS } from "./shared.js";
import { entryReads } from "./entry-reads.js";
import { approvals } from "./approvals.js";
import { deliveryAndPolling } from "./delivery-and-polling.js";
import { roomMovesAndPurges } from "./room-moves-and-purges.js";
import { entriesAndRecovery } from "./entries-and-recovery.js";
import { turnControl } from "./turn-control.js";
import { cursorTurns } from "./cursor-turns.js";
import { activity } from "./activity.js";
import { persistence } from "./persistence.js";
import { projections } from "./projections.js";
import { writePaths } from "./write-paths.js";

/**
 * SQLite-backed durable state for the daemon's compatibility manifest.
 *
 * The flat manifest entry remains the control-socket contract only. Each row is
 * decomposed into records with distinct ownership before persistence, and reads
 * recompose the same flat projection for existing callers.
 */
export class ManifestStore {
  readonly reads = new PreparedReadStatements(MANIFEST_READS);
  database: DatabaseSync | null = null;
  initializing: Promise<DatabaseSync> | null = null;
  writes: Promise<void> = Promise.resolve();
  closed = false;
  pendingActivityState: ((agentId: string) => { observedState: DaemonManifestEntry["observed_state"] | null } | null) | null = null;

  constructor(
    readonly path: string,
    readonly legacyJsonPath?: string,
    readonly permissionHousekeeping?: (paths: string[]) => Promise<void>,
    readonly schemaInitializationHook?: (database: DatabaseSync) => void,
    readonly schemaPrepared = false,
  ) {}

  /** Initialise/upgrade the shared daemon database without retaining a handle. */
  static async ensureDatabase(path: string): Promise<void> {
    const store = new ManifestStore(path);
    try { await store.load(); } finally { await store.close(); }
  }
}

// Each concern module holds part of the methods; merge their types here and
// install them as non-enumerable prototype methods, exactly as class methods.
type EntryReadsMethods = typeof entryReads;
type ApprovalsMethods = typeof approvals;
type DeliveryAndPollingMethods = typeof deliveryAndPolling;
type RoomMovesAndPurgesMethods = typeof roomMovesAndPurges;
type EntriesAndRecoveryMethods = typeof entriesAndRecovery;
type TurnControlMethods = typeof turnControl;
type CursorTurnsMethods = typeof cursorTurns;
type ActivityMethods = typeof activity;
type PersistenceMethods = typeof persistence;
type ProjectionsMethods = typeof projections;
type WritePathsMethods = typeof writePaths;
export interface ManifestStore extends EntryReadsMethods, ApprovalsMethods, DeliveryAndPollingMethods, RoomMovesAndPurgesMethods, EntriesAndRecoveryMethods, TurnControlMethods, CursorTurnsMethods, ActivityMethods, PersistenceMethods, ProjectionsMethods, WritePathsMethods {}
for (const methods of [entryReads, approvals, deliveryAndPolling, roomMovesAndPurges, entriesAndRecovery, turnControl, cursorTurns, activity, persistence, projections, writePaths]) {
  for (const [name, value] of Object.entries(methods)) {
    // Two modules defining one name would silently keep the later definition.
    if (name in ManifestStore.prototype) throw new Error(`ManifestStore method ${name} is defined twice.`);
    Object.defineProperty(ManifestStore.prototype, name, { value, writable: true, configurable: true, enumerable: false });
  }
}
