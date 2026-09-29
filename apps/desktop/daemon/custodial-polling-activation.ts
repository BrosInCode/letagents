import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NativeTurnBoundary } from "../shared/execution-protocol.js";
import { sameProviderActionConnectionIdentity, type ProviderActionHandle } from "./provider-action-port.js";
import type { DaemonManifestEntry } from "./types.js";

type Row = Record<string, unknown>;
export type PollingActivationRecord = {
  operation_id: string; request_id: string; agent_id: string; room_id: string; work_attempt_id: string;
  execution_generation_id: string; reverse_operation_id: string;
  native_continuation_id: string; native_connection_kind: "codex_app_server"; native_connection_sha256: string;
  native_pid: number; native_process_identity: string; config_revision: number; agent_session_id: string; room_cursor: string;
  phase: "prepared" | "dispatching" | "active" | "uncertain" | "complete" | "cancelled";
  provider_turn_id: string | null; terminal_outcome: "completed" | "failed" | "interrupted" | "lost" | null;
  created_at_ms: number; updated_at_ms: number;
  compacted_through_offer_id: string | null;
};
export type PreparePollingActivation = {
  operationId: string; requestId: string; agentId: string; roomId: string; executionGenerationId: string;
  reverseOperationId: string; handle: ProviderActionHandle; boundary: NativeTurnBoundary;
};
export type DispatchPollingActivation = Pick<PreparePollingActivation, "operationId" | "agentId" | "handle" | "boundary">;
export type CompletePollingActivation = {
  operationId: string; agentId: string; providerTurnId: string | null;
  outcome: NonNullable<PollingActivationRecord["terminal_outcome"]>;
};

const table = "custodial_polling_activations";
const identity = ["operation_id", "request_id", "agent_id", "room_id", "work_attempt_id", "execution_generation_id", "reverse_operation_id",
  "native_continuation_id", "native_connection_kind", "native_connection_sha256", "native_pid", "native_process_identity",
  "config_revision", "agent_session_id", "room_cursor", "created_at_ms"];
const compactionColumn = "compacted_through_offer_id TEXT CHECK(compacted_through_offer_id IS NULL OR length(trim(compacted_through_offer_id))>0)";
export const POLLING_OFFER_REPLAY_WINDOW = 256;
function activationSchema(version: 24 | 26 = 26): string[] { return [
  `CREATE TABLE ${table} (
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
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),${version === 26 ? `${compactionColumn},` : ""}
    CHECK((phase='complete')=(terminal_outcome IS NOT NULL)),
    CHECK(phase NOT IN ('prepared','dispatching','cancelled') OR provider_turn_id IS NULL),
    CHECK(phase<>'active' OR provider_turn_id IS NOT NULL),
    CHECK(phase<>'complete' OR terminal_outcome='lost' OR provider_turn_id IS NOT NULL)
  ) STRICT`,
  `CREATE UNIQUE INDEX custodial_polling_activation_one_unresolved ON ${table}(agent_id) WHERE phase NOT IN ('complete','cancelled')`,
  `CREATE UNIQUE INDEX custodial_polling_activation_native_turn ON ${table}(agent_id,execution_generation_id,native_continuation_id,provider_turn_id) WHERE provider_turn_id IS NOT NULL`,
  `CREATE TRIGGER custodial_polling_activation_predecessor BEFORE INSERT ON ${table}
    WHEN NEW.phase<>'prepared' ${version === 26 ? "OR NEW.compacted_through_offer_id IS NOT NULL" : ""} OR NOT EXISTS (SELECT 1 FROM execution_cutover_v2 WHERE operation_id=NEW.reverse_operation_id
      AND agent_id=NEW.agent_id AND room_id=NEW.room_id AND work_attempt_id=NEW.work_attempt_id
      AND authority_version=1 AND provider='codex' AND from_mode='daemon_inbox' AND to_mode='mcp_polling'
      AND strategy='drain' AND phase='complete' AND execution_generation_id<>NEW.execution_generation_id)
    BEGIN SELECT RAISE(ABORT,'Polling activation requires its completed reverse predecessor'); END`,
  `CREATE TRIGGER custodial_polling_activation_identity_immutable BEFORE UPDATE ON ${table}
    WHEN ${identity.map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
    BEGIN SELECT RAISE(ABORT,'Polling activation identity is immutable'); END`,
  `CREATE TRIGGER custodial_polling_activation_phase BEFORE UPDATE ON ${table}
    WHEN (NEW.provider_turn_id IS NOT OLD.provider_turn_id AND NOT
      (OLD.provider_turn_id IS NULL AND NEW.provider_turn_id IS NOT NULL AND OLD.phase IN ('dispatching','uncertain') AND NEW.phase='active'))
      OR (NEW.phase<>OLD.phase AND NOT
        ((OLD.phase='prepared' AND NEW.phase IN ('dispatching','cancelled'))
          OR (OLD.phase='dispatching' AND NEW.phase IN ('active','uncertain','complete'))
          OR (OLD.phase='active' AND NEW.phase IN ('uncertain','complete'))
          OR (OLD.phase='uncertain' AND NEW.phase IN ('active','complete'))))
      OR (OLD.phase IN ('complete','cancelled') AND (NEW.terminal_outcome IS NOT OLD.terminal_outcome OR NEW.updated_at_ms<>OLD.updated_at_ms))
    BEGIN SELECT RAISE(ABORT,'Polling activation transition is invalid'); END`,
  // A direct UPDATE cannot manufacture this state: the FK cascade has removed
  // the old parent but not yet detached its child. Only that child can set the
  // anchor before becoming the unique new root, in the same DELETE statement.
  ...(version === 26 ? [`CREATE TRIGGER custodial_polling_compaction_forward BEFORE UPDATE OF compacted_through_offer_id ON ${table}
    WHEN NEW.compacted_through_offer_id IS NOT OLD.compacted_through_offer_id AND
      (NEW.compacted_through_offer_id IS NULL
        OR EXISTS (SELECT 1 FROM custodial_polling_offers WHERE offer_id=NEW.compacted_through_offer_id)
        OR NOT EXISTS (SELECT 1 FROM custodial_polling_offers WHERE predecessor_offer_id=NEW.compacted_through_offer_id AND activation_id=OLD.operation_id)
        OR EXISTS (SELECT 1 FROM custodial_polling_offers WHERE activation_id=OLD.operation_id AND predecessor_offer_id IS NULL))
    BEGIN SELECT RAISE(ABORT,'Polling offer compaction requires the exact deletion cascade'); END`] : []),
]; }

