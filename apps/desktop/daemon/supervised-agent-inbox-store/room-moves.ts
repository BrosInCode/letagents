import { randomUUID } from "node:crypto";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import type { SupervisedEffectRecord, Row } from "./types.js";
import { run } from "./sql.js";
import { rowToItem } from "./row-mapping.js";
import { serializeEffectJson, rowToEffect } from "./effect-values.js";
import { InboxEffectStore } from "./effects.js";

export abstract class InboxRoomMoveStore extends InboxEffectStore {
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
}
