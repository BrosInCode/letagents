/**
 * Purge-operation and worker-mint shapes (v11, v12) and the current schema tail.
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
import { type Row, run, schemaMethods } from "./shared.js";

export const shapesV11V12 = schemaMethods({
createPurgeOperationsV11(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_purge_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      phase TEXT NOT NULL CHECK(phase IN ('prepared','reprepare_credentials','revoking_credentials','local_commit','complete','failed')),
      external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attached_work_attempt_id TEXT,
      preserved_workspace_path TEXT,
      worker_session_attestation TEXT NOT NULL CHECK(worker_session_attestation IN ('exact','none','unknown','not_required')),
      agent_session_id TEXT,
      CHECK(
        (external_revoke_required=0 AND worker_session_attestation='not_required' AND agent_session_id IS NULL)
        OR
        (external_revoke_required=1 AND (
          (worker_session_attestation='exact' AND agent_session_id IS NOT NULL)
          OR
          (worker_session_attestation IN ('none','unknown') AND agent_session_id IS NULL)
        ))
      )
    ) STRICT;
  `);
},

durablePurgeMigrationSession(database: DatabaseSync, agentId: string): string | null {
  const retained = database.prepare(`SELECT binding_agent_session_id FROM retained_worker_bindings
    WHERE agent_id=? AND last_worker_binding_present=1 AND binding_agent_session_id IS NOT NULL`).get(agentId) as Row | undefined;
  if (typeof retained?.binding_agent_session_id === "string" && retained.binding_agent_session_id.trim()) {
    return retained.binding_agent_session_id.trim();
  }
  const supervised = database.prepare("SELECT agent_session_id FROM supervised_worker_sessions WHERE agent_id=?").get(agentId) as Row | undefined;
  if (typeof supervised?.agent_session_id === "string" && supervised.agent_session_id.trim()) {
    return supervised.agent_session_id.trim();
  }
  const ids = new Set<string>();
  for (const [table, column] of [
    ["worker_session_bindings", "entry_id"],
    ["worker_binding_publications", "entry_id"],
    ["worker_generation_verifications", "entry_id"],
  ] as const) {
    for (const row of database.prepare(`SELECT DISTINCT agent_session_id FROM ${table} WHERE ${column}=?`).all(agentId) as Row[]) {
      if (typeof row.agent_session_id === "string" && row.agent_session_id.trim()) ids.add(row.agent_session_id.trim());
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
},

/**
 * Rebuild instead of ALTER: v10's phase CHECK cannot represent a recoverable
 * ambiguous purge. Active external rows are deliberately put back before the
 * revoke boundary, even when the legacy row claimed local_commit.
 */
