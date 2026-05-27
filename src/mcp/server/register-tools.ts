import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentSessionTools } from "./tools/agent-sessions.js";
import { registerMessageTools, registerStatusTools } from "./tools/messages.js";
import { registerOnboardingTools } from "./tools/onboarding.js";
import { registerRentalTools } from "./tools/rental.js";
import {
  registerRepoInitializationTool,
  registerRepoVisibilityTool,
  registerRoomInspectionTools,
  registerRoomJoinTools,
  registerRoomResumeTool,
} from "./tools/rooms.js";
import { registerTaskTools } from "./tools/tasks.js";

export function registerTools(server: McpServer): void {
  registerRoomJoinTools(server);
  registerAgentSessionTools(server);
  registerRoomInspectionTools(server);
  registerStatusTools(server);
  registerTaskTools(server);
  registerRepoInitializationTool(server);
  registerMessageTools(server);
  registerOnboardingTools(server);
  registerRoomResumeTool(server);
  registerRentalTools(server);
  registerRepoVisibilityTool(server);
}
