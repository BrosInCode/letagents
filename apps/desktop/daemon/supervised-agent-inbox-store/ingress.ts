import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { freezeQueuedPeers, hasFrozenPeerBatch } from "../queued-peer-deliveries.js";
import { assertDeliveryDrainIngressAllowed } from "../delivery-drain.js";
import { MAX_QUEUED_NOTICES_PER_TURN, peopleFirstOrder, queuedDeliveryKind, queuedNoticeIds, queuedNoticeReason, queuedNoticesFor, roomArrival, type QueuedDeliveryKind } from "../queued-delivery-order.js";
import type { InboxActivation, ObservedIngressMessage, PollIngestionInput, SuccessfulPollIngestionInput, IngressHealthUpdate, SupervisedInboxItem, Row } from "./types.js";
import { isNewerCursor } from "./inbox-rules.js";
import { run, UNTOUCHED_PENDING_SQL } from "./sql.js";
import { rowToItem } from "./row-mapping.js";
import { InboxStoreBase } from "./store-base.js";

export abstract class InboxIngressStore extends InboxStoreBase {
  /**
   * Install the initial room boundary exactly once. A fresh agent must begin
   * at the current tail, while an existing cursor (including a null cursor for
   * an initially empty room) is durable handoff/restart progress and wins.
   */
  async bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<{ agent_id: string; room_id: string; last_observed_message_id: string | null; created: boolean }> {
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id");
    if (input.last_observed_message_id !== null) this.requireNumericCursor(input.last_observed_message_id);
    return this.exclusive(async (database) => this.transaction(database, () => {
      assertDeliveryDrainIngressAllowed(database, input.agent_id);
      const existing = this.reads.get(database, "ingressCursor").get(input.agent_id) as Row | undefined;
      if (existing) {
        if (String(existing.room_id) !== input.room_id) throw new Error("Supervised inbox ingress room changed for the exact agent identity.");
        return {
          agent_id: input.agent_id,
          room_id: input.room_id,
          last_observed_message_id: existing.last_observed_message_id === null ? null : String(existing.last_observed_message_id),
          created: false,
        };
      }
      run(database.prepare("INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES (?,?,?,?)"), input.agent_id, input.room_id, input.last_observed_message_id, this.now());
      return { agent_id: input.agent_id, room_id: input.room_id, last_observed_message_id: input.last_observed_message_id, created: true };
    }), input.agent_id);
  }

  /** Atomically retire source ingress and install the response-first destination tail boundary. */
  async commitRoomMoveCursor(
    input: { agent_id: string; source_room_id: string; destination_room_id: string; last_observed_message_id: string | null },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    this.require(input.agent_id, "agent_id"); this.require(input.source_room_id, "source_room_id"); this.require(input.destination_room_id, "destination_room_id");
    if (input.source_room_id === input.destination_room_id) throw new Error("Room-move cursor requires distinct rooms.");
    if (input.last_observed_message_id !== null) this.requireNumericCursor(input.last_observed_message_id);
    await this.exclusive(async (database) => this.transactionFenced(database, () => {
      const existing = database.prepare("SELECT last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?").get(input.agent_id, input.destination_room_id) as Row | undefined;
      if (existing && (existing.last_observed_message_id === null ? null : String(existing.last_observed_message_id)) !== input.last_observed_message_id) throw new Error("Destination ingress cursor already has a different room-move boundary.");
      run(database.prepare("DELETE FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?"), input.agent_id, input.source_room_id);
      if (!existing) run(database.prepare("INSERT OR REPLACE INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES (?,?,?,?)"), input.agent_id, input.destination_room_id, input.last_observed_message_id, this.now());
    }, commitFence), input.agent_id);
  }

  /** Insert poll data without changing transport health. Used for durable recovery and test setup. */
  async ingestPoll(input: PollIngestionInput): Promise<SupervisedInboxItem[]> {
    return this.commitPollIngestion(input);
  }

  /**
   * Commit every fact proven by one successful network poll together. The
   * renderer must never observe newly received work while the same poll still
   * carries an older backoff error.
   */
  async ingestSuccessfulPoll(input: SuccessfulPollIngestionInput): Promise<SupervisedInboxItem[]> {
    this.require(input.execution_generation_id, "execution_generation_id");
    return this.commitPollIngestion(input, input.execution_generation_id, input.onInserted);
  }

