import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildRoomEventsQueryString } from "../../../room-events-query.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import { roomScopedApiCall } from "../../runtime.js";
import { resolveTaskToolTarget } from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";

export function registerTaskEventTools(server: McpServer): void {
  server.tool(
    "get_room_events",
    "Get GitHub events for the room (PRs, issues, reviews, check runs, etc.). " +
      "Returns a paginated list of normalized GitHub events persisted from webhooks. " +
      "Use this to check what happened in the repo without parsing chat messages.",
    {
      event_type: z.string().optional().describe(
        "Filter by event type: pull_request, issue, issue_comment, pull_request_review, check_run, installation, installation_repositories, repository, push, create, delete"
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
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room. Join one first.");

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
        room_id: target.roomId,
        project_id: target.projectId,
        room_path: (roomId) => `/rooms/${encodeRoomIdPath(roomId)}/events${qs ? `?${qs}` : ""}`,
        project_path: (projectId) => `/rooms/${encodeURIComponent(projectId)}/events${qs ? `?${qs}` : ""}`,
      });

      return jsonToolResponse(
        { success: true, events: result.events ?? [], has_more: result.has_more ?? false },
        2
      );
    }
  );
}
