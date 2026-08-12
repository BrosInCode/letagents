import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";
import {
  pruneSupervisedAgentHistory,
  RETAINED_UNCERTAIN_EFFECTS_PER_AGENT,
  RETAINED_TERMINAL_RECEIPTS_PER_AGENT,
  settlePreparedSupervisedEffectsForTerminalItem,
} from "./supervised-agent-history-retention.js";

export type SupervisedInboxState = "pending" | "dispatching" | "awaiting_result" | "result_recovery" | "publishing" | "retryable" | "blocked" | "acknowledged" | "acknowledged_no_reply" | "cancelled_by_room_move" | "cancelled_by_user";
export type SupervisedInboxReceiptState = SupervisedInboxState | "queued_behind_blocked";
export type InboxActivation = Record<string, unknown>;
export type IngressMessage = { source_message_id: string; source_message: unknown; activation: InboxActivation };
export type ObservedIngressMessage = IngressMessage & { activation_decision: string };
export type SupervisedInboxItem = {
  inbox_item_id: string; agent_id: string; room_id: string; source_message_id: string;
  source_message: unknown; activation: InboxActivation; fifo_sequence: number; state: SupervisedInboxState;
  attempt_count: number; action_id: string; reply_client_message_id: string; provider_turn_id: string | null;
  outcome: string | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; blocked_by_inbox_item_id: string | null;
  next_attempt_at_ms: number | null; terminal_reason: "upgrade_authority_unavailable" | null;
  created_at: string; updated_at: string; acknowledged_at: string | null;
};
export type SupervisedProviderTurnBinding = {
  inbox_item_id: string;
  agent_id: string;
  room_id: string;
  work_attempt_id: string;
  origin_execution_generation_id: string;
  provider_continuation_id: string;
  provider_turn_id: string;
};
export type SupervisedInboxReceipt = SupervisedInboxItem & { receipt_state: SupervisedInboxReceiptState };
export type SupervisedInboxEvent = {
  phase: "received" | "queued" | "turn_started" | "turn_finished" | "result_unreadable" | "publish_started" | "published" | "no_reply" | "retry_scheduled" | "blocked" | "room_move_cancelled" | "conversation_restoring" | "conversation_restored" | "user_cancelled";
  observed_at: string;
  detail: string | null;
};
export type SupervisedInboxReceiptWithTimeline = SupervisedInboxReceipt & {
  timeline: SupervisedInboxEvent[];
  canonical_message_id: string | null;
};
export type SupervisedEffectRecord = {
  effect_id: string; agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
  mcp_request_id: string; tool_name: string; request: unknown; mutation: boolean;
  state: "prepared" | "executing" | "uncertain" | "completed" | "failed";
  result: unknown | null; error: string | null; created_at: string; updated_at: string;
};
export type StructuredRoomTurnCompletion =
  | { outcome: "reply"; text: string }
  | { outcome: "no_reply"; text: null };

/** Validate the durable request written by the supervised-only completion tool. */
export function structuredRoomTurnCompletion(value: unknown): StructuredRoomTurnCompletion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "outcome" && key !== "text")) return null;
  if (record.outcome === "no_reply") {
    return record.text === undefined || record.text === null || record.text === ""
      ? { outcome: "no_reply", text: null }
      : null;
  }
  if (record.outcome !== "reply" || typeof record.text !== "string") return null;
  const text = record.text.trim();
  if (!text || Buffer.byteLength(text, "utf8") > 32 * 1024) return null;
  return { outcome: "reply", text };
}

