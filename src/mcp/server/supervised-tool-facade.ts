import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parsePositivePgIntegerScopedId } from "../../../shared/message-contracts.mjs";

import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import { runWithCurrentSupervisedRoom } from "./runtime/room-state.js";
import {
  completeCurrentSupervisedEffect,
  authorizeCustodialPolling,
  type CustodialPollingAuthorization,
  type CustodialPollingWaitRequest,
  executeCurrentSupervisedTool,
  prepareCurrentSupervisedEffect,
  type PreparedSupervisedEffect,
} from "./runtime/supervisor-bridge.js";

const READ_TOOLS = new Set([
  "get_current_room",
  "check_repo",
  "check_repo_visibility",
  "read_messages",
  "wait_for_messages",
  "get_board",
  "get_board_settings",
  "get_room_artifacts",
  "get_room_events",
  "list_board_intents",
  "get_onboarding_status",
  "status_local_codex_session",
  "rental_list_requests",
]);

export function supervisedToolIsMutation(toolName: string): boolean {
  return !READ_TOOLS.has(toolName);
}

// The desktop daemon's local control protocol intentionally uses small bounded
// frames. A read result can be returned live to the provider without copying
// the entire payload into the durable effect journal.
const MAX_DURABLE_READ_RESULT_BYTES = 16 * 1024;

/** Receipt only the bounded page actually returned by wait, never an API tail
 * beyond that page or a cursor inferred from its last visible message. */
function custodialWaitFrontier(result: CallToolResult, inputCursor: string, roomId: string): string {
  const content = result.content;
  if (result.isError || content.length !== 1 || content[0]?.type !== "text") throw new Error("Custodial wait returned no valid bounded page.");
  let output: Record<string, unknown>;
  try { output = JSON.parse(content[0].text) as Record<string, unknown>; }
  catch { throw new Error("Custodial wait returned no valid bounded page."); }
  if (!output || Array.isArray(output) || !Array.isArray(output.messages)
    || (output.room_id !== undefined && output.room_id !== roomId)) throw new Error("Custodial wait returned no valid bounded page.");
  const noProgress = output.messages.length === 0 && (output.truncated === undefined || output.truncated === false)
    && (output.omitted_message_count === undefined || output.omitted_message_count === 0)
    && (output.skipped_message_count === undefined || output.skipped_message_count === 0)
    && (output.skipped_message_ids === undefined || (Array.isArray(output.skipped_message_ids) && output.skipped_message_ids.length === 0));
  const frontier = output.last_observed_message_id;
  if (frontier === undefined || frontier === null) {
    if (!noProgress) {
      throw new Error("Custodial wait is missing its bounded observed frontier.");
    }
    return inputCursor;
  }
  const number = parsePositivePgIntegerScopedId(frontier, "msg");
  const inputNumber = parsePositivePgIntegerScopedId(inputCursor, "msg");
  if (number === null || inputNumber === null || number < inputNumber || (number === inputNumber && !noProgress)) {
    throw new Error("Custodial wait returned an invalid observed frontier.");
  }
  return String(frontier);
}

