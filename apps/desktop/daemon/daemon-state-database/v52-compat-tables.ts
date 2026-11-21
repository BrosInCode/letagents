/**
 * Inert v52 SQLite compatibility DDL and schema validation for tables whose
 * runtime paths were retired in Step 1a (custodial polling activation/offers
 * and the lifecycle projection ledger).
 *
 * Kept inside daemon-state-database/ only while DAEMON_STATE_SCHEMA_VERSION
 * remains 52 so a database created by this build retains the full 82-table v52
 * shape and can still be opened by an older v52 daemon (downgrade or a dev
 * build sharing ~/.letagents). Deleted with the rest of v52 in Step 1b.
 */
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, string | number | null>;

const POLLING_ACTIVATION_TABLE = "custodial_polling_activations";
const POLLING_ACTIVATION_IDENTITY = [
  "operation_id", "request_id", "agent_id", "room_id", "work_attempt_id", "execution_generation_id", "reverse_operation_id",
  "native_continuation_id", "native_connection_kind", "native_connection_sha256", "native_pid", "native_process_identity",
  "config_revision", "agent_session_id", "room_cursor", "created_at_ms",
];
const POLLING_COMPACTION_COLUMN = "compacted_through_offer_id TEXT CHECK(compacted_through_offer_id IS NULL OR length(trim(compacted_through_offer_id))>0)";
const POLLING_OFFER_TABLE = "custodial_polling_offers";
const POLLING_OFFER_IDENTITY = [
  "offer_id", "activation_id", "process_incarnation_id", "mcp_request_id",
  "binding_epoch", "input_cursor", "offered_frontier", "predecessor_offer_id", "created_at_ms",
];
const POLLING_OFFER_REPLAY_WINDOW = 256;

const LEDGER_MAX_LANES = 1_024;
const LEDGER_MAX_OBSERVATIONS_PER_AGENT = 10_000;
const LEDGER_PROVIDERS = ["codex", "claude-code", "cursor", "open-model"] as const;
const LEGACY_LEDGER_PROVIDERS = ["codex", "claude-code", "cursor"] as const;

function normalizedSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map(part => part.startsWith("'") ? part
    : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}

function requireForeignKeys(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Polling authority requires foreign key enforcement.");
  }
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Polling activation requires an ownership-fenced transaction.");
  requireForeignKeys(database);
}