function normalizedSql(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map(part => part.startsWith("'") ? part
    : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}

/** Operational journal, deliberately independent of the delete/reinsert manifest graph. */
export function applyPollingActivationSchema(database: DatabaseSync, version: 24 | 26 = 26): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) {
    for (const definition of activationSchema(version)) database.exec(definition);
  }
  validatePollingActivationSchema(database, version);
}

export function validatePollingActivationSchema(database: DatabaseSync, version: 24 | 26 = 26): void {
  if (version === 26) requireForeignKeys(database);
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY type,name").all(table)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = activationSchema(version).map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Polling activation journal has invalid or missing schema.");
  }
  // Integrity checking evaluates CHECK/UNIQUE constraints even if another
  // connection previously bypassed CHECK constraints. It returns no payloads.
  const integrity = database.prepare(`PRAGMA integrity_check(${table})`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Polling activation journal contains invalid authority.");
}

export function getPollingActivation(database: DatabaseSync, operationId: string): PollingActivationRecord | null {
  return database.prepare(`SELECT * FROM ${table} WHERE operation_id=?`).get(operationId) as PollingActivationRecord | undefined ?? null;
}

export function unresolvedPollingActivation(database: DatabaseSync, agentId: string): PollingActivationRecord | null {
  return database.prepare(`SELECT * FROM ${table} WHERE agent_id=? AND phase NOT IN ('complete','cancelled') LIMIT 1`)
    .get(agentId) as PollingActivationRecord | undefined ?? null;
}

export function assertNoPollingActivation(database: DatabaseSync, agentId: string): void {
  if (unresolvedPollingActivation(database, agentId)) throw new Error("An unresolved polling activation blocks this operation.");
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Polling activation requires an ownership-fenced transaction.");
  requireForeignKeys(database);
}

function requireForeignKeys(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Polling authority requires foreign key enforcement.");
  }
}

function exactActivation(database: DatabaseSync, input: { operationId: string; agentId: string }): PollingActivationRecord {
  const activation = getPollingActivation(database, input.operationId);
  if (!activation || activation.agent_id !== input.agentId) throw new Error("Polling activation has no exact operation authority.");
  return activation;
}

function nativeIdentity(handle: ProviderActionHandle): Pick<PollingActivationRecord,
  "work_attempt_id" | "native_continuation_id" | "native_connection_kind" | "native_connection_sha256" | "native_pid" | "native_process_identity"> {
  const connection = handle.providerConnection;
  if (connection?.kind !== "codex_app_server" || !sameProviderActionConnectionIdentity(connection, connection)
    || handle.pid !== connection.pid || !handle.workAttemptId.trim() || !handle.providerContinuationId?.trim()) {
    throw new Error("Polling activation requires an authenticated Codex runtime.");
  }
  return { work_attempt_id: handle.workAttemptId, native_continuation_id: handle.providerContinuationId,
    native_connection_kind: connection.kind, native_pid: connection.pid!, native_process_identity: connection.processIdentity!,
    native_connection_sha256: createHash("sha256").update(JSON.stringify([connection.kind, connection.url, connection.pid, connection.processIdentity])).digest("hex") };
}

