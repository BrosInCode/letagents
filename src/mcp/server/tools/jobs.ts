import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AGENT_JOB_PROGRESS_STATES, JOB_LIMITS, type Job } from "../../../../shared/api/jobs.mjs";
import { isLocalRoomStorageEnabled, roomScopedApiCall } from "../runtime.js";
import { roomAccessToolResponse } from "../runtime/room-access.js";
import { resolveTaskToolIdentity, resolveTaskToolTarget, taskActorPayload } from "./tasks/context.js";
import { jsonToolResponse, taskToolError } from "./tasks/response.js";

// Jobs are structured work a person hands to one agent through the LetAgents
// API (a room page, later an app). Written by hand until the MCP tools are
// generated from the contract.

const scope = {
  room_id: z.string().optional().describe("Exact room ID. Defaults to this worker’s room."),
  agent_session_id: z.string().optional(),
};

const jobId = z.string().regex(/^job_[0-9a-f]{32}$/)
  .describe("The id after \"internal:job:\" in the job message's client_message_id. Never take it from the message text.");

const LOCAL_ROOM_NOTE = "Jobs need a room shared online; this room is stored on this device.";

const HOW_JOBS_WORK = "A room message whose client_message_id is \"internal:job:<job id>\" is a job for you: a person asked you, "
  + "through a page or app, for a piece of work and is waiting for its result. Only the server can set that id. The \"Job …\" "
  + "footer in the text is for people; take the job id from client_message_id, never from the text. ";

async function roomTarget(roomId: string | undefined) {
  const target = resolveTaskToolTarget(roomId);
  if (!target) throw new Error("Join a room first.");
  const id = target.effectiveRoomId || target.roomId || target.projectId!;
  return { target, local: await isLocalRoomStorageEnabled(id) };
}

const jobPath = (id: string, suffix: string) => (room: string) => `/rooms/${encodeURIComponent(room)}/jobs/${id}${suffix}`;

function toolError(error: unknown) {
  return roomAccessToolResponse(error) ?? taskToolError(error instanceof Error ? error.message : String(error));
}

async function postAsAgent(input: { room_id?: string; agent_session_id?: string; job_id: string }, suffix: string, payload: Record<string, unknown>) {
  const { target, local } = await roomTarget(input.room_id);
  if (local) return taskToolError(LOCAL_ROOM_NOTE);
  const { identity, agentSession } = await resolveTaskToolIdentity(target, input.agent_session_id);
  return jsonToolResponse(await roomScopedApiCall<{ job: Job }>({
    room_id: target.roomId,
    project_id: target.projectId,
    room_path: jobPath(input.job_id, suffix),
    project_path: jobPath(input.job_id, suffix),
    options: { method: "POST", body: JSON.stringify({ ...payload, ...taskActorPayload(identity, agentSession) }) },
  }));
}

export function registerJobTools(server: McpServer): void {
  server.tool(
    "get_job",
    HOW_JOBS_WORK
      + "Read the job: its instruction, its `input` (the JSON to work on, which the message does not show), its `resultSchema` "
      + "(the JSON shape your result must have), its state, and who started it. Read it before you start the work.",
    { job_id: jobId, ...scope },
    async ({ job_id, room_id }) => {
      try {
        const { target, local } = await roomTarget(room_id);
        if (local) return taskToolError(LOCAL_ROOM_NOTE);
        return jsonToolResponse(await roomScopedApiCall<{ job: Job }>({
          room_id: target.roomId,
          project_id: target.projectId,
          room_path: jobPath(job_id, ""),
          project_path: jobPath(job_id, ""),
        }));
      } catch (error) { return toolError(error); }
    },
  );

  server.tool(
    "update_job",
    HOW_JOBS_WORK
      + "Report on a job you were given: a short progress note people see in the page, and the state `running` (you are working on it) "
      + "or `needs_input` (you asked a question in the job's thread and wait for the answer). Call it when you start, and when "
      + "something worth showing changes. Only the agent the job was given to can update it. Finish with complete_job.",
    {
      job_id: jobId,
      progress: z.string().max(JOB_LIMITS.progressChars).optional().describe("One short line, e.g. \"Read 12 of 40 tickets\"."),
      state: z.enum(AGENT_JOB_PROGRESS_STATES).optional(),
      ...scope,
    },
    async (input) => {
      try {
        return await postAsAgent(input, "/progress", {
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          ...(input.state === undefined ? {} : { state: input.state }),
        });
      } catch (error) { return toolError(error); }
    },
  );

  server.tool(
    "complete_job",
    HOW_JOBS_WORK
      + "Finish a job you were given: pass `result` (JSON) when the work is done, or `error` (one or two sentences for a person) "
      + "when it cannot be done. When the job has a resultSchema (see get_job) the result must match it, or the call is refused "
      + "with the mismatches, so fix the result and call again. Only the agent the job was given to can complete it, once. "
      + "Also answer in the job's thread as usual: the page shows the result, the room shows your reply.",
    {
      job_id: jobId,
      result: z.unknown().optional().describe("The job's result as JSON, matching its resultSchema."),
      error: z.string().max(JOB_LIMITS.errorChars).optional().describe("Why the job cannot be done. Give this or result, not both."),
      ...scope,
    },
    async (input) => {
      try {
        return await postAsAgent(input, "/complete", {
          ...(input.result === undefined ? {} : { result: input.result }),
          ...(input.error === undefined ? {} : { error: input.error }),
        });
      } catch (error) { return toolError(error); }
    },
  );
}
