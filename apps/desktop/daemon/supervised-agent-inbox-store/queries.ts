import { normalizeRoomGif, type RoomGif } from "../../../../shared/room-expressions.mjs";
import { validRecordedReplyAttachments, type RecordedReplyAttachment } from "../../../../shared/message-attachments.mjs";
import { DatabaseSync } from "node:sqlite";
import { ExecutionShadowStore } from "../execution-shadow-store.js";
import type { PreparedRoomContext, MessageIntervention } from "../../shared/message-outcome.js";
import { inspectorPreparedRoomContext } from "../prepared-room-context.js";
import { endedFollowUpReason, FOLLOW_UP_REASONS_THAT_ASK_THE_OWNER } from "../task-continuity.js";
import { queuedDeliveryKind } from "../queued-delivery-order.js";
import { RETAINED_UNCERTAIN_EFFECTS_PER_AGENT, RETAINED_TERMINAL_RECEIPTS_PER_AGENT } from "../supervised-agent-history-retention.js";
import type { SupervisedInboxState, SupervisedInboxReceiptState, SupervisedInboxItem, SupervisedProviderTurnBinding, SupervisedInboxEvent, SupervisedInboxReceiptWithTimeline, SupervisedInboxReceiptProjection, SupervisedInboxItemMetadata, AgentInspectorDetail, Row } from "./types.js";
import { finalStates, RETAINED_TIMELINE_EVENTS_PER_RECEIPT } from "./inbox-rules.js";
import { run, UNTOUCHED_PENDING_SQL, UNTOUCHED_BLOCKED_FOLLOW_UP_SQL } from "./sql.js";
import { rowToItem, rowToReceiptProjectionMetadata, rowToProviderTurnBinding, rowToEvent, rowToInspectorItem, rowToContinuationRepair, safeOutcome, safeSource, boundaryToDetail } from "./row-mapping.js";
import { InboxTaskContinuationStore } from "./task-continuations.js";

