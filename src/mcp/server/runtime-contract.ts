import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./register-tools.js";
import type { LetAgentsExecutionProfile } from "./runtime/execution-profile.js";

export const LETAGENTS_RUNTIME_CONTRACT_ARG = "--letagents-runtime-contract";
export const LETAGENTS_RUNTIME_READINESS_URI = "letagents://runtime/readiness";

export type LetAgentsRuntimeContract = {
  format: 1;
  profiles: {
    supervised_mcp_polling: { contract: "custodial_polling_v1"; tools: string[] };
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
  apiUrl: string | undefined = process.env.LETAGENTS_API_URL,
): string[] {
  const names = new Set<string>();
  const recorder = {
    tool(name: string) {
      names.add(name);
      return {};
    },
  } as unknown as McpServer;
  registerTools(recorder, profile, supervisedProvider, { apiUrl });
  return [...names].sort();
}

/** Public capability metadata only; reading it grants no room or tool authority. */
export function registerRuntimeReadinessResource(
  server: McpServer,
  profile: LetAgentsExecutionProfile,
  supervisedProvider: string | null,
  apiUrl: string | undefined = process.env.LETAGENTS_API_URL,
): void {
  const text = JSON.stringify({
    format: 1, profile, provider: supervisedProvider,
    tools: registeredToolNames(profile, supervisedProvider, apiUrl),
  });
  server.resource("runtime_readiness", LETAGENTS_RUNTIME_READINESS_URI,
    { mimeType: "application/json" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text }],
    }));
}

export function letAgentsRuntimeContract(apiUrl: string | undefined = process.env.LETAGENTS_API_URL): LetAgentsRuntimeContract {
  return {
    format: 1,
    profiles: {
      supervised_mcp_polling: { contract: "custodial_polling_v1", tools: registeredToolNames("supervised_mcp_polling", "codex", apiUrl) },
      cursor_supervised_room_turn: {
        tools: registeredToolNames("supervised_room_turn", "cursor", apiUrl),
      },
    },
  };
}
