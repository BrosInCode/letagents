import { z } from "zod";
import { executionIdentity, nativeRuntimeDeathSchema } from "./execution-protocol.js";
import { processBirthState, type ProcessIdentity } from "./process-identity.js";
import type { DatabaseSync } from "node:sqlite";
import { sameProviderActionConnectionIdentity } from "./provider-action-port.js";
import { executionRuntimeStorageIdentity, executionStorageIdentity } from "./execution-shadow-store.js";
import type { DaemonManifestEntry, DaemonProviderRuntimeReference } from "./types.js";
import type { SupervisedProviderTurnBinding } from "./supervised-agent-inbox-store.js";

const retiredRuntimeEvidenceSchema = z.strictObject({
  executionGenerationId: executionIdentity, runtimeGenerationId: executionIdentity,
  death: nativeRuntimeDeathSchema,
});
export type RetiredRuntimeEvidence = z.infer<typeof retiredRuntimeEvidenceSchema>;
export const retiredRuntimeEvidenceListSchema = z.array(retiredRuntimeEvidenceSchema).max(32);
export type RetiredRuntimePlan = { evidence: RetiredRuntimeEvidence[]; observerJson: string | null };

/** Retained identities identify candidates; only the host can prove them dead. */
export function prepareRetiredRuntimePlan(database: DatabaseSync, request: RuntimeRestartRequest,
  entry: DaemonManifestEntry | undefined, supplied: RetiredRuntimeEvidence[] = [], identity?: ProcessIdentity): RetiredRuntimePlan {
  assertRecoveryCoordinates(entry, request);
  supplied = retiredRuntimeEvidenceListSchema.parse(supplied);
  const suppliedByRuntime = new Map(supplied.map(value => [value.runtimeGenerationId, value]));
  if (suppliedByRuntime.size !== supplied.length) throw new Error("Retired runtime evidence contains duplicate identities.");
  const observer = database.prepare("SELECT * FROM execution_observers WHERE agent_id=?").get(entry.id);
  if (!["claude-code", "codex"].includes(entry.provider)) {
    if (supplied.length) throw new Error("This provider does not support retired process evidence.");
    return { evidence: [], observerJson: null };
  }
  const rows = database.prepare(`SELECT r.*,e.work_attempt_id,e.terminal_json,e.started_at,e.actor,e.generation,
    (EXISTS(SELECT 1 FROM execution_observers o WHERE o.agent_id=r.agent_id AND o.observer_runtime_generation_id=r.runtime_generation_id)
      OR EXISTS(SELECT 1 FROM execution_turns t WHERE t.agent_id=r.agent_id AND t.runtime_generation_id=r.runtime_generation_id AND t.state IN ('none','active'))
      OR EXISTS(SELECT 1 FROM supervised_agent_provider_turn_bindings b JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id
        WHERE b.agent_id=r.agent_id AND b.room_id=? AND b.work_attempt_id=e.work_attempt_id AND b.origin_execution_generation_id=r.execution_generation_id
        AND i.state NOT IN ('publishing','acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_user','cancelled_by_room_move'))) AS relevant
    FROM execution_runtime_generations r JOIN execution_generations g
      ON g.agent_id=r.agent_id AND g.execution_generation_id=r.execution_generation_id
    JOIN work_attempt_executions e ON e.execution_generation_id=r.execution_generation_id
    WHERE r.agent_id=? AND e.work_attempt_id=? AND r.execution_generation_id<>?
    ORDER BY r.runtime_generation_id`).all(entry.room_id, entry.id, entry.work_attempt_id!, request.executionGenerationId);
  const evidence: RetiredRuntimeEvidence[] = [];
  for (const row of rows) {
    const provided = suppliedByRuntime.get(String(row.runtime_generation_id));
    suppliedByRuntime.delete(String(row.runtime_generation_id));
    if (recoveredRuntime(database, entry.id, String(row.runtime_generation_id))) continue;
    if (!row.relevant) {
      if (provided) throw new Error("Retired runtime evidence does not belong to blocked recovery work.");
      continue;
    }
    const terminal = row.terminal_json ? JSON.parse(String(row.terminal_json)) : null;
    if (!terminal || typeof terminal.provider_continuation_id !== "string" || !terminal.provider_continuation_id.trim()
      || !Number.isFinite(Date.parse(terminal.ended_at)) || Date.parse(terminal.ended_at) < Date.parse(String(row.started_at))
      || terminal.actor !== row.actor || terminal.generation !== row.generation) {
      throw new Error("A predecessor has no exact retired execution record. Recovery cannot discard its work.");
    }
    const witnessed = nativeRuntimeDeathSchema.safeParse(terminal.native_runtime_death);
    if (terminal.native_runtime_death !== undefined && !witnessed.success) throw new Error("The predecessor death record is invalid.");
    const death = provided?.death ?? (witnessed.success ? witnessed.data : null);
    const kind = row.provider === "claude-code" ? "claude_cli" : row.provider === "codex" ? "codex_app_server" : null;
    if (!death) throw new Error("An older runtime needs verified process identity evidence before recovery can continue.");
    if (provided && (provided.executionGenerationId !== row.execution_generation_id || (witnessed.success
      && (provided.death.kind !== witnessed.data.kind || provided.death.pid !== witnessed.data.pid || provided.death.processIdentity !== witnessed.data.processIdentity)))) {
      throw new Error("Retired runtime evidence contradicts its durable execution record.");
    }
    if (row.provider !== entry.provider || death.kind !== kind
      || executionRuntimeStorageIdentity(entry.id, String(row.execution_generation_id), death.kind, death.pid, death.processIdentity) !== row.runtime_generation_id) {
      throw new Error("Retired runtime evidence does not match its recorded process owner.");
    }
    if (database.prepare(`SELECT 1 FROM execution_turns WHERE agent_id=? AND runtime_generation_id=? AND provider_continuation_id<>? LIMIT 1`)
      .get(entry.id, String(row.runtime_generation_id), terminal.provider_continuation_id)
      || database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings WHERE agent_id=? AND work_attempt_id=? AND origin_execution_generation_id=? AND provider_continuation_id<>? LIMIT 1`)
        .get(entry.id, String(row.work_attempt_id), String(row.execution_generation_id), terminal.provider_continuation_id)) {
      throw new Error("A predecessor's recorded conversation identity is inconsistent.");
    }
    if (processBirthState(death.pid, death.processIdentity, identity) !== "gone") {
      throw new Error("A predecessor's exact process has not been proven gone. No recovery boundary was changed.");
    }
    evidence.push({ executionGenerationId: String(row.execution_generation_id), runtimeGenerationId: String(row.runtime_generation_id), death });
  }
  if (suppliedByRuntime.size) throw new Error("Retired runtime evidence does not belong to this agent's work attempt.");
  return { evidence, observerJson: observer && evidence.some(item => item.runtimeGenerationId === observer.observer_runtime_generation_id) ? JSON.stringify(observer) : null };
}

export function archiveRetiredRuntimes(database: DatabaseSync, request: RuntimeRestartRequest, entry: DaemonManifestEntry,
  plan: RetiredRuntimePlan, identity?: ProcessIdentity): void {
  if (!database.isTransaction || entry.desired_state !== "paused") throw new Error("Retired runtime recovery requires a paused, fenced transaction.");
  const current = prepareRetiredRuntimePlan(database, request, entry, plan.evidence, identity);
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("The predecessor observation changed during recovery. Refresh and retry.");
  const at = new Date().toISOString();
  for (const item of plan.evidence) {
    const execution = database.prepare("SELECT terminal_json FROM work_attempt_executions WHERE execution_generation_id=?").get(item.executionGenerationId)!;
    const terminal = JSON.parse(String(execution.terminal_json));
    const snapshot = plan.observerJson && JSON.parse(plan.observerJson).observer_runtime_generation_id === item.runtimeGenerationId ? plan.observerJson : null;
    // Completed records never serve as a pending stop reference. Retain the
    // exact birth witness alongside its generation/continuation for audit.
    const ref = { work_attempt_id: entry.work_attempt_id, execution_generation_id: item.executionGenerationId,
      provider_continuation_id: terminal.provider_continuation_id, provider_connection: null, native_runtime_death: item.death };
    database.prepare("INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,'resume','complete',?,?,?,?)")
      .run(executionStorageIdentity("retired-runtime-recovery", entry.id, item.runtimeGenerationId), entry.id, entry.room_id,
        item.executionGenerationId, item.runtimeGenerationId, JSON.stringify(ref), snapshot, at, at);
    settleStoppedRuntimeWork(database, { agent_id: entry.id, room_id: entry.room_id,
      execution_generation_id: item.executionGenerationId, runtime_generation_id: item.runtimeGenerationId }, entry.work_attempt_id!, at, false);
  }
}

export type RuntimeRestartMode = "resume" | "fresh";
export type RuntimeRestartRequest = {
  operationId: string; entryId: string; roomId: string;
  executionGenerationId: string; runtimeGenerationId: string;
  mode: RuntimeRestartMode;
};
export type RuntimeRecoveryRecord = {
  operation_id: string; agent_id: string; room_id: string;
  execution_generation_id: string; runtime_generation_id: string;
  mode: RuntimeRestartMode; phase: "prepared" | "stopped" | "complete";
  provider_ref_json: string; observer_json: string | null;
  created_at: string; updated_at: string;
};
const schema = `CREATE TABLE agent_runtime_recoveries (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 512),
  agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
  execution_generation_id TEXT NOT NULL, runtime_generation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('resume','fresh')),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','stopped','complete')),
  provider_ref_json TEXT NOT NULL CHECK(json_valid(provider_ref_json)),
  observer_json TEXT CHECK(observer_json IS NULL OR json_valid(observer_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT`;
const index = "CREATE UNIQUE INDEX agent_runtime_recovery_pending ON agent_runtime_recoveries(agent_id) WHERE phase <> 'complete'";
const normalize = (sql: string) => sql.replace(/IF NOT EXISTS /gi, "").replace(/\s+/g, " ").trim();

export function applyRuntimeRecoverySchema(database: DatabaseSync): void {
  database.exec(schema.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
  database.exec(index.replace("CREATE UNIQUE INDEX", "CREATE UNIQUE INDEX IF NOT EXISTS"));
  validateRuntimeRecoverySchema(database);
}

export function validateRuntimeRecoverySchema(database: DatabaseSync): void {
  for (const [name, expected] of [["agent_runtime_recoveries", schema], ["agent_runtime_recovery_pending", index]]) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string } | undefined;
    if (!row || normalize(row.sql) !== normalize(expected)) throw new Error("Runtime recovery journal is missing or invalid.");
  }
}

export function readRuntimeRecovery(database: DatabaseSync, operationId: string): RuntimeRecoveryRecord | null {
  return database.prepare("SELECT * FROM agent_runtime_recoveries WHERE operation_id=?").get(operationId) as RuntimeRecoveryRecord | undefined ?? null;
}

export function pendingRuntimeRecovery(database: DatabaseSync, agentId: string): RuntimeRecoveryRecord | null {
  return database.prepare("SELECT * FROM agent_runtime_recoveries WHERE agent_id=? AND phase <> 'complete'").get(agentId) as RuntimeRecoveryRecord | undefined ?? null;
}

export function assertRecoveryCoordinates(entry: DaemonManifestEntry | undefined, request: RuntimeRestartRequest): asserts entry is DaemonManifestEntry {
  const ref = entry?.provider_ref;
  const connection = ref?.provider_connection;
  if (!entry || entry.id !== request.entryId || entry.room_id !== request.roomId
    || !ref || ref.work_attempt_id !== entry.work_attempt_id
    || ref.execution_generation_id !== request.executionGenerationId
    || !connection?.pid || !connection.processIdentity
    || executionRuntimeStorageIdentity(entry.id, ref.execution_generation_id, connection.kind, connection.pid, connection.processIdentity) !== request.runtimeGenerationId) {
    throw new Error("The agent runtime changed. Refresh checks before restarting it.");
  }
}

export function prepareRuntimeRecovery(database: DatabaseSync, request: RuntimeRestartRequest, entry: DaemonManifestEntry | undefined): RuntimeRecoveryRecord {
  if (!database.isTransaction) throw new Error("Runtime recovery requires a fenced transaction.");
  for (const value of [request.operationId, request.entryId, request.roomId, request.executionGenerationId, request.runtimeGenerationId]) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Runtime recovery requires exact coordinates.");
  }
  if (!["resume", "fresh"].includes(request.mode)) throw new Error("Unknown runtime recovery mode.");
  const prior = readRuntimeRecovery(database, request.operationId) ?? pendingRuntimeRecovery(database, request.entryId);
  if (prior) {
    if (prior.agent_id !== request.entryId || prior.room_id !== request.roomId || prior.execution_generation_id !== request.executionGenerationId
      || prior.runtime_generation_id !== request.runtimeGenerationId || prior.mode !== request.mode) {
      throw new Error("A different runtime recovery is already recorded. Retry its original action.");
    }
    return prior;
  }
  assertRecoveryCoordinates(entry, request);
  if (entry.desired_state === "stopped" || entry.delivery_mode !== "daemon_inbox") throw new Error("Runtime recovery requires a saved supervised agent.");
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,?,'prepared',?,NULL,?,?)`)
    .run(request.operationId, request.entryId, request.roomId, request.executionGenerationId, request.runtimeGenerationId, request.mode, JSON.stringify(entry.provider_ref), at, at);
  // This intent survives daemon death. Neither convergence nor FIFO admission
  // may silently start a replacement after an interrupted operator action.
  database.prepare("UPDATE agent_launch_intents SET desired_state='paused' WHERE agent_id=?").run(request.entryId);
  return readRuntimeRecovery(database, request.operationId)!;
}

/** The caller has independently proved this exact OS process birth is gone. */
export function checkpointRuntimeStopped(database: DatabaseSync, operationId: string, entry: DaemonManifestEntry | undefined): RuntimeRecoveryRecord {
  const record = readRuntimeRecovery(database, operationId);
  if (!record || !database.isTransaction) throw new Error("Runtime recovery has no durable stop intent.");
  if (record.phase !== "prepared") return record;
  assertRecoveryCoordinates(entry, { operationId, entryId: record.agent_id, roomId: record.room_id,
    executionGenerationId: record.execution_generation_id, runtimeGenerationId: record.runtime_generation_id, mode: record.mode });
  const saved = JSON.parse(record.provider_ref_json) as DaemonProviderRuntimeReference;
  if (entry.desired_state !== "paused" || !sameProviderActionConnectionIdentity(saved.provider_connection, entry.provider_ref?.provider_connection)) {
    throw new Error("Runtime recovery lost its paused process boundary.");
  }
  const observer = database.prepare("SELECT * FROM execution_observers WHERE agent_id=? AND observer_runtime_generation_id=?").get(record.agent_id, record.runtime_generation_id);
  const at = new Date().toISOString();
  database.prepare("UPDATE agent_runtime_recoveries SET phase='stopped',observer_json=?,updated_at=? WHERE operation_id=?")
    .run(observer ? JSON.stringify(observer) : null, at, operationId);
  settleStoppedRuntimeWork(database, record, saved.work_attempt_id, at, true);
  return readRuntimeRecovery(database, operationId)!;
}

function settleStoppedRuntimeWork(database: DatabaseSync,
  record: Pick<RuntimeRecoveryRecord, "agent_id" | "room_id" | "execution_generation_id" | "runtime_generation_id">,
  workAttemptId: string, at: string, includeUnboundDispatch: boolean): void {
  database.prepare(`UPDATE execution_observers SET observer_epoch=observer_epoch+1
    WHERE agent_id=? AND observer_runtime_generation_id=?`)
    .run(record.agent_id, record.runtime_generation_id);
  // A process exit does not prove a mutating operation succeeded or failed.
  database.prepare(`UPDATE supervised_agent_effects SET state='uncertain',error=?,updated_at=?
    WHERE agent_id=? AND execution_generation_id=? AND mutation=1 AND state='executing'`)
    .run("The runtime was restarted before this action's result was confirmed. Check its result before repeating it.", at, record.agent_id, record.execution_generation_id);
  database.prepare(`UPDATE execution_runtime_generations SET runtime_state='exited',control_state='lost',
    ended_at_ms=MAX(created_at_ms,?) WHERE agent_id=? AND runtime_generation_id=?`)
    .run(Date.parse(at), record.agent_id, record.runtime_generation_id);
  database.prepare(`UPDATE execution_turns SET state='lost',ended_at_ms=MAX(created_at_ms,?)
    WHERE agent_id=? AND runtime_generation_id=? AND state IN ('none','active')`)
    .run(Date.parse(at), record.agent_id, record.runtime_generation_id);
  database.prepare(`UPDATE supervised_agent_inbox SET state='cancelled_by_user',last_error=?,
    updated_at=?,acknowledged_at=?,next_attempt_at_ms=NULL,blocked_by_inbox_item_id=NULL
    WHERE agent_id=? AND room_id=?
    AND COALESCE(CASE WHEN json_valid(outcome) THEN json_extract(outcome,'$.kind') END,'') NOT IN ('reply','no_reply','failed','interrupted')
    AND NOT EXISTS (SELECT 1 FROM supervised_agent_terminal_results terminal WHERE terminal.inbox_item_id=supervised_agent_inbox.inbox_item_id AND terminal.outcome IN ('reply','no_reply','failed','interrupted'))
    AND state NOT IN ('publishing','acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
    AND ((?=1 AND state='dispatching' AND provider_turn_id IS NULL) OR inbox_item_id IN
      (SELECT inbox_item_id FROM supervised_agent_provider_turn_bindings WHERE agent_id=? AND room_id=? AND work_attempt_id=? AND origin_execution_generation_id=?))`)
    .run("Stopped by runtime recovery. Unconfirmed work was not replayed; review the saved results before continuing.",
      at, at, record.agent_id, record.room_id, includeUnboundDispatch ? 1 : 0, record.agent_id, record.room_id, workAttemptId, record.execution_generation_id);
  database.prepare(`UPDATE execution_message_attempts SET state='lost',conclusion='lost',settled_at_ms=MAX(created_at_ms,?)
    WHERE agent_id=? AND state='active' AND attempt_id IN
      (SELECT attempt_id FROM execution_turns WHERE agent_id=? AND runtime_generation_id=?)
    AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox i WHERE i.agent_id=execution_message_attempts.agent_id
      AND i.room_id=execution_message_attempts.room_id AND i.source_message_id=execution_message_attempts.source_message_id
      AND ((CASE WHEN json_valid(i.outcome) THEN json_extract(i.outcome,'$.kind') END) IN ('reply','no_reply','failed','interrupted')
        OR EXISTS (SELECT 1 FROM supervised_agent_terminal_results terminal WHERE terminal.inbox_item_id=i.inbox_item_id AND terminal.outcome IN ('reply','no_reply','failed','interrupted'))))`)
    .run(Date.parse(at), record.agent_id, record.agent_id, record.runtime_generation_id);
}

export function recoveredRuntime(database: DatabaseSync, agentId: string, runtimeId: string): { incomplete: boolean } | null {
  if (!runtimeRecoveryStorageAvailable(database)) return null;
  const row = database.prepare(`SELECT observer_json FROM agent_runtime_recoveries
    WHERE agent_id=? AND runtime_generation_id=? AND phase IN ('stopped','complete') LIMIT 1`).get(agentId, runtimeId) as { observer_json: string | null } | undefined;
  if (!row) return null;
  // Force-stop proves death, not that every final native event reached SQLite.
  // Preserve that uncertainty even when the durable cursor had no known gap.
  return { incomplete: true };
}

/** The caller proved the exact Cursor turn's origin execution terminal and owns the reset transaction. */
export function recordInterruptedCursorRecovery(database: DatabaseSync, turn: SupervisedProviderTurnBinding, at: string): string | null {
  if (!database.isTransaction) throw new Error("Runtime recovery requires a fenced transaction.");
  const runtime = database.prepare(`SELECT r.runtime_generation_id FROM execution_turns t
    JOIN execution_runtime_generations r ON r.agent_id=t.agent_id
      AND r.execution_generation_id=t.execution_generation_id AND r.runtime_generation_id=t.runtime_generation_id
    JOIN execution_attempt_generations g ON g.attempt_id=t.attempt_id AND g.agent_id=t.agent_id
      AND g.room_id=t.room_id AND g.execution_generation_id=t.execution_generation_id
    WHERE t.agent_id=? AND t.room_id=? AND t.execution_generation_id=?
      AND t.provider_continuation_id=? AND t.provider_turn_id=? AND g.workspace_id=? AND r.provider='cursor'`)
    .get(turn.agent_id, turn.room_id, turn.origin_execution_generation_id,
      turn.provider_continuation_id, turn.provider_turn_id, turn.work_attempt_id) as { runtime_generation_id: string } | undefined;
  if (!runtime) return null; // Older deliveries may have no captured native runtime.
  const runtimeId = runtime.runtime_generation_id;
  if (pendingRuntimeRecovery(database, turn.agent_id)) throw new Error("A different runtime recovery is already recorded.");
  if (recoveredRuntime(database, turn.agent_id, runtimeId)) return runtimeId;
  const observer = database.prepare(`SELECT * FROM execution_observers
    WHERE agent_id=? AND observer_runtime_generation_id=?`).get(turn.agent_id, runtimeId);
  // Retain the old cursor, including missing events. Recovery permits a new
  // process to start; it never turns the crashed turn into a native success.
  const ref: DaemonProviderRuntimeReference = { work_attempt_id: turn.work_attempt_id,
    execution_generation_id: turn.origin_execution_generation_id,
    provider_continuation_id: turn.provider_continuation_id, provider_connection: null };
  database.prepare(`INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,?,'complete',?,?,?,?)`)
    .run(executionStorageIdentity("cursor-recovery", turn.agent_id, runtimeId), turn.agent_id, turn.room_id,
      turn.origin_execution_generation_id, runtimeId, "fresh", JSON.stringify(ref), observer ? JSON.stringify(observer) : null, at, at);
  database.prepare(`UPDATE execution_observers SET observer_epoch=observer_epoch+1
    WHERE agent_id=? AND observer_runtime_generation_id=?`).run(turn.agent_id, runtimeId);
  database.prepare(`UPDATE execution_runtime_generations SET runtime_state='exited',control_state='lost',
    ended_at_ms=MAX(created_at_ms,?) WHERE agent_id=? AND runtime_generation_id=?`).run(Date.parse(at), turn.agent_id, runtimeId);
  database.prepare(`UPDATE execution_turns SET state='lost',ended_at_ms=MAX(created_at_ms,?)
    WHERE agent_id=? AND runtime_generation_id=? AND state IN ('none','active')`).run(Date.parse(at), turn.agent_id, runtimeId);
  database.prepare(`UPDATE supervised_agent_effects SET state='uncertain',error=?,updated_at=?
    WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mutation=1 AND state='executing'`)
    .run("The runtime was recovered before this action's result was confirmed. Check its result before repeating it.",
      at, turn.agent_id, turn.origin_execution_generation_id, turn.provider_turn_id);
  return runtimeId;
}

/** Only a new process may cross this boundary. The old missing events stay missing. */
export function hasRuntimeRecoveryBoundary(database: DatabaseSync, agentId: string, oldRuntime: string, newRuntime: string, sourceId: string | null): boolean {
  if (oldRuntime === newRuntime || !runtimeRecoveryStorageAvailable(database)) return false;
  return Boolean(database.prepare(`SELECT 1 FROM agent_runtime_recoveries WHERE agent_id=? AND runtime_generation_id=?
    AND phase IN ('stopped','complete') AND json_extract(observer_json,'$.observer_runtime_generation_id')=?
    AND json_extract(observer_json,'$.source_id') IS ? LIMIT 1`).get(agentId, oldRuntime, oldRuntime, sourceId));
}

/** Standalone retained-history databases may predate operational recovery. */
export function runtimeRecoveryStorageAvailable(database: DatabaseSync): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runtime_recoveries'").get());
}
