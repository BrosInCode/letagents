/**
 * Repair journal, OpenCode identity, action replay and native turn shapes (v13 to v16).
 *
 * Where new code goes: a new schema version's migration goes in
 * storage-migrations.ts (with its dispatch in schema.ts createSchema and the
 * DAEMON_STATE_SCHEMA_VERSION bump in shared.ts); a change
 * to the current shape goes in shapes-v17-current.ts. The other shapes-*.ts
 * files hold frozen historical versions and change only to fix a repair bug.
 * shapes-v4-v7.ts owns the plain apply/validate shapes for v4 to v7;
 * shapes-v6-v9.ts owns v8 and v9 plus the v6/v7 repair paths
 * (repairAndValidateV6Shape/V7Shape, bounded delivery, secret scrub) that
 * call into those v6/v7 shapes, so the two names overlap at v6 and v7.
 */
import type { DatabaseSync } from "node:sqlite";
import { INBOX_STATES_V17, INBOX_STATE_CONSTRAINT, type Row, terminalResultsSql, validateTerminalResults, schemaMethods } from "./shared.js";

export const shapesV13ToV16 = schemaMethods({
applyV13Shape(database: DatabaseSync): void {
  const inboxColumns = this.tableColumns(database, "supervised_agent_inbox");
  const hasFailureCode = inboxColumns.has("failure_code");
  const hasRepairJournal = this.tableColumns(database, "provider_continuation_repairs").size > 0;
  const inboxDefinition = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'",
  ).get() as Row | undefined;
  const retainedInboxStates = INBOX_STATE_CONSTRAINT.exec(String(inboxDefinition?.sql))?.[1]?.replace(/\s/g, "") === `${INBOX_STATES_V17},'acknowledged_failed'`
    ? `${INBOX_STATES_V17},'acknowledged_failed'` : INBOX_STATES_V17;
  const hasCanonicalFailureCodeConstraint = /CHECK\s*\(\s*failure_code\s+IS\s+NULL\s+OR\s+failure_code\s*=\s*'provider_continuation_missing'\s*\)/i
    .test(String(inboxDefinition?.sql));
  if (hasFailureCode && hasRepairJournal && hasCanonicalFailureCodeConstraint) {
    // The causal event table is additive evidence. A current-version reopen
    // may safely recreate an absent empty journal, but it must never rebuild
    // the authoritative inbox or repair journal in place.
    if (!this.tableColumns(database, "supervised_agent_inbox_events").size) {
      database.exec(`
        CREATE TABLE supervised_agent_inbox_events (
          inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
          event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
          idempotency_key TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled','conversation_restoring','conversation_restored','user_cancelled')),
          observed_at TEXT NOT NULL,
          detail TEXT,
          PRIMARY KEY(inbox_item_id,event_sequence),
          UNIQUE(inbox_item_id,idempotency_key)
        ) STRICT;
        CREATE INDEX supervised_agent_inbox_events_timeline
          ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
      `);
    }
    return;
  }
  if (hasFailureCode) {
    const invalidFailureCode = database.prepare(`
      SELECT failure_code
      FROM supervised_agent_inbox
      WHERE failure_code IS NOT NULL
        AND failure_code <> 'provider_continuation_missing'
      LIMIT 1
    `).get() as Row | undefined;
    if (invalidFailureCode) {
      throw new Error("Daemon state v13 inbox contains an unsupported continuation failure code.");
    }
  }
  const migratedFailureCode = hasFailureCode
    ? `CASE
        WHEN failure_code='provider_continuation_missing' THEN failure_code
        WHEN state='blocked' AND attempt_count=0 AND provider_turn_id IS NULL AND outcome IS NULL
          AND lower(last_error) GLOB 'thread not found: ????????-????-????-????-????????????'
          THEN 'provider_continuation_missing'
        ELSE NULL
      END`
    : `CASE WHEN state='blocked' AND attempt_count=0 AND provider_turn_id IS NULL AND outcome IS NULL
        AND lower(last_error) GLOB 'thread not found: ????????-????-????-????-????????????'
        THEN 'provider_continuation_missing' ELSE NULL END`;

  const terminalVersion = validateTerminalResults(database);
  // A rolled-back version marker or interrupted legacy repair can retain the
  // current repair journal while temporarily rebuilding the older delivery
  // tables. Preserve those rows outside the foreign-key graph while the
  // authoritative inbox is rebuilt, then restore them against the new parent.
  if (hasRepairJournal) {
    database.exec(`
      DROP TABLE IF EXISTS temp.provider_continuation_repairs_v13_backup;
      CREATE TEMP TABLE provider_continuation_repairs_v13_backup AS
        SELECT * FROM provider_continuation_repairs;
      DROP TABLE provider_continuation_repairs;
    `);
    this.afterV13RepairJournalBackupHook?.();
  }
  const restoreNativeTurnBindings = this.detachLaterInboxTables(database, ["supervised_agent_provider_turn_bindings", "supervised_agent_prepared_context"]);
  database.exec(`
    PRAGMA defer_foreign_keys = ON;
    ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_pre_v13;

    CREATE TABLE supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN (${retainedInboxStates})),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT, outcome TEXT, last_error TEXT,
      failure_code TEXT CHECK(failure_code IS NULL OR failure_code='provider_continuation_missing'),
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
      UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
      UNIQUE(inbox_item_id,agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,
        ${migratedFailureCode},
        blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_pre_v13;

    CREATE TABLE supervised_agent_inbox_events_v13 (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled','conversation_restoring','conversation_restored','user_cancelled')),
      observed_at TEXT NOT NULL, detail TEXT,
      PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
    ) STRICT;
    INSERT INTO supervised_agent_inbox_events_v13 SELECT * FROM supervised_agent_inbox_events;

    ${terminalResultsSql(terminalVersion, "supervised_agent_terminal_results_v13")};
    INSERT INTO supervised_agent_terminal_results_v13 SELECT * FROM supervised_agent_terminal_results;

    CREATE TABLE supervised_agent_publications_v13 (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
      UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_publications_v13 SELECT * FROM supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_events;
    DROP TABLE supervised_agent_terminal_results;
    DROP TABLE supervised_agent_publications;
    DROP TABLE supervised_agent_inbox_pre_v13;

    ALTER TABLE supervised_agent_inbox_events_v13 RENAME TO supervised_agent_inbox_events;
    ALTER TABLE supervised_agent_terminal_results_v13 RENAME TO supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_publications_v13 RENAME TO supervised_agent_publications;

    CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
    CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
    CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);

    CREATE TABLE provider_continuation_repairs (
      repair_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      inbox_item_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      execution_generation_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      expected_pid INTEGER NOT NULL CHECK(expected_pid > 0),
      expected_process_identity TEXT NOT NULL,
      missing_continuation TEXT NOT NULL,
      replacement_continuation TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('probing','replacement_created','committed','failed')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX one_active_provider_continuation_repair
      ON provider_continuation_repairs(agent_id) WHERE phase NOT IN ('committed','failed');
    CREATE INDEX provider_continuation_repairs_inbox
      ON provider_continuation_repairs(inbox_item_id,updated_at);
  `);
  if (hasRepairJournal) {
    database.exec(`
      INSERT INTO provider_continuation_repairs
        SELECT * FROM temp.provider_continuation_repairs_v13_backup;
      DROP TABLE temp.provider_continuation_repairs_v13_backup;
    `);
  }
  restoreNativeTurnBindings();
},

validateV13Shape(database: DatabaseSync): void {
  this.validateV12Shape(database);
  const inboxColumns = this.tableColumns(database, "supervised_agent_inbox");
  const hasV17TerminalReason = inboxColumns.has("terminal_reason");
  const repairColumns = this.tableColumns(database, "provider_continuation_repairs");
  const expectedInboxColumns = [
    "inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json",
    "activation_json", "fifo_sequence", "state", "attempt_count", "action_id",
    "reply_client_message_id", "provider_turn_id", "outcome", "last_error", "failure_code",
    "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at",
    ...(hasV17TerminalReason ? ["terminal_reason"] : []),
  ];
  const expectedRepairColumns = [
    "repair_id", "agent_id", "room_id", "inbox_item_id", "daemon_generation",
    "execution_generation_id", "work_attempt_id", "expected_pid",
    "expected_process_identity", "missing_continuation", "replacement_continuation",
    "phase", "attempt_count", "last_error", "created_at", "updated_at",
  ];
  if (inboxColumns.size !== expectedInboxColumns.length
    || expectedInboxColumns.some((column) => !inboxColumns.has(column))
    || repairColumns.size !== expectedRepairColumns.length
    || expectedRepairColumns.some((column) => !repairColumns.has(column))) {
    throw new Error("Daemon state v13 continuation-repair shape is incomplete.");
  }
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  const repairs = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_continuation_repairs'").get() as Row | undefined;
  const events = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox_events'").get() as Row | undefined;
  const inboxSql = String(inbox?.sql);
  const repairSql = String(repairs?.sql);
  const eventSql = String(events?.sql);
  if (!inbox || !repairs || !events
    || !/cancelled_by_user/i.test(inboxSql)
    || !/CHECK\s*\(\s*failure_code\s+IS\s+NULL\s+OR\s+failure_code\s*=\s*'provider_continuation_missing'\s*\)/i.test(inboxSql)
    || !/phase\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*phase\s+IN\s*\(\s*'probing'\s*,\s*'replacement_created'\s*,\s*'committed'\s*,\s*'failed'\s*\)\s*\)/i.test(repairSql)
    || !/FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)\s*REFERENCES\s+supervised_agent_inbox/i.test(repairSql)
    || !/conversation_restoring/i.test(eventSql) || !/conversation_restored/i.test(eventSql) || !/user_cancelled/i.test(eventSql)
    || !/STRICT\s*$/i.test(inboxSql) || !/STRICT\s*$/i.test(repairSql) || !/STRICT\s*$/i.test(eventSql)) {
    throw new Error("Daemon state v13 continuation-repair tables are invalid.");
  }
  const indexes: Record<string, { table: string; unique: number; partial: number; columns: string[] }> = {
    one_active_provider_continuation_repair: {
      table: "provider_continuation_repairs", unique: 1, partial: 1, columns: ["agent_id"],
    },
    provider_continuation_repairs_inbox: {
      table: "provider_continuation_repairs", unique: 0, partial: 0, columns: ["inbox_item_id", "updated_at"],
    },
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[])
      .find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    if (!listed || String(listed.origin) !== "c" || Number(listed.unique) !== expected.unique
      || Number(listed.partial) !== expected.partial || terms.length !== expected.columns.length
      || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index]
        || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) {
      throw new Error(`Daemon state v13 index ${name} is invalid.`);
    }
  }
  const activeIndex = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='one_active_provider_continuation_repair'",
  ).get() as Row | undefined;
  if (!activeIndex
    || !/WHERE\s+phase\s+NOT\s+IN\s*\(\s*'committed'\s*,\s*'failed'\s*\)/i.test(String(activeIndex.sql))) {
    throw new Error("Daemon state v13 active continuation-repair index is invalid.");
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("Daemon state v13 failed foreign-key validation.");
  }
},

