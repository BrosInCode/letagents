/** Shared constants, SQL helpers and agent state version triggers for modern daemon schemas (v1+). */
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** ASCII 'LAD1' (LetAgents Daemon schema lineage v1+). Legacy v1-v52 DBs have application_id = 0. */
export const DAEMON_STATE_APPLICATION_ID = 0x4c414431;
export const DAEMON_STATE_SCHEMA_VERSION = 4;
export const SCHEMA_VERSION = DAEMON_STATE_SCHEMA_VERSION;
/**
 * Offset added to logical schema version when stored in SQLite's PRAGMA user_version.
 * Keeps modern user_version (1001 for schema v1, 1002 for schema v2, ...) strictly
 * above legacy v1-v52 so older released daemons (which never inspect application_id)
 * fail closed at their read-only version gate before writing daemon-state.sqlite.recovery.enc
 * or inspecting tables.
 */
export const DAEMON_STATE_USER_VERSION_OFFSET = 1000;
export const DAEMON_STATE_USER_VERSION = DAEMON_STATE_USER_VERSION_OFFSET + DAEMON_STATE_SCHEMA_VERSION;
export function toSqliteUserVersion(schemaVersion: number): number {
  return DAEMON_STATE_USER_VERSION_OFFSET + schemaVersion;
}
export function fromSqliteUserVersion(userVersion: number): number {
  return userVersion - DAEMON_STATE_USER_VERSION_OFFSET;
}

export type Row = Record<string, unknown>;
export function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
export function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

/** Normalizes SQLite DDL strings while preserving case-sensitive string literals. */
export function normalizeSchemaSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? [])
    .map((part) => (part.startsWith("'")
      ? part
      : part.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "").replaceAll('"', "").replace(/\s+/g, "").toLowerCase()))
    .join("")
    .replace(/;$/, "");
}

/**
 * Per-agent change counters maintained inside SQLite by triggers.
 * `inbox_version` advances on inbox/effect/turn-control changes;
 * `manifest_version` advances on agent/activity changes. Native liveness
 * updates on activity batches do not bump `inbox_version`.
 */
export const AGENT_STATE_VERSIONS_TABLE = "agent_state_versions";
export const agentStateVersionsTableSql = `CREATE TABLE agent_state_versions (
  agent_id TEXT PRIMARY KEY,
  inbox_version INTEGER NOT NULL,
  manifest_version INTEGER NOT NULL
) STRICT`;

export type AgentStateVersionScope = "inbox" | "manifest" | "both";
export type AgentStateVersionSource = {
  table: string;
  /** The column that holds the agent, or the inbox item looked up through `inbox_items`. */
  key: "agent_id" | "inbox_item_id";
  scope: AgentStateVersionScope;
  /** When set, an UPDATE counts only when one of these columns changes; INSERT and DELETE always count. */
  updateOf?: readonly string[];
};