rebuildPurgeOperationsV11(database: DatabaseSync): void {
  const rows = database.prepare("SELECT * FROM agent_purge_operations ORDER BY created_at,operation_id").all() as Row[];
  database.exec(`
    DROP INDEX IF EXISTS agent_purge_operations_agent_updated;
    DROP INDEX IF EXISTS one_active_agent_purge;
    ALTER TABLE agent_purge_operations RENAME TO agent_purge_operations_pre_v11;
  `);
  this.createPurgeOperationsV11(database);
  const insert = database.prepare(`INSERT INTO agent_purge_operations
    (operation_id,request_id,agent_id,daemon_generation,phase,external_revoke_required,error,created_at,updated_at,
      attached_work_attempt_id,preserved_workspace_path,worker_session_attestation,agent_session_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const agentId = String(row.agent_id);
    const external = Number(row.external_revoke_required) === 1;
    const terminal = row.phase === "complete" || row.phase === "failed";
    const storedAttestation = typeof row.worker_session_attestation === "string"
      ? row.worker_session_attestation
      : null;
    const storedSession = typeof row.agent_session_id === "string" && row.agent_session_id.trim()
      ? row.agent_session_id.trim()
      : null;
    const recoveredSession = storedSession ?? this.durablePurgeMigrationSession(database, agentId);
    let phase = String(row.phase);
    let attestation: "exact" | "none" | "unknown" | "not_required";
    let sessionId: string | null;
    if (!external) {
      attestation = "not_required";
      sessionId = null;
      if (!terminal) phase = "local_commit";
    } else if (terminal) {
      attestation = storedAttestation === "none"
        ? "none"
        : recoveredSession ? "exact" : "unknown";
      sessionId = attestation === "exact" ? recoveredSession : null;
    } else if (storedAttestation === "none") {
      attestation = "none";
      sessionId = null;
      phase = "revoking_credentials";
    } else if (recoveredSession) {
      attestation = "exact";
      sessionId = recoveredSession;
      phase = "revoking_credentials";
    } else {
      attestation = "unknown";
      sessionId = null;
      phase = "reprepare_credentials";
    }
    run(insert,
      row.operation_id, row.request_id, agentId, row.daemon_generation, phase, external ? 1 : 0,
      row.error ?? null, row.created_at, row.updated_at, row.attached_work_attempt_id ?? null,
      row.preserved_workspace_path ?? null, attestation, sessionId);
  }
  database.exec("DROP TABLE agent_purge_operations_pre_v11");
},

applyV11Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  if (!columns.has("reasoning_effort")) database.exec("ALTER TABLE agent_configurations ADD COLUMN reasoning_effort TEXT");
  if (!columns.has("config_revision")) database.exec("ALTER TABLE agent_configurations ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision >= 1)");
  if (!columns.has("runtime_configuration_revision")) database.exec("ALTER TABLE agent_configurations ADD COLUMN runtime_configuration_revision INTEGER NOT NULL DEFAULT 1 CHECK(runtime_configuration_revision >= 1)");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_room_moves (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      destination_room_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      work_attempt_id TEXT,
      execution_generation_id TEXT,
      agent_session_id TEXT,
      activating_inbox_item_id TEXT,
      provider_turn_id TEXT,
      effect_id TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','waiting_for_current_turn','joining_destination','membership_committed','rotating_credentials','bootstrapping_destination_tail','active','failed','rollback_required')),
      remote_room_id TEXT,
      destination_cursor TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1)),
      source_cursor TEXT,
      source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1)),
      CHECK(source_room_id <> destination_room_id),
      CHECK((work_attempt_id IS NULL) = (execution_generation_id IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_room_moves_agent_updated ON agent_room_moves(agent_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_room_move ON agent_room_moves(agent_id)
      WHERE phase NOT IN ('active','failed');
  `);
  this.createPurgeOperationsV11(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS agent_purge_operations_agent_updated ON agent_purge_operations(agent_id,updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_purge ON agent_purge_operations(agent_id)
      WHERE phase NOT IN ('complete','failed');
  `);
},

validateV11Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  for (const column of ["reasoning_effort", "config_revision", "runtime_configuration_revision"]) {
    if (!columns.has(column)) throw new Error(`Daemon state v11 is missing agent configuration column ${column}.`);
  }
  const moves = this.tableColumns(database, "agent_room_moves");
  for (const column of ["operation_id", "request_id", "agent_id", "source_room_id", "destination_room_id", "daemon_generation", "work_attempt_id", "execution_generation_id", "agent_session_id", "activating_inbox_item_id", "provider_turn_id", "effect_id", "phase", "remote_room_id", "destination_cursor", "source_credentials_revoked", "created_at", "updated_at", "source_cursor_present", "source_cursor"]) {
    if (!moves.has(column)) throw new Error(`Daemon state v11 is missing room-move column ${column}.`);
  }
  const purges = this.tableColumns(database, "agent_purge_operations");
  for (const column of ["operation_id", "request_id", "agent_id", "daemon_generation", "phase", "external_revoke_required", "created_at", "updated_at", "attached_work_attempt_id", "preserved_workspace_path", "worker_session_attestation", "agent_session_id"]) {
    if (!purges.has(column)) throw new Error(`Daemon state v11 is missing purge-operation column ${column}.`);
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const canonicalTables: Record<string, string> = {
    agent_room_moves: `CREATE TABLE agent_room_moves (operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL,source_room_id TEXT NOT NULL,destination_room_id TEXT NOT NULL,daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),work_attempt_id TEXT,execution_generation_id TEXT,agent_session_id TEXT,activating_inbox_item_id TEXT,provider_turn_id TEXT,effect_id TEXT,phase TEXT NOT NULL CHECK(phase IN ('prepared','waiting_for_current_turn','joining_destination','membership_committed','rotating_credentials','bootstrapping_destination_tail','active','failed','rollback_required')),remote_room_id TEXT,destination_cursor TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1)),source_cursor TEXT,source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1)),CHECK(source_room_id <> destination_room_id),CHECK((work_attempt_id IS NULL) = (execution_generation_id IS NULL))) STRICT`,
    agent_purge_operations: `CREATE TABLE agent_purge_operations (operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL,daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),phase TEXT NOT NULL CHECK(phase IN ('prepared','reprepare_credentials','revoking_credentials','local_commit','complete','failed')),external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,attached_work_attempt_id TEXT,preserved_workspace_path TEXT,worker_session_attestation TEXT NOT NULL CHECK(worker_session_attestation IN ('exact','none','unknown','not_required')),agent_session_id TEXT,CHECK((external_revoke_required=0 AND worker_session_attestation='not_required' AND agent_session_id IS NULL) OR (external_revoke_required=1 AND ((worker_session_attestation='exact' AND agent_session_id IS NOT NULL) OR (worker_session_attestation IN ('none','unknown') AND agent_session_id IS NULL))))) STRICT`,
  };
  const strictTables = database.prepare("PRAGMA table_list").all() as Row[];
  for (const table of ["agent_room_moves", "agent_purge_operations"]) {
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonicalTables[table]!)) throw new Error(`Daemon state v11 table ${table} does not match its canonical definition.`);
    const info = strictTables.find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || Number(info.wr) !== 0) throw new Error(`Daemon state v11 table ${table} must be a strict rowid table.`);
    const fk = database.prepare(`PRAGMA foreign_key_check(${table})`).get();
    if (fk) throw new Error(`Daemon state v11 table ${table} contains a broken foreign key.`);
  }
  const indexes: Record<string, { table: string; unique: number; partial: number; columns: string[] }> = {
    agent_room_moves_agent_updated: { table: "agent_room_moves", unique: 0, partial: 0, columns: ["agent_id", "updated_at"] },
    one_active_agent_room_move: { table: "agent_room_moves", unique: 1, partial: 1, columns: ["agent_id"] },
    agent_purge_operations_agent_updated: { table: "agent_purge_operations", unique: 0, partial: 0, columns: ["agent_id", "updated_at"] },
    one_active_agent_purge: { table: "agent_purge_operations", unique: 1, partial: 1, columns: ["agent_id"] },
  };
  const canonicalIndexes: Record<string, string> = {
    agent_room_moves_agent_updated: "CREATE INDEX agent_room_moves_agent_updated ON agent_room_moves(agent_id,updated_at)",
    one_active_agent_room_move: "CREATE UNIQUE INDEX one_active_agent_room_move ON agent_room_moves(agent_id) WHERE phase NOT IN ('active','failed')",
    agent_purge_operations_agent_updated: "CREATE INDEX agent_purge_operations_agent_updated ON agent_purge_operations(agent_id,updated_at)",
    one_active_agent_purge: "CREATE UNIQUE INDEX one_active_agent_purge ON agent_purge_operations(agent_id) WHERE phase NOT IN ('complete','failed')",
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as Row | undefined;
    if (!listed || String(listed.origin) !== "c" || Number(listed.unique) !== expected.unique || Number(listed.partial) !== expected.partial || !definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonicalIndexes[name]!) || terms.length !== expected.columns.length || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index] || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v11 index ${name} is invalid.`);
  }
  const integrity = database.prepare("PRAGMA integrity_check").get() as Row | undefined;
  if (!integrity || Object.values(integrity)[0] !== "ok" || database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Daemon state v11 failed SQLite integrity validation.");
},

