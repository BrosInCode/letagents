import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildAgentActorLabel, formatOwnerAttribution } from "../../../../shared/agent-identity.js";
import { normalizeAgentBaseName } from "../../../../shared/codenames.js";
import {
  apiCall,
  currentAgentIdentity,
  currentAgentIdentityKey,
  detectAgentIdeLabel,
  getConversationIdentity,
  getLetagentsToken,
  resolveOwnerContext,
  setConversationIdentity,
  storeCurrentAgentIdentity,
  toPublicAgentIdentity,
  type StoredAgentIdentityState,
} from "../../runtime.js";
import { jsonTextResponse } from "./responses.js";
import { workerModeDisabledToolResult } from "../../runtime/worker-bearer.js";

export function registerSetAgentNameTool(server: McpServer): void {
  server.tool(
    "set_agent_name",
    "Set or change the legacy process identity's display name. Durable MCP workers choose display_name when first registered; this tool cannot rename them.",
    {
      worker_id: z.string().optional().describe("Durable worker handles cannot be renamed by this legacy tool."),
      name: z
        .string()
        .min(2)
        .max(64)
        .describe("The desired display name for this agent (2-64 characters)."),
      conversation_id: z
        .string()
        .optional()
        .describe("Optional conversation ID to scope this name change. When provided, only this conversation uses the new name; other conversations keep their own identity."),
    },
    async ({ name: desiredName, conversation_id, worker_id }) => {
      if (worker_id) throw new Error("Choose display_name when first registering this worker. set_agent_name only changes the legacy process identity.");
      const disabled = workerModeDisabledToolResult();
      if (disabled) return jsonTextResponse(disabled);
      const trimmedName = desiredName.trim();
      if (trimmedName.length < 2 || trimmedName.length > 64) {
        return jsonTextResponse({
          success: false,
          error: "Name must be between 2 and 64 characters.",
        });
      }

      const authAvailable = Boolean(await getLetagentsToken());
      if (!authAvailable) {
        return jsonTextResponse({
          success: false,
          error: "Authentication required. Run start_device_auth first.",
        });
      }

      const slugName = normalizeAgentBaseName(trimmedName);

      try {
        const owner = await resolveOwnerContext();
        const ideLabel = detectAgentIdeLabel();
        const ownerAttribution = formatOwnerAttribution(owner.label);
        const actorLabel = buildAgentActorLabel({
          display_name: trimmedName,
          owner_label: owner.label,
          ide_label: ideLabel,
        });

        let canonicalKey: string | null = owner.login ? `${owner.login}/${slugName}` : null;
        if (!conversation_id) {
          const registered = await apiCall<Record<string, unknown>>("/agents", {
            method: "POST",
            body: JSON.stringify({
              name: slugName,
              display_name: trimmedName,
              owner_label: owner.label,
            }),
          });
          if (typeof registered.canonical_key === "string") {
            canonicalKey = registered.canonical_key;
          }
        }

        const updatedIdentity: StoredAgentIdentityState = {
          name: slugName,
          display_name: trimmedName,
          owner_label: owner.label,
          owner_attribution: ownerAttribution,
          ide_label: ideLabel,
          actor_label: actorLabel,
          canonical_key: canonicalKey,
          runtime_key: currentAgentIdentityKey,
          source: conversation_id ? "local" : "api",
          resolved_at: new Date().toISOString(),
        };

        if (conversation_id) {
          setConversationIdentity(conversation_id, updatedIdentity);
        } else {
          storeCurrentAgentIdentity(updatedIdentity, currentAgentIdentityKey);
        }

        return jsonTextResponse({
          success: true,
          message: `Agent name changed to "${trimmedName}".`,
          agent_identity: toPublicAgentIdentity(
            conversation_id
              ? getConversationIdentity(conversation_id)
              : currentAgentIdentity,
          ),
        });
      } catch (error) {
        return jsonTextResponse({
          success: false,
          error: `Failed to set name: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );
}
