import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { syncRoomPresence, toPublicAgentIdentity } from "../../runtime.js";
import { postCanonicalTaskAction } from "./api.js";
import {
  resolveCanonicalRoomId,
  resolveCanonicalTaskToolIdentity,
  taskActorPayload,
} from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import { boardIntentApprovalSchema, taskLeaseIdentitySchema, taskReviewIdentitySchema } from "./schemas.js";

export function registerTaskLeaseTools(server: McpServer): void {
  server.tool(
    "claim_task_review",
    "Claim board review authority for a task in review. This creates a review lease " +
      "for the registered worker session and is rejected if the worker holds the active work lease.",
    {
      task_id: z.string().describe("The task to review, e.g. 'task_1'"),
      reason: z.string().optional().describe("Why this worker is taking review authority"),
      ...taskReviewIdentitySchema,
    },
    async ({ task_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");

      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postCanonicalTaskAction<{
          action: "claim";
          task: Record<string, unknown>;
          lease: Record<string, unknown> | null;
        }>(targetRoomId, task_id, "review-lease-action", {
          action: "claim",
          reason,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(targetRoomId, identity, {
          status: "reviewing",
          status_text: `reviewing ${task_id}`,
        }, agentSession);

        return jsonToolResponse(
          {
            success: true,
            ...result,
            agent_identity: toPublicAgentIdentity(identity),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "release_task_review",
    "Release this worker's active review lease on a task. Room admins can pass a specific lease_id to clear another review lease.",
    {
      task_id: z.string().describe("The task whose review lease should be released"),
      lease_id: z.string().optional().describe("Optional review lease id. Required for admin release of another reviewer."),
      reason: z.string().optional().describe("Why review authority is being released"),
      ...taskReviewIdentitySchema,
    },
    async ({ task_id, lease_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");

      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postCanonicalTaskAction<{
          action: "release";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
        }>(targetRoomId, task_id, "review-lease-action", {
          action: "release",
          lease_id: lease_id ?? undefined,
          reason,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(targetRoomId, identity, {
          status: "idle",
          status_text: `released review on ${task_id}`,
        }, agentSession);

        return jsonToolResponse(
          {
            success: true,
            ...result,
            agent_identity: toPublicAgentIdentity(identity),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "release_task_lease",
    "Release or forcibly clear the active work lease on a task so it can be claimed again. " +
      "Use this when the current worker is blocked, gone, or needs to give the lane back to the room.",
    {
      task_id: z.string().describe("The task whose active work lease should be cleared"),
      lease_id: z.string().optional().describe("Optional expected active lease id for stale-checking"),
      reason: z.string().optional().describe("Why the lease is being released"),
      ...taskLeaseIdentitySchema,
      ...boardIntentApprovalSchema,
    },
    async ({ task_id, lease_id, reason, room_id, conversation_id: _conversation_id, agent_session_id, board_intent_id, board_approval_token }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");

      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postCanonicalTaskAction<{
          action: "release";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
        }>(targetRoomId, task_id, "lease-action", {
          action: "release",
          lease_id: lease_id ?? undefined,
          reason,
          board_intent_id,
          board_approval_token,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(targetRoomId, identity, {
          status: "working",
          status_text: `released lease on ${task_id}`,
        }, agentSession);

        return jsonToolResponse(
          {
            success: true,
            ...result,
            agent_identity: toPublicAgentIdentity(identity),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "handoff_task_lease",
    "Transfer the active work lease on a task to another agent. " +
      "This reassigns the task and mints a fresh work lease for the target worker session.",
    {
      task_id: z.string().describe("The task whose active work lease should be transferred"),
      target_agent_key: z.string().describe("Canonical agent key to receive the new work lease"),
      target_actor_instance_id: z.string().optional().describe("Optional target agent instance id when selecting among active sessions for the same agent key"),
      target_agent_session_id: z.string().optional().describe("Optional target registered agent session id. Required when the target agent key has multiple active worker sessions."),
      lease_id: z.string().optional().describe("Optional expected active lease id for stale-checking"),
      reason: z.string().optional().describe("Why the lane is being handed off"),
      ...taskLeaseIdentitySchema,
      ...boardIntentApprovalSchema,
    },
    async ({
      task_id,
      target_agent_key,
      target_actor_instance_id,
      target_agent_session_id,
      lease_id,
      reason,
      room_id,
      conversation_id: _conversation_id,
      agent_session_id,
      board_intent_id,
      board_approval_token,
    }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");

      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postCanonicalTaskAction<{
          action: "handoff";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
          new_lease: Record<string, unknown> | null;
        }>(targetRoomId, task_id, "lease-action", {
          action: "handoff",
          lease_id: lease_id ?? undefined,
          reason,
          target_actor_key: target_agent_key,
          target_actor_instance_id: target_actor_instance_id ?? undefined,
          target_agent_session_id: target_agent_session_id ?? undefined,
          board_intent_id,
          board_approval_token,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(targetRoomId, identity, {
          status: "working",
          status_text: `handed off ${task_id} to ${target_agent_key}`,
        }, agentSession);

        return jsonToolResponse(
          {
            success: true,
            ...result,
            agent_identity: toPublicAgentIdentity(identity),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );
}
