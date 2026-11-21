import { DatabaseSync } from "node:sqlite";

export type SqliteRow = Record<string, unknown>;

/**
 * Read-only SQLite inspector for black-box daemon edge tests.
 * Opens `<stateDir>/daemon-state.sqlite` directly with `node:sqlite` and
 * imports no daemon internal modules.
 */
export class EdgeSqliteInspector {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    this.db = new DatabaseSync(databasePath, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout = 2000");
  }

  all<T extends SqliteRow = SqliteRow>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T extends SqliteRow = SqliteRow>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  userVersion(): number {
    const row = this.get<{ user_version: number }>("PRAGMA user_version");
    return Number(row?.user_version ?? 0);
  }

  journalMode(): string {
    const row = this.get<{ journal_mode: string }>("PRAGMA journal_mode");
    return String(row?.journal_mode ?? "").toLowerCase();
  }

  integrityCheck(): string {
    const row = this.get<{ integrity_check: string }>("PRAGMA integrity_check");
    return String(row?.integrity_check ?? "");
  }

  tableNames(): string[] {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => String(row.name));
  }

  inboxItems(agentId: string): SqliteRow[] {
    return this.all(
      "SELECT * FROM supervised_agent_inbox WHERE agent_id = ? ORDER BY fifo_sequence ASC",
      agentId,
    );
  }

  terminalResults(agentId: string): SqliteRow[] {
    return this.all(
      "SELECT * FROM supervised_agent_terminal_results WHERE agent_id = ? ORDER BY observed_at ASC",
      agentId,
    );
  }

  ingressCursor(agentId: string): SqliteRow | undefined {
    return this.get(
      "SELECT * FROM supervised_agent_ingress_cursors WHERE agent_id = ?",
      agentId,
    );
  }

  runtimeDeployment(agentId: string): SqliteRow | undefined {
    return this.get(
      "SELECT * FROM runtime_deployments WHERE agent_id = ?",
      agentId,
    );
  }

  lifecycleState(agentId: string): SqliteRow | undefined {
    return this.get(
      "SELECT * FROM agent_lifecycle_states WHERE agent_id = ?",
      agentId,
    );
  }

  reconciliationRecord(agentId: string): SqliteRow | undefined {
    return this.get(
      "SELECT * FROM reconciliation_records WHERE agent_id = ?",
      agentId,
    );
  }

  reconciliationExitTimestamps(agentId: string): number[] {
    return this.all<{ timestamp_ms: number }>(
      "SELECT timestamp_ms FROM reconciliation_exit_timestamps WHERE agent_id = ? ORDER BY sort_order ASC",
      agentId,
    ).map((row) => Number(row.timestamp_ms));
  }

  turnControlJournal(agentId: string): SqliteRow | undefined {
    return this.get(
      "SELECT * FROM turn_control_journals WHERE agent_id = ?",
      agentId,
    );
  }

  approvalRequests(agentId: string): SqliteRow[] {
    return this.all(
      "SELECT * FROM execution_approval_requests WHERE agent_id = ? ORDER BY created_at_ms ASC",
      agentId,
    );
  }

  executionTurns(agentId: string): SqliteRow[] {
    return this.all(
      "SELECT * FROM execution_turns WHERE agent_id = ? ORDER BY rowid ASC",
      agentId,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
