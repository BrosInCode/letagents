import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";

export type SupervisedInboxState = "pending" | "dispatching" | "awaiting_result" | "result_recovery" | "publishing" | "retryable" | "blocked" | "acknowledged" | "acknowledged_no_reply" | "cancelled_by_room_move";
export type SupervisedInboxReceiptState = SupervisedInboxState | "queued_behind_blocked";
export type InboxActivation = Record<string, unknown>;
export type IngressMessage = { source_message_id: string; source_message: unknown; activation: InboxActivation };
export type ObservedIngressMessage = IngressMessage & { activation_decision: string };
export type SupervisedInboxItem = {
  inbox_item_id: string; agent_id: string; room_id: string; source_message_id: string;
  source_message: unknown; activation: InboxActivation; fifo_sequence: number; state: SupervisedInboxState;
  attempt_count: number; action_id: string; reply_client_message_id: string; provider_turn_id: string | null;
  outcome: string | null; last_error: string | null; blocked_by_inbox_item_id: string | null;
  next_attempt_at_ms: number | null; created_at: string; updated_at: string; acknowledged_at: string | null;
};
export type SupervisedInboxReceipt = SupervisedInboxItem & { receipt_state: SupervisedInboxReceiptState };
export type SupervisedInboxEvent = {
  phase: "received" | "queued" | "turn_started" | "turn_finished" | "result_unreadable" | "publish_started" | "published" | "no_reply" | "retry_scheduled" | "blocked" | "room_move_cancelled";
  observed_at: string;
  detail: string | null;
};
export type SupervisedInboxReceiptWithTimeline = SupervisedInboxReceipt & { timeline: SupervisedInboxEvent[] };
export type SupervisedEffectRecord = {
  effect_id: string; agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
  mcp_request_id: string; tool_name: string; request: unknown; state: "prepared" | "executing" | "completed" | "failed";
  result: unknown | null; error: string | null;
};
type Row = Record<string, unknown>;
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
const finalStates = new Set<SupervisedInboxState>(["acknowledged", "acknowledged_no_reply", "cancelled_by_room_move"]);
const transitions: Readonly<Record<SupervisedInboxState, readonly SupervisedInboxState[]>> = {
  pending: ["dispatching", "blocked"], dispatching: ["awaiting_result", "retryable", "blocked"],
  awaiting_result: ["result_recovery", "publishing", "acknowledged_no_reply", "retryable", "blocked"],
  result_recovery: ["publishing", "acknowledged_no_reply", "blocked"], publishing: ["acknowledged", "retryable", "blocked"],
  retryable: ["pending", "blocked"], blocked: ["pending"], acknowledged: [], acknowledged_no_reply: [], cancelled_by_room_move: [],
};

