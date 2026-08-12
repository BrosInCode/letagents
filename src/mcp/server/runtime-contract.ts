import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./register-tools.js";
import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";

export const LETAGENTS_RUNTIME_CONTRACT_ARG = "--letagents-runtime-contract";

export type LetAgentsRuntimeContract = {
  format: 1;
  profiles: {
    cursor_supervised_room_turn: {
      tools: string[];
    };
  };
};

/**
 * Discover through the production registration path rather than maintaining a
 * second capability list that can drift from the MCP server.
 */
export function registeredToolNames(
  profile: LetAgentsExecutionProfile,
  supervisedProvider: string | null = null,
): string[] {
  const names = new Set<string>();
  const recorder = {
    tool(name: string) {
      names.add(name);
      return {};
    },
  } as unknown as McpServer;
  registerTools(recorder, profile, supervisedProvider);
  return [...names].sort();
}

export function letAgentsRuntimeContract(): LetAgentsRuntimeContract {
  return {
    format: 1,
    profiles: {
      cursor_supervised_room_turn: {
        tools: registeredToolNames("supervised_room_turn", "cursor"),
      },
    },
  };
}