repairAndValidateV13Shape(database: DatabaseSync): void {
  // Preserve every predecessor's additive repair guarantees on current
  // opens. The v7 validator recognizes the v13 inbox discriminator, so this
  // repairs only unchanged authority/configuration columns and never
  // downgrades the current delivery state machine.
  this.repairAndValidateV12Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV13Shape(database);
    this.validateV13Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  this.finishPendingV6SecretScrub(database);
},

applyV14Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "runtime_deployments").has("provider_server_auth_path")) {
    database.exec("ALTER TABLE runtime_deployments ADD COLUMN provider_server_auth_path TEXT");
  }
  database.exec(`
    UPDATE runtime_deployments
    SET provider_connection_kind = NULL,
        provider_connection_url = NULL,
        provider_server_auth_path = NULL,
        provider_connection_pid = NULL,
        provider_process_identity_present = 0,
        provider_process_identity = NULL
    WHERE provider_connection_kind = 'opencode_server'
      AND (provider_connection_url IS NULL OR provider_server_auth_path IS NULL);
  `);
},

validateV14Shape(database: DatabaseSync): void {
  this.validateV13Shape(database);
  if (!this.tableColumns(database, "runtime_deployments").has("provider_server_auth_path")) {
    throw new Error("Daemon state v14 is missing the OpenCode server authentication reference.");
  }
  if (database.prepare(`
    SELECT 1 FROM runtime_deployments
    WHERE provider_connection_kind = 'opencode_server'
      AND (provider_connection_url IS NULL OR provider_server_auth_path IS NULL)
    LIMIT 1
  `).get()) {
    throw new Error("Daemon state v14 contains incomplete OpenCode server connection evidence.");
  }
},

