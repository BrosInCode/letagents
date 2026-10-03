import { z } from "zod";
import { hostGrantApiOrigin } from "./cloud-http.js";
import { executionIdentity, nativeRuntimeDeathSchema } from "./execution-protocol.js";
import { processBirthState, type ProcessIdentity } from "./process-identity.js";
import type { DatabaseSync } from "node:sqlite";
import { sameProviderActionConnectionIdentity } from "./provider-action-port.js";
import { executionRuntimeStorageIdentity, executionStorageIdentity } from "./execution-shadow-store.js";
import type { DaemonManifestEntry, DaemonProviderRuntimeReference } from "./types.js";
import type { SupervisedProviderTurnBinding } from "./supervised-agent-inbox-store.js";

/** Positive lane-stop and exact worker-retirement acknowledgement; not native process death. */
export const cursorLaneRetirementSchema = z.strictObject({
  kind: z.literal("cursor_idle_lane_retired_v1"),
  entry_id: executionIdentity, room_id: executionIdentity, work_attempt_id: executionIdentity,
  execution_generation_id: executionIdentity, provider_continuation_id: executionIdentity,
  agent_session_id: executionIdentity, grant_id: executionIdentity,
  api_url: z.string().min(1).max(512).refine(value => {
    try { return hostGrantApiOrigin(value) === value; } catch { return false; }
  }, "Expected a canonical host grant API origin"),
  agent_key: executionIdentity, retired_at: z.iso.datetime(),
});
export type CursorLaneRetirement = z.infer<typeof cursorLaneRetirementSchema>;

