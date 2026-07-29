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
import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import { toolSurfaceForExecutionProfile } from "./runtime/tool-surface-policy.js";
import { profileAwareToolServer } from "./supervised-tool-facade.js";

export function registerTools(server: McpServer, profile: LetAgentsExecutionProfile = "autonomous_mcp_worker"): void {
  const tools = profileAwareToolServer(server, profile);
  const surface = toolSurfaceForExecutionProfile(profile);
  registerRoomJoinTools(tools);
  if (surface.agentSessionLifecycle) registerAgentSessionTools(tools);
  registerRoomInspectionTools(tools);
  registerStatusTools(tools);
  registerTaskTools(tools);
  registerRepoInitializationTool(tools);
  registerMessageTools(tools, { includeDeliveryLoop: surface.deliveryLoop });
  if (surface.onboarding) registerOnboardingTools(tools);
  if (surface.roomResume) registerRoomResumeTool(tools);
  if (surface.rental) registerRentalTools(tools);
  registerRepoVisibilityTool(tools);
}
