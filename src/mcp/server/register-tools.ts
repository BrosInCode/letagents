import { localSupervisedRoomToolAvailable } from "../../../shared/local-supervised-tools.mjs";
import { isLocalRoomApi } from "../../../shared/room-api-origin.mjs";
import { registerRoomKnowledgeTools } from "./tools/knowledge.js";
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
import { workerAwareToolServer } from "./worker-tool-facade.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

export function registerTools(
  server: McpServer,
  profile: LetAgentsExecutionProfile = "autonomous_mcp_worker",
  supervisedProvider = process.env.LETAGENTS_SUPERVISOR_PROVIDER?.trim() || null,
  options: { executionOwner?: "provider" | "daemon"; apiUrl?: string } = {},
): void {
  const localRoom = profile === "supervised_room_turn" && isLocalRoomApi(options.apiUrl ?? process.env.LETAGENTS_API_URL);
  const routedServer = localRoom ? new Proxy(server, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "tool") return typeof value === "function" ? value.bind(target) : value;
      return (name: string, ...registration: unknown[]) => {
        if (!localSupervisedRoomToolAvailable(name)) return undefined;
        if (name === "update_task" && typeof registration[0] === "string") {
          registration[0] += " In local rooms, close verified merged work with status 'done'; no close intent or replacement work lease is needed.";
        }
        return (target.tool as (...args: unknown[]) => unknown).call(target, name, ...registration);
      };
    },
  }) : server;
  const profileTools = options.executionOwner === "daemon"
    ? routedServer
    : profileAwareToolServer(routedServer, profile, undefined, supervisedProvider);
  const tools = profile === "autonomous_mcp_worker" || profile === "interactive_desktop"
    ? workerAwareToolServer(profileTools) : profileTools;
  const surface = toolSurfaceForExecutionProfile(profile);
  registerRoomJoinTools(tools);
  if (surface.agentSessionLifecycle) registerAgentSessionTools(tools);
  registerRoomInspectionTools(tools);
  registerRoomKnowledgeTools(tools);
  registerStatusTools(tools);
  if (profile === "autonomous_mcp_worker" || profile === "interactive_desktop") registerWorkspaceTools(tools);
  registerTaskTools(tools);
  registerRepoInitializationTool(tools);
  registerMessageTools(tools, { includeDeliveryLoop: surface.deliveryLoop });
  if (profile === "supervised_room_turn" && supervisedProvider === "cursor") registerSupervisedRoomTurnTools(tools);
  if (surface.onboarding) registerOnboardingTools(tools);
  if (surface.roomResume) registerRoomResumeTool(tools);
  if (surface.rental) registerRentalTools(tools);
  registerRepoVisibilityTool(tools);
}