const retiredRuntimeEvidenceSchema = z.strictObject({
  executionGenerationId: executionIdentity, runtimeGenerationId: executionIdentity,
  death: nativeRuntimeDeathSchema,
});
export type RetiredRuntimeEvidence = z.infer<typeof retiredRuntimeEvidenceSchema>;
export const retiredRuntimeEvidenceListSchema = z.array(retiredRuntimeEvidenceSchema).max(32);
export type RetiredRuntimePlan = { evidence: RetiredRuntimeEvidence[]; suppliedEvidence: RetiredRuntimeEvidence[]; observerJson: string | null };

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
    return { evidence: [], suppliedEvidence: supplied, observerJson: null };
  }
  // Lease continuity also consumes legacy worker reservations, even when that
  // generation has no unfinished message work. Retire those exact candidates
  // through the same death checks; never manufacture a historical grant receipt.
  const rows = database.prepare(`SELECT r.*,e.work_attempt_id,e.terminal_json,e.started_at,e.actor,e.generation,
    (EXISTS(SELECT 1 FROM execution_observers o WHERE o.agent_id=r.agent_id AND o.observer_runtime_generation_id=r.runtime_generation_id)
      OR EXISTS(SELECT 1 FROM execution_turns t WHERE t.agent_id=r.agent_id AND t.runtime_generation_id=r.runtime_generation_id AND t.state IN ('none','active','lost'))
      OR EXISTS(SELECT 1 FROM supervised_agent_provider_turn_bindings b JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id
        WHERE b.agent_id=r.agent_id AND b.room_id=? AND b.work_attempt_id=e.work_attempt_id AND b.origin_execution_generation_id=r.execution_generation_id
        AND i.state NOT IN ('publishing','acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_user','cancelled_by_room_move'))
      OR EXISTS(SELECT 1 FROM (
        SELECT entry_id,execution_generation_id,agent_session_id FROM worker_binding_publications WHERE entry_id=r.agent_id
        UNION SELECT entry_id,from_execution_generation_id,agent_session_id FROM worker_generation_verifications WHERE entry_id=r.agent_id
        UNION SELECT entry_id,to_execution_generation_id,agent_session_id FROM worker_generation_verifications WHERE entry_id=r.agent_id
      ) p WHERE p.entry_id=r.agent_id AND p.execution_generation_id=r.execution_generation_id
        AND NOT EXISTS(SELECT 1 FROM worker_execution_bindings b WHERE b.entry_id=p.entry_id
          AND b.execution_generation_id=p.execution_generation_id AND b.agent_session_id=p.agent_session_id))) AS relevant
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
  return { evidence, suppliedEvidence: supplied, observerJson: observer && evidence.some(item => item.runtimeGenerationId === observer.observer_runtime_generation_id) ? JSON.stringify(observer) : null };
}

export function archiveRetiredRuntimes(database: DatabaseSync, request: RuntimeRestartRequest, entry: DaemonManifestEntry,
  plan: RetiredRuntimePlan, identity?: ProcessIdentity): void {
  if (!database.isTransaction || entry.desired_state !== "paused") throw new Error("Retired runtime recovery requires a paused, fenced transaction.");
  const current = prepareRetiredRuntimePlan(database, request, entry, plan.suppliedEvidence, identity);
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

/** The line an owner reads in the agent's activity when its record stops under a runtime that keeps working. */
export const ACTIVITY_RECORD_STOPPED_NOTICE = "LetAgents stopped recording this agent's activity: part of the record could not be kept. The agent keeps working, and its messages are not affected.";
/** The line an owner reads in the agent's activity when the daemon carried on past a gap in its record. */
export const ACTIVITY_RECORD_CONTINUED_NOTICE = "Part of this agent's activity record is missing; LetAgents continued with a new record.";

/**
 * The daemon is about to start another runtime for this agent. It does that
 * only once every earlier generation of the work attempt has ended, and the
 * runtimes of those generations can still stop the new one from being
 * recorded: one whose record has a gap refuses the next observer, and one
 * with a turn left open refuses the next turn. Nothing else will ever
 * complete either. So each is archived behind the same boundary that
 * "Restart and resume" records: its observer as it stands, gap included, a
 * new observer epoch, the runtime ended, its open turns lost. What is missing
 * stays missing and the runtime reads as incomplete from then on.
 *
 * Unlike that action, nobody stopped anything here, so no message is
 * cancelled and no attempt is marked lost: a turn whose message is still to
 * be settled is left for its replacement to read back.
 */
export function archiveExitedRuntimes(database: DatabaseSync, entry: DaemonManifestEntry | undefined, identity?: ProcessIdentity): string[] {
  if (!database.isTransaction) throw new Error("Runtime recovery requires a fenced transaction.");
  const rows = exitedRuntimesToArchive(database, entry, identity);
  return entry && rows.length ? archiveSelectedRuntimes(database, entry, rows) : [];
}

/**
 * The ended runtimes of this agent that `archiveExitedRuntimes` would archive. It only reads.
 *
 * Each has a recorded terminal. The runtime the agent's saved reference still
 * names is archived only once its process is known to have ended: the
 * operating system says the process is gone (absent, or another process
 * under its id), or it cannot tell and the terminal carries the evidence of
 * the process's death. A process it shows running is never archived. When its
 * liveness cannot be told, it is left alone; the restart for a blocked record
 * stops it through its adapter, or its owner is shown why the agent waits.
 * Every other runtime has been followed by a later one, which the daemon only
 * starts once the process before it is proven gone.
 *
 * Cursor starts a child per turn in one generation, and that generation has
 * a terminal only once the lane itself ends. A child of the lane's current
 * generation is archived once the saved reference no longer names it: the
 * daemon moves the reference off a child only after the child has exited, or
 * after a successor found it gone. A turn it left open, after a daemon that
 * was replaced under it, otherwise refuses every later turn of the lane.
 */
export function exitedRuntimesToArchive(database: DatabaseSync, entry: DaemonManifestEntry | undefined,
  identity?: ProcessIdentity): Array<Record<string, string | number | null>> {
  if (!entry || entry.delivery_mode !== "daemon_inbox" || !runtimeRecoveryStorageAvailable(database)
    || pendingRuntimeRecovery(database, entry.id)) return [];
  const saved = entry.provider_ref;
  const savedRuntime = saved?.provider_connection?.pid && saved.provider_connection.processIdentity
    ? executionRuntimeStorageIdentity(entry.id, saved.execution_generation_id, saved.provider_connection.kind,
      saved.provider_connection.pid, saved.provider_connection.processIdentity) : null;
  return (database.prepare(`SELECT r.runtime_generation_id,r.execution_generation_id,e.work_attempt_id,e.terminal_json,
      (SELECT COUNT(*) FROM execution_observers o WHERE o.agent_id=r.agent_id AND o.observer_runtime_generation_id=r.runtime_generation_id) AS observes
    FROM execution_runtime_generations r
    JOIN work_attempt_executions e ON e.execution_generation_id=r.execution_generation_id
    WHERE r.agent_id=? AND (e.terminal_json IS NOT NULL OR (r.provider='cursor' AND r.execution_generation_id=?))
      AND NOT EXISTS (SELECT 1 FROM agent_runtime_recoveries done WHERE done.agent_id=r.agent_id
        AND done.runtime_generation_id=r.runtime_generation_id AND done.phase IN ('stopped','complete'))
      AND (EXISTS (SELECT 1 FROM execution_observers o WHERE o.agent_id=r.agent_id
          AND o.observer_runtime_generation_id=r.runtime_generation_id
          AND (o.source_id IS NULL OR o.max_observed_sequence > o.last_source_sequence))
        OR EXISTS (SELECT 1 FROM execution_turns t JOIN execution_message_attempts a ON a.attempt_id=t.attempt_id
          WHERE t.agent_id=r.agent_id AND t.runtime_generation_id=r.runtime_generation_id AND t.state IN ('none','active','lost')
            AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox i WHERE i.agent_id=a.agent_id AND i.room_id=a.room_id
              AND i.source_message_id=a.source_message_id
              AND i.state IN ('pending','dispatching','awaiting_result','result_recovery','retryable','blocked'))))
    ORDER BY r.runtime_generation_id`).all(entry.id, saved?.execution_generation_id ?? null) as Array<Record<string, string | number | null>>)
    .filter(row => {
      if (String(row.runtime_generation_id) !== savedRuntime) return true;
      // The Cursor child the saved reference still names is the lane's own, until its exit is settled.
      if (row.terminal_json === null) return false;
      const birth = processBirthState(saved!.provider_connection!.pid, saved!.provider_connection!.processIdentity ?? null, identity);
      // A process the operating system shows running is never archived, whatever its terminal says.
      return birth === "gone" || (birth === "unknown" && witnessedDeath(entry, row) !== null);
    });
}

/** The death of exactly this runtime's process, as its generation's terminal records it, if it does. */
function witnessedDeath(entry: DaemonManifestEntry, row: Record<string, string | number | null>) {
  let terminal: { native_runtime_death?: unknown };
  try { terminal = JSON.parse(String(row.terminal_json)) as typeof terminal; } catch { return null; }
  const witnessed = nativeRuntimeDeathSchema.safeParse(terminal?.native_runtime_death);
  return witnessed.success && executionRuntimeStorageIdentity(entry.id, String(row.execution_generation_id), witnessed.data.kind,
    witnessed.data.pid, witnessed.data.processIdentity) === String(row.runtime_generation_id) ? witnessed.data : null;
}

function archiveSelectedRuntimes(database: DatabaseSync, entry: DaemonManifestEntry,
  rows: Array<Record<string, string | number | null>>): string[] {
  const at = new Date().toISOString();
  const archived: string[] = [];
  for (const row of rows) {
    const runtimeId = String(row.runtime_generation_id);
    const generationId = String(row.execution_generation_id);
    const terminal = (row.terminal_json === null ? {} : JSON.parse(String(row.terminal_json))) as { provider_continuation_id?: unknown; native_runtime_death?: unknown };
    const death = witnessedDeath(entry, row);
    const observer = row.observes ? database.prepare(`SELECT * FROM execution_observers
      WHERE agent_id=? AND observer_runtime_generation_id=?`).get(entry.id, runtimeId) : undefined;
    const ref = { work_attempt_id: String(row.work_attempt_id), execution_generation_id: generationId,
      provider_continuation_id: typeof terminal.provider_continuation_id === "string" ? terminal.provider_continuation_id : null,
      provider_connection: null, ...(death ? { native_runtime_death: death } : {}) };
    database.prepare("INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,'resume','complete',?,?,?,?)")
      .run(executionStorageIdentity("automatic-runtime-recovery", entry.id, runtimeId), entry.id, entry.room_id,
        generationId, runtimeId, JSON.stringify(ref), observer ? JSON.stringify(observer) : null, at, at);
    database.prepare(`UPDATE execution_observers SET observer_epoch=observer_epoch+1
      WHERE agent_id=? AND observer_runtime_generation_id=?`).run(entry.id, runtimeId);
    database.prepare(`UPDATE execution_runtime_generations SET runtime_state='exited',control_state='lost',
      ended_at_ms=COALESCE(ended_at_ms,MAX(created_at_ms,?)) WHERE agent_id=? AND runtime_generation_id=?`)
      .run(Date.parse(at), entry.id, runtimeId);
    database.prepare(`UPDATE execution_turns SET state='lost',ended_at_ms=MAX(created_at_ms,?)
      WHERE agent_id=? AND runtime_generation_id=? AND state IN ('none','active')`).run(Date.parse(at), entry.id, runtimeId);
    archived.push(runtimeId);
  }
  return archived;
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
export function recordInterruptedCursorRecovery(database: DatabaseSync, turn: SupervisedProviderTurnBinding, at: string, laneRetirement?: CursorLaneRetirement): string | null {
  if (!database.isTransaction) throw new Error("Runtime recovery requires a fenced transaction.");
  let runtime = database.prepare(`SELECT r.runtime_generation_id FROM execution_turns t
    JOIN execution_runtime_generations r ON r.agent_id=t.agent_id
      AND r.execution_generation_id=t.execution_generation_id AND r.runtime_generation_id=t.runtime_generation_id
    JOIN execution_attempt_generations g ON g.attempt_id=t.attempt_id AND g.agent_id=t.agent_id
      AND g.room_id=t.room_id AND g.execution_generation_id=t.execution_generation_id
    WHERE t.agent_id=? AND t.room_id=? AND t.execution_generation_id=?
      AND t.provider_continuation_id=? AND t.provider_turn_id=? AND g.workspace_id=? AND r.provider='cursor'`)
    .get(turn.agent_id, turn.room_id, turn.origin_execution_generation_id,
      turn.provider_continuation_id, turn.provider_turn_id, turn.work_attempt_id) as { runtime_generation_id: string } | undefined;
  if (!runtime) {
    // A failed child may never acquire a typed turn. Retain the exact retired
    // predecessor's observer instead; its missing events remain unknown.
    runtime = database.prepare(`SELECT DISTINCT r.runtime_generation_id FROM execution_observers o
      JOIN execution_runtime_generations r ON r.agent_id=o.agent_id
        AND r.execution_generation_id=o.observer_execution_generation_id AND r.runtime_generation_id=o.observer_runtime_generation_id
      JOIN execution_turns t ON t.agent_id=r.agent_id AND t.execution_generation_id=r.execution_generation_id AND t.runtime_generation_id=r.runtime_generation_id
      JOIN execution_attempt_generations g ON g.attempt_id=t.attempt_id AND g.agent_id=t.agent_id
        AND g.room_id=t.room_id AND g.execution_generation_id=t.execution_generation_id
      WHERE o.agent_id=? AND o.observer_execution_generation_id=? AND o.execution_generation_id=o.observer_execution_generation_id
        AND o.runtime_generation_id=o.observer_runtime_generation_id AND r.provider='cursor'
        AND r.runtime_state='exited' AND r.control_state='lost' AND t.state='terminal'
        AND t.provider_continuation_id=? AND t.room_id=? AND g.workspace_id=?`)
      .get(turn.agent_id, turn.origin_execution_generation_id, turn.provider_continuation_id,
        turn.room_id, turn.work_attempt_id) as { runtime_generation_id: string } | undefined;
    if (!runtime && database.prepare("SELECT 1 FROM execution_observers WHERE agent_id=?").get(turn.agent_id)) {
      throw new Error("Runtime recovery cannot archive an unrelated or unretired Cursor observer.");
    }
  }
  if (!runtime) {
    if (laneRetirement) throw new Error("Cursor lane retirement requires a new captured recovery boundary.");
    return null; // Older deliveries may have no captured native runtime.
  }
  if (laneRetirement) {
    laneRetirement = cursorLaneRetirementSchema.parse(laneRetirement);
    if (laneRetirement.entry_id !== turn.agent_id || laneRetirement.room_id !== turn.room_id
      || laneRetirement.work_attempt_id !== turn.work_attempt_id
      || laneRetirement.provider_continuation_id !== turn.provider_continuation_id
      || !database.prepare(`SELECT 1 FROM worker_execution_bindings WHERE entry_id=? AND room_id=?
        AND work_attempt_id=? AND execution_generation_id=? AND agent_session_id=? AND api_url=? AND grant_id=? AND agent_key=?`)
        .get(laneRetirement.entry_id, laneRetirement.room_id, laneRetirement.work_attempt_id,
          laneRetirement.execution_generation_id, laneRetirement.agent_session_id, laneRetirement.api_url,
          laneRetirement.grant_id, laneRetirement.agent_key)) {
      throw new Error("Cursor lane retirement lost its exact worker authority.");
    }
  }
  const runtimeId = runtime.runtime_generation_id;
  if (pendingRuntimeRecovery(database, turn.agent_id)) throw new Error("A different runtime recovery is already recorded.");
  if (recoveredRuntime(database, turn.agent_id, runtimeId)) {
    if (laneRetirement) throw new Error("Cursor lane retirement cannot rewrite an archived recovery boundary.");
    return runtimeId;
  }
  const observer = database.prepare(`SELECT * FROM execution_observers
    WHERE agent_id=? AND observer_runtime_generation_id=?`).get(turn.agent_id, runtimeId);
  // Retain the old cursor, including missing events. Recovery permits a new
  // process to start; it never turns the crashed turn into a native success.
  const ref: DaemonProviderRuntimeReference = { work_attempt_id: turn.work_attempt_id,
    execution_generation_id: turn.origin_execution_generation_id,
    provider_continuation_id: turn.provider_continuation_id, provider_connection: null };
  database.prepare(`INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,?,'complete',?,?,?,?)`)
    .run(executionStorageIdentity("cursor-recovery", turn.agent_id, runtimeId), turn.agent_id, turn.room_id,
      turn.origin_execution_generation_id, runtimeId, "fresh", JSON.stringify({ ...ref, ...(laneRetirement ? { cursor_lane_retirement: laneRetirement } : {}) }), observer ? JSON.stringify(observer) : null, at, at);
  database.prepare(`UPDATE execution_observers SET observer_epoch=observer_epoch+1
    WHERE agent_id=? AND observer_runtime_generation_id=?`).run(turn.agent_id, runtimeId);
  database.prepare(`UPDATE execution_runtime_generations SET runtime_state='exited',control_state='lost',
    ended_at_ms=MAX(created_at_ms,?) WHERE agent_id=? AND runtime_generation_id=? AND runtime_state<>'exited'`).run(Date.parse(at), turn.agent_id, runtimeId);
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

/**
 * Where an agent's current record window starts in the journal: after the
 * last fact recorded before its latest recovery boundary, or at the beginning.
 * A boundary closes the window before it. Those facts stay where they are,
 * incomplete as they were left, and stop counting toward what the agent may
 * retain. Without this a record that had filled up refused the first fact of
 * every later runtime, boundary or not, and that agent could never be
 * recorded, and so never take a message, again.
 */
export function executionRecordWindowStart(database: DatabaseSync, agentId: string): number {
  if (!runtimeRecoveryStorageAvailable(database)) return 0;
  // Only a boundary that has been reached holds the observer it archived.
  const boundary = database.prepare(`SELECT MAX(CAST(json_extract(observer_json,'$.observer_epoch') AS INTEGER)) AS epoch
    FROM agent_runtime_recoveries WHERE agent_id=? AND observer_json IS NOT NULL`)
    .get(agentId) as { epoch: number | null } | undefined;
  const epoch = Number(boundary?.epoch ?? 0);
  if (!Number.isSafeInteger(epoch) || epoch < 1) return 0;
  // Newest first: the scan ends at the first fact from before the boundary.
  const last = database.prepare(`SELECT sequence FROM execution_facts INDEXED BY execution_facts_agent_sequence
    WHERE agent_id=? AND observer_epoch<=? ORDER BY sequence DESC LIMIT 1`).get(agentId, epoch) as { sequence: number } | undefined;
  return Number(last?.sequence ?? 0);
}

/** Standalone retained-history databases may predate operational recovery. */
export function runtimeRecoveryStorageAvailable(database: DatabaseSync): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runtime_recoveries'").get());
}
