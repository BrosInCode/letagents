/**
 * Worker, delivery and inbox-event shapes (v4 to v7).
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

export const shapesV4ToV7 = schemaMethods({
applyV4Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worker_session_bindings (
      entry_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      agent_session_token TEXT NOT NULL,
      api_url TEXT NOT NULL,
      room_cursor TEXT,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS worker_session_binding_authority
      ON worker_session_bindings(entry_id, binding_epoch, execution_generation_id, agent_session_id);
    CREATE TABLE IF NOT EXISTS worker_binding_publications (
      reservation_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'failed')),
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE(entry_id, sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS worker_binding_publications_current
      ON worker_binding_publications(entry_id, binding_epoch, sequence DESC);
    CREATE TABLE IF NOT EXISTS worker_generation_verifications (
      reservation_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      from_execution_generation_id TEXT NOT NULL,
      to_execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'failed', 'lost_race')),
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE(entry_id, sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS worker_generation_verifications_current
      ON worker_generation_verifications(entry_id, binding_epoch, sequence DESC);
  `);
},

validateV4Shape(database: DatabaseSync): void {
  const normalizeSql = (value: string) => {
    const stripped = value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    let result = ""; let quote = ""; let escaped = false;
    for (const char of stripped) {
      if (quote) { result += char; if (escaped) escaped = false; else if (char === "'") quote = ""; else if (char === "\\") escaped = true; }
      else if (char === "'") { quote = char; result += char; } else result += char.toLowerCase();
    }
    return result.replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").trim();
  };
  const canonicalTables: Record<string, string> = {
    worker_session_bindings: `CREATE TABLE worker_session_bindings (entry_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,work_attempt_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,agent_session_token TEXT NOT NULL,api_url TEXT NOT NULL,room_cursor TEXT,last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),updated_at TEXT NOT NULL) STRICT`,
    worker_binding_publications: `CREATE TABLE worker_binding_publications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_generation_verifications: `CREATE TABLE worker_generation_verifications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),from_execution_generation_id TEXT NOT NULL,to_execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed','lost_race')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
  };
  for (const [table, canonical] of Object.entries(canonicalTables)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(canonical)) throw new Error(`Daemon state v4 table ${table} does not match its canonical definition.`);
  }
  const required: Record<string, string[]> = {
    worker_session_bindings: ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url", "room_cursor", "last_sequence", "last_observed_at_ms", "binding_epoch", "updated_at"],
    worker_binding_publications: ["reservation_id", "entry_id", "binding_epoch", "execution_generation_id", "agent_session_id", "sequence", "observed_at", "observed_at_ms", "state", "created_at", "finalized_at"],
    worker_generation_verifications: ["reservation_id", "entry_id", "binding_epoch", "from_execution_generation_id", "to_execution_generation_id", "agent_session_id", "sequence", "observed_at", "observed_at_ms", "state", "created_at", "finalized_at"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number; hidden: number }>;
    const actual = new Set(columns.map((column) => column.name));
    const missing = expected.filter((column) => !actual.has(column));
    const extra = columns.map((column) => column.name).filter((column) => !expected.includes(column));
    if (missing.length || extra.length) throw new Error(`Daemon state v4 table ${table} has invalid columns (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
    for (const column of columns) {
      const isPrimary = column.name === (table === "worker_session_bindings" ? "entry_id" : "reservation_id");
      const expectedType = ["last_sequence", "last_observed_at_ms", "binding_epoch", "sequence", "observed_at_ms"].includes(column.name) ? "INTEGER" : "TEXT";
      const nullable = column.name === "room_cursor" || column.name === "finalized_at";
      if (Number(column.hidden) !== 0 || column.type !== expectedType || Number(column.notnull) !== (nullable ? 0 : 1) || Number(column.pk) !== (isPrimary ? 1 : 0)) {
        throw new Error(`Daemon state v4 table ${table} has invalid definition for ${column.name}.`);
      }
    }
    const tableRow = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!tableRow || Number(tableRow.strict) !== 1 || Number(tableRow.wr) !== 0) throw new Error(`Daemon state v4 table ${table} must be STRICT rowid tables.`);
  }
  const indexNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Row[]).map((row) => String(row.name)));
  for (const index of ["worker_session_binding_authority", "worker_binding_publications_current", "worker_generation_verifications_current"]) {
    if (!indexNames.has(index)) throw new Error(`Daemon state v4 is missing required index ${index}.`);
  }
  const indexColumns: Record<string, string[]> = {
    worker_session_binding_authority: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"],
    worker_binding_publications_current: ["entry_id", "binding_epoch", "sequence"],
    worker_generation_verifications_current: ["entry_id", "binding_epoch", "sequence"],
  };
  for (const [name, expected] of Object.entries(indexColumns)) {
    const actual = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{ key: number; name: string | null; desc: number }>).filter((row) => Number(row.key) === 1);
    const descendingLast = name !== "worker_session_binding_authority";
    if (actual.length !== expected.length || actual.some((row, index) => row.name !== expected[index] || Number(row.desc) !== (descendingLast && index === expected.length - 1 ? 1 : 0))) {
      throw new Error(`Daemon state v4 index ${name} has an invalid key definition.`);
    }
  }
  const indexRequirements: Record<string, { table: string; unique: number; columns: string[] }> = {
    worker_session_binding_authority: { table: "worker_session_bindings", unique: 1, columns: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"] },
    worker_binding_publications_current: { table: "worker_binding_publications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    worker_generation_verifications_current: { table: "worker_generation_verifications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
  };
  for (const [name, requirement] of Object.entries(indexRequirements)) {
    const listed = (database.prepare(`PRAGMA index_list(${requirement.table})`).all() as Array<{ name: string; unique: number; partial: number; origin: string }>).find((row) => row.name === name);
    if (!listed || Number(listed.unique) !== requirement.unique || Number(listed.partial) !== 0 || String(listed.origin) !== "c") throw new Error(`Daemon state v4 index ${name} has invalid ownership or uniqueness.`);
    const info = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{ key: number; cid: number; name: string | null; desc: number; coll: string }>).filter((row) => Number(row.key) === 1);
    const descendingLast = name !== "worker_session_binding_authority";
    if (info.length !== requirement.columns.length || info.some((row, index) => Number(row.cid) < 0 || row.name !== requirement.columns[index] || Number(row.desc) !== (descendingLast && index === requirement.columns.length - 1 ? 1 : 0) || String(row.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v4 index ${name} has invalid terms.`);
  }
  for (const table of ["worker_binding_publications", "worker_generation_verifications"]) {
    const uniqueSequence = (database.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>).some((row) => {
      if (Number(row.unique) !== 1 || String(row.origin) !== "u" || Number(row.partial) !== 0) return false;
      const terms = (database.prepare(`PRAGMA index_xinfo(${row.name})`).all() as Array<{ key: number; cid: number; name: string | null; desc: number; coll: string }>).filter((term) => Number(term.key) === 1);
      return terms.length === 2 && terms[0]?.cid >= 0 && terms[1]?.cid >= 0 && terms[0]?.name === "entry_id" && terms[1]?.name === "sequence" && Number(terms[0]?.desc) === 0 && Number(terms[1]?.desc) === 0 && String(terms[0]?.coll).toUpperCase() === "BINARY" && String(terms[1]?.coll).toUpperCase() === "BINARY";
    });
    if (!uniqueSequence) throw new Error(`Daemon state v4 table ${table} is missing UNIQUE(entry_id, sequence).`);
  }
  const rejectsCheck = (sql: string, ...values: unknown[]) => {
    database.exec("SAVEPOINT worker_v4_check_probe");
    try {
      try { database.prepare(sql).run(...values as never[]); }
      catch (error: unknown) { if (!/CHECK constraint failed/i.test(String(error))) throw error; return; }
      throw new Error("required CHECK accepted an invalid value");
    } finally { database.exec("ROLLBACK TO worker_v4_check_probe"); database.exec("RELEASE worker_v4_check_probe"); }
  };
  const binding = ["probe", "room", "attempt", "run", "session", "token", "https://example.test", null, 1, 1, 1, "2026-01-01T00:00:00.000Z"];
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), -1, 1, 1, binding[11]);
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), 1, -1, 1, binding[11]);
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), 1, 1, 0, binding[11]);
  const publication = ["probe", "agent", 1, "run", "session", 1, "2026-01-01T00:00:00.000Z", 1, "reserved", "2026-01-01T00:00:00.000Z", null];
  for (const invalid of [[-1, 1, "reserved"], [0, 1, "reserved"], [1, -1, "reserved"], [1, 1, "bogus"], [1, 1, "working"], [1, 1, ""]]) rejectsCheck("INSERT INTO worker_binding_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...publication.slice(0, 5), invalid[0], publication[6], invalid[1], invalid[2], publication[9], null);
  const verification = ["probe", "agent", 1, "from", "to", "session", 1, "2026-01-01T00:00:00.000Z", 1, "reserved", "2026-01-01T00:00:00.000Z", null];
  for (const invalid of [[-1, 1, "reserved"], [0, 1, "reserved"], [1, -1, "reserved"], [1, 1, "bogus"], [1, 1, "working"], [1, 1, ""]]) rejectsCheck("INSERT INTO worker_generation_verifications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...verification.slice(0, 6), invalid[0], verification[7], invalid[1], invalid[2], verification[10], null);
},

applyV5Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worker_binding_watermarks (
      entry_id TEXT PRIMARY KEY,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  // v4 kept authority only with live credentials. Build the independent
  // tombstone from both the live row and every historic reservation before a
  // v5 opener can bind again. This runs idempotently during interrupted
  // migrations as well as a normal upgrade.
  database.exec(`
    INSERT INTO worker_binding_watermarks
      (entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at)
    SELECT entry_id, MAX(binding_epoch), MAX(last_sequence), MAX(last_observed_at_ms), MAX(updated_at)
    FROM (
      SELECT entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at
      FROM worker_session_bindings
      UNION ALL
      SELECT entry_id, binding_epoch, sequence, observed_at_ms, observed_at
      FROM worker_binding_publications
      UNION ALL
      SELECT entry_id, binding_epoch, sequence, observed_at_ms, observed_at
      FROM worker_generation_verifications
    )
    GROUP BY entry_id
    ON CONFLICT(entry_id) DO UPDATE SET
      binding_epoch = MAX(worker_binding_watermarks.binding_epoch, excluded.binding_epoch),
      last_sequence = MAX(worker_binding_watermarks.last_sequence, excluded.last_sequence),
      last_observed_at_ms = MAX(worker_binding_watermarks.last_observed_at_ms, excluded.last_observed_at_ms),
      updated_at = CASE
        WHEN excluded.last_observed_at_ms >= worker_binding_watermarks.last_observed_at_ms THEN excluded.updated_at
        ELSE worker_binding_watermarks.updated_at
      END;
  `);
},

validateV5Shape(database: DatabaseSync): void {
  const canonical = `CREATE TABLE worker_binding_watermarks (entry_id TEXT PRIMARY KEY,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),updated_at TEXT NOT NULL) STRICT`;
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_binding_watermarks'").get() as Row | undefined;
  if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(canonical)) throw new Error("Daemon state v5 table worker_binding_watermarks does not match its canonical definition.");
  const columns = database.prepare("PRAGMA table_xinfo(worker_binding_watermarks)").all() as Array<{ name: string; type: string; notnull: number; pk: number; hidden: number }>;
  const expected = [
    ["entry_id", "TEXT", 1, 1], ["binding_epoch", "INTEGER", 1, 0], ["last_sequence", "INTEGER", 1, 0],
    ["last_observed_at_ms", "INTEGER", 1, 0], ["updated_at", "TEXT", 1, 0],
  ] as const;
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index]![0] || column.type !== expected[index]![1] || Number(column.notnull) !== expected[index]![2] || Number(column.pk) !== expected[index]![3] || Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v5 table worker_binding_watermarks has invalid columns.");
  }
  const table = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === "worker_binding_watermarks" && row.type === "table");
  if (!table || Number(table.strict) !== 1 || Number(table.wr) !== 0) throw new Error("Daemon state v5 table worker_binding_watermarks must be a STRICT rowid table.");
  const rejectsCheck = (sql: string, ...values: unknown[]) => {
    database.exec("SAVEPOINT worker_v5_check_probe");
    try {
      try { database.prepare(sql).run(...values as never[]); }
      catch (error: unknown) { if (!/CHECK constraint failed/i.test(String(error))) throw error; return; }
      throw new Error("required CHECK accepted an invalid value");
    } finally { database.exec("ROLLBACK TO worker_v5_check_probe"); database.exec("RELEASE worker_v5_check_probe"); }
  };
  for (const invalid of [[0, 0, 0], [1, -1, 0], [1, 0, -1]]) rejectsCheck("INSERT INTO worker_binding_watermarks VALUES (?, ?, ?, ?, ?)", "probe", invalid[0], invalid[1], invalid[2], "2026-01-01T00:00:00.000Z");
},

applyV6Shape(database: DatabaseSync): void {
  // This additive v6 journal originally ordered tied timestamps by a text key,
  // which is not causal. Rebuild only that new table into the ordinal shape.
  const eventColumns = this.tableColumns(database, "supervised_agent_inbox_events");
  if (eventColumns.has("transition_key") && !eventColumns.has("event_sequence")) {
    database.exec(`
      CREATE TABLE supervised_agent_inbox_events_v6_ordered (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      INSERT INTO supervised_agent_inbox_events_v6_ordered(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT inbox_item_id,ROW_NUMBER() OVER (PARTITION BY inbox_item_id ORDER BY observed_at,transition_key),transition_key,phase,observed_at,detail
      FROM supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_events;
      ALTER TABLE supervised_agent_inbox_events_v6_ordered RENAME TO supervised_agent_inbox_events;
    `);
  }
  // v4/v5 persisted the raw worker-session token. Rebuild rather than ALTER
  // so no live table in a completed v6 database has a secret column.
  const columns = this.tableColumns(database, "worker_session_bindings");
  if (columns.has("agent_session_token")) {
    database.exec(`
      -- A prior interrupted/manual attempt may have left the staging name.
      -- The caller is in one IMMEDIATE transaction, so discarding that
      -- incomplete copy is safe; the authoritative legacy source remains.
      DROP TABLE IF EXISTS worker_session_bindings_v6;
      CREATE TABLE worker_session_bindings_v6 (
        entry_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        work_attempt_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        api_url TEXT NOT NULL,
        room_cursor TEXT,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
        binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO worker_session_bindings_v6
        (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id,
         credential_ref, api_url, room_cursor, last_sequence, last_observed_at_ms,
         binding_epoch, updated_at)
      SELECT entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id,
        lower(hex(randomblob(16))), api_url, room_cursor, last_sequence,
        last_observed_at_ms, binding_epoch, updated_at
      FROM worker_session_bindings;
      DROP TABLE worker_session_bindings;
      ALTER TABLE worker_session_bindings_v6 RENAME TO worker_session_bindings;
      CREATE UNIQUE INDEX worker_session_binding_authority
        ON worker_session_bindings(entry_id, binding_epoch, execution_generation_id, agent_session_id);
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL,
      activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','publishing','retryable','blocked','acknowledged','acknowledged_no_reply')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL,
      reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT,
      outcome TEXT,
      last_error TEXT,
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      UNIQUE(agent_id, source_message_id),
      UNIQUE(agent_id, fifo_sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_inbox_head
      ON supervised_agent_inbox(agent_id, fifo_sequence);
    -- Additive v6 journal: phase facts are append-only and survive a daemon
    -- restart. It does not alter the canonical inbox state machine.
    CREATE TABLE IF NOT EXISTS supervised_agent_inbox_events (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),
      observed_at TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY(inbox_item_id, event_sequence),
      UNIQUE(inbox_item_id, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_inbox_events_timeline
      ON supervised_agent_inbox_events(inbox_item_id, event_sequence);
    CREATE TABLE IF NOT EXISTS supervised_agent_ingress_cursors (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      last_observed_message_id TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS supervised_worker_sessions (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
},

applyV7Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "supervised_agent_terminal_results").size) {
    const restoreContext = this.detachLaterInboxTables(database, ["supervised_agent_prepared_context"]);
    database.exec(`
      ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_v6;
      CREATE TABLE supervised_agent_inbox (
        inbox_item_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL,
        activation_json TEXT NOT NULL,
        fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        action_id TEXT NOT NULL,
        reply_client_message_id TEXT NOT NULL,
        provider_turn_id TEXT,
        outcome TEXT,
        last_error TEXT,
        blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
        next_attempt_at_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE(agent_id, source_message_id),
        UNIQUE(agent_id, fifo_sequence)
      ) STRICT;
      INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_v6;

      CREATE TABLE supervised_agent_inbox_events_v7 (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      INSERT INTO supervised_agent_inbox_events_v7
        (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail
      FROM supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_v6;
      ALTER TABLE supervised_agent_inbox_events_v7 RENAME TO supervised_agent_inbox_events;
      CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
      CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);

      CREATE TABLE supervised_agent_terminal_results (
        inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable')),
        normalized_text TEXT,
        evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
        terminal_evidence_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX supervised_agent_terminal_result_turn
        ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);

      CREATE TABLE supervised_agent_observed_messages (
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL,
        activation_json TEXT NOT NULL,
        activation_decision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,source_message_id)
      ) STRICT;
      CREATE INDEX supervised_agent_observed_context
        ON supervised_agent_observed_messages(agent_id,room_id,source_message_id);

      CREATE TABLE supervised_agent_effects (
        effect_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        mcp_request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','executing','completed','failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
      ) STRICT;
      CREATE INDEX supervised_agent_effects_turn
        ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);

      CREATE TABLE supervised_agent_ingress_health (
        agent_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','observing','backoff','blocked','stopped')),
        detail TEXT,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    restoreContext();
  }
  if (!this.tableColumns(database, "supervised_agent_inbox_events").size) {
    database.exec(`
      CREATE TABLE supervised_agent_inbox_events (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      CREATE INDEX supervised_agent_inbox_events_timeline
        ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    `);
  }
},

validateV7Shape(database: DatabaseSync, includeInboxEvents = true): void {
  // The inbox discriminator is sufficient during current-version repair:
  // the additive repair journal may be absent while the authoritative inbox
  // has already reached v13.
  const hasV13DeliveryShape = this.tableColumns(database, "supervised_agent_inbox").has("failure_code");
  const hasV17TerminalReason = this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason");
  const hasV17EffectShape = this.tableColumns(database, "supervised_agent_effects").has("mutation");
  const required: Record<string, string[]> = {
    supervised_agent_inbox: ["inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "fifo_sequence", "state", "attempt_count", "action_id", "reply_client_message_id", "provider_turn_id", "outcome", "last_error", ...(hasV13DeliveryShape ? ["failure_code"] : []), "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at", ...(hasV17TerminalReason ? ["terminal_reason"] : [])],
    supervised_agent_inbox_events: ["inbox_item_id", "event_sequence", "idempotency_key", "phase", "observed_at", "detail"],
    supervised_agent_terminal_results: ["inbox_item_id", "agent_id", "execution_generation_id", "provider_turn_id", "outcome", "normalized_text", "evidence_source", "terminal_evidence_json", "observed_at", "updated_at"],
    supervised_agent_observed_messages: ["agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "activation_decision", "observed_at"],
    supervised_agent_effects: ["effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id", "mcp_request_id", "tool_name", "request_json", ...(hasV17EffectShape ? ["mutation"] : []), "state", "result_json", "error", "created_at", "updated_at"],
    supervised_agent_ingress_health: ["agent_id", "room_id", "execution_generation_id", "state", "detail", "observed_at", "updated_at"],
  };
  if (!includeInboxEvents) delete required.supervised_agent_inbox_events;
  for (const [table, expected] of Object.entries(required)) {
    const details = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; hidden: number }>;
    const columns = details.map((column) => String(column.name));
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || expected.some((column) => !columns.includes(column))
      || columns.some((column) => !expected.includes(column)) || details.some((column) => Number(column.hidden) !== 0)) {
      throw new Error(`Daemon state v7 table ${table} has an invalid strict schema.`);
    }
  }
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v7 must not persist agent_session_token.");
  }
},

validateV6Shape(database: DatabaseSync, includeDeliveryTables = true): void {
  const canonical: Record<string, string> = {
    worker_session_bindings: `CREATE TABLE worker_session_bindings (entry_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,work_attempt_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,credential_ref TEXT NOT NULL,api_url TEXT NOT NULL,room_cursor TEXT,last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),updated_at TEXT NOT NULL) STRICT`,
    supervised_agent_inbox: `CREATE TABLE supervised_agent_inbox (inbox_item_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,room_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_message_json TEXT NOT NULL,activation_json TEXT NOT NULL,fifo_sequence INTEGER NOT NULL CHECK(fifo_sequence > 0),state TEXT NOT NULL CHECK(state IN ('pending','dispatching','awaiting_result','publishing','retryable','blocked','acknowledged','acknowledged_no_reply')),attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),action_id TEXT NOT NULL,reply_client_message_id TEXT NOT NULL,provider_turn_id TEXT,outcome TEXT,last_error TEXT,blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),next_attempt_at_ms INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,acknowledged_at TEXT,UNIQUE(agent_id,source_message_id),UNIQUE(agent_id,fifo_sequence)) STRICT`,
    supervised_agent_inbox_events: `CREATE TABLE supervised_agent_inbox_events (inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),idempotency_key TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),observed_at TEXT NOT NULL,detail TEXT,PRIMARY KEY(inbox_item_id,event_sequence),UNIQUE(inbox_item_id,idempotency_key)) STRICT`,
    supervised_agent_ingress_cursors: `CREATE TABLE supervised_agent_ingress_cursors (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,last_observed_message_id TEXT,updated_at TEXT NOT NULL) STRICT`,
    supervised_worker_sessions: `CREATE TABLE supervised_worker_sessions (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,credential_ref TEXT NOT NULL,expires_at TEXT,updated_at TEXT NOT NULL) STRICT`,
    worker_binding_publications: `CREATE TABLE worker_binding_publications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_generation_verifications: `CREATE TABLE worker_generation_verifications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),from_execution_generation_id TEXT NOT NULL,to_execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed','lost_race')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_binding_watermarks: `CREATE TABLE worker_binding_watermarks (entry_id TEXT PRIMARY KEY,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),updated_at TEXT NOT NULL) STRICT`,
  };
  if (!includeDeliveryTables) {
    delete canonical.supervised_agent_inbox;
    delete canonical.supervised_agent_inbox_events;
    delete canonical.supervised_agent_ingress_cursors;
    delete canonical.supervised_worker_sessions;
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  for (const [table, expected] of Object.entries(canonical)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(expected)) throw new Error(`Daemon state v6 table ${table} does not match its canonical definition.`);
  }
  const required: Record<string, string[]> = {
    worker_session_bindings: ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "credential_ref", "api_url", "room_cursor", "last_sequence", "last_observed_at_ms", "binding_epoch", "updated_at"],
    supervised_agent_inbox: ["inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "fifo_sequence", "state", "attempt_count", "action_id", "reply_client_message_id", "provider_turn_id", "outcome", "last_error", "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at"],
    supervised_agent_inbox_events: ["inbox_item_id", "event_sequence", "idempotency_key", "phase", "observed_at", "detail"],
    supervised_agent_ingress_cursors: ["agent_id", "room_id", "last_observed_message_id", "updated_at"],
    supervised_worker_sessions: ["agent_id", "room_id", "agent_session_id", "execution_generation_id", "credential_ref", "expires_at", "updated_at"],
  };
  if (!includeDeliveryTables) {
    delete required.supervised_agent_inbox;
    delete required.supervised_agent_inbox_events;
    delete required.supervised_agent_ingress_cursors;
    delete required.supervised_worker_sessions;
  }
  for (const [table, expected] of Object.entries(required)) {
    const details = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; hidden: number }>;
    const columns = details.map((column) => String(column.name));
    const missing = expected.filter((column) => !columns.includes(column));
    const extra = columns.filter((column) => !expected.includes(column));
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || missing.length || extra.length || details.some((column) => Number(column.hidden) !== 0)) {
      throw new Error(`Daemon state v6 table ${table} has an invalid strict schema.`);
    }
  }
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v6 must not persist agent_session_token.");
  }
  if (includeDeliveryTables) {
    const duplicateInbox = database.prepare(`SELECT 1 FROM supervised_agent_inbox GROUP BY agent_id, source_message_id HAVING COUNT(*) > 1 LIMIT 1`).get();
    if (duplicateInbox) throw new Error("Daemon state v6 inbox uniqueness is invalid.");
  }
  const indexes: Record<string, { table: string; unique: number; columns: string[] }> = {
    worker_session_binding_authority: { table: "worker_session_bindings", unique: 1, columns: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"] },
    worker_binding_publications_current: { table: "worker_binding_publications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    worker_generation_verifications_current: { table: "worker_generation_verifications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    supervised_agent_inbox_head: { table: "supervised_agent_inbox", unique: 0, columns: ["agent_id", "fifo_sequence"] },
    supervised_agent_inbox_events_timeline: { table: "supervised_agent_inbox_events", unique: 0, columns: ["inbox_item_id", "event_sequence"] },
  };
  if (!includeDeliveryTables) {
    delete indexes.supervised_agent_inbox_head;
    delete indexes.supervised_agent_inbox_events_timeline;
  }
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    if (!listed || Number(listed.unique) !== expected.unique || Number(listed.partial) !== 0
      || String(listed.origin) !== "c" || terms.length !== expected.columns.length
      || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index]
        || Number(term.desc) !== (name.endsWith("_current") && index === terms.length - 1 ? 1 : 0)
        || String(term.coll).toUpperCase() !== "BINARY")) {
      throw new Error(`Daemon state v6 index ${name} is invalid.`);
    }
  }
},
});
