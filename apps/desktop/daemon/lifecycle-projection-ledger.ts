import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { executionIdentity } from "./execution-protocol.js";

export type LifecycleProjectionProvider = "codex" | "claude-code" | "cursor" | "open-model";
export type LifecycleCaptureAdmissionStatus = "pending" | "ready" | "unavailable";
export type LifecycleCaptureAdmissionDiagnostics = Record<LifecycleProjectionProvider, LifecycleCaptureAdmissionStatus>;
export type LifecycleProjectionPhase = "turn_active" | "turn_terminal";
export type LifecycleTypedProjectionState = "working" | "terminal";
export type LifecycleLegacyProjectionState = "working" | "idle" | "terminal" | "failed";
export type LifecycleProjectionState = LifecycleTypedProjectionState | LifecycleLegacyProjectionState;
export type LifecycleProjectionSide = "typed" | "legacy";
export type LifecycleProjectionClassification =
  | "incomplete"
  | "matched"
  | "divergent"
  | "missing_in_typed"
  | "missing_in_legacy"
  | "conflict";

export type LifecycleProjectionObservation = {
  agentId: string;
  provider: LifecycleProjectionProvider;
  workAttemptId: string;
  executionGenerationId: string;
  nativeEventId: string;
  phase: LifecycleProjectionPhase;
  state: LifecycleProjectionState;
};

export type LifecycleTypedProjectionObservation = Omit<LifecycleProjectionObservation, "state"> & {
  state: LifecycleTypedProjectionState;
};

export type LifecycleProjectionDiagnostics = {
  available: boolean;
  providers: Record<LifecycleProjectionProvider, {
    comparedSegments: number;
    matched: number;
    missingInTyped: number;
    missingInLegacy: number;
    pairedButDifferent: number;
    conflicts: number;
    observationUnavailable: number;
  }>;
};

export function unavailableLifecycleProjectionDiagnostics(): LifecycleProjectionDiagnostics {
  const empty = () => ({ comparedSegments: 0, matched: 0, missingInTyped: 0, missingInLegacy: 0,
    pairedButDifferent: 0, conflicts: 0, observationUnavailable: 0 });
  return { available: false, providers: { codex: empty(), "claude-code": empty(), cursor: empty(), "open-model": empty() } };
}

