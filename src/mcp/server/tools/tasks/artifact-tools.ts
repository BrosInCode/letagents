import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { encodeRoomIdPath } from "../../../room-id.js";
import { roomScopedApiCall } from "../../runtime.js";
import { resolveTaskToolTarget } from "./context.js";
import { jsonToolResponse, taskToolError } from "./response.js";
import { workflowArtifactSchema } from "./schemas.js";

function buildRoomArtifactsQueryString(input: {
  task_id?: string;
  limit?: number;
}): string {
  const params = new URLSearchParams();
  if (input.task_id) params.set("task_id", input.task_id);
  if (input.limit) params.set("limit", String(input.limit));
  return params.toString();
}

export function registerTaskArtifactTools(server: McpServer): void {
  server.tool(
    "get_room_artifacts",
    "Get shared workflow artifacts for the room. Returns provider-neutral artifacts such as PRs, branches, issues, checks, and their linked task IDs.",
    {
      task_id: z.string().optional().describe("Optional task ID to filter artifacts linked to that task."),
      limit: z.number().int().min(1).max(250).optional().describe("Max artifacts to return (default 100, max 250)."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ task_id, limit, room_id }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room. Join one first.");

      const qs = buildRoomArtifactsQueryString({ task_id, limit });
      const result = await roomScopedApiCall<{
        room_id?: string;
        artifacts?: Array<Record<string, unknown>>;
      }>({
        room_id: target.roomId,
        project_id: target.projectId,
        room_path: (roomId) => `/rooms/${encodeRoomIdPath(roomId)}/artifacts${qs ? `?${qs}` : ""}`,
        project_path: (projectId) => `/rooms/${encodeURIComponent(projectId)}/artifacts${qs ? `?${qs}` : ""}`,
      });

      return jsonToolResponse(
        {
          success: true,
          room_id: result.room_id ?? target.projectId,
          artifacts: result.artifacts ?? [],
        },
        2
      );
    }
  );

  server.tool(
    "publish_room_artifact",
    "Publish a provider-neutral Git workflow artifact into the shared room artifact list. Use this for branches, PRs, issues, reviews, checks, or merges that should be visible to the room even if they were not created through a task update or GitHub webhook.",
    {
      artifact: workflowArtifactSchema.describe(
        "Artifact to publish. It must include provider, kind, and at least one stable identity: url, id, number, or ref."
      ),
      task_id: z.string().optional().describe("Optional task ID to link to this artifact."),
      linked_task_ids: z
        .array(z.string())
        .max(32)
        .optional()
        .describe("Optional task IDs to link to this artifact."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    },
    async ({ artifact, task_id, linked_task_ids, room_id }) => {
      const target = resolveTaskToolTarget(room_id);
      if (!target) return taskToolError("Not in a room. Join one first.");

      try {
        const result = await roomScopedApiCall<{
          room_id?: string;
          artifact?: Record<string, unknown>;
        }>({
          room_id: target.roomId,
          project_id: target.projectId,
          room_path: (roomId) => `/rooms/${encodeRoomIdPath(roomId)}/artifacts`,
          project_path: (projectId) => `/rooms/${encodeURIComponent(projectId)}/artifacts`,
          options: {
            method: "POST",
            body: JSON.stringify({
              artifact,
              task_id,
              linked_task_ids,
            }),
          },
        });

        return jsonToolResponse(
          {
            success: true,
            room_id: result.room_id ?? target.projectId,
            artifact: result.artifact ?? null,
          },
          2
        );
      } catch (error) {
        return taskToolError(String(error));
      }
    }
  );
}
