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
export type PrepareCustodialForward = PrepareDeliveryDrain & { reverseOperationId: string };
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
  return prepareOwnedDrain(database, input, current, null);
}

/** Undo only a completed reverse whose custodial runtime has never activated. */
export function prepareCustodialForward(database: DatabaseSync, input: PrepareCustodialForward, current: DaemonManifestEntry | undefined): { created: boolean; cutover: DeliveryDrainRecord } {
  if (!input.reverseOperationId.trim()) throw new Error("Custodial forward requires an exact reverse predecessor.");
  return prepareOwnedDrain(database, input, current, input.reverseOperationId);
}

function prepareOwnedDrain(database: DatabaseSync, input: PrepareDeliveryDrain, current: DaemonManifestEntry | undefined,
  reverseOperationId: string | null): { created: boolean; cutover: DeliveryDrainRecord } {
  if (!database.isTransaction) throw new Error("Delivery drain requires an admission transaction.");
  const { handle, boundary } = input;
  const forward = reverseOperationId !== null;
  const fromMode = forward ? "mcp_polling" : "daemon_inbox";
  const toMode = forward ? "daemon_inbox" : "mcp_polling";
  for (const value of [input.requestId, input.operationId, input.agentId, input.roomId, input.executionGenerationId, handle.workAttemptId]) {
    if (!value.trim()) throw new Error("Delivery drain requires exact non-empty coordinates.");
  }
  const connection = handle.providerConnection;
  if (connection?.kind !== "codex_app_server" || !sameProviderActionConnectionIdentity(connection, connection)
    || handle.pid !== connection.pid || !handle.providerContinuationId?.trim()
    || boundary.state === "unknown" || (forward && boundary.state !== "idle") || boundary.providerContinuationId !== handle.providerContinuationId
    || boundary.nativeProcessIdentity !== connection.processIdentity) {
    throw new Error("Delivery drain requires an authenticated Codex native boundary.");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    connection.kind, connection.url, connection.pid, connection.processIdentity,
  ])).digest("hex");
  const prior = database.prepare("SELECT operation_id FROM execution_cutover_v2 WHERE request_id=? OR operation_id=? LIMIT 1").get(input.requestId, input.operationId) as Row | undefined;
  if (prior) {
    const cutover = readDeliveryDrain(database, String(prior.operation_id))!;
    if (cutover.operation_id !== input.operationId || cutover.request_id !== input.requestId || cutover.agent_id !== input.agentId
      || cutover.room_id !== input.roomId || cutover.execution_generation_id !== input.executionGenerationId
      || cutover.authority_version !== 1 || cutover.strategy !== "drain" || cutover.from_mode !== fromMode
      || cutover.to_mode !== toMode || cutover.predecessor_operation_id !== reverseOperationId
      || cutover.work_attempt_id !== handle.workAttemptId || cutover.native_continuation_id !== handle.providerContinuationId
      || cutover.native_connection_sha256 !== digest
      || (boundary.state === "active" && cutover.native_target_turn_id !== boundary.providerTurnId)) {
      throw new Error("Delivery drain request id is already bound to different coordinates.");
    }
    return { created: false, cutover };
  }
  if (!current || current.id !== input.agentId || current.room_id !== input.roomId
    || current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== fromMode
    || current.desired_state !== "running" || current.condition !== "none"
    || current.work_attempt_id !== handle.workAttemptId || current.provider_ref?.work_attempt_id !== handle.workAttemptId
    || current.provider_ref?.execution_generation_id !== input.executionGenerationId
    || current.provider_ref.provider_continuation_id !== handle.providerContinuationId
    || !sameProviderActionConnectionIdentity(current.provider_ref.provider_connection, connection)
    || !database.prepare("SELECT 1 FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=? AND terminal_json IS NULL")
      .get(input.executionGenerationId, handle.workAttemptId)) {
    throw new Error("Delivery drain lost its exact execution authority.");
  }
  const configuration = database.prepare("SELECT config_revision,runtime_configuration_revision,polling_contract FROM agent_configurations WHERE agent_id=?")
    .get(input.agentId) as Row;
  if (configuration.config_revision !== configuration.runtime_configuration_revision
    || (forward && configuration.polling_contract !== "custodial_polling_v1")
    || (forward && handle.custodyLaunchAgentSessionId !== undefined
      && handle.custodyLaunchAgentSessionId !== current.provider_ref.custodial_launch_agent_session_id)
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
  const cutover: DeliveryDrainRecord = { operation_id: input.operationId, request_id: input.requestId, agent_id: input.agentId,
    execution_generation_id: input.executionGenerationId, target_turn_id: null, predecessor_operation_id: reverseOperationId,
    from_mode: fromMode, to_mode: toMode, strategy: "drain", phase: "draining", created_at_ms: now, updated_at_ms: now,
    authority_version: 1, room_id: input.roomId, work_attempt_id: handle.workAttemptId, provider: "codex",
    native_continuation_id: handle.providerContinuationId, native_connection_kind: connection.kind, native_connection_sha256: digest,
    native_pid: connection.pid!, native_process_identity: connection.processIdentity!, native_target_turn_id: nativeTurn,
    admitted_inbox_item_id: admitted ? String(admitted.inbox_item_id) : null,
    admitted_source_message_id: admitted ? String(admitted.source_message_id) : null,
    admitted_action_id: admitted ? String(admitted.action_id) : null };
  if (forward) {
    assertCustodialPreActivation(database, cutover);
    if (head || unsettledEffects(database, input.agentId)) throw new Error("Custodial forward requires no pending inbox work or effects.");
    custodialAckCursor(database, cutover);
  }
  database.prepare(`INSERT INTO execution_cutover_v2(${Object.keys(cutover).join(",")}) VALUES(${Object.keys(cutover).map(() => "?").join(",")})`)
    .run(...Object.values(cutover));
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

function ownedDrain(database: DatabaseSync, operationId: string, agentId?: string): DeliveryDrainRecord {
  const cutover = readDeliveryDrain(database, operationId);
  if (!cutover || (agentId !== undefined && cutover.agent_id !== agentId)
    || cutover.authority_version !== 1 || cutover.provider !== "codex" || cutover.strategy !== "drain"
    || !((cutover.from_mode === "daemon_inbox" && cutover.to_mode === "mcp_polling" && cutover.predecessor_operation_id === null)
      || (cutover.from_mode === "mcp_polling" && cutover.to_mode === "daemon_inbox" && cutover.predecessor_operation_id !== null
        && cutover.native_target_turn_id === null && cutover.admitted_inbox_item_id === null))) throw new Error("Delivery drain has no exact native authority.");
  return cutover;
}

function assertCurrentDrainAuthority(database: DatabaseSync, cutover: DeliveryDrainRecord, current: DaemonManifestEntry | undefined, allowDetached = false): void {
  const forward = cutover.from_mode === "mcp_polling";
  const ref = current?.provider_ref;
  const connection = ref?.provider_connection;
  const digest = connection?.kind === "codex_app_server" ? createHash("sha256").update(JSON.stringify([
    connection.kind, connection.url, connection.pid, connection.processIdentity,
  ])).digest("hex") : null;
  const execution = database.prepare("SELECT generation FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?")
    .get(cutover.execution_generation_id, cutover.work_attempt_id) as Row | undefined;
  if (!current || current.id !== cutover.agent_id || current.room_id !== cutover.room_id
    || current.provider !== cutover.provider || (current.delivery_mode ?? "mcp_polling") !== cutover.from_mode
    || current.desired_state !== "running" || current.condition !== "none"
    || current.work_attempt_id !== cutover.work_attempt_id
    || (!(allowDetached && !forward && ref == null) && (ref?.work_attempt_id !== cutover.work_attempt_id
      || ref.execution_generation_id !== cutover.execution_generation_id
      || ref.provider_continuation_id !== cutover.native_continuation_id || digest !== cutover.native_connection_sha256
      || connection?.pid !== cutover.native_pid || connection?.processIdentity !== cutover.native_process_identity))
    || !execution || database.prepare("SELECT 1 FROM work_attempt_executions WHERE work_attempt_id=? AND generation>? LIMIT 1")
      .get(cutover.work_attempt_id, Number(execution.generation))) {
    throw new Error("Delivery drain lost its exact execution authority.");
  }
  const config = database.prepare("SELECT config_revision,runtime_configuration_revision,polling_contract FROM agent_configurations WHERE agent_id=?")
    .get(cutover.agent_id) as Row;
  if (config.polling_contract !== (forward ? "custodial_polling_v1" : null) || config.config_revision !== config.runtime_configuration_revision) {
    throw new Error("Delivery drain requires the current applied provider configuration.");
  }
  if (forward) { assertCustodialPreActivation(database, cutover); custodialAckCursor(database, cutover); }
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

function assertCustodialPreActivation(database: DatabaseSync, cutover: DeliveryDrainRecord): void {
  const previous = cutover.predecessor_operation_id ? readDeliveryDrain(database, cutover.predecessor_operation_id) : null;
  const priorExecution = previous ? database.prepare("SELECT generation FROM work_attempt_executions WHERE work_attempt_id=? AND execution_generation_id=?")
    .get(previous.work_attempt_id, previous.execution_generation_id) as Row | undefined : undefined;
  const execution = database.prepare("SELECT generation FROM work_attempt_executions WHERE work_attempt_id=? AND execution_generation_id=?")
    .get(cutover.work_attempt_id, cutover.execution_generation_id) as Row | undefined;
  if (!previous || previous.phase !== "complete" || previous.authority_version !== 1 || previous.provider !== "codex"
    || previous.strategy !== "drain" || previous.from_mode !== "daemon_inbox" || previous.to_mode !== "mcp_polling"
    || previous.predecessor_operation_id !== null || previous.agent_id !== cutover.agent_id || previous.room_id !== cutover.room_id
    || previous.work_attempt_id !== cutover.work_attempt_id || !priorExecution || !execution
    || Number(execution.generation) <= Number(priorExecution.generation)
    || database.prepare("SELECT 1 FROM work_attempt_executions WHERE work_attempt_id=? AND generation>? LIMIT 1")
      .get(cutover.work_attempt_id, Number(execution.generation))) {
    throw new Error("Custodial forward requires its completed reverse predecessor and exact successor runtime.");
  }
  if (database.prepare(`SELECT 1 FROM execution_cutover_v2 r LEFT JOIN work_attempt_executions e
      ON e.work_attempt_id=r.work_attempt_id AND e.execution_generation_id=r.execution_generation_id
    WHERE r.agent_id=? AND r.work_attempt_id=? AND r.operation_id<>? AND r.phase='complete' AND r.authority_version=1
      AND r.provider='codex' AND r.from_mode='daemon_inbox' AND r.to_mode='mcp_polling' AND r.strategy='drain'
      AND (e.generation IS NULL OR e.generation>=?) LIMIT 1`).get(cutover.agent_id, cutover.work_attempt_id,
    previous.operation_id, Number(priorExecution.generation))) {
    throw new Error("Custodial forward requires the current reverse predecessor.");
  }
  assertNoPollingActivation(database, cutover.agent_id);
  // Native idle is not proof that a previously dispatched polling batch was
  // acknowledged, or that all remote callbacks finished. This is only an undo
  // before polling activation, across every generation under this predecessor.
  if (database.prepare(`SELECT 1 FROM custodial_polling_activations a LEFT JOIN work_attempt_executions e
      ON e.work_attempt_id=a.work_attempt_id AND e.execution_generation_id=a.execution_generation_id
    WHERE a.phase<>'cancelled' AND (a.reverse_operation_id=? OR (a.agent_id=? AND a.work_attempt_id=?
      AND (e.generation IS NULL OR e.generation>=?))) LIMIT 1`).get(previous.operation_id, cutover.agent_id,
    cutover.work_attempt_id, Number(priorExecution.generation))) throw new Error("Custodial forward is supported only before polling activation.");
}

function numericCursor(value: unknown): bigint | null {
  return typeof value === "string" && /^(?:msg_)?\d+$/.test(value) ? BigInt(value.replace(/^msg_/, "")) : null;
}

/** Read the source ACK under the same SQLite transaction as the authority
 * change. No tail lookup, controller cursor, detached-ref or retained-ID fallback. */
function custodialAckCursor(database: DatabaseSync, cutover: DeliveryDrainRecord): string {
  const binding = database.prepare(`SELECT b.*,d.provider_ref_present,d.provider_work_attempt_id,d.provider_execution_generation_id,
      d.provider_continuation_id,d.provider_connection_kind,d.provider_connection_url,d.provider_connection_pid,
      d.provider_process_identity,d.custodial_launch_agent_session_id
    FROM worker_session_bindings b JOIN runtime_deployments d ON d.agent_id=b.entry_id WHERE b.entry_id=?`).get(cutover.agent_id) as Row | undefined;
  const digest = binding ? createHash("sha256").update(JSON.stringify([binding.provider_connection_kind,
    binding.provider_connection_url, binding.provider_connection_pid, binding.provider_process_identity])).digest("hex") : null;
  if (!binding || binding.room_id !== cutover.room_id || binding.work_attempt_id !== cutover.work_attempt_id
    || binding.execution_generation_id !== cutover.execution_generation_id || binding.provider_ref_present !== 1
    || binding.provider_work_attempt_id !== cutover.work_attempt_id || binding.provider_execution_generation_id !== cutover.execution_generation_id
    || binding.provider_continuation_id !== cutover.native_continuation_id || binding.provider_connection_kind !== "codex_app_server"
    || binding.provider_connection_pid !== cutover.native_pid || binding.provider_process_identity !== cutover.native_process_identity
    || digest !== cutover.native_connection_sha256 || !binding.custodial_launch_agent_session_id
    || binding.custodial_launch_agent_session_id !== binding.agent_session_id) {
    throw new Error("Custodial forward lost its exact native launch and worker binding authority.");
  }
  const ack = numericCursor(binding.room_cursor);
  const ingress = database.prepare("SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?").get(cutover.agent_id) as Row | undefined;
  const checkpoint = database.prepare("SELECT room_cursor FROM work_attempt_checkpoints WHERE work_attempt_id=? AND room_cursor IS NOT NULL ORDER BY sort_order DESC LIMIT 1")
    .get(cutover.work_attempt_id) as Row | undefined;
  const observed = numericCursor(ingress?.last_observed_message_id); const saved = numericCursor(checkpoint?.room_cursor);
  if (ack === null || !ingress || ingress.room_id !== cutover.room_id || observed === null || saved === null || ack < observed || ack < saved) {
    throw new Error("Custodial forward requires a numeric ACK cursor without ingress or checkpoint regression.");
  }
  return String(binding.room_cursor);
}

function unsettledEffects(database: DatabaseSync, agentId: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM supervised_agent_effects WHERE agent_id=? AND state IN ('prepared','executing','uncertain')
    UNION ALL SELECT 1 FROM supervised_agent_effect_tombstones WHERE agent_id=? AND state='uncertain' LIMIT 1`).get(agentId, agentId));
}

/** One bounded snapshot; readiness never changes receipts or advances a cursor. */
export function deliveryDrainReadiness(database: DatabaseSync, operationId: string): DeliveryDrainReadiness {
  const cutover = ownedDrain(database, operationId);
  const cursorRow = database.prepare("SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?")
    .get(cutover.agent_id) as Row | undefined;
  if (cursorRow && cursorRow.room_id !== cutover.room_id) throw new Error("Delivery drain ingress cursor belongs to another room.");
  if (cutover.from_mode === "mcp_polling") assertCustodialPreActivation(database, cutover);
  const cursor = cutover.from_mode === "mcp_polling" ? custodialAckCursor(database, cutover)
    : cursorRow?.last_observed_message_id as string | null | undefined ?? null;
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
  const effects = unsettledEffects(database, cutover.agent_id);
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
  const cutover = ownedDrain(database, input.operationId, input.agentId);
  if (!["prepared", "draining", "dispatching", "uncertain"].includes(cutover.phase)) throw new Error("Delivery drain cannot dispatch from its current phase.");
  assertCurrentDrainAuthority(database, cutover, current);
  const connection = input.handle.providerConnection;
  if (input.boundary.state !== "idle" || input.boundary.providerContinuationId !== cutover.native_continuation_id
    || input.boundary.nativeProcessIdentity !== cutover.native_process_identity
    || input.handle.workAttemptId !== cutover.work_attempt_id || input.handle.providerContinuationId !== cutover.native_continuation_id
    || input.handle.pid !== cutover.native_pid || !sameProviderActionConnectionIdentity(current!.provider_ref!.provider_connection, connection)
    || (cutover.from_mode === "mcp_polling" && input.handle.custodyLaunchAgentSessionId !== undefined
      && input.handle.custodyLaunchAgentSessionId !== current!.provider_ref!.custodial_launch_agent_session_id)
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
  const cutover = ownedDrain(database, input.operationId, input.agentId);
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
  const cutover = ownedDrain(database, input.operationId, input.agentId);
  if (!deliveryDrainBlocksRuntime(cutover)) throw new Error("Delivery drain has no durable stop intent.");
  // The exact old process exit callback may already have detached its handle.
  // No successor execution may exist, and the caller's host fence still proves
  // the journal's immutable old PID/birth, never this nullable projection.
  assertCurrentDrainAuthority(database, cutover, current, true);
  const cursor = requireReadyCursor(database, input.operationId);
  const binding = database.prepare("SELECT room_id,work_attempt_id,execution_generation_id FROM worker_session_bindings WHERE entry_id=?")
    .get(cutover.agent_id) as Row | undefined;
  if (binding && (binding.room_id !== cutover.room_id || binding.work_attempt_id !== cutover.work_attempt_id
    || binding.execution_generation_id !== cutover.execution_generation_id)) throw new Error("Delivery drain worker binding changed before cursor transfer.");
  const timestamp = new Date().toISOString();
  if (cutover.from_mode === "mcp_polling") {
    database.prepare("UPDATE supervised_agent_ingress_cursors SET last_observed_message_id=?,updated_at=? WHERE agent_id=? AND room_id=?")
      .run(cursor, timestamp, cutover.agent_id, cutover.room_id);
  } else if (binding) database.prepare("UPDATE worker_session_bindings SET room_cursor=?,updated_at=? WHERE entry_id=?")
    .run(cursor, timestamp, cutover.agent_id);
  database.prepare(`INSERT INTO work_attempt_checkpoints(work_attempt_id,sort_order,at,room_cursor,provider_continuation_id)
    SELECT ?,COALESCE(MAX(sort_order),-1)+1,?,?,? FROM work_attempt_checkpoints WHERE work_attempt_id=?`)
    .run(cutover.work_attempt_id, timestamp, cursor, cutover.native_continuation_id, cutover.work_attempt_id);
  database.prepare(`UPDATE agent_configurations SET delivery_mode=?,polling_contract=?,
    config_revision=config_revision+1 WHERE agent_id=?`).run(cutover.to_mode, cutover.to_mode === "mcp_polling" ? "custodial_polling_v1" : null, cutover.agent_id);
  database.prepare("UPDATE execution_cutover_v2 SET phase='complete',updated_at_ms=? WHERE operation_id=?")
    .run(Math.max(Date.now(), cutover.updated_at_ms), input.operationId);
  return readDeliveryDrain(database, input.operationId)!;
}
