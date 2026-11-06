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
/**
 * Per-agent change counters that the database keeps itself. A trigger on
 * every table an agent's state is read from moves the agent's counter on each
 * row change, so a write by any connection or process (the inbox store, the
 * manifest store's turn-control transactions, a retired daemon during handoff)
 * counts, and a writer that forgets to report a change cannot leave a counter
 * unchanged. `inbox_version` moves with the tables the read model's inbox
 * inputs are read from (daemon-read-model.ts inboxInputs); `manifest_version`
 * with the tables one manifest entry is projected from (manifest-store
 * MANIFEST_ENTRY_SELECT and projectionFromRow). A reader compares a counter to
 * the one it read before and reads the agent's rows again only when it moved.
 * An agent without a row is at version 0.
 *
 * Applied additively, like the read indexes: at the end of createSchema and
 * when a store opens its connection, because a table rebuilt by a repair loses
 * its triggers. The triggers never fail a write: every key column is NOT NULL,
 * and a missing inbox parent inserts nothing. A migration that renames or
 * rebuilds a source table drops them first (dropAgentStateVersionTriggers): the
 * triggers on the tables keyed by inbox item name supervised_agent_inbox in
 * their bodies, and a dropped table they name fails every later write.
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
  /** The column that holds the agent, or the inbox item the agent is found through (supervised_agent_inbox). */
  key: "agent_id" | "inbox_item_id";
  scope: AgentStateVersionScope;
  /** When set, an UPDATE counts only when one of these columns changes; INSERT and DELETE always count. */
  updateOf?: readonly string[];
};
export const agentStateVersionSources: readonly AgentStateVersionSource[] = [
  // Inbox inputs of an entry's view: receipts and their timelines, the
  // blocked-head skip and its refusal, the uncertain-effect facts of a
  // follow-up, the latest continuation repair, ingress health.
  { table: "supervised_agent_inbox", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_inbox_events", key: "inbox_item_id", scope: "inbox" },
  { table: "supervised_agent_publications", key: "inbox_item_id", scope: "inbox" },
  { table: "supervised_agent_provider_turn_bindings", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_effects", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_effect_tombstones", key: "agent_id", scope: "inbox" },
  { table: "provider_continuation_repairs", key: "agent_id", scope: "inbox" },
  { table: "supervised_agent_ingress_health", key: "agent_id", scope: "inbox" },
  // supervised_agent_terminal_results is read for a blocked head's refusal,
  // but it is only written in the transaction that also updates the item's
  // inbox row (supervised-agent-inbox-store/delivery.ts), whose trigger counts
  // for both, and the previous daemon refuses a database with a trigger on it.
  // The turn-control journal joins the entry and tells a blocked head's turn.
  { table: "turn_control_journals", key: "agent_id", scope: "both" },
  // The runtime deployment is the entry's runtime (every column), and tells a
  // blocked head's refusal whether its turn can still be running (the work
  // attempt and conversation only): the liveness it records on every activity
  // batch must not cost the inbox inputs a read.
  { table: "runtime_deployments", key: "agent_id", scope: "manifest" },
  { table: "runtime_deployments", key: "agent_id", scope: "inbox",
    updateOf: ["work_attempt_id_present", "work_attempt_id", "provider_ref_present", "provider_continuation_id"] },
  // One manifest entry.
  { table: "agent_identities", key: "agent_id", scope: "manifest" },
  { table: "agent_profiles", key: "agent_id", scope: "manifest" },
  { table: "agent_room_memberships", key: "agent_id", scope: "manifest" },
  { table: "agent_configurations", key: "agent_id", scope: "manifest" },
  { table: "agent_launch_intents", key: "agent_id", scope: "manifest" },
  { table: "agent_lifecycle_states", key: "agent_id", scope: "manifest" },
  { table: "agent_readiness", key: "agent_id", scope: "manifest" },
  { table: "turn_control_sequence_watermarks", key: "agent_id", scope: "manifest" },
  { table: "retained_worker_bindings", key: "agent_id", scope: "manifest" },
  { table: "reconciliation_records", key: "agent_id", scope: "manifest" },
  { table: "activity_events", key: "agent_id", scope: "manifest" },
  { table: "turn_control_stages", key: "agent_id", scope: "manifest" },
  { table: "reconciliation_completed_actions", key: "agent_id", scope: "manifest" },
  { table: "reconciliation_exit_timestamps", key: "agent_id", scope: "manifest" },
  { table: "reconciliation_notices", key: "agent_id", scope: "manifest" },
];
function agentStateVersionBump(source: AgentStateVersionSource, row: "NEW" | "OLD", onlyWhenMoved = false): string {
  const inbox = source.scope === "inbox" || source.scope === "both" ? 1 : 0;
  const manifest = source.scope === "manifest" || source.scope === "both" ? 1 : 0;
  const upsert = `ON CONFLICT(agent_id) DO UPDATE SET inbox_version = inbox_version + ${inbox}, manifest_version = manifest_version + ${manifest}`;
  // An UPDATE that moves a row to another agent also counts for the agent it left.
  const moved = onlyWhenMoved ? ` AND OLD.${source.key} IS NOT NEW.${source.key}` : "";
  return source.key === "agent_id"
    ? `INSERT INTO agent_state_versions(agent_id, inbox_version, manifest_version) SELECT ${row}.agent_id, ${inbox}, ${manifest} WHERE 1${moved} ${upsert};`
    : `INSERT INTO agent_state_versions(agent_id, inbox_version, manifest_version) SELECT agent_id, ${inbox}, ${manifest} FROM supervised_agent_inbox WHERE inbox_item_id = ${row}.inbox_item_id${moved} ${upsert};`;
}
/** The triggers of one source, by name. */
export function agentStateVersionTriggers(source: AgentStateVersionSource): Record<string, string> {
  const name = `agent_state_versions_${source.table}_${source.scope}`;
  const updateOf = source.updateOf ? ` OF ${source.updateOf.join(", ")}` : "";
  return {
    [`${name}_insert`]: `CREATE TRIGGER ${name}_insert AFTER INSERT ON ${source.table} BEGIN ${agentStateVersionBump(source, "NEW")} END`,
    [`${name}_update`]: `CREATE TRIGGER ${name}_update AFTER UPDATE${updateOf} ON ${source.table} BEGIN ${agentStateVersionBump(source, "NEW")} ${agentStateVersionBump(source, "OLD", true)} END`,
    [`${name}_delete`]: `CREATE TRIGGER ${name}_delete AFTER DELETE ON ${source.table} BEGIN ${agentStateVersionBump(source, "OLD")} END`,
  };
}
const normalizeSchemaSql = (value: string) => value.replace(/\s+/g, " ").trim();
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
      if (!columnExists(database, source.table, column)) throw new Error(`Agent state versions cannot follow ${source.table}: it has no ${column} column.`);
    }
    for (const [name, sql] of Object.entries(agentStateVersionTriggers(source))) {
      const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as Row | undefined;
      if (!actual || normalizeSchemaSql(String(actual.sql)) !== normalizeSchemaSql(sql)) {
        throw new Error(`Agent state version trigger ${name} is missing or invalid.`);
      }
    }
  }
}
/**
 * Create the table and every missing or outdated trigger of a source table
 * that exists; then validate. Idempotent, and atomic against another process
 * opening the same fresh database: the checks and the creates share one write
 * transaction (an outer transaction, if any, is used as it is).
 */
export function applyAgentStateVersionSchema(database: DatabaseSync): void {
  if (database.isTransaction) { applyAgentStateVersionSchemaInTransaction(database); return; }
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
      // A trigger of an older definition is replaced, so the definition here is the whole truth.
      if (actual) database.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
      database.exec(sql);
    }
  }
  // A trigger of a source that no longer exists here (a table dropped from the list) goes too.
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'agent_state_versions_*'").all() as Row[]) {
    if (!expected.has(String(row.name))) database.exec(`DROP TRIGGER ${quoteIdentifier(String(row.name))}`);
  }
  validateAgentStateVersionSchema(database);
}
/** For a migration that renames or rebuilds a source table: drop every version trigger first; the next open re-applies them. */
export function dropAgentStateVersionTriggers(database: DatabaseSync): void {
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'agent_state_versions_*'").all() as Row[]) {
    database.exec(`DROP TRIGGER ${quoteIdentifier(String(row.name))}`);
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
