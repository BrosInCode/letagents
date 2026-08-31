import { createHash } from "node:crypto";
import { assertNoPollingActivation } from "./custodial-polling-activation.js";
import type { DatabaseSync } from "node:sqlite";
import type { NativeTurnBoundary } from "../shared/execution-protocol.js";
import { sameProviderActionConnectionIdentity, type ProviderActionHandle } from "./provider-action-port.js";
import { readDurableNativeFailure } from "./supervised-agent-history-retention.js";
import type { SupervisedInboxItem } from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "./types.js";

type Row = Record<string, unknown>;
export type DeliveryDrainRecord = {
  operation_id: string; request_id: string; agent_id: string; execution_generation_id: string;
  target_turn_id: string | null; predecessor_operation_id: string | null;
  from_mode: "daemon_inbox" | "mcp_polling"; to_mode: "daemon_inbox" | "mcp_polling";
  strategy: "drain" | "force";
  phase: "prepared" | "draining" | "dispatching" | "uncertain" | "complete" | "cancelled" | "failed";
  authority_version: 1 | null; room_id: string | null; work_attempt_id: string | null;
  provider: string | null; native_continuation_id: string | null; native_connection_kind: string | null;
  native_connection_sha256: string | null; native_pid: number | null; native_process_identity: string | null;
  native_target_turn_id: string | null; admitted_inbox_item_id: string | null;
  admitted_source_message_id: string | null; admitted_action_id: string | null;
  created_at_ms: number; updated_at_ms: number;
};
export type PrepareDeliveryDrain = {
  requestId: string; operationId: string; agentId: string; roomId: string; executionGenerationId: string;
  /** The caller authenticates this owned handle and obtains the boundary through the provider port. */
  handle: ProviderActionHandle;
  boundary: NativeTurnBoundary;
};
export type DeliveryDrainReadiness = {
  cutover: DeliveryDrainRecord; status: "waiting" | "queued" | "ready"; cursor: string | null;
};
export type DispatchDeliveryDrain = Pick<PrepareDeliveryDrain, "operationId" | "agentId" | "handle" | "boundary">;

export function readDeliveryDrain(database: DatabaseSync, operationId: string): DeliveryDrainRecord | null {
  return database.prepare("SELECT * FROM execution_cutover_v2 WHERE operation_id=?").get(operationId) as DeliveryDrainRecord | undefined ?? null;
}

export function unresolvedDeliveryDrain(database: DatabaseSync, agentId: string): DeliveryDrainRecord | null {
  return database.prepare("SELECT * FROM execution_cutover_v2 WHERE agent_id=? AND phase NOT IN ('complete','cancelled','failed') LIMIT 1")
    .get(agentId) as DeliveryDrainRecord | undefined ?? null;
}

export function assertNoDeliveryDrain(database: DatabaseSync, agentId: string): void {
  if (unresolvedDeliveryDrain(database, agentId)) throw new Error("An unresolved delivery drain blocks this new operation.");
}

/** Stop intent is durable: neither ingress nor a successor runtime may restart it. */
export function deliveryDrainBlocksRuntime(record: DeliveryDrainRecord | null): boolean {
  return record?.phase === "dispatching" || record?.phase === "uncertain";
}

/** Called inside each ingress writer, not only before an asynchronous poll. */
export function assertDeliveryDrainIngressAllowed(database: DatabaseSync, agentId: string): void {
  if (deliveryDrainBlocksRuntime(unresolvedDeliveryDrain(database, agentId))
    || database.prepare("SELECT 1 FROM agent_configurations WHERE agent_id=? AND polling_contract='custodial_polling_v1'").get(agentId)) {
    throw new Error("Delivery drain freezes daemon inbox ingress.");
  }
}

