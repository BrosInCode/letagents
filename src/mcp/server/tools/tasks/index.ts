import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskBoardTools } from "./board-tools.js";
import { registerTaskEventTools } from "./event-tools.js";
import { registerTaskLeaseTools } from "./lease-tools.js";
import { registerTaskMutationTools } from "./mutation-tools.js";

export function registerTaskTools(server: McpServer): void {
  registerTaskBoardTools(server);
  registerTaskEventTools(server);
  registerTaskMutationTools(server);
  registerTaskLeaseTools(server);
}
