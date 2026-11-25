/**
 * Unified external-effect journal schema (introduced as `effect_journal` in
 * schema v2 and promoted to `effects` in schema v3 when bounded MCP effects
 * migrated onto this table and dropped the legacy `effects` table).
 *
 * Holds only actions on the outside world. Internal state changes commit
 * directly with their domain state inside the caller's SQLite transaction.
 */
import type { DatabaseSync } from "node:sqlite";

/** Final table name in schema v3+. */
export const EFFECT_JOURNAL_TABLE = "effects";

/** Staging table name used in immutable schema v2 before v2 -> v3 cutover. */
export const EFFECT_JOURNAL_TABLE_V2 = "effect_journal";

export const EFFECT_STATES = [
  "prepared",
  "executing",
  "uncertain",
  "completed",
  "failed",
] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

function effectTableCreateSql(table: string): string {
  return `CREATE TABLE ${table} (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
    agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 256),
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'executing', 'uncertain', 'completed', 'failed')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    outcome TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
    retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
    next_attempt_at_ms INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, kind, idempotency_key),
    CHECK (retryable = 1 OR max_attempts = 1),
    CHECK (attempt_count <= max_attempts),
    CHECK (
      (state = 'prepared' AND outcome IS NULL)
      OR (state = 'executing' AND outcome IS NULL AND next_attempt_at_ms IS NULL AND attempt_count >= 1)
      OR (state = 'uncertain' AND next_attempt_at_ms IS NULL)
      OR (state = 'completed' AND next_attempt_at_ms IS NULL AND last_error IS NULL)
      OR (state = 'failed' AND next_attempt_at_ms IS NULL)
    )
  ) STRICT`;
}

function effectIndexesAndTriggerSql(
  table: string,
  prefix: string,
  includeBoundedMcpTurnIndex: boolean,
): readonly string[] {
  return [
    `CREATE INDEX ${prefix}_runnable
    ON ${table}(state, next_attempt_at_ms, created_at, id)
    WHERE state IN ('prepared', 'executing')`,
    `CREATE INDEX ${prefix}_agent_state
    ON ${table}(agent_id, kind, state, updated_at)`,
    ...(includeBoundedMcpTurnIndex
      ? [
          `CREATE INDEX ${prefix}_bounded_mcp_turn
    ON ${table}(agent_id, json_extract(payload, '$.execution_generation_id'), json_extract(payload, '$.provider_turn_id'))
    WHERE kind = 'bounded_mcp_effect'`,
        ]
      : []),
    `CREATE TRIGGER ${prefix}_immutable_identity BEFORE UPDATE ON ${table}
    WHEN NEW.id IS NOT OLD.id
      OR NEW.agent_id IS NOT OLD.agent_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.idempotency_key IS NOT OLD.idempotency_key
      OR NEW.payload IS NOT OLD.payload
      OR NEW.retryable IS NOT OLD.retryable
      OR NEW.max_attempts IS NOT OLD.max_attempts
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.epoch < OLD.epoch
      OR NEW.attempt_count < OLD.attempt_count
      OR OLD.state IN ('completed', 'failed')
      OR (OLD.state = 'prepared' AND NEW.state NOT IN ('executing', 'uncertain', 'failed'))
      OR (OLD.state = 'prepared' AND NEW.state = 'uncertain' AND OLD.attempt_count < 1)
      OR (OLD.state = 'prepared' AND NEW.state = 'executing' AND NEW.attempt_count != OLD.attempt_count + 1)
      OR (OLD.state != 'prepared' AND NEW.attempt_count != OLD.attempt_count)
      OR (OLD.state = 'executing' AND NEW.state NOT IN ('prepared', 'uncertain', 'completed', 'failed'))
      OR (OLD.state = 'executing' AND NEW.state = 'prepared' AND (OLD.retryable = 0 OR OLD.attempt_count >= OLD.max_attempts))
      OR (OLD.state = 'uncertain' AND NEW.state NOT IN ('completed', 'failed'))
    BEGIN
      SELECT RAISE(ABORT, 'Effect journal identity or state transition is invalid');
    END`,
  ];
}

/** Immutable v2 DDL creating the staging `effect_journal` table and its indexes/trigger. */
export const effectJournalSchemaV2Sql: readonly string[] = [
  effectTableCreateSql(EFFECT_JOURNAL_TABLE_V2),
  ...effectIndexesAndTriggerSql(EFFECT_JOURNAL_TABLE_V2, EFFECT_JOURNAL_TABLE_V2, false),
];

/** Final v3+ indexes and trigger installed on the renamed `effects` table. */
export const effectsTableIndexesAndTriggerV3Sql: readonly string[] =
  effectIndexesAndTriggerSql(EFFECT_JOURNAL_TABLE, EFFECT_JOURNAL_TABLE, true);

/** Full standalone v3+ DDL for `effects`. */
export const effectJournalSchemaSql: readonly string[] = [
  effectTableCreateSql(EFFECT_JOURNAL_TABLE),
  ...effectsTableIndexesAndTriggerV3Sql,
];

/** Applies the immutable v2 staging `effect_journal` DDL inside `migrateV1ToV2`. */
export function applyEffectJournalSchemaV2(database: DatabaseSync): void {
  for (const statement of effectJournalSchemaV2Sql) {
    database.exec(statement);
  }
}

/** Installs the final v3+ `effects` indexes and trigger after `ALTER TABLE effect_journal RENAME TO effects`. */
export function applyEffectsTableIndexesAndTriggerV3(database: DatabaseSync): void {
  for (const statement of effectsTableIndexesAndTriggerV3Sql) {
    database.exec(statement);
  }
}

/** Applies the full v3+ unified `effects` DDL on an empty table-less database. */
export function applyEffectJournalSchema(database: DatabaseSync): void {
  for (const statement of effectJournalSchemaSql) {
    database.exec(statement);
  }
}
