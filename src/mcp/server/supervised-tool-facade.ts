import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import { runWithCurrentSupervisedRoom } from "./runtime/room-state.js";
import {
  completeCurrentSupervisedEffect,
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

function instruction(text: string, data: Record<string, unknown> = {}): CallToolResult {
  const payload = { ...data, instruction: text };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Preserve the complete public tool schemas while replacing supervised tool
 * execution with an exact-turn daemon fence and durable effect journal.
 * Engine mechanics are not registered, so they are absent from discovery.
 */
export interface SupervisedToolFacadeDependencies {
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
  if (profile !== "supervised_room_turn") return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "tool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, ...registration: unknown[]) => {
        const callback = registration.at(-1);
        if (typeof callback !== "function") throw new Error(`Tool ${name} has no callback.`);
        const wrapped = async (...call: unknown[]): Promise<CallToolResult> => {
          const extra = (call.at(-1) ?? {}) as { requestId?: string | number };
          const input = call.length > 1 ? call[0] : {};
          if (extra.requestId === undefined || extra.requestId === null || String(extra.requestId).trim() === "") {
            throw new Error(`Supervised tool ${name} is missing its MCP request id; refusing an effect that cannot be deduplicated safely.`);
          }
          const prepared = await dependencies.prepareEffect({
            toolName: name,
            input,
            mcpRequestId: String(extra.requestId),
            mutation: !READ_TOOLS.has(name),
          });
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
            await dependencies.completeEffect({ effectId: prepared.effectId, result });
            return result;
          });
        };
        return (target.tool as (...args: unknown[]) => unknown).call(target, name, ...registration.slice(0, -1), wrapped);
      };
    },
  }) as McpServer;
}
