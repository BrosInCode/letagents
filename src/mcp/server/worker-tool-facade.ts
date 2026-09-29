import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runMcpWorkerCall } from "./runtime/worker-handles.js";
import { getStoredAgentSession } from "../local-state/agent-sessions.js";
import { isMcpWorkerId } from "../../shared/mcp-worker.js";

/** One explicit identity path for all worker tools, including shared transports. */
export function workerAwareToolServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "tool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, description: string, schema: Record<string, unknown>, callback: (...args: any[]) => unknown) => {
        // assign_board_manager's session id names the target, not the caller.
        if (name === "register_agent_session" || name === "assign_board_manager"
          || !schema.room_id) {
          return (target.tool as any)(name, description, schema, callback);
        }
        return (target.tool as any)(name, description, {
          ...schema,
          worker_id: z.string().optional().describe("Stable handle returned by register_agent_session for this chat. Use worker_id or legacy agent_session_id, not both. Reconnect the handle after an MCP process restart."),
        }, async (input: Record<string, unknown>, extra: unknown) => {
          const { worker_id, ...args } = input;
          if (worker_id === undefined) {
            const session = typeof args.agent_session_id === "string" ? getStoredAgentSession(args.agent_session_id) : null;
            return session && isMcpWorkerId(session.agent_instance_id)
              ? runMcpWorkerCall(session.agent_instance_id!, (args.room_id as string | undefined) ?? session.room_id,
                () => callback(args, extra), name === "disconnect_agent_session")
              : callback(args, extra);
          }
          if (args.agent_session_id !== undefined) throw new Error("Choose worker_id or agent_session_id, not both.");
          return runMcpWorkerCall(String(worker_id), args.room_id as string | undefined, (session) =>
            callback({ ...args, room_id: session.room_id,
              ...(schema.agent_session_id ? { agent_session_id: session.session_id } : {}) }, extra), name === "disconnect_agent_session");
        });
      };
    },
  });
}
