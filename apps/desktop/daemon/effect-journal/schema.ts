/**
 * Unified external-effect journal schema (introduced in daemon schema v2).
 *
 * Holds only actions on the outside world. Internal state changes commit
 * directly with their domain state inside the caller's SQLite transaction.
 *
 * The table is named `effect_journal` during the incremental per-feature
 * migration so existing schema-v1 bounded MCP `effects` rows remain intact
 * until bounded MCP effects moves onto this journal and replaces the legacy
 * table. All feature code goes through this module's exported constant and
 * store functions rather than hardcoding the table name.
 */
import type { DatabaseSync } from "node:sqlite";

export const EFFECT_JOURNAL_TABLE = "effect_journal";

export const EFFECT_STATES = [
  "prepared",
  "executing",
  "uncertain",
  "completed",
  "failed",
] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

export const effectJournalSchemaSql: readonly string[] = [
  `CREATE TABLE ${EFFECT_JOURNAL_TABLE} (
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
  ) STRICT`,
  `CREATE INDEX effect_journal_runnable
    ON ${EFFECT_JOURNAL_TABLE}(state, next_attempt_at_ms, created_at, id)
    WHERE state IN ('prepared', 'executing')`,
  `CREATE INDEX effect_journal_agent_state
    ON ${EFFECT_JOURNAL_TABLE}(agent_id, kind, state, updated_at)`,
  `CREATE TRIGGER effect_journal_immutable_identity BEFORE UPDATE ON ${EFFECT_JOURNAL_TABLE}
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
      OR (OLD.state = 'prepared' AND NEW.state NOT IN ('executing', 'failed'))
      OR (OLD.state = 'prepared' AND NEW.state = 'executing' AND NEW.attempt_count != OLD.attempt_count + 1)
      OR (OLD.state != 'prepared' AND NEW.attempt_count != OLD.attempt_count)
      OR (OLD.state = 'executing' AND NEW.state NOT IN ('prepared', 'uncertain', 'completed', 'failed'))
      OR (OLD.state = 'executing' AND NEW.state = 'prepared' AND (OLD.retryable = 0 OR OLD.attempt_count >= OLD.max_attempts))
      OR (OLD.state = 'uncertain' AND NEW.state NOT IN ('completed', 'failed'))
    BEGIN
      SELECT RAISE(ABORT, 'Effect journal identity or state transition is invalid');
    END`,
];

/** Applies the unified effect journal DDL inside the caller's write transaction. */
export function applyEffectJournalSchema(database: DatabaseSync): void {
  for (const statement of effectJournalSchemaSql) {
    database.exec(statement);
  }
}
