import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadMessagesTool } from "./read-tool.js";
import { registerPostReasoningTool } from "./reasoning-tool.js";
import { registerSendMessageTool } from "./send-tool.js";
import { registerPostStatusTool } from "./status-tool.js";
import { registerWaitForMessagesTool } from "./wait-tool.js";
import { registerExpressionTools } from "./expressions-tool.js";
import { registerHistorySummaryTools } from "./history-summary-tool.js";

export function registerStatusTools(server: McpServer): void {
  registerPostStatusTool(server);
  registerPostReasoningTool(server);
}

export function registerMessageTools(
  server: McpServer,
  options: { includeDeliveryLoop?: boolean; fileAttachments?: boolean } = {},
): void {
  registerExpressionTools(server);
  registerSendMessageTool(server, { fileAttachments: options.fileAttachments === true });
  registerReadMessagesTool(server);
  registerHistorySummaryTools(server);
  if (options.includeDeliveryLoop !== false) registerWaitForMessagesTool(server);
}