repairAndValidateV11Shape(database: DatabaseSync): void {
  this.repairAndValidateV9Shape(database);
  const columns = this.tableColumns(database, "agent_configurations");
  const purgeColumns = this.tableColumns(database, "agent_purge_operations");
  if (columns.has("reasoning_effort") && columns.has("config_revision") && columns.has("runtime_configuration_revision") && this.tableColumns(database, "agent_room_moves").has("source_cursor_present")
    && this.tableColumns(database, "agent_room_moves").has("source_credentials_revoked")
    && purgeColumns.has("attached_work_attempt_id") && purgeColumns.has("preserved_workspace_path")
    && purgeColumns.has("worker_session_attestation") && purgeColumns.has("agent_session_id")) {
    this.applyV11Shape(database);
    this.validateV11Shape(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    let moveColumns = this.tableColumns(database, "agent_room_moves");
    if (moveColumns.size && !moveColumns.has("request_id")) {
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM agent_room_moves").get() as Row).count);
      if (count !== 0) throw new Error("Cannot repair the prerelease v10 room-move journal because it contains operations.");
      database.exec("DROP TABLE agent_room_moves");
      moveColumns = new Set();
    }
    if (moveColumns.size && !moveColumns.has("source_cursor_present")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1))");
    }
    if (moveColumns.size && !moveColumns.has("source_cursor")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_cursor TEXT");
    }
    if (moveColumns.size && !moveColumns.has("source_credentials_revoked")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1))");
    }
    let purgeColumns = this.tableColumns(database, "agent_purge_operations");
    if (purgeColumns.size && !purgeColumns.has("attached_work_attempt_id")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN attached_work_attempt_id TEXT");
    }
    if (purgeColumns.size && !purgeColumns.has("preserved_workspace_path")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN preserved_workspace_path TEXT");
    }
    if (purgeColumns.size && !purgeColumns.has("agent_session_id")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN agent_session_id TEXT");
    }
    purgeColumns = this.tableColumns(database, "agent_purge_operations");
    if (purgeColumns.size && !purgeColumns.has("worker_session_attestation")) {
      this.rebuildPurgeOperationsV11(database);
    }
    this.applyV11Shape(database); this.validateV11Shape(database); database.exec("COMMIT");
  }
  catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
},

