import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ROOM_EXPRESSION_GUIDANCE } from "../../../shared/room-expressions.mjs";
import { registerRoomResources } from "./resources.js";
import { registerTools } from "./register-tools.js";
import { REMOTE_MAX_TOOL_INPUT_ELEMENTS } from "./remote-tool-surface.js";
import { registerRuntimeReadinessResource } from "./runtime-contract.js";
import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";
import { WORKSPACE_CAPTURE_INSTRUCTIONS } from "./tools/workspace.js";

export interface LetAgentsToolContext {
  profile: LetAgentsExecutionProfile;
  supervisedProvider: string | null;
  /**
   * The API's remote (streamable HTTP) endpoint: only the remote allow list
   * registers, and local-path inputs are removed.
   */
  remote: boolean;
}

/**
 * Register the LetAgents tools and resources on any MCP server object. The
 * stdio server (npm package) and the API's remote endpoint both call this, so
 * there is one registry with two transports.
 */
export function registerLetAgentsTools(server: McpServer, context: LetAgentsToolContext): void {
  registerRoomResources(server);
  registerTools(server, context.profile, context.supervisedProvider, { remote: context.remote });
  // The readiness resource describes the full local registry; remote callers
  // see only their allow list (tools/list), so it is not offered to them.
  if (!context.remote) registerRuntimeReadinessResource(server, context.profile, context.supervisedProvider);
}

/** A new MCP server object with the LetAgents tools registered. */
export function createLetAgentsMcpServer(context: LetAgentsToolContext): McpServer {
  const workerProfile = context.profile === "autonomous_mcp_worker" || context.profile === "interactive_desktop";
  const server = new McpServer({ name: "letagents", version: "0.2.0" }, {
    instructions: context.remote ? ROOM_EXPRESSION_GUIDANCE
      : workerProfile ? `${WORKSPACE_CAPTURE_INSTRUCTIONS}\n\n${ROOM_EXPRESSION_GUIDANCE}` : undefined,
    // Remote callers reach SDK validation over HTTP; bound its work per call
    // (GHSA-46jr-4wx8-v453). stdio servers are not exposed to it.
    ...(context.remote ? { maxToolInputElements: REMOTE_MAX_TOOL_INPUT_ELEMENTS } : {}),
  });
  registerLetAgentsTools(server, context);
  return server;
}
