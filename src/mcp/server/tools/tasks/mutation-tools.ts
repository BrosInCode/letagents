import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveTaskPresenceStatus } from "../../../agent-presence.js";
import {
  getRememberedRoomPresence,
  syncRoomPresence,
  toPublicAgentIdentity,
} from "../../runtime.js";
import { patchTask } from "./api.js";
import {
  resolveTaskToolIdentity,
  resolveTaskToolTarget,
  taskActorPayload,
} from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import {
  deprecatedAssigneeSchema,
  boardIntentApprovalSchema,
  TASK_STATUSES,
  workerTaskIdentitySchema,
  workflowArtifactSchema,
} from "./schemas.js";

export function registerTaskMutationTools(server: McpServer): void {
  server.tool(
    "claim_task",
    "Claim an accepted task, or retry your own assigned task to recover a missing work lease. " +
      "This sets the assignee to you and moves the status to 'assigned'. A retry with your active lease is idempotent. " +
      "If approval is required, register a task claim intent; after the manager approves it, pass board_intent_id. Managed workers do not need to copy approval tokens. " +
      "Do NOT claim proposed tasks — they need to be accepted first.",
    {
      task_id: z.string().describe("The task ID to claim, e.g. 'task_1'"),
      assignee: deprecatedAssigneeSchema,
      ...workerTaskIdentitySchema,
      ...boardIntentApprovalSchema,
    },
    async ({ task_id, assignee: _assignee, room_id, conversation_id: _conversation_id, agent_session_id, board_intent_id, board_approval_token }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room.");

      try {
        const { identity, agentSession } = await resolveTaskToolIdentity(target, agent_session_id);
        const updated = await patchTask(target, task_id, {
          status: "assigned",
          assignee: identity.actor_label,
          ...taskActorPayload(identity, agentSession),
          assignee_agent_key: identity.canonical_key,
          board_intent_id,
          board_approval_token,
        });
        await syncRoomPresence(target.effectiveRoomId, identity, {
          status: "working",
          status_text: `claimed ${task_id}`,
        }, agentSession).catch((error) => console.error("[tasks] Task updated; presence update failed:", String(error)));

        return jsonToolResponse(
          { success: true, task: updated, agent_identity: toPublicAgentIdentity(identity) },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "update_task",
    "Update a task's status or assignee. Status transitions are validated — " +
      "only valid transitions are allowed (e.g. in_progress → in_review, " +
      "but NOT proposed → in_progress).",
    {
      task_id: z.string().describe("The task ID to update"),
      status: z.enum(TASK_STATUSES).optional().describe("New status for the task"),
      assignee: z
        .string()
        .optional()
        .describe("New assignee for the task. Defaults to the current agent when status=assigned."),
      pr_url: z.string().optional().describe("PR URL to link to the task"),
      workflow_artifacts: z
        .array(workflowArtifactSchema)
        .max(32)
        .optional()
        .describe("Persisted provider-neutral task workflow artifacts to attach to the task"),
      ...workerTaskIdentitySchema,
      ...boardIntentApprovalSchema,
    },
    async ({ task_id, status, assignee, pr_url, workflow_artifacts, room_id, conversation_id: _conversation_id, agent_session_id, board_intent_id, board_approval_token }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room.");

      try {
        const { identity, agentSession } = await resolveTaskToolIdentity(target, agent_session_id);
        const rememberedPresence = getRememberedRoomPresence(target.effectiveRoomId, identity);
        const nextAssignee = status === "assigned" && !assignee ? identity.actor_label : assignee;
        const nextAssigneeAgentKey =
          nextAssignee === identity.actor_label ? identity.canonical_key : undefined;
        const updated = await patchTask(target, task_id, {
          status,
          assignee: nextAssignee,
          assignee_agent_key: nextAssigneeAgentKey,
          pr_url,
          workflow_artifacts,
          board_intent_id,
          board_approval_token,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(target.effectiveRoomId, identity, {
          status: deriveTaskPresenceStatus(status ?? null, rememberedPresence.status),
          status_text: status ? `${task_id} -> ${status}` : rememberedPresence.status_text,
        }, agentSession).catch((error) => console.error("[tasks] Task updated; presence update failed:", String(error)));

        return jsonToolResponse(
          {
            success: true,
            task: updated,
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
    "complete_task",
    "Submit a task for review. Moves the task to 'in_review' status. " +
      "Optionally attach a PR URL. After this, a reviewer must confirm " +
      "the work is merged before it can be marked done.",
    {
      task_id: z.string().describe("The task ID to submit for review"),
      pr_url: z.string().optional().describe("GitHub PR URL for the work"),
      ...workerTaskIdentitySchema,
    },
    async ({ task_id, pr_url, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room.");

      try {
        const { identity, agentSession } = await resolveTaskToolIdentity(target, agent_session_id);
        const updated = await patchTask(target, task_id, {
          status: "in_review",
          pr_url,
          ...taskActorPayload(identity, agentSession),
        });
        await syncRoomPresence(target.effectiveRoomId, identity, {
          status: "reviewing",
          status_text: `${task_id} -> in_review`,
        }, agentSession).catch((error) => console.error("[tasks] Task updated; presence update failed:", String(error)));

        return jsonToolResponse(
          {
            success: true,
            task: updated,
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