applyV12Shape(database: DatabaseSync): void {
  this.applyV11Shape(database);
  const existed = this.tableColumns(database, "supervised_worker_mint_states").size > 0;
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_worker_mint_states (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('never_minted','minting_unknown','exact')),
      agent_session_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK(
        (phase='exact' AND agent_session_id IS NOT NULL)
        OR
        (phase IN ('never_minted','minting_unknown') AND agent_session_id IS NULL)
      )
    ) STRICT;
  `);
  if (!existed) {
    // V11 had no mint journal. Seed only facts that its durable records can
    // actually prove; omitted legacy bindings deliberately remain unknown.
    const now = new Date().toISOString();
    run(database.prepare(`
      INSERT INTO supervised_worker_mint_states
        (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
      SELECT b.agent_id,m.room_id,'daemon:' || b.agent_id,
        CASE WHEN b.binding_agent_session_id IS NULL THEN 'minting_unknown' ELSE 'exact' END,
        b.binding_agent_session_id,COALESCE(b.binding_updated_at,?)
      FROM retained_worker_bindings b
      JOIN agent_room_memberships m USING(agent_id)
      WHERE b.last_worker_binding_present=1
    `), now);
    run(database.prepare(`
      INSERT OR REPLACE INTO supervised_worker_mint_states
        (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
      SELECT agent_id,room_id,'daemon:' || agent_id,'exact',agent_session_id,updated_at
      FROM supervised_worker_sessions
    `));
  }
},

/**
 * Every legacy migration in this file advances directly to the current
 * paired version marker. Keep the physical v12 validation ahead of the v13
 * inbox rebuild so an incomplete predecessor can never be disguised by the
 * continuation-repair tables.
 */
applyCurrentSchemaTail(database: DatabaseSync): void {
  this.applyV12Shape(database);
  this.validateV12Shape(database);
  this.applyV13Shape(database);
  this.validateV13Shape(database);
  this.applyV14Shape(database);
  this.validateV14Shape(database);
  this.applyV15Shape(database);
  this.validateV15Shape(database);
  this.applyV16Shape(database);
  this.validateV16Shape(database);
  this.applyV17Shape(database, true);
  this.validateV17Shape(database);
  this.applyV18Shape(database);
  this.validateV18Shape(database);
  this.applyV20Shape(database);
},

validateV12Shape(database: DatabaseSync): void {
  this.validateV11Shape(database);
  const expectedColumns = ["agent_id", "room_id", "agent_instance_id", "phase", "agent_session_id", "updated_at"];
  const details = database.prepare("PRAGMA table_xinfo(supervised_worker_mint_states)")
    .all() as Array<{ name: string; hidden: number }>;
  const actualColumns = details.map((column) => String(column.name));
  if (actualColumns.length !== expectedColumns.length
    || expectedColumns.some((column, index) => actualColumns[index] !== column)
    || details.some((column) => Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v12 mint-state table has invalid columns.");
  }
  if (actualColumns.some((column) => /(token|bearer|credential|secret)/i.test(column))) {
    throw new Error("Daemon state v12 mint-state table must never persist worker credentials.");
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const canonical = `CREATE TABLE supervised_worker_mint_states (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,agent_instance_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('never_minted','minting_unknown','exact')),agent_session_id TEXT,updated_at TEXT NOT NULL,CHECK((phase='exact' AND agent_session_id IS NOT NULL) OR (phase IN ('never_minted','minting_unknown') AND agent_session_id IS NULL))) STRICT`;
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_worker_mint_states'").get() as Row | undefined;
  const info = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_worker_mint_states" && row.type === "table");
  if (!definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonical)
    || !info || Number(info.strict) !== 1 || Number(info.wr) !== 0) {
    throw new Error("Daemon state v12 mint-state table does not match its canonical strict definition.");
  }
},

repairAndValidateV12Shape(database: DatabaseSync): void {
  this.repairAndValidateV11Shape(database);
  const columns = this.tableColumns(database, "supervised_worker_mint_states");
  if (columns.size === 0) {
    throw new Error("Daemon state v12 is missing its mint-state table and cannot safely reconstruct erased mint attempts.");
  }
  this.validateV12Shape(database);
},
});
