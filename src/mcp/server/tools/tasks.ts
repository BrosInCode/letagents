import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveTaskPresenceStatus } from "../../agent-presence.js";
import { buildRoomEventsQueryString } from "../../room-events-query.js";
import { encodeRoomIdPath } from "../../room-id.js";
import {
  AGENT_INSTANCE_UUID,
  apiCall,
  agentSessionCredentials,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getRememberedRoomPresence,
  getTargetRoomId,
  heartbeatRoomPresence,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toPublicAgentIdentity,
} from "../runtime.js";

export function registerTaskTools(server: McpServer): void {
  // -- Task Board Tools -------------------------------------------------------

  const TASK_STATUSES = [
    "proposed", "accepted", "assigned", "in_progress",
    "blocked", "in_review", "merged", "done", "cancelled",
  ] as const;

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
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this task action. Required for worker task writes."),
    },
    async ({ title, description, created_by: _createdBy, source_message_id, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
        };
      }

      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const task = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks`,
        options: {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            created_by: identity.actor_label,
            actor_label: identity.actor_label,
            actor_key: identity.canonical_key,
            actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
            source_message_id,
            ...agentSessionCredentials(agentSession),
          }),
        },
      });
      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity),
        agentSession
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: true, task, agent_identity: toPublicAgentIdentity(identity) },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_board",
    "Get the current task board for the room. By default shows only open tasks " +
      "(not done/cancelled). Agents should check this on startup and when idle to " +
      "see if there is unassigned work to claim.",
    {
      status: z.enum(TASK_STATUSES).optional().describe("Filter by specific status"),
      open_only: z.boolean().optional().describe("If true (default), only show tasks not done/cancelled"),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ status, open_only, room_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
        };
      }

      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (open_only !== false) params.set("open", "true");

      // Paginate through all pages to return the full board
      const allTasks: unknown[] = [];
      let afterCursor: string | undefined;

      for (;;) {
        const pageParams = new URLSearchParams(params);
        if (afterCursor) pageParams.set("after", afterCursor);
        const qs = pageParams.toString();

        const result = await roomScopedApiCall<{
          tasks?: Array<{ id?: string }>;
          has_more?: boolean;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks${qs ? `?${qs}` : ""}`,
          project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks${qs ? `?${qs}` : ""}`,
        });

        const tasks = result.tasks ?? [];
        allTasks.push(...tasks);

        if (!result.has_more || tasks.length === 0) break;
        const lastTask = tasks[tasks.length - 1];
        if (!lastTask?.id) break;
        afterCursor = lastTask.id;
      }
      await heartbeatRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, await ensureAgentIdentity());

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, tasks: allTasks }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_room_events",
    "Get GitHub events for the room (PRs, issues, reviews, check runs, etc.). " +
      "Returns a paginated list of normalized GitHub events persisted from webhooks. " +
      "Use this to check what happened in the repo without parsing chat messages.",
    {
      event_type: z.string().optional().describe(
        "Filter by event type: pull_request, issue, issue_comment, pull_request_review, check_run, installation, installation_repositories, repository"
      ),
      object_id: z.string().optional().describe("Filter by GitHub object ID (e.g. PR number, issue number)"),
      actor: z.string().optional().describe("Filter by GitHub login of the actor"),
      since: z.string().optional().describe("ISO timestamp — only events after this time"),
      until: z.string().optional().describe("ISO timestamp — only events before this time"),
      after: z.string().optional().describe("Cursor event ID for pagination (from a previous response)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max events to return (default 50, max 100)"),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ event_type, object_id, actor, since, until, after, limit, room_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
        };
      }

      const qs = buildRoomEventsQueryString({
        event_type,
        object_id,
        actor,
        since,
        until,
        after,
        limit,
      });

      const result = await roomScopedApiCall<{
        events?: Array<Record<string, unknown>>;
        has_more?: boolean;
      }>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/events${qs ? `?${qs}` : ""}`,
        project_path: (targetProjectId) => `/rooms/${encodeURIComponent(targetProjectId)}/events${qs ? `?${qs}` : ""}`,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, events: result.events ?? [], has_more: result.has_more ?? false }, null, 2) }],
      };
    }
  );

  server.tool(
    "claim_task",
    "Claim an accepted task. The task must be in 'accepted' " +
      "status. This sets the assignee to you and moves the status to 'assigned'. " +
      "Do NOT claim proposed tasks — they need to be accepted first.",
    {
      task_id: z.string().describe("The task ID to claim, e.g. 'task_1'"),
      assignee: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this task action. Required for worker task writes."),
    },
    async ({ task_id, assignee: _assignee, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId ?? currentRoom?.room_id ?? null,
          agentSessionId: agent_session_id,
        });
        const updated = await roomScopedApiCall({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
          project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
          options: {
            method: "PATCH",
            body: JSON.stringify({
              status: "assigned",
              assignee: identity.actor_label,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
              assignee_agent_key: identity.canonical_key,
              ...agentSessionCredentials(agentSession),
            }),
          },
        });
        await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
          status: "working",
          status_text: `claimed ${task_id}`,
        }, agentSession);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, task: updated, agent_identity: toPublicAgentIdentity(identity) },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
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
        .array(
          z.object({
            provider: z.enum(["github", "gitlab", "bitbucket", "unknown"]),
            kind: z.enum(["issue", "branch", "pull_request", "merge_request", "review", "check_run", "merge"]),
            id: z.string().nullable().optional(),
            number: z.number().int().nullable().optional(),
            title: z.string().nullable().optional(),
            url: z.string().nullable().optional(),
            ref: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
          }).strict()
        )
        .max(32)
        .optional()
        .describe("Persisted provider-neutral task workflow artifacts to attach to the task"),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this task action. Required for worker task writes."),
    },
    async ({ task_id, status, assignee, pr_url, workflow_artifacts, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId ?? currentRoom?.room_id ?? null,
          agentSessionId: agent_session_id,
        });
        const nextAssignee = status === "assigned" && !assignee ? identity.actor_label : assignee;
        const nextAssigneeAgentKey =
          nextAssignee === identity.actor_label ? identity.canonical_key : undefined;
        const updated = await roomScopedApiCall({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
          project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
          options: {
            method: "PATCH",
            body: JSON.stringify({
              status,
              assignee: nextAssignee,
              assignee_agent_key: nextAssigneeAgentKey,
              pr_url,
              workflow_artifacts,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          },
        });
        await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
          status: deriveTaskPresenceStatus(
            status ?? null,
            getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity).status
          ),
          status_text: status
            ? `${task_id} -> ${status}`
            : getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity).status_text,
        }, agentSession);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  task: updated,
                  agent_identity: toPublicAgentIdentity(identity),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
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
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this task action. Required for worker task writes."),
    },
    async ({ task_id, pr_url, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId ?? currentRoom?.room_id ?? null,
          agentSessionId: agent_session_id,
        });
        const updated = await roomScopedApiCall({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
          project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
          options: {
            method: "PATCH",
            body: JSON.stringify({
              status: "in_review",
              pr_url,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          },
        });
        await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
          status: "reviewing",
          status_text: `${task_id} -> in_review`,
        }, agentSession);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                task: updated,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
      }
    }
  );

  server.tool(
    "claim_task_review",
    "Claim board review authority for a task in review. This creates a review lease " +
      "for the registered worker session and is rejected if the worker holds the active work lease.",
    {
      task_id: z.string().describe("The task to review, e.g. 'task_1'"),
      reason: z.string().optional().describe("Why this worker is taking review authority"),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this review action. Required for worker review writes."),
    },
    async ({ task_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      if (!targetRoomId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a canonical room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId,
          agentSessionId: agent_session_id,
        });
        const result = await apiCall<{
          action: "claim";
          task: Record<string, unknown>;
          lease: Record<string, unknown> | null;
        }>(
          `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}/review-lease-action`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "claim",
              reason,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          }
        );
        await syncRoomPresence(targetRoomId, identity, {
          status: "reviewing",
          status_text: `reviewing ${task_id}`,
        }, agentSession);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                ...result,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
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
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this review action. Required for worker review writes."),
    },
    async ({ task_id, lease_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      if (!targetRoomId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a canonical room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId,
          agentSessionId: agent_session_id,
        });
        const result = await apiCall<{
          action: "release";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
        }>(
          `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}/review-lease-action`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "release",
              lease_id: lease_id ?? undefined,
              reason,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          }
        );
        await syncRoomPresence(targetRoomId, identity, {
          status: "idle",
          status_text: `released review on ${task_id}`,
        }, agentSession);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                ...result,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
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
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this lease action. Required for worker lease writes."),
    },
    async ({ task_id, lease_id, reason, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      if (!targetRoomId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a canonical room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId,
          agentSessionId: agent_session_id,
        });
        const result = await apiCall<{
          action: "release";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
        }>(
          `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}/lease-action`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "release",
              lease_id: lease_id ?? undefined,
              reason,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          }
        );
        await syncRoomPresence(targetRoomId, identity, {
          status: "working",
          status_text: `released lease on ${task_id}`,
        }, agentSession);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                ...result,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
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
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
      conversation_id: z.string().optional().describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z.string().optional().describe("Registered agent session to use for this lease action. Required for worker lease writes."),
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
    }) => {
      const targetRoomId = getTargetRoomId(room_id);
      if (!targetRoomId) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a canonical room." }) }],
        };
      }

      try {
        const { identity, agentSession } = await resolveWorkerToolIdentity({
          roomId: targetRoomId,
          agentSessionId: agent_session_id,
        });
        const result = await apiCall<{
          action: "handoff";
          task: Record<string, unknown>;
          released_lease: Record<string, unknown> | null;
          new_lease: Record<string, unknown> | null;
        }>(
          `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}/lease-action`,
          {
            method: "POST",
            body: JSON.stringify({
              action: "handoff",
              lease_id: lease_id ?? undefined,
              reason,
              target_actor_key: target_agent_key,
              target_actor_instance_id: target_actor_instance_id ?? undefined,
              target_agent_session_id: target_agent_session_id ?? undefined,
              actor_label: identity.actor_label,
              actor_key: identity.canonical_key,
              actor_instance_id: agentSession?.agent_instance_id || AGENT_INSTANCE_UUID,
              ...agentSessionCredentials(agentSession),
            }),
          }
        );
        await syncRoomPresence(targetRoomId, identity, {
          status: "working",
          status_text: `handed off ${task_id} to ${target_agent_key}`,
        }, agentSession);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                ...result,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        };
      }
    }
  );
}
