import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ensureAgentIdentity,
  getRememberedRoomPresence,
  heartbeatRoomPresence,
  syncRoomPresence,
  toPublicAgentIdentity,
} from "../../runtime.js";
import { createTask, listTasks } from "./api.js";
import {
  resolveTaskToolIdentity,
  resolveTaskToolTarget,
  taskActorPayload,
} from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import { boardIntentApprovalSchema, TASK_STATUSES, workerTaskIdentitySchema } from "./schemas.js";

export const MAX_BOARD_WORKFLOW_ARTIFACTS_PER_TASK = 4;
export const MAX_BOARD_WORKFLOW_REFS_PER_TASK = 4;

function compactBoardWorkflowArtifact(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const artifact = value as Record<string, unknown>;
  // A change-summary detail may itself contain hundreds of files. The board is
  // an index; callers that need complete artifact detail use get_room_artifacts.
  return Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "detail"));
}

export function compactTaskForBoard(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = value as Record<string, unknown>;
  const artifacts = Array.isArray(task.workflow_artifacts) ? task.workflow_artifacts : [];
  const refs = Array.isArray(task.workflow_refs) ? task.workflow_refs : [];

  return {
    ...task,
    workflow_artifacts: artifacts
      .slice(-MAX_BOARD_WORKFLOW_ARTIFACTS_PER_TASK)
      .map(compactBoardWorkflowArtifact),
    workflow_refs: refs.slice(-MAX_BOARD_WORKFLOW_REFS_PER_TASK),
    workflow_artifact_count: artifacts.length,
    workflow_ref_count: refs.length,
    workflow_artifacts_truncated: artifacts.length > MAX_BOARD_WORKFLOW_ARTIFACTS_PER_TASK,
    workflow_refs_truncated: refs.length > MAX_BOARD_WORKFLOW_REFS_PER_TASK,
  };
}

export function registerTaskBoardTools(server: McpServer): void {
  server.tool(
    "add_task",
    "Add a new task to the room board. Tasks normally start as 'proposed' and must be " +
      "accepted before an agent can claim them. Agent-created tasks require coordinator " +
      "acceptance before they become claimable. Use this when a human or agent identifies " +
      "work that needs to be done.",
    {
      title: z.string().describe("Short task title, e.g. 'Wire up Jest test runner'"),
      description: z.string().optional().describe("Longer description of what needs to be done"),
      created_by: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      source_message_id: z.string().optional().describe("Optional message ID where task was agreed, e.g. 'msg_42'"),
      ...workerTaskIdentitySchema,
      ...boardIntentApprovalSchema,
    },
    async ({ title, description, created_by: _createdBy, source_message_id, room_id, conversation_id: _conversation_id, agent_session_id, board_intent_id, board_approval_token }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room. Join one first.");

      const { identity, agentSession } = await resolveTaskToolIdentity(target, agent_session_id);
      const task = await createTask(target, {
        title,
        description,
        created_by: identity.actor_label,
        ...taskActorPayload(identity, agentSession),
        source_message_id,
        board_intent_id,
        board_approval_token,
      });

      await syncRoomPresence(
        target.effectiveRoomId,
        identity,
        getRememberedRoomPresence(target.effectiveRoomId, identity),
        agentSession
      );

      return jsonToolResponse(
        { success: true, task, agent_identity: toPublicAgentIdentity(identity) },
        2
      );
    }
  );

  server.tool(
    "get_board",
    "Get the current task board for the room. By default shows only actionable tasks " +
      "(including merged closeout work, but not done/cancelled). Agents should check this on startup and when idle to " +
      "see if there is unassigned work to claim.",
    {
      status: z.enum(TASK_STATUSES).optional().describe("Filter by specific status"),
      open_only: z.boolean().optional().describe("If true (default), only show actionable tasks, including merged closeout work but not done/cancelled"),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ status, open_only, room_id }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room. Join one first.");

      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (open_only !== false) params.set("open", "true");

      const allTasks: unknown[] = [];
      let afterCursor: string | undefined;

      for (;;) {
        const pageParams = new URLSearchParams(params);
        if (afterCursor) pageParams.set("after", afterCursor);
        const qs = pageParams.toString();

        const result = await listTasks(target, qs);

        const tasks = result.tasks ?? [];
        allTasks.push(...tasks.map(compactTaskForBoard));

        if (!result.has_more || tasks.length === 0) break;
        const lastTask = tasks[tasks.length - 1];
        if (!lastTask?.id) break;
        afterCursor = lastTask.id;
      }

      await heartbeatRoomPresence(target.effectiveRoomId, await ensureAgentIdentity());

      return jsonToolResponse({
        success: true,
        tasks: allTasks,
        artifact_detail_instruction:
          "Board tasks contain bounded artifact summaries. Use get_room_artifacts for complete workflow artifact detail.",
      }, 2);
    }
  );
}