repairAndValidateV14Shape(database: DatabaseSync): void {
  this.repairAndValidateV13Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

applyV15Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_action_tombstones (
      agent_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, action_id)
    ) STRICT;
    INSERT OR IGNORE INTO reconciliation_action_tombstones(agent_id, action_id)
      SELECT agent_id, action_id FROM reconciliation_completed_actions;
  `);
},

validateV15Shape(database: DatabaseSync): void {
  this.validateV14Shape(database);
  const expected = ["agent_id", "action_id"];
  const actual = database.prepare("PRAGMA table_xinfo(reconciliation_action_tombstones)").all() as Row[];
  if (actual.length !== expected.length || expected.some((column, index) => actual[index]?.name !== column)
    || actual.some((column) => Number(column.hidden) !== 0 || String(column.type).toUpperCase() !== "TEXT" || Number(column.notnull) !== 1)
    || Number(actual[0]?.pk) !== 1 || Number(actual[1]?.pk) !== 2) {
    throw new Error("Daemon state v15 action-tombstone table has an invalid shape.");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(reconciliation_action_tombstones)").all() as Row[];
  if (foreignKeys.length !== 0) {
    throw new Error("Daemon state v15 lifetime action tombstones must survive targeted identity replacement.");
  }
  if (!this.hasUniqueIndex(database, "reconciliation_action_tombstones", ["agent_id", "action_id"], false)) {
    throw new Error("Daemon state v15 action-tombstone identity constraint is missing.");
  }
},

repairAndValidateV15Shape(database: DatabaseSync): void {
  this.repairAndValidateV14Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

applyV16Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "turn_control_journals").has("action_sequence")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN action_sequence INTEGER");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_room_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_room_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_source_message_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_source_message_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_provider_continuation_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_provider_continuation_id TEXT");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_provider_turn_bindings (
      inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      origin_execution_generation_id TEXT NOT NULL,
      provider_continuation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      UNIQUE(agent_id, provider_continuation_id, provider_turn_id),
      FOREIGN KEY(inbox_item_id, agent_id, room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id, agent_id, room_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turn_control_sequence_watermarks (
      agent_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
    ) STRICT;
    UPDATE turn_control_journals
      SET action_sequence=1
      WHERE turn_control_present=1 AND action_id IS NOT NULL AND action_sequence IS NULL;
    INSERT INTO turn_control_sequence_watermarks(agent_id,last_sequence)
      SELECT agent_id,MAX(action_sequence) FROM turn_control_journals
      WHERE action_sequence IS NOT NULL GROUP BY agent_id
      ON CONFLICT(agent_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence);
    DELETE FROM reconciliation_action_tombstones;
  `);
  database.exec(`
    UPDATE turn_control_journals AS j
    SET target_room_id=(SELECT i.room_id FROM supervised_agent_inbox i WHERE i.inbox_item_id=j.inbox_item_id),
        target_source_message_id=(SELECT i.source_message_id FROM supervised_agent_inbox i WHERE i.inbox_item_id=j.inbox_item_id),
        target_provider_continuation_id=(SELECT b.provider_continuation_id FROM supervised_agent_provider_turn_bindings b WHERE b.inbox_item_id=j.inbox_item_id)
    WHERE j.turn_control_present=1 AND j.inbox_item_id IS NOT NULL
      AND (j.target_room_id IS NULL OR j.target_source_message_id IS NULL OR j.target_provider_continuation_id IS NULL)
      AND EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=j.inbox_item_id
          AND b.work_attempt_id=j.turn_work_attempt_id
          AND b.origin_execution_generation_id=j.turn_execution_generation_id);
    UPDATE turn_control_journals
    SET status='uncertain',
        error='This turn-control action predates exact causal target fencing and cannot be replayed automatically.'
    WHERE turn_control_present=1 AND status IN ('prepared','dispatching','retryable')
      AND (target_room_id IS NULL OR target_source_message_id IS NULL
        OR target_provider_continuation_id IS NULL OR inbox_item_id IS NULL OR provider_turn_id IS NULL);
  `);
  // Missing legacy provider-turn authority is classified by v17 after its
  // explicit terminal-reason column exists. v16 must not misrepresent an
  // upgrade retirement as a user cancellation, even transiently inside the
  // all-the-way-to-current migration transaction.
  database.exec(`
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced a legacy effect whose exact provider-turn authority cannot be reconstructed; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name<>'join_room'
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.agent_id=e.agent_id AND b.room_id=e.room_id
          AND b.origin_execution_generation_id=e.execution_generation_id
          AND b.provider_turn_id=e.provider_turn_id);
    UPDATE agent_room_moves
    SET phase='failed',
        error='Upgrade fenced a supervised room move before any external membership mutation because its activating turn authority cannot be reconstructed.',
        updated_at=datetime('now')
    WHERE effect_id IS NOT NULL AND activating_inbox_item_id IS NOT NULL
      AND phase IN ('prepared','waiting_for_current_turn')
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=agent_room_moves.activating_inbox_item_id
          AND b.agent_id=agent_room_moves.agent_id
          AND b.work_attempt_id=agent_room_moves.work_attempt_id
          AND b.origin_execution_generation_id=agent_room_moves.execution_generation_id
          AND b.provider_turn_id=agent_room_moves.provider_turn_id);
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced the legacy supervised room move before external membership mutation; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m
        WHERE m.effect_id=e.effect_id AND m.phase='failed'
          AND m.error LIKE 'Upgrade fenced a supervised room move%');
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced an orphaned legacy room-move effect with no durable recovery journal; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND NOT EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id);
    UPDATE supervised_agent_effects AS e
    SET state='completed',
        result_json=(SELECT json_object(
          'phase','active','moved',json('true'),'old_room',m.source_room_id,
          'destination_room',COALESCE(m.remote_room_id,m.destination_room_id),
          'destination_cursor',m.destination_cursor)
          FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='active'),
        error=NULL,updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='active');
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error=COALESCE((SELECT m.error FROM agent_room_moves m
          WHERE m.effect_id=e.effect_id AND m.phase='failed'),
          'The legacy room move failed before its effect journal was settled.'),
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='failed');
  `);
  // Earlier v16 builds could commit two internally valid but mutually split
  // states. Repair only exact, non-effectful evidence before validating:
  //
  // 1. Cursor may have advanced runtime+binding from its wrapper's temporary
  //    continuation to the real session while an already-prepared control
  //    retained the temporary id. The exact inbox/turn/work/generation tuple
  //    proves this is the same turn, so the journal can advance with it.
  // 2. Retention could prune the terminal inbox row referenced by the single
  //    completed control journal. The native action is already terminal; clear
  //    its unverifiable causal tuple to an honest audit-only record rather than
  //    preventing daemon startup forever. Active controls remain fail-closed.
  database.exec(`
    UPDATE turn_control_journals AS j
    SET target_provider_continuation_id=(
          SELECT b.provider_continuation_id
          FROM supervised_agent_provider_turn_bindings b
          WHERE b.inbox_item_id=j.inbox_item_id
        ),
        updated_at=datetime('now')
    WHERE j.turn_control_present=1
      AND j.target_provider_continuation_id LIKE 'cursor-pending:%'
      AND EXISTS (
        SELECT 1
        FROM supervised_agent_inbox i
        JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
        JOIN agent_configurations c ON c.agent_id=j.agent_id
        JOIN runtime_deployments d ON d.agent_id=j.agent_id
        WHERE i.inbox_item_id=j.inbox_item_id
          AND i.agent_id=j.agent_id AND i.room_id=j.target_room_id
          AND i.source_message_id=j.target_source_message_id
          AND i.provider_turn_id=j.provider_turn_id
          AND b.agent_id=j.agent_id AND b.room_id=j.target_room_id
          AND b.work_attempt_id=j.turn_work_attempt_id
          AND b.origin_execution_generation_id=j.turn_execution_generation_id
          AND b.provider_turn_id=j.provider_turn_id
          AND b.provider_continuation_id NOT LIKE 'cursor-pending:%'
          AND c.provider='cursor' AND d.provider_ref_present=1
          AND d.provider_work_attempt_id=b.work_attempt_id
          AND d.provider_execution_generation_id=b.origin_execution_generation_id
          AND d.provider_continuation_id=b.provider_continuation_id
      );
    UPDATE turn_control_journals AS j
    SET target_room_id=NULL,target_source_message_id=NULL,
        target_provider_continuation_id=NULL,inbox_item_id=NULL,provider_turn_id=NULL,
        error=CASE WHEN error IS NULL OR length(trim(error))=0
          THEN 'Historical completed turn-control target is unavailable after predecessor retention; retained as audit-only.'
          ELSE error || ' Historical exact target is unavailable after predecessor retention; retained as audit-only.' END,
        updated_at=datetime('now')
    WHERE j.turn_control_present=1 AND j.status='completed'
      AND j.target_room_id IS NOT NULL
      AND j.inbox_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM supervised_agent_inbox i
        WHERE i.inbox_item_id=j.inbox_item_id
      )
      AND EXISTS (
        SELECT 1 FROM supervised_agent_pruned_sources p
        WHERE p.agent_id=j.agent_id
          AND p.room_id=j.target_room_id
          AND p.source_message_id=j.target_source_message_id
      );
  `);
},

