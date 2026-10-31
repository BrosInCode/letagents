/** Shared constants, SQL helpers and validators for the daemon-state schema modules. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { compactSupervisedTerminalHistory } from "../supervised-agent-history-retention.js";
import type { DaemonStateSchema } from "./schema.js";

export const DAEMON_STATE_SCHEMA_VERSION = 51;
export const SCHEMA_VERSION = DAEMON_STATE_SCHEMA_VERSION;
export const workerExecutionBindingsSql = `CREATE TABLE worker_execution_bindings (
  entry_id TEXT NOT NULL, room_id TEXT NOT NULL, api_url TEXT NOT NULL,
  grant_id TEXT NOT NULL, work_attempt_id TEXT NOT NULL,
  execution_generation_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
  agent_key TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(entry_id,execution_generation_id,agent_session_id,grant_id),
  FOREIGN KEY(work_attempt_id) REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE
) STRICT`;
export function validateWorkerExecutionBindings(database: DatabaseSync): void {
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name='worker_execution_bindings'").get();
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  if (normalize(String(actual?.sql ?? "")) !== normalize(workerExecutionBindingsSql)) {
    throw new Error("Worker execution custody schema is invalid.");
  }
}
export function applyWorkerExecutionBindings(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='worker_execution_bindings'").get()) {
    database.exec(workerExecutionBindingsSql);
  }
  validateWorkerExecutionBindings(database);
}

// SQLite appends rowid to ordinary index keys, so reverse traversal also
// preserves the latest-repair tie breaker without a temporary sort.
export const daemonReadIndexes = {
  provider_continuation_repairs_agent_created: "CREATE INDEX provider_continuation_repairs_agent_created ON provider_continuation_repairs(agent_id,created_at)",
  provider_continuation_repairs_inbox_created: "CREATE INDEX provider_continuation_repairs_inbox_created ON provider_continuation_repairs(inbox_item_id,created_at)",
  activity_events_summary: "CREATE INDEX activity_events_summary ON activity_events(agent_id,sequence,sort_order)",
};
export function validateDaemonReadIndexes(database: DatabaseSync): void {
  for (const [name, sql] of Object.entries(daemonReadIndexes)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
    if (!actual || normalizedTerminalSql(String(actual.sql)) !== normalizedTerminalSql(sql)) {
      throw new Error(`Daemon read index ${name} is missing or invalid.`);
    }
  }
}
export function applyDaemonReadIndexes(database: DatabaseSync): void {
  for (const [name, sql] of Object.entries(daemonReadIndexes)) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)) database.exec(sql);
  }
  validateDaemonReadIndexes(database);
}
/**
 * v50: whether an agent's owner says its model reads images. Only an Open
 * Model agent can be given images on this choice; every other agent app
 * either always takes them or never does. Off for every existing agent.
 */
export const IMAGE_INPUT_COLUMN = "image_input INTEGER NOT NULL DEFAULT 0 CHECK (image_input IN (0, 1))";
export function applyAgentImageInputColumn(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM pragma_table_info('agent_configurations') WHERE name='image_input'").get()) {
    database.exec(`ALTER TABLE agent_configurations ADD COLUMN ${IMAGE_INPUT_COLUMN}`);
  }
  validateAgentImageInputColumn(database);
}
export function validateAgentImageInputColumn(database: DatabaseSync): void {
  const column = database.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agent_configurations') WHERE name='image_input'").get() as Row | undefined;
  if (!column || String(column.type).toUpperCase() !== "INTEGER" || Number(column.required) !== 1 || String(column.dflt_value) !== "0"
    || database.prepare("SELECT 1 FROM agent_configurations WHERE image_input NOT IN (0, 1) LIMIT 1").get()) {
    throw new Error("Agent configuration storage has an invalid image input column.");
  }
}
/**
 * v51: whether an agent's owner shares its live activity with the room: off,
 * on, or off while the room may still show earlier turns that the daemon must
 * remove. Only the owner's desktop turns it on, and the daemon publishes
 * nothing while it is not on. Off for every existing agent.
 */