  /** One transaction: idempotently insert activated messages, persist the cursor, and optionally restore observing health. */
  private async commitPollIngestion(input: PollIngestionInput, observingExecutionGenerationId?: string,
    onInserted?: (sourceMessageIds: readonly string[]) => void): Promise<SupervisedInboxItem[]> {
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id");
    const inserted: string[] = [];
    let changed = true;
    const result = await this.exclusive(async (database) => this.transaction(database, () => {
      assertDeliveryDrainIngressAllowed(database, input.agent_id);
      const cursor = this.reads.get(database, "ingressCursor").get(input.agent_id) as Row | undefined;
      if (cursor && String(cursor.room_id) !== input.room_id) throw new Error("Supervised inbox ingress room changed for the exact agent identity.");
      const currentCursor = cursor?.last_observed_message_id === null || cursor?.last_observed_message_id === undefined ? null : String(cursor.last_observed_message_id);
      if (input.expected_cursor !== undefined && input.expected_cursor !== currentCursor) {
        throw new Error("Supervised inbox ingress cursor changed before this poll could commit.");
      }
      if (input.last_observed_message_id !== null) this.requireNumericCursor(input.last_observed_message_id);
      const nextCursor = input.last_observed_message_id === null || !isNewerCursor(input.last_observed_message_id, currentCursor)
        ? currentCursor : input.last_observed_message_id;
      if (observingExecutionGenerationId && cursor && nextCursor === currentCursor
        && input.messages.length === 0 && (input.observed_messages?.length ?? 0) === 0) {
        const health = this.reads.get(database, "ingressHealth").get(input.agent_id) as Row | undefined;
        if (health?.room_id === input.room_id && health.execution_generation_id === observingExecutionGenerationId
          && health.state === "observing" && health.detail === null) {
          // The room/cursor/drain checks above remain inside the transaction.
          // These timestamps are change records; binding publications own liveness.
          // Retention is driven by growth and terminal transitions, not elapsed time.
          changed = false;
          return [];
        }
      }
      let historyGrew = false;
      const observedAt = this.now();
      for (const message of input.observed_messages ?? input.messages.map((candidate) => ({ ...candidate, activation_decision: "activate" }))) {
        this.require(message.source_message_id, "source_message_id");
        const observed = database.prepare(`INSERT INTO supervised_agent_observed_messages
          (agent_id,room_id,source_message_id,source_message_json,activation_json,activation_decision,observed_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id,room_id,source_message_id) DO NOTHING`).run(
          input.agent_id, input.room_id, message.source_message_id, JSON.stringify(message.source_message), JSON.stringify(message.activation), message.activation_decision, observedAt);
        historyGrew ||= Number(observed.changes) > 0;
      }
      let sequence = Number((database.prepare("SELECT COALESCE(MAX(fifo_sequence), 0) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(input.agent_id) as Row).value);
      // The head may already be claimed or admitted by delivery; queue ordering never moves it.
      const head = database.prepare(`SELECT fifo_sequence FROM supervised_agent_inbox WHERE agent_id=?
        AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence LIMIT 1`).get(input.agent_id) as Row | undefined;
      const created: SupervisedInboxItem[] = [];
      const newItemIds = new Set<string>();
      for (const message of input.messages) {
        this.require(message.source_message_id, "source_message_id");
        const existing = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=?").get(input.agent_id, input.room_id, message.source_message_id) as Row | undefined;
        if (existing) { created.push(rowToItem(existing)); continue; }
        historyGrew = true;
        sequence += 1;
        const timestamp = this.now(); const inboxItemId = randomUUID();
        const actionId = `supervised-room:${input.agent_id}:${input.room_id}:${message.source_message_id}:action:v1`;
        const replyId = `supervised-room:${input.agent_id}:${input.room_id}:${message.source_message_id}:reply:v1`;
        run(database.prepare(`INSERT INTO supervised_agent_inbox
          (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
          VALUES (?,?,?,?,?,?,?,'pending',0,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`),
          inboxItemId, input.agent_id, input.room_id, message.source_message_id, JSON.stringify(message.source_message), JSON.stringify(message.activation), sequence, actionId, replyId, timestamp, timestamp);
        this.recordEvent(database, inboxItemId, "received:0", "received", timestamp, null);
        this.recordEvent(database, inboxItemId, "queued:0", "queued", timestamp, null);
        // An inbox row can be re-created after receipt pruning. Only sources
        // beyond the committed poll cursor get a new attribution opportunity;
        // this observation fence does not alter operational ingestion.
        try { if (isNewerCursor(message.source_message_id, currentCursor)) inserted.push(message.source_message_id); }
        catch { /* A nonnumeric source cannot establish new room provenance. */ }
        newItemIds.add(inboxItemId);
        created.push(rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row));
      }
      if (newItemIds.size) {
        this.orderQueuedDeliveries(database, input.agent_id, input.room_id, head ? Number(head.fifo_sequence) : 0, observedAt);
        for (const [index, item] of created.entries()) {
          created[index] = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
        }
      }
      const timestamp = this.now();
      run(database.prepare(`INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id,last_observed_message_id=excluded.last_observed_message_id,updated_at=excluded.updated_at`), input.agent_id, input.room_id, nextCursor, timestamp);
      if (observingExecutionGenerationId) {
        this.writeIngressHealth(database, {
          agent_id: input.agent_id,
          room_id: input.room_id,
          execution_generation_id: observingExecutionGenerationId,
          state: "observing",
        }, timestamp);
      }
      if (historyGrew) this.pruneAgentHistory(database, input.agent_id);
      return created;
    }), input.agent_id, () => changed);
    // Replays deliberately do not receive a fresh attribution opportunity.
    // Missing observation stays local; it must never roll back received work.
    try { if (inserted.length) onInserted?.(inserted); } catch { /* optional observation */ }
    return result;
  }

  /**
   * After new room work arrives, put people's messages ahead of earlier
   * automated deliveries in the untouched queue behind the head. Each passed
   * row records a passed:<person> event, so at most MAX_PERSON_PASSES people
   * ever go ahead of it, however often the head changes. Only rows still exactly as ingested move. The head,
   * any row with dispatch, retry, block, binding or turn-control history,
   * daemon-authored rows and rows from another room are barriers; only the
   * run after the last barrier is reordered. Nothing is settled here.
   */
  private orderQueuedDeliveries(database: DatabaseSync, agentId: string, roomId: string, headSequence: number, timestamp: string): void {
    const rows = database.prepare(`SELECT i.*,${UNTOUCHED_PENDING_SQL} AS untouched,
        (SELECT COUNT(*) FROM supervised_agent_inbox_events e WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key GLOB 'passed:*') AS passes
      FROM supervised_agent_inbox i WHERE i.agent_id=? AND i.fifo_sequence>?
        AND i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
      ORDER BY i.fifo_sequence`).all(agentId, headSequence) as Row[];
    let queue: Array<{ item: SupervisedInboxItem; kind: QueuedDeliveryKind; arrival: bigint; passes: number }> = [];
    for (const row of rows) {
      const item = rowToItem(row);
      const kind = queuedDeliveryKind(item.source_message_id, item.source_message);
      if (Number(row.untouched) !== 1 || kind === "fixed" || item.room_id !== roomId) queue = [];
      else queue.push({ item, kind, arrival: roomArrival(item.source_message_id), passes: Number(row.passes) });
    }
    const { order, passed } = peopleFirstOrder(queue);
    const moves = order.flatMap((entry, index) => entry.item.fifo_sequence === queue[index]!.item.fifo_sequence
      ? [] : [{ entry, slot: queue[index]!.item.fifo_sequence }]);
    if (!moves.length) return;
    // Permute the run's own slots through unused ones above the maximum so
    // UNIQUE(agent_id,fifo_sequence) holds at every step; other rows keep theirs.
    let parked = Number((database.prepare("SELECT MAX(fifo_sequence) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(agentId) as Row).value);
    const move = database.prepare("UPDATE supervised_agent_inbox SET fifo_sequence=? WHERE inbox_item_id=?");
    for (const { entry } of moves) run(move, ++parked, entry.item.inbox_item_id);
    for (const { entry, slot } of moves) run(move, slot, entry.item.inbox_item_id);
    for (const [person, overtaken] of passed) {
      this.recordEvent(database, person.item.inbox_item_id, "queued:person_first", "queued", timestamp,
        `Queued ahead of ${overtaken.length} earlier automated ${overtaken.length === 1 ? "delivery" : "deliveries"}.`);
      // The durable pass budget: each row counts the people who went ahead of it.
      for (const entry of overtaken) {
        this.recordEvent(database, entry.item.inbox_item_id, `passed:${person.item.source_message_id}`, "queued", timestamp,
          `A person's message (${person.item.source_message_id}) was queued ahead of this one.`);
      }
    }
  }

  /**
   * The activation a freshly claimed head is dispatched with. A notice head
   * also lists the untouched notices queued behind it, up to the first
   * person's message or barrier, so one turn handles them. They stay pending
   * until that turn completes with a reply or no reply (checkpointNormalizedTerminal
   * settles them); a skip, stop, failure or unreadable result leaves them queued.
   */
  protected dispatchActivation(database: DatabaseSync, head: SupervisedInboxItem, untouched: boolean, timestamp: string): InboxActivation {
    // Dispatch bookkeeping changes fresh eligibility, but never the already
    // committed membership assigned to a proven pre-native retry.
    if (hasFrozenPeerBatch(database, head.inbox_item_id)) return head.activation;
    // Exact quote/recipient eligibility is checked against the immutable
    // publication pin inside freezeQueuedPeers, including quoted peer heads
    // and ordinary ordered human thread turns with peers already queued.
    const source = head.source_message;
    if (source && typeof source === "object" && !Array.isArray(source)
      && ((source as Record<string, unknown>).source === "agent" || (source as Record<string, unknown>).source === "browser")
      && head.activation.decision === "activate"
      && head.activation.reason === "thread_participant") {
      const rows = database.prepare(`SELECT i.*,${UNTOUCHED_PENDING_SQL} AS untouched
        FROM supervised_agent_inbox i WHERE i.agent_id=? AND i.fifo_sequence>?
          AND i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY i.fifo_sequence LIMIT 17`).all(head.agent_id, head.fifo_sequence) as Row[];
      return freezeQueuedPeers(database, head, rows.map(row => ({ ...rowToItem(row), untouched: Number(row.untouched) === 1 })), untouched, timestamp);
    }
    const { queued_notices: _stale, queued_peer_messages: _untrusted, ...activation } = head.activation;
    if (queuedDeliveryKind(head.source_message_id, head.source_message) !== "notice") return activation;
    const rows = database.prepare(`SELECT i.*,${UNTOUCHED_PENDING_SQL} AS untouched
      FROM supervised_agent_inbox i WHERE i.agent_id=? AND i.fifo_sequence>?
        AND i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
      ORDER BY i.fifo_sequence`).all(head.agent_id, head.fifo_sequence) as Row[];
    const queued: SupervisedInboxItem[] = [];
    for (const row of rows) {
      const item = rowToItem(row);
      const kind = queuedDeliveryKind(item.source_message_id, item.source_message);
      // A person's message or correction may change what a later notice means; never deliver past it.
      if (Number(row.untouched) !== 1 || kind === "fixed" || kind === "person" || item.room_id !== head.room_id) break;
      if (kind === "notice" && queued.push(item) === MAX_QUEUED_NOTICES_PER_TURN) break;
    }
    return queued.length ? { ...activation, queued_notices: queuedNoticesFor(head, queued) } : activation;
  }

  /** Settle the notices a completed turn carried. Each must still be an untouched notice (never a person's message). */
  protected settleQueuedNotices(database: DatabaseSync, head: SupervisedInboxItem, timestamp: string): void {
    let settled = false;
    for (const sourceMessageId of queuedNoticeIds(head.activation)) {
      const row = database.prepare(`SELECT i.*,${UNTOUCHED_PENDING_SQL} AS untouched FROM supervised_agent_inbox i
        WHERE i.agent_id=? AND i.room_id=? AND i.source_message_id=?`).get(head.agent_id, head.room_id, sourceMessageId) as Row | undefined;
      if (!row || Number(row.untouched) !== 1) continue;
      const item = rowToItem(row);
      if (queuedDeliveryKind(item.source_message_id, item.source_message) !== "notice") continue;
      const reason = queuedNoticeReason(head.activation, head.source_message_id, sourceMessageId);
      run(database.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',last_error=?,updated_at=?,acknowledged_at=?
        WHERE inbox_item_id=? AND state='pending'`), reason, timestamp, timestamp, item.inbox_item_id);
      this.recordEvent(database, item.inbox_item_id, `delivered_with:${head.inbox_item_id}`, "no_reply", timestamp, reason);
      this.settleTerminalItem(database, item, timestamp);
      settled = true;
    }
    if (settled) this.pruneAgentHistory(database, head.agent_id);
  }

  /**
   * Enqueue the desktop-authored message that starts a newly created agent.
   * Its caller supplies a deterministic source id, so retries and daemon
   * recovery can re-admit the same launch without running the message twice.
   */
  async enqueueInitialMessage(input: { agent_id: string; room_id: string; source_message_id: string; source_message: unknown; activation: unknown }): Promise<SupervisedInboxItem> {
    return this.enqueueSyntheticMessage(input);
  }

  /**
   * Enqueue a human correction as a synthetic FIFO turn that runs on the SAME
   * provider session as the interrupted turn (stop-then-resend). It mirrors
   * `ingestPoll`'s inbox INSERT but deliberately never touches the ingress
   * cursor: a correction is not an observed room message, so advancing the
   * cursor would skip real messages. The caller owns the synthetic
   * `source_message_id` (derived from the stable turn-control action id) so a
   * retried control action re-enqueues idempotently rather than duplicating.
   */
  async enqueueCorrection(input: { agent_id: string; room_id: string; source_message_id: string; source_message: unknown; activation: unknown }): Promise<SupervisedInboxItem> {
    return this.enqueueSyntheticMessage(input);
  }

  private async enqueueSyntheticMessage(input: { agent_id: string; room_id: string; source_message_id: string; source_message: unknown; activation: unknown }): Promise<SupervisedInboxItem> {
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id"); this.require(input.source_message_id, "source_message_id");
    return this.exclusive(async (database) => this.transaction(database, () => this.insertSyntheticMessage(database, input)), input.agent_id);
  }

  protected insertSyntheticMessage(database: DatabaseSync, input: { agent_id: string; room_id: string; source_message_id: string; source_message: unknown; activation: unknown }): SupervisedInboxItem {
    assertDeliveryDrainIngressAllowed(database, input.agent_id);
    const existing = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=?").get(input.agent_id, input.room_id, input.source_message_id) as Row | undefined;
    if (existing) return rowToItem(existing);
    const sequence = Number((database.prepare("SELECT COALESCE(MAX(fifo_sequence), 0) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(input.agent_id) as Row).value) + 1;
    const timestamp = this.now(); const inboxItemId = randomUUID();
    const actionId = `supervised-room:${input.agent_id}:${input.room_id}:${input.source_message_id}:action:v1`;
    const replyId = `supervised-room:${input.agent_id}:${input.room_id}:${input.source_message_id}:reply:v1`;
    run(database.prepare(`INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      VALUES (?,?,?,?,?,?,?,'pending',0,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`),
      inboxItemId, input.agent_id, input.room_id, input.source_message_id, JSON.stringify(input.source_message), JSON.stringify(input.activation), sequence, actionId, replyId, timestamp, timestamp);
    this.recordEvent(database, inboxItemId, "received:0", "received", timestamp, null);
    this.recordEvent(database, inboxItemId, "queued:0", "queued", timestamp, null);
    return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
  }

  async observedContext(agentId: string, roomId: string, limit = 50): Promise<ObservedIngressMessage[]> {
    return this.read(async (database) => (database.prepare(`SELECT source_message_id,source_message_json,activation_json,activation_decision
      FROM supervised_agent_observed_messages WHERE agent_id=? AND room_id=? ORDER BY rowid DESC LIMIT ?`).all(agentId, roomId, Math.max(1, Math.min(limit, 200))) as Row[])
      .reverse().map((row) => ({ source_message_id: String(row.source_message_id), source_message: JSON.parse(String(row.source_message_json)), activation: JSON.parse(String(row.activation_json)), activation_decision: String(row.activation_decision) })));
  }

  async setIngressHealth(input: IngressHealthUpdate): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => {
      this.writeIngressHealth(database, input, this.now());
    }), input.agent_id);
  }

  private writeIngressHealth(database: DatabaseSync, input: IngressHealthUpdate, timestamp: string): void {
    run(database.prepare(`INSERT INTO supervised_agent_ingress_health(agent_id,room_id,execution_generation_id,state,detail,observed_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id,execution_generation_id=excluded.execution_generation_id,state=excluded.state,detail=excluded.detail,observed_at=excluded.observed_at,updated_at=excluded.updated_at`),
      input.agent_id, input.room_id, input.execution_generation_id, input.state, input.detail ?? null, timestamp, timestamp);
  }

  async ingressHealth(agentId: string): Promise<{ room_id: string; state: "starting" | "observing" | "backoff" | "blocked" | "stopped"; detail: string | null; execution_generation_id: string } | null> {
    return this.read(async (database) => {
      const row = this.reads.get(database, "ingressHealth").get(agentId) as Row | undefined;
      return row ? { room_id: String(row.room_id), state: String(row.state) as "starting" | "observing" | "backoff" | "blocked" | "stopped", detail: row.detail === null ? null : String(row.detail), execution_generation_id: String(row.execution_generation_id) } : null;
    });
  }
}
