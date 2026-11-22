import { validReplyGifIntent } from "../../../../shared/room-expressions.mjs";
import { validRecordedReplyAttachments } from "../../../../shared/message-attachments.mjs";
import { randomUUID } from "node:crypto";
import { SUPERVISED_READ_ONLY_TOOLS } from "../../../../shared/supervised-read-tools.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  BOUNDED_MCP_EFFECT_KIND,
  BOUNDED_MCP_MAX_READ_ATTEMPTS,
  boundedMcpEffectIdempotencyKey,
  completePreparedEffectAtomicallyInTransaction,
  rowToBoundedMcpEffect,
  serializeBoundedMcpPayload,
  type EffectRecord,
} from "../effect-journal/index.js";
import { pendingRuntimeRecovery } from "../runtime-recovery-journal.js";
import type { SupervisedInboxItem, SupervisedEffectRecord, Row } from "./types.js";
import { structuredRoomTurnCompletion, structuredRoomTurnCompletionResult } from "./turn-completion.js";
import { run } from "./sql.js";
import { rowToItem } from "./row-mapping.js";
import {
  EffectAuthorityError,
  MAX_EFFECTS_PER_PROVIDER_TURN,
  MAX_UNRESOLVED_EFFECTS_PER_AGENT,
  MAX_EFFECT_REQUEST_BYTES,
  MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN,
  MAX_EFFECT_RESULT_BYTES,
  MAX_EFFECT_RESULT_BYTES_PER_PROVIDER_TURN,
  serializeEffectJson,
  effectRequestFingerprint,
  truncateEffectError,
  rowToEffect,
  rowToTombstonedEffect,
} from "./effect-values.js";
import { InboxQueryStore } from "./queries.js";

function normalizeEffectEpoch(daemonGeneration?: number): number {
  return typeof daemonGeneration === "number" && Number.isSafeInteger(daemonGeneration) && daemonGeneration >= 1
    ? daemonGeneration
    : 1;
}