export const LIVE_SHARING_COLUMN = "live_sharing TEXT NOT NULL DEFAULT 'off' CHECK (live_sharing IN ('off', 'on', 'withdrawing'))";
export function applyAgentLiveSharingColumn(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM pragma_table_info('agent_configurations') WHERE name='live_sharing'").get()) {
    database.exec(`ALTER TABLE agent_configurations ADD COLUMN ${LIVE_SHARING_COLUMN}`);
  }
  validateAgentLiveSharingColumn(database);
}
export function validateAgentLiveSharingColumn(database: DatabaseSync): void {
  const column = database.prepare("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('agent_configurations') WHERE name='live_sharing'").get() as Row | undefined;
  if (!column || String(column.type).toUpperCase() !== "TEXT" || Number(column.required) !== 1 || String(column.dflt_value) !== "'off'"
    || database.prepare("SELECT 1 FROM agent_configurations WHERE live_sharing NOT IN ('off', 'on', 'withdrawing') LIMIT 1").get()) {
    throw new Error("Agent configuration storage has an invalid live sharing column.");
  }
}
export function applyDaemonEfficiencyMigration(database: DatabaseSync): void {
  applyDaemonReadIndexes(database);
  for (const row of database.prepare("SELECT DISTINCT agent_id FROM supervised_agent_inbox").all()) {
    compactSupervisedTerminalHistory(database, String(row.agent_id));
  }
}
/**
 * v49: the desktop engine that delivered room events to agents is retired, so
 * an agent stored with that delivery mode is a polling agent now. Runs before
 * any version branch because every later shape validator rejects the value.
 */
export function retireDesktopEventsDelivery(database: DatabaseSync): void {
  const column = database.prepare("SELECT 1 FROM pragma_table_info('agent_configurations') WHERE name = 'delivery_mode'").get();
  if (!column) return;
  database.exec("UPDATE agent_configurations SET delivery_mode = 'mcp_polling' WHERE delivery_mode = 'desktop_events'");
}

export const INBOX_STATES_V17 = "'pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user'";
export const INBOX_STATE_CONSTRAINT = /state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(([^)]+)\)\s*\)/i;
export type Row = Record<string, unknown>;
export function parseJson<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
export function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
export function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

export const TERMINAL_RESULTS_TABLE = "supervised_agent_terminal_results";
export const POLLING_CONTRACT_COLUMN = "polling_contract TEXT CHECK(polling_contract IS NULL OR (polling_contract='custodial_polling_v1' AND delivery_mode='mcp_polling'))";
export const CUSTODIAL_LAUNCH_SESSION_COLUMN = "custodial_launch_agent_session_id TEXT CHECK(custodial_launch_agent_session_id IS NULL OR length(trim(custodial_launch_agent_session_id))>0)";
export const TERMINAL_RESULTS_INDEX = "CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id)";
export function terminalResultsSql(version: 19 | 20, table = TERMINAL_RESULTS_TABLE): string {
  return `CREATE TABLE ${table} (
    inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable'${version === 20 ? ",'failed','interrupted'" : ""})),
    normalized_text TEXT, evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
    terminal_evidence_json TEXT NOT NULL, observed_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ${version === 20 ? ",CHECK(outcome NOT IN ('failed','interrupted') OR (normalized_text IS NULL AND evidence_source <> 'none'))" : ""}
  ) STRICT`;
}

export function normalizedTerminalSql(sql: string): string {
  // Preserve case-sensitive CHECK values; ALTER TABLE may quote identifiers.
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map((part) => part.startsWith("'") ? part
    : part.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "").replaceAll('"', "").replace(/\s+/g, "").toLowerCase())
    .join("").replace(/;$/, "");
}

/** Custody is durable configuration: never repair a missing value or weakened contract. */
export function validatePollingContract(database: DatabaseSync): void {
  const column = (database.prepare("PRAGMA table_xinfo(agent_configurations)").all() as Row[])
    .find((entry) => entry.name === "polling_contract");
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_configurations'").get() as Row | undefined;
  const sql = normalizedTerminalSql(String(definition?.sql ?? ""));
  const declaration = `,${normalizedTerminalSql(POLLING_CONTRACT_COLUMN)}`;
  if (!column || column.type !== "TEXT" || Number(column.notnull) !== 0 || column.dflt_value !== null
    || Number(column.hidden) !== 0 || Number(column.pk) !== 0
    || !(sql.includes(`${declaration},`) || sql.endsWith(`${declaration})strict`))) {
    throw new Error("Daemon polling custody has an invalid or missing column definition.");
  }
  if (database.prepare(`SELECT 1 FROM agent_configurations WHERE polling_contract IS NOT NULL
    AND (polling_contract <> 'custodial_polling_v1' OR delivery_mode IS NOT 'mcp_polling') LIMIT 1`).get()) {
    throw new Error("Daemon polling custody contains invalid configuration.");
  }
}