function assertIdle(activation: Pick<PollingActivationRecord, "native_continuation_id" | "native_process_identity">, boundary: NativeTurnBoundary): void {
  if (boundary.state !== "idle" || boundary.providerContinuationId !== activation.native_continuation_id
    || boundary.nativeProcessIdentity !== activation.native_process_identity) throw new Error("Polling activation requires its exact native idle boundary.");
}

/** Structural native identity only; callers separately validate current config,
 * worker custody and desired state. No liveness or latest-turn inference. */
export function matchesPollingActivationRuntime(activation: PollingActivationRecord, current: DaemonManifestEntry,
  handle?: ProviderActionHandle): boolean {
  const ref = current.provider_ref;
  if (current.id !== activation.agent_id || current.room_id !== activation.room_id || current.provider !== "codex"
    || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling" || current.work_attempt_id !== activation.work_attempt_id
    || ref?.execution_generation_id !== activation.execution_generation_id
    || ref.custodial_launch_agent_session_id !== activation.agent_session_id) return false;
  try {
    const native = nativeIdentity({ workAttemptId: ref.work_attempt_id, providerContinuationId: ref.provider_continuation_id,
      providerConnection: ref.provider_connection, pid: ref.provider_connection?.pid ?? 0, observedState: "idle" });
    if (Object.entries(native).some(([key, value]) => activation[key as keyof PollingActivationRecord] !== value)) return false;
    return !handle || ((handle.custodyLaunchAgentSessionId === undefined || handle.custodyLaunchAgentSessionId === activation.agent_session_id)
      && !Object.entries(nativeIdentity(handle)).some(([key, value]) => activation[key as keyof PollingActivationRecord] !== value));
  } catch { return false; }
}

function assertNoOtherControl(database: DatabaseSync, agentId: string, current: DaemonManifestEntry): void {
  if (current.delivery_cutover
    || database.prepare("SELECT 1 FROM execution_cutover_v2 WHERE agent_id=? AND phase NOT IN ('complete','cancelled','failed') LIMIT 1").get(agentId)
    || database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain')").get(agentId)
    || database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(agentId)
    || database.prepare("SELECT 1 FROM provider_continuation_repairs WHERE agent_id=? AND phase NOT IN ('committed','failed') LIMIT 1").get(agentId)) {
    throw new Error("Polling activation conflicts with an unresolved control operation.");
  }
}

function assertCurrent(database: DatabaseSync, activation: PollingActivationRecord, current: DaemonManifestEntry | undefined, terminal = false): void {
  if (!current || current.id !== activation.agent_id || current.room_id !== activation.room_id
    || current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
    || current.work_attempt_id !== activation.work_attempt_id || (!terminal && (current.desired_state !== "running" || current.condition !== "none"))) {
    throw new Error("Polling activation lost its exact current agent authority.");
  }
  const ref = current.provider_ref;
  if (!(terminal && ref == null)) {
    if (!matchesPollingActivationRuntime(activation, current)) throw new Error("Polling activation runtime changed.");
  }
  const execution = database.prepare("SELECT generation,terminal_json FROM work_attempt_executions WHERE work_attempt_id=? AND execution_generation_id=?")
    .get(activation.work_attempt_id, activation.execution_generation_id) as Row | undefined;
  if (!execution || (!terminal && execution.terminal_json !== null)
    || database.prepare("SELECT 1 FROM work_attempt_executions WHERE work_attempt_id=? AND generation>? LIMIT 1").get(activation.work_attempt_id, Number(execution.generation))) {
    throw new Error("Polling activation execution generation changed.");
  }
  const config = database.prepare("SELECT config_revision,runtime_configuration_revision,polling_contract FROM agent_configurations WHERE agent_id=?")
    .get(activation.agent_id) as Row;
  if (config.polling_contract !== "custodial_polling_v1" || config.config_revision !== activation.config_revision
    || config.runtime_configuration_revision !== activation.config_revision) throw new Error("Polling activation configuration changed.");
  if (!terminal) {
    const binding = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(activation.agent_id) as Row | undefined;
    if (!binding || binding.room_id !== activation.room_id || binding.work_attempt_id !== activation.work_attempt_id
      || binding.execution_generation_id !== activation.execution_generation_id || binding.agent_session_id !== activation.agent_session_id
      || (activation.phase === "prepared" && binding.room_cursor !== activation.room_cursor)) throw new Error("Polling activation worker authority changed.");
    assertNoOtherControl(database, activation.agent_id, current);
  }
}

