import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { encodeRoomIdPath } from "../../../room-id.js";
import { roomScopedApiCall, syncRoomPresence, toPublicAgentIdentity } from "../../runtime.js";
import {
  resolveCanonicalRoomId,
  resolveCanonicalTaskToolIdentity,
  taskActorPayload,
} from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import { taskReviewIdentitySchema } from "./schemas.js";

export function registerTaskVerdictTools(server: McpServer): void {
  server.tool(
    "submit_review_verdict",
    "Submit a GitHub review verdict through the durable effect journal. Requires this exact worker session to hold an active review lease. Ambiguous provider outcomes are reconciled by correlation lookup and are never blindly retried.",
    {
      task_id: z.string().describe("Task in review, e.g. 'task_1'."),
      verdict: z.enum(["approve", "request_changes", "comment"]).describe("GitHub review verdict."),
      body: z.string().max(65_536).optional().describe("Review explanation. Empty or junk blocking verdicts are quarantined."),
      expected_head_sha: z.string().regex(/^[0-9a-fA-F]{40}$/).describe("Exact 40-hex pull request head SHA that was reviewed."),
      idempotency_key: z.string().min(1).max(200).describe("Stable key for this logical verdict; reuse it only for an exact replay."),
      ...taskReviewIdentitySchema,
    },
    async ({ task_id, verdict, body, expected_head_sha, idempotency_key, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");

      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await roomScopedApiCall<{
          room_id: string;
          task_id: string;
          effect: Record<string, unknown>;
        }>({
          room_id: targetRoomId,
          project_id: null,
          room_path: (canonicalRoomId) =>
            `/rooms/${encodeRoomIdPath(canonicalRoomId)}/tasks/${encodeURIComponent(task_id)}/review-verdict`,
          project_path: () => "",
          options: {
            method: "POST",
            body: JSON.stringify({
              verdict,
              body: body ?? "",
              expected_head_sha: expected_head_sha.toLowerCase(),
              idempotency_key,
              ...taskActorPayload(identity, agentSession),
            }),
          },
        });
        await syncRoomPresence(targetRoomId, identity, {
          status: "reviewing",
          status_text: `submitted ${verdict} verdict for ${task_id}`,
        }, agentSession);
        return jsonToolResponse({
          success: true,
          ...result,
          agent_identity: toPublicAgentIdentity(identity),
        }, 2);
      } catch (error) {
        return taskToolError(String(error));
      }
    },
  );
}