/** Durable, provider-neutral room delivery queue. It owns neither polling nor turns. */
export class SupervisedAgentInboxStore {
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly databasePath: string, private readonly now: () => string = () => new Date().toISOString()) {}

  async close(): Promise<void> {
    this.closed = true;
    await this.writes.catch(() => undefined);
    await this.initializing?.catch(() => undefined);
    this.database?.close(); this.database = null; this.initializing = null;
  }

  /**
   * Install the initial room boundary exactly once. A fresh agent must begin
   * at the current tail, while an existing cursor (including a null cursor for
   * an initially empty room) is durable handoff/restart progress and wins.
   */
  async bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<{ agent_id: string; room_id: string; last_observed_message_id: string | null; created: boolean }> {
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id");
    if (input.last_observed_message_id !== null) this.requireNumericCursor(input.last_observed_message_id);
    return this.exclusive(async (database) => this.transaction(database, () => {
      const existing = database.prepare("SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?").get(input.agent_id) as Row | undefined;
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
    }));
  }

  /** One transaction: idempotently insert activated messages and persist the poll cursor. */
  async ingestPoll(input: { agent_id: string; room_id: string; last_observed_message_id: string | null; expected_cursor?: string | null; messages: readonly IngressMessage[]; observed_messages?: readonly ObservedIngressMessage[] }): Promise<SupervisedInboxItem[]> {
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const cursor = database.prepare("SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?").get(input.agent_id) as Row | undefined;
      if (cursor && String(cursor.room_id) !== input.room_id) throw new Error("Supervised inbox ingress room changed for the exact agent identity.");
      const currentCursor = cursor?.last_observed_message_id === null || cursor?.last_observed_message_id === undefined ? null : String(cursor.last_observed_message_id);
      if (input.expected_cursor !== undefined && input.expected_cursor !== currentCursor) {
        throw new Error("Supervised inbox ingress cursor changed before this poll could commit.");
      }
      if (input.last_observed_message_id !== null) this.requireNumericCursor(input.last_observed_message_id);
      const observedAt = this.now();
      for (const message of input.observed_messages ?? input.messages.map((candidate) => ({ ...candidate, activation_decision: "activate" }))) {
        this.require(message.source_message_id, "source_message_id");
        run(database.prepare(`INSERT INTO supervised_agent_observed_messages
          (agent_id,room_id,source_message_id,source_message_json,activation_json,activation_decision,observed_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id,source_message_id) DO NOTHING`),
          input.agent_id, input.room_id, message.source_message_id, JSON.stringify(message.source_message), JSON.stringify(message.activation), message.activation_decision, observedAt);
      }
      let sequence = Number((database.prepare("SELECT COALESCE(MAX(fifo_sequence), 0) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(input.agent_id) as Row).value);
      const created: SupervisedInboxItem[] = [];
      for (const message of input.messages) {
        this.require(message.source_message_id, "source_message_id");
        const existing = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND source_message_id=?").get(input.agent_id, message.source_message_id) as Row | undefined;
        if (existing) { created.push(rowToItem(existing)); continue; }
        sequence += 1;
        const timestamp = this.now(); const inboxItemId = randomUUID();
        const actionId = `supervised-room:${input.agent_id}:${message.source_message_id}:action:v1`;
        const replyId = `supervised-room:${input.agent_id}:${message.source_message_id}:reply:v1`;
        run(database.prepare(`INSERT INTO supervised_agent_inbox
          (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
          VALUES (?,?,?,?,?,?,?,'pending',0,?,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`),
          inboxItemId, input.agent_id, input.room_id, message.source_message_id, JSON.stringify(message.source_message), JSON.stringify(message.activation), sequence, actionId, replyId, timestamp, timestamp);
        this.recordEvent(database, inboxItemId, "received:0", "received", timestamp, null);
        this.recordEvent(database, inboxItemId, "queued:0", "queued", timestamp, null);
        created.push(rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row));
      }
      const timestamp = this.now();
      const nextCursor = input.last_observed_message_id === null || !isNewerCursor(input.last_observed_message_id, currentCursor)
        ? currentCursor : input.last_observed_message_id;
      run(database.prepare(`INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id,last_observed_message_id=excluded.last_observed_message_id,updated_at=excluded.updated_at`), input.agent_id, input.room_id, nextCursor, timestamp);
      return created;
    }));
  }

  async cursor(agentId: string): Promise<{ agent_id: string; room_id: string; last_observed_message_id: string | null; updated_at: string } | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_ingress_cursors WHERE agent_id=?").get(agentId) as Row | undefined;
      return row ? { agent_id: String(row.agent_id), room_id: String(row.room_id), last_observed_message_id: row.last_observed_message_id === null ? null : String(row.last_observed_message_id), updated_at: String(row.updated_at) } : null;
    });
  }

  async head(agentId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move') ORDER BY fifo_sequence LIMIT 1").get(agentId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }
  async get(inboxItemId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => { const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined; return row ? rowToItem(row) : null; });
  }
  async transition(inboxItemId: string, next: SupervisedInboxState, patch: Partial<Pick<SupervisedInboxItem, "provider_turn_id" | "outcome" | "last_error" | "next_attempt_at_ms" | "blocked_by_inbox_item_id">> = {}): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (!transitions[item.state].includes(next)) throw new Error(`Invalid supervised inbox transition: ${item.state} -> ${next}.`);
      // Every in-flight state is causally owned by the true FIFO head. This
      // prevents a later item becoming blocked and hiding the real stall.
      if (!finalStates.has(next)) this.assertCurrentHead(database, item);
      if (next === "dispatching" && item.state !== "pending") throw new Error("Only the current pending FIFO head may be dispatched.");
      const attempts = item.attempt_count;
      const timestamp = this.now(); const acknowledged = finalStates.has(next) ? timestamp : null;
      run(database.prepare(`UPDATE supervised_agent_inbox SET state=?,attempt_count=?,provider_turn_id=?,outcome=?,last_error=?,blocked_by_inbox_item_id=?,next_attempt_at_ms=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`),
        next, attempts, valueOrCurrent(patch, "provider_turn_id", item.provider_turn_id), valueOrCurrent(patch, "outcome", item.outcome), valueOrCurrent(patch, "last_error", item.last_error),
        valueOrCurrent(patch, "blocked_by_inbox_item_id", item.blocked_by_inbox_item_id), valueOrCurrent(patch, "next_attempt_at_ms", item.next_attempt_at_ms), timestamp, acknowledged, inboxItemId);
      const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
      const event = phaseForTransition(next);
      if (event) {
        const ordinal = event === "retry_scheduled" || event === "queued"
          ? Number((database.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase=?").get(inboxItemId, event) as Row).value) + 1
          : updated.attempt_count;
        this.recordEvent(database, inboxItemId, `${event}:${ordinal}`, event, timestamp, updated.last_error);
      }
      return updated;
    }));
  }
  async claimHead(agentId: string): Promise<SupervisedInboxItem | null> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move') ORDER BY fifo_sequence LIMIT 1").get(agentId) as Row | undefined;
      if (!row) return null;
      const item = rowToItem(row);
      if (item.state === "result_recovery") return item;
      if (item.state !== "pending") return null;
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET state='dispatching',updated_at=? WHERE inbox_item_id=? AND state='pending'"), timestamp, item.inbox_item_id);
      const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
      return updated;
    }));
  }
  /**
   * Revalidate the durable dispatch fact immediately before turn/start. The
   * fact itself is the FIFO claim's committed `dispatching` state; this is
   * intentionally not a second synthetic transition.
   */
  async checkpointDispatchIntent(inboxItemId: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching" || item.provider_turn_id) throw new Error("Provider dispatch intent requires an unstarted dispatching inbox item.");
      this.assertCurrentHead(database, item);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  /** Persist the exact provider turn id before waiting for any terminal evidence. */
  async checkpointTurnStarted(inboxItemId: string, providerTurnId: string): Promise<SupervisedInboxItem> {
    if (!providerTurnId.trim()) throw new Error("Provider turn id is required for the turn-start checkpoint.");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching") throw new Error("Provider turn-start checkpoint requires a dispatching inbox item.");
      this.assertCurrentHead(database, item);
      if (item.provider_turn_id && item.provider_turn_id !== providerTurnId) throw new Error("Provider turn-start checkpoint conflicts with the durable exact turn id.");
      const timestamp = this.now();
      const nextAttemptCount = item.provider_turn_id ? item.attempt_count : item.attempt_count + 1;
      run(database.prepare("UPDATE supervised_agent_inbox SET provider_turn_id=?,attempt_count=?,updated_at=? WHERE inbox_item_id=?"), providerTurnId, nextAttemptCount, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `turn_started:${nextAttemptCount}:${providerTurnId}`, "turn_started", timestamp, null);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  async checkpointNormalizedTerminal(input: {
    inbox_item_id: string;
    agent_id: string;
    execution_generation_id: string;
    provider_turn_id: string;
    outcome: "reply" | "no_reply" | "unreadable";
    text: string | null;
    evidence: "transcript" | "stream" | "none";
    terminal_evidence: unknown;
  }): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${input.inbox_item_id}`);
      const item = rowToItem(row);
      if (item.agent_id !== input.agent_id || item.provider_turn_id !== input.provider_turn_id) throw new Error("Normalized terminal evidence does not match the exact inbox turn.");
      if (item.state !== "dispatching" && item.state !== "awaiting_result" && item.state !== "result_recovery") throw new Error("Normalized terminal evidence requires an in-flight or recovering result.");
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare(`INSERT INTO supervised_agent_terminal_results
        (inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(inbox_item_id) DO UPDATE SET outcome=excluded.outcome,normalized_text=excluded.normalized_text,evidence_source=excluded.evidence_source,terminal_evidence_json=excluded.terminal_evidence_json,updated_at=excluded.updated_at`),
        input.inbox_item_id, input.agent_id, input.execution_generation_id, input.provider_turn_id, input.outcome, input.text, input.evidence, JSON.stringify(input.terminal_evidence), timestamp, timestamp);
      const outcome = JSON.stringify({ kind: input.outcome, text: input.text, evidence: input.evidence });
      run(database.prepare("UPDATE supervised_agent_inbox SET outcome=?,updated_at=? WHERE inbox_item_id=?"), outcome, timestamp, input.inbox_item_id);
      this.recordEvent(database, input.inbox_item_id, `turn_finished:${item.attempt_count}:${input.provider_turn_id}`, "turn_finished", timestamp, input.evidence);
      if (input.outcome === "unreadable") {
        this.recordEvent(database, input.inbox_item_id, `result_unreadable:${input.provider_turn_id}`, "result_unreadable", timestamp, "Re-reading the same completed provider turn.");
      }
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row);
    }));
  }

  async observedContext(agentId: string, roomId: string, limit = 50): Promise<ObservedIngressMessage[]> {
    return this.read(async (database) => (database.prepare(`SELECT source_message_id,source_message_json,activation_json,activation_decision
      FROM supervised_agent_observed_messages WHERE agent_id=? AND room_id=? ORDER BY rowid DESC LIMIT ?`).all(agentId, roomId, Math.max(1, Math.min(limit, 200))) as Row[])
      .reverse().map((row) => ({ source_message_id: String(row.source_message_id), source_message: JSON.parse(String(row.source_message_json)), activation: JSON.parse(String(row.activation_json)), activation_decision: String(row.activation_decision) })));
  }

  async setIngressHealth(input: { agent_id: string; room_id: string; execution_generation_id: string; state: "starting" | "observing" | "backoff" | "blocked" | "stopped"; detail?: string | null }): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => {
      const timestamp = this.now();
      run(database.prepare(`INSERT INTO supervised_agent_ingress_health(agent_id,room_id,execution_generation_id,state,detail,observed_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id,execution_generation_id=excluded.execution_generation_id,state=excluded.state,detail=excluded.detail,observed_at=excluded.observed_at,updated_at=excluded.updated_at`),
        input.agent_id, input.room_id, input.execution_generation_id, input.state, input.detail ?? null, timestamp, timestamp);
    }));
  }

  async ingressHealth(agentId: string): Promise<{ room_id: string; state: "starting" | "observing" | "backoff" | "blocked" | "stopped"; detail: string | null; execution_generation_id: string } | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT room_id,state,detail,execution_generation_id FROM supervised_agent_ingress_health WHERE agent_id=?").get(agentId) as Row | undefined;
      return row ? { room_id: String(row.room_id), state: String(row.state) as "starting" | "observing" | "backoff" | "blocked" | "stopped", detail: row.detail === null ? null : String(row.detail), execution_generation_id: String(row.execution_generation_id) } : null;
    });
  }

  async prepareEffect(input: {
    agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    mcp_request_id: string; tool_name: string; request: unknown;
  }): Promise<{ created: boolean; effect: SupervisedEffectRecord }> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const existing = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mcp_request_id=?`).get(
        input.agent_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id,
      ) as Row | undefined;
      if (existing) {
        const effect = rowToEffect(existing);
        if (effect.room_id !== input.room_id || effect.tool_name !== input.tool_name
          || String(existing.request_json) !== JSON.stringify(input.request)) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        return { created: false, effect };
      }
      const timestamp = this.now();
      const effectId = randomUUID();
      run(database.prepare(`INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'prepared',NULL,NULL,?,?)`),
        effectId, input.agent_id, input.room_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id, input.tool_name, JSON.stringify(input.request), timestamp, timestamp);
      return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row) };
    }));
  }

  async markEffectExecuting(effectId: string): Promise<SupervisedEffectRecord> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row | undefined;
      if (!row) throw new Error("Unknown supervised effect.");
      const effect = rowToEffect(row);
      if (effect.state === "completed" || effect.state === "failed") return effect;
      if (effect.state === "executing") throw new Error("This supervised effect is already executing; refusing a duplicate side effect.");
      run(database.prepare("UPDATE supervised_agent_effects SET state='executing',updated_at=? WHERE effect_id=?"), this.now(), effectId);
      return rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row);
    }));
  }

  /** Attach validated preparation data without claiming the side effect has
   * executed. Room moves remain prepared until the activating reply finishes. */
  async stagePreparedEffectResult(effectId: string, result: unknown): Promise<SupervisedEffectRecord> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row | undefined;
      if (!row) throw new Error("Unknown supervised effect.");
      const effect = rowToEffect(row);
      if (effect.state !== "prepared") return effect;
      run(database.prepare("UPDATE supervised_agent_effects SET result_json=?,updated_at=? WHERE effect_id=?"), JSON.stringify(result), this.now(), effectId);
      return rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as Row);
    }));
  }

  async preparedRoomMove(agentId: string, providerTurnId: string): Promise<SupervisedEffectRecord | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT * FROM supervised_agent_effects
        WHERE agent_id=? AND provider_turn_id=? AND tool_name='join_room' AND state='prepared'
        ORDER BY created_at LIMIT 1`).get(agentId, providerTurnId) as Row | undefined;
      return row ? rowToEffect(row) : null;
    });
  }

  /** Commit the queue side of a room move atomically: later old-room work is
   * cancelled and the old cursor/health authority is removed. */
  async commitRoomMoveQueue(input: { agent_id: string; old_room_id: string; after_fifo_sequence: number }): Promise<number> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const rows = database.prepare(`SELECT * FROM supervised_agent_inbox
        WHERE agent_id=? AND room_id=? AND fifo_sequence>? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move')
        ORDER BY fifo_sequence`).all(input.agent_id, input.old_room_id, input.after_fifo_sequence) as Row[];
      const timestamp = this.now();
      for (const row of rows) {
        const item = rowToItem(row);
        run(database.prepare(`UPDATE supervised_agent_inbox SET state='cancelled_by_room_move',last_error=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`),
          "Cancelled because the agent moved to another room.", timestamp, timestamp, item.inbox_item_id);
        this.recordEvent(database, item.inbox_item_id, `room_move_cancelled:${item.fifo_sequence}`, "room_move_cancelled", timestamp, "Agent moved rooms after completing an earlier message.");
      }
      run(database.prepare("DELETE FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?"), input.agent_id, input.old_room_id);
      run(database.prepare("DELETE FROM supervised_agent_ingress_health WHERE agent_id=? AND room_id=?"), input.agent_id, input.old_room_id);
      return rows.length;
    }));
  }

  async completeEffect(input: {
    effect_id: string; result?: unknown; error?: string;
    expected?: { agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string };
  }): Promise<SupervisedEffectRecord> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row | undefined;
      if (!row) throw new Error("Unknown supervised effect.");
      const effect = rowToEffect(row);
      if (input.expected && (effect.agent_id !== input.expected.agent_id || effect.room_id !== input.expected.room_id
        || effect.execution_generation_id !== input.expected.execution_generation_id
        || effect.provider_turn_id !== input.expected.provider_turn_id)) {
        throw new Error("The supervised effect does not belong to the exact active turn.");
      }
      if (effect.state === "completed" || effect.state === "failed") return effect;
      if (effect.state !== "executing" && effect.tool_name !== "join_room") throw new Error("A supervised effect must be executing before completion.");
      const failed = Boolean(input.error);
      run(database.prepare("UPDATE supervised_agent_effects SET state=?,result_json=?,error=?,updated_at=? WHERE effect_id=?"),
        failed ? "failed" : "completed", input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null, this.now(), input.effect_id);
      return rowToEffect(database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(input.effect_id) as Row);
    }));
  }
  /** Persist provider terminal evidence before advancing out of dispatching. */
  async checkpointTerminalOutcome(inboxItemId: string, outcome: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (item.state !== "dispatching" && item.state !== "awaiting_result") throw new Error("Provider terminal evidence may only be checkpointed while delivery is in-flight.");
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET outcome=?,updated_at=? WHERE inbox_item_id=?"), outcome, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `turn_finished:${item.attempt_count}`, "turn_finished", timestamp, null);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
  }
  async retryBlocked(inboxItemId: string): Promise<SupervisedInboxItem> { return this.transition(inboxItemId, "pending", { blocked_by_inbox_item_id: null, next_attempt_at_ms: null }); }
  /**
   * Normalize work interrupted by a daemon crash before a new runtime is
   * allowed to pump it. A persisted reply is authoritative terminal evidence:
   * it may be published again with its stable client id, but must never invoke
   * the provider again. Everything else that was in-flight is ambiguous and
   * remains visible as blocked rather than being accidentally acknowledged.
   */
  async normalizeStartupRecovery(agentId: string): Promise<SupervisedInboxItem[]> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const rows = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move') ORDER BY fifo_sequence").all(agentId) as Row[];
      const recovered: SupervisedInboxItem[] = [];
      for (const row of rows) {
        const item = rowToItem(row);
        const terminal = persistedTerminalOutcome(item.outcome);
        let next: SupervisedInboxState | null = null;
        let error: string | null = item.last_error;
        if (item.state === "result_recovery") {
          next = "result_recovery";
          error = "Re-reading the same completed provider turn; no new model turn will start.";
        } else if (item.state === "dispatching" || item.state === "awaiting_result" || item.state === "publishing" || item.state === "retryable") {
          if (terminal?.kind === "reply") {
            // Republish only: delivery sees the durable outcome before it can
            // consider runRoomTurn, so a recovered provider turn is impossible.
            next = "pending";
            error = item.state === "dispatching"
              ? "Daemon restarted after a durable provider reply; publishing it without rerunning the provider."
              : item.state === "publishing"
              ? "Daemon restarted during publication; retrying the durable reply."
              : item.state === "retryable"
                ? "Retrying the durable reply after a recoverable failure."
                : "Daemon restarted after a durable provider reply; publishing it."
          } else if (terminal?.kind === "no_reply") {
            next = "acknowledged_no_reply";
            error = null;
          } else if (terminal?.kind === "unreadable" && item.provider_turn_id) {
            next = "result_recovery";
            error = "Provider completed, but its answer could not be read; re-reading the same turn without rerunning it.";
          } else if (item.provider_turn_id && (item.state === "dispatching" || item.state === "awaiting_result")) {
            // This is not a retry: delivery will ask the provider to inspect
            // precisely this persisted turn id and will block if it cannot.
            next = "pending";
            error = "Daemon restarted while awaiting the exact persisted provider turn; recovering it without rerunning.";
          } else {
            next = "blocked";
            error = `Daemon restarted during ${item.state} without authoritative terminal or publication evidence; acknowledgement is unsafe.`;
          }
        }
        if (!next) continue;
        const timestamp = this.now();
        run(database.prepare("UPDATE supervised_agent_inbox SET state=?,last_error=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?"),
          next, error, timestamp, finalStates.has(next) ? timestamp : null, item.inbox_item_id);
        const updated = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
        const phase = phaseForTransition(next);
        if (phase) this.recordEvent(database, updated.inbox_item_id, `recovery:${phase}:${updated.attempt_count}`, phase, timestamp, error);
        recovered.push(updated);
      }
      return recovered;
    }));
  }
  async receipts(agentId: string): Promise<SupervisedInboxReceiptWithTimeline[]> {
    return this.read(async (database) => {
      const rows = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? ORDER BY fifo_sequence").all(agentId) as Row[];
      const head = rows.find((row) => !finalStates.has(String(row.state) as SupervisedInboxState));
      const firstBlocked = head && String(head.state) === "blocked" ? head : undefined;
      return rows.map((row) => {
        const item = rowToItem(row);
        const timeline = this.events(database, item.inbox_item_id);
        if (firstBlocked && item.fifo_sequence > Number(firstBlocked.fifo_sequence) && !finalStates.has(item.state)) {
          return { ...item, timeline, receipt_state: "queued_behind_blocked" as const, blocked_by_inbox_item_id: String(firstBlocked.inbox_item_id) };
        }
        return { ...item, timeline, receipt_state: item.state };
      });
    });
  }

  private async read<T>(operation: (database: DatabaseSync) => Promise<T> | T): Promise<T> { return operation(await this.getDatabase()); }
  private async exclusive<T>(operation: (database: DatabaseSync) => Promise<T>): Promise<T> {
    let release!: () => void; const prior = this.writes; this.writes = new Promise<void>((resolve) => { release = resolve; });
    await prior; try { return await operation(await this.getDatabase()); } finally { release(); }
  }
  private transaction<T>(database: DatabaseSync, operation: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = operation(); database.exec("COMMIT"); return result; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
  private async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("Supervised inbox store is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = openDaemonStateDatabase(this.databasePath, (database) => new DaemonStateSchema().createSchema(database)).then((database) => { this.database = database; return database; });
    return this.initializing;
  }
  private require(value: string, field: string): void { if (!value?.trim()) throw new Error(`Supervised inbox ${field} is required.`); }
  private requireNumericCursor(cursor: string): void { if (!/^(?:msg_)?\d+$/.test(cursor)) throw new Error("Supervised inbox cursor must be a numeric room message id."); }
  private assertCurrentHead(database: DatabaseSync, item: SupervisedInboxItem): void {
    const head = database.prepare("SELECT inbox_item_id FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move') ORDER BY fifo_sequence LIMIT 1").get(item.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== item.inbox_item_id) throw new Error("Only the current FIFO head may change delivery state.");
  }
  private recordEvent(database: DatabaseSync, inboxItemId: string, idempotencyKey: string, phase: SupervisedInboxEvent["phase"], observedAt: string, detail: string | null): void {
    // The ordinal is allocated in the same inbox transaction as its state
    // fact. The idempotency key remains independent so replay cannot append a
    // duplicate phase, even when timestamps are identical.
    run(database.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT ?,COALESCE((SELECT MAX(event_sequence) FROM supervised_agent_inbox_events WHERE inbox_item_id=?),0)+1,?,?,?,?
      WHERE NOT EXISTS (
        SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?
      )`), inboxItemId, inboxItemId, idempotencyKey, phase, observedAt, detail, inboxItemId, idempotencyKey);
  }
  private events(database: DatabaseSync, inboxItemId: string): SupervisedInboxEvent[] {
    return (database.prepare("SELECT phase,observed_at,detail FROM supervised_agent_inbox_events WHERE inbox_item_id=? ORDER BY event_sequence").all(inboxItemId) as Row[]).map((row) => ({
      phase: String(row.phase) as SupervisedInboxEvent["phase"], observed_at: String(row.observed_at), detail: row.detail === null ? null : String(row.detail),
    }));
  }
}

