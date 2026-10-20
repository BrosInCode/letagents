import { RoomLatencyTrace } from "../room-latency-trace.js";
import { PreparedReadStatements } from "../prepared-reads.js";
import { DatabaseSync } from "node:sqlite";
import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "../daemon-state-database.js";
import { pruneSupervisedAgentHistory, settleSupervisedTerminalItem } from "../supervised-agent-history-retention.js";
import type { SupervisedInboxItem, SupervisedInboxEvent, Row } from "./types.js";
import { run, INBOX_READS } from "./sql.js";
import { rowToItem } from "./row-mapping.js";

/** Tells one opened connection from the next, so a version read on a replaced connection never equals an older one. */
const connectionIdentities = new WeakMap<DatabaseSync, number>();
let nextConnectionIdentity = 1;

export abstract class InboxStoreBase {
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  protected readonly reads = new PreparedReadStatements(INBOX_READS);

  constructor(
    private readonly databasePath: string,
    protected readonly now: () => string = () => new Date().toISOString(),
    private readonly onMutation: (affectedAgentId?: string) => void = () => undefined,
    private readonly schemaPrepared = false,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    await this.writes.catch(() => undefined);
    await this.initializing?.catch(() => undefined);
    this.reads.clear();
    this.database?.close(); this.database = null; this.initializing = null;
  }
  async get(inboxItemId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => { const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined; return row ? rowToItem(row) : null; });
  }

  /**
   * A token that is equal on two reads only if neither the rows nor the schema
   * of this database file changed between them, by any connection. Another
   * connection's commit changes `PRAGMA data_version` here; a row change made
   * on this connection (committed or not) changes `total_changes()`; a schema
   * change made on this connection (which changes neither of those) changes
   * `PRAGMA schema_version`. Null while this connection has a transaction
   * open, because its reads then see rows that may still be rolled back. Its
   * parts are SQLite's own counters, so a writer that forgets to report a
   * change cannot leave it unchanged.
   */
  async committedStateVersion(): Promise<string | null> {
    return this.read((database) => {
      if (database.isTransaction) return null;
      let identity = connectionIdentities.get(database);
      if (identity === undefined) { identity = nextConnectionIdentity++; connectionIdentities.set(database, identity); }
      const dataVersion = (this.reads.get(database, "dataVersion").get() as Row).data_version;
      const totalChanges = (this.reads.get(database, "totalChanges").get() as Row).value;
      const schemaVersion = (this.reads.get(database, "schemaVersion").get() as Row).schema_version;
      return `${identity}:${String(dataVersion)}:${String(totalChanges)}:${String(schemaVersion)}`;
    });
  }

  protected async read<T>(operation: (database: DatabaseSync) => Promise<T> | T): Promise<T> { return operation(await this.getDatabase()); }
  protected async exclusive<T>(operation: (database: DatabaseSync) => Promise<T>, affectedAgentId?: string,
    shouldNotify: () => boolean = () => true): Promise<T> {
    const timing = new RoomLatencyTrace("inbox_write");
    let release!: () => void; const prior = this.writes; this.writes = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    timing.mark("queue_wait");
    let committed = false;
    try {
      const database = await this.getDatabase();
      timing.mark("database");
      const result = await operation(database);
      committed = true;
      return result;
    } finally {
      release();
      timing.mark("operation");
      timing.finish();
      if (committed && shouldNotify()) this.onMutation(affectedAgentId);
    }
  }
  protected transaction<T>(database: DatabaseSync, operation: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = operation(); database.exec("COMMIT"); return result; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
  protected async transactionFenced<T>(database: DatabaseSync, operation: () => T, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<T> {
    let transactionOpen = false;
    let committed = false;
    let result!: T;
    try {
      const transaction = async () => {
        if (transactionOpen || committed) throw new Error("Supervised inbox transaction was already started.");
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        result = operation();
        database.exec("COMMIT");
        transactionOpen = false;
        committed = true;
      };
      if (commitFence) await commitFence(transaction); else await transaction();
      if (!committed) throw new Error("Supervised inbox commit fence returned without committing.");
      return result;
    } catch (error) {
      if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
      throw error;
    }
  }
  private async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("Supervised inbox store is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = (this.schemaPrepared
      ? openPreparedDaemonStateDatabase(this.databasePath)
      : openDaemonStateDatabase(this.databasePath, (database) => new DaemonStateSchema().createSchema(database)))
      .then((database) => { this.database = database; return database; });
    return this.initializing;
  }
  protected require(value: string, field: string): void { if (!value?.trim()) throw new Error(`Supervised inbox ${field} is required.`); }
  protected requireNumericCursor(cursor: string): void { if (!/^(?:msg_)?\d+$/.test(cursor)) throw new Error("Supervised inbox cursor must be a numeric room message id."); }
  /** Terminal ownership proves a prepared ordinary effect never crossed its
   * execution CAS. Settle it in the same transaction as every terminal path
   * so handoff/Stop races cannot leave immortal purge blockers. Room moves are
   * intentionally prepared until the acknowledged reply is reconciled. Already
   * captured attempts may copy this receipt through an isolated savepoint. */
  protected settleTerminalItem(database: DatabaseSync, item: SupervisedInboxItem, timestamp: string): void {
    settleSupervisedTerminalItem(database, {
      inboxItemId: item.inbox_item_id,
      agentId: item.agent_id,
      providerTurnId: item.provider_turn_id,
    }, timestamp);
  }
  protected assertCurrentHead(database: DatabaseSync, item: SupervisedInboxItem): void {
    const head = database.prepare("SELECT inbox_item_id FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence LIMIT 1").get(item.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== item.inbox_item_id) throw new Error("Only the current FIFO head may change delivery state.");
  }
  /**
   * Retry re-reads the same completed turn without a new attempt, so a re-read
   * and its re-block recur within one attempt. Their keys also carry the next
   * journal sequence, which only grows (retention keeps the newest events),
   * so no occurrence is silently dropped as a duplicate.
   */
  protected occurrenceKey(database: DatabaseSync, inboxItemId: string, key: string, phase: SupervisedInboxEvent["phase"]): string {
    if (phase !== "blocked" && phase !== "result_unreadable") return key;
    const next = Number((database.prepare("SELECT COALESCE(MAX(event_sequence),0)+1 AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=?")
      .get(inboxItemId) as Row).value);
    return `${key}:${next}`;
  }
  protected recordEvent(database: DatabaseSync, inboxItemId: string, idempotencyKey: string, phase: SupervisedInboxEvent["phase"], observedAt: string, detail: string | null): void {
    // The ordinal is allocated in the same inbox transaction as its state
    // fact. The idempotency key remains independent so replay cannot append a
    // duplicate phase, even when timestamps are identical.
    run(database.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT ?,COALESCE((SELECT MAX(event_sequence) FROM supervised_agent_inbox_events WHERE inbox_item_id=?),0)+1,?,?,?,?
      WHERE NOT EXISTS (
        SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?
      )`), inboxItemId, inboxItemId, idempotencyKey, phase, observedAt, detail, inboxItemId, idempotencyKey);
  }
  protected pruneAgentHistory(database: DatabaseSync, agentId: string, protectedUncertainEffectId: string | null = null): void {
    pruneSupervisedAgentHistory(database, agentId, this.now, protectedUncertainEffectId);
  }
}