export abstract class InboxQueryStore extends InboxTaskContinuationStore {
  async cursor(agentId: string): Promise<{ agent_id: string; room_id: string; last_observed_message_id: string | null; updated_at: string } | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_ingress_cursors WHERE agent_id=?").get(agentId) as Row | undefined;
      return row ? { agent_id: String(row.agent_id), room_id: String(row.room_id), last_observed_message_id: row.last_observed_message_id === null ? null : String(row.last_observed_message_id), updated_at: String(row.updated_at) } : null;
    });
  }

  async head(agentId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence LIMIT 1").get(agentId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }

  async providerTurnBinding(inboxItemId: string): Promise<SupervisedProviderTurnBinding | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      return row ? rowToProviderTurnBinding(row) : null;
    });
  }
  /**
   * Whether the execution record holds this item's exact native turn without
   * an ending: recorded as started, or as lost with the runtime that ran it.
   * A turn the record never saw start is not open; there is nothing to close.
   */
  async recordedTurnIsOpen(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => {
      try {
        return Boolean(database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings b
          JOIN execution_turns t ON t.agent_id=b.agent_id
            AND t.provider_continuation_id=b.provider_continuation_id AND t.provider_turn_id=b.provider_turn_id
          WHERE b.inbox_item_id=? AND t.state IN ('none','active','lost')`).get(inboxItemId));
      } catch { return false; /* A database without an execution record has no turn to close. */ }
    });
  }
  /**
   * Whether the process that ran this item's saved turn has ended: the
   * execution generation the turn started in is not the one given, and has a
   * recorded terminal.
   */
  async providerTurnProcessEnded(inboxItemId: string, currentExecutionGenerationId: string): Promise<boolean> {
    return this.read(async (database) => {
      try {
        return Boolean(database.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings b
          JOIN work_attempt_executions e ON e.execution_generation_id=b.origin_execution_generation_id AND e.work_attempt_id=b.work_attempt_id
          WHERE b.inbox_item_id=? AND b.origin_execution_generation_id<>? AND e.terminal_json IS NOT NULL`)
          .get(inboxItemId, currentExecutionGenerationId));
      } catch { return false; /* Without the durable executions there is no proof that the process ended. */ }
    });
  }
  /** Completed routing controls carry no text and grant no publication authority.
   * Retain legacy intercepted requests for already-running provider versions;
   * Stop may fail those effects before a native reply wins publication. */
  async hasInterceptedThreadReply(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => Boolean(database.prepare(`SELECT 1
      FROM supervised_agent_inbox i
      JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
        AND b.agent_id=i.agent_id AND b.room_id=i.room_id AND b.provider_turn_id=i.provider_turn_id
      JOIN supervised_agent_effects e ON e.agent_id=b.agent_id AND e.room_id=b.room_id
        AND e.execution_generation_id=b.origin_execution_generation_id AND e.provider_turn_id=b.provider_turn_id
      WHERE i.inbox_item_id=? AND (
        (e.state='completed' AND e.tool_name='set_reply_thread') OR
        (e.state IN ('prepared','failed') AND e.tool_name IN ('send_message','send_thread_message')
          AND json_extract(e.request_json,'$.thread_parent_id')=i.source_message_id))
      LIMIT 1`).get(inboxItemId)));
  }
  /** The last GIF choice for this exact bound turn, never a previous attempt. */
  async replyGif(inboxItemId: string): Promise<RoomGif | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT e.request_json FROM supervised_agent_inbox i
        JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
          AND b.agent_id=i.agent_id AND b.room_id=i.room_id AND b.provider_turn_id=i.provider_turn_id
        JOIN supervised_agent_effects e ON e.agent_id=b.agent_id AND e.room_id=b.room_id
          AND e.execution_generation_id=b.origin_execution_generation_id AND e.provider_turn_id=b.provider_turn_id
        WHERE i.inbox_item_id=? AND e.state='completed' AND e.tool_name='set_reply_gif'
        ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`).get(inboxItemId) as Row | undefined;
      return row ? normalizeRoomGif(JSON.parse(String(row.request_json)).gif) : null;
    });
  }
  /** The last attachment choice for this exact bound turn; files:null clears an earlier one. */
  async replyAttachments(inboxItemId: string): Promise<RecordedReplyAttachment[]> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT e.request_json FROM supervised_agent_inbox i
        JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
          AND b.agent_id=i.agent_id AND b.room_id=i.room_id AND b.provider_turn_id=i.provider_turn_id
        JOIN supervised_agent_effects e ON e.agent_id=b.agent_id AND e.room_id=b.room_id
          AND e.execution_generation_id=b.origin_execution_generation_id AND e.provider_turn_id=b.provider_turn_id
        WHERE i.inbox_item_id=? AND e.state='completed' AND e.tool_name='set_reply_attachments'
        ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`).get(inboxItemId) as Row | undefined;
      const request = row ? JSON.parse(String(row.request_json)) as unknown : null;
      return validRecordedReplyAttachments(request) ? request.files ?? [] : [];
    });
  }
  /** Reuse the queue's exact no-dispatch/retry/control-history boundary. */
  async untouchedPending(inboxItemId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async database => {
      const row = database.prepare(`SELECT i.* FROM supervised_agent_inbox i WHERE i.inbox_item_id=? AND ${UNTOUCHED_PENDING_SQL}`)
        .get(inboxItemId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }
  /** Read one stable room-source identity, including terminal legacy rows. */
  async getBySourceMessage(agentId: string, roomId: string, sourceMessageId: string): Promise<SupervisedInboxItem | null> {
    this.require(agentId, "agent_id"); this.require(roomId, "room_id"); this.require(sourceMessageId, "source_message_id");
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=? LIMIT 1")
        .get(agentId, roomId, sourceMessageId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }
  /**
   * Whether this item is a follow-up that was made blocked, because its automatic attempts were used up or its
   * tasks could not be verified, and that nothing has touched since. It never reached a provider.
   */
  async isUntouchedBlockedFollowUp(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => Boolean(database.prepare(
      `SELECT 1 FROM supervised_agent_inbox i WHERE i.inbox_item_id=? AND ${UNTOUCHED_BLOCKED_FOLLOW_UP_SQL}`).get(inboxItemId)));
  }
  /** Exact-entry, exact-room, bounded renderer-safe projection. */
  async detail(
    agentId: string,
    roomId: string,
    sourceMessageId?: string | null,
    runtimeFence?: { executionGenerationId: string; runtimeGenerationId: string; daemonGenerationId: string } | null,
  ): Promise<AgentInspectorDetail> {
    return this.read(async (database) => {
      let runtimeControl: AgentInspectorDetail["runtime_control"] = null;
      try { if (runtimeFence !== null) {
        const runtime = database.prepare(`SELECT r.control_state,r.runtime_state,
          o.observer_execution_generation_id,o.observer_runtime_generation_id,o.daemon_generation_id,
          (SELECT MAX(f.observed_at_ms) FROM execution_facts f
            WHERE f.agent_id=o.agent_id
              AND f.execution_generation_id=o.observer_execution_generation_id
              AND f.runtime_generation_id=o.observer_runtime_generation_id
              AND f.observer_epoch=o.observer_epoch
              AND f.domain='control') AS observed_at_ms
          FROM execution_observers o
          JOIN execution_runtime_generations r ON r.agent_id=o.agent_id
            AND r.execution_generation_id=o.observer_execution_generation_id
            AND r.runtime_generation_id=o.observer_runtime_generation_id
          WHERE o.agent_id=?
            AND o.max_observed_sequence=o.last_source_sequence
            AND (? IS NULL OR (o.observer_execution_generation_id=?
              AND o.observer_runtime_generation_id=? AND o.daemon_generation_id=?))`).get(
          agentId,
          runtimeFence?.executionGenerationId ?? null,
          runtimeFence?.executionGenerationId ?? "",
          runtimeFence?.runtimeGenerationId ?? "",
          runtimeFence?.daemonGenerationId ?? "",
        ) as Row | undefined;
        if (runtime) {
          const observedAtMs = runtime.observed_at_ms === null ? null : Number(runtime.observed_at_ms);
          const observedAt = observedAtMs !== null && Number.isSafeInteger(observedAtMs)
            ? new Date(observedAtMs).toISOString()
            : null;
          runtimeControl = {
            control_state: String(runtime.control_state) as NonNullable<AgentInspectorDetail["runtime_control"]>["control_state"],
            runtime_state: String(runtime.runtime_state) as NonNullable<AgentInspectorDetail["runtime_control"]>["runtime_state"],
            observed_at: observedAt,
            execution_generation_id: String(runtime.observer_execution_generation_id),
            daemon_generation_id: String(runtime.daemon_generation_id),
            runtime_generation_id: String(runtime.observer_runtime_generation_id),
          };
        }
      } } catch {
        // Control health is optional evidence. A missing/corrupt execution
        // journal must not hide durable delivery history from the Inspector.
      }
      const boundary = database.prepare("SELECT * FROM supervised_agent_history_boundaries WHERE agent_id=? AND room_id=?").get(agentId, roomId) as Row | undefined;
      // Work rows are newest-first so a reopened Inspector starts at current work.
      const items = (database.prepare(`SELECT i.inbox_item_id,i.source_message_id,i.source_message_json,i.state,i.attempt_count,i.updated_at,i.outcome,i.provider_turn_id,i.last_error,i.failure_code,i.terminal_reason,p.canonical_message_id
        FROM supervised_agent_inbox i LEFT JOIN supervised_agent_publications p ON p.inbox_item_id=i.inbox_item_id
        WHERE i.agent_id=? AND i.room_id=? ORDER BY i.fifo_sequence DESC LIMIT 50`).all(agentId, roomId) as Row[]).map(rowToInspectorItem);
      const uncertainEffects = (database.prepare(`SELECT effect_id,tool_name,mcp_request_id,error,created_at,updated_at
        FROM supervised_agent_effects WHERE agent_id=? AND state='uncertain'
        ORDER BY updated_at DESC,effect_id DESC LIMIT ?`).all(agentId, RETAINED_UNCERTAIN_EFFECTS_PER_AGENT) as Row[]).map((effect) => ({
        effect_id: String(effect.effect_id),
        tool_name: String(effect.tool_name),
        mcp_request_id: String(effect.mcp_request_id),
        error: effect.error === null ? "The mutating tool outcome is uncertain." : String(effect.error),
        created_at: String(effect.created_at),
        updated_at: String(effect.updated_at),
      }));
      const row = sourceMessageId ? database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=? LIMIT 1").get(agentId, roomId, sourceMessageId) as Row | undefined : undefined;
      const history = boundary ? boundaryToDetail(boundary) : null;
      if (!row) {
        const pruned = sourceMessageId && database.prepare("SELECT 1 FROM supervised_agent_pruned_sources WHERE agent_id=? AND room_id=? AND source_message_id=? LIMIT 1").get(agentId, roomId, sourceMessageId);
        const observed = sourceMessageId && database.prepare("SELECT 1 FROM supervised_agent_observed_messages WHERE agent_id=? AND room_id=? AND source_message_id=? LIMIT 1").get(agentId, roomId, sourceMessageId);
        const availability: AgentInspectorDetail["availability"] = pruned ? "pruned" : observed ? "not_loaded" : "not_loaded";
        return { availability, runtime_control: runtimeControl, entry_id: agentId, room_id: roomId, requested_source_message_id: sourceMessageId ?? null, inbox_item_id: null, source_message: null, receipt: null, terminal: null, publication: null, continuation_repair: null, timeline: [], items, uncertain_effects: uncertainEffects, history_boundary: history };
      }
      const item = rowToItem(row);
      const events = (database.prepare("SELECT event_sequence,phase,observed_at,detail FROM supervised_agent_inbox_events WHERE inbox_item_id=? ORDER BY event_sequence LIMIT 100").all(item.inbox_item_id) as Row[]).map(rowToEvent);
      const contextEvent = database.prepare("SELECT snapshot_json FROM supervised_agent_prepared_context WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      let preparedContext: PreparedRoomContext | null = null;
      try { if (contextEvent) preparedContext = inspectorPreparedRoomContext(JSON.parse(String(contextEvent.snapshot_json))); } catch { /* Optional evidence must not hide delivery receipts. */ }
      const control = database.prepare(`SELECT j.* FROM turn_control_journals j
        JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=j.inbox_item_id
        WHERE j.turn_control_present=1 AND j.agent_id=? AND j.target_room_id=?
          AND j.target_source_message_id=? AND j.inbox_item_id=?
          AND b.agent_id=j.agent_id AND b.room_id=j.target_room_id
          AND b.provider_turn_id=j.provider_turn_id AND b.work_attempt_id=j.turn_work_attempt_id
          AND b.origin_execution_generation_id=j.turn_execution_generation_id
          AND b.provider_continuation_id=j.target_provider_continuation_id`)
        .get(agentId, roomId, item.source_message_id, item.inbox_item_id) as Row | undefined;
      const intervention: MessageIntervention | null = control ? {
        actionId: String(control.action_id), recordedAt: String(control.recorded_at),
        hasCorrection: control.has_correction === 1,
        correctionText: typeof control.correction_text === "string" ? control.correction_text : null,
        strategy: control.correction_strategy as MessageIntervention["strategy"],
        operatorResolution: control.operator_resolution as MessageIntervention["operatorResolution"],
        status: control.status as MessageIntervention["status"],
        interrupted: control.interrupted === null ? null : control.interrupted === 1,
        resumed: control.resumed === null ? null : control.resumed === 1,
      } : null;
      const terminal = database.prepare("SELECT outcome,normalized_text,evidence_source,observed_at FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      const publication = database.prepare("SELECT room_id,client_message_id,canonical_message_id FROM supervised_agent_publications WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      const repair = database.prepare("SELECT * FROM provider_continuation_repairs WHERE inbox_item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(item.inbox_item_id) as Row | undefined;
      return { availability: "available", runtime_control: runtimeControl, entry_id: agentId, room_id: roomId, requested_source_message_id: sourceMessageId ?? null, inbox_item_id: item.inbox_item_id,
        prepared_context: preparedContext,
        latest_intervention: intervention,
        recorded_execution: new ExecutionShadowStore(database).retainedMessageExecution(agentId, roomId, item.source_message_id),
        source_message: safeSource(item.source_message, item.source_message_id, roomId, item.activation),
        receipt: { state: item.state, attempt_count: item.attempt_count, provider_turn_id: item.provider_turn_id, outcome: safeOutcome(item.outcome), last_error: item.last_error, failure_code: item.failure_code, blocked_by_inbox_item_id: item.blocked_by_inbox_item_id, next_attempt_at_ms: item.next_attempt_at_ms, terminal_reason: item.terminal_reason },
        terminal: terminal ? { outcome: String(terminal.outcome), normalized_text: terminal.normalized_text === null ? null : String(terminal.normalized_text), evidence_source: String(terminal.evidence_source), observed_at: String(terminal.observed_at) } : null,
        publication: publication ? { client_message_id: String(publication.client_message_id), canonical_message_id: String(publication.canonical_message_id), room_id: String(publication.room_id) } : null,
        continuation_repair: repair ? rowToContinuationRepair(repair) : null,
        timeline: events, items, uncertain_effects: uncertainEffects, history_boundary: history };
    });
  }
  /**
   * Return every actionable receipt plus a bounded terminal history. Timeline
   * events are loaded in one joined query and capped per selected receipt so a
   * noisy historical incident cannot make every manifest projection unbounded.
   */
  async receipts(agentId: string, terminalLimit = RETAINED_TERMINAL_RECEIPTS_PER_AGENT): Promise<SupervisedInboxReceiptWithTimeline[]> {
    return this.readReceipts(agentId, terminalLimit, "receipts", rowToItem);
  }

  /** State projections never need activating message bodies or activation payloads. */
  async receiptProjection(agentId: string, terminalLimit = RETAINED_TERMINAL_RECEIPTS_PER_AGENT): Promise<SupervisedInboxReceiptProjection[]> {
    return this.readReceipts(agentId, terminalLimit, "receiptProjection", rowToReceiptProjectionMetadata, (database, item) => this.followUpFacts(database, item));
  }

  /**
   * What the receipt of a follow-up that ended with nothing started also says, which only the daemon can know. It is asked for such a
   * follow-up and for no other row, so the bodies of ordinary messages are not read for a projection. It never throws: a projection
   * of every receipt must not fail for one of them. A fact that cannot be found is the one that keeps the note.
   * - `follow_up_uncertain`, for the reason `uncertain_action`: an action of the failed turn is still executing or uncertain.
   * - `follow_up_person_turn`, for a reason whose note asks the owner to send a message: a turn started for a message of a person that
   *   came after the follow-up. A turn for another agent's message, a follow-up or a correction is not one.
   */
  private followUpFacts<Item extends SupervisedInboxItemMetadata>(database: DatabaseSync, item: Item): Item & { follow_up_uncertain?: boolean; follow_up_person_turn?: boolean } {
    if ((item.state !== "acknowledged_no_reply" && item.state !== "cancelled_by_user") || item.provider_turn_id || !item.source_message_id.startsWith("task-continuation:")) return item;
    const reason = endedFollowUpReason(item.last_error);
    try {
      if (reason === "uncertain_action") {
        const parent = database.prepare("SELECT inbox_item_id,agent_id,room_id,provider_turn_id FROM supervised_agent_inbox WHERE inbox_item_id=?")
          .get(item.source_message_id.slice("task-continuation:".length)) as Row | undefined;
        // A parent that is no longer kept cannot be asked: the reason stays, which keeps the note.
        return { ...item, follow_up_uncertain: parent ? this.hasUncertainTaskEffects(database, {
          inbox_item_id: String(parent.inbox_item_id), agent_id: String(parent.agent_id), room_id: String(parent.room_id),
          provider_turn_id: parent.provider_turn_id === null ? null : String(parent.provider_turn_id) }) : true };
      }
      if (reason && FOLLOW_UP_REASONS_THAT_ASK_THE_OWNER.has(reason)) {
        // Only the fields that tell a person from an agent are read, and not the text.
        const later = database.prepare(`SELECT source_message_id,
            CASE WHEN json_valid(source_message_json) THEN json_extract(source_message_json,'$.source') END AS source,
            CASE WHEN json_valid(source_message_json) THEN json_type(source_message_json,'$.agent_identity') END AS agent_identity,
            CASE WHEN json_valid(source_message_json) THEN json_extract(source_message_json,'$.publisher_agent_key') END AS publisher_agent_key
          FROM supervised_agent_inbox WHERE agent_id=? AND fifo_sequence>? AND provider_turn_id IS NOT NULL`).all(item.agent_id, item.fifo_sequence) as Row[];
        return { ...item, follow_up_person_turn: later.some((row) => queuedDeliveryKind(String(row.source_message_id), {
          source: row.source, ...(row.agent_identity === "object" ? { agent_identity: {} } : {}), publisher_agent_key: row.publisher_agent_key }) === "person") };
      }
    } catch { return reason === "uncertain_action" ? { ...item, follow_up_uncertain: true } : item; }
    return item;
  }

  private async readReceipts<Item extends SupervisedInboxItemMetadata>(agentId: string, terminalLimit: number,
    statement: "receipts" | "receiptProjection", decode: (row: Row) => Item,
    enrich: (database: DatabaseSync, item: Item) => Item = (_database, item) => item): Promise<Array<Item & {
      timeline: SupervisedInboxEvent[]; canonical_message_id: string | null; receipt_state: SupervisedInboxReceiptState;
    }>> {
    return this.read(async (database) => {
      const limit = Math.max(0, Math.min(Math.trunc(terminalLimit), RETAINED_TERMINAL_RECEIPTS_PER_AGENT));
      const rows = this.reads.get(database, statement).all(agentId, agentId, limit) as Row[];
      const timelines = new Map<string, SupervisedInboxEvent[]>();
      for (const event of this.reads.get(database, "receiptTimelines").all(
          agentId,
          agentId,
          limit,
          RETAINED_TIMELINE_EVENTS_PER_RECEIPT,
        ) as Row[]) {
        const inboxItemId = String(event.inbox_item_id);
        const timeline = timelines.get(inboxItemId) ?? [];
        timeline.push({
          event_sequence: Number(event.event_sequence),
          phase: String(event.phase) as SupervisedInboxEvent["phase"],
          observed_at: String(event.observed_at),
          detail: event.detail === null ? null : String(event.detail),
        });
        timelines.set(inboxItemId, timeline);
      }
      const head = rows.find((row) => !finalStates.has(String(row.state) as SupervisedInboxState));
      const firstBlocked = head && String(head.state) === "blocked" ? head : undefined;
      return rows.map((row) => {
        const item = enrich(database, decode(row));
        const timeline = timelines.get(item.inbox_item_id) ?? [];
        const canonicalMessageId = row.canonical_message_id === null
          ? null
          : String(row.canonical_message_id);
        if (firstBlocked && item.fifo_sequence > Number(firstBlocked.fifo_sequence) && !finalStates.has(item.state)) {
          return {
            ...item,
            timeline,
            canonical_message_id: canonicalMessageId,
            receipt_state: "queued_behind_blocked" as const,
            blocked_by_inbox_item_id: String(firstBlocked.inbox_item_id),
          };
        }
        return {
          ...item,
          timeline,
          canonical_message_id: canonicalMessageId,
          receipt_state: item.state,
        };
      });
    });
  }

  /** Remove all daemon-owned delivery history for an agent being discarded. */
  async removeAgent(agentId: string): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => {
      run(database.prepare("DELETE FROM supervised_agent_effects WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_effect_tombstones WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM provider_continuation_repairs WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_observed_messages WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_ingress_health WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_ingress_cursors WHERE agent_id=?"), agentId);
      // removeAgent is a purge, not PR4's future retire operation.
      run(database.prepare("DELETE FROM supervised_agent_history_boundaries WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_pruned_sources WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_agent_inbox WHERE agent_id=?"), agentId);
    }), agentId);
  }

  async pruneHistory(agentId: string): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => this.pruneAgentHistory(database, agentId)), agentId);
  }
}