function activationSchema(version: 24 | 26 = 26): string[] {
  return [
    `CREATE TABLE ${POLLING_ACTIVATION_TABLE} (
    operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id))>0),
    request_id TEXT NOT NULL UNIQUE CHECK(length(trim(request_id))>0),
    agent_id TEXT NOT NULL CHECK(length(trim(agent_id))>0), room_id TEXT NOT NULL CHECK(length(trim(room_id))>0),
    work_attempt_id TEXT NOT NULL CHECK(length(trim(work_attempt_id))>0),
    execution_generation_id TEXT NOT NULL CHECK(length(trim(execution_generation_id))>0),
    reverse_operation_id TEXT NOT NULL CHECK(length(trim(reverse_operation_id))>0),
    native_continuation_id TEXT NOT NULL CHECK(length(trim(native_continuation_id))>0),
    native_connection_kind TEXT NOT NULL CHECK(native_connection_kind='codex_app_server'),
    native_connection_sha256 TEXT NOT NULL CHECK(length(native_connection_sha256)=64 AND native_connection_sha256 NOT GLOB '*[^0-9a-f]*'),
    native_pid INTEGER NOT NULL CHECK(native_pid>0), native_process_identity TEXT NOT NULL CHECK(length(trim(native_process_identity))>0),
    config_revision INTEGER NOT NULL CHECK(config_revision>0), agent_session_id TEXT NOT NULL CHECK(length(trim(agent_session_id))>0),
    room_cursor TEXT NOT NULL CHECK((length(room_cursor)>0 AND room_cursor NOT GLOB '*[^0-9]*')
      OR (substr(room_cursor,1,4)='msg_' AND length(room_cursor)>4 AND substr(room_cursor,5) NOT GLOB '*[^0-9]*')),
    phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatching','active','uncertain','complete','cancelled')),
    provider_turn_id TEXT CHECK(provider_turn_id IS NULL OR length(trim(provider_turn_id))>0),
    terminal_outcome TEXT CHECK(terminal_outcome IN ('completed','failed','interrupted','lost')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),${version === 26 ? `${POLLING_COMPACTION_COLUMN},` : ""}
    CHECK((phase='complete')=(terminal_outcome IS NOT NULL)),
    CHECK(phase NOT IN ('prepared','dispatching','cancelled') OR provider_turn_id IS NULL),
    CHECK(phase<>'active' OR provider_turn_id IS NOT NULL),
    CHECK(phase<>'complete' OR terminal_outcome='lost' OR provider_turn_id IS NOT NULL)
  ) STRICT`,
    `CREATE UNIQUE INDEX custodial_polling_activation_one_unresolved ON ${POLLING_ACTIVATION_TABLE}(agent_id) WHERE phase NOT IN ('complete','cancelled')`,
    `CREATE UNIQUE INDEX custodial_polling_activation_native_turn ON ${POLLING_ACTIVATION_TABLE}(agent_id,execution_generation_id,native_continuation_id,provider_turn_id) WHERE provider_turn_id IS NOT NULL`,
    `CREATE TRIGGER custodial_polling_activation_predecessor BEFORE INSERT ON ${POLLING_ACTIVATION_TABLE}
    WHEN NEW.phase<>'prepared' ${version === 26 ? "OR NEW.compacted_through_offer_id IS NOT NULL" : ""} OR NOT EXISTS (SELECT 1 FROM execution_cutover_v2 WHERE operation_id=NEW.reverse_operation_id
      AND agent_id=NEW.agent_id AND room_id=NEW.room_id AND work_attempt_id=NEW.work_attempt_id
      AND authority_version=1 AND provider='codex' AND from_mode='daemon_inbox' AND to_mode='mcp_polling'
      AND strategy='drain' AND phase='complete' AND execution_generation_id<>NEW.execution_generation_id)
    BEGIN SELECT RAISE(ABORT,'Polling activation requires its completed reverse predecessor'); END`,
    `CREATE TRIGGER custodial_polling_activation_identity_immutable BEFORE UPDATE ON ${POLLING_ACTIVATION_TABLE}
    WHEN ${POLLING_ACTIVATION_IDENTITY.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
    BEGIN SELECT RAISE(ABORT,'Polling activation identity is immutable'); END`,
    `CREATE TRIGGER custodial_polling_activation_phase BEFORE UPDATE ON ${POLLING_ACTIVATION_TABLE}
    WHEN (NEW.provider_turn_id IS NOT OLD.provider_turn_id AND NOT
      (OLD.provider_turn_id IS NULL AND NEW.provider_turn_id IS NOT NULL AND OLD.phase IN ('dispatching','uncertain') AND NEW.phase='active'))
      OR (NEW.phase<>OLD.phase AND NOT
        ((OLD.phase='prepared' AND NEW.phase IN ('dispatching','cancelled'))
          OR (OLD.phase='dispatching' AND NEW.phase IN ('active','uncertain','complete'))
          OR (OLD.phase='active' AND NEW.phase IN ('uncertain','complete'))
          OR (OLD.phase='uncertain' AND NEW.phase IN ('active','complete'))))
      OR (OLD.phase IN ('complete','cancelled') AND (NEW.terminal_outcome IS NOT OLD.terminal_outcome OR NEW.updated_at_ms<>OLD.updated_at_ms))
    BEGIN SELECT RAISE(ABORT,'Polling activation transition is invalid'); END`,
    ...(version === 26 ? [`CREATE TRIGGER custodial_polling_compaction_forward BEFORE UPDATE OF compacted_through_offer_id ON ${POLLING_ACTIVATION_TABLE}
    WHEN NEW.compacted_through_offer_id IS NOT OLD.compacted_through_offer_id AND
      (NEW.compacted_through_offer_id IS NULL
        OR EXISTS (SELECT 1 FROM custodial_polling_offers WHERE offer_id=NEW.compacted_through_offer_id)
        OR NOT EXISTS (SELECT 1 FROM custodial_polling_offers WHERE predecessor_offer_id=NEW.compacted_through_offer_id AND activation_id=OLD.operation_id)
        OR EXISTS (SELECT 1 FROM custodial_polling_offers WHERE activation_id=OLD.operation_id AND predecessor_offer_id IS NULL))
    BEGIN SELECT RAISE(ABORT,'Polling offer compaction requires the exact deletion cascade'); END`] : []),
  ];
}

