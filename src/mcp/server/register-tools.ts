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
import { registerSupervisedRoomTurnTools } from "./tools/supervised-room-turn.js";
import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import { toolSurfaceForExecutionProfile } from "./runtime/tool-surface-policy.js";
import { profileAwareToolServer } from "./supervised-tool-facade.js";

export function registerTools(
  server: McpServer,
  profile: LetAgentsExecutionProfile = "autonomous_mcp_worker",
  supervisedProvider = process.env.LETAGENTS_SUPERVISOR_PROVIDER?.trim() || null,
): void {
  const tools = profileAwareToolServer(server, profile, undefined, supervisedProvider);
  const surface = toolSurfaceForExecutionProfile(profile);
  registerRoomJoinTools(tools);
  if (surface.agentSessionLifecycle) registerAgentSessionTools(tools);
  registerRoomInspectionTools(tools);
  registerStatusTools(tools);
  registerTaskTools(tools);
  registerRepoInitializationTool(tools);
  registerMessageTools(tools, { includeDeliveryLoop: surface.deliveryLoop });
  if (profile === "supervised_room_turn" && supervisedProvider === "cursor") registerSupervisedRoomTurnTools(tools);
  if (surface.onboarding) registerOnboardingTools(tools);
  if (surface.roomResume) registerRoomResumeTool(tools);
  if (surface.rental) registerRentalTools(tools);
  registerRepoVisibilityTool(tools);
}
