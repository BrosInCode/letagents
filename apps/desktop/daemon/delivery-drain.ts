import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NativeTurnBoundary } from "../shared/execution-protocol.js";
import { sameProviderActionConnectionIdentity, type ProviderActionHandle } from "./provider-action-port.js";
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
