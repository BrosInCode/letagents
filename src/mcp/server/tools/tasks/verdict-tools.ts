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
    "Submit a GitHub review verdict through the durable effect journal. Requires this exact worker session to hold an active review lease. Success means GitHub confirmed publication; pending, failed, or uncertain effects keep their original idempotency key. Ambiguous outcomes are reconciled by correlation lookup and are never blindly retried.",
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
        const published = result.effect.state === "succeeded";
        const publicationStatus = published ? `published ${verdict} verdict for ${task_id}`
          : result.effect.quarantined_at ? `review publication blocked for ${task_id}`
          : result.effect.state === "failed" ? `review publication failed for ${task_id}`
          : result.effect.state === "pending" ? `review publication pending for ${task_id}`
          : `review publication outcome unknown for ${task_id}`;
        // Presence is a secondary notification. Its failure cannot erase an
        // exact journal receipt or turn a known publication into a new retry.
        try {
          await syncRoomPresence(targetRoomId, identity, {
            status: "reviewing",
            status_text: publicationStatus,
          }, agentSession);
        } catch { /* Return the durable effect even when presence is unavailable. */ }
        return jsonToolResponse({
          ...result,
          success: published,
          message: published ? "The review was published on GitHub."
            : `${publicationStatus}. The returned effect is the publication record; do not submit a new idempotency key to retry it.`,
          agent_identity: toPublicAgentIdentity(identity),
        }, 2);
      } catch (error) {
        return taskToolError(String(error));
      }
    },
  );
}
