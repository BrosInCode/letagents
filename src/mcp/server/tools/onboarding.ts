import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDeviceAuthTools } from "./onboarding/device-auth-tools.js";
import { registerSetAgentNameTool } from "./onboarding/name-tool.js";
import { registerGetOnboardingStatusTool } from "./onboarding/status-tool.js";

export function registerOnboardingTools(server: McpServer): void {
  registerGetOnboardingStatusTool(server);
  registerDeviceAuthTools(server);
  registerSetAgentNameTool(server);
}