/** Admission only: never gate A's terminal checkpoint, effects, or reply publication. */
export function deliveryDrainAllowsAdmission(database: DatabaseSync, item: Pick<SupervisedInboxItem,
  "agent_id" | "room_id" | "inbox_item_id" | "source_message_id" | "action_id" | "state" | "provider_turn_id">): boolean {
  const drain = unresolvedDeliveryDrain(database, item.agent_id);
  if (!drain) return true;
  if (drain.authority_version !== 1 || drain.strategy !== "drain" || drain.from_mode !== "daemon_inbox"
    || !["prepared", "draining"].includes(drain.phase)
    || drain.room_id !== item.room_id || drain.admitted_inbox_item_id !== item.inbox_item_id
    || drain.admitted_source_message_id !== item.source_message_id || drain.admitted_action_id !== item.action_id) return false;
  // claimHead committed this invocation before the drain transaction. A
  // pre-dispatch failure resets it to pending, which must not create a replay.
  if (!item.provider_turn_id) return item.state === "dispatching";
  return Boolean(database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
    WHERE inbox_item_id=? AND agent_id=? AND room_id=? AND provider_turn_id=?
      AND work_attempt_id=? AND origin_execution_generation_id=? AND provider_continuation_id=?`)
    .get(item.inbox_item_id, item.agent_id, item.room_id, item.provider_turn_id,
      drain.work_attempt_id, drain.execution_generation_id, drain.native_continuation_id));
}

/** Runs inside the manifest writer's BEGIN IMMEDIATE, shared with FIFO claims. */
export function prepareDeliveryDrain(database: DatabaseSync, input: PrepareDeliveryDrain, current: DaemonManifestEntry | undefined): { created: boolean; cutover: DeliveryDrainRecord } {
  if (!database.isTransaction) throw new Error("Delivery drain requires an admission transaction.");
  const { handle, boundary } = input;
  for (const value of [input.requestId, input.operationId, input.agentId, input.roomId, input.executionGenerationId, handle.workAttemptId]) {
    if (!value.trim()) throw new Error("Delivery drain requires exact non-empty coordinates.");
  }
  const connection = handle.providerConnection;
  if (connection?.kind !== "codex_app_server" || !sameProviderActionConnectionIdentity(connection, connection)
    || handle.pid !== connection.pid || !handle.providerContinuationId?.trim()
    || boundary.state === "unknown" || boundary.providerContinuationId !== handle.providerContinuationId
    || boundary.nativeProcessIdentity !== connection.processIdentity) {
    throw new Error("Delivery drain requires an authenticated Codex native boundary.");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    connection.kind, connection.url, connection.pid, connection.processIdentity,
  ])).digest("hex");
  const prior = database.prepare("SELECT operation_id FROM execution_cutover_v2 WHERE request_id=?").get(input.requestId) as Row | undefined;
  if (prior) {
    const cutover = readDeliveryDrain(database, String(prior.operation_id))!;
    if (cutover.operation_id !== input.operationId || cutover.agent_id !== input.agentId
      || cutover.room_id !== input.roomId || cutover.execution_generation_id !== input.executionGenerationId
      || cutover.authority_version !== 1 || cutover.strategy !== "drain" || cutover.from_mode !== "daemon_inbox"
      || cutover.to_mode !== "mcp_polling" || cutover.predecessor_operation_id !== null
      || cutover.work_attempt_id !== handle.workAttemptId || cutover.native_continuation_id !== handle.providerContinuationId
      || cutover.native_connection_sha256 !== digest
      || (boundary.state === "active" && cutover.native_target_turn_id !== boundary.providerTurnId)) {
      throw new Error("Delivery drain request id is already bound to different coordinates.");
    }
    return { created: false, cutover };
  }
  if (!current || current.id !== input.agentId || current.room_id !== input.roomId
    || current.provider !== "codex" || current.delivery_mode !== "daemon_inbox"
    || current.desired_state !== "running" || current.condition !== "none"
    || current.work_attempt_id !== handle.workAttemptId || current.provider_ref?.work_attempt_id !== handle.workAttemptId
    || current.provider_ref?.execution_generation_id !== input.executionGenerationId
    || current.provider_ref.provider_continuation_id !== handle.providerContinuationId
    || !sameProviderActionConnectionIdentity(current.provider_ref.provider_connection, connection)
    || !database.prepare("SELECT 1 FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=? AND terminal_json IS NULL")
      .get(input.executionGenerationId, handle.workAttemptId)) {
    throw new Error("Delivery drain lost its exact execution authority.");
  }
  const configuration = database.prepare("SELECT config_revision,runtime_configuration_revision FROM agent_configurations WHERE agent_id=?")
    .get(input.agentId) as Row;
  if (configuration.config_revision !== configuration.runtime_configuration_revision
    || (handle.appliedConfigurationRevision !== undefined && handle.appliedConfigurationRevision !== configuration.runtime_configuration_revision)) {
    throw new Error("Delivery drain requires the current applied provider configuration.");
  }
  assertNoDeliveryDrain(database, input.agentId);
  assertNoPollingActivation(database, input.agentId);
  if (current.delivery_cutover
    || database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain')").get(input.agentId)
    || database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed')").get(input.agentId)
    || database.prepare("SELECT 1 FROM provider_continuation_repairs WHERE agent_id=? AND phase NOT IN ('committed','failed')").get(input.agentId)) {
    throw new Error("Delivery drain conflicts with an unresolved control operation.");
  }
  const head = database.prepare(`SELECT * FROM supervised_agent_inbox WHERE agent_id=?
    AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
    ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
  let admitted: Row | undefined;
  let nativeTurn: string | null = null;
  if (head && (head.provider_turn_id !== null || head.outcome !== null || ["dispatching", "awaiting_result", "result_recovery", "publishing"].includes(String(head.state)))) {
    if (head.room_id !== input.roomId) throw new Error("Delivery drain FIFO head belongs to a different room.");
    if (head.provider_turn_id !== null) {
      const binding = database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
        WHERE inbox_item_id=? AND agent_id=? AND room_id=? AND provider_turn_id=?
          AND work_attempt_id=? AND origin_execution_generation_id=? AND provider_continuation_id=?`)
        .get(String(head.inbox_item_id), input.agentId, input.roomId, String(head.provider_turn_id),
          handle.workAttemptId, input.executionGenerationId, handle.providerContinuationId);
      if (!binding) throw new Error("Delivery drain cannot authenticate the admitted provider turn.");
      nativeTurn = String(head.provider_turn_id);
    } else if (head.state !== "dispatching" || head.outcome !== null) {
      throw new Error("Delivery drain cannot authenticate unbound recovery or publication.");
    }
    admitted = head;
  }
  if (boundary.state === "active" && (!boundary.providerTurnId.trim() || boundary.providerTurnId !== nativeTurn)) {
    throw new Error("Delivery drain native boundary does not match the admitted turn.");
  }
  const now = Date.now();
  database.prepare(`INSERT INTO execution_cutover_v2
    (operation_id,request_id,agent_id,execution_generation_id,target_turn_id,predecessor_operation_id,
      from_mode,to_mode,strategy,phase,created_at_ms,updated_at_ms,authority_version,room_id,work_attempt_id,provider,
      native_continuation_id,native_connection_kind,native_connection_sha256,native_pid,native_process_identity,
      native_target_turn_id,admitted_inbox_item_id,admitted_source_message_id,admitted_action_id)
    VALUES (?,?,?,?,NULL,NULL,'daemon_inbox','mcp_polling','drain','draining',?,?,1,?,?,'codex',?,?,?,?,?,?,?,?,?)`)
    .run(input.operationId, input.requestId, input.agentId, input.executionGenerationId, now, now, input.roomId,
      handle.workAttemptId, handle.providerContinuationId, connection.kind, digest, connection.pid!, connection.processIdentity!,
      nativeTurn, admitted ? String(admitted.inbox_item_id) : null, admitted ? String(admitted.source_message_id) : null,
      admitted ? String(admitted.action_id) : null);
  return { created: true, cutover: readDeliveryDrain(database, input.operationId)! };
}

export function cancelDeliveryDrain(database: DatabaseSync, input: { operationId: string; agentId: string }): DeliveryDrainRecord {
  if (!database.isTransaction) throw new Error("Delivery drain cancellation requires a transaction.");
  const current = readDeliveryDrain(database, input.operationId);
  if (!current || current.agent_id !== input.agentId || current.authority_version !== 1 || current.strategy !== "drain"
    || !["prepared", "draining", "cancelled"].includes(current.phase)) {
    throw new Error("Delivery drain cannot be cancelled without exact pre-dispatch authority.");
  }
  if (current.phase !== "cancelled") database.prepare("UPDATE execution_cutover_v2 SET phase='cancelled',updated_at_ms=? WHERE operation_id=?")
    .run(Math.max(Date.now(), current.updated_at_ms), input.operationId);
  return readDeliveryDrain(database, input.operationId)!;
}

function reverseDrain(database: DatabaseSync, operationId: string, agentId?: string): DeliveryDrainRecord {
  const cutover = readDeliveryDrain(database, operationId);
  if (!cutover || (agentId !== undefined && cutover.agent_id !== agentId)
    || cutover.authority_version !== 1 || cutover.provider !== "codex" || cutover.strategy !== "drain"
    || cutover.from_mode !== "daemon_inbox" || cutover.to_mode !== "mcp_polling"
    || cutover.predecessor_operation_id !== null) throw new Error("Delivery drain has no exact reverse authority.");
  return cutover;
}

function assertCurrentReverseAuthority(database: DatabaseSync, cutover: DeliveryDrainRecord, current: DaemonManifestEntry | undefined, allowDetached = false): void {
  const ref = current?.provider_ref;
  const connection = ref?.provider_connection;
  const digest = connection?.kind === "codex_app_server" ? createHash("sha256").update(JSON.stringify([
    connection.kind, connection.url, connection.pid, connection.processIdentity,
  ])).digest("hex") : null;
  const execution = database.prepare("SELECT generation FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?")
    .get(cutover.execution_generation_id, cutover.work_attempt_id) as Row | undefined;
  if (!current || current.id !== cutover.agent_id || current.room_id !== cutover.room_id
    || current.provider !== cutover.provider || current.delivery_mode !== "daemon_inbox"
    || current.desired_state !== "running" || current.condition !== "none"
    || current.work_attempt_id !== cutover.work_attempt_id
    || (!(allowDetached && ref == null) && (ref?.work_attempt_id !== cutover.work_attempt_id
      || ref.execution_generation_id !== cutover.execution_generation_id
      || ref.provider_continuation_id !== cutover.native_continuation_id || digest !== cutover.native_connection_sha256
      || connection?.pid !== cutover.native_pid || connection?.processIdentity !== cutover.native_process_identity))
    || !execution || database.prepare("SELECT 1 FROM work_attempt_executions WHERE work_attempt_id=? AND generation>? LIMIT 1")
      .get(cutover.work_attempt_id, Number(execution.generation))) {
    throw new Error("Delivery drain lost its exact execution authority.");
  }
  const config = database.prepare("SELECT config_revision,runtime_configuration_revision,polling_contract FROM agent_configurations WHERE agent_id=?")
    .get(cutover.agent_id) as Row;
  if (config.polling_contract !== null || config.config_revision !== config.runtime_configuration_revision) {
    throw new Error("Delivery drain requires the current applied provider configuration.");
  }
  if (current.delivery_cutover
    || database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain')").get(cutover.agent_id)
    || database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed')").get(cutover.agent_id)
    || database.prepare("SELECT 1 FROM provider_continuation_repairs WHERE agent_id=? AND phase NOT IN ('committed','failed')").get(cutover.agent_id)) {
    throw new Error("Delivery drain conflicts with an unresolved control operation.");
  }
}

function assertAdmittedReceipt(database: DatabaseSync, cutover: DeliveryDrainRecord, item: Row): void {
  const binding = database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
    WHERE inbox_item_id=? AND agent_id=? AND room_id=? AND work_attempt_id=? AND origin_execution_generation_id=?
      AND provider_continuation_id=? AND provider_turn_id=?`).get(cutover.admitted_inbox_item_id, cutover.agent_id,
    cutover.room_id, cutover.work_attempt_id, cutover.execution_generation_id, cutover.native_continuation_id,
    item.provider_turn_id as string | null);
  if (!binding || item.terminal_reason !== null || typeof item.acknowledged_at !== "string"
    || !Number.isFinite(Date.parse(item.acknowledged_at))) throw new Error("Delivery drain admitted turn has no exact terminal receipt.");
  const failure = readDurableNativeFailure(database, String(item.inbox_item_id));
  if (item.state === "acknowledged_failed" && failure) return;
  if (failure) throw new Error("Delivery drain admitted failure does not match its receipt.");
  if (item.state === "cancelled_by_user") return;
  let outcome: { kind?: unknown; text?: unknown; evidence?: unknown } | null = null;
  try { outcome = item.outcome ? JSON.parse(String(item.outcome)) : null; } catch { /* Fail closed below. */ }
  const terminal = database.prepare(`SELECT agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source
    FROM supervised_agent_terminal_results WHERE inbox_item_id=?`).get(String(item.inbox_item_id)) as Row | undefined;
  if (!outcome || !terminal || terminal.agent_id !== cutover.agent_id
    || terminal.execution_generation_id !== cutover.execution_generation_id || terminal.provider_turn_id !== item.provider_turn_id
    || terminal.outcome !== outcome.kind || terminal.normalized_text !== outcome.text || terminal.evidence_source !== outcome.evidence) {
    throw new Error("Delivery drain admitted turn has no exact terminal receipt.");
  }
  if (item.state === "acknowledged_no_reply" && outcome.kind === "no_reply" && outcome.text === null) return;
  if (item.state === "acknowledged" && outcome.kind === "reply" && typeof outcome.text === "string" && outcome.text.trim()
    && database.prepare(`SELECT 1 FROM supervised_agent_publications
      WHERE inbox_item_id=? AND agent_id=? AND room_id=? AND client_message_id=? AND length(trim(canonical_message_id))>0`)
      .get(String(item.inbox_item_id), cutover.agent_id, cutover.room_id, String(item.reply_client_message_id))) return;
  throw new Error("Delivery drain admitted turn has no exact terminal receipt.");
}

/** One bounded snapshot; readiness never changes receipts or advances a cursor. */
export function deliveryDrainReadiness(database: DatabaseSync, operationId: string): DeliveryDrainReadiness {
  const cutover = reverseDrain(database, operationId);
  const cursorRow = database.prepare("SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?")
    .get(cutover.agent_id) as Row | undefined;
  if (cursorRow && cursorRow.room_id !== cutover.room_id) throw new Error("Delivery drain ingress cursor belongs to another room.");
  const cursor = cursorRow?.last_observed_message_id as string | null | undefined ?? null;
  const unfinished = "state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')";
  const other = database.prepare(`SELECT 1 FROM supervised_agent_inbox WHERE agent_id=? AND ${unfinished}
    AND (? IS NULL OR inbox_item_id<>?) LIMIT 1`).get(cutover.agent_id, cutover.admitted_inbox_item_id, cutover.admitted_inbox_item_id);
  if (other) return { cutover, status: "queued", cursor };
  if (cutover.admitted_inbox_item_id) {
    const item = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(cutover.admitted_inbox_item_id) as Row | undefined;
    if (!item || item.agent_id !== cutover.agent_id || item.room_id !== cutover.room_id
      || item.source_message_id !== cutover.admitted_source_message_id || item.action_id !== cutover.admitted_action_id) {
      throw new Error("Delivery drain lost its exact admitted inbox item.");
    }
    if (!["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"].includes(String(item.state))) {
      return { cutover, status: deliveryDrainAllowsAdmission(database, item as unknown as SupervisedInboxItem) ? "waiting" : "queued", cursor };
    }
    assertAdmittedReceipt(database, cutover, item);
  }
  const effects = database.prepare(`SELECT 1 FROM supervised_agent_effects WHERE agent_id=? AND state IN ('prepared','executing','uncertain')
    UNION ALL SELECT 1 FROM supervised_agent_effect_tombstones WHERE agent_id=? AND state='uncertain' LIMIT 1`)
    .get(cutover.agent_id, cutover.agent_id);
  return { cutover, status: effects ? "waiting" : "ready", cursor };
}

function requireReadyCursor(database: DatabaseSync, operationId: string): string {
  const ready = deliveryDrainReadiness(database, operationId);
  if (ready.status !== "ready") throw new Error("Delivery drain cannot dispatch or commit with unsettled inbox work or effects.");
  if (ready.cursor === null || !/^(?:msg_)?\d+$/.test(ready.cursor)) throw new Error("Delivery drain requires an exact numeric ingress cursor.");
  return ready.cursor;
}

/** The caller has joined ingress and authenticated native idle before this transaction. */
export function markDeliveryDrainDispatch(database: DatabaseSync, input: DispatchDeliveryDrain, current: DaemonManifestEntry | undefined): DeliveryDrainRecord {
  if (!database.isTransaction) throw new Error("Delivery drain requires a dispatch transaction.");
  const cutover = reverseDrain(database, input.operationId, input.agentId);
  if (!["prepared", "draining", "dispatching", "uncertain"].includes(cutover.phase)) throw new Error("Delivery drain cannot dispatch from its current phase.");
  assertCurrentReverseAuthority(database, cutover, current);
  const connection = input.handle.providerConnection;
  if (input.boundary.state !== "idle" || input.boundary.providerContinuationId !== cutover.native_continuation_id
    || input.boundary.nativeProcessIdentity !== cutover.native_process_identity
    || input.handle.workAttemptId !== cutover.work_attempt_id || input.handle.providerContinuationId !== cutover.native_continuation_id
    || input.handle.pid !== cutover.native_pid || !sameProviderActionConnectionIdentity(current!.provider_ref!.provider_connection, connection)
    || (input.handle.appliedConfigurationRevision !== undefined && input.handle.appliedConfigurationRevision !==
      (database.prepare("SELECT runtime_configuration_revision FROM agent_configurations WHERE agent_id=?").get(cutover.agent_id) as Row).runtime_configuration_revision)) {
    throw new Error("Delivery drain requires its exact authenticated native idle boundary.");
  }
  requireReadyCursor(database, input.operationId);
  if (deliveryDrainBlocksRuntime(cutover)) return cutover;
  database.prepare("UPDATE execution_cutover_v2 SET phase='dispatching',updated_at_ms=? WHERE operation_id=?")
    .run(Math.max(Date.now(), cutover.updated_at_ms), input.operationId);
  return readDeliveryDrain(database, input.operationId)!;
}

export function markDeliveryDrainUncertain(database: DatabaseSync, input: { operationId: string; agentId: string }): DeliveryDrainRecord {
  if (!database.isTransaction) throw new Error("Delivery drain requires an uncertainty transaction.");
  const cutover = reverseDrain(database, input.operationId, input.agentId);
  if (!deliveryDrainBlocksRuntime(cutover)) throw new Error("Delivery drain has no durable stop intent.");
  if (cutover.phase === "uncertain") return cutover;
  database.prepare("UPDATE execution_cutover_v2 SET phase='uncertain',updated_at_ms=? WHERE operation_id=?")
    .run(Math.max(Date.now(), cutover.updated_at_ms), input.operationId);
  return readDeliveryDrain(database, input.operationId)!;
}

/** Called only through ManifestStore's required host-death/ownership commit fence.
 * A terminal_json value alone is never process-death proof. No provider is launched here. */
export function commitDeliveryDrain(database: DatabaseSync, input: { operationId: string; agentId: string }, current: DaemonManifestEntry | undefined): DeliveryDrainRecord {
  if (!database.isTransaction) throw new Error("Delivery drain requires an authority transaction.");
  const cutover = reverseDrain(database, input.operationId, input.agentId);
  if (!deliveryDrainBlocksRuntime(cutover)) throw new Error("Delivery drain has no durable stop intent.");
  // The exact old process exit callback may already have detached its handle.
  // No successor execution may exist, and the caller's host fence still proves
  // the journal's immutable old PID/birth, never this nullable projection.
  assertCurrentReverseAuthority(database, cutover, current, true);
  const cursor = requireReadyCursor(database, input.operationId);
  const binding = database.prepare("SELECT room_id,work_attempt_id,execution_generation_id FROM worker_session_bindings WHERE entry_id=?")
    .get(cutover.agent_id) as Row | undefined;
  if (binding && (binding.room_id !== cutover.room_id || binding.work_attempt_id !== cutover.work_attempt_id
    || binding.execution_generation_id !== cutover.execution_generation_id)) throw new Error("Delivery drain worker binding changed before cursor transfer.");
  const timestamp = new Date().toISOString();
  if (binding) database.prepare("UPDATE worker_session_bindings SET room_cursor=?,updated_at=? WHERE entry_id=?")
    .run(cursor, timestamp, cutover.agent_id);
  database.prepare(`INSERT INTO work_attempt_checkpoints(work_attempt_id,sort_order,at,room_cursor,provider_continuation_id)
    SELECT ?,COALESCE(MAX(sort_order),-1)+1,?,?,? FROM work_attempt_checkpoints WHERE work_attempt_id=?`)
    .run(cutover.work_attempt_id, timestamp, cursor, cutover.native_continuation_id, cutover.work_attempt_id);
  database.prepare(`UPDATE agent_configurations SET delivery_mode='mcp_polling',polling_contract='custodial_polling_v1',
    config_revision=config_revision+1 WHERE agent_id=?`).run(cutover.agent_id);
  database.prepare("UPDATE execution_cutover_v2 SET phase='complete',updated_at_ms=? WHERE operation_id=?")
    .run(Math.max(Date.now(), cutover.updated_at_ms), input.operationId);
  return readDeliveryDrain(database, input.operationId)!;
}
