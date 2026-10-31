import { validReplyGifIntent } from "../../../../shared/room-expressions.mjs";
import { validRecordedReplyAttachments } from "../../../../shared/message-attachments.mjs";
import { randomUUID } from "node:crypto";
import { SUPERVISED_READ_ONLY_TOOLS } from "../../../../shared/supervised-read-tools.mjs";
import { DatabaseSync } from "node:sqlite";
import { pendingRuntimeRecovery } from "../runtime-recovery-journal.js";
import type { SupervisedInboxItem, SupervisedEffectRecord, Row } from "./types.js";
import { structuredRoomTurnCompletion, structuredRoomTurnCompletionResult } from "./turn-completion.js";
import { run } from "./sql.js";
import { rowToItem } from "./row-mapping.js";
import { EffectAuthorityError, MAX_EFFECTS_PER_PROVIDER_TURN, MAX_UNRESOLVED_EFFECTS_PER_AGENT, MAX_EFFECT_REQUEST_BYTES, MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN, MAX_EFFECT_RESULT_BYTES, MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN, serializeEffectJson, effectRequestFingerprint, truncateEffectError, rowToEffect, rowToTombstonedEffect } from "./effect-values.js";
import { InboxQueryStore } from "./queries.js";

export abstract class InboxEffectStore extends InboxQueryStore {
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
  protected assertEffectAdmissionCapacity(
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
  protected assertEffectResultCapacity(database: DatabaseSync, effect: SupervisedEffectRecord, resultJson: string): void {
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
  protected assertActiveEffectAuthority(database: DatabaseSync, input: {
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
  protected normalizeInterruptedEffectsInTransaction(database: DatabaseSync, agentId: string | undefined, interruptedAt: string): void {
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