function offerSchema(version: 25 | 26 = 26): string[] {
  return [
    `CREATE TABLE ${POLLING_OFFER_TABLE} (
    offer_id TEXT PRIMARY KEY CHECK(length(trim(offer_id))>0),
    activation_id TEXT NOT NULL REFERENCES custodial_polling_activations(operation_id) ON DELETE RESTRICT,
    process_incarnation_id TEXT NOT NULL CHECK(length(process_incarnation_id)=36),
    mcp_request_id TEXT NOT NULL CHECK(json_valid(mcp_request_id) AND json_type(mcp_request_id) IN ('text','integer')),
    binding_epoch INTEGER NOT NULL CHECK(binding_epoch>=1),
    input_cursor TEXT NOT NULL CHECK((length(input_cursor)>0 AND input_cursor NOT GLOB '*[^0-9]*')
      OR (substr(input_cursor,1,4)='msg_' AND length(input_cursor)>4 AND substr(input_cursor,5) NOT GLOB '*[^0-9]*')),
    offered_frontier TEXT NOT NULL CHECK((length(offered_frontier)>0 AND offered_frontier NOT GLOB '*[^0-9]*')
      OR (substr(offered_frontier,1,4)='msg_' AND length(offered_frontier)>4 AND substr(offered_frontier,5) NOT GLOB '*[^0-9]*')),
    predecessor_offer_id TEXT UNIQUE,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
    acknowledged_at_ms INTEGER CHECK(acknowledged_at_ms>=created_at_ms),
    UNIQUE(activation_id,process_incarnation_id,mcp_request_id), UNIQUE(offer_id,activation_id),
    ${version === 25
      ? `FOREIGN KEY(predecessor_offer_id,activation_id) REFERENCES ${POLLING_OFFER_TABLE}(offer_id,activation_id) ON DELETE RESTRICT`
      : `FOREIGN KEY(predecessor_offer_id) REFERENCES ${POLLING_OFFER_TABLE}(offer_id) ON DELETE SET NULL`}
  ) STRICT`,
    `CREATE UNIQUE INDEX custodial_polling_offer_one_root ON ${POLLING_OFFER_TABLE}(activation_id) WHERE predecessor_offer_id IS NULL`,
    `CREATE TRIGGER custodial_polling_offer_append BEFORE INSERT ON ${POLLING_OFFER_TABLE}
    WHEN NEW.acknowledged_at_ms IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM custodial_polling_activations WHERE operation_id=NEW.activation_id AND phase='active')
      OR (NEW.predecessor_offer_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM ${POLLING_OFFER_TABLE} p WHERE p.offer_id=NEW.predecessor_offer_id AND p.activation_id=NEW.activation_id
          AND p.created_at_ms<=NEW.created_at_ms))
    BEGIN SELECT RAISE(ABORT,'Polling offers must append to the active chain tail'); END`,
    `CREATE TRIGGER custodial_polling_offer_immutable BEFORE UPDATE ON ${POLLING_OFFER_TABLE}
    ${version === 25 ? "WHEN" : "BEGIN SELECT CASE WHEN"} ${POLLING_OFFER_IDENTITY.filter(column => version === 25 || column !== "predecessor_offer_id").map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
      OR (NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms AND
        (OLD.acknowledged_at_ms IS NOT NULL OR NEW.acknowledged_at_ms IS NULL
          OR EXISTS (SELECT 1 FROM ${POLLING_OFFER_TABLE} s WHERE s.predecessor_offer_id=OLD.offer_id)))
    ${version === 25 ? "BEGIN SELECT RAISE(ABORT,'Polling offer identity and interior acknowledgements are immutable');" : `
      THEN RAISE(ABORT,'Polling offer identity and interior acknowledgements are immutable') END;
      UPDATE ${POLLING_ACTIVATION_TABLE} SET compacted_through_offer_id=OLD.predecessor_offer_id
        WHERE operation_id=OLD.activation_id AND NEW.predecessor_offer_id IS NULL AND OLD.predecessor_offer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${POLLING_OFFER_TABLE} WHERE offer_id=OLD.predecessor_offer_id);
      SELECT CASE WHEN NEW.predecessor_offer_id IS NOT OLD.predecessor_offer_id AND NOT
        (NEW.predecessor_offer_id IS NULL AND OLD.predecessor_offer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${POLLING_OFFER_TABLE} p WHERE p.offer_id=OLD.predecessor_offer_id)
          AND EXISTS (SELECT 1 FROM ${POLLING_ACTIVATION_TABLE} a WHERE a.operation_id=OLD.activation_id
            AND a.compacted_through_offer_id=OLD.predecessor_offer_id))
        THEN RAISE(ABORT,'Polling offer predecessor is immutable outside compaction') END;
    `} END`,
    `CREATE TRIGGER custodial_polling_offer_no_delete BEFORE DELETE ON ${POLLING_OFFER_TABLE}
    BEGIN ${version === 25 ? "SELECT RAISE(ABORT,'Polling offer history cannot be removed');" : `
      SELECT CASE WHEN OLD.predecessor_offer_id IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM ${POLLING_OFFER_TABLE} s WHERE s.predecessor_offer_id=OLD.offer_id AND s.activation_id=OLD.activation_id)
        OR (SELECT COUNT(*) FROM ${POLLING_OFFER_TABLE} WHERE activation_id=OLD.activation_id)<=${POLLING_OFFER_REPLAY_WINDOW}
        THEN RAISE(ABORT,'Polling offer tail or retained history cannot be removed') END;
    `} END`,
  ];
}