validateV16Shape(database: DatabaseSync): void {
  this.validateV15Shape(database);
  if (!this.tableColumns(database, "turn_control_journals").has("action_sequence")) {
    throw new Error("Daemon state v16 turn-control journal is missing its durable action sequence.");
  }
  for (const column of ["target_room_id", "target_source_message_id", "target_provider_continuation_id"]) {
    if (!this.tableColumns(database, "turn_control_journals").has(column)) {
      throw new Error(`Daemon state v16 turn-control journal is missing ${column}.`);
    }
  }
  const expected = [
    "inbox_item_id", "agent_id", "room_id", "work_attempt_id",
    "origin_execution_generation_id", "provider_continuation_id", "provider_turn_id",
  ];
  const actual = database.prepare("PRAGMA table_xinfo(supervised_agent_provider_turn_bindings)").all() as Row[];
  if (actual.length !== expected.length || expected.some((column, index) => actual[index]?.name !== column)
    || actual.some((column) => Number(column.hidden) !== 0 || String(column.type).toUpperCase() !== "TEXT" || Number(column.notnull) !== 1)
    || Number(actual[0]?.pk) !== 1) {
    throw new Error("Daemon state v16 provider-turn authority binding table has an invalid shape.");
  }
  const invalid = database.prepare(`SELECT 1
    FROM supervised_agent_provider_turn_bindings b
    LEFT JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id
    WHERE i.inbox_item_id IS NULL OR i.agent_id<>b.agent_id OR i.room_id<>b.room_id
      OR i.provider_turn_id IS NULL OR i.provider_turn_id<>b.provider_turn_id
    LIMIT 1`).get();
  if (invalid) throw new Error("Daemon state v16 provider-turn authority binding is detached from its exact inbox turn.");
  if (!this.hasUniqueIndex(database, "supervised_agent_provider_turn_bindings", ["agent_id", "provider_continuation_id", "provider_turn_id"], false)) {
    throw new Error("Daemon state v16 provider-turn scoped identity constraint is missing.");
  }
  const watermarkColumns = database.prepare("PRAGMA table_xinfo(turn_control_sequence_watermarks)").all() as Row[];
  if (watermarkColumns.length !== 2
    || watermarkColumns[0]?.name !== "agent_id" || watermarkColumns[1]?.name !== "last_sequence"
    || String(watermarkColumns[0]?.type).toUpperCase() !== "TEXT"
    || String(watermarkColumns[1]?.type).toUpperCase() !== "INTEGER"
    || Number(watermarkColumns[0]?.pk) !== 1
    || watermarkColumns.some((column) => Number(column.notnull) !== 1 || Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v16 turn-control sequence watermark has an invalid shape.");
  }
  if (database.prepare("SELECT 1 FROM reconciliation_action_tombstones LIMIT 1").get()) {
    throw new Error("Daemon state v16 retained legacy lifetime action tombstones.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_sequence_watermarks
    WHERE last_sequence<0 OR last_sequence>9007199254740991 LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control sequence watermark is outside the safe integer range.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals j
    LEFT JOIN turn_control_sequence_watermarks w ON w.agent_id=j.agent_id
    WHERE j.turn_control_present=1 AND j.action_id IS NOT NULL
      AND (j.action_sequence IS NULL OR j.action_sequence<1 OR j.action_sequence>9007199254740991
        OR w.agent_id IS NULL OR w.last_sequence<>j.action_sequence)
    LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control journal does not exactly match its sequence watermark.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals j
    LEFT JOIN supervised_agent_inbox i ON i.inbox_item_id=j.inbox_item_id
    LEFT JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=j.inbox_item_id
    WHERE j.turn_control_present=1
      AND ((j.target_room_id IS NULL)+(j.target_source_message_id IS NULL)
        +(j.target_provider_continuation_id IS NULL)) NOT IN (0,3)
      OR j.turn_control_present=1 AND j.target_room_id IS NOT NULL
      AND (j.inbox_item_id IS NULL OR j.provider_turn_id IS NULL
        OR i.inbox_item_id IS NULL OR i.agent_id<>j.agent_id OR i.room_id<>j.target_room_id
        OR i.source_message_id<>j.target_source_message_id
        OR i.provider_turn_id<>j.provider_turn_id
        OR b.inbox_item_id IS NULL OR b.agent_id<>j.agent_id
        OR b.provider_continuation_id<>j.target_provider_continuation_id
        OR b.work_attempt_id<>j.turn_work_attempt_id
        OR b.origin_execution_generation_id<>j.turn_execution_generation_id)
    LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control causal target is detached from its exact inbox binding.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals
    WHERE turn_control_present=1 AND target_room_id IS NULL
      AND status NOT IN ('uncertain','completed') LIMIT 1`).get()) {
    throw new Error("Daemon state v16 active turn-control journal is missing its exact causal target.");
  }
},

repairAndValidateV16Shape(database: DatabaseSync): void {
  this.repairAndValidateV15Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},
});