export function preparePollingActivation(database: DatabaseSync, input: PreparePollingActivation, current: DaemonManifestEntry | undefined): { created: boolean; activation: PollingActivationRecord } {
  requireTransaction(database);
  if ([input.operationId, input.requestId, input.agentId, input.roomId, input.executionGenerationId, input.reverseOperationId].some(value => !value.trim())) {
    throw new Error("Polling activation requires exact non-empty coordinates.");
  }
  const native = nativeIdentity(input.handle); assertIdle(native, input.boundary);
  const prior = database.prepare(`SELECT * FROM ${table} WHERE request_id=? OR operation_id=? LIMIT 1`).get(input.requestId, input.operationId) as PollingActivationRecord | undefined;
  if (prior) {
    if (prior.request_id !== input.requestId || prior.operation_id !== input.operationId || prior.agent_id !== input.agentId
      || prior.room_id !== input.roomId || prior.execution_generation_id !== input.executionGenerationId || prior.reverse_operation_id !== input.reverseOperationId
      || Object.entries(native).some(([key, value]) => prior[key as keyof PollingActivationRecord] !== value)
      || (input.handle.custodyLaunchAgentSessionId !== undefined && prior.agent_session_id !== input.handle.custodyLaunchAgentSessionId)
      || (input.handle.appliedConfigurationRevision !== undefined && prior.config_revision !== input.handle.appliedConfigurationRevision)) {
      throw new Error("Polling activation request or operation is bound to different coordinates.");
    }
    return { created: false, activation: prior };
  }
  const predecessor = database.prepare(`SELECT execution_generation_id FROM execution_cutover_v2
    WHERE operation_id=? AND agent_id=? AND room_id=? AND work_attempt_id=? AND authority_version=1 AND provider='codex'
      AND from_mode='daemon_inbox' AND to_mode='mcp_polling' AND strategy='drain' AND phase='complete'`).get(
    input.reverseOperationId, input.agentId, input.roomId, native.work_attempt_id) as Row | undefined;
  const previous = predecessor ? database.prepare("SELECT generation FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?")
    .get(String(predecessor.execution_generation_id), native.work_attempt_id) as Row | undefined : undefined;
  const execution = database.prepare("SELECT generation FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?")
    .get(input.executionGenerationId, native.work_attempt_id) as Row | undefined;
  if (!predecessor || !previous || !execution || input.executionGenerationId === predecessor.execution_generation_id
    || Number(execution.generation) <= Number(previous.generation)) throw new Error("Polling activation requires a completed reverse cutover and its successor runtime.");
  const config = database.prepare("SELECT config_revision FROM agent_configurations WHERE agent_id=?").get(input.agentId) as Row | undefined;
  const binding = database.prepare("SELECT agent_session_id,room_cursor FROM worker_session_bindings WHERE entry_id=?").get(input.agentId) as Row | undefined;
  if (!config || !binding || typeof binding.room_cursor !== "string" || !/^(?:msg_)?\d+$/.test(binding.room_cursor)
    || typeof binding.agent_session_id !== "string" || !binding.agent_session_id.trim()
    || (input.handle.appliedConfigurationRevision !== undefined && input.handle.appliedConfigurationRevision !== config.config_revision)) {
    throw new Error("Polling activation requires an applied configuration and acknowledged worker cursor.");
  }
  const timestamp = Date.now();
  const activation: PollingActivationRecord = { operation_id: input.operationId, request_id: input.requestId, agent_id: input.agentId,
    room_id: input.roomId, execution_generation_id: input.executionGenerationId, reverse_operation_id: input.reverseOperationId,
    ...native, config_revision: Number(config.config_revision), agent_session_id: binding.agent_session_id, room_cursor: binding.room_cursor,
    phase: "prepared", provider_turn_id: null, terminal_outcome: null, created_at_ms: timestamp, updated_at_ms: timestamp,
    compacted_through_offer_id: null };
  assertCurrent(database, activation, current);
  if (!matchesPollingActivationRuntime(activation, current!, input.handle)) throw new Error("Polling activation runtime changed.");
  assertNoPollingActivation(database, input.agentId);
  const columns = Object.keys(activation);
  database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .run(...Object.values(activation));
  return { created: true, activation: getPollingActivation(database, input.operationId)! };
}

export function markPollingActivationDispatch(database: DatabaseSync, input: DispatchPollingActivation, current: DaemonManifestEntry | undefined): PollingActivationRecord {
  requireTransaction(database); const activation = exactActivation(database, input);
  const native = nativeIdentity(input.handle); assertIdle(native, input.boundary);
  if (Object.entries(native).some(([key, value]) => activation[key as keyof PollingActivationRecord] !== value)
    || (input.handle.appliedConfigurationRevision !== undefined && input.handle.appliedConfigurationRevision !== activation.config_revision)) {
    throw new Error("Polling activation dispatch runtime changed.");
  }
  if (!["prepared", "dispatching"].includes(activation.phase)) throw new Error("Polling activation cannot dispatch from this phase.");
  assertCurrent(database, activation, current);
  if (!matchesPollingActivationRuntime(activation, current!, input.handle)) throw new Error("Polling activation dispatch runtime changed.");
  if (activation.phase === "dispatching") return activation;
  return updatePhase(database, activation, "dispatching");
}