export const agentStateVersionSources: readonly AgentStateVersionSource[] = [
  { table: "inbox_items", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_inbox_events", key: "inbox_item_id", scope: "inbox" },
  { table: "supervised_agent_publications", key: "inbox_item_id", scope: "inbox" },
  { table: "supervised_agent_provider_turn_bindings", key: "agent_id", scope: "inbox" },
  { table: "effects", key: "agent_id", scope: "inbox" },
  { table: "effect_tombstones", key: "agent_id", scope: "inbox" },
  { table: "provider_continuation_repairs", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_ingress_health", key: "agent_id", scope: "inbox" },
  { table: "agents", key: "agent_id", scope: "manifest" },
  {
    table: "agents",
    key: "agent_id",
    scope: "inbox",
    updateOf: ["work_attempt_id", "provider_continuation_id", "turn_control_inbox_item_id", "turn_control_status", "turn_control_json"],
  },
  { table: "activity_events", key: "agent_id", scope: "manifest" },
];

function agentStateVersionBump(source: AgentStateVersionSource, row: "NEW" | "OLD", onlyWhenMoved = false): string {
  const inbox = source.scope === "inbox" || source.scope === "both" ? 1 : 0;
  const manifest = source.scope === "manifest" || source.scope === "both" ? 1 : 0;
  const upsert = `ON CONFLICT(agent_id) DO UPDATE SET inbox_version = inbox_version + ${inbox}, manifest_version = manifest_version + ${manifest}`;
  const moved = onlyWhenMoved ? ` AND OLD.${source.key} IS NOT NEW.${source.key}` : "";
  return source.key === "agent_id"
    ? `INSERT INTO agent_state_versions(agent_id, inbox_version, manifest_version) SELECT ${row}.agent_id, ${inbox}, ${manifest} WHERE 1${moved} ${upsert};`
    : `INSERT INTO agent_state_versions(agent_id, inbox_version, manifest_version) SELECT agent_id, ${inbox}, ${manifest} FROM inbox_items WHERE inbox_item_id = ${row}.inbox_item_id${moved} ${upsert};`;
}

export function agentStateVersionTriggers(source: AgentStateVersionSource): Record<string, string> {
  const name = `agent_state_versions_${source.table}_${source.scope}`;
  const updateOf = source.updateOf ? ` OF ${source.updateOf.join(", ")}` : "";
  return {
    [`${name}_insert`]: `CREATE TRIGGER ${name}_insert AFTER INSERT ON ${source.table} BEGIN ${agentStateVersionBump(source, "NEW")} END`,
    [`${name}_update`]: `CREATE TRIGGER ${name}_update AFTER UPDATE${updateOf} ON ${source.table} BEGIN ${agentStateVersionBump(source, "NEW")} ${agentStateVersionBump(source, "OLD", true)} END`,
    [`${name}_delete`]: `CREATE TRIGGER ${name}_delete AFTER DELETE ON ${source.table} BEGIN ${agentStateVersionBump(source, "OLD")} END`,
  };
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(table, column));
}

export function validateAgentStateVersionSchema(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(AGENT_STATE_VERSIONS_TABLE) as Row | undefined;
  if (!table || normalizeSchemaSql(String(table.sql)) !== normalizeSchemaSql(agentStateVersionsTableSql)) {
    throw new Error("Agent state version storage is missing or invalid.");
  }
  for (const source of agentStateVersionSources) {
    if (!tableExists(database, source.table)) continue;
    for (const column of [source.key, ...(source.updateOf ?? [])]) {
      if (!columnExists(database, source.table, column)) {
        throw new Error(`Agent state versions cannot follow ${source.table}: it has no ${column} column.`);
      }
    }
    for (const [name, sql] of Object.entries(agentStateVersionTriggers(source))) {
      const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as Row | undefined;
      if (!actual || normalizeSchemaSql(String(actual.sql)) !== normalizeSchemaSql(sql)) {
        throw new Error(`Agent state version trigger ${name} is missing or invalid.`);
      }
    }
  }
}

export function applyAgentStateVersionSchema(database: DatabaseSync): void {
  if (database.isTransaction) {
    applyAgentStateVersionSchemaInTransaction(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    applyAgentStateVersionSchemaInTransaction(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

function applyAgentStateVersionSchemaInTransaction(database: DatabaseSync): void {
  if (!tableExists(database, AGENT_STATE_VERSIONS_TABLE)) database.exec(agentStateVersionsTableSql);
  const expected = new Set<string>();
  for (const source of agentStateVersionSources) {
    if (!tableExists(database, source.table)) continue;
    for (const [name, sql] of Object.entries(agentStateVersionTriggers(source))) {
      expected.add(name);
      const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as Row | undefined;
      if (actual && normalizeSchemaSql(String(actual.sql)) === normalizeSchemaSql(sql)) continue;
      if (actual) database.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
      database.exec(sql);
    }
  }
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'agent_state_versions_*'").all() as Row[]) {
    if (!expected.has(String(row.name))) database.exec(`DROP TRIGGER ${quoteIdentifier(String(row.name))}`);
  }
  validateAgentStateVersionSchema(database);
}
