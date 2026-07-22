import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadMessagesTool } from "./read-tool.js";
import { registerPostReasoningTool } from "./reasoning-tool.js";
import { registerSendMessageTool } from "./send-tool.js";
import { registerPostStatusTool } from "./status-tool.js";
import { registerWaitForMessagesTool } from "./wait-tool.js";

export function registerStatusTools(server: McpServer): void {
  registerPostStatusTool(server);
  registerPostReasoningTool(server);
}

export function registerMessageTools(server: McpServer, options: { includeDeliveryLoop?: boolean } = {}): void {
  registerSendMessageTool(server);
  registerReadMessagesTool(server);
  if (options.includeDeliveryLoop !== false) registerWaitForMessagesTool(server);
}
