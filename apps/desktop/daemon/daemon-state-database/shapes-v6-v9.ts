/** Inspector history and delivery shapes (v8, v9), v6/v7 repair and the v6 secret scrub. */
import type { DatabaseSync } from "node:sqlite";
import { type Row, run, quoteIdentifier, terminalResultsSql, validateTerminalResults, schemaMethods } from "./shared.js";

export const shapesV6ToV9 = schemaMethods({
/** Preserve later authority when repairing an older physical inbox shape. */
detachLaterInboxTables(database: DatabaseSync, names: string[]): () => void {
  const saved = names.flatMap((table) => {
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!definition) return [];
    const objects = (database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
      .all(table) as Row[]).map((row) => String(row.sql));
    database.exec(`CREATE TEMP TABLE ${quoteIdentifier(`inbox_repair_${table}`)} AS SELECT * FROM ${quoteIdentifier(table)}`);
    database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    return [{ table, sql: String(definition.sql), objects }];
  });
  return () => {
    for (const item of saved) {
      database.exec(item.sql);
      database.exec(`INSERT INTO ${quoteIdentifier(item.table)} SELECT * FROM temp.${quoteIdentifier(`inbox_repair_${item.table}`)}`);
      database.exec(`DROP TABLE temp.${quoteIdentifier(`inbox_repair_${item.table}`)}`);
      for (const object of item.objects) database.exec(object);
    }
  };
},

applyV8Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_publications (
      inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE(room_id,client_message_id),
      UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_publications_agent_room
      ON supervised_agent_publications(agent_id,room_id);
    CREATE TABLE IF NOT EXISTS supervised_agent_history_boundaries (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      earliest_retained_observed_message_id TEXT,
      earliest_retained_inbox_message_id TEXT,
      earliest_retained_receipt_sequence INTEGER,
      pruned_before_message_id TEXT,
      pruned_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_history_boundaries_updated
      ON supervised_agent_history_boundaries(agent_id,updated_at);
    CREATE TABLE IF NOT EXISTS supervised_agent_pruned_sources (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      pruned_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id,source_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_pruned_sources_retention
      ON supervised_agent_pruned_sources(agent_id,pruned_at,source_message_id);
  `);
},

validateV8Shape(database: DatabaseSync): void {
  const canonical: Record<string, string> = {
    supervised_agent_publications: `CREATE TABLE supervised_agent_publications (inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,agent_id TEXT NOT NULL,room_id TEXT NOT NULL,client_message_id TEXT NOT NULL,canonical_message_id TEXT NOT NULL,published_at TEXT NOT NULL,UNIQUE(room_id,client_message_id),UNIQUE(room_id,canonical_message_id)) STRICT`,
    supervised_agent_history_boundaries: `CREATE TABLE supervised_agent_history_boundaries (agent_id TEXT NOT NULL,room_id TEXT NOT NULL,earliest_retained_observed_message_id TEXT,earliest_retained_inbox_message_id TEXT,earliest_retained_receipt_sequence INTEGER,pruned_before_message_id TEXT,pruned_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(agent_id,room_id)) STRICT`,
    supervised_agent_pruned_sources: `CREATE TABLE supervised_agent_pruned_sources (agent_id TEXT NOT NULL,room_id TEXT NOT NULL,source_message_id TEXT NOT NULL,pruned_at TEXT NOT NULL,PRIMARY KEY(agent_id,room_id,source_message_id)) STRICT`,
  };
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  for (const [table, expected] of Object.entries(canonical)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(expected)) throw new Error(`Daemon state v8 table ${table} does not match its canonical definition.`);
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || Number(info.wr) !== 0) throw new Error(`Daemon state v8 table ${table} has an invalid strict schema.`);
  }
  const indexes: Record<string, { table: string; unique: number; columns: string[] }> = {
    supervised_agent_publications_agent_room: { table: "supervised_agent_publications", unique: 0, columns: ["agent_id", "room_id"] },
    supervised_agent_history_boundaries_updated: { table: "supervised_agent_history_boundaries", unique: 0, columns: ["agent_id", "updated_at"] },
    supervised_agent_pruned_sources_retention: { table: "supervised_agent_pruned_sources", unique: 0, columns: ["agent_id", "pruned_at", "source_message_id"] },
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    if (!listed || Number(listed.unique) !== expected.unique || Number(listed.partial) !== 0 || String(listed.origin) !== "c" || terms.length !== expected.columns.length || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index] || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v8 index ${name} is invalid.`);
  }
},

repairAndValidateV8Shape(database: DatabaseSync): void {
  const needsRepair = !this.tableColumns(database, "supervised_agent_publications").size || !this.tableColumns(database, "supervised_agent_history_boundaries").size || !this.tableColumns(database, "supervised_agent_pruned_sources").size;
  // Preserve v7's security scrub and shape-repair guards before accepting v8.
  if (!needsRepair) { this.repairAndValidateV7Shape(database); this.validateV8Shape(database); return; }
  database.exec("BEGIN IMMEDIATE");
  try { this.validateV7Shape(database); this.applyV8Shape(database); this.validateV8Shape(database); database.exec("COMMIT"); }
  catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
},

/**
 * V9 deliberately rebuilds the small, bounded delivery-history tables. The
 * old uniqueness key omitted room_id, which made a reused room message id
 * collide across room moves for the same durable agent.
 */
applyV9Shape(database: DatabaseSync): void {
  const terminalVersion = validateTerminalResults(database);
  const restoreLaterAuthority = this.detachLaterInboxTables(database, ["provider_continuation_repairs", "supervised_agent_provider_turn_bindings", "supervised_agent_prepared_context"]);
  database.exec(`
    PRAGMA defer_foreign_keys = ON;
    ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_v8;
    ALTER TABLE supervised_agent_observed_messages RENAME TO supervised_agent_observed_messages_v8;

    CREATE TABLE supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT, outcome TEXT, last_error TEXT,
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
      UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
      UNIQUE(inbox_item_id,agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_v8;

    CREATE TABLE supervised_agent_inbox_events_v9 (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
      observed_at TEXT NOT NULL, detail TEXT,
      PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
    ) STRICT;
    INSERT INTO supervised_agent_inbox_events_v9 SELECT * FROM supervised_agent_inbox_events;

    ${terminalResultsSql(terminalVersion, "supervised_agent_terminal_results_v9")};
    INSERT INTO supervised_agent_terminal_results_v9 SELECT * FROM supervised_agent_terminal_results;

    CREATE TABLE supervised_agent_publications_v9 (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
      UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_publications_v9 SELECT * FROM supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_events;
    DROP TABLE supervised_agent_terminal_results;
    DROP TABLE supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_v8;

    CREATE TABLE supervised_agent_observed_messages (
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      activation_decision TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id,source_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_observed_messages SELECT * FROM supervised_agent_observed_messages_v8;
    DROP TABLE supervised_agent_observed_messages_v8;

    ALTER TABLE supervised_agent_inbox_events_v9 RENAME TO supervised_agent_inbox_events;
    ALTER TABLE supervised_agent_terminal_results_v9 RENAME TO supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_publications_v9 RENAME TO supervised_agent_publications;
    CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
    CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
    CREATE INDEX supervised_agent_observed_context ON supervised_agent_observed_messages(agent_id,room_id,source_message_id);
    CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);

    ALTER TABLE supervised_agent_history_boundaries RENAME TO supervised_agent_history_boundaries_v8;
    CREATE TABLE supervised_agent_history_boundaries (
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      earliest_retained_observed_message_id TEXT, earliest_retained_inbox_message_id TEXT,
      earliest_retained_receipt_sequence INTEGER,
      pruned_before_message_id TEXT, pruned_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((pruned_before_message_id IS NULL) = (pruned_at IS NULL)),
      PRIMARY KEY(agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_history_boundaries
      SELECT agent_id,room_id,earliest_retained_observed_message_id,earliest_retained_inbox_message_id,earliest_retained_receipt_sequence,
        CASE WHEN pruned_before_message_id IS NULL OR pruned_at IS NULL THEN NULL ELSE pruned_before_message_id END,
        CASE WHEN pruned_before_message_id IS NULL OR pruned_at IS NULL THEN NULL ELSE pruned_at END,
        updated_at
      FROM supervised_agent_history_boundaries_v8;
    DROP TABLE supervised_agent_history_boundaries_v8;
    CREATE INDEX supervised_agent_history_boundaries_updated ON supervised_agent_history_boundaries(agent_id,updated_at);
  `);
  restoreLaterAuthority();
},

validateV9Shape(database: DatabaseSync): void {
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  const observed = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_observed_messages'").get() as Row | undefined;
  const publications = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as Row | undefined;
  const boundaries = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_history_boundaries'").get() as Row | undefined;
  for (const [name, row] of Object.entries({ inbox, observed, publications, boundaries })) {
    if (!row || !/STRICT\s*$/i.test(String(row.sql))) throw new Error(`Daemon state v9 table ${name} is invalid.`);
  }
  const inboxSql = String(inbox?.sql);
  const observedSql = String(observed?.sql);
  const publicationsSql = String(publications?.sql);
  const boundariesSql = String(boundaries?.sql);
  if (!/UNIQUE\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i.test(inboxSql)
    || !/PRIMARY KEY\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i.test(observedSql)
    || !/FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i.test(publicationsSql)
    || !/CHECK\s*\(\s*\(\s*pruned_before_message_id\s+IS\s+NULL\s*\)\s*=\s*\(\s*pruned_at\s+IS\s+NULL\s*\)\s*\)/i.test(boundariesSql)) {
    throw new Error("Daemon state v9 delivery-history constraints are invalid.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_inbox GROUP BY agent_id,room_id,source_message_id HAVING COUNT(*) > 1 LIMIT 1").get()) {
    throw new Error("Daemon state v9 inbox room-scoped uniqueness is invalid.");
  }
  const publicationIndex = database.prepare("PRAGMA index_info('supervised_agent_publications_agent_room')").all() as Row[];
  if (publicationIndex.map((row) => String(row.name)).join(",") !== "agent_id,room_id") {
    throw new Error("Daemon state v9 publication index is invalid.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_history_boundaries WHERE (pruned_before_message_id IS NULL) <> (pruned_at IS NULL) LIMIT 1").get()) {
    throw new Error("Daemon state v9 history boundary pruning fields are invalid.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_publications p LEFT JOIN supervised_agent_inbox i
    ON i.inbox_item_id=p.inbox_item_id AND i.agent_id=p.agent_id AND i.room_id=p.room_id
    WHERE i.inbox_item_id IS NULL LIMIT 1`).get()) {
    throw new Error("Daemon state v9 publication parent identity is invalid.");
  }
  if ((database.prepare("PRAGMA foreign_key_check").all() as Row[]).length) {
    throw new Error("Daemon state v9 foreign key integrity check failed.");
  }
},

hasV9DeliveryHistoryShape(database: DatabaseSync): boolean {
  const publication = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as Row | undefined;
  return Boolean(publication && /FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i.test(String(publication.sql)));
},

/**
 * All legacy markers must reach this exact physical delivery shape before
 * either version marker advances. Older schemas have no inbox tables at all,
 * while interrupted upgrades can already have v6-v8 tables, so this path is
 * intentionally additive until the final v9 rebuild.
 */
advanceDeliveryToCurrent(database: DatabaseSync): void {
  if (this.hasV9DeliveryHistoryShape(database)) {
    this.validateV9Shape(database);
    return;
  }
  this.applyBoundedDeliveryV6Shape(database);
  this.validateBoundedDeliveryV6Shape(database);
  this.applyV7Shape(database);
  this.validateV7Shape(database);
  this.applyV8Shape(database);
  this.validateV8Shape(database);
  this.applyV9Shape(database);
  this.validateV9Shape(database);
},

repairAndValidateV9Shape(database: DatabaseSync): void {
  this.repairAndValidateV7Shape(database);
  this.validateV9Shape(database);
},

/**
 * Older-version test fixtures can carry a newer physical worker table after a
 * version-marker rollback.  Prefer its already-secret-free v6 shape; real
 * v1–v5 databases still build and validate each predecessor in order.
 */
migrateWorkerShapeToV6(database: DatabaseSync): boolean {
  const columns = this.tableColumns(database, "worker_session_bindings");
  const requiresScrub = columns.has("agent_session_token");
  if (!columns.has("credential_ref")) {
    this.applyV4Shape(database);
    this.validateV4Shape(database);
  }
  this.applyV5Shape(database);
  this.validateV5Shape(database);
  // Test fixtures and interrupted version-marker repairs may already carry
  // the secret-free v7 delivery shape. Never try to validate that expanded
  // state machine against the narrower v6 CHECK constraints.
  if (this.tableColumns(database, "supervised_agent_terminal_results").size) {
    if (requiresScrub) this.applyV6Shape(database);
    this.validateV7Shape(database);
    if (this.hasV9DeliveryHistoryShape(database)) {
      this.validateV9Shape(database);
      return requiresScrub;
    }
    this.applyV8Shape(database);
    this.validateV8Shape(database);
    return requiresScrub;
  }
  this.applyV6Shape(database);
  this.validateV6Shape(database);
  this.applyBoundedDeliveryV6Shape(database);
  this.validateBoundedDeliveryV6Shape(database);
  this.applyV7Shape(database);
  this.validateV7Shape(database);
  this.applyV8Shape(database);
  this.validateV8Shape(database);
  return requiresScrub;
},

repairAndValidateV7Shape(database: DatabaseSync): void {
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v7 must not persist agent_session_token.");
  }
  const hasV13DeliveryShape = this.tableColumns(database, "supervised_agent_inbox").has("failure_code");
  const needsLegacyPresenceRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  const needsV2AdditiveRepair = !this.tableColumns(database, "agent_configurations").has("provider_launch_policy_undefined")
    || !this.tableColumns(database, "runtime_deployments").has("provider_process_identity_present");
  const needsBoundedDeliveryRepair = !this.tableColumns(database, "agent_configurations").has("delivery_mode")
    || !this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id")
    || !this.tableColumns(database, "turn_control_journals").has("inbox_item_id")
    || !this.tableColumns(database, "turn_control_journals").has("correction_text")
    || !this.tableColumns(database, "turn_control_journals").has("correction_strategy")
    || !this.tableColumns(database, "turn_control_journals").has("operator_resolution");
  const needsV7AdditiveRepair = !this.tableColumns(database, "supervised_agent_terminal_results").size
    || (!hasV13DeliveryShape && !this.tableColumns(database, "supervised_agent_inbox_events").size);
  const deferMissingV13Events = hasV13DeliveryShape
    && !this.tableColumns(database, "supervised_agent_inbox_events").size;
  if (hasV13DeliveryShape && !this.tableColumns(database, "supervised_agent_terminal_results").size) {
    throw new Error("Daemon state v13 is missing terminal-result evidence and cannot safely reconstruct it.");
  }
  if (!needsLegacyPresenceRepair && !needsV2AdditiveRepair && !needsBoundedDeliveryRepair && !needsV7AdditiveRepair) {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database, false);
    this.validateBoundedDeliveryV6Shape(database);
    this.validateV7Shape(database, !deferMissingV13Events);
    this.finishPendingV6SecretScrub(database);
    return;
  }
  if (this.hasPendingV6SecretScrub(database)) {
    throw new Error("Daemon state v7 cannot repair additive schema state while a credential scrub is pending.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    if (needsLegacyPresenceRepair || needsV2AdditiveRepair) this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    // Current-version repair never synthesizes or rewrites authority tables.
    // Corruption in work-attempt or worker fencing remains a hard failure.
    this.validateV3Shape(database);
    this.validateV6Shape(database, false);
    if (needsBoundedDeliveryRepair) this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    if (needsV7AdditiveRepair) this.applyV7Shape(database);
    this.validateV7Shape(database, !deferMissingV13Events);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

repairAndValidateV6Shape(database: DatabaseSync): void {
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v6 must not persist agent_session_token.");
  }
  const needsLegacyPresenceRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  const needsBoundedDeliveryRepair = !this.tableColumns(database, "agent_configurations").has("delivery_mode")
    || !this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id")
    || !this.tableColumns(database, "turn_control_journals").has("inbox_item_id")
    || !this.tableColumns(database, "turn_control_journals").has("correction_text")
    || !this.tableColumns(database, "turn_control_journals").has("correction_strategy")
    || !this.tableColumns(database, "turn_control_journals").has("operator_resolution");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    this.finishPendingV6SecretScrub(database);
    if (!needsLegacyPresenceRepair && !needsBoundedDeliveryRepair) return;
  } catch (error) {
    // A pending scrub is safety-critical. Do not convert a failed VACUUM or
    // checkpoint into an unrelated shape-repair attempt that could claim the
    // database healthy while raw credential pages remain.
    if (this.hasPendingV6SecretScrub(database)) throw error;
    // Do not validate or recreate the retired v5 credential shape on normal
    // v6 opens. v2/v3 repairs remain necessary for old partial-marker cases.
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV6Shape(database);
    this.validateV6Shape(database);
    this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

applyBoundedDeliveryV6Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "agent_configurations").has("delivery_mode")) {
    database.exec("ALTER TABLE agent_configurations ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'mcp_polling' CHECK (delivery_mode IN ('mcp_polling','daemon_inbox'))");
  }
  if (!this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")) {
    database.exec("ALTER TABLE agent_configurations ADD COLUMN delivery_cutover_json TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("provider_turn_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN provider_turn_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("inbox_item_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN inbox_item_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_text")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN correction_text TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_strategy")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN correction_strategy TEXT CHECK (correction_strategy IS NULL OR correction_strategy IN ('native','stop_then_resend'))");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("operator_resolution")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN operator_resolution TEXT CHECK (operator_resolution IS NULL OR operator_resolution IN ('applied','not_applied'))");
  }
},

validateBoundedDeliveryV6Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  if (!columns.has("delivery_mode")) throw new Error("Daemon state v6 delivery_mode is missing.");
  if (!columns.has("delivery_cutover_json")) throw new Error("Daemon state v6 delivery_cutover_json is missing.");
  const invalid = database.prepare("SELECT 1 FROM agent_configurations WHERE delivery_mode NOT IN ('mcp_polling','daemon_inbox') LIMIT 1").get();
  if (invalid) throw new Error("Daemon state v6 delivery_mode is invalid.");
  if (!this.tableColumns(database, "turn_control_journals").has("provider_turn_id")) {
    throw new Error("Daemon state v6 provider_turn_id is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("inbox_item_id")) {
    throw new Error("Daemon state v6 inbox_item_id is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_text")) {
    throw new Error("Daemon state v6 correction_text is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_strategy")) {
    throw new Error("Daemon state v6 correction_strategy is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("operator_resolution")) {
    throw new Error("Daemon state v6 operator_resolution is missing.");
  }
  const invalidCorrectionStrategy = database.prepare("SELECT 1 FROM turn_control_journals WHERE correction_strategy IS NOT NULL AND correction_strategy NOT IN ('native','stop_then_resend') LIMIT 1").get();
  if (invalidCorrectionStrategy) throw new Error("Daemon state v6 correction_strategy is invalid.");
  const invalidOperatorResolution = database.prepare("SELECT 1 FROM turn_control_journals WHERE operator_resolution IS NOT NULL AND operator_resolution NOT IN ('applied','not_applied') LIMIT 1").get();
  if (invalidOperatorResolution) throw new Error("Daemon state v6 operator_resolution is invalid.");
},

finishPendingV6SecretScrub(database: DatabaseSync): void {
  if (this.hasPendingV6SecretScrub(database)) this.finishV6SecretScrub(database);
},

hasPendingV6SecretScrub(database: DatabaseSync): boolean {
  const pending = database.prepare("SELECT checksum FROM migration_records WHERE migration_key='v6-worker-token-scrub'").get() as Row | undefined;
  return pending?.checksum === "pending";
},

markV6SecretScrubPending(database: DatabaseSync): void {
  run(database.prepare("INSERT OR REPLACE INTO migration_records(migration_key, checksum, imported_at) VALUES ('v6-worker-token-scrub', 'pending', ?)"), new Date().toISOString());
},

completeV6SecretScrub(database: DatabaseSync): void {
  this.postV6CommitBeforeScrubHook?.();
  this.finishV6SecretScrub(database);
},

finishV6SecretScrub(database: DatabaseSync): void {
  this.beforeV6ScrubHook?.();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("BEGIN IMMEDIATE");
  try {
    run(database.prepare("DELETE FROM migration_records WHERE migration_key='v6-worker-token-scrub' AND checksum='pending'"));
    database.exec("COMMIT");
  } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
},
});