function structuredRoomTurnCompletionResult(completion: StructuredRoomTurnCompletion): Record<string, unknown> {
  const payload = {
    accepted: true,
    outcome: completion.outcome,
    instruction: "The daemon recorded this exact turn completion. End the provider turn without sending the activating reply through another tool.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
export type AgentInspectorDetail = {
  availability: "available" | "pruned" | "not_loaded";
  entry_id: string; room_id: string; requested_source_message_id: string | null; inbox_item_id: string | null;
  source_message: { id: string; room_id: string; sender: string | null; text: string | null; created_at: string | null; reply_to: string | null; thread_root_id: string | null; activation: InboxActivation | null } | null;
  receipt: { state: SupervisedInboxState; attempt_count: number; provider_turn_id: string | null; outcome: unknown; last_error: string | null; failure_code: "provider_continuation_missing" | null; blocked_by_inbox_item_id: string | null; next_attempt_at_ms: number | null; terminal_reason: "upgrade_authority_unavailable" | null } | null;
  terminal: { outcome: string; normalized_text: string | null; evidence_source: string; observed_at: string } | null;
  publication: { client_message_id: string; canonical_message_id: string | null; room_id: string | null } | null;
  continuation_repair: ProviderContinuationRepair | null;
  timeline: SupervisedInboxEvent[];
  items: Array<{ source_message_id: string; inbox_item_id: string; state: SupervisedInboxState; attempt_count: number; updated_at: string; sender: string | null; text_preview: string | null; created_at: string | null; outcome: unknown; provider_turn_id: string | null; last_error: string | null; failure_code: "provider_continuation_missing" | null; terminal_reason: "upgrade_authority_unavailable" | null; canonical_message_id: string | null }>;
  uncertain_effects: Array<{ effect_id: string; tool_name: string; mcp_request_id: string; error: string; created_at: string; updated_at: string }>;
  history_boundary: { earliest_retained_observed_message_id: string | null; earliest_retained_inbox_message_id: string | null; earliest_retained_receipt_sequence: number | null; pruned_before_message_id: string | null; pruned_at: string | null } | null;
};
type Row = Record<string, unknown>;
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
class EffectAuthorityError extends Error {}
const MAX_EFFECTS_PER_PROVIDER_TURN = 128;
const MAX_UNRESOLVED_EFFECTS_PER_AGENT = 128;
const MAX_EFFECT_REQUEST_BYTES = 64 * 1024;
const MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN = 512 * 1024;
const MAX_EFFECT_RESULT_BYTES = 256 * 1024;
const MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN = 1024 * 1024;
const MAX_EFFECT_ERROR_BYTES = 16 * 1024;
const READ_ONLY_EFFECT_TOOLS = new Set([
  "get_current_room", "check_repo", "check_repo_visibility",
  "read_messages", "wait_for_messages", "get_board", "get_board_settings",
  "get_room_artifacts", "get_room_events", "list_board_intents",
  "get_onboarding_status", "status_local_codex_session", "rental_list_requests",
]);
export type ProviderContinuationRepair = {
  repair_id: string;
  agent_id: string;
  room_id: string;
  inbox_item_id: string;
  daemon_generation: number;
  execution_generation_id: string;
  work_attempt_id: string;
  expected_pid: number;
  expected_process_identity: string;
  missing_continuation: string;
  replacement_continuation: string | null;
  phase: "probing" | "replacement_created" | "committed" | "failed";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
const finalStates = new Set<SupervisedInboxState>(["acknowledged", "acknowledged_no_reply", "cancelled_by_room_move", "cancelled_by_user"]);
const RETAINED_TIMELINE_EVENTS_PER_RECEIPT = 64;
const transitions: Readonly<Record<SupervisedInboxState, readonly SupervisedInboxState[]>> = {
  pending: ["dispatching", "blocked"], dispatching: ["awaiting_result", "retryable", "blocked"],
  awaiting_result: ["result_recovery", "publishing", "acknowledged_no_reply", "retryable", "blocked"],
  result_recovery: ["publishing", "acknowledged_no_reply", "blocked"], publishing: ["acknowledged", "retryable", "blocked"],
  retryable: ["pending", "blocked"], blocked: ["pending", "cancelled_by_user"], acknowledged: [], acknowledged_no_reply: [], cancelled_by_room_move: [], cancelled_by_user: [],
};

/** Durable, provider-neutral room delivery queue. It owns neither polling nor turns. */
export class SupervisedAgentInboxStore {
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly databasePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onMutation: () => void = () => undefined,
  ) {}

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
    }, commitFence));
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
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id,room_id,source_message_id) DO NOTHING`),
          input.agent_id, input.room_id, message.source_message_id, JSON.stringify(message.source_message), JSON.stringify(message.activation), message.activation_decision, observedAt);
      }
      let sequence = Number((database.prepare("SELECT COALESCE(MAX(fifo_sequence), 0) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(input.agent_id) as Row).value);
      const created: SupervisedInboxItem[] = [];
      for (const message of input.messages) {
        this.require(message.source_message_id, "source_message_id");
        const existing = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=?").get(input.agent_id, input.room_id, message.source_message_id) as Row | undefined;
        if (existing) { created.push(rowToItem(existing)); continue; }
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
        created.push(rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row));
      }
      const timestamp = this.now();
      const nextCursor = input.last_observed_message_id === null || !isNewerCursor(input.last_observed_message_id, currentCursor)
        ? currentCursor : input.last_observed_message_id;
      run(database.prepare(`INSERT INTO supervised_agent_ingress_cursors(agent_id,room_id,last_observed_message_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id,last_observed_message_id=excluded.last_observed_message_id,updated_at=excluded.updated_at`), input.agent_id, input.room_id, nextCursor, timestamp);
      this.pruneAgentHistory(database, input.agent_id);
      return created;
    }));
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
    this.require(input.agent_id, "agent_id"); this.require(input.room_id, "room_id"); this.require(input.source_message_id, "source_message_id");
    return this.exclusive(async (database) => this.transaction(database, () => {
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
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence LIMIT 1").get(agentId) as Row | undefined;
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
  async get(inboxItemId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => { const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined; return row ? rowToItem(row) : null; });
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
        this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
      }
      this.pruneAgentHistory(database, item.agent_id);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
    }));
  }
  /** Exact-entry, exact-room, bounded renderer-safe projection. */
  async detail(agentId: string, roomId: string, sourceMessageId?: string | null): Promise<AgentInspectorDetail> {
    return this.read(async (database) => {
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
        return { availability, entry_id: agentId, room_id: roomId, requested_source_message_id: sourceMessageId ?? null, inbox_item_id: null, source_message: null, receipt: null, terminal: null, publication: null, continuation_repair: null, timeline: [], items, uncertain_effects: uncertainEffects, history_boundary: history };
      }
      const item = rowToItem(row);
      const events = (database.prepare("SELECT phase,observed_at,detail FROM supervised_agent_inbox_events WHERE inbox_item_id=? ORDER BY event_sequence LIMIT 100").all(item.inbox_item_id) as Row[]).map(rowToEvent);
      const terminal = database.prepare("SELECT outcome,normalized_text,evidence_source,observed_at FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      const publication = database.prepare("SELECT room_id,client_message_id,canonical_message_id FROM supervised_agent_publications WHERE inbox_item_id=?").get(item.inbox_item_id) as Row | undefined;
      const repair = database.prepare("SELECT * FROM provider_continuation_repairs WHERE inbox_item_id=? ORDER BY created_at DESC LIMIT 1").get(item.inbox_item_id) as Row | undefined;
      return { availability: "available", entry_id: agentId, room_id: roomId, requested_source_message_id: sourceMessageId ?? null, inbox_item_id: item.inbox_item_id,
        source_message: safeSource(item.source_message, item.source_message_id, roomId, item.activation),
        receipt: { state: item.state, attempt_count: item.attempt_count, provider_turn_id: item.provider_turn_id, outcome: safeOutcome(item.outcome), last_error: item.last_error, failure_code: item.failure_code, blocked_by_inbox_item_id: item.blocked_by_inbox_item_id, next_attempt_at_ms: item.next_attempt_at_ms, terminal_reason: item.terminal_reason },
        terminal: terminal ? { outcome: String(terminal.outcome), normalized_text: terminal.normalized_text === null ? null : String(terminal.normalized_text), evidence_source: String(terminal.evidence_source), observed_at: String(terminal.observed_at) } : null,
        publication: publication ? { client_message_id: String(publication.client_message_id), canonical_message_id: String(publication.canonical_message_id), room_id: String(publication.room_id) } : null,
        continuation_repair: repair ? rowToContinuationRepair(repair) : null,
        timeline: events, items, uncertain_effects: uncertainEffects, history_boundary: history };
    });
  }
  async transition(inboxItemId: string, next: SupervisedInboxState, patch: Partial<Pick<SupervisedInboxItem, "provider_turn_id" | "outcome" | "last_error" | "failure_code" | "next_attempt_at_ms" | "blocked_by_inbox_item_id">> = {}): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const current = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!current) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(current);
      if (!transitions[item.state].includes(next)) throw new Error(`Invalid supervised inbox transition: ${item.state} -> ${next}.`);
      // Every in-flight state is causally owned by the true FIFO head. This
      // prevents a later item becoming blocked and hiding the real stall.
      if (!finalStates.has(next)) this.assertCurrentHead(database, item);
      if (next === "dispatching" && item.state !== "pending") throw new Error("Only the current pending FIFO head may be dispatched.");
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
        this.recordEvent(database, inboxItemId, `${event}:${ordinal}`, event, timestamp, updated.last_error);
      }
      if (finalStates.has(next)) {
        this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
        this.pruneAgentHistory(database, item.agent_id);
      }
      return updated;
    }));
  }
  async claimHead(agentId: string): Promise<SupervisedInboxItem | null> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence LIMIT 1").get(agentId) as Row | undefined;
      if (!row) return null;
      const item = rowToItem(row);
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
  /**
   * Roll back only a provider turn whose durable wrapper proves native dispatch
   * never happened. This is intentionally narrower than the ordinary retry
   * transition: exact turn identity, FIFO ownership, and absence of terminal
   * or tool-effect evidence are all checked in the same transaction.
   */
  async resetUndispatchedTurn(inboxItemId: string, providerTurnId: string): Promise<SupervisedInboxItem> {
    if (!providerTurnId.trim()) throw new Error("Undispatched reset requires an exact provider turn id.");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(row);
      if (!["dispatching", "awaiting_result", "result_recovery"].includes(item.state)
        || item.provider_turn_id !== providerTurnId) {
        throw new Error("Undispatched reset does not match the exact in-flight provider turn.");
      }
      this.assertCurrentHead(database, item);
      const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      if (!binding || String(binding.agent_id) !== item.agent_id || String(binding.room_id) !== item.room_id
        || String(binding.provider_turn_id) !== providerTurnId) {
        throw new Error("Undispatched reset is missing its exact provider-turn authority binding.");
      }
      const executionGenerationId = String(binding.origin_execution_generation_id);
      const terminal = database.prepare("SELECT 1 FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(inboxItemId);
      const effect = database.prepare(`SELECT 1 FROM supervised_agent_effects
        WHERE agent_id=? AND room_id=? AND execution_generation_id=? AND provider_turn_id=?
        UNION ALL
        SELECT 1 FROM supervised_agent_effect_tombstones
        WHERE agent_id=? AND room_id=? AND execution_generation_id=? AND provider_turn_id=?
        LIMIT 1`).get(
        item.agent_id, item.room_id, executionGenerationId, providerTurnId,
        item.agent_id, item.room_id, executionGenerationId, providerTurnId,
      );
      if (terminal || effect || item.outcome) {
        throw new Error("Undispatched reset found terminal or effect evidence and was refused.");
      }
      const timestamp = this.now();
      run(database.prepare("DELETE FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?"), inboxItemId);
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='pending',attempt_count=?,provider_turn_id=NULL,outcome=NULL,last_error=NULL,
            failure_code=NULL,next_attempt_at_ms=NULL,updated_at=?
        WHERE inbox_item_id=?`), Math.max(0, item.attempt_count - 1), timestamp, inboxItemId);
      const retryOrdinal = Number((database.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='retry_scheduled'").get(inboxItemId) as Row).value) + 1;
      this.recordEvent(database, inboxItemId, `undispatched_retry:${retryOrdinal}:${providerTurnId}`, "retry_scheduled", timestamp, "Prepared provider wrapper exited before native dispatch; retrying the same FIFO item.");
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
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
      const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(input.inbox_item_id) as Row | undefined;
      if (!binding
        || String(binding.agent_id) !== item.agent_id
        || String(binding.room_id) !== item.room_id
        || String(binding.origin_execution_generation_id) !== input.execution_generation_id
        || String(binding.provider_turn_id) !== input.provider_turn_id) {
        throw new Error("Normalized terminal evidence does not match the durable provider-turn authority binding.");
      }
      const priorTerminal = database.prepare(`SELECT agent_id,execution_generation_id,provider_turn_id
        FROM supervised_agent_terminal_results WHERE inbox_item_id=?`).get(input.inbox_item_id) as Row | undefined;
      if (priorTerminal && (String(priorTerminal.agent_id) !== input.agent_id
        || String(priorTerminal.execution_generation_id) !== input.execution_generation_id
        || String(priorTerminal.provider_turn_id) !== input.provider_turn_id)) {
        throw new Error("Normalized terminal evidence conflicts with an earlier provider-turn authority identity.");
      }
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

  async recordResultRecoveryRetry(inboxItemId: string, error: string): Promise<number> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error(`Unknown supervised inbox item: ${inboxItemId}`);
      const item = rowToItem(row);
      if (item.state !== "result_recovery") throw new Error("Only an unreadable terminal result may record a result-recovery retry.");
      this.assertCurrentHead(database, item);
      const prior = Number((database.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='retry_scheduled'").get(inboxItemId) as Row).value);
      const attempt = prior + 1;
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?"), error, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `result_recovery_retry:${attempt}`, "retry_scheduled", timestamp, `Re-reading the same completed turn (${attempt}/3): ${error}`);
      return attempt;
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
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
    mcp_request_id: string; tool_name: string; request: unknown; mutation?: boolean;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; effect: SupervisedEffectRecord }> {
    const requestJson = serializeEffectJson(input.request, "request");
    const expectedMutation = !READ_ONLY_EFFECT_TOOLS.has(input.tool_name);
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
              AND tool_name<>'complete_room_turn' AND state='executing' LIMIT 1`).get(
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
              ? "The daemon restarted while committing the local completion proposal; its durable request is safe to commit again."
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
                AND tool_name<>'complete_room_turn' AND state='executing' LIMIT 1`).get(
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
            AND tool_name<>'complete_room_turn' AND state='executing' LIMIT 1`).get(
          input.agent_id, input.execution_generation_id, input.provider_turn_id,
        );
        if (executing) {
          throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
        }
      }
      this.assertActiveEffectAuthority(database, input);
      const timestamp = this.now();
      const effectId = randomUUID();
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
        WHERE agent_id=? AND room_id=? AND fifo_sequence>? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence`).all(input.agent_id, input.old_room_id, input.after_fifo_sequence) as Row[];
      const timestamp = this.now();
      for (const row of rows) {
        const item = rowToItem(row);
        run(database.prepare(`UPDATE supervised_agent_inbox SET state='cancelled_by_room_move',last_error=?,updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`),
          "Cancelled because the agent moved to another room.", timestamp, timestamp, item.inbox_item_id);
        this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
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
      const row = database.prepare(
        "SELECT * FROM provider_continuation_repairs WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      ).get(agentId) as Row | undefined;
      return row ? rowToContinuationRepair(row) : null;
    });
  }

  async skipBlocked(inboxItemId: string): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) throw new Error("The blocked room message no longer exists.");
      const item = rowToItem(row);
      if (item.state !== "blocked" || item.attempt_count !== 0 || item.provider_turn_id || item.outcome) {
        throw new Error("This message cannot be skipped because provider work may already have started.");
      }
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='cancelled_by_user',last_error=NULL,failure_code=NULL,updated_at=?,acknowledged_at=?
        WHERE inbox_item_id=?`), timestamp, timestamp, inboxItemId);
      this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
      this.recordEvent(database, inboxItemId, "user_cancelled", "user_cancelled", timestamp, "Skipped by the user before any provider turn started.");
      this.pruneAgentHistory(database, item.agent_id);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
    }));
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
    // Every pre-publish state is safe to settle on a user Stop. `publishing`
    // and the terminal states are not: their outcome is already committed.
    const cancellable = new Set<SupervisedInboxState>(["pending", "dispatching", "awaiting_result", "result_recovery", "retryable", "blocked"]);
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      if (!row) return null;
      const item = rowToItem(row);
      if (expected && (item.agent_id !== expected.agent_id || item.room_id !== expected.room_id)) {
        throw new Error("Interrupted-turn settlement does not match the exact active delivery identity.");
      }
      if (!cancellable.has(item.state)) return item;
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='cancelled_by_user',last_error=?,failure_code=NULL,updated_at=?,acknowledged_at=?
        WHERE inbox_item_id=?`), detail, timestamp, timestamp, inboxItemId);
      this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
      this.recordEvent(database, inboxItemId, `user_cancelled:${item.fifo_sequence}`, "user_cancelled", timestamp, detail);
      this.pruneAgentHistory(database, item.agent_id);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
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
   * allowed to pump it. A persisted reply is authoritative terminal evidence:
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
      const rows = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence").all(agentId) as Row[];
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
          } else if (item.provider_turn_id && (item.state === "dispatching" || item.state === "awaiting_result" || item.state === "retryable")) {
            // This is not a retry: delivery will ask the provider to inspect
            // precisely this persisted turn id and will block if it cannot.
            next = "pending";
            error = "Daemon restarted while awaiting the exact persisted provider turn; recovering it without rerunning.";
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
        if (finalStates.has(next)) {
          this.settlePreparedEffectsForTerminalItem(database, item, timestamp);
          this.pruneAgentHistory(database, item.agent_id);
        }
        recovered.push(updated);
      }
      this.pruneAgentHistory(database, agentId);
      return recovered;
    }));
  }
  /**
   * Return every actionable receipt plus a bounded terminal history. Timeline
   * events are loaded in one joined query and capped per selected receipt so a
   * noisy historical incident cannot make every manifest projection unbounded.
   */
  async receipts(agentId: string, terminalLimit = RETAINED_TERMINAL_RECEIPTS_PER_AGENT): Promise<SupervisedInboxReceiptWithTimeline[]> {
    return this.read(async (database) => {
      const limit = Math.max(0, Math.min(Math.trunc(terminalLimit), RETAINED_TERMINAL_RECEIPTS_PER_AGENT));
      const rows = database.prepare(`SELECT i.*,p.canonical_message_id
        FROM supervised_agent_inbox i
        LEFT JOIN supervised_agent_publications p ON p.inbox_item_id=i.inbox_item_id
        WHERE i.agent_id=? AND (
          i.state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
          OR i.inbox_item_id IN (
            SELECT inbox_item_id FROM supervised_agent_inbox
            WHERE agent_id=? AND state IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
            ORDER BY fifo_sequence DESC LIMIT ?
          )
        ) ORDER BY i.fifo_sequence`).all(agentId, agentId, limit) as Row[];
      const timelines = new Map<string, SupervisedInboxEvent[]>();
      for (const event of database.prepare(`WITH selected_inbox AS (
          SELECT inbox_item_id,fifo_sequence
          FROM supervised_agent_inbox
          WHERE agent_id=? AND (
            state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
            OR inbox_item_id IN (
              SELECT inbox_item_id FROM supervised_agent_inbox
              WHERE agent_id=? AND state IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
              ORDER BY fifo_sequence DESC LIMIT ?
            )
          )
        )
        SELECT e.inbox_item_id,e.phase,e.observed_at,e.detail
        FROM selected_inbox s
        JOIN supervised_agent_inbox_events e
          ON e.inbox_item_id=s.inbox_item_id
          AND e.event_sequence > COALESCE((
            SELECT cutoff.event_sequence
            FROM supervised_agent_inbox_events cutoff
            WHERE cutoff.inbox_item_id=s.inbox_item_id
            ORDER BY cutoff.event_sequence DESC
            LIMIT 1 OFFSET ?
          ),0)
        ORDER BY s.fifo_sequence,e.event_sequence`).all(
          agentId,
          agentId,
          limit,
          RETAINED_TIMELINE_EVENTS_PER_RECEIPT,
        ) as Row[]) {
        const inboxItemId = String(event.inbox_item_id);
        const timeline = timelines.get(inboxItemId) ?? [];
        timeline.push({
          phase: String(event.phase) as SupervisedInboxEvent["phase"],
          observed_at: String(event.observed_at),
          detail: event.detail === null ? null : String(event.detail),
        });
        timelines.set(inboxItemId, timeline);
      }
      const head = rows.find((row) => !finalStates.has(String(row.state) as SupervisedInboxState));
      const firstBlocked = head && String(head.state) === "blocked" ? head : undefined;
      return rows.map((row) => {
        const item = rowToItem(row);
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
    }));
  }

  async pruneHistory(agentId: string): Promise<void> {
    await this.exclusive(async (database) => this.transaction(database, () => this.pruneAgentHistory(database, agentId)));
  }

  private async read<T>(operation: (database: DatabaseSync) => Promise<T> | T): Promise<T> { return operation(await this.getDatabase()); }
  private async exclusive<T>(operation: (database: DatabaseSync) => Promise<T>): Promise<T> {
    let release!: () => void; const prior = this.writes; this.writes = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    let committed = false;
    try {
      const result = await operation(await this.getDatabase());
      committed = true;
      return result;
    } finally {
      release();
      if (committed) this.onMutation();
    }
  }
  private transaction<T>(database: DatabaseSync, operation: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = operation(); database.exec("COMMIT"); return result; } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; } }
  private async transactionFenced<T>(database: DatabaseSync, operation: () => T, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<T> {
    let transactionOpen = false;
    let committed = false;
    let result!: T;
    try {
      const transaction = async () => {
        if (transactionOpen || committed) throw new Error("Supervised inbox transaction was already started.");
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        result = operation();
        database.exec("COMMIT");
        transactionOpen = false;
        committed = true;
      };
      if (commitFence) await commitFence(transaction); else await transaction();
      if (!committed) throw new Error("Supervised inbox commit fence returned without committing.");
      return result;
    } catch (error) {
      if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
      throw error;
    }
  }
  private async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("Supervised inbox store is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = openDaemonStateDatabase(this.databasePath, (database) => new DaemonStateSchema().createSchema(database)).then((database) => { this.database = database; return database; });
    return this.initializing;
  }
  private require(value: string, field: string): void { if (!value?.trim()) throw new Error(`Supervised inbox ${field} is required.`); }
  private requireNumericCursor(cursor: string): void { if (!/^(?:msg_)?\d+$/.test(cursor)) throw new Error("Supervised inbox cursor must be a numeric room message id."); }
  /** Terminal ownership proves a prepared ordinary effect never crossed its
   * execution CAS. Settle it in the same transaction as every terminal path
   * so handoff/Stop races cannot leave immortal purge blockers. Room moves are
   * intentionally prepared until the acknowledged reply is reconciled. */
  private settlePreparedEffectsForTerminalItem(database: DatabaseSync, item: SupervisedInboxItem, timestamp: string): void {
    settlePreparedSupervisedEffectsForTerminalItem(database, {
      inboxItemId: item.inbox_item_id,
      agentId: item.agent_id,
      providerTurnId: item.provider_turn_id,
    }, timestamp);
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
      WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
      ORDER BY fifo_sequence LIMIT 1`).get(input.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== String(rows[0]?.inbox_item_id)) {
      throw new EffectAuthorityError("The supervised effect provider turn is no longer the exact FIFO head.");
    }
    const runtime = database.prepare(`SELECT m.room_id,l.desired_state,d.work_attempt_id_present,d.work_attempt_id,
        d.provider_ref_present,d.provider_work_attempt_id,d.provider_continuation_id,d.provider_execution_generation_id,s.condition
      FROM agent_room_memberships m JOIN agent_launch_intents l USING(agent_id)
      JOIN runtime_deployments d USING(agent_id) JOIN agent_lifecycle_states s USING(agent_id)
      WHERE m.agent_id=?`).get(input.agent_id) as Row | undefined;
    if (!runtime || String(runtime.room_id) !== input.room_id || String(runtime.desired_state) !== "running"
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
  private assertCurrentHead(database: DatabaseSync, item: SupervisedInboxItem): void {
    const head = database.prepare("SELECT inbox_item_id FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user') ORDER BY fifo_sequence LIMIT 1").get(item.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== item.inbox_item_id) throw new Error("Only the current FIFO head may change delivery state.");
  }
  private normalizeInterruptedEffectsInTransaction(database: DatabaseSync, agentId: string | undefined, interruptedAt: string): void {
    const scope = agentId ? " AND agent_id=?" : "";
    const readArgs = [
      "The daemon restarted before this read-only tool result was checkpointed. The exact request may be executed again safely.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='prepared',error=?,updated_at=?
      WHERE state='executing' AND mutation=0 AND tool_name<>'join_room'${scope}`), ...readArgs);
    const mutationArgs = [
      "The daemon restarted after this mutating tool crossed its execution boundary. It may have completed; verify external state before repeating it.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='uncertain',error=?,updated_at=?
      WHERE state='executing' AND mutation=1 AND tool_name NOT IN ('join_room','complete_room_turn')${scope}`), ...mutationArgs);
    const completionArgs = [
      "The daemon restarted while committing the local completion proposal; its durable request is safe to commit again.",
      interruptedAt,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE supervised_agent_effects
      SET state='prepared',error=?,updated_at=?
      WHERE state='executing' AND tool_name='complete_room_turn'${scope}`), ...completionArgs);
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
  private pruneAgentHistory(database: DatabaseSync, agentId: string, protectedUncertainEffectId: string | null = null): void {
    pruneSupervisedAgentHistory(database, agentId, this.now, protectedUncertainEffectId);
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
  if (state === "cancelled_by_user") return "user_cancelled";
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
  return { inbox_item_id: String(row.inbox_item_id), agent_id: String(row.agent_id), room_id: String(row.room_id), source_message_id: String(row.source_message_id), source_message: JSON.parse(String(row.source_message_json)), activation: JSON.parse(String(row.activation_json)), fifo_sequence: Number(row.fifo_sequence), state: String(row.state) as SupervisedInboxState, attempt_count: Number(row.attempt_count), action_id: String(row.action_id), reply_client_message_id: String(row.reply_client_message_id), provider_turn_id: row.provider_turn_id === null ? null : String(row.provider_turn_id), outcome: row.outcome === null ? null : String(row.outcome), last_error: row.last_error === null ? null : String(row.last_error), failure_code: row.failure_code === null || row.failure_code === undefined ? null : String(row.failure_code) as "provider_continuation_missing", blocked_by_inbox_item_id: row.blocked_by_inbox_item_id === null ? null : String(row.blocked_by_inbox_item_id), next_attempt_at_ms: row.next_attempt_at_ms === null ? null : Number(row.next_attempt_at_ms), terminal_reason: row.terminal_reason === null || row.terminal_reason === undefined ? null : String(row.terminal_reason) as "upgrade_authority_unavailable", created_at: String(row.created_at), updated_at: String(row.updated_at), acknowledged_at: row.acknowledged_at === null ? null : String(row.acknowledged_at) };
}
function rowToProviderTurnBinding(row: Row): SupervisedProviderTurnBinding {
  return {
    inbox_item_id: String(row.inbox_item_id),
    agent_id: String(row.agent_id),
    room_id: String(row.room_id),
    work_attempt_id: String(row.work_attempt_id),
    origin_execution_generation_id: String(row.origin_execution_generation_id),
    provider_continuation_id: String(row.provider_continuation_id),
    provider_turn_id: String(row.provider_turn_id),
  };
}
function sameProviderTurnBinding(left: SupervisedProviderTurnBinding, right: SupervisedProviderTurnBinding): boolean {
  return left.inbox_item_id === right.inbox_item_id
    && left.agent_id === right.agent_id
    && left.room_id === right.room_id
    && left.work_attempt_id === right.work_attempt_id
    && left.origin_execution_generation_id === right.origin_execution_generation_id
    && left.provider_continuation_id === right.provider_continuation_id
    && left.provider_turn_id === right.provider_turn_id;
}
function rowToEvent(row: Row): SupervisedInboxEvent { return { phase: String(row.phase) as SupervisedInboxEvent["phase"], observed_at: String(row.observed_at), detail: row.detail === null ? null : String(row.detail) }; }
function rowToInspectorItem(row: Row): AgentInspectorDetail["items"][number] { const source = safeSource(JSON.parse(String(row.source_message_json)), String(row.source_message_id), "", {}); return { source_message_id: String(row.source_message_id), inbox_item_id: String(row.inbox_item_id), state: String(row.state) as SupervisedInboxState, attempt_count: Number(row.attempt_count), updated_at: String(row.updated_at), sender: source?.sender ?? null, text_preview: source?.text ? source.text.slice(0, 240) : null, created_at: source?.created_at ?? null, outcome: safeOutcome(row.outcome === null ? null : String(row.outcome)), provider_turn_id: row.provider_turn_id === null ? null : String(row.provider_turn_id), last_error: row.last_error === null ? null : String(row.last_error), failure_code: row.failure_code === null || row.failure_code === undefined ? null : String(row.failure_code) as "provider_continuation_missing", terminal_reason: row.terminal_reason === null || row.terminal_reason === undefined ? null : String(row.terminal_reason) as "upgrade_authority_unavailable", canonical_message_id: row.canonical_message_id === null ? null : String(row.canonical_message_id) }; }
function rowToContinuationRepair(row: Row): ProviderContinuationRepair {
  return {
    repair_id: String(row.repair_id),
    agent_id: String(row.agent_id),
    room_id: String(row.room_id),
    inbox_item_id: String(row.inbox_item_id),
    daemon_generation: Number(row.daemon_generation),
    execution_generation_id: String(row.execution_generation_id),
    work_attempt_id: String(row.work_attempt_id),
    expected_pid: Number(row.expected_pid),
    expected_process_identity: String(row.expected_process_identity),
    missing_continuation: String(row.missing_continuation),
    replacement_continuation: row.replacement_continuation === null ? null : String(row.replacement_continuation),
    phase: String(row.phase) as ProviderContinuationRepair["phase"],
    attempt_count: Number(row.attempt_count),
    last_error: row.last_error === null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
function safeOutcome(outcome: string | null): unknown { try { return outcome ? JSON.parse(outcome) : null; } catch { return null; } }
function safeSource(source: unknown, id: string, roomId: string, activation: InboxActivation): AgentInspectorDetail["source_message"] { const value = source && typeof source === "object" ? source as Record<string, unknown> : {}; const reply = value.reply_to && typeof value.reply_to === "object" ? value.reply_to as Record<string, unknown> : {}; return { id, room_id: roomId, sender: typeof value.sender === "string" ? value.sender : null, text: typeof value.text === "string" ? value.text : null, created_at: typeof value.timestamp === "string" ? value.timestamp : null, reply_to: typeof value.thread_reply_to_id === "string" ? value.thread_reply_to_id : typeof reply.id === "string" ? reply.id : null, thread_root_id: typeof value.thread_root_id === "string" ? value.thread_root_id : null, activation }; }
function boundaryToDetail(row: Row): NonNullable<AgentInspectorDetail["history_boundary"]> { return { earliest_retained_observed_message_id: row.earliest_retained_observed_message_id === null ? null : String(row.earliest_retained_observed_message_id), earliest_retained_inbox_message_id: row.earliest_retained_inbox_message_id === null ? null : String(row.earliest_retained_inbox_message_id), earliest_retained_receipt_sequence: row.earliest_retained_receipt_sequence === null ? null : Number(row.earliest_retained_receipt_sequence), pruned_before_message_id: row.pruned_before_message_id === null ? null : String(row.pruned_before_message_id), pruned_at: row.pruned_at === null ? null : String(row.pruned_at) }; }

function serializeEffectJson(value: unknown, label: string): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error(`A supervised effect ${label} must be JSON-serializable.`); }
  if (serialized === undefined) throw new Error(`A supervised effect ${label} must be a JSON value.`);
  return serialized;
}

