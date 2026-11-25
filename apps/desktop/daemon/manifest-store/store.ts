/**
 * The ManifestStore class: fields, constructor, shared-connection attach, and method composition.
 *
 * Modules:
 * - entry-reads.ts: Manifest and entry reads, per-agent versions, runtime lifecycle authority.
 * - approvals.ts: Execution approvals, host tool rules, managed-runtime checks and execution delegation.
 * - delivery-and-polling.ts: Agent configuration reads and live sharing.
 * - room-moves-and-purges.ts: Room-move and purge journals.
 * - entries-and-recovery.ts: Agent creation, configuration updates, entry replacement, provider birth checkpoints and runtime recovery.
 * - turn-control.ts: Turn-control preparation, target checkpoints and commit.
 * - cursor-turns.ts: Cursor prepared-turn and provider-state checkpoints.
 * - activity.ts: Batch entry replacement and removal, runtime configuration, activity writes and workplace liveness.
 * - persistence.ts: Connection lifecycle: attach/close, bulk write, standalone open and schema v1.
 * - projections.ts: Entry rows to and from the `agents` domain table.
 * - write-paths.ts: Pre-membership room-move failure, journal and per-agent versioned write paths, serialization and file permissions.
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
 * SQLite-backed durable state for the daemon's agents and operational journals
 * on schema v1. Uses the process's single shared SQLite connection when
 * attached by SupervisorDaemon, or opens one lazily for standalone tests.
 */
export class ManifestStore {
  readonly reads = new PreparedReadStatements(MANIFEST_READS);
  database: DatabaseSync | null = null;
  ownsDatabase = false;
  initializing: Promise<DatabaseSync> | null = null;
  writes: Promise<void> = Promise.resolve();
  closed = false;
  writeFence: (() => void) | null = null;
  pendingActivityState: ((agentId: string) => { observedState: DaemonManifestEntry["observed_state"] | null } | null) | null = null;
  /** The entries loadForStateWatch last projected, each under the manifest version read before it; see entry-reads.ts. */
  stateWatchEntries: { database: DatabaseSync; byAgent: Map<string, { version: number; entry: DaemonManifestEntry }> } | null = null;

  constructor(
    readonly path: string,
    readonly permissionHousekeeping?: (paths: string[]) => Promise<void>,
    readonly schemaInitializationHook?: (database: DatabaseSync) => void,
  ) {}

  /** Attach the process's single shared SQLite handle without taking ownership of closing it. */
  attachDatabase(database: DatabaseSync, writeFence?: () => void): void {
    this.reads.clear();
    this.stateWatchEntries = null;
    this.database = database;
    this.ownsDatabase = false;
    this.initializing = null;
    this.closed = false;
    if (writeFence) this.writeFence = writeFence;
  }

  /** Bind a synchronous generation fence check invoked inside every BEGIN IMMEDIATE transaction. */
  bindWriteFence(writeFence: () => void): void {
    this.writeFence = writeFence;
  }

  /** Initialise the daemon database without retaining a handle. */
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
