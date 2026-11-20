import type { Express, Response } from "express";

import { ApiError } from "../../../../shared/api/core.mjs";
import { AGENT_JOB_PROGRESS_STATES, isJobId } from "../../../../shared/api/jobs.mjs";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../request/agent-identity.js";
import { completeJobAsAgent, getJob, updateJobAsAgent } from "../../jobs/service.js";
import { resolveParticipantRoom, routeParam } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

export type JobAgentRouteDeps = Pick<RoomMessageRouteDeps, "resolveCanonicalRoomRequestId" | "resolveRoomRequestOrReply" | "resolveRoomOrReply" | "requireParticipant">;

// The agent side of LetAgents API jobs, for the `get_job`, `update_job` and
// `complete_job` MCP tools. These are room routes with the worker identity
// every other agent tool uses: /api/v1 accepts only people until the actor
// chain learns agents, and an agent's report is not a page or app call.

function fail(res: Response, error: unknown): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("[jobs]", error);
  res.status(500).json({ error: "Unable to read or update the job. Please retry." });
}

function jobIdParam(req: AuthenticatedRequest): string {
  const id = routeParam(req, 1);
  if (!isJobId(id)) throw new ApiError("not_found", "No job with this id in this room.");
  return id;
}

async function agentKey(req: AuthenticatedRequest, roomId: string): Promise<string> {
  const result = await requireWorkerRequestAgentIdentity({ req, room_id: roomId, body: req.body ?? {} });
  if (!result.ok) {
    throw new ApiError(result.status === 401 ? "unauthenticated" : result.status === 400 ? "invalid_input" : "not_granted", result.error);
  }
  return result.identity.agent_key;
}

function body(req: AuthenticatedRequest): Record<string, unknown> {
  const value = req.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalid_input", "The body must be a JSON object.");
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ApiError("invalid_input", `${field} must be a string.`);
  return value;
}

export function registerJobAgentRoutes(app: Express, deps: JobAgentRouteDeps): void {
  const room = (req: AuthenticatedRequest, res: Response) => resolveParticipantRoom(req, res, deps);

  app.get(/^\/rooms\/(.+)\/jobs\/(job_[0-9a-f]{32})$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      res.json({ job: await getJob(project.id, jobIdParam(req)) });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/jobs\/(job_[0-9a-f]{32})\/progress$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const input = body(req);
      const state = optionalString(input, "state");
      if (state !== undefined && !(AGENT_JOB_PROGRESS_STATES as readonly string[]).includes(state)) {
        throw new ApiError("invalid_input", `state must be one of: ${AGENT_JOB_PROGRESS_STATES.join(", ")}.`);
      }
      res.json({ job: await updateJobAsAgent({
        roomId: project.id,
        id: jobIdParam(req),
        agentKey: await agentKey(req, project.id),
        progress: optionalString(input, "progress"),
        state: state as typeof AGENT_JOB_PROGRESS_STATES[number] | undefined,
      }) });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/jobs\/(job_[0-9a-f]{32})\/complete$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const input = body(req);
      res.json({ job: await completeJobAsAgent({
        roomId: project.id,
        id: jobIdParam(req),
        agentKey: await agentKey(req, project.id),
        ...(Object.hasOwn(input, "result") ? { result: input.result } : {}),
        error: optionalString(input, "error"),
      }) });
    } catch (error) { fail(res, error); }
  });
}
