import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { roomAccessToolResponse } from "./runtime/room-access.js";

/**
 * Every tool answers "sign in first" and "members only" the same way,
 * whichever room call met it: a result that names the next step, instead of
 * raw API text the agent may retry. It wraps the outermost callback, so the
 * other facades (remote, supervised, worker) see the error as before.
 */
export function roomAccessAwareToolServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "tool" && property !== "registerTool") return value.bind(target);
      return (name: string, ...registration: unknown[]) => {
        const callback = registration.at(-1);
        if (typeof callback !== "function") return value.call(target, name, ...registration);
        const answered = async (...args: unknown[]) => {
          try {
            return await callback(...args);
          } catch (error) {
            const response = roomAccessToolResponse(error);
            if (response) return response;
            throw error;
          }
        };
        return value.call(target, name, ...registration.slice(0, -1), answered);
      };
    },
  });
}