export abstract class InboxEffectStore extends InboxQueryStore {
  async prepareEffect(input: {
    agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
    mcp_request_id: string; tool_name: string; request: unknown; mutation?: boolean;
    daemon_generation?: number;
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
    const requestSha256 = effectRequestFingerprint(requestJson);
    const idempotencyKey = boundedMcpEffectIdempotencyKey(
      input.execution_generation_id,
      input.provider_turn_id,
      input.mcp_request_id,
    );
    const { payloadJson } = serializeBoundedMcpPayload({
      room_id: input.room_id,
      execution_generation_id: input.execution_generation_id,
      provider_turn_id: input.provider_turn_id,
      mcp_request_id: input.mcp_request_id,
      tool_name: input.tool_name,
      request: input.request,
      requestJson,
      mutation: expectedMutation,
    });
    const epoch = normalizeEffectEpoch(input.daemon_generation);

    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const existing = database.prepare(`SELECT * FROM effects
        WHERE agent_id=? AND kind=? AND idempotency_key=?`).get(
        input.agent_id, BOUNDED_MCP_EFFECT_KIND, idempotencyKey,
      ) as Row | undefined;
      if (existing) {
        const existingView = rowToBoundedMcpEffect(existing);
        const effect = rowToEffect(existing);
        if (effect.room_id !== input.room_id || effect.tool_name !== input.tool_name
          || effect.mutation !== expectedMutation || existingView.request_sha256 !== requestSha256) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        if (effect.state === "completed" || effect.state === "failed" || effect.state === "uncertain") return { created: false, effect };
        this.assertActiveEffectAuthority(database, input);
        if (effect.tool_name === "complete_room_turn") {
          const completion = structuredRoomTurnCompletion(input.request);
          if (!completion) throw new Error("The supervised room-turn completion proposal is malformed.");
          const executing = database.prepare(`SELECT id FROM effects
            WHERE agent_id=? AND kind=?
              AND json_extract(payload,'$.execution_generation_id')=?
              AND json_extract(payload,'$.provider_turn_id')=?
              AND json_extract(payload,'$.tool_name')<>'complete_room_turn'
              AND state='executing' AND json_extract(payload,'$.mutation')=1 LIMIT 1`).get(
            input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
          );
          if (executing) {
            throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
          }
          completePreparedEffectAtomicallyInTransaction(database, {
            id: effect.effect_id,
            outcomeJson: serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result"),
            updatedAt: this.now(),
            minEpoch: epoch,
          });
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effect.effect_id) as Row) };
        }
        if (effect.state === "executing") {
          const timestamp = this.now();
          const canResetToPrepared = (!effect.mutation || effect.tool_name === "complete_room_turn")
            && Number(existing.retryable) === 1
            && Number(existing.attempt_count) < Number(existing.max_attempts);
          if (!canResetToPrepared) {
            run(database.prepare(`UPDATE effects
              SET state='uncertain',last_error=?,next_attempt_at_ms=NULL,updated_at=? WHERE id=? AND state='executing'`),
            "The mutating tool crossed its execution boundary without a durable result. It may have completed; verify external state before repeating it.", timestamp, effect.effect_id);
            this.pruneAgentHistory(database, effect.agent_id, effect.effect_id);
          } else {
            run(database.prepare(`UPDATE effects
              SET state='prepared',outcome=NULL,last_error=?,next_attempt_at_ms=NULL,updated_at=? WHERE id=? AND state='executing'`),
            effect.tool_name === "complete_room_turn"
              ? "Room delivery restarted while committing the local completion proposal; its durable request is safe to commit again."
              : "The prior read-only execution ended without a durable result and is safe to execute again.", timestamp, effect.effect_id);
          }
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effect.effect_id) as Row) };
        }
        return { created: false, effect };
      }
      const tombstone = database.prepare(`SELECT * FROM effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND mcp_request_id=?`).get(
        input.agent_id, input.execution_generation_id, input.provider_turn_id, input.mcp_request_id,
      ) as Row | undefined;
      if (tombstone) {
        const effect = rowToTombstonedEffect(tombstone);
        if (effect.room_id !== input.room_id || effect.tool_name !== input.tool_name
          || effect.mutation !== expectedMutation
          || String(tombstone.request_sha256) !== requestSha256) {
          throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
        }
        return { created: false, effect };
      }
      const completedTurn = database.prepare(`SELECT id FROM effects
        WHERE agent_id=? AND kind=?
          AND json_extract(payload,'$.execution_generation_id')=?
          AND json_extract(payload,'$.provider_turn_id')=?
          AND json_extract(payload,'$.tool_name')='complete_room_turn'
          AND state='completed' LIMIT 1`).get(
        input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
      ) as Row | undefined;
      if (completedTurn && input.tool_name !== "complete_room_turn") {
        throw new Error("The supervised room turn is already complete; no new effects may be admitted.");
      }
      if (input.tool_name === "complete_room_turn") {
        const completion = structuredRoomTurnCompletion(input.request);
        if (!completion) throw new Error("The supervised room-turn completion proposal is malformed.");
        const completedResultJson = serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result");
        const singleton = database.prepare(`SELECT * FROM effects
          WHERE agent_id=? AND kind=?
            AND json_extract(payload,'$.execution_generation_id')=?
            AND json_extract(payload,'$.provider_turn_id')=?
            AND json_extract(payload,'$.tool_name')='complete_room_turn'
          ORDER BY created_at,id LIMIT 1`).get(
          input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
        ) as Row | undefined;
        if (singleton) {
          const singletonView = rowToBoundedMcpEffect(singleton);
          const effect = rowToEffect(singleton);
          if (effect.room_id !== input.room_id || effect.mutation !== expectedMutation
            || singletonView.request_sha256 !== requestSha256) {
            throw new Error("The supervised room turn already recorded a different completion proposal.");
          }
          if (effect.state !== "completed") {
            const executing = database.prepare(`SELECT id FROM effects
              WHERE agent_id=? AND kind=?
                AND json_extract(payload,'$.execution_generation_id')=?
                AND json_extract(payload,'$.provider_turn_id')=?
                AND json_extract(payload,'$.tool_name')<>'complete_room_turn'
                AND state='executing' AND json_extract(payload,'$.mutation')=1 LIMIT 1`).get(
              input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
            );
            if (executing) {
              throw new Error("The supervised room turn cannot complete while an earlier effect is still executing.");
            }
          }
          this.assertActiveEffectAuthority(database, input);
          if (effect.state === "prepared" || effect.state === "executing") {
            completePreparedEffectAtomicallyInTransaction(database, {
              id: effect.effect_id,
              outcomeJson: completedResultJson,
              updatedAt: this.now(),
              minEpoch: epoch,
            });
          }
          return { created: false, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effect.effect_id) as Row) };
        }
        const executing = database.prepare(`SELECT id FROM effects
          WHERE agent_id=? AND kind=?
            AND json_extract(payload,'$.execution_generation_id')=?
            AND json_extract(payload,'$.provider_turn_id')=?
            AND json_extract(payload,'$.tool_name')<>'complete_room_turn'
            AND state='executing' AND json_extract(payload,'$.mutation')=1 LIMIT 1`).get(
          input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
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
        const source = database.prepare(`SELECT i.source_message_id FROM inbox_items i
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
        run(database.prepare(`INSERT INTO effects
          (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
          VALUES (?,?,?,?,?,'completed',?,?,0,1,1,NULL,NULL,?,?)`),
        effectId, input.agent_id, BOUNDED_MCP_EFFECT_KIND, idempotencyKey, epoch, payloadJson, result, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effectId) as Row) };
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
        run(database.prepare(`INSERT INTO effects
          (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
          VALUES (?,?,?,?,?,'completed',?,?,0,1,1,NULL,NULL,?,?)`),
        effectId, input.agent_id, BOUNDED_MCP_EFFECT_KIND, idempotencyKey, epoch, payloadJson, result, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effectId) as Row) };
      }
      if (input.tool_name === "complete_room_turn") {
        const completion = structuredRoomTurnCompletion(input.request)!;
        const completedResultJson = serializeEffectJson(structuredRoomTurnCompletionResult(completion), "result");
        run(database.prepare(`INSERT INTO effects
          (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
          VALUES (?,?,?,?,?,'completed',?,?,0,1,1,NULL,NULL,?,?)`),
        effectId, input.agent_id, BOUNDED_MCP_EFFECT_KIND, idempotencyKey, epoch, payloadJson, completedResultJson, timestamp, timestamp);
        return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effectId) as Row) };
      }
      this.assertEffectAdmissionCapacity(database, input, requestJson);
      const retryable = expectedMutation ? 0 : 1;
      const maxAttempts = expectedMutation ? 1 : BOUNDED_MCP_MAX_READ_ATTEMPTS;
      run(database.prepare(`INSERT INTO effects
        (id,agent_id,kind,idempotency_key,epoch,state,payload,outcome,retryable,attempt_count,max_attempts,next_attempt_at_ms,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,'prepared',?,NULL,?,0,?,NULL,NULL,?,?)`),
      effectId, input.agent_id, BOUNDED_MCP_EFFECT_KIND, idempotencyKey, epoch, payloadJson, retryable, maxAttempts, timestamp, timestamp);
      return { created: true, effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(effectId) as Row) };
    }, commitFence));
  }

  /**
   * Domain authority guard evaluated inside `EffectExecutor`'s atomic
   * `claimEffectForExecution` transaction right before transitioning a
   * `bounded_mcp_effect` row from `prepared` to `executing`.
   */
  authorizeBoundedEffectClaimInTransaction(
    database: DatabaseSync,
    effectRecord: EffectRecord,
    input: {
      agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
      work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
    },
  ): string | null {
    const payload = effectRecord.payload as {
      room_id?: unknown;
      execution_generation_id?: unknown;
      provider_turn_id?: unknown;
      tool_name?: unknown;
    };
    if (effectRecord.agent_id !== input.agent_id
      || String(payload.room_id ?? "") !== input.room_id
      || String(payload.execution_generation_id ?? "") !== input.execution_generation_id
      || String(payload.provider_turn_id ?? "") !== input.provider_turn_id) {
      return "The supervised effect does not belong to the exact active turn.";
    }
    if (String(payload.tool_name ?? "") !== "complete_room_turn") {
      const completedTurn = database.prepare(`SELECT id FROM effects
        WHERE agent_id=? AND kind=?
          AND json_extract(payload,'$.execution_generation_id')=?
          AND json_extract(payload,'$.provider_turn_id')=?
          AND json_extract(payload,'$.tool_name')='complete_room_turn'
          AND state='completed' LIMIT 1`).get(
        input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
      );
      if (completedTurn) {
        return "The supervised room turn is already complete; this prepared effect may no longer execute.";
      }
    }
    try {
      this.assertActiveEffectAuthority(database, input);
    } catch (error) {
      if (error instanceof EffectAuthorityError) return error.message;
      throw error;
    }
    return null;
  }

  async markEffectExecuting(input: {
    effect_id: string; agent_id: string; room_id: string; execution_generation_id: string; provider_turn_id: string;
    work_attempt_id: string; current_execution_generation_id: string; provider_continuation_id: string;
    daemon_generation?: number;
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<SupervisedEffectRecord> {
    const epoch = normalizeEffectEpoch(input.daemon_generation);
    const admitted = await this.exclusive(async (database) => this.transactionFenced(database, () => {
      const row = database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row | undefined;
      if (!row) {
        const tombstone = database.prepare("SELECT * FROM effect_tombstones WHERE effect_id=?").get(input.effect_id) as Row | undefined;
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
        const completedTurn = database.prepare(`SELECT id FROM effects
          WHERE agent_id=? AND kind=?
            AND json_extract(payload,'$.execution_generation_id')=?
            AND json_extract(payload,'$.provider_turn_id')=?
            AND json_extract(payload,'$.tool_name')='complete_room_turn'
            AND state='completed' LIMIT 1`).get(
          effect.agent_id, BOUNDED_MCP_EFFECT_KIND, effect.execution_generation_id, effect.provider_turn_id,
        );
        if (completedTurn) {
          const rejection = "The supervised room turn is already complete; this prepared effect may no longer execute.";
          run(database.prepare("UPDATE effects SET state='failed',last_error=?,next_attempt_at_ms=NULL,updated_at=? WHERE id=? AND state='prepared'"),
            rejection, this.now(), input.effect_id);
          return {
            effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row),
            rejection,
          };
        }
      }
      try {
        this.assertActiveEffectAuthority(database, input);
      } catch (error) {
        if (!(error instanceof EffectAuthorityError)) throw error;
        const rejection = error.message;
        run(database.prepare("UPDATE effects SET state='failed',last_error=?,next_attempt_at_ms=NULL,updated_at=? WHERE id=? AND state='prepared'"),
          rejection, this.now(), input.effect_id);
        return {
          effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row),
          rejection,
        };
      }
      if (Number(row.attempt_count) >= Number(row.max_attempts)) {
        const rejection = "The supervised effect has exhausted its retry budget.";
        run(database.prepare("UPDATE effects SET state='failed',last_error=?,next_attempt_at_ms=NULL,updated_at=? WHERE id=? AND state='prepared'"),
          rejection, this.now(), input.effect_id);
        return {
          effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row),
          rejection,
        };
      }
      const nextEpoch = Math.max(Number(row.epoch), epoch);
      run(database.prepare(`UPDATE effects
        SET state='executing',epoch=?,attempt_count=attempt_count+1,next_attempt_at_ms=NULL,updated_at=?
        WHERE id=? AND state='prepared'`), nextEpoch, this.now(), input.effect_id);
      return {
        effect: rowToEffect(database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row),
        rejection: null,
      };
    }, commitFence));
    if (admitted.rejection) throw new EffectAuthorityError(admitted.rejection);
    return admitted.effect;
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
      const rows = database.prepare(`SELECT * FROM effects
        WHERE agent_id=? AND kind=?
          AND json_extract(payload,'$.execution_generation_id')=?
          AND json_extract(payload,'$.provider_turn_id')=?
          AND json_extract(payload,'$.tool_name')='complete_room_turn'
        ORDER BY created_at,id`).all(
        agentId,
        BOUNDED_MCP_EFFECT_KIND,
        originExecutionGenerationId,
        providerTurnId,
      ) as Row[];
      return rows.map(rowToEffect);
    });
  }

  async inboxForProviderTurn(agentId: string, providerTurnId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => {
      const row = database.prepare(`SELECT * FROM inbox_items
        WHERE agent_id=? AND provider_turn_id=? ORDER BY fifo_sequence LIMIT 1`).get(agentId, providerTurnId) as Row | undefined;
      return row ? rowToItem(row) : null;
    });
  }

  async completeEffect(input: {
    effect_id: string; result?: unknown; error?: string; uncertain?: boolean;
    expected?: { agent_id: string; work_attempt_id: string; provider_turn_id?: string | null };
  }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<SupervisedEffectRecord> {
    return this.exclusive(async (database) => this.transactionFenced(database, () => {
      const row = database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row | undefined;
      const tombstone = row ? undefined
        : database.prepare("SELECT * FROM effect_tombstones WHERE effect_id=?").get(input.effect_id) as Row | undefined;
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
      if (input.uncertain) {
        if (effect.state === "uncertain") {
          this.pruneAgentHistory(database, effect.agent_id, effect.effect_id);
          return effect;
        }
        if (effect.state !== "executing") {
          throw new Error("A supervised effect must be executing before marking uncertain.");
        }
        const error = truncateEffectError(
          input.error ?? "The mutating tool crossed its execution boundary without a durable result. It may have completed; verify external state before repeating it.",
        );
        run(database.prepare(`UPDATE effects
          SET state='uncertain',outcome=NULL,last_error=?,next_attempt_at_ms=NULL,updated_at=?
          WHERE id=? AND state='executing'`), error, this.now(), input.effect_id);
        const uncertainRow = database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row;
        const uncertain = rowToEffect(uncertainRow);
        this.pruneAgentHistory(database, effect.agent_id, effect.effect_id);
        return uncertain;
      }
      if (effect.state !== "executing" && effect.state !== "uncertain" && effect.tool_name !== "join_room") {
        throw new Error("A supervised effect must be executing or uncertain before completion.");
      }
      const failed = Boolean(input.error);
      const resultJson = input.result === undefined
        ? null
        : this.boundedCompletionResultJson(database, effect, input.result);
      const error = input.error ? truncateEffectError(input.error) : null;
      const updatedAt = this.now();
      if (tombstone) {
        run(database.prepare("UPDATE effect_tombstones SET state=?,result_json=?,error=?,updated_at=? WHERE effect_id=?"),
          failed ? "failed" : "completed", resultJson, error, updatedAt, input.effect_id);
        const completedRow = database.prepare("SELECT * FROM effect_tombstones WHERE effect_id=?").get(input.effect_id) as Row;
        const completed = rowToTombstonedEffect(completedRow);
        this.pruneAgentHistory(database, effect.agent_id);
        return completed;
      }
      if (!failed && effect.state === "prepared") {
        completePreparedEffectAtomicallyInTransaction(database, {
          id: input.effect_id,
          outcomeJson: resultJson,
          updatedAt,
        });
      } else {
        run(database.prepare(`UPDATE effects
          SET state=?,outcome=?,last_error=?,next_attempt_at_ms=NULL,updated_at=?
          WHERE id=?`),
        failed ? "failed" : "completed", resultJson, error, updatedAt, input.effect_id);
      }
      const completedRow = database.prepare("SELECT * FROM effects WHERE id=?").get(input.effect_id) as Row;
      const completed = rowToEffect(completedRow);
      this.pruneAgentHistory(database, effect.agent_id);
      return completed;
    }, commitFence));
  }

  /** Prunes bounded history for agents whose effects were marked `uncertain` during startup recovery. */
  async pruneAgentsAfterEffectRecovery(agentIds: readonly string[]): Promise<void> {
    if (agentIds.length === 0) return;
    await this.exclusive(async (database) => this.transaction(database, () => {
      for (const agentId of new Set(agentIds)) {
        this.pruneAgentHistory(database, agentId);
      }
    }));
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
        SELECT CAST(json_extract(payload,'$.request_bytes') AS INTEGER) AS request_bytes
        FROM effects
        WHERE agent_id=? AND kind=?
          AND json_extract(payload,'$.execution_generation_id')=?
          AND json_extract(payload,'$.provider_turn_id')=?
        UNION ALL
        SELECT request_bytes FROM effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
      )`).get(
      input.agent_id, BOUNDED_MCP_EFFECT_KIND, input.execution_generation_id, input.provider_turn_id,
      input.agent_id, input.execution_generation_id, input.provider_turn_id,
    ) as Row;
    if (Number(usage.effect_count) >= MAX_EFFECTS_PER_PROVIDER_TURN) {
      throw new Error(`A supervised provider turn may durably admit at most ${MAX_EFFECTS_PER_PROVIDER_TURN} effects.`);
    }
    if (Number(usage.request_bytes) + requestBytes > MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN) {
      throw new Error(`A supervised provider turn exceeds the ${MAX_EFFECT_REQUEST_BYTES_PER_PROVIDER_TURN}-byte durable request budget.`);
    }
    const unresolved = database.prepare(`SELECT COUNT(*) AS effect_count FROM effects
      WHERE agent_id=? AND kind=? AND state IN ('prepared','executing')`).get(input.agent_id, BOUNDED_MCP_EFFECT_KIND) as Row;
    if (Number(unresolved.effect_count) >= MAX_UNRESOLVED_EFFECTS_PER_AGENT) {
      throw new Error(`A supervised agent may retain at most ${MAX_UNRESOLVED_EFFECTS_PER_AGENT} unresolved effects across turns.`);
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
        SELECT length(CAST(outcome AS BLOB)) AS result_bytes FROM effects
        WHERE agent_id=? AND kind=?
          AND json_extract(payload,'$.execution_generation_id')=?
          AND json_extract(payload,'$.provider_turn_id')=?
          AND id<>?
        UNION ALL
        SELECT length(CAST(result_json AS BLOB)) AS result_bytes FROM effect_tombstones
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND effect_id<>?
      )`).get(
      effect.agent_id, BOUNDED_MCP_EFFECT_KIND, effect.execution_generation_id, effect.provider_turn_id, effect.effect_id,
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
      JOIN inbox_items i ON i.inbox_item_id=b.inbox_item_id
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
    const head = database.prepare(`SELECT inbox_item_id FROM inbox_items
      WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
      ORDER BY fifo_sequence LIMIT 1`).get(input.agent_id) as Row | undefined;
    if (!head || String(head.inbox_item_id) !== String(rows[0]?.inbox_item_id)) {
      throw new EffectAuthorityError("The supervised effect provider turn is no longer the exact FIFO head.");
    }
    const runtime = database.prepare(`SELECT room_id,desired_state,work_attempt_id,
        provider_work_attempt_id,provider_continuation_id,provider_execution_generation_id,condition
      FROM agents WHERE agent_id=?`).get(input.agent_id) as Row | undefined;
    if (pendingRuntimeRecovery(database, input.agent_id) || !runtime || String(runtime.room_id) !== input.room_id || String(runtime.desired_state) !== "running"
      || String(runtime.condition) !== "none" || runtime.work_attempt_id === null
      || String(runtime.work_attempt_id) !== input.work_attempt_id || runtime.provider_work_attempt_id === null
      || String(runtime.provider_work_attempt_id) !== input.work_attempt_id
      || String(runtime.provider_continuation_id) !== input.provider_continuation_id
      || String(runtime.provider_execution_generation_id) !== input.current_execution_generation_id) {
      throw new EffectAuthorityError("The supervised effect lost its exact current runtime authority.");
    }
    if (database.prepare(`SELECT 1 FROM agents
      WHERE agent_id=? AND turn_control_status IN ('prepared','dispatching','retryable','uncertain') LIMIT 1`)
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
      BOUNDED_MCP_EFFECT_KIND,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE effects
      SET state='prepared',outcome=NULL,last_error=?,next_attempt_at_ms=NULL,updated_at=?
      WHERE kind=? AND state='executing' AND retryable=1 AND attempt_count<max_attempts
        AND json_extract(payload,'$.tool_name') NOT IN ('join_room','complete_room_turn')${scope}`), ...readArgs);
    const completionArgs = [
      "Room delivery restarted while committing the local completion proposal; its durable request is safe to commit again.",
      interruptedAt,
      BOUNDED_MCP_EFFECT_KIND,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE effects
      SET state='prepared',outcome=NULL,last_error=?,next_attempt_at_ms=NULL,updated_at=?
      WHERE kind=? AND state='executing' AND retryable=1 AND attempt_count<max_attempts
        AND json_extract(payload,'$.tool_name')='complete_room_turn'${scope}`), ...completionArgs);
    const mutationArgs = [
      "Room delivery restarted after this mutating tool crossed its execution boundary. It may have completed; verify external state before repeating it.",
      interruptedAt,
      BOUNDED_MCP_EFFECT_KIND,
      ...(agentId ? [agentId] : []),
    ];
    run(database.prepare(`UPDATE effects
      SET state='uncertain',last_error=?,next_attempt_at_ms=NULL,updated_at=?
      WHERE kind=? AND state='executing' AND (retryable=0 OR attempt_count>=max_attempts)
        AND json_extract(payload,'$.tool_name')<>'join_room'${scope}`), ...mutationArgs);
  }
}