function phaseForTransition(state: SupervisedInboxState): SupervisedInboxEvent["phase"] | null {
  if (state === "result_recovery") return "result_unreadable";
  if (state === "publishing") return "publish_started";
  if (state === "acknowledged") return "published";
  if (state === "acknowledged_no_reply") return "no_reply";
  if (state === "retryable") return "retry_scheduled";
  if (state === "blocked") return "blocked";
  if (state === "cancelled_by_room_move") return "room_move_cancelled";
  if (state === "pending") return "queued";
  return null;
}

function isNewerCursor(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  const numeric = (value: string) => value.startsWith("msg_") ? value.slice(4) : value;
  const candidateNumber = BigInt(numeric(candidate)); const currentNumber = BigInt(numeric(current));
  return candidateNumber > currentNumber;
}

function rowToItem(row: Row): SupervisedInboxItem {
  return { inbox_item_id: String(row.inbox_item_id), agent_id: String(row.agent_id), room_id: String(row.room_id), source_message_id: String(row.source_message_id), source_message: JSON.parse(String(row.source_message_json)), activation: JSON.parse(String(row.activation_json)), fifo_sequence: Number(row.fifo_sequence), state: String(row.state) as SupervisedInboxState, attempt_count: Number(row.attempt_count), action_id: String(row.action_id), reply_client_message_id: String(row.reply_client_message_id), provider_turn_id: row.provider_turn_id === null ? null : String(row.provider_turn_id), outcome: row.outcome === null ? null : String(row.outcome), last_error: row.last_error === null ? null : String(row.last_error), blocked_by_inbox_item_id: row.blocked_by_inbox_item_id === null ? null : String(row.blocked_by_inbox_item_id), next_attempt_at_ms: row.next_attempt_at_ms === null ? null : Number(row.next_attempt_at_ms), created_at: String(row.created_at), updated_at: String(row.updated_at), acknowledged_at: row.acknowledged_at === null ? null : String(row.acknowledged_at) };
}

function rowToEffect(row: Row): SupervisedEffectRecord {
  return {
    effect_id: String(row.effect_id), agent_id: String(row.agent_id), room_id: String(row.room_id),
    execution_generation_id: String(row.execution_generation_id), provider_turn_id: String(row.provider_turn_id),
    mcp_request_id: String(row.mcp_request_id), tool_name: String(row.tool_name), request: JSON.parse(String(row.request_json)),
    state: String(row.state) as SupervisedEffectRecord["state"],
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
  };
}

function valueOrCurrent<T extends object, K extends keyof T>(patch: T, key: K, current: T[K]): T[K] {
  return Object.hasOwn(patch, key) ? patch[key] : current;
}

function persistedTerminalOutcome(outcome: string | null): { kind: "reply"; text: string } | { kind: "no_reply" } | { kind: "unreadable" } | null {
  if (!outcome) return null;
  try {
    const parsed = JSON.parse(outcome) as { kind?: unknown; text?: unknown };
    if (parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim()) return { kind: "reply", text: parsed.text };
    if (parsed.kind === "no_reply") return { kind: "no_reply" };
    return parsed.kind === "unreadable" ? { kind: "unreadable" } : null;
  } catch { return null; }
}