/** The immutable native launch environment cannot be reconstructed from a
 * reminted worker binding. Existing runtimes deliberately retain NULL. */
export function validateCustodialLaunchSession(database: DatabaseSync): void {
  const column = (database.prepare("PRAGMA table_xinfo(runtime_deployments)").all() as Row[])
    .find(entry => entry.name === "custodial_launch_agent_session_id");
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_deployments'").get() as Row | undefined;
  const sql = normalizedTerminalSql(String(definition?.sql ?? ""));
  const declaration = `,${normalizedTerminalSql(CUSTODIAL_LAUNCH_SESSION_COLUMN)}`;
  if (!column || column.type !== "TEXT" || Number(column.notnull) !== 0 || column.dflt_value !== null
    || Number(column.hidden) !== 0 || Number(column.pk) !== 0
    || !(sql.includes(`${declaration},`) || sql.endsWith(`${declaration})strict`))) {
    throw new Error("Daemon custodial launch receipt has an invalid or missing column definition.");
  }
  if (database.prepare("SELECT 1 FROM runtime_deployments WHERE custodial_launch_agent_session_id IS NOT NULL AND length(trim(custodial_launch_agent_session_id))=0 LIMIT 1").get()) {
    throw new Error("Daemon custodial launch receipt contains invalid authority.");
  }
}

/** Terminal rows are authority: never repair a lost or weakened definition. */
export function validateTerminalResults(database: DatabaseSync, requiredVersion?: 20): 19 | 20 {
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TERMINAL_RESULTS_TABLE) as Row | undefined;
  const version = ([20, 19] as const).find((candidate) => (!requiredVersion || candidate === requiredVersion)
    && definition && normalizedTerminalSql(String(definition.sql)) === normalizedTerminalSql(terminalResultsSql(candidate)));
  if (!version) throw new Error("Daemon terminal-result authority has an invalid or missing table definition.");
  const index = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='supervised_agent_terminal_result_turn'").get() as Row | undefined;
  const indexes = database.prepare("PRAGMA index_list(supervised_agent_terminal_results)").all() as Row[];
  if (!index || normalizedTerminalSql(String(index.sql)) !== normalizedTerminalSql(TERMINAL_RESULTS_INDEX)
    || indexes.length !== 2 || indexes.filter((entry) => entry.origin === "pk" && Number(entry.unique) === 1).length !== 1
    || database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(TERMINAL_RESULTS_TABLE)) {
    throw new Error("Daemon terminal-result authority has invalid indexes or triggers.");
  }
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]) {
    if ((database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(String(name))})`).all() as Row[])
      .some((key) => key.table === TERMINAL_RESULTS_TABLE)) {
      throw new Error("Daemon terminal-result authority has an unrecognized inbound dependency.");
    }
  }
  if (database.prepare("PRAGMA foreign_key_check(supervised_agent_terminal_results)").get()
    || database.prepare(`SELECT 1 FROM supervised_agent_terminal_results
      WHERE outcome NOT IN ('reply','no_reply','unreadable'${version === 20 ? ",'failed','interrupted'" : ""})
        OR evidence_source NOT IN ('transcript','stream','none')
        OR (outcome IN ('failed','interrupted') AND (normalized_text IS NOT NULL OR evidence_source='none')) LIMIT 1`).get()) {
    throw new Error("Daemon terminal-result authority contains invalid evidence.");
  }
  return version;
}


/** Types an object of DaemonStateSchema methods; `this` is the composed schema instance. */
export function schemaMethods<T>(methods: T & ThisType<DaemonStateSchema>): T { return methods; }