/** A first ID after uncertainty must come only from this same invocation's RPC acknowledgement.
 * The mandatory caller fence authenticates that live callback; latest-turn reads cannot mint it. */
export function checkpointPollingActivationTurn(database: DatabaseSync, input: { operationId: string; agentId: string; providerTurnId: string }, current: DaemonManifestEntry | undefined): PollingActivationRecord {
  requireTransaction(database); const activation = exactActivation(database, input);
  if (!input.providerTurnId.trim()) throw new Error("Polling activation requires an exact native turn id.");
  if (activation.provider_turn_id !== null) {
    if (activation.provider_turn_id !== input.providerTurnId) throw new Error("Polling activation native turn is already bound.");
    if (activation.phase !== "complete") assertCurrent(database, activation, current);
    // An authenticated read of this already-bound exact turn may resolve
    // uncertainty. It cannot introduce a turn ID that was never checkpointed.
    if (activation.phase === "uncertain") return updatePhase(database, activation, "active");
    return activation;
  }
  if (!["dispatching", "uncertain"].includes(activation.phase)) throw new Error("Polling activation has no dispatched invocation.");
  assertCurrent(database, activation, current);
  database.prepare(`UPDATE ${table} SET provider_turn_id=?,phase='active',updated_at_ms=? WHERE operation_id=?`)
    .run(input.providerTurnId, Math.max(Date.now(), activation.updated_at_ms), input.operationId);
  return getPollingActivation(database, input.operationId)!;
}

function updatePhase(database: DatabaseSync, activation: PollingActivationRecord, phase: PollingActivationRecord["phase"]): PollingActivationRecord {
  database.prepare(`UPDATE ${table} SET phase=?,updated_at_ms=? WHERE operation_id=?`).run(phase, Math.max(Date.now(), activation.updated_at_ms), activation.operation_id);
  return getPollingActivation(database, activation.operation_id)!;
}

export function markPollingActivationUncertain(database: DatabaseSync, input: { operationId: string; agentId: string }): PollingActivationRecord {
  requireTransaction(database); const activation = exactActivation(database, input);
  if (activation.phase === "uncertain") return activation;
  if (!["dispatching", "active"].includes(activation.phase)) throw new Error("Polling activation has no dispatched invocation.");
  return updatePhase(database, activation, "uncertain");
}

export function cancelPollingActivation(database: DatabaseSync, input: { operationId: string; agentId: string }): PollingActivationRecord {
  requireTransaction(database); const activation = exactActivation(database, input);
  if (activation.phase === "cancelled") return activation;
  if (activation.phase !== "prepared") throw new Error("Only an undispatched polling activation may be cancelled.");
  return updatePhase(database, activation, "cancelled");
}

/** Caller proves this exact terminal, or hard absence of the frozen native birth, before committing. */
export function completePollingActivation(database: DatabaseSync, input: CompletePollingActivation, current: DaemonManifestEntry | undefined): PollingActivationRecord {
  requireTransaction(database); const activation = exactActivation(database, input);
  if (!["completed", "failed", "interrupted", "lost"].includes(input.outcome) || input.providerTurnId !== activation.provider_turn_id
    || (input.providerTurnId === null && input.outcome !== "lost")) throw new Error("Polling activation terminal does not match its exact native turn.");
  if (activation.phase === "complete") {
    if (activation.terminal_outcome !== input.outcome) throw new Error("Polling activation terminal is immutable.");
    return activation;
  }
  if (!["dispatching", "active", "uncertain"].includes(activation.phase)) throw new Error("Polling activation has no dispatched invocation.");
  assertCurrent(database, activation, current, true);
  database.prepare(`UPDATE ${table} SET phase='complete',terminal_outcome=?,updated_at_ms=? WHERE operation_id=?`)
    .run(input.outcome, Math.max(Date.now(), activation.updated_at_ms), input.operationId);
  return getPollingActivation(database, input.operationId)!;
}

/** Cursor acknowledgement, never evidence that a worker consumed or completed work.
 * An unacknowledged interior row is superseded; only an unacknowledged tail is outstanding. */
export type PollingOfferRecord = {
  offer_id: string; activation_id: string; process_incarnation_id: string; mcp_request_id: string;
  binding_epoch: number;
  input_cursor: string; offered_frontier: string; predecessor_offer_id: string | null;
  created_at_ms: number; acknowledged_at_ms: number | null;
};
type PollingOfferScope = { operationId: string; agentId: string; processIncarnationId: string };
export type RecordPollingOffer = PollingOfferScope & { requestId: string | number; inputCursor: string; offeredFrontier: string; expectedBindingEpoch: number };
export type AcknowledgePollingOffer = PollingOfferScope & { roomCursor: string | null };

