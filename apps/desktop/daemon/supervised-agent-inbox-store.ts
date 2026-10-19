import { RoomLatencyTrace } from "./room-latency-trace.js";
import { normalizeRoomGif, validReplyGifIntent, type RoomGif } from "../../../shared/room-expressions.mjs";
import { validRecordedReplyAttachments, type RecordedReplyAttachment } from "../../../shared/message-attachments.mjs";
import { createHash, randomUUID } from "node:crypto";
import { SUPERVISED_READ_ONLY_TOOLS } from "../../../shared/supervised-read-tools.mjs";
import { PreparedReadStatements } from "./prepared-reads.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ExecutionShadowStore } from "./execution-shadow-store.js";
import { pendingRuntimeRecovery } from "./runtime-recovery-journal.js";
import type { RetainedExecutionDetail } from "../shared/execution-protocol.js";
import type { PreparedRoomContext, MessageIntervention } from "../shared/message-outcome.js";
import { prepareRoomContext } from "./prepared-room-context.js";
import { freezeQueuedPeers, hasFrozenPeerBatch } from "./queued-peer-deliveries.js";

import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "./daemon-state-database.js";
import { assertDeliveryDrainIngressAllowed, assertNoDeliveryDrain, deliveryDrainAllowsAdmission } from "./delivery-drain.js";
import { assertNoPollingActivation } from "./custodial-polling-activation.js";
import { endedFollowUpReason, FOLLOW_UP_ENDED, FOLLOW_UP_REASONS_THAT_ASK_THE_OWNER, followUpOrigin, parseClaudeApiFailure, parseTaskContinuation, type ClaudeApiFailure, type ContinuityTask, type FollowUpKind, type TaskContinuation } from "./task-continuity.js";
import {
  MAX_QUEUED_NOTICES_PER_TURN, peopleFirstOrder, queuedDeliveryKind, queuedNoticeIds, queuedNoticeReason, queuedNoticesFor, roomArrival,
  type QueuedDeliveryKind,
} from "./queued-delivery-order.js";
import {
  cancelInterruptedSupervisedTurn,
  pruneSupervisedAgentHistory,
  readDurableNativeFailure,
  RETAINED_UNCERTAIN_EFFECTS_PER_AGENT,
  RETAINED_TERMINAL_RECEIPTS_PER_AGENT,
  settleSupervisedTerminalItem,
} from "./supervised-agent-history-retention.js";
import type { SupervisedInboxState, SupervisedInboxReceiptState, SupervisedRetryDomain, InboxActivation, IngressMessage, ObservedIngressMessage, PollIngestionInput, SuccessfulPollIngestionInput, IngressHealthUpdate, SupervisedInboxItem, InboxHeadSnapshot, SupervisedProviderTurnBinding, SupervisedInboxReceipt, SupervisedInboxEvent, SupervisedInboxReceiptWithTimeline, SupervisedInboxReceiptProjection, SupervisedInboxItemMetadata, SupervisedEffectRecord, StructuredRoomTurnCompletion, AgentInspectorDetail, Row, ProviderContinuationRepair } from "./supervised-agent-inbox-store/types.js";
export type { SupervisedInboxState, SupervisedInboxReceiptState, SupervisedRetryDomain, InboxActivation, IngressMessage, ObservedIngressMessage, SupervisedInboxItem, SupervisedProviderTurnBinding, SupervisedInboxReceipt, SupervisedInboxEvent, SupervisedInboxReceiptWithTimeline, SupervisedInboxReceiptProjection, SupervisedEffectRecord, StructuredRoomTurnCompletion, AgentInspectorDetail, ProviderContinuationRepair } from "./supervised-agent-inbox-store/types.js";
import { structuredRoomTurnCompletion, structuredRoomTurnCompletionResult } from "./supervised-agent-inbox-store/turn-completion.js";
export { structuredRoomTurnCompletion } from "./supervised-agent-inbox-store/turn-completion.js";
import { sameInboxHead, finalStates, RETAINED_TIMELINE_EVENTS_PER_RECEIPT, transitions, phaseForTransition, isNewerCursor, valueOrCurrent, providerWorkStarted, persistedTerminalOutcome } from "./supervised-agent-inbox-store/inbox-rules.js";
export { sameInboxHead } from "./supervised-agent-inbox-store/inbox-rules.js";
import { run, UNTOUCHED_PENDING_SQL, UNTOUCHED_BLOCKED_FOLLOW_UP_SQL, RECEIPT_METADATA_COLUMNS, RECEIPT_SELECTION_SQL, INBOX_READS } from "./supervised-agent-inbox-store/sql.js";
import { rowToItem, rowToReceiptProjectionMetadata, rowToItemMetadata, rowToProviderTurnBinding, sameProviderTurnBinding, rowToEvent, rowToInspectorItem, rowToContinuationRepair, safeOutcome, safeSource, boundaryToDetail } from "./supervised-agent-inbox-store/row-mapping.js";
import { EffectAuthorityError, MAX_EFFECTS_PER_PROVIDER_TURN, MAX_UNRESOLVED_EFFECTS_PER_AGENT, MAX_EFFECT_REQUEST_BYTES, MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN, MAX_EFFECT_RESULT_BYTES, MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN, MAX_EFFECT_ERROR_BYTES, serializeEffectJson, effectRequestFingerprint, truncateEffectError, rowToEffect, rowToTombstonedEffect } from "./supervised-agent-inbox-store/effect-values.js";
import { InboxStoreBase } from "./supervised-agent-inbox-store/store-base.js";
import { InboxIngressStore } from "./supervised-agent-inbox-store/ingress.js";
import { InboxTaskContinuationStore } from "./supervised-agent-inbox-store/task-continuations.js";
import { InboxQueryStore } from "./supervised-agent-inbox-store/queries.js";