function instruction(text: string, data: Record<string, unknown> = {}): CallToolResult {
  const payload = { ...data, instruction: text };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function durableCompletionResult(
  result: CallToolResult,
  mutation: boolean,
): CallToolResult {
  if (mutation) return result;
  const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (serializedBytes <= MAX_DURABLE_READ_RESULT_BYTES) return result;

  return instruction(
    "The read completed, but its large result was returned live instead of being copied into the durable journal. Issue a fresh read request if this exact request is replayed after a restart.",
    {
      code: "SUPERVISED_READ_RESULT_NOT_RETAINED",
      serialized_bytes: serializedBytes,
    },
  );
}

/**
 * Preserve the complete public tool schemas while replacing supervised tool
 * execution with an exact-turn daemon fence and durable effect journal.
 * Engine mechanics are not registered, so they are absent from discovery.
 */
export interface SupervisedToolFacadeDependencies {
  authorizePolling?: (toolName: string, prior?: CustodialPollingAuthorization, wait?: CustodialPollingWaitRequest) => Promise<CustodialPollingAuthorization>;
  executeTool?: (input: {
    toolName: string;
    input: unknown;
    mcpRequestId: string;
  }) => Promise<{ state: "unsupported" } | { state: "completed"; roomId: string; result: unknown }>;
  prepareEffect: (input: {
    toolName: string;
    input: unknown;
    mcpRequestId: string;
    mutation: boolean;
  }) => Promise<PreparedSupervisedEffect>;
  completeEffect: (input: { effectId: string; result?: unknown; error?: string }) => Promise<void>;
  withRoom: <T>(roomId: string, callback: () => T) => T;
}

const productionDependencies: SupervisedToolFacadeDependencies = {
  executeTool: executeCurrentSupervisedTool,
  prepareEffect: prepareCurrentSupervisedEffect,
  completeEffect: completeCurrentSupervisedEffect,
  withRoom: runWithCurrentSupervisedRoom,
};

export function profileAwareToolServer(
  server: McpServer,
  profile: LetAgentsExecutionProfile,
  dependencies: SupervisedToolFacadeDependencies = productionDependencies,
  supervisedProvider: string | null = process.env.LETAGENTS_SUPERVISOR_PROVIDER?.trim() || null,
): McpServer {
  if (profile !== "supervised_room_turn" && profile !== "supervised_mcp_polling") return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "tool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, ...registration: unknown[]) => {
        const mutation = supervisedToolIsMutation(name);
        const callback = registration.at(-1);
        if (typeof callback !== "function") throw new Error(`Tool ${name} has no callback.`);
        const wrapped = async (...call: unknown[]): Promise<CallToolResult> => {
          if (profile === "supervised_mcp_polling") {
            const authorize = dependencies.authorizePolling ?? ((toolName, prior, wait) => authorizeCustodialPolling(toolName, prior, process.env, {}, wait));
            const input = call[0] as Record<string, unknown> | undefined;
            const extra = (call.length > 1 ? call.at(-1) : undefined) as { requestId?: unknown } | undefined;
            let wait: CustodialPollingWaitRequest | undefined;
            if (name === "wait_for_messages") {
              const requestId = extra?.requestId;
              if (!(typeof requestId === "string" || (typeof requestId === "number" && Number.isSafeInteger(requestId)))) {
                throw new Error("Custodial wait is missing its exact MCP request id.");
              }
              if (input?.after_message_id != null && typeof input.after_message_id !== "string") throw new Error("Custodial wait requires a valid requested cursor.");
              if ((input?.room_id != null && typeof input.room_id !== "string")
                || (input?.agent_session_id != null && typeof input.agent_session_id !== "string")) throw new Error("Custodial wait requires valid requested identity.");
              wait = { mcpRequestId: requestId, roomCursor: input?.after_message_id as string | null | undefined ?? null,
                ...(typeof input?.room_id === "string" ? { requestedRoomId: input.room_id } : {}),
                ...(typeof input?.agent_session_id === "string" ? { requestedAgentSessionId: input.agent_session_id } : {}) };
            }
            const authority = await authorize(name, undefined, wait);
            return dependencies.withRoom(authority.roomId, async () => {
              if (input?.room_id && input.room_id !== authority.roomId) throw new Error("Custodial tool room does not match its exact authority.");
              if (name === "wait_for_messages") {
                if (!authority.roomCursor) throw new Error("Custodial polling has no durable cursor; refusing a tail fallback.");
                call[0] = { ...input, after_message_id: authority.roomCursor };
              }
              const result = await callback(...call) as CallToolResult;
              if (wait) await authorize(name, authority, { ...wait,
                offeredFrontier: custodialWaitFrontier(result, authority.roomCursor!, authority.roomId) });
              else if (name === "read_messages") await authorize(name, authority);
              return result;
            });
          }
          const extra = (call.at(-1) ?? {}) as { requestId?: string | number };
          const input = call.length > 1 ? call[0] : {};
          if (extra.requestId === undefined || extra.requestId === null || String(extra.requestId).trim() === "") {
            throw new Error(`Supervised tool ${name} is missing its MCP request id; refusing an effect that cannot be deduplicated safely.`);
          }
          const executionRequest = {
            toolName: name,
            input,
            mcpRequestId: String(extra.requestId),
          };
          if (dependencies.executeTool) {
            const executed = await dependencies.executeTool(executionRequest);
            if (executed.state === "completed") {
              return dependencies.withRoom(executed.roomId, () => executed.result as CallToolResult);
            }
          }
          const prepared = await dependencies.prepareEffect({ ...executionRequest, mutation });
          return dependencies.withRoom(prepared.roomId, async () => {
            if (prepared.state === "completed") return prepared.result as CallToolResult;
            if (prepared.state === "uncertain") {
              return instruction("This mutating tool may already have completed, but its result was not durably checkpointed. Verify the external state before issuing a new request; this exact request will not be repeated automatically.", {
                code: "SUPERVISED_EFFECT_OUTCOME_UNCERTAIN",
                effect_id: prepared.effectId,
                detail: prepared.error,
              });
            }
            if (prepared.action === "use_final_answer") {
              return instruction(supervisedProvider === "cursor"
                ? "Do not send the activating room reply with a message tool. Keep working, then record the one public answer with complete_room_turn; Cursor's aggregate final text is live evidence only."
                : "Do not send the activating room reply with a message tool. Return it as your final answer; the daemon will publish it exactly once.", {
                code: "USE_FINAL_ANSWER",
                source_message_id: prepared.sourceMessageId,
              });
            }
            if (prepared.action === "room_move_prepared") {
              return instruction(supervisedProvider === "cursor"
                ? "The room move is prepared. Finish the work, then call complete_room_turn with the public response; the daemon will publish that proposal and then move the agent."
                : "The room move is prepared. Finish this turn normally; the daemon will publish the activating response and then move the agent.", {
                code: "ROOM_MOVE_PREPARED",
                destination_room: prepared.destinationRoom,
              });
            }
            let result: CallToolResult;
            try {
              result = await callback(...call) as CallToolResult;
            } catch (error) {
              try {
                await dependencies.completeEffect({ effectId: prepared.effectId, error: error instanceof Error ? error.message : String(error) });
              } catch {
                // Preserve the callback error. An unacknowledged journal entry
                // remains executing, which is safer than repeating the effect.
              }
              throw error;
            }
            // Completion transport is deliberately outside the callback catch.
            // A reporting failure must never relabel a successful action failed.
            await dependencies.completeEffect({
              effectId: prepared.effectId,
              result: durableCompletionResult(result, mutation),
            });
            return result;
          });
        };
        return (target.tool as (...args: unknown[]) => unknown).call(target, name, ...registration.slice(0, -1), wrapped);
      };
    },
  }) as McpServer;
}
