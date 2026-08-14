import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

export const RETAINED_TERMINAL_RECEIPTS_PER_AGENT = 200;
/** Ambiguous mutating tool outcomes remain visible without pinning live work forever. */
export const RETAINED_UNCERTAIN_EFFECTS_PER_AGENT = 32;
const RETAINED_OBSERVED_MESSAGES_PER_AGENT = 500;
const RETAINED_PRUNED_SOURCE_EVIDENCE_PER_AGENT = 2_000;

function run(statement: StatementSync, ...values: unknown[]): void {
  statement.run(...values as never[]);
}

/**
 * Terminal inbox ownership proves that an ordinary prepared effect never won
 * its execution CAS. It also makes an executing read irrelevant: reads are
 * safely repeatable and cannot outlive their completed provider turn. Settle
 * both in the same SQLite transaction so they cannot become immortal retention
 * pins or exhaust the per-agent unresolved-effect budget. Executing mutations
 * remain untouched because their outcome may be externally uncertain. Room
 * moves are excluded: their prepared effect is the durable move journal until
 * reconciliation.
 */
export function settlePreparedSupervisedEffectsForTerminalItem(
  database: DatabaseSync,
  item: {
    inboxItemId: string;
    agentId: string;
    providerTurnId: string | null;
  },
  timestamp: string,
): void {
  if (!item.providerTurnId) return;
  const binding = database.prepare(`SELECT origin_execution_generation_id
    FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?`)
    .get(item.inboxItemId) as Row | undefined;
  if (!binding) return;
  run(database.prepare(`UPDATE supervised_agent_effects
    SET state='failed',error='The provider turn settled before this effect completed.',updated_at=?
    WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
      AND (state='prepared' OR (state='executing' AND mutation=0))
      AND tool_name<>'join_room'`),
  timestamp, item.agentId, String(binding.origin_execution_generation_id), item.providerTurnId);
}

/**
 * Apply the complete bounded-history policy inside the caller's SQLite write
 * transaction. Every state-machine owner that can terminalize an inbox row
 * must call this before commit; cleanup is part of the authoritative mutation,
 * never a best-effort follow-up.
 */