type Row = Record<string, string | number | null>;
const MAX_LANES = 1_024;
const MAX_OBSERVATIONS_PER_AGENT = 10_000;
const providers = ["codex", "claude-code", "cursor", "open-model"] as const;
const legacyProviders = ["codex", "claude-code", "cursor"] as const;
const schema = [
  `CREATE TABLE lifecycle_projection_lanes (
    lane_id TEXT PRIMARY KEY CHECK(length(lane_id)=48 AND lane_id GLOB 'lpl1:*'),
    agent_id TEXT NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 512),
    provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code','cursor','open-model')),
    work_attempt_id TEXT NOT NULL CHECK(length(work_attempt_id) BETWEEN 1 AND 512),
    execution_generation_id TEXT NOT NULL CHECK(length(execution_generation_id) BETWEEN 1 AND 512),
    typed_sequence INTEGER NOT NULL DEFAULT 0 CHECK(typed_sequence BETWEEN 0 AND 9007199254740991),
    legacy_sequence INTEGER NOT NULL DEFAULT 0 CHECK(legacy_sequence BETWEEN 0 AND 9007199254740991),
    compared_typed_sequence INTEGER NOT NULL DEFAULT 0 CHECK(compared_typed_sequence BETWEEN 0 AND typed_sequence),
    compared_legacy_sequence INTEGER NOT NULL DEFAULT 0 CHECK(compared_legacy_sequence BETWEEN 0 AND legacy_sequence),
    observation_count INTEGER NOT NULL DEFAULT 0 CHECK(observation_count BETWEEN 0 AND ${MAX_OBSERVATIONS_PER_AGENT}),
    retention_limited INTEGER NOT NULL DEFAULT 0 CHECK(retention_limited IN (0,1)),
    observation_unavailable INTEGER NOT NULL DEFAULT 0 CHECK(observation_unavailable IN (0,1)),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
    UNIQUE(agent_id,provider,work_attempt_id,execution_generation_id)
  ) STRICT`,
  `CREATE TABLE lifecycle_projection_pairs (
    lane_id TEXT NOT NULL REFERENCES lifecycle_projection_lanes(lane_id) ON DELETE RESTRICT,
    native_event_id TEXT NOT NULL CHECK(length(native_event_id) BETWEEN 1 AND 512),
    typed_sequence INTEGER CHECK(typed_sequence IS NULL OR typed_sequence BETWEEN 1 AND 9007199254740991),
    typed_phase TEXT CHECK(typed_phase IS NULL OR typed_phase IN ('turn_active','turn_terminal')),
    typed_state TEXT CHECK(typed_state IS NULL OR typed_state IN ('working','terminal')),
    legacy_sequence INTEGER CHECK(legacy_sequence IS NULL OR legacy_sequence BETWEEN 1 AND 9007199254740991),
    legacy_phase TEXT CHECK(legacy_phase IS NULL OR legacy_phase IN ('turn_active','turn_terminal')),
    legacy_state TEXT CHECK(legacy_state IS NULL OR legacy_state IN ('working','idle','terminal','failed')),
    classification TEXT NOT NULL DEFAULT 'incomplete' CHECK(classification IN
      ('incomplete','matched','divergent','missing_in_typed','missing_in_legacy','conflict')),
    conflict INTEGER NOT NULL DEFAULT 0 CHECK(conflict IN (0,1)),
    accounted INTEGER NOT NULL DEFAULT 0 CHECK(accounted IN (0,1)),
    recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(lane_id,native_event_id),
    CHECK((typed_sequence IS NULL)=(typed_phase IS NULL) AND (typed_sequence IS NULL)=(typed_state IS NULL)),
    CHECK(typed_sequence IS NULL OR (typed_phase='turn_active' AND typed_state='working')
      OR (typed_phase='turn_terminal' AND typed_state='terminal')),
    CHECK((legacy_sequence IS NULL)=(legacy_phase IS NULL) AND (legacy_sequence IS NULL)=(legacy_state IS NULL)),
    CHECK(typed_sequence IS NOT NULL OR legacy_sequence IS NOT NULL),
    CHECK((conflict=1)=(classification='conflict')),
    CHECK(accounted=1 OR classification IN ('incomplete','conflict')),
    CHECK(accounted=0 OR classification<>'incomplete')
  ) STRICT`,
  `CREATE UNIQUE INDEX lifecycle_projection_pairs_typed_sequence ON lifecycle_projection_pairs(lane_id,typed_sequence)
    WHERE typed_sequence IS NOT NULL`,
  `CREATE UNIQUE INDEX lifecycle_projection_pairs_legacy_sequence ON lifecycle_projection_pairs(lane_id,legacy_sequence)
    WHERE legacy_sequence IS NOT NULL`,
  `CREATE TABLE lifecycle_projection_totals (
    provider TEXT PRIMARY KEY CHECK(provider IN ('codex','claude-code','cursor','open-model')),
    compared_segments INTEGER NOT NULL DEFAULT 0 CHECK(compared_segments BETWEEN 0 AND 9007199254740991),
    matched INTEGER NOT NULL DEFAULT 0 CHECK(matched BETWEEN 0 AND 9007199254740991),
    missing_in_typed INTEGER NOT NULL DEFAULT 0 CHECK(missing_in_typed BETWEEN 0 AND 9007199254740991),
    missing_in_legacy INTEGER NOT NULL DEFAULT 0 CHECK(missing_in_legacy BETWEEN 0 AND 9007199254740991),
    paired_but_different INTEGER NOT NULL DEFAULT 0 CHECK(paired_but_different BETWEEN 0 AND 9007199254740991),
    conflicts INTEGER NOT NULL DEFAULT 0 CHECK(conflicts BETWEEN 0 AND 9007199254740991),
    observation_unavailable INTEGER NOT NULL DEFAULT 0 CHECK(observation_unavailable BETWEEN 0 AND 9007199254740991),
    first_observed_at_ms INTEGER CHECK(first_observed_at_ms IS NULL OR first_observed_at_ms BETWEEN 0 AND 9007199254740991),
    last_observed_at_ms INTEGER CHECK(last_observed_at_ms IS NULL OR last_observed_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK((first_observed_at_ms IS NULL)=(last_observed_at_ms IS NULL) AND
      (first_observed_at_ms IS NULL OR first_observed_at_ms<=last_observed_at_ms))
  ) STRICT`,
  `CREATE TRIGGER lifecycle_projection_lane_capacity BEFORE INSERT ON lifecycle_projection_lanes
    WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM lifecycle_projection_lanes LIMIT ${MAX_LANES}))>=${MAX_LANES}
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection lane capacity reached'); END`,
  `CREATE TRIGGER lifecycle_projection_pair_capacity BEFORE INSERT ON lifecycle_projection_pairs
    WHEN (SELECT COALESCE(SUM(observation_count),0) FROM lifecycle_projection_lanes
      WHERE agent_id=(SELECT agent_id FROM lifecycle_projection_lanes WHERE lane_id=NEW.lane_id))>=${MAX_OBSERVATIONS_PER_AGENT}
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection observation capacity reached'); END`,
  `CREATE TRIGGER lifecycle_projection_lane_immutable BEFORE UPDATE ON lifecycle_projection_lanes
    WHEN NEW.lane_id IS NOT OLD.lane_id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.provider IS NOT OLD.provider
      OR NEW.work_attempt_id IS NOT OLD.work_attempt_id OR NEW.execution_generation_id IS NOT OLD.execution_generation_id
      OR NEW.typed_sequence<OLD.typed_sequence OR NEW.legacy_sequence<OLD.legacy_sequence
      OR NEW.compared_typed_sequence<OLD.compared_typed_sequence OR NEW.compared_legacy_sequence<OLD.compared_legacy_sequence
      OR NEW.observation_count<OLD.observation_count
      OR NEW.retention_limited<OLD.retention_limited OR NEW.observation_unavailable<OLD.observation_unavailable
      OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.updated_at_ms<OLD.updated_at_ms
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection lane evidence is immutable'); END`,
  `CREATE TRIGGER lifecycle_projection_pair_immutable BEFORE UPDATE ON lifecycle_projection_pairs
    WHEN NEW.lane_id IS NOT OLD.lane_id OR NEW.native_event_id IS NOT OLD.native_event_id
      OR (OLD.typed_sequence IS NOT NULL AND (NEW.typed_sequence IS NOT OLD.typed_sequence OR NEW.typed_phase IS NOT OLD.typed_phase OR NEW.typed_state IS NOT OLD.typed_state))
      OR (OLD.legacy_sequence IS NOT NULL AND (NEW.legacy_sequence IS NOT OLD.legacy_sequence OR NEW.legacy_phase IS NOT OLD.legacy_phase OR NEW.legacy_state IS NOT OLD.legacy_state))
      OR NEW.conflict<OLD.conflict OR NEW.accounted<OLD.accounted OR NEW.recorded_at_ms IS NOT OLD.recorded_at_ms
      OR (OLD.classification<>'incomplete' AND NEW.classification IS NOT OLD.classification AND NEW.classification<>'conflict')
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection witness is immutable'); END`,
  `CREATE TRIGGER lifecycle_projection_total_monotonic BEFORE UPDATE ON lifecycle_projection_totals
    WHEN NEW.provider IS NOT OLD.provider OR NEW.compared_segments<OLD.compared_segments OR NEW.matched<OLD.matched
      OR NEW.missing_in_typed<OLD.missing_in_typed OR NEW.missing_in_legacy<OLD.missing_in_legacy
      OR NEW.paired_but_different<OLD.paired_but_different OR NEW.conflicts<OLD.conflicts
      OR NEW.observation_unavailable<OLD.observation_unavailable
      OR (OLD.first_observed_at_ms IS NOT NULL AND NEW.first_observed_at_ms IS NOT OLD.first_observed_at_ms)
      OR (OLD.first_observed_at_ms IS NULL AND NEW.first_observed_at_ms IS NULL AND NEW.last_observed_at_ms IS NOT NULL)
      OR NEW.last_observed_at_ms<OLD.last_observed_at_ms
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection totals cannot move backward'); END`,
  `CREATE TRIGGER lifecycle_projection_lane_no_delete BEFORE DELETE ON lifecycle_projection_lanes
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection lanes cannot be deleted'); END`,
  `CREATE TRIGGER lifecycle_projection_pair_no_delete BEFORE DELETE ON lifecycle_projection_pairs
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection witnesses cannot be deleted'); END`,
  `CREATE TRIGGER lifecycle_projection_total_no_delete BEFORE DELETE ON lifecycle_projection_totals
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection totals cannot be deleted'); END`,
];
const legacySchema = schema.map((definition) => definition.replaceAll(",'open-model'", ""));

function normalizedSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map(part => part.startsWith("'") ? part
    : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}
function invalid(): never { throw new Error("Lifecycle projection evidence is invalid."); }
function identity(value: unknown): string {
  const parsed = executionIdentity.safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data;
}
function validateObservation(side: LifecycleProjectionSide,
  value: LifecycleProjectionObservation): LifecycleProjectionObservation {
  if (!value || typeof value !== "object" || !providers.includes(value.provider)
    || !["turn_active", "turn_terminal"].includes(value.phase)
    || !(side === "typed"
      ? (value.phase === "turn_active" && value.state === "working")
        || (value.phase === "turn_terminal" && value.state === "terminal")
      : ["working", "idle", "terminal", "failed"].includes(value.state))) invalid();
  return { ...value, agentId: identity(value.agentId), workAttemptId: identity(value.workAttemptId),
    executionGenerationId: identity(value.executionGenerationId), nativeEventId: identity(value.nativeEventId) };
}
function laneId(value: LifecycleProjectionObservation): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "lifecycle-projection-lane-v1", value.agentId, value.provider, value.workAttemptId, value.executionGenerationId,
  ])).digest("base64url");
  return `lpl1:${digest}`;
}
function rowNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) invalid();
  return number;
}

export function applyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='lifecycle_projection_lanes'").get()) {
    for (const definition of schema) database.exec(definition);
    for (const provider of providers) database.prepare("INSERT INTO lifecycle_projection_totals(provider) VALUES(?)").run(provider);
  }
  validateLifecycleProjectionLedgerSchema(database);
}