function effectRequestFingerprint(requestJson: string): string {
  return createHash("sha256").update(requestJson).digest("hex");
}

function truncateEffectError(error: string): string {
  if (Buffer.byteLength(error, "utf8") <= MAX_EFFECT_ERROR_BYTES) return error;
  const suffix = "… [truncated]";
  const prefixBytes = MAX_EFFECT_ERROR_BYTES - Buffer.byteLength(suffix, "utf8");
  const prefix = Buffer.from(error, "utf8").subarray(0, prefixBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${prefix}${suffix}`;
}

function rowToEffect(row: Row): SupervisedEffectRecord {
  return {
    effect_id: String(row.effect_id), agent_id: String(row.agent_id), room_id: String(row.room_id),
    execution_generation_id: String(row.execution_generation_id), provider_turn_id: String(row.provider_turn_id),
    mcp_request_id: String(row.mcp_request_id), tool_name: String(row.tool_name), request: JSON.parse(String(row.request_json)),
    mutation: Number(row.mutation) === 1,
    state: String(row.state) as SupervisedEffectRecord["state"],
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function rowToTombstonedEffect(row: Row): SupervisedEffectRecord {
  return {
    effect_id: String(row.effect_id), agent_id: String(row.agent_id), room_id: String(row.room_id),
    execution_generation_id: String(row.execution_generation_id), provider_turn_id: String(row.provider_turn_id),
    mcp_request_id: String(row.mcp_request_id), tool_name: String(row.tool_name), request: null,
    mutation: Number(row.mutation) === 1,
    state: String(row.state) as SupervisedEffectRecord["state"],
    result: row.result_json === null ? null : JSON.parse(String(row.result_json)),
    error: row.error === null ? null : String(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
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