export function applyPollingActivationSchema(database: DatabaseSync, version: 24 | 26 = 26): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(POLLING_ACTIVATION_TABLE)) {
    for (const definition of activationSchema(version)) database.exec(definition);
  }
  validatePollingActivationSchema(database, version);
}

export function validatePollingActivationSchema(database: DatabaseSync, version: 24 | 26 = 26): void {
  if (version === 26) requireForeignKeys(database);
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY type,name").all(POLLING_ACTIVATION_TABLE)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = activationSchema(version).map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Polling activation journal has invalid or missing schema.");
  }
  const integrity = database.prepare(`PRAGMA integrity_check(${POLLING_ACTIVATION_TABLE})`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Polling activation journal contains invalid authority.");
  }
}

export function applyPollingOfferSchema(database: DatabaseSync, version: 25 | 26 = 26): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(POLLING_OFFER_TABLE)) {
    for (const definition of offerSchema(version)) database.exec(definition);
  }
  validatePollingOfferSchema(database, version);
}

export function validatePollingOfferSchema(database: DatabaseSync, version: 25 | 26 = 26): void {
  if (version === 26) requireForeignKeys(database);
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL").all(POLLING_OFFER_TABLE)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = offerSchema(version).map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Polling offer journal has invalid or missing schema.");
  }
  const integrity = database.prepare(`PRAGMA integrity_check(${POLLING_OFFER_TABLE})`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || database.prepare(`PRAGMA foreign_key_check(${POLLING_OFFER_TABLE})`).get()) {
    throw new Error("Polling offer journal contains invalid authority.");
  }
}

export function migratePollingOffersV25ToV26(database: DatabaseSync): void {
  requireTransaction(database);
  validatePollingActivationSchema(database, 24);
  validatePollingOfferSchema(database, 25);
  database.exec(`ALTER TABLE ${POLLING_ACTIVATION_TABLE} ADD COLUMN ${POLLING_COMPACTION_COLUMN}`);
  database.exec("DROP TRIGGER custodial_polling_activation_predecessor");
  database.exec(activationSchema().find(definition => definition.startsWith("CREATE TRIGGER custodial_polling_activation_predecessor "))!);
  database.exec(activationSchema().at(-1)!);
  database.exec(`PRAGMA defer_foreign_keys=ON;
    CREATE TEMP TABLE polling_offer_migration AS SELECT rowid AS saved_rowid,* FROM ${POLLING_OFFER_TABLE};
    DROP TABLE ${POLLING_OFFER_TABLE}`);
  database.exec(offerSchema()[0]!);
  database.exec(`INSERT INTO ${POLLING_OFFER_TABLE}(rowid,${[...POLLING_OFFER_IDENTITY, "acknowledged_at_ms"].join(",")})
    SELECT saved_rowid,${[...POLLING_OFFER_IDENTITY, "acknowledged_at_ms"].join(",")} FROM temp.polling_offer_migration;
    DROP TABLE temp.polling_offer_migration`);
  for (const definition of offerSchema().slice(1)) database.exec(definition);
  validatePollingActivationSchema(database);
  validatePollingOfferSchema(database);
}

const ledgerSchema = [
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
    observation_count INTEGER NOT NULL DEFAULT 0 CHECK(observation_count BETWEEN 0 AND ${LEDGER_MAX_OBSERVATIONS_PER_AGENT}),
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
    WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM lifecycle_projection_lanes LIMIT ${LEDGER_MAX_LANES}))>=${LEDGER_MAX_LANES}
    BEGIN SELECT RAISE(ABORT,'Lifecycle projection lane capacity reached'); END`,
  `CREATE TRIGGER lifecycle_projection_pair_capacity BEFORE INSERT ON lifecycle_projection_pairs
    WHEN (SELECT COALESCE(SUM(observation_count),0) FROM lifecycle_projection_lanes
      WHERE agent_id=(SELECT agent_id FROM lifecycle_projection_lanes WHERE lane_id=NEW.lane_id))>=${LEDGER_MAX_OBSERVATIONS_PER_AGENT}
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
const legacyLedgerSchema = ledgerSchema.map((definition) => definition.replaceAll(",'open-model'", ""));