export function validateLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  validateLifecycleProjectionLedger(database, schema, providers);
}

/** Validate the exact three-provider ledger shipped before Open Model shadow capture. */
export function validateLegacyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  validateLifecycleProjectionLedger(database, legacySchema, legacyProviders);
}

/**
 * Comparator evidence is rollout telemetry, not user work. A provider-set
 * change starts a fresh evidence epoch instead of translating incomparable
 * soak counters. The caller owns the schema-migration transaction.
 */
export function resetLegacyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Lifecycle projection reset requires the schema migration transaction.");
  validateLegacyLifecycleProjectionLedgerSchema(database);
  database.exec(`DROP TABLE lifecycle_projection_pairs;
    DROP TABLE lifecycle_projection_lanes;
    DROP TABLE lifecycle_projection_totals;`);
  applyLifecycleProjectionLedgerSchema(database);
}

function validateLifecycleProjectionLedger(
  database: DatabaseSync,
  expectedSchema: readonly string[],
  expectedProviders: readonly string[],
): void {
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name GLOB 'lifecycle_projection_*' AND sql IS NOT NULL")
    .all().map(row => normalizedSql(String(row.sql))).sort();
  const expected = expectedSchema.map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Lifecycle projection ledger has invalid or missing schema.");
  }
  const totals = database.prepare("SELECT * FROM lifecycle_projection_totals ORDER BY provider").all() as Row[];
  if (totals.length !== expectedProviders.length
    || totals.some((row, index) => row.provider !== [...expectedProviders].sort()[index])) invalid();
  if (database.prepare("PRAGMA foreign_key_check(lifecycle_projection_pairs)").get()) invalid();
  const integrity = database.prepare("PRAGMA integrity_check(lifecycle_projection_pairs)").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") invalid();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_lanes WHERE
      typed_sequence<compared_typed_sequence OR legacy_sequence<compared_legacy_sequence
      OR typed_sequence<>COALESCE((SELECT MAX(typed_sequence) FROM lifecycle_projection_pairs p
        WHERE p.lane_id=lifecycle_projection_lanes.lane_id),0)
      OR legacy_sequence<>COALESCE((SELECT MAX(legacy_sequence) FROM lifecycle_projection_pairs p
        WHERE p.lane_id=lifecycle_projection_lanes.lane_id),0)
      OR observation_count<>(SELECT COUNT(*) FROM lifecycle_projection_pairs p WHERE p.lane_id=lifecycle_projection_lanes.lane_id)
      LIMIT 1`).get()) invalid();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_pairs WHERE
      (typed_sequence IS NULL)!=(typed_phase IS NULL) OR (typed_sequence IS NULL)!=(typed_state IS NULL)
      OR (typed_sequence IS NOT NULL AND NOT ((typed_phase='turn_active' AND typed_state='working')
        OR (typed_phase='turn_terminal' AND typed_state='terminal')))
      OR (legacy_sequence IS NULL)!=(legacy_phase IS NULL) OR (legacy_sequence IS NULL)!=(legacy_state IS NULL)
      OR (typed_sequence IS NULL AND legacy_sequence IS NULL)
      OR (conflict=1)!=(classification='conflict')
      OR (accounted=0 AND classification NOT IN ('incomplete','conflict'))
      OR (accounted=1 AND classification='incomplete') LIMIT 1`).get()) invalid();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_pairs p JOIN lifecycle_projection_lanes l USING(lane_id)
      WHERE p.accounted=1 AND ((p.typed_sequence IS NOT NULL AND p.typed_sequence>l.compared_typed_sequence)
        OR (p.legacy_sequence IS NOT NULL AND p.legacy_sequence>l.compared_legacy_sequence)) LIMIT 1`).get()) invalid();
  const laneCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM lifecycle_projection_lanes LIMIT ${MAX_LANES + 1})`).get()!.count);
  if (laneCount > MAX_LANES) invalid();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_lanes l GROUP BY agent_id
    HAVING SUM(observation_count)>${MAX_OBSERVATIONS_PER_AGENT} LIMIT 1`).get()) invalid();
}

/** Durable comparison evidence only. This store owns no lifecycle authority. */
export class LifecycleProjectionLedger {
  constructor(private readonly database: DatabaseSync, private readonly nowMs: () => number = Date.now) {}

  recordTypedInCurrentTransaction(value: LifecycleTypedProjectionObservation): void {
    if (!this.database.isTransaction) throw new Error("Typed lifecycle projection requires the execution-fact transaction.");
    this.record("typed", validateObservation("typed", value));
  }

  recordLegacy(value: LifecycleProjectionObservation): void {
    if (this.database.isTransaction) throw new Error("Legacy lifecycle projection requires its own transaction.");
    this.database.exec("BEGIN IMMEDIATE");
    try { this.record("legacy", validateObservation("legacy", value)); this.database.exec("COMMIT"); }
    catch (error) { try { this.database.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
  }

  recordUnavailable(provider: LifecycleProjectionProvider, count = 1): void {
    if (!providers.includes(provider) || !Number.isSafeInteger(count) || count < 1) invalid();
    if (this.database.isTransaction) throw new Error("Lifecycle projection unavailability requires its own transaction.");
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) invalid();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.touchTotals(provider, now);
      this.unavailable(provider, count);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  diagnostics(): LifecycleProjectionDiagnostics {
    const rows = this.database.prepare("SELECT * FROM lifecycle_projection_totals ORDER BY provider").all() as Row[];
    const result = unavailableLifecycleProjectionDiagnostics();
    result.available = true;
    for (const row of rows) result.providers[row.provider as LifecycleProjectionProvider] = {
      comparedSegments: rowNumber(row.compared_segments), matched: rowNumber(row.matched),
      missingInTyped: rowNumber(row.missing_in_typed), missingInLegacy: rowNumber(row.missing_in_legacy),
      pairedButDifferent: rowNumber(row.paired_but_different), conflicts: rowNumber(row.conflicts),
      observationUnavailable: rowNumber(row.observation_unavailable),
    };
    return result;
  }

  private record(side: LifecycleProjectionSide, value: LifecycleProjectionObservation): void {
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) invalid();
    const lane = laneId(value);
    this.touchTotals(value.provider, now);
    let laneRow = this.database.prepare("SELECT * FROM lifecycle_projection_lanes WHERE lane_id=?").get(lane) as Row | undefined;
    let agentObservationCount: number | undefined;
    if (!laneRow) {
      agentObservationCount = Number(this.database.prepare(`SELECT COALESCE(SUM(observation_count),0) AS count
        FROM lifecycle_projection_lanes WHERE agent_id=?`).get(value.agentId)!.count);
      if (agentObservationCount >= MAX_OBSERVATIONS_PER_AGENT) {
        this.unavailable(value.provider);
        return;
      }
      const laneCount = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM lifecycle_projection_lanes LIMIT ${MAX_LANES})`).get()!.count);
      if (laneCount >= MAX_LANES) { this.unavailable(value.provider); return; }
      this.database.prepare(`INSERT INTO lifecycle_projection_lanes
        (lane_id,agent_id,provider,work_attempt_id,execution_generation_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)`)
        .run(lane, value.agentId, value.provider, value.workAttemptId, value.executionGenerationId, now, now);
      laneRow = this.database.prepare("SELECT * FROM lifecycle_projection_lanes WHERE lane_id=?").get(lane) as Row;
    } else if (laneRow.agent_id !== value.agentId || laneRow.provider !== value.provider
      || laneRow.work_attempt_id !== value.workAttemptId || laneRow.execution_generation_id !== value.executionGenerationId) invalid();
    const existing = this.database.prepare("SELECT * FROM lifecycle_projection_pairs WHERE lane_id=? AND native_event_id=?")
      .get(lane, value.nativeEventId) as Row | undefined;
    // Once retention is capped, preserve the ability to complete or detect a
    // conflict on an already-retained witness. Only new evidence is refused.
    if (Number(laneRow.retention_limited) === 1 && !existing) return;
    const sequenceColumn = `${side}_sequence`; const phaseColumn = `${side}_phase`; const stateColumn = `${side}_state`;
    if (existing?.[sequenceColumn] !== null && existing?.[sequenceColumn] !== undefined) {
      if (existing[phaseColumn] !== value.phase || existing[stateColumn] !== value.state) {
        this.markConflict(lane, value.provider, value.nativeEventId);
      }
      this.reconcileTerminal(lane, value.provider, value.nativeEventId, value.phase, now);
      return;
    }

    // A window-closing terminal made absence durable evidence. A late opposite
    // witness is an ordering conflict, never permission to rewrite that fact.
    if (existing && Number(existing.accounted) === 1) {
      this.markConflict(lane, value.provider, value.nativeEventId);
      return;
    }

    const count = agentObservationCount ?? Number(this.database.prepare(`SELECT COALESCE(SUM(observation_count),0) AS count
      FROM lifecycle_projection_lanes WHERE agent_id=?`).get(value.agentId)!.count);
    if (!existing && count >= MAX_OBSERVATIONS_PER_AGENT) {
      this.database.prepare(`UPDATE lifecycle_projection_lanes SET retention_limited=1,observation_unavailable=1,
        updated_at_ms=MAX(updated_at_ms,?) WHERE lane_id=?`)
        .run(now, lane);
      this.unavailable(value.provider);
      return;
    }
    const next = rowNumber(laneRow[sequenceColumn]) + 1;
    if (next > Number.MAX_SAFE_INTEGER) { this.unavailable(value.provider); return; }
    this.database.prepare(`UPDATE lifecycle_projection_lanes SET ${sequenceColumn}=?,updated_at_ms=MAX(updated_at_ms,?) WHERE lane_id=?`)
      .run(next, now, lane);
    if (!existing) {
      this.database.prepare(`INSERT INTO lifecycle_projection_pairs
        (lane_id,native_event_id,${sequenceColumn},${phaseColumn},${stateColumn},recorded_at_ms) VALUES(?,?,?,?,?,?)`)
        .run(lane, value.nativeEventId, next, value.phase, value.state, now);
      this.database.prepare("UPDATE lifecycle_projection_lanes SET observation_count=observation_count+1 WHERE lane_id=?").run(lane);
    } else {
      this.database.prepare(`UPDATE lifecycle_projection_pairs SET ${sequenceColumn}=?,${phaseColumn}=?,${stateColumn}=?
        WHERE lane_id=? AND native_event_id=?`).run(next, value.phase, value.state, lane, value.nativeEventId);
      const oppositePhase = side === "typed" ? existing.legacy_phase : existing.typed_phase;
      if (oppositePhase !== value.phase) this.markConflict(lane, value.provider, value.nativeEventId);
    }
    this.reconcileTerminal(lane, value.provider, value.nativeEventId, value.phase, now);
  }

  private touchTotals(provider: LifecycleProjectionProvider, now: number): void {
    this.database.prepare(`INSERT INTO lifecycle_projection_totals(provider,first_observed_at_ms,last_observed_at_ms)
      VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET
      first_observed_at_ms=COALESCE(first_observed_at_ms,excluded.first_observed_at_ms),
      last_observed_at_ms=MAX(COALESCE(last_observed_at_ms,excluded.last_observed_at_ms),excluded.last_observed_at_ms)`)
      .run(provider, now, now);
  }

  private markConflict(lane: string, provider: LifecycleProjectionProvider, nativeEventId: string): void {
    const changed = this.database.prepare(`UPDATE lifecycle_projection_pairs SET conflict=1,classification='conflict'
      WHERE lane_id=? AND native_event_id=? AND conflict=0`).run(lane, nativeEventId).changes;
    if (Number(changed) === 1) {
      this.database.prepare("UPDATE lifecycle_projection_totals SET conflicts=conflicts+1 WHERE provider=?").run(provider);
    }
  }

  private reconcileTerminal(lane: string, provider: LifecycleProjectionProvider, terminalId: string,
    phase: LifecycleProjectionPhase, now: number): void {
    if (phase !== "turn_terminal") return;
    const terminal = this.database.prepare("SELECT * FROM lifecycle_projection_pairs WHERE lane_id=? AND native_event_id=?")
      .get(lane, terminalId) as Row | undefined;
    if (!terminal || terminal.typed_phase !== "turn_terminal" || terminal.legacy_phase !== "turn_terminal") return;
    const laneRow = this.database.prepare("SELECT * FROM lifecycle_projection_lanes WHERE lane_id=?").get(lane) as Row;
    const typedTerminal = rowNumber(terminal.typed_sequence); const legacyTerminal = rowNumber(terminal.legacy_sequence);
    const typedCursor = rowNumber(laneRow.compared_typed_sequence); const legacyCursor = rowNumber(laneRow.compared_legacy_sequence);
    if (typedTerminal <= typedCursor && legacyTerminal <= legacyCursor) return;
    if (typedTerminal <= typedCursor || legacyTerminal <= legacyCursor) {
      this.database.prepare(`UPDATE lifecycle_projection_lanes SET observation_unavailable=1,
        updated_at_ms=MAX(updated_at_ms,?) WHERE lane_id=?`).run(now, lane);
      this.unavailable(provider); return;
    }
    const rows = this.database.prepare(`SELECT * FROM lifecycle_projection_pairs WHERE lane_id=? AND accounted=0 AND
      ((typed_sequence>? AND typed_sequence<=?) OR (legacy_sequence>? AND legacy_sequence<=?))
      ORDER BY COALESCE(typed_sequence,legacy_sequence),native_event_id`).all(lane, typedCursor, typedTerminal, legacyCursor, legacyTerminal) as Row[];
    const increments = { matched: 0, missing_in_typed: 0, missing_in_legacy: 0, paired_but_different: 0 };
    for (const row of rows) {
      const typedSequence = row.typed_sequence === null ? null : rowNumber(row.typed_sequence);
      const legacySequence = row.legacy_sequence === null ? null : rowNumber(row.legacy_sequence);
      if (typedSequence !== null && legacySequence !== null
        && (typedSequence > typedTerminal || legacySequence > legacyTerminal)) {
        this.markConflict(lane, provider, String(row.native_event_id));
        continue;
      }
      const classification: LifecycleProjectionClassification = Number(row.conflict) === 1 ? "conflict"
        : row.typed_sequence === null ? "missing_in_typed"
          : row.legacy_sequence === null ? "missing_in_legacy"
            : row.typed_phase === row.legacy_phase && row.typed_state === row.legacy_state ? "matched" : "divergent";
      this.database.prepare("UPDATE lifecycle_projection_pairs SET classification=?,accounted=1 WHERE lane_id=? AND native_event_id=?")
        .run(classification, lane, row.native_event_id);
      if (classification === "matched") increments.matched++;
      else if (classification === "missing_in_typed") increments.missing_in_typed++;
      else if (classification === "missing_in_legacy") increments.missing_in_legacy++;
      else if (classification === "divergent") increments.paired_but_different++;
      // Conflicts were counted at first observation and remain gate failures.
    }
    this.database.prepare(`UPDATE lifecycle_projection_totals SET compared_segments=compared_segments+1,
      matched=matched+?,missing_in_typed=missing_in_typed+?,missing_in_legacy=missing_in_legacy+?,
      paired_but_different=paired_but_different+? WHERE provider=?`)
      .run(increments.matched, increments.missing_in_typed, increments.missing_in_legacy, increments.paired_but_different, provider);
    this.database.prepare(`UPDATE lifecycle_projection_lanes SET compared_typed_sequence=?,compared_legacy_sequence=?,
      updated_at_ms=MAX(updated_at_ms,?) WHERE lane_id=?`)
      .run(typedTerminal, legacyTerminal, now, lane);
  }

  private unavailable(provider: LifecycleProjectionProvider, count = 1): void {
    this.database.prepare("UPDATE lifecycle_projection_totals SET observation_unavailable=observation_unavailable+? WHERE provider=?")
      .run(count, provider);
  }
}
