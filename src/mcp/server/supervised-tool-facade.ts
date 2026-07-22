import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import {
  completeCurrentSupervisedEffect,
  prepareCurrentSupervisedEffect,
} from "./runtime/supervisor-bridge.js";

const ENGINE_TOOLS = new Set([
  "wait_for_messages",
  "register_agent_session",
  "renew_agent_session",
  "start_device_auth",
  "poll_device_auth",
  "clear_saved_auth",
  "resume_room_session",
]);

const READ_TOOLS = new Set([
  "get_current_room",
  "read_messages",
  "get_board",
  "get_board_settings",
  "get_room_artifacts",
  "get_onboarding_status",
  "get_repo_visibility",
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
export function profileAwareToolServer(server: McpServer, profile: LetAgentsExecutionProfile): McpServer {
  if (profile !== "supervised_room_turn") return server;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "tool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, ...registration: unknown[]) => {
        if (ENGINE_TOOLS.has(name)) return {};
        const callback = registration.at(-1);
        if (typeof callback !== "function") throw new Error(`Tool ${name} has no callback.`);
        const wrapped = async (...call: unknown[]): Promise<CallToolResult> => {
          const extra = (call.at(-1) ?? {}) as { requestId?: string | number };
          const input = call.length > 1 ? call[0] : {};
          const prepared = await prepareCurrentSupervisedEffect({
            toolName: name,
            input,
            mcpRequestId: String(extra.requestId ?? "missing-request-id"),
            mutation: !READ_TOOLS.has(name),
          });
          if (prepared.state === "completed") return prepared.result as CallToolResult;
          if (prepared.action === "use_final_answer") {
            return instruction("Do not send the activating room reply with a message tool. Return it as your final answer; the daemon will publish it exactly once.", {
              code: "USE_FINAL_ANSWER",
              source_message_id: prepared.sourceMessageId,
            });
          }
          if (prepared.action === "room_move_prepared") {
            return instruction("The room move is prepared. Finish this turn normally; the daemon will publish the activating response and then move the agent.", {
              code: "ROOM_MOVE_PREPARED",
              destination_room: prepared.destinationRoom,
            });
          }
          try {
            const result = await callback(...call) as CallToolResult;
            await completeCurrentSupervisedEffect({ effectId: prepared.effectId, result });
            return result;
          } catch (error) {
            await completeCurrentSupervisedEffect({ effectId: prepared.effectId, error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        };
        return (target.tool as (...args: unknown[]) => unknown).call(target, name, ...registration.slice(0, -1), wrapped);
      };
    },
  }) as McpServer;
}

export const supervisedEngineToolNames = ENGINE_TOOLS;
