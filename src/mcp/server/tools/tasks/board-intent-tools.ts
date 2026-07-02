import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  deleteActiveBoardManager,
  getBoardIntents,
  getBoardSettings,
  patchBoardSettings,
  postBoardIntent,
  postBoardIntentDecision,
  postBoardManager,
} from "./api.js";
import {
  resolveCanonicalRoomId,
  resolveCanonicalTaskToolIdentity,
  taskActorPayload,
} from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import { workerTaskIdentitySchema } from "./schemas.js";
import {
  boardIntentPayloadForLeaseAction,
  boardIntentPayloadForTaskCreate,
  boardIntentPayloadForTaskMutation,
  type BoardIntentPayload,
} from "../../../../api/board-intent-payloads.js";

const boardManagerModeSchema = z.enum(["off", "manager_optional", "intent_required"]);
const boardManagerRuntimeSourceSchema = z.enum(["desktop_managed", "open_model", "external", "unknown"]);
const boardIntentActionTypeSchema = z.enum([
  "task_create",
  "task_claim",
  "task_close",
  "task_override",
  "task_update",
]);
const boardIntentPayloadSchema = z.record(z.string(), z.unknown());
const boardIntentCloseStatusSchema = z.enum(["merged", "done", "cancelled"]);

async function registerTypedBoardIntent(input: {
  roomId: string;
  actionType: z.infer<typeof boardIntentActionTypeSchema>;
  payload: BoardIntentPayload;
  taskId?: string | null;
  agentSessionId?: string | null;
}) {
  const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(
    input.roomId,
    input.agentSessionId ?? undefined
  );
  const result = await postBoardIntent(input.roomId, {
    action_type: input.actionType,
    payload: input.payload,
    task_id: input.taskId ?? undefined,
    ...taskActorPayload(identity, agentSession),
  });
  return jsonToolResponse(
    {
      success: true,
      ...responseObject(result),
    },
    2
  );
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function registerBoardIntentTools(server: McpServer): void {
  server.tool(
    "get_board_settings",
    "Read Board Manager mode, the active Board Manager assignment, and pending intent count for the current room.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ room_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        return jsonToolResponse({ success: true, ...responseObject(await getBoardSettings(targetRoomId)) }, 2);
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "set_board_manager_mode",
    "Set room Board Manager mode. Requires room admin authority. Use manager_optional unless the human explicitly requires all high-impact agent board actions to register intent.",
    {
      manager_mode: boardManagerModeSchema.describe("off disables intent checks; manager_optional requires approval only while a manager is assigned; intent_required always requires approval."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ manager_mode, room_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const result = await patchBoardSettings(targetRoomId, { manager_mode });
        return jsonToolResponse(
          { success: true, ...responseObject(result) },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "assign_board_manager",
    "Promote an active worker session to Board Manager for this room. Runtime source is inferred for Open Model workers unless explicitly provided. Requires room admin authority.",
    {
      agent_session_id: z.string().describe("Active room agent session to promote."),
      runtime_source: boardManagerRuntimeSourceSchema.optional().describe("Runtime source for audit display."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ agent_session_id, runtime_source, room_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const result = await postBoardManager(targetRoomId, { agent_session_id, runtime_source });
        return jsonToolResponse(
          {
            success: true,
            ...responseObject(result),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "release_board_manager",
    "Release the active Board Manager assignment for this room. Requires room admin authority.",
    {
      reason: z.string().optional().describe("Why the manager role is being released."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ reason, room_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const result = await deleteActiveBoardManager(targetRoomId, { reason });
        return jsonToolResponse(
          { success: true, ...responseObject(result) },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "register_board_intent",
    "Advanced: register intent with an exact payload for a high-impact board action. Prefer the typed register_task_*_intent tools so the later action hash matches.",
    {
      action_type: boardIntentActionTypeSchema.describe("High-impact board action being proposed."),
      payload: boardIntentPayloadSchema.describe("Exact payload for the intended action. The later mutation must match this payload."),
      task_id: z.string().optional().describe("Task id for task-specific intents."),
      ...workerTaskIdentitySchema,
    },
    async ({ action_type, payload, task_id, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postBoardIntent(targetRoomId, {
          action_type,
          payload,
          task_id,
          ...taskActorPayload(identity, agentSession),
        });
        return jsonToolResponse(
          {
            success: true,
            ...responseObject(result),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "register_task_create_intent",
    "Register intent to add a task. Use this before add_task when Board Manager approval is required.",
    {
      title: z.string().describe("Task title exactly as it will be passed to add_task."),
      description: z.string().optional().describe("Task description exactly as it will be passed to add_task."),
      source_message_id: z.string().optional().describe("Source message id exactly as it will be passed to add_task."),
      ...workerTaskIdentitySchema,
    },
    async ({ title, description, source_message_id, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        return await registerTypedBoardIntent({
          roomId: targetRoomId,
          actionType: "task_create",
          payload: boardIntentPayloadForTaskCreate({
            title,
            description: description ?? null,
            sourceMessageId: source_message_id ?? null,
          }),
          agentSessionId: agent_session_id,
        });
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "register_task_claim_intent",
    "Register intent to claim an accepted task as the current worker. Use the returned approval with claim_task.",
    {
      task_id: z.string().describe("Task id to claim, e.g. task_12."),
      ...workerTaskIdentitySchema,
    },
    async ({ task_id, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postBoardIntent(targetRoomId, {
          action_type: "task_claim",
          task_id,
          payload: boardIntentPayloadForTaskMutation({
            taskId: task_id,
            status: "assigned",
            assignee: identity.actor_label,
            assigneeAgentKey: identity.canonical_key,
          }),
          ...taskActorPayload(identity, agentSession),
        });
        return jsonToolResponse(
          { success: true, ...responseObject(result) },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "register_task_close_intent",
    "Register intent to close a task as merged, done, or cancelled. Use the returned approval with update_task.",
    {
      task_id: z.string().describe("Task id to close, e.g. task_12."),
      status: boardIntentCloseStatusSchema.describe("Closeout status to pass to update_task."),
      pr_url: z.string().optional().describe("PR URL exactly as it will be passed to update_task, if any."),
      ...workerTaskIdentitySchema,
    },
    async ({ task_id, status, pr_url, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        return await registerTypedBoardIntent({
          roomId: targetRoomId,
          actionType: "task_close",
          taskId: task_id,
          payload: boardIntentPayloadForTaskMutation({
            taskId: task_id,
            status,
            prUrl: pr_url ?? null,
          }),
          agentSessionId: agent_session_id,
        });
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "register_task_lease_action_intent",
    "Register intent to release or hand off a task work lease. Use the returned approval with release_task_lease or handoff_task_lease.",
    {
      task_id: z.string().describe("Task id whose work lease will be changed."),
      action: z.enum(["release", "handoff"]).describe("Lease action that will be performed."),
      lease_id: z.string().optional().describe("Expected active lease id exactly as it will be passed to the lease action."),
      target_agent_key: z.string().optional().describe("Target canonical agent key. Required for handoff."),
      target_agent_session_id: z.string().optional().describe("Target registered agent session id exactly as it will be passed to handoff_task_lease."),
      ...workerTaskIdentitySchema,
    },
    async ({
      task_id,
      action,
      lease_id,
      target_agent_key,
      target_agent_session_id,
      room_id,
      conversation_id: _conversation_id,
      agent_session_id,
    }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      if (action === "handoff" && !target_agent_key) {
        return taskToolError("target_agent_key is required for handoff intent.");
      }
      try {
        return await registerTypedBoardIntent({
          roomId: targetRoomId,
          actionType: "task_override",
          taskId: task_id,
          payload: boardIntentPayloadForLeaseAction({
            taskId: task_id,
            action,
            leaseId: lease_id ?? null,
            targetActorKey: target_agent_key ?? null,
            targetAgentSessionId: target_agent_session_id ?? null,
          }),
          agentSessionId: agent_session_id,
        });
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "list_board_intents",
    "List Board Manager intents for this room, optionally filtered by status.",
    {
      status: z.enum(["pending", "approved", "denied", "expired", "used"]).optional(),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ status, room_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      try {
        const result = await getBoardIntents(targetRoomId, params.toString());
        return jsonToolResponse(
          { success: true, ...responseObject(result) },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "approve_board_intent",
    "Approve a pending board intent. Returns the scoped approval token that must be passed to the actual board action.",
    {
      intent_id: z.string().describe("Board intent id to approve."),
      reason: z.string().optional().describe("Short approval reason."),
      ...workerTaskIdentitySchema,
    },
    async ({ intent_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postBoardIntentDecision(targetRoomId, intent_id, "approve", {
          reason,
          ...taskActorPayload(identity, agentSession),
        });
        return jsonToolResponse(
          {
            success: true,
            ...responseObject(result),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );

  server.tool(
    "deny_board_intent",
    "Deny a pending board intent with a short reason.",
    {
      intent_id: z.string().describe("Board intent id to deny."),
      reason: z.string().optional().describe("Short denial reason."),
      ...workerTaskIdentitySchema,
    },
    async ({ intent_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = resolveCanonicalRoomId(room_id);
      if (!targetRoomId) return taskToolError("Not in a canonical room.");
      try {
        const { identity, agentSession } = await resolveCanonicalTaskToolIdentity(targetRoomId, agent_session_id);
        const result = await postBoardIntentDecision(targetRoomId, intent_id, "deny", {
          reason,
          ...taskActorPayload(identity, agentSession),
        });
        return jsonToolResponse(
          {
            success: true,
            ...responseObject(result),
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );
}