const offers = "custodial_polling_offers";
const offerIdentity = ["offer_id", "activation_id", "process_incarnation_id", "mcp_request_id", "binding_epoch", "input_cursor", "offered_frontier", "predecessor_offer_id", "created_at_ms"];
function offerSchema(version: 25 | 26 = 26): string[] { return [
  `CREATE TABLE ${offers} (
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
      ? `FOREIGN KEY(predecessor_offer_id,activation_id) REFERENCES ${offers}(offer_id,activation_id) ON DELETE RESTRICT`
      : `FOREIGN KEY(predecessor_offer_id) REFERENCES ${offers}(offer_id) ON DELETE SET NULL`}
  ) STRICT`,
  `CREATE UNIQUE INDEX custodial_polling_offer_one_root ON ${offers}(activation_id) WHERE predecessor_offer_id IS NULL`,
  `CREATE TRIGGER custodial_polling_offer_append BEFORE INSERT ON ${offers}
    WHEN NEW.acknowledged_at_ms IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM custodial_polling_activations WHERE operation_id=NEW.activation_id AND phase='active')
      OR (NEW.predecessor_offer_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM ${offers} p WHERE p.offer_id=NEW.predecessor_offer_id AND p.activation_id=NEW.activation_id
          AND p.created_at_ms<=NEW.created_at_ms))
    BEGIN SELECT RAISE(ABORT,'Polling offers must append to the active chain tail'); END`,
  `CREATE TRIGGER custodial_polling_offer_immutable BEFORE UPDATE ON ${offers}
    ${version === 25 ? "WHEN" : "BEGIN SELECT CASE WHEN"} ${offerIdentity.filter(column => version === 25 || column !== "predecessor_offer_id").map(column => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")}
      OR (NEW.acknowledged_at_ms IS NOT OLD.acknowledged_at_ms AND
        (OLD.acknowledged_at_ms IS NOT NULL OR NEW.acknowledged_at_ms IS NULL
          OR EXISTS (SELECT 1 FROM ${offers} s WHERE s.predecessor_offer_id=OLD.offer_id)))
    ${version === 25 ? "BEGIN SELECT RAISE(ABORT,'Polling offer identity and interior acknowledgements are immutable');" : `
      THEN RAISE(ABORT,'Polling offer identity and interior acknowledgements are immutable') END;
      UPDATE ${table} SET compacted_through_offer_id=OLD.predecessor_offer_id
        WHERE operation_id=OLD.activation_id AND NEW.predecessor_offer_id IS NULL AND OLD.predecessor_offer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${offers} WHERE offer_id=OLD.predecessor_offer_id);
      SELECT CASE WHEN NEW.predecessor_offer_id IS NOT OLD.predecessor_offer_id AND NOT
        (NEW.predecessor_offer_id IS NULL AND OLD.predecessor_offer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${offers} p WHERE p.offer_id=OLD.predecessor_offer_id)
          AND EXISTS (SELECT 1 FROM ${table} a WHERE a.operation_id=OLD.activation_id
            AND a.compacted_through_offer_id=OLD.predecessor_offer_id))
        THEN RAISE(ABORT,'Polling offer predecessor is immutable outside compaction') END;
    `} END`,
  `CREATE TRIGGER custodial_polling_offer_no_delete BEFORE DELETE ON ${offers}
    BEGIN ${version === 25 ? "SELECT RAISE(ABORT,'Polling offer history cannot be removed');" : `
      SELECT CASE WHEN OLD.predecessor_offer_id IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM ${offers} s WHERE s.predecessor_offer_id=OLD.offer_id AND s.activation_id=OLD.activation_id)
        OR (SELECT COUNT(*) FROM ${offers} WHERE activation_id=OLD.activation_id)<=${POLLING_OFFER_REPLAY_WINDOW}
        THEN RAISE(ABORT,'Polling offer tail or retained history cannot be removed') END;
    `} END`,
]; }

export function applyPollingOfferSchema(database: DatabaseSync, version: 25 | 26 = 26): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(offers)) {
    for (const definition of offerSchema(version)) database.exec(definition);
  }
  validatePollingOfferSchema(database, version);
}

export function validatePollingOfferSchema(database: DatabaseSync, version: 25 | 26 = 26): void {
  if (version === 26) requireForeignKeys(database);
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL").all(offers)
    .map(row => normalizedSql(String(row.sql))).sort();
  const expected = offerSchema(version).map(normalizedSql).sort();
  if (actual.length !== expected.length || actual.some((definition, index) => definition !== expected[index])) {
    throw new Error("Polling offer journal has invalid or missing schema.");
  }
  const integrity = database.prepare(`PRAGMA integrity_check(${offers})`).all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || database.prepare(`PRAGMA foreign_key_check(${offers})`).get()) {
    throw new Error("Polling offer journal contains invalid authority.");
  }
}