/** Durable, provider-neutral room delivery queue. It owns neither polling nor turns. */
export class SupervisedAgentInboxStore extends InboxQueryStore {
  /** Atomically checkpoint the canonical API identity with its acknowledgement. */
  async checkpointPublication(input: { inbox_item_id: string; room_id: string; canonical_message_id: string }): Promise<SupervisedInboxItem> {
    this.require(input.inbox_item_id, "inbox_item_id"); this.require(input.room_id, "room_id"); this.require(input.canonical_message_id, "canonical_message_id");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row | undefined;
      if (!row) throw new Error("Unknown supervised inbox publication.");
      const item = rowToItem(row);
      if (item.room_id !== input.room_id) throw new Error("Canonical publication room does not match the inbox item.");
      const existing = database.prepare("SELECT room_id,client_message_id,canonical_message_id FROM supervised_agent_publications WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      if (existing && (String(existing.room_id) !== input.room_id || String(existing.client_message_id) !== item.reply_client_message_id || String(existing.canonical_message_id) !== input.canonical_message_id)) throw new Error("Canonical publication conflicts with a prior checkpoint.");
      if (item.state !== "publishing" && !(item.state === "acknowledged" && existing)) throw new Error("Canonical publication requires a publishing inbox item or an idempotently acknowledged publication.");
      const timestamp = this.now();
      if (item.state === "publishing") {
        run(database.prepare(`INSERT INTO supervised_agent_publications(inbox_item_id,agent_id,room_id,client_message_id,canonical_message_id,published_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(inbox_item_id) DO NOTHING`), item.inbox_item_id, item.agent_id, item.room_id, item.reply_client_message_id, input.canonical_message_id, timestamp);
        run(database.prepare("UPDATE supervised_agent_inbox SET state='acknowledged',updated_at=?,acknowledged_at=? WHERE inbox_item_id=?"), timestamp, timestamp, item.inbox_item_id);
        this.recordEvent(database, item.inbox_item_id, `published:${item.attempt_count}`, "published", timestamp, input.canonical_message_id);
        this.settleTerminalItem(database, item, timestamp);
      }
      this.pruneAgentHistory(database, item.agent_id);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
    }));
  }
  async transition(inboxItemId: string, next: SupervisedInboxState, patch: Partial<Pick<SupervisedInboxItem, "provider_turn_id" | "outcome" | "last_error" | "failure_code" | "next_attempt_at_ms" | "blocked_by_inbox_item_id">> = {}): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (!transitions[item.state].includes(next)) throw new Error(`Invalid supervised inbox transition: ${item.state} -> ${next}.`);
      const nativeFailure = readDurableNativeFailure(database, inboxItemId);
      if (nativeFailure && ((Object.hasOwn(patch, "outcome") && patch.outcome !== item.outcome)
        || ["pending", "publishing", "acknowledged", "acknowledged_no_reply", "cancelled_by_user"].includes(next))) {
        throw new Error("Exact native terminal failure cannot be overwritten or replayed.");
      }
      if (Object.hasOwn(patch, "outcome") && patch.outcome !== item.outcome) {
        let kind: unknown;
        try { kind = patch.outcome ? JSON.parse(patch.outcome).kind : null; } catch { /* Existing opaque outcomes remain supported. */ }
        if (kind === "failed" || kind === "interrupted") throw new Error("Native failure outcomes require the exact terminal checkpoint.");
      }
      if (next === "acknowledged_failed") {
        this.assertCurrentHead(database, item);
        const patchKeys = Object.keys(patch);
        const hasOnlyFailureDetail = patchKeys.length === 1
          && patchKeys[0] === "last_error"
          && typeof patch.last_error === "string"
          && patch.last_error.trim().length > 0;
        if ((patchKeys.length > 0 && !hasOnlyFailureDetail) || !nativeFailure) {
          throw new Error("Failed settlement requires unchanged exact native terminal evidence.");
        }
      }
      // Every in-flight state is causally owned by the true FIFO head. This
      // prevents a later item becoming blocked and hiding the real stall.
      if (!finalStates.has(next)) this.assertCurrentHead(database, item);
      if (next === "dispatching" && item.state !== "pending") throw new Error("Only the current pending FIFO head may be dispatched.");
      if (next === "dispatching" && !deliveryDrainAllowsAdmission(database, item)) throw new Error("Delivery drain blocks new turn admission.");
      if (Object.hasOwn(patch, "provider_turn_id")
        && patch.provider_turn_id !== item.provider_turn_id) {
        throw new Error("Provider turn identity may change only through the atomic turn-start checkpoint.");
      }
      const attempts = item.attempt_count;
      const timestamp = this.now(); const acknowledged = finalStates.has(next) ? timestamp : null;
      run(database.prepare(`UPDATE supervised_agent_inbox SET state=?,attempt_count=?,provider_turn_id=?,outcome=?,last_error=?,failure_code=?,blocked_by_inbox_item_id=?,next_attempt_at_ms=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`),
        next, attempts, valueOrCurrent(patch, "provider_turn_id", item.provider_turn_id), valueOrCurrent(patch, "outcome", item.outcome), valueOrCurrent(patch, "last_error", item.last_error),
        valueOrCurrent(patch, "failure_code", item.failure_code), valueOrCurrent(patch, "blocked_by_inbox_item_id", item.blocked_by_inbox_item_id), valueOrCurrent(patch, "next_attempt_at_ms", item.next_attempt_at_ms), timestamp, acknowledged, inboxItemId);
      const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
      const event = phaseForTransition(next);
      if (event) {
        const ordinal = event === "retry_scheduled" || event === "queued"
          ? Number((database.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase=?").get(inboxItemId, event) as Row).value) + 1
          : updated.attempt_count;
        this.recordEvent(database, inboxItemId, this.occurrenceKey(database, inboxItemId, `${event}:${ordinal}`, event), event, timestamp, updated.last_error);
      }
      if (finalStates.has(next)) {
        this.settleTerminalItem(database, item, timestamp);
        this.pruneAgentHistory(database, item.agent_id);
      }
      return updated;
    }));
  }
  async claimHead(agentId: string, expected?: InboxHeadSnapshot | null): Promise<SupervisedInboxItem | null> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      if (pendingRuntimeRecovery(database, agentId)) return null;
      const row = database.prepare(`SELECT i.*,${UNTOUCHED_PENDING_SQL} AS untouched FROM supervised_agent_inbox i WHERE i.agent_id=? AND i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') ORDER BY i.fifo_sequence LIMIT 1`).get(agentId) as Row | undefined;
      if (!row) return null;
      const item = rowToItem(row);
      if (expected !== undefined && !sameInboxHead(expected, item)) return null;
      const turnControlBarrier = database.prepare(`SELECT inbox_item_id,status FROM turn_control_journals
        WHERE agent_id=? AND turn_control_present=1
          AND status IN ('prepared','dispatching','uncertain','retryable')`).get(agentId) as Row | undefined;
      if (turnControlBarrier) {
        const linkedInboxItemId = typeof turnControlBarrier.inbox_item_id === "string"
          && turnControlBarrier.inbox_item_id.trim()
          ? turnControlBarrier.inbox_item_id
          : null;
        const status = String(turnControlBarrier.status);
        // Every unresolved accepted action freezes lane admission, including an
        // idle/pre-native action that has no linked row yet. Otherwise B could
        // be claimed between the action's idle observation and its atomic
        // correction insert, placing an already-running B behind the newly
        // inserted correction. The sole recovery exception is a retryable
        // action linked to exact A: A may resume, but the same barrier keeps B
        // blocked after A finishes until the accepted action completes.
        if (status !== "retryable" || linkedInboxItemId === null || item.inbox_item_id !== linkedInboxItemId) return null;
      }
      if (!deliveryDrainAllowsAdmission(database, item)) return null;
      if (item.state === "result_recovery") return item;
      if (item.state !== "pending") return null;
      if (this.readTaskContinuation(database, item) && item.next_attempt_at_ms !== null
        && item.next_attempt_at_ms > Date.parse(this.now())) return null;
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET state='dispatching',updated_at=? WHERE inbox_item_id=? AND state='pending'"), timestamp, item.inbox_item_id);
      // A recovering row keeps the activation its existing provider turn was started with.
      if (!item.provider_turn_id && !item.outcome) {
        const activation = this.dispatchActivation(database, item, Number(row.untouched) === 1, timestamp);
        if (JSON.stringify(activation) !== JSON.stringify(item.activation)) {
          run(database.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?"), JSON.stringify(activation), item.inbox_item_id);
        }
      }
      const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
      return updated;
    }));
  }
  /**
   * Revalidate the durable dispatch fact immediately before turn/start. The
   * fact itself is the FIFO claim's committed `dispatching` state; this is
   * intentionally not a second synthetic transition.
   */
  async checkpointDispatchIntent(inboxItemId: string, taskOwnerSessionId?: string, context?: readonly unknown[]): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching" || item.provider_turn_id) throw new Error("Provider dispatch intent requires an unstarted dispatching inbox item.");
      this.assertCurrentHead(database, item);
      if (!deliveryDrainAllowsAdmission(database, item)) throw new Error("Delivery drain blocks new turn dispatch.");
      if (context) {
        const snapshot = prepareRoomContext(context, this.now());
        run(database.prepare(`INSERT INTO supervised_agent_prepared_context(inbox_item_id,snapshot_json) VALUES (?,?)
          ON CONFLICT(inbox_item_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`), inboxItemId, JSON.stringify(snapshot));
      }
      run(database.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?"),
        JSON.stringify({ ...item.activation, task_continuity_dispatch_session_id: taskOwnerSessionId ?? null }), inboxItemId);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  /** Persist the exact provider turn id before waiting for any terminal evidence. */
  async checkpointTurnStarted(inboxItemId: string, providerTurnId: string, authority: {
    work_attempt_id: string;
    origin_execution_generation_id: string;
    provider_continuation_id: string;
  }): Promise<SupervisedInboxItem> {
    if (!providerTurnId.trim()) throw new Error("Provider turn id is required for the turn-start checkpoint.");
    this.require(authority.work_attempt_id, "provider turn work_attempt_id");
    this.require(authority.origin_execution_generation_id, "provider turn origin_execution_generation_id");
    this.require(authority.provider_continuation_id, "provider turn provider_continuation_id");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching") throw new Error("Provider turn-start checkpoint requires a dispatching inbox item.");
      this.assertCurrentHead(database, item);
      if (item.provider_turn_id && item.provider_turn_id !== providerTurnId) throw new Error("Provider turn-start checkpoint conflicts with the durable exact turn id.");
      const existingBinding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      if (item.provider_turn_id) {
        if (!existingBinding || !sameProviderTurnBinding(rowToProviderTurnBinding(existingBinding), {
          inbox_item_id: inboxItemId,
          agent_id: item.agent_id,
          room_id: item.room_id,
          provider_turn_id: providerTurnId,
          ...authority,
        })) {
          throw new Error("Provider turn-start checkpoint conflicts with the durable authority binding.");
        }
      } else if (existingBinding) {
        throw new Error("Provider turn-start checkpoint found authority without a durable provider turn.");
      }
      const timestamp = this.now();
      const nextAttemptCount = item.provider_turn_id ? item.attempt_count : item.attempt_count + 1;
      run(database.prepare("UPDATE supervised_agent_inbox SET provider_turn_id=?,attempt_count=?,updated_at=? WHERE inbox_item_id=?"), providerTurnId, nextAttemptCount, timestamp, inboxItemId);
      if (!existingBinding) {
        run(database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings
          (inbox_item_id,agent_id,room_id,work_attempt_id,origin_execution_generation_id,provider_continuation_id,provider_turn_id)
          VALUES (?,?,?,?,?,?,?)`), inboxItemId, item.agent_id, item.room_id, authority.work_attempt_id,
        authority.origin_execution_generation_id, authority.provider_continuation_id, providerTurnId);
      }
      this.recordEvent(database, inboxItemId, `turn_started:${nextAttemptCount}:${providerTurnId}`, "turn_started", timestamp, null);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  /** Record failure debt and its retry/block disposition in one transaction. */
  async recordRetryFailure(inboxItemId: string, input: {
    domain: SupervisedRetryDomain;
    error: string;
    resetUndispatchedTurnId?: string;
  }): Promise<{ item: SupervisedInboxItem; attempt: number }> {
    if (!["pre_dispatch", "result_recovery", "publication"].includes(input.domain)) {
      throw new Error("Unknown supervised retry domain.");
    }
    const resetTurnId = input.resetUndispatchedTurnId;
    if (resetTurnId !== undefined && (input.domain !== "pre_dispatch" || !resetTurnId.trim())) {
      throw new Error("Undispatched reset requires an exact provider turn id and pre-dispatch retry domain.");
    }
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(row);
      this.assertCurrentHead(database, item);
      if (readDurableNativeFailure(database, inboxItemId)) {
        throw new Error("Exact native terminal failure cannot be retried.");
      }
      const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      const terminal = database.prepare("SELECT outcome FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      const outcome = safeOutcome(item.outcome) as { kind?: unknown; text?: unknown } | null;
      if (input.domain === "publication") {
        if (item.state !== "publishing" || outcome?.kind !== "reply"
          || typeof outcome.text !== "string" || !outcome.text.trim()) {
          throw new Error("Publication retry requires a publishing inbox item with its saved reply.");
        }
      } else {
        if (!["dispatching", "awaiting_result", "result_recovery"].includes(item.state)
          || (resetTurnId !== undefined && item.provider_turn_id !== resetTurnId)) {
          throw new Error("Retry does not match the exact in-flight provider turn.");
        }
        if (input.domain === "result_recovery" || resetTurnId !== undefined) {
          if (!item.provider_turn_id || !binding || String(binding.agent_id) !== item.agent_id
            || String(binding.room_id) !== item.room_id || String(binding.provider_turn_id) !== item.provider_turn_id) {
            throw new Error("Retry is missing its exact provider-turn authority binding.");
          }
        }
        if (input.domain === "result_recovery") {
          if ((terminal && terminal.outcome !== "unreadable")
            || (item.outcome !== null && outcome?.kind !== "unreadable")) {
            throw new Error("Accepted terminal completion cannot consume a result-recovery retry.");
          }
        } else if (resetTurnId !== undefined) {
          const executionGenerationId = String(binding!.origin_execution_generation_id);
          const effect = database.prepare(`SELECT 1 FROM supervised_agent_effects
            WHERE agent_id=? AND room_id=? AND execution_generation_id=? AND provider_turn_id=?
            UNION ALL
            SELECT 1 FROM supervised_agent_effect_tombstones
            WHERE agent_id=? AND room_id=? AND execution_generation_id=? AND provider_turn_id=?
            LIMIT 1`).get(
            item.agent_id, item.room_id, executionGenerationId, resetTurnId,
            item.agent_id, item.room_id, executionGenerationId, resetTurnId,
          );
          if (terminal || effect || item.outcome) {
            throw new Error("Undispatched reset found terminal or effect evidence and was refused.");
          }
        } else if (item.provider_turn_id || binding || item.outcome || terminal || item.state === "result_recovery") {
          throw new Error("Pre-dispatch retry requires an unstarted dispatch without turn or terminal evidence.");
        }
      }

      // Count the physical journal, never the receipt's bounded display tail.
      // Old generic retry keys have unknown provenance: retain that debt for
      // each domain, without guessing from error text. Known bookkeeping keys
      // (including room-move rollback and handoff) do not consume a budget.
      const prefix = `retry_failure:${input.domain}:`;
      const legacyPrefix = input.domain === "pre_dispatch" ? "undispatched_retry:*"
        : input.domain === "result_recovery" ? "result_recovery_retry:*" : null;
      const prior = Number((database.prepare(`SELECT COUNT(*) AS value FROM supervised_agent_inbox_events
        WHERE inbox_item_id=? AND phase='retry_scheduled'
          AND (idempotency_key GLOB ? OR idempotency_key GLOB ? OR idempotency_key GLOB 'retry_scheduled:*')`)
        .get(inboxItemId, `${prefix}*`, legacyPrefix) as Row).value);
      const attempt = prior + 1;
      const exhausted = attempt >= 3;
      const reset = resetTurnId !== undefined && !exhausted;
      const next = exhausted ? "blocked" : reset ? "pending"
        : item.state === "result_recovery" ? "result_recovery" : "retryable";
      const timestamp = this.now();
      const label = input.domain === "result_recovery" ? "Result recovery"
        : input.domain === "publication" ? "Reply publication" : "Pre-dispatch preparation";
      const error = exhausted ? `${label} failed ${attempt} times: ${input.error}` : input.error;
      if (reset) run(database.prepare("DELETE FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?"), inboxItemId);
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state=?,attempt_count=?,provider_turn_id=?,last_error=?,failure_code=NULL,
            blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,updated_at=?
        WHERE inbox_item_id=?`), next, reset ? Math.max(0, item.attempt_count - 1) : item.attempt_count,
      reset ? null : item.provider_turn_id, error, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `${prefix}${attempt}`, "retry_scheduled", timestamp, error);
      if (exhausted) this.recordEvent(database, inboxItemId, `${prefix}${attempt}:blocked`, "blocked", timestamp, error);
      return { item: rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row), attempt };
    }));
  }
  /**
   * A controlled handoff may roll back a dispatch intent only after its
   * provider promise proves no wrapper/native turn was made. Crash recovery
   * cannot call this path because it lacks that live cleanup proof.
   */
  async resetPreNativeHandoff(inboxItemId: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(row);
      if (!["dispatching", "retryable"].includes(item.state) || item.provider_turn_id || item.outcome) {
        throw new Error("Pre-native handoff reset requires an exact unstarted dispatch or retry-backoff intent.");
      }
      this.assertCurrentHead(database, item);
      const terminal = database.prepare("SELECT 1 FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(inboxItemId);
      if (terminal) throw new Error("Pre-native handoff reset found terminal evidence and was refused.");
      const timestamp = this.now();
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='pending',last_error=NULL,failure_code=NULL,blocked_by_inbox_item_id=NULL,
            next_attempt_at_ms=NULL,updated_at=?
        WHERE inbox_item_id=?`), timestamp, inboxItemId);
      const queuedOrdinal = Number((database.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='queued'").get(inboxItemId) as Row).value) + 1;
      this.recordEvent(database, inboxItemId, `handoff_queued:${queuedOrdinal}`, "queued", timestamp, "Clean handoff completed before native provider dispatch; returning the FIFO item to pending.");
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  async checkpointNormalizedTerminal(input: {
    inbox_item_id: string;
    agent_id: string;
    execution_generation_id: string;
    provider_turn_id: string;
    outcome: "reply" | "no_reply" | "unreadable" | "failed" | "interrupted";
    text: string | null;
    evidence: "transcript" | "stream" | "none";
    failure_detail?: string | null;
    task_owner_session_id?: string;
    terminal_evidence: unknown;
  }): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${input.inbox_item_id}`);
      const item = rowToItem(row);
      if (item.agent_id !== input.agent_id || item.provider_turn_id !== input.provider_turn_id) throw new Error("Normalized terminal evidence does not match the exact inbox turn.");
      if (item.state !== "dispatching" && item.state !== "awaiting_result" && item.state !== "result_recovery") throw new Error("Normalized terminal evidence requires an in-flight or recovering result.");
      this.assertCurrentHead(database, item);
      const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(input.inbox_item_id) as Row | undefined;
      if (!binding
        || String(binding.agent_id) !== item.agent_id
        || String(binding.room_id) !== item.room_id
        || String(binding.origin_execution_generation_id) !== input.execution_generation_id
        || String(binding.provider_turn_id) !== input.provider_turn_id) {
        throw new Error("Normalized terminal evidence does not match the durable provider-turn authority binding.");
      }
      const nativeFailure = input.outcome === "failed" || input.outcome === "interrupted";
      if (!nativeFailure && input.failure_detail) {
        throw new Error("Only an exact native terminal failure may retain a failure detail.");
      }
      if (nativeFailure) {
        const evidence = input.terminal_evidence as Record<string, unknown> | null;
        const failureDetail = input.failure_detail?.trim() || undefined;
        if (input.text !== null || input.evidence === "none" || !evidence
          || evidence.outcome !== input.outcome || evidence.turnId !== input.provider_turn_id
          || evidence.text !== null || evidence.evidence !== input.evidence
          || evidence.providerContinuationId !== binding.provider_continuation_id
          || evidence.error !== failureDetail) {
          throw new Error("Native terminal failure requires exact continuation, turn, and terminal evidence.");
        }
      }
      const priorTerminal = database.prepare(`SELECT agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text
        FROM supervised_agent_terminal_results WHERE inbox_item_id=?`).get(input.inbox_item_id) as Row | undefined;
      if (priorTerminal && (String(priorTerminal.agent_id) !== input.agent_id
        || String(priorTerminal.execution_generation_id) !== input.execution_generation_id
        || String(priorTerminal.provider_turn_id) !== input.provider_turn_id)) {
        throw new Error("Normalized terminal evidence conflicts with an earlier provider-turn authority identity.");
      }
      // A definitive completion is monotonic. Re-reading can resolve an
      // unreadable result, but cleanup or a late observation cannot demote an
      // already accepted room reply/no-reply or change an exact native failure.
      if (priorTerminal && priorTerminal.outcome !== "unreadable") {
        if (input.outcome === "unreadable"
          || (nativeFailure && ["reply", "no_reply"].includes(String(priorTerminal.outcome)))
          || (priorTerminal.outcome === input.outcome && priorTerminal.normalized_text === input.text)) return item;
        throw new Error("Normalized terminal evidence conflicts with an already accepted completion.");
      }
      const timestamp = this.now();
      run(database.prepare(`INSERT INTO supervised_agent_terminal_results
        (inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(inbox_item_id) DO UPDATE SET outcome=excluded.outcome,normalized_text=excluded.normalized_text,evidence_source=excluded.evidence_source,terminal_evidence_json=excluded.terminal_evidence_json,updated_at=excluded.updated_at`),
        input.inbox_item_id, input.agent_id, input.execution_generation_id, input.provider_turn_id, input.outcome, input.text, input.evidence, JSON.stringify(input.terminal_evidence), timestamp, timestamp);
      const outcome = JSON.stringify({ kind: input.outcome, text: input.text, evidence: input.evidence });
      const failureDetail = nativeFailure ? input.failure_detail?.trim() || null : item.last_error;
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET outcome=?,last_error=?,updated_at=? WHERE inbox_item_id=?`),
        outcome, failureDetail, timestamp, input.inbox_item_id);
      // Recovery may observe an old turn after a worker-session replacement.
      // Only the worker stamped before native dispatch can inherit its work.
      if (input.outcome === "failed") {
        const sameOwner = input.task_owner_session_id
          && item.activation.task_continuity_dispatch_session_id === input.task_owner_session_id;
        run(database.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?"),
          JSON.stringify({ ...item.activation, task_continuity_owner_session_id: sameOwner ? input.task_owner_session_id : null,
            task_continuity_failed_at: sameOwner ? timestamp : null, task_continuity_considered: null }), input.inbox_item_id);
      }
      this.recordEvent(database, input.inbox_item_id, `turn_finished:${item.attempt_count}:${input.provider_turn_id}`, "turn_finished", timestamp, input.evidence);
      // The turn that carried these notices completed; they need no turn of their own.
      // A failed, interrupted, stopped or unreadable turn leaves them queued.
      if (input.outcome === "reply" || input.outcome === "no_reply") this.settleQueuedNotices(database, item, timestamp);
      if (input.outcome === "unreadable") {
        this.recordEvent(database, input.inbox_item_id, `result_unreadable:${input.provider_turn_id}`, "result_unreadable", timestamp, "Checking the existing provider turn for its result.");
      }
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row);
    }));
  }

  async nativeFailure(inboxItemId: string): Promise<"failed" | "interrupted" | null> {
    return this.read(async (database) => readDurableNativeFailure(database, inboxItemId));
  }

  async prepareEffect(input: {
    agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
    mcp_request_id: string; tool_name: string; request: unknown; mutation?: boolean;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; effect: SupervisedEffectRecord }> {
    const requestJson = serializeEffectJson(input.request, "request");
    if (input.tool_name === "set_reply_thread" && requestJson !== "{}") {
      throw new Error("set_reply_thread takes an empty object; the active turn determines its thread.");
    }
    if (input.tool_name === "set_reply_gif" && !validReplyGifIntent(input.request)) throw new Error("Invalid GIF reply intent.");
    if (input.tool_name === "set_reply_attachments" && !validRecordedReplyAttachments(input.request)) throw new Error("Invalid reply attachments intent.");
    const expectedMutation = !SUPERVISED_READ_ONLY_TOOLS.has(input.tool_name);
    if (input.mutation !== undefined && input.mutation !== expectedMutation) {
      throw new Error("The supervised effect classification does not match the registered tool policy.");
    }
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const existing = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mcp_request_id=?`).get(
        input.agent_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id,
      ) as Row | undefined;
      if (existing) {
        const effect = rowToEffect(existing);
        if (effect.room_id !== input.room_id || effect.tool_name !== input.tool_name
          || effect.mutation !== expectedMutation || String(existing.request_json) !== requestJson) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        if (effect.state === "completed" || effect.state === "failed" || effect.state === "uncertain") return { created: false, effect };
        this.assertActiveEffectAuthority(database, input);
        if (effect.tool_name === "complete_room_turn") {
          const completion = structuredRoomTurnCompletion(input.request);
          if (!completion) throw new Error("The supervised room-turn completion proposal is malformed.");
          const executing = database.prepare(`SELECT effect_id FROM supervised_agent_effects
            WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
              AND tool_name<>'complete_room_turn' AND state='executing' AND mutation=1 LIMIT 1`).get(
            input.agent_id, input.execution_generation_id, input.provider_turn_id,
          );
          if (executing) {
            throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
          }
          run(database.prepare(`UPDATE supervised_agent_effects SET state='completed',result_json=?,error=NULL,updated_at=?
            WHERE effect_id=? AND state IN ('prepared','executing')`),
          serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result"), this.now(), effect.effect_id);
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effect.effect_id) as Row) };
        }
        if (effect.state === "executing") {
          const timestamp = this.now();
          if (effect.mutation && effect.tool_name !== "complete_room_turn") {
            run(database.prepare(`UPDATE supervised_agent_effects
              SET state='uncertain',error=?,updated_at=? WHERE effect_id=? AND state='executing'`),
            "The mutating tool crossed its execution boundary without a durable result. It may have completed; verify external state before repeating it.", timestamp, effect.effect_id);
            this.pruneAgentHistory(database, effect.agent_id, effect.effect_id);
          } else {
            run(database.prepare(`UPDATE supervised_agent_effects
              SET state='prepared',error=?,updated_at=? WHERE effect_id=? AND state='executing'`),
            effect.tool_name === "complete_room_turn"
              ? "Room delivery restarted while committing the local completion proposal; its durable request is safe to commit again."
              : "The prior read-only execution ended without a durable result and is safe to execute again.", timestamp, effect.effect_id);
          }
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effect.effect_id) as Row) };
        }
        return { created: false, effect };
      }
      const tombstone = database.prepare(`SELECT * FROM supervised_agent_effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mcp_request_id=?`).get(
        input.agent_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id,
      ) as Row | undefined;
      if (tombstone) {
        const effect = rowToTombstonedEffect(tombstone);
        if (effect.room_id !== input.room_id || effect.tool_name !== input.tool_name
          || effect.mutation !== expectedMutation
          || String(tombstone.request_sha256) !== effectRequestFingerprint(requestJson)) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        return { created: false, effect };
      }
      const completedTurn = database.prepare(`SELECT effect_id FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
          AND tool_name='complete_room_turn' AND state='completed' LIMIT 1`).get(
        input.agent_id, input.execution_generation_id, input.provider_turn_id,
      ) as Row | undefined;
      if (completedTurn && input.tool_name !== "complete_room_turn") {
        throw new Error("The supervised room turn is already complete; no new effects may be admitted.");
      }
      if (input.tool_name === "complete_room_turn") {
        const completion = structuredRoomTurnCompletion(input.request);
        if (!completion) throw new Error("The supervised room-turn completion proposal is malformed.");
        const completedResultJson = serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result");
        const singleton = database.prepare(`SELECT * FROM supervised_agent_effects
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND tool_name='complete_room_turn'
          ORDER BY created_at,effect_id LIMIT 1`).get(
          input.agent_id, input.execution_generation_id, input.provider_turn_id,
        ) as Row | undefined;
        if (singleton) {
          const effect = rowToEffect(singleton);
          if (effect.room_id !== input.room_id || effect.mutation !== expectedMutation
            || String(singleton.request_json) !== requestJson) {
            throw new Error("The supervised room turn already recorded a different completion proposal.");
          }
          if (effect.state !== "completed") {
            const executing = database.prepare(`SELECT effect_id FROM supervised_agent_effects
              WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
                AND tool_name<>'complete_room_turn' AND state='executing' AND mutation=1 LIMIT 1`).get(
              input.agent_id, input.execution_generation_id, input.provider_turn_id,
            );
            if (executing) {
              throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
            }
          }
          this.assertActiveEffectAuthority(database, input);
          if (effect.state === "prepared" || effect.state === "executing") {
            run(database.prepare(`UPDATE supervised_agent_effects SET state='completed',result_json=?,error=NULL,updated_at=?
              WHERE effect_id=? AND state IN ('prepared','executing')`),
            completedResultJson, this.now(), effect.effect_id);
          }
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effect.effect_id) as Row) };
        }
        const executing = database.prepare(`SELECT effect_id FROM supervised_agent_effects
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
            AND tool_name<>'complete_room_turn' AND state='executing' AND mutation=1 LIMIT 1`).get(
          input.agent_id, input.execution_generation_id, input.provider_turn_id,
        );
        if (executing) {
          throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
        }
      }
      const binding = this.assertActiveEffectAuthority(database, input);
      const timestamp = this.now();
      const effectId = randomUUID();
      if (input.tool_name === "set_reply_thread" || input.tool_name === "set_reply_gif") {
        // Only an observed room message can select a thread. Synthetic initial
        // assignments, corrections and task continuations are not room messages.
        const source = database.prepare(`SELECT i.source_message_id FROM supervised_agent_inbox i
          JOIN supervised_agent_observed_messages o ON o.agent_id=i.agent_id AND o.room_id=i.room_id
            AND o.source_message_id=i.source_message_id
          WHERE i.inbox_item_id=? AND json_extract(i.source_message_json,'$.id')=i.source_message_id`)
          .get(binding.inbox_item_id) as Row | undefined;
        if (!source) throw new Error(`${input.tool_name} requires an observed activating room message, not a synthetic turn.`);
        const payload = { code: input.tool_name === "set_reply_gif" ? "REPLY_GIF_RECORDED" : "REPLY_THREAD_RECORDED", source_message_id: String(source.source_message_id),
          instruction: input.tool_name === "set_reply_gif"
            ? "GIF choice recorded. Continue working, then finish with an ordinary reply and meaningful fallback text. No message has been sent. A no_reply outcome sends nothing."
            : "Thread choice recorded. Continue working and finish through your normal final completion; no message has been sent." };
        const result = serializeEffectJson({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }, "result");
        // Keep a receipt per request id so reusing any id for a different tool
        // still fails. Existing admission limits bound repeated distinct calls.
        this.assertEffectAdmissionCapacity(database, input, requestJson);
        run(database.prepare(`INSERT INTO supervised_agent_effects
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,1,'completed',?,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.execution_generation_id, input.provider_turn_id,
        input.mcp_request_id, input.tool_name, requestJson, result, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
      }
      if (input.tool_name === "set_reply_attachments") {
        // Any turn that ends in a published reply may carry files, synthetic task turns included.
        const recorded = validRecordedReplyAttachments(input.request) ? input.request.files ?? [] : [];
        const payload = { code: "REPLY_ATTACHMENTS_RECORDED", files: recorded.map((file) => file.name),
          instruction: recorded.length
            ? "Attachment choice recorded and the files were copied; later edits are not sent. Continue working, then finish with an ordinary reply and meaningful text. No message has been sent. A no_reply outcome sends nothing."
            : "Attachment choice cleared. No message has been sent." };
        const result = serializeEffectJson({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }, "result");
        this.assertEffectAdmissionCapacity(database, input, requestJson);
        run(database.prepare(`INSERT INTO supervised_agent_effects
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,1,'completed',?,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.execution_generation_id, input.provider_turn_id,
        input.mcp_request_id, input.tool_name, requestJson, result, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
      }
      if (input.tool_name === "complete_room_turn") {
        const completion = structuredRoomTurnCompletion(input.request)!;
        const completedResultJson = serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result");
        run(database.prepare(`INSERT INTO supervised_agent_effects
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'completed',?,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.execution_generation_id, input.provider_turn_id,
        input.mcp_request_id, input.tool_name, requestJson, expectedMutation ? 1 : 0, completedResultJson, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
      }
      this.assertEffectAdmissionCapacity(database, input, requestJson);
      run(database.prepare(`INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id, input.tool_name, requestJson, expectedMutation ? 1 : 0, timestamp, timestamp);
      return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
    }, commitFence));
  }

  async markEffectExecuting(input: {
    effect_id: string; agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<SupervisedEffectRecord> {
    const admitted = await this.exclusive(async (database) => this.transactionFenced(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row | undefined;
      if (!row) {
        const tombstone = database.prepare("SELECT * FROM supervised_agent_effect_tombstones WHERE effect_id=?").get(input.effect_id) as Row | undefined;
        if (tombstone) {
          const compacted = rowToTombstonedEffect(tombstone);
          if (compacted.agent_id !== input.agent_id || compacted.room_id !== input.room_id
            || compacted.execution_generation_id !== input.execution_generation_id
            || compacted.provider_turn_id !== input.provider_turn_id) {
            throw new Error("The supervised effect does not belong to the exact active turn.");
          }
          throw new Error(compacted.error || "The supervised effect outcome is uncertain and cannot be executed again.");
        }
        throw new Error("Unknown supervised effect.");
      }
      const effect = rowToEffect(row);
      if (effect.agent_id !== input.agent_id || effect.room_id !== input.room_id
        || effect.execution_generation_id !== input.execution_generation_id
        || effect.provider_turn_id !== input.provider_turn_id) {
        throw new Error("The supervised effect does not belong to the exact active turn.");
      }
      if (effect.state === "failed") throw new Error(effect.error || "The supervised effect was fenced before execution.");
      if (effect.state === "completed") return { effect, rejection: null };
      if (effect.state === "uncertain") throw new Error(effect.error || "The supervised effect outcome is uncertain and cannot be executed again.");
      if (effect.state === "executing") throw new Error("This supervised effect is already executing; refusing a duplicate side effect.");
      if (effect.tool_name !== "complete_room_turn") {
        const completedTurn = database.prepare(`SELECT effect_id FROM supervised_agent_effects
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
            AND tool_name='complete_room_turn' AND state='completed' LIMIT 1`).get(
          effect.agent_id, effect.execution_generation_id, effect.provider_turn_id,
        );
        if (completedTurn) {
          const rejection = "The supervised room turn is already complete; this prepared effect may no longer execute.";
          run(database.prepare("UPDATE supervised_agent_effects SET state='failed',error=?,updated_at=? WHERE effect_id=? AND state='prepared'"),
            rejection, this.now(), input.effect_id);
          return {
            effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row),
            rejection,
          };
        }
      }
      try {
        this.assertActiveEffectAuthority(database, input);
      } catch (error) {
        if (!(error instanceof EffectAuthorityError)) throw error;
        const rejection = error.message;
        run(database.prepare("UPDATE supervised_agent_effects SET state='failed',error=?,updated_at=? WHERE effect_id=? AND state='prepared'"),
          rejection, this.now(), input.effect_id);
        return {
          effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row),
          rejection,
        };
      }
      run(database.prepare("UPDATE supervised_agent_effects SET state='executing',updated_at=? WHERE effect_id=?"), this.now(), input.effect_id);
      return {
        effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row),
        rejection: null,
      };
    }, commitFence));
    if (admitted.rejection) throw new EffectAuthorityError(admitted.rejection);
    return admitted.effect;
  }

  /** Attach validated preparation data without claiming the side effect has
   * executed. Room moves remain prepared until the activating reply finishes. */
  async stagePreparedEffectResult(effectId: string, result: unknown, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<SupervisedEffectRecord> {
    const resultJson = serializeEffectJson(result, "prepared result");
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row | undefined;
      if (!row) throw new Error("Unknown supervised effect.");
      const effect = rowToEffect(row);
      if (effect.state !== "prepared") return effect;
      this.assertEffectResultCapacity(database, effect, resultJson);
      run(database.prepare("UPDATE supervised_agent_effects SET result_json=?,updated_at=? WHERE effect_id=?"), resultJson, this.now(), effectId);
      return rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row);
    }, commitFence));
  }

  /** Atomically create the exactly-once MCP effect and its local room-move
   * journal. Handoff can therefore observe either neither record or both. */
  async prepareRoomMoveEffect(input: {
    agent_id: string; room_id: string; effect_execution_generation_id: string; provider_turn_id: string;
    mcp_request_id: string; request: unknown; destination_room_id: string;
    daemon_generation: number; work_attempt_id: string; execution_generation_id: string;
    provider_continuation_id: string; agent_session_id: string; activating_inbox_item_id: string;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; effect: SupervisedEffectRecord }> {
    const requestJson = serializeEffectJson(input.request, "request");
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const existing = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mcp_request_id=?`).get(
        input.agent_id, input.effect_execution_generation_id, input.provider_turn_id, input.mcp_request_id,
      ) as Row | undefined;
      let created = false;
      let effectId: string;
      if (existing) {
        const effect = rowToEffect(existing);
        if (effect.room_id !== input.room_id || effect.tool_name !== "join_room"
          || String(existing.request_json) !== requestJson) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        if (effect.state === "completed" || effect.state === "failed") return { created: false, effect };
        const binding = this.assertActiveEffectAuthority(database, {
          agent_id: input.agent_id, room_id: input.room_id,
          execution_generation_id: input.effect_execution_generation_id, provider_turn_id: input.provider_turn_id,
          work_attempt_id: input.work_attempt_id, current_execution_generation_id: input.execution_generation_id,
          provider_continuation_id: input.provider_continuation_id,
        });
        if (binding.inbox_item_id !== input.activating_inbox_item_id) throw new Error("The supervised room move lost its exact activating inbox turn.");
        effectId = effect.effect_id;
      } else {
        const completedTurn = database.prepare(`SELECT effect_id FROM supervised_agent_effects
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
            AND tool_name='complete_room_turn' AND state='completed' LIMIT 1`).get(
          input.agent_id, input.effect_execution_generation_id, input.provider_turn_id,
        );
        if (completedTurn) {
          throw new Error("The supervised room turn is already complete; no new effects may be admitted.");
        }
        const binding = this.assertActiveEffectAuthority(database, {
          agent_id: input.agent_id, room_id: input.room_id,
          execution_generation_id: input.effect_execution_generation_id, provider_turn_id: input.provider_turn_id,
          work_attempt_id: input.work_attempt_id, current_execution_generation_id: input.execution_generation_id,
          provider_continuation_id: input.provider_continuation_id,
        });
        if (binding.inbox_item_id !== input.activating_inbox_item_id) throw new Error("The supervised room move lost its exact activating inbox turn.");
        this.assertEffectAdmissionCapacity(database, {
          agent_id: input.agent_id,
          execution_generation_id: input.effect_execution_generation_id,
          provider_turn_id: input.provider_turn_id,
        }, requestJson);
        created = true;
        effectId = randomUUID();
        const timestamp = this.now();
      run(database.prepare(`INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,'prepared',NULL,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.effect_execution_generation_id, input.provider_turn_id,
        input.mcp_request_id, "join_room", requestJson, timestamp, timestamp);
      }
      const result = {
        destination_room: input.destination_room_id,
        requested_room: input.destination_room_id,
        phase: "prepared",
        room_move_operation_id: `room_move:${effectId}`,
      };
      const resultJson = serializeEffectJson(result, "prepared result");
      const preparedEffect = rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row);
      this.assertEffectResultCapacity(database, preparedEffect, resultJson);
      run(database.prepare("UPDATE supervised_agent_effects SET result_json=?,updated_at=? WHERE effect_id=? AND state='prepared'"),
        resultJson, this.now(), effectId);
      const requestId = `bounded-effect:${effectId}`;
      const operationId = `room_move:${effectId}`;
      const existingMove = database.prepare("SELECT * FROM agent_room_moves WHERE request_id=?").get(requestId) as Row | undefined;
      if (existingMove) {
        if (String(existingMove.operation_id) !== operationId || String(existingMove.agent_id) !== input.agent_id
          || String(existingMove.source_room_id) !== input.room_id || String(existingMove.destination_room_id) !== input.destination_room_id
          || String(existingMove.execution_generation_id) !== input.execution_generation_id
          || String(existingMove.effect_id) !== effectId) {
          throw new Error("Room-move request id is already bound to different coordinates.");
        }
      } else {
        const unresolvedControl = database.prepare(`SELECT action_id FROM turn_control_journals
          WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain')`).get(input.agent_id);
        if (unresolvedControl) throw new Error("Room move is blocked by unresolved turn control.");
        assertNoDeliveryDrain(database, input.agent_id);
        assertNoPollingActivation(database, input.agent_id);
        const timestamp = this.now();
        const sourceCursor = database.prepare("SELECT last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?")
          .get(input.agent_id, input.room_id) as Row | undefined;
        run(database.prepare(`INSERT INTO agent_room_moves(operation_id,request_id,agent_id,source_room_id,destination_room_id,daemon_generation,work_attempt_id,execution_generation_id,agent_session_id,activating_inbox_item_id,provider_turn_id,effect_id,phase,remote_room_id,destination_cursor,error,created_at,updated_at,source_cursor_present,source_cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)`),
        operationId, requestId, input.agent_id, input.room_id, input.destination_room_id, input.daemon_generation,
        input.work_attempt_id, input.execution_generation_id, input.agent_session_id, input.activating_inbox_item_id,
        input.provider_turn_id, effectId, "prepared", timestamp, timestamp, sourceCursor ? 1 : 0,
        sourceCursor?.last_observed_message_id ?? null);
      }
      return { created, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
    }, commitFence));
  }

  async preparedRoomMove(agentId: string, originExecutionGenerationId: string, providerTurnId: string): Promise<SupervisedEffectRecord | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND tool_name='join_room' AND state='prepared'
        ORDER BY created_at LIMIT 1`).get(agentId, originExecutionGenerationId, providerTurnId) as Row | undefined;
      return row ? rowToEffect(row) : null;
    });
  }

  async preparedRoomMoves(agentId?: string): Promise<SupervisedEffectRecord[]> {
    return this.read(async (database) => {
      const rows = agentId
        ? database.prepare(`SELECT * FROM supervised_agent_effects
          WHERE agent_id=? AND tool_name='join_room' AND state='prepared' ORDER BY created_at`).all(agentId) as Row[]
        : database.prepare(`SELECT * FROM supervised_agent_effects
          WHERE tool_name='join_room' AND state='prepared' ORDER BY created_at`).all() as Row[];
      return rows.map(rowToEffect);
    });
  }

  /**
   * Read every structured completion proposal for one exact provider turn.
   * Callers deliberately receive the whole (normally singleton) set so a
   * duplicate proposal is observable as a conflict, never resolved by row
   * order or last-write-wins behavior.
   */
  async roomTurnCompletionEffects(
    agentId: string,
    originExecutionGenerationId: string,
    providerTurnId: string,
  ): Promise<SupervisedEffectRecord[]> {
    return this.read(async (database) => {
      const rows = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
          AND tool_name='complete_room_turn'
        ORDER BY created_at,effect_id`).all(
        agentId,
        originExecutionGenerationId,
        providerTurnId,
      ) as Row[];
      return rows.map(rowToEffect);
    });
  }

  async inboxForProviderTurn(agentId: string, providerTurnId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT * FROM supervised_agent_inbox
        WHERE agent_id=? AND provider_turn_id=? ORDER BY fifo_sequence LIMIT 1`).get(agentId, providerTurnId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }

  /** Commit the queue side of a room move atomically: later old-room work is
   * cancelled and the old cursor/health authority is removed. */
  async commitRoomMoveQueue(
    input: { operation_id: string; agent_id: string; old_room_id: string; after_fifo_sequence: number },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<number> {
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const rows = database.prepare(`SELECT * FROM supervised_agent_inbox
        WHERE agent_id=? AND room_id=? AND fifo_sequence>? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence`).all(input.agent_id, input.old_room_id, input.after_fifo_sequence) as Row[];
      const timestamp = this.now();
      for (const row of rows) {
        const item = rowToItem(row);
        run(database.prepare(`UPDATE supervised_agent_inbox SET state='cancelled_by_room_move',last_error=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`),
          "Cancelled because the agent moved to another room.", timestamp, timestamp, item.inbox_item_id);
        this.settleTerminalItem(database, item, timestamp);
        this.recordEvent(database, item.inbox_item_id, `room_move_cancelled:${input.operation_id}:${item.fifo_sequence}`, "room_move_cancelled", timestamp, "Agent moved rooms after completing an earlier message.");
      }
      run(database.prepare("DELETE FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?"), input.agent_id, input.old_room_id);
      run(database.prepare("DELETE FROM supervised_agent_ingress_health WHERE agent_id=? AND room_id=?"), input.agent_id, input.old_room_id);
      // This is safe during the move because the shared retention policy pins
      // every row owned by its still-recoverable compensation journal. It can
      // still compact unrelated terminal history in the same transaction.
      this.pruneAgentHistory(database, input.agent_id);
      return rows.length;
    }, commitFence));
  }

  /**
   * Idempotently restore the exact source ingress truth after a room-move
   * compensation. Only queue rows cancelled by this operation are revived.
   */
  async rollbackRoomMoveIngress(input: {
    operation_id: string; agent_id: string; source_room_id: string; destination_room_id: string;
    source_cursor_present: boolean; source_cursor: string | null; after_fifo_sequence: number;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<number> {
    this.require(input.operation_id, "operation_id"); this.require(input.agent_id, "agent_id");
    this.require(input.source_room_id, "source_room_id"); this.require(input.destination_room_id, "destination_room_id");
    if (input.source_room_id === input.destination_room_id) throw new Error("Room-move rollback requires distinct rooms.");
    if (input.source_cursor !== null) this.requireNumericCursor(input.source_cursor);
    if (!input.source_cursor_present && input.source_cursor !== null) throw new Error("Absent source cursor authority cannot carry a cursor value.");
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      // Prove exact operation ownership from the append-only cancellation
      // event before reviving each bounded source-room candidate.
      const candidates = database.prepare(`SELECT i.* FROM supervised_agent_inbox i
        WHERE i.agent_id=? AND i.room_id=? AND i.fifo_sequence>? AND i.state='cancelled_by_room_move'
        ORDER BY i.fifo_sequence`).all(input.agent_id, input.source_room_id, input.after_fifo_sequence) as Row[];
      const timestamp = this.now();
      let restored = 0;
      for (const row of candidates) {
        const item = rowToItem(row);
        const owned = database.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?").get(
          item.inbox_item_id, `room_move_cancelled:${input.operation_id}:${item.fifo_sequence}`,
        );
        if (!owned) continue;
        run(database.prepare(`UPDATE supervised_agent_inbox SET state='pending',last_error=?,updated_at=?,acknowledged_at=NULL WHERE inbox_item_id=? AND state='cancelled_by_room_move'`),
          "Room move rolled back; source-room delivery was restored without starting a duplicate provider turn.", timestamp, item.inbox_item_id);
        this.recordEvent(database, item.inbox_item_id, `room_move_rollback:${input.operation_id}:${item.fifo_sequence}`, "retry_scheduled", timestamp, "Source-room delivery restored after room-move rollback.");
        restored += 1;
      }
      run(database.prepare("DELETE FROM supervised_agent_ingress_cursors WHERE agent_id=?"), input.agent_id);
      if (input.source_cursor_present) {
        run(database.prepare("INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES(?,?,?,?)"),
          input.agent_id, input.source_room_id, input.source_cursor, timestamp);
      }
      run(database.prepare("DELETE FROM supervised_agent_ingress_health WHERE agent_id=?"), input.agent_id);
      return restored;
    }, commitFence));
  }

  async completeEffect(input: {
    effect_id: string; result?: unknown; error?: string;
    expected?: { agent_id: string; work_attempt_id: string; provider_turn_id?: string | null };
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<SupervisedEffectRecord> {
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row | undefined;
      const tombstone = row ? undefined
        : database.prepare("SELECT * FROM supervised_agent_effect_tombstones WHERE effect_id=?").get(input.effect_id) as Row | undefined;
      if (!row && !tombstone) throw new Error("Unknown supervised effect.");
      const effect = row ? rowToEffect(row) : rowToTombstonedEffect(tombstone!);
      if (input.expected && (effect.agent_id !== input.expected.agent_id
        || (input.expected.provider_turn_id && effect.provider_turn_id !== input.expected.provider_turn_id))) {
        throw new Error("The supervised effect does not belong to the exact active turn.");
      }
      if (input.expected) {
        const binding = database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
          WHERE agent_id=? AND room_id=? AND work_attempt_id=? AND origin_execution_generation_id=? AND provider_turn_id=?`)
          .get(effect.agent_id, effect.room_id, input.expected.work_attempt_id,
            effect.execution_generation_id, effect.provider_turn_id);
        if (!binding) throw new Error("The supervised effect completion lost its durable provider-turn authority binding.");
      }
      if (effect.state === "completed" || effect.state === "failed") {
        this.pruneAgentHistory(database, effect.agent_id);
        return effect;
      }
      if (effect.state !== "executing" && effect.state !== "uncertain" && effect.tool_name !== "join_room") throw new Error("A supervised effect must be executing or uncertain before completion.");
      const failed = Boolean(input.error);
      const resultJson = input.result === undefined
        ? null
        : this.boundedCompletionResultJson(database, effect, input.result);
      const error = input.error ? truncateEffectError(input.error) : null;
      const target = tombstone ? "supervised_agent_effect_tombstones" : "supervised_agent_effects";
      run(database.prepare(`UPDATE ${target} SET state=?,result_json=?,error=?,updated_at=? WHERE effect_id=?`),
        failed ? "failed" : "completed", resultJson, error, this.now(), input.effect_id);
      const completedRow = database.prepare(`SELECT * FROM ${target} WHERE effect_id=?`).get(input.effect_id) as Row;
      const completed = tombstone ? rowToTombstonedEffect(completedRow) : rowToEffect(completedRow);
      this.pruneAgentHistory(database, effect.agent_id);
      return completed;
    }, commitFence));
  }
  /** Persist provider terminal evidence before advancing out of dispatching. */
  async checkpointTerminalOutcome(inboxItemId: string, outcome: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching" && item.state !== "awaiting_result") throw new Error("Provider terminal evidence may only be checkpointed while delivery is in-flight.");
      this.assertCurrentHead(database, item);
      if (readDurableNativeFailure(database, inboxItemId)) {
        if (outcome !== item.outcome) throw new Error("Exact native terminal failure cannot be overwritten.");
        return item;
      }
      let kind: unknown;
      try { kind = JSON.parse(outcome).kind; } catch { /* Legacy opaque outcomes remain supported. */ }
      if (kind === "failed" || kind === "interrupted") throw new Error("Native failure outcomes require the exact terminal checkpoint.");
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET outcome=?,updated_at=? WHERE inbox_item_id=?"), outcome, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `turn_finished:${item.attempt_count}`, "turn_finished", timestamp, null);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  async retryBlocked(inboxItemId: string): Promise<SupervisedInboxItem> {
    return this.transition(inboxItemId, "pending", {
      blocked_by_inbox_item_id: null,
      next_attempt_at_ms: null,
      failure_code: null,
    });
  }

  async beginContinuationRepair(input: {
    agent_id: string;
    room_id: string;
    inbox_item_id: string;
    daemon_generation: number;
    execution_generation_id: string;
    work_attempt_id: string;
    expected_pid: number;
    expected_process_identity: string;
    missing_continuation: string;
  }): Promise<ProviderContinuationRepair> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      assertNoDeliveryDrain(database, input.agent_id);
      assertNoPollingActivation(database, input.agent_id);
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row | undefined;
      if (!row) throw new Error("The blocked room message no longer exists.");
      const item = rowToItem(row);
      if (item.agent_id !== input.agent_id || item.room_id !== input.room_id
        || item.state !== "blocked" || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0 || item.provider_turn_id || item.outcome) {
        throw new Error("Conversation restoration is no longer safe for this room message.");
      }
      this.assertCurrentHead(database, item);
      const active = database.prepare(`SELECT * FROM provider_continuation_repairs
        WHERE agent_id=? AND phase NOT IN ('committed','failed') LIMIT 1`).get(input.agent_id) as Row | undefined;
      if (active) {
        const repair = rowToContinuationRepair(active);
        if (repair.inbox_item_id !== input.inbox_item_id
          || repair.execution_generation_id !== input.execution_generation_id
          || repair.work_attempt_id !== input.work_attempt_id
          || repair.expected_pid !== input.expected_pid
          || repair.expected_process_identity !== input.expected_process_identity
          || repair.missing_continuation !== input.missing_continuation) {
          throw new Error("Another continuation repair owns this agent.");
        }
        if (repair.daemon_generation !== input.daemon_generation) {
          run(database.prepare("UPDATE provider_continuation_repairs SET daemon_generation=?,updated_at=? WHERE repair_id=?"),
            input.daemon_generation, this.now(), repair.repair_id);
          return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as Row);
        }
        return repair;
      }
      const failed = database.prepare(`SELECT * FROM provider_continuation_repairs
        WHERE agent_id=? AND inbox_item_id=? AND phase='failed'
        ORDER BY created_at DESC LIMIT 1`).get(input.agent_id, input.inbox_item_id) as Row | undefined;
      if (failed) {
        const repair = rowToContinuationRepair(failed);
        if (repair.execution_generation_id !== input.execution_generation_id
          || repair.work_attempt_id !== input.work_attempt_id
          || repair.expected_pid !== input.expected_pid
          || repair.expected_process_identity !== input.expected_process_identity
          || repair.missing_continuation !== input.missing_continuation) {
          throw new Error("The failed continuation repair belongs to a different provider authority.");
        }
        const timestamp = this.now();
        run(database.prepare(`UPDATE provider_continuation_repairs
          SET daemon_generation=?,phase=?,attempt_count=attempt_count+1,last_error=NULL,updated_at=?
          WHERE repair_id=?`),
        input.daemon_generation, repair.replacement_continuation ? "replacement_created" : "probing", timestamp, repair.repair_id);
        run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?"),
          "Restoring the saved provider conversation before any model work starts.", timestamp, input.inbox_item_id);
        this.recordEvent(database, input.inbox_item_id, `conversation_restoring:${repair.repair_id}:${repair.attempt_count + 1}`, "conversation_restoring", timestamp, "Retrying conversation restoration with the exact current provider authority.");
        return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as Row);
      }
      const timestamp = this.now();
      const repairId = randomUUID();
      run(database.prepare(`INSERT INTO provider_continuation_repairs
        (repair_id,agent_id,room_id,inbox_item_id,daemon_generation,execution_generation_id,work_attempt_id,expected_pid,expected_process_identity,missing_continuation,replacement_continuation,phase,attempt_count,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'probing',1,NULL,?,?)`),
      repairId, input.agent_id, input.room_id, input.inbox_item_id, input.daemon_generation,
      input.execution_generation_id, input.work_attempt_id, input.expected_pid,
      input.expected_process_identity, input.missing_continuation, timestamp, timestamp);
      run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?"),
        "Restoring the saved provider conversation before any model work starts.", timestamp, input.inbox_item_id);
      this.recordEvent(database, input.inbox_item_id, `conversation_restoring:${repairId}`, "conversation_restoring", timestamp, "Verifying the saved conversation on the existing provider process.");
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async checkpointContinuationReplacement(repairId: string, replacementContinuation: string): Promise<ProviderContinuationRepair> {
    if (!replacementContinuation.trim()) throw new Error("Replacement continuation is required.");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "committed") {
        if (repair.replacement_continuation !== replacementContinuation) throw new Error("Committed continuation repair has a different replacement.");
        return repair;
      }
      if (repair.phase === "failed") throw new Error("A failed continuation repair cannot install a replacement.");
      if (repair.replacement_continuation && repair.replacement_continuation !== replacementContinuation) {
        throw new Error("Continuation repair replacement identity changed.");
      }
      run(database.prepare(`UPDATE provider_continuation_repairs
        SET replacement_continuation=?,phase='replacement_created',updated_at=? WHERE repair_id=?`),
      replacementContinuation, this.now(), repairId);
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async commitContinuationRepair(repairId: string, authoritativeContinuation: string, continuityReset: boolean): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "failed") throw new Error("A failed continuation repair cannot be committed.");
      if (repair.replacement_continuation) {
        if (repair.replacement_continuation !== authoritativeContinuation) {
          throw new Error("Continuation repair cannot commit a different replacement conversation.");
        }
      } else if (authoritativeContinuation !== repair.missing_continuation) {
        throw new Error("A rematerialized conversation must match the original continuation.");
      }
      const itemRow = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(repair.inbox_item_id) as Row | undefined;
      if (!itemRow) throw new Error("Continuation repair lost its room message.");
      const item = rowToItem(itemRow);
      if (item.state !== "blocked" || item.attempt_count !== 0 || item.provider_turn_id || item.outcome) {
        throw new Error("Continuation repair can no longer release this room message.");
      }
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare(`UPDATE provider_continuation_repairs
        SET replacement_continuation=?,phase='committed',last_error=NULL,updated_at=? WHERE repair_id=?`),
      authoritativeContinuation, timestamp, repairId);
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='pending',last_error=NULL,failure_code=NULL,blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,updated_at=?
        WHERE inbox_item_id=?`), timestamp, item.inbox_item_id);
      const detail = continuityReset
        ? "Conversation restored with a replacement thread; durable agent identity and workspace were preserved."
        : "The saved conversation became available again; no replacement was created.";
      this.recordEvent(database, item.inbox_item_id, `conversation_restored:${repairId}`, "conversation_restored", timestamp, detail);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
    }));
  }

  async failContinuationRepair(repairId: string, error: string): Promise<ProviderContinuationRepair> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "committed") return repair;
      const timestamp = this.now();
      run(database.prepare("UPDATE provider_continuation_repairs SET phase='failed',last_error=?,updated_at=? WHERE repair_id=?"),
        error, timestamp, repairId);
      run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=? AND state='blocked'"),
        error, timestamp, repair.inbox_item_id);
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async exhaustCommittedContinuationRepair(
    inboxItemId: string,
    repairId: string,
    error: string,
  ): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const repairRow = database.prepare(
        "SELECT * FROM provider_continuation_repairs WHERE repair_id=?",
      ).get(repairId) as Row | undefined;
      const itemRow = database.prepare(
        "SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?",
      ).get(inboxItemId) as Row | undefined;
      if (!repairRow || !itemRow) throw new Error("Conversation restoration evidence is no longer available.");
      const repair = rowToContinuationRepair(repairRow);
      const item = rowToItem(itemRow);
      if (
        repair.inbox_item_id !== item.inbox_item_id
        || repair.agent_id !== item.agent_id
        || repair.phase !== "committed"
        || item.state !== "blocked"
        || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0
        || item.provider_turn_id
        || item.outcome
      ) {
        throw new Error("Conversation restoration can no longer be exhausted safely.");
      }
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(
        database.prepare(
          "UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?",
        ),
        error,
        timestamp,
        inboxItemId,
      );
      this.recordEvent(
        database,
        inboxItemId,
        `continuation_repair_exhausted:${repairId}`,
        "blocked",
        timestamp,
        error,
      );
      return rowToItem(
        database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row,
      );
    }));
  }

  async latestContinuationRepair(agentId: string): Promise<ProviderContinuationRepair | null> {
    return this.read(async (database) => {
      const row = this.reads.get(database, "latestRepair").get(agentId) as Row | undefined;
      return row ? rowToContinuationRepair(row) : null;
    });
  }

  /**
   * Settle a blocked FIFO head as skipped by the user. Nothing is sent to the
   * provider: a turn that already ran is never rerun, and its answer is
   * dropped.
   */
  async skipBlocked(inboxItemId: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error("The blocked room message no longer exists.");
      const item = rowToItem(row);
      if (item.state !== "blocked") throw new Error("This message is no longer blocked, so it cannot be skipped.");
      this.assertCurrentHead(database, item);
      const refusal = this.blockedSkipRefusal(database, item);
      if (refusal) throw new Error(refusal);
      const started = providerWorkStarted(item);
      const detail = started
        ? "Skipped by the user. The provider's turn was not rerun and its answer was dropped."
        : "Skipped by the user before any provider turn started.";
      // A follow-up has no room message of its own. Its owner reads on the message it is for what became of it, so a
      // follow-up that was skipped before it started says that it was skipped, and nothing more: no attempt waited for
      // its time, and what the task is now is not known here. A follow-up that started keeps the text of a started turn.
      const lastError = started ? detail : item.source_message_id.startsWith("task-continuation:") ? FOLLOW_UP_ENDED.skippedByOwner : null;
      const timestamp = this.now();
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='cancelled_by_user',last_error=?,failure_code=NULL,updated_at=?,acknowledged_at=?
        WHERE inbox_item_id=?`), lastError, timestamp, timestamp, inboxItemId);
      this.settleTerminalItem(database, item, timestamp);
      this.recordEvent(database, inboxItemId, "user_cancelled", "user_cancelled", timestamp, detail);
      this.pruneAgentHistory(database, item.agent_id);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }

  /** Whether the agent's blocked FIFO head may be skipped now, by the same rule skipBlocked enforces. */
  async blockedHeadSkip(agentId: string): Promise<{ inbox_item_id: string; refusal: string | null } | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT * FROM supervised_agent_inbox WHERE agent_id=?
        AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence LIMIT 1`).get(agentId) as Row | undefined;
      if (!row || String(row.state) !== "blocked") return null;
      const item = rowToItemMetadata(row);
      return { inbox_item_id: item.inbox_item_id, refusal: this.blockedSkipRefusal(database, item) };
    });
  }

  /**
   * Why a blocked message may not be skipped now, or null. A started turn is
   * skippable only when it cannot still be running: its terminal result is
   * recorded, or the agent's current runtime (read here, in the same
   * transaction) has a different work attempt or conversation. The daemon
   * installs those only after the old runtime is proven stopped, or, for a
   * same-process conversation repair, only while no provider turn is active.
   */
  private blockedSkipRefusal(database: DatabaseSync, item: SupervisedInboxItemMetadata): string | null {
    if (persistedTerminalOutcome(item.outcome)?.kind === "reply"
      || database.prepare("SELECT 1 FROM supervised_agent_publications WHERE inbox_item_id=?").get(item.inbox_item_id)) {
      return "This message has a saved reply that wasn't posted. Post the saved reply instead; the provider is not asked again.";
    }
    if (database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND inbox_item_id=? AND turn_control_present=1")
      .get(item.agent_id, item.inbox_item_id)) {
      return "A stop or correction for this message is still being settled. Try again once it finishes.";
    }
    if (!providerWorkStarted(item)) return null;
    // The provider finished this exact turn; only its answer is dropped.
    const terminal = database.prepare("SELECT provider_turn_id FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
      .get(item.inbox_item_id) as Row | undefined;
    if (terminal && item.provider_turn_id && String(terminal.provider_turn_id) === item.provider_turn_id) return null;
    const binding = database.prepare("SELECT work_attempt_id,provider_continuation_id FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
      .get(item.inbox_item_id) as Row | undefined;
    const current = database.prepare(`SELECT CASE WHEN work_attempt_id_present=1 THEN work_attempt_id END AS work_attempt_id,
      CASE WHEN provider_ref_present=1 THEN provider_continuation_id END AS provider_continuation_id
      FROM runtime_deployments WHERE agent_id=?`).get(item.agent_id) as Row | undefined;
    if (binding && current?.work_attempt_id && current.provider_continuation_id
      && (String(binding.work_attempt_id) !== String(current.work_attempt_id)
        || String(binding.provider_continuation_id) !== String(current.provider_continuation_id))) return null;
    return "This message can't be skipped yet: provider work may already have started and may still be running. Retry delivery to read its saved turn again, or use Start fresh to replace the agent's conversation; Skip is available after either one settles it.";
  }
  /**
   * Settle the in-flight FIFO head as user-cancelled when a Stop (or a
   * stop-then-resend correction) interrupts a turn that provider work already
   * touched. `skipBlocked` covers only the never-started case; this is the sole
   * `cancelled_by_user` path once dispatch has begun.
   *
   * It settles from ANY pre-publish state — including `retryable`, `pending`,
   * and `blocked`, which a racing `deliver()` catch may have committed for the
   * SAME turn between the provider-interrupt rejection and this settlement (a
   * claude-code native interrupt rejects the in-flight turn, so the catch can
   * transition to `retryable` first). Settling those too is what stops a stopped
   * turn from being mis-reported as published and then re-dispatched.
   *
   * It is deliberately a no-op once the item reaches `publishing` or a terminal
   * state: past that commit the reply is being (or has been) posted, so the
   * published outcome stays authoritative and the interrupt loses the race.
   * Because both this write and the delivery pump's `publishing` transition are
   * serialized inbox transactions on the exact FIFO head, exactly one wins —
   * this is the mutual exclusion that stops one turn producing two outcomes.
   * The returned item's `state` tells the caller which side won (`cancelled_by_user`
   * → interrupt settled it; anything else → publication already committed).
   */
  async cancelInterruptedTurn(
    inboxItemId: string,
    detail = "Stopped by the user.",
    expected?: { agent_id: string; room_id: string },
  ): Promise<SupervisedInboxItem | null> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = cancelInterruptedSupervisedTurn(database, inboxItemId, detail, this.now(), expected);
      return row ? rowToItem(row) : null;
    }));
  }

  /**
   * Recover only effect execution boundaries. Daemon startup calls this even
   * for paused/stopped agents so a crashed mutation cannot remain an immortal
   * purge or quota blocker while no provider pump is eligible to start.
   */
  async normalizeInterruptedEffects(agentId?: string): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => {
      const scope = agentId ? " AND agent_id=?" : "";
      const affected = database.prepare(`SELECT DISTINCT agent_id FROM supervised_agent_effects
        WHERE state='executing' AND tool_name<>'join_room'${scope}`).all(
        ...(agentId ? [agentId] : []) as never[],
      ) as Row[];
      this.normalizeInterruptedEffectsInTransaction(database, agentId, this.now());
      for (const row of affected) this.pruneAgentHistory(database, String(row.agent_id));
    }));
  }

  /**
   * Normalize work interrupted by a daemon crash before a new runtime is
   * allowed to pump it. Delivery also runs this whenever it restarts one
   * agent's room delivery (a changed worker credential, provider handle or
   * binding), so the details say the delivery restarted, not the daemon.
   * A persisted reply is authoritative terminal evidence:
   * it may be published again with its stable client id, but must never invoke
   * the provider again. Everything else that was in-flight is ambiguous and
   * remains visible as blocked rather than being accidentally acknowledged.
   */
  async normalizeStartupRecovery(
    agentId: string,
    policy: { resetCheckpointGatedUnstartedDispatch?: boolean } = {},
  ): Promise<SupervisedInboxItem[]> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const interruptedAt = this.now();
      this.normalizeInterruptedEffectsInTransaction(database, agentId, interruptedAt);
      const rows = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence").all(agentId) as Row[];
      const recovered: SupervisedInboxItem[] = [];
      for (const row of rows) {
        const item = rowToItem(row);
        const terminal = persistedTerminalOutcome(item.outcome);
        let next: SupervisedInboxState | null = null;
        let error: string | null = item.last_error;
        if (readDurableNativeFailure(database, item.inbox_item_id)) {
          next = "acknowledged_failed";
          error = item.last_error;
        } else if (item.state === "result_recovery") {
          next = "result_recovery";
          error = "Checking the existing provider turn; no new model turn will start.";
        } else if (item.state === "dispatching" || item.state === "awaiting_result" || item.state === "publishing" || item.state === "retryable") {
          if (terminal?.kind === "reply") {
            // Republish only: delivery sees the durable outcome before it can
            // consider runRoomTurn, so a recovered provider turn is impossible.
            next = "pending";
            error = item.state === "dispatching"
              ? "Room delivery restarted after a durable provider reply; publishing it without rerunning the provider."
              : item.state === "publishing"
              ? "Room delivery restarted during publication; retrying the durable reply."
              : item.state === "retryable"
                ? "Retrying the durable reply after a recoverable failure."
                : "Room delivery restarted after a durable provider reply; publishing it."
          } else if (terminal?.kind === "no_reply") {
            next = "acknowledged_no_reply";
            error = null;
          } else if (terminal?.kind === "unreadable" && item.provider_turn_id) {
            next = "result_recovery";
            error = "Provider completed, but its answer could not be read; re-reading the same turn without rerunning it.";
          } else if (item.provider_turn_id && (item.state === "dispatching" || item.state === "awaiting_result" || item.state === "retryable")) {
            // This is not a retry: delivery will ask the provider to inspect
            // precisely this persisted turn id and will block if it cannot.
            next = "pending";
            error = "Room delivery restarted while awaiting the exact persisted provider turn; recovering it without rerunning.";
          } else if (policy.resetCheckpointGatedUnstartedDispatch
            && item.state === "dispatching"
            && item.attempt_count === 0
            && !item.provider_turn_id
            && !item.outcome) {
            // Cursor's supervised wrapper cannot release native work before
            // its exact turn id is committed. This shape therefore proves the
            // prior generation never dispatched and is safe to requeue. Never
            // apply this provider capability to Codex/Claude/Open Model.
            next = "pending";
            error = "Recovered an unstarted checkpoint-gated Cursor delivery; retrying without duplicate provider work.";
          } else {
            next = "blocked";
            error = `Room delivery restarted during ${item.state} without authoritative terminal or publication evidence; acknowledgement is unsafe.`;
          }
        }
        if (!next) continue;
        const timestamp = this.now();
        run(database.prepare("UPDATE supervised_agent_inbox SET state=?,last_error=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?"),
          next, error, timestamp, finalStates.has(next) ? timestamp : null, item.inbox_item_id);
        const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
        const phase = phaseForTransition(next);
        const key = `recovery:${phase}:${updated.attempt_count}`;
        // A row left in its state is the same fact again; a real transition is recorded every time.
        if (phase) this.recordEvent(database, updated.inbox_item_id, next === item.state ? key : this.occurrenceKey(database, updated.inbox_item_id, key, phase), phase, timestamp, error);
        if (finalStates.has(next)) {
          this.settleTerminalItem(database, item, timestamp);
          this.pruneAgentHistory(database, item.agent_id);
        }
        recovered.push(updated);
      }
      this.pruneAgentHistory(database, agentId);
      return recovered;
    }));
  }
  private assertEffectAdmissionCapacity(
    database: DatabaseSync,
    input: { agent_id: string; execution_generation_id: string; provider_turn_id: string; tool_name?: string },
    requestJson: string,
  ): void {
    const requestBytes = Buffer.byteLength(requestJson, "utf8");
    if (requestBytes > MAX_EFFECT_REQUEST_BYTES) {
      throw new Error(`A supervised effect request exceeds the ${MAX_EFFECT_REQUEST_BYTES}-byte durable limit.`);
    }
    // This exact singleton is the turn's mandatory publication contract. Its
    // own request is bounded to 32 KiB by validation, so ordinary tools cannot
    // consume the slot or aggregate byte budget needed to finish the turn.
    if (input.tool_name === "complete_room_turn") return;
    const usage = database.prepare(`SELECT COUNT(*) AS effect_count,COALESCE(SUM(request_bytes),0) AS request_bytes
      FROM (
        SELECT length(CAST(request_json AS BLOB)) AS request_bytes
        FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
        UNION ALL
        SELECT request_bytes FROM supervised_agent_effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
      )`).get(
      input.agent_id, input.execution_generation_id, input.provider_turn_id,
      input.agent_id, input.execution_generation_id, input.provider_turn_id,
    ) as Row;
    if (Number(usage.effect_count) >= MAX_EFFECTS_PER_PROVIDER_TURN) {
      throw new Error(`A supervised provider turn may durably admit at most ${MAX_EFFECTS_PER_PROVIDER_TURN} effects.`);
    }
    if (Number(usage.request_bytes) + requestBytes > MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN) {
      throw new Error(`A supervised provider turn exceeds the ${MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN}-byte durable request budget.`);
    }
    const unresolved = database.prepare(`SELECT COUNT(*) AS effect_count FROM supervised_agent_effects
      WHERE agent_id=? AND state IN ('prepared','executing')`).get(input.agent_id) as Row;
    if (Number(unresolved.effect_count) >= MAX_UNRESOLVED_EFFECTS_PER_AGENT) {
      throw new Error(`A supervised agent may retain at most ${MAX_UNRESOLVED_EFFECTS_PER_AGENT} unresolved effects across turns.`);
    }
  }
  private assertEffectResultCapacity(database: DatabaseSync, effect: SupervisedEffectRecord, resultJson: string): void {
    const resultBytes = Buffer.byteLength(resultJson, "utf8");
    if (resultBytes > MAX_EFFECT_RESULT_BYTES) {
      throw new Error(`A supervised effect prepared result exceeds the ${MAX_EFFECT_RESULT_BYTES}-byte durable limit.`);
    }
    const usage = database.prepare(`SELECT COALESCE(SUM(result_bytes),0) AS result_bytes FROM (
        SELECT length(CAST(result_json AS BLOB)) AS result_bytes FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND effect_id<>?
        UNION ALL
        SELECT length(CAST(result_json AS BLOB)) AS result_bytes FROM supervised_agent_effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND effect_id<>?
      )`).get(
      effect.agent_id, effect.execution_generation_id, effect.provider_turn_id, effect.effect_id,
      effect.agent_id, effect.execution_generation_id, effect.provider_turn_id, effect.effect_id,
    ) as Row;
    if (Number(usage.result_bytes) + resultBytes > MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN) {
      throw new Error(`A supervised provider turn exceeds the ${MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN}-byte durable result budget.`);
    }
  }
  private boundedCompletionResultJson(database: DatabaseSync, effect: SupervisedEffectRecord, result: unknown): string | null {
    let serialized: string | null = null;
    let serializedBytes: number | null = null;
    try {
      serialized = serializeEffectJson(result, "completion result");
      serializedBytes = Buffer.byteLength(serialized, "utf8");
    } catch { /* Completion must settle even when an external result is not JSON-serializable. */ }
    const usage = database.prepare(`SELECT COALESCE(SUM(result_bytes),0) AS result_bytes FROM (
        SELECT length(CAST(result_json AS BLOB)) AS result_bytes FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND effect_id<>?
        UNION ALL
        SELECT length(CAST(result_json AS BLOB)) AS result_bytes FROM supervised_agent_effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND effect_id<>?
      )`).get(
      effect.agent_id, effect.execution_generation_id, effect.provider_turn_id, effect.effect_id,
      effect.agent_id, effect.execution_generation_id, effect.provider_turn_id, effect.effect_id,
    ) as Row;
    const priorBytes = Number(usage.result_bytes);
    if (serialized !== null && serializedBytes !== null
      && serializedBytes <= MAX_EFFECT_RESULT_BYTES
      && priorBytes + serializedBytes <= MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN) {
      return serialized;
    }
    const omission = JSON.stringify({
      supervised_effect_result_omitted: true,
      reason: serialized === null ? "not_json_serializable" : "durable_size_limit",
      serialized_bytes: serializedBytes,
    });
    return priorBytes + Buffer.byteLength(omission, "utf8") <= MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN
      ? omission
      : null;
  }
  private assertActiveEffectAuthority(database: DatabaseSync, input: {
    agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
  }): { inbox_item_id: string } {
    const rows = database.prepare(`SELECT b.inbox_item_id,i.state
      FROM supervised_agent_provider_turn_bindings b
      JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id
      WHERE b.agent_id=? AND b.room_id=? AND b.work_attempt_id=?
        AND b.origin_execution_generation_id=? AND b.provider_continuation_id=?
        AND b.provider_turn_id=? AND i.agent_id=b.agent_id AND i.room_id=b.room_id
        AND i.provider_turn_id=b.provider_turn_id`).all(
      input.agent_id, input.room_id, input.work_attempt_id, input.execution_generation_id,
      input.provider_continuation_id, input.provider_turn_id,
    ) as Row[];
    if (rows.length !== 1 || !["dispatching", "awaiting_result"].includes(String(rows[0]?.state))) {
      throw new EffectAuthorityError("A supervised effect requires one exact active durable provider-turn authority binding.");
    }
    const head = database.prepare(`SELECT inbox_item_id FROM supervised_agent_inbox
      WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
      ORDER BY fifo_sequence LIMIT 1`).get(input.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== String(rows[0]?.inbox_item_id)) {
      throw new EffectAuthorityError("The supervised effect provider turn is no longer the exact FIFO head.");
    }
    const runtime = database.prepare(`SELECT m.room_id,l.desired_state,d.work_attempt_id_present,d.work_attempt_id,
        d.provider_ref_present,d.provider_work_attempt_id,d.provider_continuation_id,d.provider_execution_generation_id,s.condition
      FROM agent_room_memberships m JOIN agent_launch_intents l USING(agent_id)
      JOIN runtime_deployments d USING(agent_id) JOIN agent_lifecycle_states s USING(agent_id)
      WHERE m.agent_id=?`).get(input.agent_id) as Row | undefined;
    if (pendingRuntimeRecovery(database, input.agent_id) || !runtime || String(runtime.room_id) !== input.room_id || String(runtime.desired_state) !== "running"
      || String(runtime.condition) !== "none" || Number(runtime.work_attempt_id_present) !== 1
      || String(runtime.work_attempt_id) !== input.work_attempt_id || Number(runtime.provider_ref_present) !== 1
      || String(runtime.provider_work_attempt_id) !== input.work_attempt_id
      || String(runtime.provider_continuation_id) !== input.provider_continuation_id
      || String(runtime.provider_execution_generation_id) !== input.current_execution_generation_id) {
      throw new EffectAuthorityError("The supervised effect lost its exact current runtime authority.");
    }
    if (database.prepare(`SELECT 1 FROM turn_control_journals
      WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain') LIMIT 1`)
      .get(input.agent_id)) {
      throw new EffectAuthorityError("The supervised effect is blocked by an unresolved turn-control authority barrier.");
    }
    return { inbox_item_id: String(rows[0]!.inbox_item_id) };
  }
  private normalizeInterruptedEffectsInTransaction(database: DatabaseSync, agentId: string | undefined, interruptedAt: string): void {
    const scope = agentId ? " AND agent_id=?" : "";
    const readArgs = [
      "Room delivery restarted before this read-only tool result was checkpointed. The exact request may be executed again safely.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='prepared',error=?,updated_at=?
      WHERE state='executing' AND mutation=0 AND tool_name<>'join_room'${scope}`), ...readArgs);
    const mutationArgs = [
      "Room delivery restarted after this mutating tool crossed its execution boundary. It may have completed; verify external state before repeating it.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='uncertain',error=?,updated_at=?
      WHERE state='executing' AND mutation=1 AND tool_name NOT IN ('join_room','complete_room_turn')${scope}`), ...mutationArgs);
    const completionArgs = [
      "Room delivery restarted while committing the local completion proposal; its durable request is safe to commit again.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='prepared',error=?,updated_at=?
      WHERE state='executing' AND tool_name='complete_room_turn'${scope}`), ...completionArgs);
  }
}

