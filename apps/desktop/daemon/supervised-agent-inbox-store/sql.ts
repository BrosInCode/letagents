import type { StatementSync } from "node:sqlite";

export function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }

/** A pending row exactly as ingested: no dispatch, retry, block, binding or turn-control history. Alias `i`. */
export const UNTOUCHED_PENDING_SQL = `(i.state='pending' AND i.attempt_count=0 AND i.provider_turn_id IS NULL
  AND i.outcome IS NULL AND i.last_error IS NULL AND i.failure_code IS NULL AND i.blocked_by_inbox_item_id IS NULL
  AND i.next_attempt_at_ms IS NULL AND i.terminal_reason IS NULL
  AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e WHERE e.inbox_item_id=i.inbox_item_id
    AND e.idempotency_key NOT IN ('received:0','queued:0','queued:person_first') AND e.idempotency_key NOT GLOB 'passed:*'
    AND e.idempotency_key NOT GLOB 'peer_batch_assigned:*')
  AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b WHERE b.inbox_item_id=i.inbox_item_id)
  AND NOT EXISTS (SELECT 1 FROM turn_control_journals j WHERE j.inbox_item_id=i.inbox_item_id))`;
/**
 * A follow-up that was made blocked and has not been touched since: no claim, retry, dispatch, turn or turn control.
 * Nothing was ever sent to a provider for it, so no native work can be running for it. Alias `i`.
 */
export const UNTOUCHED_BLOCKED_FOLLOW_UP_SQL = `(i.state='blocked' AND i.source_message_id GLOB 'task-continuation:*' AND i.attempt_count=0
  AND i.provider_turn_id IS NULL AND i.outcome IS NULL
  AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e WHERE e.inbox_item_id=i.inbox_item_id
    AND e.idempotency_key NOT IN ('received:0','queued:0','task-continuation:0'))
  AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b WHERE b.inbox_item_id=i.inbox_item_id)
  AND NOT EXISTS (SELECT 1 FROM turn_control_journals j WHERE j.inbox_item_id=i.inbox_item_id))`;
export const RECEIPT_METADATA_COLUMNS = "i.inbox_item_id,i.agent_id,i.room_id,i.source_message_id,i.fifo_sequence,i.state,i.attempt_count,i.action_id,i.reply_client_message_id,i.provider_turn_id,i.outcome,i.last_error,i.failure_code,i.blocked_by_inbox_item_id,i.next_attempt_at_ms,i.terminal_reason,i.created_at,i.updated_at,i.acknowledged_at";
export const RECEIPT_SELECTION_SQL = `FROM supervised_agent_inbox i
        LEFT JOIN supervised_agent_publications p ON p.inbox_item_id=i.inbox_item_id
        WHERE i.agent_id=? AND (
          i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
          OR i.inbox_item_id IN (
            SELECT inbox_item_id FROM supervised_agent_inbox
            WHERE agent_id=? AND state IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
            ORDER BY fifo_sequence DESC LIMIT ?
          )
        ) ORDER BY i.fifo_sequence`;
export const INBOX_READS = {
  receipts: `SELECT i.*,p.canonical_message_id ${RECEIPT_SELECTION_SQL}`,
  // What a follow-up that waits for its time is for. It is read from the saved follow-up and from no other row,
  // so that the payload of an ordinary message is still never read here.
  receiptProjection: `SELECT ${RECEIPT_METADATA_COLUMNS},p.canonical_message_id,
    CASE WHEN i.state='pending' AND i.next_attempt_at_ms IS NOT NULL AND i.source_message_id GLOB 'task-continuation:*' AND json_valid(i.activation_json)
      THEN json_extract(i.activation_json,'$.task_continuity.kind') END AS follow_up_kind ${RECEIPT_SELECTION_SQL}`,
  receiptTimelines: `WITH selected_inbox AS (
          SELECT inbox_item_id,fifo_sequence
          FROM supervised_agent_inbox
          WHERE agent_id=? AND (
            state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
            OR inbox_item_id IN (
              SELECT inbox_item_id FROM supervised_agent_inbox
              WHERE agent_id=? AND state IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
              ORDER BY fifo_sequence DESC LIMIT ?
            )
          )
        )
        SELECT e.inbox_item_id,e.event_sequence,e.phase,e.observed_at,e.detail
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
        ORDER BY s.fifo_sequence,e.event_sequence`,
  ingressHealth: "SELECT room_id,state,detail,execution_generation_id FROM supervised_agent_ingress_health WHERE agent_id=?",
  ingressCursor: "SELECT room_id,last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=?",
  latestRepair: "SELECT * FROM provider_continuation_repairs WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
  dataVersion: "PRAGMA data_version",
  schemaVersion: "PRAGMA schema_version",
  totalChanges: "SELECT total_changes() AS value",
} as const;