/** Protected schema migration only: preserve every row and ACK; never compact
 * historical evidence or claim it covers releases the journal never observed. */
export function migratePollingOffersV25ToV26(database: DatabaseSync): void {
  requireTransaction(database);
  validatePollingActivationSchema(database, 24); validatePollingOfferSchema(database, 25);
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${compactionColumn}`);
  database.exec("DROP TRIGGER custodial_polling_activation_predecessor");
  database.exec(activationSchema().find(definition => definition.startsWith("CREATE TRIGGER custodial_polling_activation_predecessor "))!);
  database.exec(activationSchema().at(-1)!);
  // The old predecessor FK is RESTRICT. Defer it inside the migration's
  // transaction while replacing this one self-referencing table, not the
  // surrounding manifest graph. COMMIT still checks every foreign key.
  database.exec(`PRAGMA defer_foreign_keys=ON;
    CREATE TEMP TABLE polling_offer_migration AS SELECT rowid AS saved_rowid,* FROM ${offers};
    DROP TABLE ${offers}`);
  database.exec(offerSchema()[0]!);
  database.exec(`INSERT INTO ${offers}(rowid,${[...offerIdentity, "acknowledged_at_ms"].join(",")})
    SELECT saved_rowid,${[...offerIdentity, "acknowledged_at_ms"].join(",")} FROM temp.polling_offer_migration;
    DROP TABLE temp.polling_offer_migration`);
  for (const definition of offerSchema().slice(1)) database.exec(definition);
  validatePollingActivationSchema(database); validatePollingOfferSchema(database);
}

export function getPollingOfferTail(database: DatabaseSync, activationId: string): PollingOfferRecord | null {
  return database.prepare(`SELECT p.* FROM ${offers} p WHERE p.activation_id=?
    AND NOT EXISTS (SELECT 1 FROM ${offers} s WHERE s.predecessor_offer_id=p.offer_id)`).get(activationId) as PollingOfferRecord | undefined ?? null;
}

function offerCursor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:msg_)?\d+$/.test(value)) throw new Error("Polling offer requires a numeric room cursor.");
  return BigInt(value.replace(/^msg_/, ""));
}

function currentOfferAuthority(database: DatabaseSync, input: PollingOfferScope, current: DaemonManifestEntry | undefined): PollingActivationRecord {
  requireTransaction(database);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.processIncarnationId)) {
    throw new Error("Polling offer requires its MCP process incarnation UUID.");
  }
  const activation = exactActivation(database, input);
  if (activation.phase !== "active") throw new Error("Polling offer requires an active native activation.");
  assertCurrent(database, activation, current);
  const session = database.prepare(`SELECT s.expires_at FROM supervised_worker_sessions s
    JOIN worker_session_bindings b ON b.entry_id=s.agent_id AND b.room_id=s.room_id
      AND b.agent_session_id=s.agent_session_id AND b.execution_generation_id=s.execution_generation_id
      AND b.credential_ref=s.credential_ref WHERE s.agent_id=?`).get(activation.agent_id);
  if (typeof session?.expires_at !== "string" || !(Date.parse(session.expires_at) > Date.now())) {
    throw new Error("Polling offer worker session authority is missing, expired or changed.");
  }
  return activation;
}

/** Publish a bounded reply frontier before releasing it. Supersession is the
 * successor edge itself, never a state transition that can empty the chain.
 * Replay refusal is guaranteed only within the retained window. Beyond it,
 * a pure-read replay may become a fresh offer under the identical authority
 * fences. Neither reoffering nor compaction advances the worker cursor. */
export function recordPollingOffer(database: DatabaseSync, input: RecordPollingOffer, current: DaemonManifestEntry | undefined): PollingOfferRecord | null {
  const activation = currentOfferAuthority(database, input, current);
  if (typeof input.requestId !== "string" && !Number.isSafeInteger(input.requestId)) throw new Error("Polling offer requires an exact SDK request id.");
  const requestId = JSON.stringify(input.requestId); // Numeric 1 and string "1" are different invocations.
  if (offerCursor(input.offeredFrontier) < offerCursor(input.inputCursor)) throw new Error("Polling offer cannot move behind its input cursor.");
  const binding = database.prepare("SELECT room_cursor,binding_epoch FROM worker_session_bindings WHERE entry_id=?").get(activation.agent_id)!;
  if (!Number.isSafeInteger(binding.binding_epoch) || Number(binding.binding_epoch) < 1) throw new Error("Polling offer worker binding epoch is invalid.");
  if (!Number.isSafeInteger(input.expectedBindingEpoch) || input.expectedBindingEpoch < 1 || input.expectedBindingEpoch !== binding.binding_epoch) {
    throw new Error("Polling offer worker binding epoch changed.");
  }
  const prior = database.prepare(`SELECT * FROM ${offers} WHERE activation_id=? AND process_incarnation_id=? AND mcp_request_id=?`)
    .get(input.operationId, input.processIncarnationId, requestId) as PollingOfferRecord | undefined;
  const tail = getPollingOfferTail(database, input.operationId);
  if (prior) {
    if (prior.input_cursor !== input.inputCursor || prior.offered_frontier !== input.offeredFrontier || prior.offer_id !== tail?.offer_id
      || prior.binding_epoch !== binding.binding_epoch) {
      throw new Error("Polling offer invocation changed or was superseded.");
    }
    return prior;
  }
  if (binding.room_cursor !== input.inputCursor) throw new Error("Polling offer input is not the durable acknowledged cursor.");
  // An empty no-progress read supplies no new acknowledgement authority. Keep
  // the existing tail, but only after checking retained request identity.
  if (input.offeredFrontier === input.inputCursor) return null;
  const offer: PollingOfferRecord = { offer_id: randomUUID(), activation_id: input.operationId, process_incarnation_id: input.processIncarnationId,
    binding_epoch: Number(binding.binding_epoch),
    mcp_request_id: requestId, input_cursor: input.inputCursor, offered_frontier: input.offeredFrontier, predecessor_offer_id: tail?.offer_id ?? null,
    created_at_ms: Math.max(Date.now(), tail?.created_at_ms ?? 0), acknowledged_at_ms: null };
  database.prepare(`INSERT INTO ${offers}(${Object.keys(offer).join(",")}) VALUES(${Object.keys(offer).map(() => "?").join(",")})`).run(...Object.values(offer));
  const excess = Number(database.prepare(`SELECT COUNT(*) AS n FROM ${offers} WHERE activation_id=?`).get(input.operationId)!.n) - POLLING_OFFER_REPLAY_WINDOW;
  for (let index = 0; index < excess; index++) {
    // Only the tail is outstanding. Both acknowledged and superseded roots
    // compact; preserving unACKed interiors would make retries unbounded.
    database.prepare(`DELETE FROM ${offers} WHERE activation_id=? AND predecessor_offer_id IS NULL`).run(input.operationId);
  }
  return getPollingOfferTail(database, input.operationId)!;
}

/** Both writes share the ManifestStore transaction. A refused cursor never
 * advances anything, including when it names a superseded offer's frontier. */
export function acknowledgePollingOffer(database: DatabaseSync, input: AcknowledgePollingOffer, current: DaemonManifestEntry | undefined): { acknowledged: boolean; offer: PollingOfferRecord | null; roomCursor: string; bindingEpoch: number } {
  const activation = currentOfferAuthority(database, input, current);
  if (input.roomCursor !== null) offerCursor(input.roomCursor);
  const binding = database.prepare("SELECT room_cursor,binding_epoch FROM worker_session_bindings WHERE entry_id=?").get(activation.agent_id)!;
  const bindingEpoch = Number(binding.binding_epoch);
  if (!Number.isSafeInteger(bindingEpoch) || bindingEpoch < 1) throw new Error("Polling offer worker binding epoch is invalid.");
  const roomCursor = String(binding.room_cursor); offerCursor(roomCursor);
  const offer = getPollingOfferTail(database, input.operationId);
  if (input.roomCursor === null || !offer || offer.process_incarnation_id !== input.processIncarnationId || offer.offered_frontier !== input.roomCursor
    || offer.binding_epoch !== binding.binding_epoch) {
    return { acknowledged: false, offer, roomCursor, bindingEpoch };
  }
  if (offer.acknowledged_at_ms !== null) {
    if (roomCursor !== offer.offered_frontier) throw new Error("Polling offer acknowledgement and worker cursor disagree.");
    return { acknowledged: true, offer, roomCursor, bindingEpoch };
  }
  if (roomCursor !== offer.input_cursor) throw new Error("Polling offer worker cursor changed before acknowledgement.");
  const at = Math.max(Date.now(), offer.created_at_ms);
  database.prepare(`UPDATE ${offers} SET acknowledged_at_ms=? WHERE offer_id=?`).run(at, offer.offer_id);
  database.prepare("UPDATE worker_session_bindings SET room_cursor=?,updated_at=? WHERE entry_id=?").run(offer.offered_frontier, new Date(at).toISOString(), activation.agent_id);
  return { acknowledged: true, offer: getPollingOfferTail(database, input.operationId), roomCursor: offer.offered_frontier, bindingEpoch };
}