export function pruneSupervisedAgentHistory(
  database: DatabaseSync,
  agentId: string,
  now: () => string,
  protectedUncertainEffectId: string | null = null,
): void {
  const compactableUncertain = database.prepare(`SELECT * FROM supervised_agent_effects
    WHERE agent_id=? AND state='uncertain' AND effect_id NOT IN (
      SELECT effect_id FROM supervised_agent_effects
      WHERE agent_id=? AND state='uncertain'
      ORDER BY CASE WHEN effect_id=? THEN 0 ELSE 1 END,updated_at DESC,effect_id DESC LIMIT ?
    ) ORDER BY updated_at,effect_id`).all(
    agentId, agentId, protectedUncertainEffectId, RETAINED_UNCERTAIN_EFFECTS_PER_AGENT,
  ) as Row[];
  const insertTombstone = database.prepare(`INSERT INTO supervised_agent_effect_tombstones
    (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
     tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const deleteCompactedEffect = database.prepare("DELETE FROM supervised_agent_effects WHERE effect_id=? AND state='uncertain'");
  for (const effect of compactableUncertain) {
    const requestJson = String(effect.request_json);
    run(insertTombstone,
      String(effect.effect_id), String(effect.agent_id), String(effect.room_id),
      String(effect.execution_generation_id), String(effect.provider_turn_id), String(effect.mcp_request_id),
      String(effect.tool_name), createHash("sha256").update(requestJson).digest("hex"),
      Buffer.byteLength(requestJson, "utf8"), Number(effect.mutation), "uncertain", null,
      effect.error === null ? null : String(effect.error), String(effect.created_at), String(effect.updated_at));
    run(deleteCompactedEffect, String(effect.effect_id));
  }
  // A tombstone remains replay/late-completion authority only while its exact
  // provider-turn binding exists. Its cardinality is transitively bounded:
  // per-turn effect admission caps identities before compaction, and bindings
  // survive only for active authority or bounded terminal receipt retention.
  // Do not independently evict compact identities while a binding survives;
  // doing so could make an already-crossed mutation executable again. If crash
  // repair or terminal receipt pruning removed the binding, deletion is safe.
  run(database.prepare(`DELETE FROM supervised_agent_effect_tombstones AS t
    WHERE t.agent_id=? AND NOT EXISTS (
      SELECT 1 FROM supervised_agent_provider_turn_bindings b
      WHERE b.agent_id=t.agent_id AND b.room_id=t.room_id
        AND b.origin_execution_generation_id=t.execution_generation_id
        AND b.provider_turn_id=t.provider_turn_id
    )`), agentId);
  // The one current turn-control journal is a durable causal/audit record,
  // including after it completes. Its exact inbox row owns the provider-turn
  // binding that validates those coordinates on reopen, so retention must keep
  // that row until a later control replaces the journal. Count the pin inside
  // the fixed receipt budget rather than growing history around it.
  const pinnedTerminalCount = Number((database.prepare(`SELECT COUNT(*) AS count
    FROM supervised_agent_inbox i
    WHERE i.agent_id=?
      AND i.state IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
      AND EXISTS (
        SELECT 1 FROM turn_control_journals j
        WHERE j.agent_id=i.agent_id AND j.turn_control_present=1
          AND j.inbox_item_id=i.inbox_item_id
      )`).get(agentId) as Row).count);
  const retainedUnpinnedReceipts = Math.max(
    0,
    RETAINED_TERMINAL_RECEIPTS_PER_AGENT - pinnedTerminalCount,
  );
  const stale = database.prepare(`SELECT i.inbox_item_id,i.provider_turn_id,i.room_id,i.source_message_id,
      b.origin_execution_generation_id
    FROM supervised_agent_inbox i
    LEFT JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
    WHERE i.agent_id=?
      AND i.state IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
      AND NOT EXISTS (
        SELECT 1 FROM turn_control_journals j
        WHERE j.agent_id=i.agent_id AND j.turn_control_present=1
          AND j.inbox_item_id=i.inbox_item_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM supervised_agent_effects e
        WHERE e.agent_id=i.agent_id AND e.provider_turn_id=i.provider_turn_id
          AND (b.origin_execution_generation_id IS NULL
            OR e.execution_generation_id=b.origin_execution_generation_id)
          AND e.state IN ('prepared','executing')
      )
      -- A room-move cancellation is compensating state, not disposable
      -- history, until that exact durable move reaches active or failed. The
      -- event key binds the row to its operation without parsing ids.
      AND NOT EXISTS (
        SELECT 1 FROM agent_room_moves m
        JOIN supervised_agent_inbox_events ev
          ON ev.inbox_item_id=i.inbox_item_id
         AND ev.idempotency_key=('room_move_cancelled:' || m.operation_id || ':' || i.fifo_sequence)
        WHERE m.agent_id=i.agent_id AND m.source_room_id=i.room_id
          AND m.phase NOT IN ('active','failed')
      )
    ORDER BY i.fifo_sequence DESC LIMIT -1 OFFSET ?`).all(agentId, retainedUnpinnedReceipts) as Row[];
  const deleteEffects = database.prepare(`DELETE FROM supervised_agent_effects
    WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
      AND state IN ('uncertain','completed','failed')`);
  const deleteEffectTombstones = database.prepare(`DELETE FROM supervised_agent_effect_tombstones
    WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?`);
  const deleteInbox = database.prepare("DELETE FROM supervised_agent_inbox WHERE inbox_item_id=?");
  const prunedByRoom = new Map<string, string>();
  for (const row of stale) {
    if (!prunedByRoom.has(String(row.room_id))) {
      prunedByRoom.set(String(row.room_id), String(row.source_message_id));
    }
    run(database.prepare(`INSERT INTO supervised_agent_pruned_sources
      (agent_id,room_id,source_message_id,pruned_at) VALUES (?,?,?,?)
      ON CONFLICT(agent_id,room_id,source_message_id) DO NOTHING`),
    agentId, String(row.room_id), String(row.source_message_id), now());
    if (row.provider_turn_id !== null && row.origin_execution_generation_id !== null) {
      run(deleteEffects, agentId, String(row.origin_execution_generation_id), String(row.provider_turn_id));
      run(deleteEffectTombstones, agentId, String(row.origin_execution_generation_id), String(row.provider_turn_id));
    }
    run(deleteInbox, String(row.inbox_item_id));
  }
  const observedStale = database.prepare(`SELECT room_id,source_message_id
    FROM supervised_agent_observed_messages
    WHERE agent_id=? AND rowid NOT IN (
      SELECT rowid FROM supervised_agent_observed_messages
      WHERE agent_id=? ORDER BY rowid DESC LIMIT ?
    ) ORDER BY rowid DESC`).all(agentId, agentId, RETAINED_OBSERVED_MESSAGES_PER_AGENT) as Row[];
  run(database.prepare(`DELETE FROM supervised_agent_observed_messages
    WHERE agent_id=? AND rowid NOT IN (
      SELECT rowid FROM supervised_agent_observed_messages
      WHERE agent_id=? ORDER BY rowid DESC LIMIT ?
    )`), agentId, agentId, RETAINED_OBSERVED_MESSAGES_PER_AGENT);
  const rooms = database.prepare(`SELECT DISTINCT room_id FROM supervised_agent_inbox WHERE agent_id=?
    UNION SELECT DISTINCT room_id FROM supervised_agent_observed_messages WHERE agent_id=?`)
    .all(agentId, agentId) as Row[];
  for (const row of observedStale) {
    if (!prunedByRoom.has(String(row.room_id))) {
      prunedByRoom.set(String(row.room_id), String(row.source_message_id));
    }
  }
  for (const room of rooms) {
    updateHistoryBoundary(database, agentId, String(room.room_id), prunedByRoom.get(String(room.room_id)) ?? null, now);
  }
  for (const [roomId, marker] of prunedByRoom) {
    if (!rooms.some((room) => String(room.room_id) === roomId)) {
      updateHistoryBoundary(database, agentId, roomId, marker, now);
    }
  }
  run(database.prepare(`DELETE FROM supervised_agent_pruned_sources
    WHERE agent_id=? AND rowid NOT IN (
      SELECT rowid FROM supervised_agent_pruned_sources
      WHERE agent_id=? ORDER BY rowid DESC LIMIT ?
    )`), agentId, agentId, RETAINED_PRUNED_SOURCE_EVIDENCE_PER_AGENT);
}

function updateHistoryBoundary(
  database: DatabaseSync,
  agentId: string,
  roomId: string,
  prunedMarker: string | null,
  now: () => string,
): void {
  const observed = database.prepare(`SELECT source_message_id
    FROM supervised_agent_observed_messages WHERE agent_id=? AND room_id=? ORDER BY rowid LIMIT 1`)
    .get(agentId, roomId) as Row | undefined;
  const inbox = database.prepare(`SELECT source_message_id,fifo_sequence
    FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? ORDER BY fifo_sequence LIMIT 1`)
    .get(agentId, roomId) as Row | undefined;
  const prior = database.prepare(`SELECT pruned_before_message_id,pruned_at
    FROM supervised_agent_history_boundaries WHERE agent_id=? AND room_id=?`)
    .get(agentId, roomId) as Row | undefined;
  run(database.prepare(`INSERT INTO supervised_agent_history_boundaries
    (agent_id,room_id,earliest_retained_observed_message_id,earliest_retained_inbox_message_id,
     earliest_retained_receipt_sequence,pruned_before_message_id,pruned_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,room_id) DO UPDATE SET
      earliest_retained_observed_message_id=excluded.earliest_retained_observed_message_id,
      earliest_retained_inbox_message_id=excluded.earliest_retained_inbox_message_id,
      earliest_retained_receipt_sequence=excluded.earliest_retained_receipt_sequence,
      pruned_before_message_id=COALESCE(excluded.pruned_before_message_id,supervised_agent_history_boundaries.pruned_before_message_id),
      pruned_at=COALESCE(excluded.pruned_at,supervised_agent_history_boundaries.pruned_at),
      updated_at=excluded.updated_at`),
  agentId, roomId, observed ? String(observed.source_message_id) : null,
  inbox ? String(inbox.source_message_id) : null,
  inbox ? Number(inbox.fifo_sequence) : null,
  prunedMarker ?? (prior?.pruned_before_message_id ?? null),
  prunedMarker ? now() : (prior?.pruned_at ?? null), now());
}
