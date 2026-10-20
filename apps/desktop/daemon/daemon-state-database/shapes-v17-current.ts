/**
 * Inbox terminal-result and execution storage shapes (v17, v18) and current-shape validation.
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
import { validateManagedLaunchContractSchema } from "../managed-launch-contract.js";
import { validateHostToolRuleSchema } from "../host-tool-rules.js";
import { validatePreparedRoomContextSchema } from "../prepared-room-context.js";
import { validateRoomWorkspaceSchema, validateRoomWorkspaceReviewSchema } from "../room-workspace-store.js";
import type { DatabaseSync } from "node:sqlite";
import { applyExecutionStorageSchema, validateExecutionStorageSchema, type ExecutionStorageSchemaVersion } from "../execution-storage-schema.js";
import { validatePollingActivationSchema, validatePollingOfferSchema } from "../custodial-polling-activation.js";
import { validateRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { validateExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { validateLegacyLifecycleProjectionLedgerSchema, validateLifecycleProjectionLedgerSchema } from "../lifecycle-projection-ledger.js";
import { validateRuntimeRecoverySchema } from "../runtime-recovery-journal.js";
import { SCHEMA_VERSION, validateWorkerExecutionBindings, validateDaemonReadIndexes, applyDaemonReadIndexes, validateAgentImageInputColumn, validateAgentLiveSharingColumn, INBOX_STATES_V17, INBOX_STATE_CONSTRAINT, type Row, quoteIdentifier, validatePollingContract, validateCustodialLaunchSession, validateTerminalResults, schemaMethods } from "./shared.js";
import { assertDaemonStateVersionSupported } from "./version-gate.js";

export const shapesV17ToCurrent = schemaMethods({
applyV17Shape(database: DatabaseSync, migrateInterruptedEffects: boolean): void {
  if (!this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason")) {
    database.exec(`ALTER TABLE supervised_agent_inbox ADD COLUMN terminal_reason TEXT
      CHECK(terminal_reason IS NULL OR terminal_reason='upgrade_authority_unavailable')`);
  }

  const effectColumns = this.tableColumns(database, "supervised_agent_effects");
  if (!effectColumns.has("mutation")) {
    // SQLite cannot extend the existing state CHECK in place. Rebuild exactly
    // once while preserving the stable effect id and request-id uniqueness.
    database.exec(`
      ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_pre_v17;
      CREATE TABLE supervised_agent_effects (
        effect_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        mcp_request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('prepared','executing','uncertain','completed','failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
      ) STRICT;
      INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      SELECT effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
        tool_name,request_json,
        CASE WHEN tool_name IN (
          'get_current_room','check_repo','check_repo_visibility',
          'read_messages','wait_for_messages','get_board','get_board_settings',
          'get_room_artifacts','get_room_events','list_board_intents',
          'get_onboarding_status','status_local_codex_session','rental_list_requests'
        ) THEN 0 ELSE 1 END,
        state,result_json,error,created_at,updated_at
      FROM supervised_agent_effects_pre_v17;
      DROP TABLE supervised_agent_effects_pre_v17;
      CREATE INDEX supervised_agent_effects_turn
        ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
    `);
  }

  // Inspector diagnostics retain only a bounded set of full uncertain rows.
  // This compact journal preserves the exact dedupe identity and delayed
  // completion authority until retention removes the owning provider-turn
  // binding. It intentionally stores only a request fingerprint and byte
  // count, never the potentially large original request payload.
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_effect_tombstones (
      effect_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      mcp_request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      request_bytes INTEGER NOT NULL CHECK(request_bytes>=0),
      mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('uncertain','completed','failed')),
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_effect_tombstones_turn
      ON supervised_agent_effect_tombstones(agent_id,execution_generation_id,provider_turn_id);
  `);

  // Correct rows written by the predecessor v16 migration, then classify any
  // v15 in-flight turn that reached this all-the-way-to-current transaction.
  // acknowledged_no_reply is only transport shape here; terminal_reason is the
  // authoritative explanation and the outcome remains null/unknown.
  database.exec(`
    UPDATE supervised_agent_inbox_events
    SET idempotency_key='v17_missing_authority_retired',phase='no_reply',
        detail='Upgrade retired an unrecoverable legacy provider turn because its exact authority is unavailable; provider work was not replayed.'
    WHERE idempotency_key='v16_missing_authority_cancelled';
    INSERT INTO supervised_agent_inbox_events
      (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
    SELECT i.inbox_item_id,
      COALESCE((SELECT MAX(e.event_sequence) FROM supervised_agent_inbox_events e
        WHERE e.inbox_item_id=i.inbox_item_id),0)+1,
      'v17_missing_authority_retired','no_reply',datetime('now'),
      'Upgrade retired an unrecoverable legacy provider turn because its exact authority is unavailable; provider work was not replayed.'
    FROM supervised_agent_inbox i
    WHERE i.provider_turn_id IS NOT NULL
      AND i.state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
      AND CASE WHEN i.outcome IS NOT NULL AND json_valid(i.outcome)
        AND COALESCE(json_extract(i.outcome,'$.kind')='no_reply'
          OR (json_extract(i.outcome,'$.kind')='reply'
            AND json_type(i.outcome,'$.text')='text'
            AND length(trim(json_extract(i.outcome,'$.text')))>0),0)=1
        THEN 0 ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=i.inbox_item_id)
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
        WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='v17_missing_authority_retired');
    UPDATE supervised_agent_inbox AS i
    SET state='acknowledged_no_reply', failure_code=NULL,
        terminal_reason='upgrade_authority_unavailable',
        last_error='Upgrade retired this legacy provider turn because its exact durable authority is unavailable; the outcome is unknown and provider work was not replayed.',
        blocked_by_inbox_item_id=NULL, next_attempt_at_ms=NULL,
        updated_at=datetime('now'), acknowledged_at=COALESCE(acknowledged_at,datetime('now'))
    WHERE EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
      WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='v17_missing_authority_retired');
  `);

  if (migrateInterruptedEffects) {
    database.exec(`
      UPDATE supervised_agent_effects
      SET state='prepared',
          error='A read-only supervised effect was interrupted before its result checkpoint and may be executed again safely.',
          updated_at=datetime('now')
      WHERE state='executing' AND mutation=0 AND tool_name<>'join_room';
      UPDATE supervised_agent_effects
      SET state='uncertain',
          error='A mutating supervised effect crossed its execution boundary without a durable result; it may have completed and must not be repeated without verification.',
          updated_at=datetime('now')
      WHERE state='executing' AND mutation=1 AND tool_name<>'join_room';
    `);
  }
},

validateV17Shape(database: DatabaseSync): void {
  this.validateV16Shape(database);
  const expectedEffects = [
    "effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id",
    "mcp_request_id", "tool_name", "request_json", "mutation", "state", "result_json",
    "error", "created_at", "updated_at",
  ];
  const effects = database.prepare("PRAGMA table_xinfo(supervised_agent_effects)").all() as Row[];
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_effects'").get() as Row | undefined;
  const effectsTable = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_agent_effects" && row.type === "table");
  if (effects.length !== expectedEffects.length
    || expectedEffects.some((column, index) => effects[index]?.name !== column)
    || effects.some((column) => Number(column.hidden) !== 0)
    || !/mutation\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*mutation\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(String(definition?.sql))
    || !/state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\([^)]*'uncertain'/i.test(String(definition?.sql))) {
    throw new Error("Daemon state v17 supervised-effect journal has an invalid durable classification shape.");
  }
  if (!effectsTable || Number(effectsTable.strict) !== 1 || Number(effectsTable.wr) !== 0
    || String(effects[0]?.type).toUpperCase() !== "TEXT"
    || Number(effects[0]?.notnull) !== 1 || Number(effects[0]?.pk) !== 1
    || effects.slice(1).some((column) => Number(column.pk) !== 0)) {
    throw new Error("Daemon state v17 supervised-effect journal effect_id must be its exact TEXT primary key.");
  }
  const exactIndexTerms = (indexName: string, expected: string[]): boolean => {
    const escaped = indexName.replace(/"/g, '""');
    const terms = (database.prepare(`PRAGMA index_xinfo("${escaped}")`).all() as Row[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    return terms.length === expected.length && terms.every((term, position) =>
      Number(term.cid) >= 0 && String(term.name) === expected[position]
      && Number(term.desc) === 0 && String(term.coll).toUpperCase() === "BINARY");
  };
  const effectIndexes = database.prepare("PRAGMA index_list(supervised_agent_effects)").all() as Row[];
  const effectIdentity = ["agent_id", "execution_generation_id", "provider_turn_id", "mcp_request_id"];
  const hasExactIdentityConstraint = effectIndexes.some((index) => Number(index.unique) === 1
    && Number(index.partial) === 0 && String(index.origin) === "u"
    && exactIndexTerms(String(index.name), effectIdentity));
  if (!hasExactIdentityConstraint) {
    throw new Error("Daemon state v17 supervised-effect journal is missing its exact request identity constraint.");
  }
  const turnIndex = effectIndexes.find((index) => index.name === "supervised_agent_effects_turn");
  if (!turnIndex || Number(turnIndex.unique) !== 0 || Number(turnIndex.partial) !== 0
    || String(turnIndex.origin) !== "c"
    || !exactIndexTerms("supervised_agent_effects_turn", ["agent_id", "execution_generation_id", "provider_turn_id"])) {
    throw new Error("Daemon state v17 supervised-effect turn index is missing or malformed.");
  }
  const expectedTombstones = [
    "effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id",
    "mcp_request_id", "tool_name", "request_sha256", "request_bytes", "mutation", "state",
    "result_json", "error", "created_at", "updated_at",
  ];
  const tombstones = database.prepare("PRAGMA table_xinfo(supervised_agent_effect_tombstones)").all() as Row[];
  const tombstoneDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_effect_tombstones'").get() as Row | undefined;
  const tombstoneTable = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_agent_effect_tombstones" && row.type === "table");
  if (tombstones.length !== expectedTombstones.length
    || expectedTombstones.some((column, index) => tombstones[index]?.name !== column)
    || tombstones.some((column) => Number(column.hidden) !== 0)
    || !/request_sha256\s+TEXT\s+NOT\s+NULL\s+CHECK/i.test(String(tombstoneDefinition?.sql))
    || !/mutation\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*mutation\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(String(tombstoneDefinition?.sql))) {
    throw new Error("Daemon state v17 supervised-effect tombstone journal has an invalid compact shape.");
  }
  if (!tombstoneTable || Number(tombstoneTable.strict) !== 1 || Number(tombstoneTable.wr) !== 0
    || String(tombstones[0]?.type).toUpperCase() !== "TEXT"
    || Number(tombstones[0]?.notnull) !== 1 || Number(tombstones[0]?.pk) !== 1
    || tombstones.slice(1).some((column) => Number(column.pk) !== 0)) {
    throw new Error("Daemon state v17 supervised-effect tombstone effect_id must be its exact TEXT primary key.");
  }
  const tombstoneIndexes = database.prepare("PRAGMA index_list(supervised_agent_effect_tombstones)").all() as Row[];
  if (!tombstoneIndexes.some((index) => Number(index.unique) === 1 && Number(index.partial) === 0
      && String(index.origin) === "u" && exactIndexTerms(String(index.name), effectIdentity))) {
    throw new Error("Daemon state v17 supervised-effect tombstone identity constraint is missing.");
  }
  const tombstoneTurnIndex = tombstoneIndexes.find((index) => index.name === "supervised_agent_effect_tombstones_turn");
  if (!tombstoneTurnIndex || Number(tombstoneTurnIndex.unique) !== 0 || Number(tombstoneTurnIndex.partial) !== 0
    || String(tombstoneTurnIndex.origin) !== "c"
    || !exactIndexTerms("supervised_agent_effect_tombstones_turn", ["agent_id", "execution_generation_id", "provider_turn_id"])) {
    throw new Error("Daemon state v17 supervised-effect tombstone turn index is missing or malformed.");
  }
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  if (!this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason")
    || !/terminal_reason\s+TEXT\s+CHECK\s*\(\s*terminal_reason\s+IS\s+NULL\s+OR\s+terminal_reason\s*=\s*'upgrade_authority_unavailable'\s*\)/i.test(String(inbox?.sql))) {
    throw new Error("Daemon state v17 inbox is missing its honest upgrade terminal classification.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_effects
    WHERE mutation NOT IN (0,1) OR state NOT IN ('prepared','executing','uncertain','completed','failed') LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains an invalid supervised-effect classification.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_effect_tombstones
    WHERE mutation NOT IN (0,1) OR state NOT IN ('uncertain','completed','failed')
      OR length(request_sha256)<>64 OR request_sha256 GLOB '*[^0-9a-f]*' OR request_bytes<0 LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains an invalid supervised-effect tombstone.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_inbox
    WHERE terminal_reason IS NOT NULL
      AND (terminal_reason<>'upgrade_authority_unavailable' OR state<>'acknowledged_no_reply') LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains a mismatched upgrade terminal classification.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE idempotency_key='v16_missing_authority_cancelled' LIMIT 1").get()) {
    throw new Error("Daemon state v17 retained a legacy upgrade event represented as user cancellation.");
  }
},

repairAndValidateV17Shape(database: DatabaseSync): void {
  this.repairAndValidateV16Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV17Shape(database, false);
    this.validateV17Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

applyV18Shape(database: DatabaseSync, executionStorageVersion: ExecutionStorageSchemaVersion = 25): void {
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'")
    .get() as Row | undefined;
  const sql = String(definition?.sql ?? "");
  const states = INBOX_STATE_CONSTRAINT.exec(sql)?.[1]?.replace(/\s/g, "");
  if (states !== `${INBOX_STATES_V17},'acknowledged_failed'`) {
    if (states !== INBOX_STATES_V17) throw new Error("Daemon state v18 cannot upgrade an unknown inbox state constraint.");
    // Every direct dependent must be saved before dropping the parent: SQLite
    // rewrites foreign keys on RENAME, and DROP can cascade native-turn and
    // publication authority away even with deferred constraint checking.
    const children = [
      "supervised_agent_inbox_events", "supervised_agent_terminal_results",
      "supervised_agent_publications", "provider_continuation_repairs",
      "supervised_agent_provider_turn_bindings",
    ];
    // Current-schema repair can rebuild an older physical inbox while
    // keeping newer, already-retained context alongside its receipt.
    if (this.tableColumns(database, "supervised_agent_prepared_context").size) children.push("supervised_agent_prepared_context");
    const tables = ["supervised_agent_inbox", ...children];
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]) {
      const table = String(row.name);
      const referencesInbox = (database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Row[])
        .some((key) => key.table === "supervised_agent_inbox");
      if (referencesInbox && !tables.includes(table)) {
        throw new Error("Daemon state v18 found an unrecognized inbox dependency and cannot safely rebuild it.");
      }
    }
    const definitions = tables.map((table) => {
      const tableDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
      if (!tableDefinition?.sql) throw new Error("Daemon state v18 is missing an authoritative inbox dependency.");
      const objects = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
        .all(table) as Row[];
      return { table, sql: String(tableDefinition.sql), objects: objects.map((object) => String(object.sql)) };
    });
    database.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of tables) {
      database.exec(`CREATE TEMP TABLE ${quoteIdentifier(`v18_snapshot_${table}`)} AS SELECT * FROM ${quoteIdentifier(table)}`);
    }
    for (const table of children) database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    database.exec("DROP TABLE supervised_agent_inbox");
    for (const saved of definitions) {
      database.exec(saved.table === "supervised_agent_inbox"
        ? saved.sql.replace(INBOX_STATE_CONSTRAINT, `state TEXT NOT NULL CHECK(state IN (${INBOX_STATES_V17},'acknowledged_failed'))`)
        : saved.sql);
    }
    for (const saved of definitions) {
      database.exec(`INSERT INTO ${quoteIdentifier(saved.table)} SELECT * FROM temp.${quoteIdentifier(`v18_snapshot_${saved.table}`)}`);
      database.exec(`DROP TABLE temp.${quoteIdentifier(`v18_snapshot_${saved.table}`)}`);
      for (const object of saved.objects) database.exec(object);
    }
  }
  applyExecutionStorageSchema(database, executionStorageVersion);
},

validateV18Shape(database: DatabaseSync, executionStorageVersion: ExecutionStorageSchemaVersion = 25): void {
  this.validateV17Shape(database);
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  if (INBOX_STATE_CONSTRAINT.exec(String(definition?.sql))?.[1]?.replace(/\s/g, "") !== `${INBOX_STATES_V17},'acknowledged_failed'`) {
    throw new Error("Daemon state v18 inbox is missing its reserved failed-delivery terminal state.");
  }
  validateExecutionStorageSchema(database, executionStorageVersion);
  const expectedKeys: Record<string, string[]> = {
    supervised_agent_inbox: ["blocked_by_inbox_item_id:inbox_item_id:NO ACTION"],
    supervised_agent_inbox_events: ["inbox_item_id:inbox_item_id:CASCADE"],
    supervised_agent_terminal_results: ["inbox_item_id:inbox_item_id:CASCADE"],
    supervised_agent_publications: ["inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
    provider_continuation_repairs: ["inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
    supervised_agent_provider_turn_bindings: ["inbox_item_id:inbox_item_id:CASCADE", "inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
  };
  for (const [table, expected] of Object.entries(expectedKeys)) {
    const groups = new Map<number, Row[]>();
    for (const key of database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Row[]) {
      if (key.table !== "supervised_agent_inbox" || key.on_update !== "NO ACTION") {
        throw new Error(`Daemon state v18 table ${table} has an invalid inbox authority foreign key.`);
      }
      const group = groups.get(Number(key.id)) ?? [];
      group.push(key); groups.set(Number(key.id), group);
    }
    const actual = [...groups.values()].map((group) => group.sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((key) => `${key.from}:${key.to}:${key.on_delete}`).join("|")).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(`Daemon state v18 table ${table} has an invalid inbox authority foreign key.`);
    }
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Daemon state v18 failed foreign-key validation.");
},

repairAndValidateCurrentShape(database: DatabaseSync, executionStorageVersion?: 19 | 20 | 21 | 22 | 23 | 24 | 25): void {
  const version = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
  if (version >= 46) validateManagedLaunchContractSchema(database);
  if (version >= 47) validateWorkerExecutionBindings(database);
  const storageVersion = executionStorageVersion ?? (version >= 35 ? 25 : version >= 34 ? 24 : version >= 31 ? 23 : version >= 30 ? 22 : 21);
  if (version >= 36) validateExecutionApprovalPublicationSchema(database);
  if (version >= 28) {
    if (version < 32) validateLegacyLifecycleProjectionLedgerSchema(database);
    else validateLifecycleProjectionLedgerSchema(database);
  }
  if (version >= 41) validateRuntimeRecoverySchema(database);
  if (version >= 43) validatePreparedRoomContextSchema(database);
  if (version >= 44) validateHostToolRuleSchema(database);
  if (version >= 39) validateRoomWorkspaceReviewSchema(database);
  if (version >= 38) validateRoomWorkspaceSchema(database);
  if (version >= 27) validateRoomWorkPublicationSchema(database, version < 37);
  if (version >= 25) validatePollingOfferSchema(database, version >= 26 ? 26 : 25);
  if (Number((database.prepare("PRAGMA user_version").get() as Row).user_version) >= 24) {
    validatePollingActivationSchema(database, version >= 26 ? 26 : 24); validateCustodialLaunchSession(database);
  }
  if (Number((database.prepare("PRAGMA user_version").get() as Row).user_version) >= 23) validatePollingContract(database);
  if (!this.tableColumns(database, "supervised_agent_inbox_events").size
    && database.prepare("SELECT 1 FROM supervised_agent_inbox LIMIT 1").get()) {
    throw new Error("Daemon state is missing inbox retry history and cannot safely reconstruct consumed retry budgets.");
  }
  // Missing typed journals are lost authority, not permission to recreate an
  // empty history. Check them before any predecessor's additive repair path.
  validateExecutionStorageSchema(database, storageVersion);
  validateTerminalResults(database, 20);
  this.repairAndValidateV17Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV18Shape(database, storageVersion);
    this.validateV18Shape(database, storageVersion);
    validateTerminalResults(database, 20);
    if (version >= 48) applyDaemonReadIndexes(database);
    if (version >= 50) validateAgentImageInputColumn(database);
    if (version >= 51) validateAgentLiveSharingColumn(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

/** Read-only validation for observers; never enter a predecessor repair path. */
validateCurrentShape(database: DatabaseSync): void {
  if (assertDaemonStateVersionSupported(database) !== SCHEMA_VERSION) {
    throw new Error("Daemon observation storage requires the already-current schema.");
  }
  this.validateLocalRoomMembershipShape(database);
  validateDaemonReadIndexes(database);
  validateAgentImageInputColumn(database);
  validateAgentLiveSharingColumn(database);
  validatePreparedRoomContextSchema(database);
  if (this.hasPendingV6SecretScrub(database)) {
    throw new Error("Daemon observation storage requires completed credential cleanup.");
  }
  this.validateV2Shape(database);
  this.validateV3Shape(database);
  this.validateV6Shape(database, false);
  this.validateBoundedDeliveryV6Shape(database);
  this.validateV7Shape(database);
  this.validateV9Shape(database);
  this.validateV18Shape(database);
},
});