function invalidLedger(): never {
  throw new Error("Lifecycle projection evidence is invalid.");
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
    || totals.some((row, index) => row.provider !== [...expectedProviders].sort()[index])) invalidLedger();
  if (database.prepare("PRAGMA foreign_key_check(lifecycle_projection_pairs)").get()) invalidLedger();
  const integrity = database.prepare("PRAGMA integrity_check(lifecycle_projection_pairs)").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") invalidLedger();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_lanes WHERE
      typed_sequence<compared_typed_sequence OR legacy_sequence<compared_legacy_sequence
      OR typed_sequence<>COALESCE((SELECT MAX(typed_sequence) FROM lifecycle_projection_pairs p
        WHERE p.lane_id=lifecycle_projection_lanes.lane_id),0)
      OR legacy_sequence<>COALESCE((SELECT MAX(legacy_sequence) FROM lifecycle_projection_pairs p
        WHERE p.lane_id=lifecycle_projection_lanes.lane_id),0)
      OR observation_count<>(SELECT COUNT(*) FROM lifecycle_projection_pairs p WHERE p.lane_id=lifecycle_projection_lanes.lane_id)
      LIMIT 1`).get()) invalidLedger();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_pairs WHERE
      (typed_sequence IS NULL)!=(typed_phase IS NULL) OR (typed_sequence IS NULL)!=(typed_state IS NULL)
      OR (typed_sequence IS NOT NULL AND NOT ((typed_phase='turn_active' AND typed_state='working')
        OR (typed_phase='turn_terminal' AND typed_state='terminal')))
      OR (legacy_sequence IS NULL)!=(legacy_phase IS NULL) OR (legacy_sequence IS NULL)!=(legacy_state IS NULL)
      OR (typed_sequence IS NULL AND legacy_sequence IS NULL)
      OR (conflict=1)!=(classification='conflict')
      OR (accounted=0 AND classification NOT IN ('incomplete','conflict'))
      OR (accounted=1 AND classification='incomplete') LIMIT 1`).get()) invalidLedger();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_pairs p JOIN lifecycle_projection_lanes l USING(lane_id)
      WHERE p.accounted=1 AND ((p.typed_sequence IS NOT NULL AND p.typed_sequence>l.compared_typed_sequence)
        OR (p.legacy_sequence IS NOT NULL AND p.legacy_sequence>l.compared_legacy_sequence)) LIMIT 1`).get()) invalidLedger();
  const laneCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM lifecycle_projection_lanes LIMIT ${LEDGER_MAX_LANES + 1})`).get()!.count);
  if (laneCount > LEDGER_MAX_LANES) invalidLedger();
  if (database.prepare(`SELECT 1 FROM lifecycle_projection_lanes l GROUP BY agent_id
    HAVING SUM(observation_count)>${LEDGER_MAX_OBSERVATIONS_PER_AGENT} LIMIT 1`).get()) invalidLedger();
}

export function applyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='lifecycle_projection_lanes'").get()) {
    for (const definition of ledgerSchema) database.exec(definition);
    for (const provider of LEDGER_PROVIDERS) {
      database.prepare("INSERT INTO lifecycle_projection_totals(provider) VALUES(?)").run(provider);
    }
  }
  validateLifecycleProjectionLedgerSchema(database);
}

export function validateLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  validateLifecycleProjectionLedger(database, ledgerSchema, LEDGER_PROVIDERS);
}

export function validateLegacyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  validateLifecycleProjectionLedger(database, legacyLedgerSchema, LEGACY_LEDGER_PROVIDERS);
}

export function resetLegacyLifecycleProjectionLedgerSchema(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Lifecycle projection reset requires the schema migration transaction.");
  validateLegacyLifecycleProjectionLedgerSchema(database);
  database.exec(`DROP TABLE lifecycle_projection_pairs;
    DROP TABLE lifecycle_projection_lanes;
    DROP TABLE lifecycle_projection_totals;`);
  applyLifecycleProjectionLedgerSchema(database);
}
