import { randomBytes } from "node:crypto";

import type { ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import {
  JOB_CLIENT_MESSAGE_ID_PREFIX,
  JOB_LIMITS,
  type AGENT_JOB_PROGRESS_STATES,
  type Job,
  type JobResultSchema,
  type JobState,
  instructionLooksLikeJobFooter,
  jsonNestsDeeperThan,
} from "../../../shared/api/jobs.mjs";
import {
  getApiJob,
  insertApiJob,
  isFinishedJobState,
  listApiJobs,
  listOnlineRoomAgentKeys,
  recentAgentPartnerKey,
  updateUnfinishedApiJob,
  type ApiJobChange,
  type ApiJobRow,
} from "../db/api-jobs.js";
import { formatMessageId } from "../db/utils.js";
import { ROOM_RESOURCE_JOBS } from "../../../shared/room-resource-invalidation.mjs";
import { emitProjectMessage, queueRoomResourceInvalidation } from "../server/events.js";
import { requireJobStartAllowed } from "./policy.js";
import { assertJobResultSchemaBounds, jobResultProblems, jsonBytes } from "./result-schema.js";

export interface JobServiceDeps {
  listOnlineAgentKeys: typeof listOnlineRoomAgentKeys;
  recentAgentPartnerKey: typeof recentAgentPartnerKey;
  emitMessage: typeof emitProjectMessage;
  invalidate: (roomId: string) => void;
  now: () => string;
}

const defaultDeps: JobServiceDeps = {
  listOnlineAgentKeys: listOnlineRoomAgentKeys,
  recentAgentPartnerKey,
  emitMessage: emitProjectMessage,
  invalidate: (roomId) => queueRoomResourceInvalidation(roomId, ROOM_RESOURCE_JOBS),
  now: () => new Date().toISOString(),
};

export function newJobId(): string {
  return `job_${randomBytes(16).toString("hex")}`;
}

export function jobClientMessageId(jobId: string): string {
  return `${JOB_CLIENT_MESSAGE_ID_PREFIX}${jobId}`;
}

/**
 * One agent for a job, always exactly one, because a person's message that
 * names nobody wakes nobody in a room with more than two agents. The agent
 * the caller named, when online; else the caller's recent partner, when
 * online; else the first online agent. Null when no agent is online.
 */
export async function pickJobAgent(input: {
  requested?: string;
  online: readonly string[];
  recentPartner: () => Promise<string | null>;
}): Promise<string | null> {
  if (input.requested && input.online.includes(input.requested)) return input.requested;
  if (input.online.length === 0) return null;
  const partner = await input.recentPartner();
  if (partner && input.online.includes(partner)) return partner;
  return input.online[0]!;
}

/** The room text of a job's thread root: the exact mention first, so routing wakes that agent alone. */
export function jobRootText(agentKey: string, instruction: string, jobId: string, via: ApiActor["via"]): string {
  // Page titles arrive with the pages registry; until then the footer names what the call came through.
  return `@agent:${agentKey} ${instruction}\n\nJob ${jobId} · via ${via?.id ?? "API"}`;
}

export function toJob(row: ApiJobRow): Job {
  return {
    id: row.id,
    roomId: row.room_id,
    state: row.state,
    agent: row.target_agent_key,
    instruction: row.instruction,
    input: row.input ?? null,
    resultSchema: (row.result_schema as JobResultSchema | null) ?? null,
    progress: row.progress,
    result: row.result ?? null,
    error: row.error,
    messageId: row.root_message_number === null ? null : formatMessageId(row.root_message_number),
    createdBy: {
      principal: { kind: row.principal_kind, id: row.principal_id },
      ...(row.via_kind && row.via_id ? {
        via: { kind: row.via_kind, id: row.via_id, ...(row.via_version === null ? {} : { version: row.via_version }) },
      } : {}),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export async function startJob(
  input: {
    roomId: string;
    actor: ApiActor;
    /** How the room shows the person: the sender of the thread root. */
    senderLabel: string;
    agent?: string;
    instruction: string;
    input?: unknown;
    resultSchema?: JobResultSchema;
  },
  deps: JobServiceDeps = defaultDeps,
): Promise<Job> {
  await requireJobStartAllowed(input.actor, input.roomId);
  if (instructionLooksLikeJobFooter(input.instruction)) {
    throw new ApiError("invalid_input", "The instruction may not contain a job id or a line that starts with \"Job \".");
  }
  if (jsonNestsDeeperThan(input.input, JOB_LIMITS.jsonDepth)) {
    throw new ApiError("invalid_input", `input nests deeper than ${JOB_LIMITS.jsonDepth} levels.`);
  }
  if (input.input !== undefined && jsonBytes(input.input) > JOB_LIMITS.inputBytes) {
    throw new ApiError("too_large", `input is larger than ${JOB_LIMITS.inputBytes} bytes.`);
  }
  if (input.resultSchema) assertJobResultSchemaBounds(input.resultSchema);

  const online = await deps.listOnlineAgentKeys(input.roomId);
  const target = await pickJobAgent({
    requested: input.agent,
    online,
    recentPartner: () => deps.recentAgentPartnerKey(input.roomId, input.actor.principal.id, deps.now()),
  });
  const now = deps.now();
  const via = input.actor.via;
  const row: ApiJobRow = {
    id: newJobId(),
    room_id: input.roomId,
    principal_kind: input.actor.principal.kind,
    principal_id: input.actor.principal.id,
    via_kind: via?.kind ?? null,
    via_id: via?.id ?? null,
    via_version: via?.version ?? null,
    target_agent_key: target,
    instruction: input.instruction,
    input: input.input ?? null,
    result_schema: input.resultSchema ?? null,
    state: target ? "queued" : "no_agent",
    progress: null,
    result: null,
    error: null,
    root_message_number: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };

  if (!target) {
    // Nobody would read a post: keep the job so the page can say so, and post nothing.
    await insertApiJob(row);
    deps.invalidate(input.roomId);
    return toJob(row);
  }

  let saved: ApiJobRow | null = null;
  // The post and the job commit together: a job never points at a message
  // that does not exist, and a post never lacks its job.
  await deps.emitMessage(input.roomId, input.senderLabel, jobRootText(target, input.instruction, row.id, via), {
    source: "browser",
    account_id: input.actor.principal.id,
    client_message_id: jobClientMessageId(row.id),
    // The instruction is the person's text, and may say "@everyone" or name
    // other agents and people. Routing it would wake or notify them; the job
    // goes to its one agent alone, which gets the only receipt.
    addressed_to: { agent_key: target, reason: "explicit_mention" },
    with_created_message_in_transaction: async (tx, message) => {
      const withRoot = { ...row, root_message_number: message.number };
      await insertApiJob(withRoot, tx);
      saved = withRoot;
    },
  });
  if (!saved) throw new Error(`Job ${row.id} was not saved with its message.`);
  deps.invalidate(input.roomId);
  return toJob(saved);
}

export async function getJob(roomId: string, id: string): Promise<Job> {
  const row = await getApiJob(roomId, id);
  if (!row) throw new ApiError("not_found", "No job with this id in this room.");
  return toJob(row);
}

export async function listJobs(roomId: string, options: { state?: JobState; limit: number }): Promise<Job[]> {
  return (await listApiJobs(roomId, options)).map(toJob);
}

async function changeUnfinished(
  roomId: string,
  row: ApiJobRow,
  change: ApiJobChange,
  deps: Pick<JobServiceDeps, "invalidate" | "now">,
): Promise<Job> {
  if (isFinishedJobState(row.state)) throw new ApiError("conflict", `This job already finished (${row.state}).`);
  const updated = await updateUnfinishedApiJob(roomId, row.id, change, deps.now());
  if (!updated) throw new ApiError("conflict", "This job finished while the change was on its way.");
  deps.invalidate(roomId);
  return toJob(updated);
}

/**
 * Cancels a job that has not finished. Through a page or app: only a job
 * started through that same page or app, for the same person. A person acting
 * directly: their own jobs, or any job as a room admin.
 */
export async function cancelJob(
  input: { roomId: string; id: string; actor: ApiActor; isRoomAdmin: () => Promise<boolean> },
  deps: Pick<JobServiceDeps, "invalidate" | "now"> = defaultDeps,
): Promise<Job> {
  const row = await getApiJob(input.roomId, input.id);
  if (!row) throw new ApiError("not_found", "No job with this id in this room.");
  const creator = row.principal_kind === input.actor.principal.kind && row.principal_id === input.actor.principal.id;
  const via = input.actor.via;
  if (via) {
    // A page or app holds `jobs.read` to cancel, so it may stop only what it
    // started itself, never what the person started elsewhere or, as an
    // admin, anyone's job.
    if (!creator || row.via_kind !== via.kind || row.via_id !== via.id) {
      throw new ApiError("not_granted", "A page or app can cancel only the jobs started through it.");
    }
  } else if (!creator && !(await input.isRoomAdmin())) {
    throw new ApiError("not_granted", "Only the person who started this job, or a room admin, can cancel it.");
  }
  return changeUnfinished(input.roomId, row, { state: "cancelled", finished_at: deps.now() }, deps);
}

async function targetJob(roomId: string, id: string, agentKey: string): Promise<ApiJobRow> {
  const row = await getApiJob(roomId, id);
  if (!row) throw new ApiError("not_found", "No job with this id in this room.");
  if (row.target_agent_key !== agentKey) throw new ApiError("not_granted", "Only the agent this job was given to can report on it.");
  return row;
}

/** The target agent says how far it got, or that it waits for a person. */
export async function updateJobAsAgent(
  input: {
    roomId: string;
    id: string;
    agentKey: string;
    progress?: string;
    state?: typeof AGENT_JOB_PROGRESS_STATES[number];
  },
  deps: Pick<JobServiceDeps, "invalidate" | "now"> = defaultDeps,
): Promise<Job> {
  if (input.progress === undefined && input.state === undefined) {
    throw new ApiError("invalid_input", "Give progress, state or both.");
  }
  if (input.progress !== undefined && input.progress.length > JOB_LIMITS.progressChars) {
    throw new ApiError("invalid_input", `progress is longer than ${JOB_LIMITS.progressChars} characters.`);
  }
  const row = await targetJob(input.roomId, input.id, input.agentKey);
  return changeUnfinished(input.roomId, row, {
    // Any report means the agent took the job.
    state: input.state ?? (row.state === "queued" ? "running" : row.state),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  }, deps);
}

/**
 * The target agent finishes the job: `done` with a result that matches the
 * job's result schema, or `failed` with an error.
 */
export async function completeJobAsAgent(
  input: { roomId: string; id: string; agentKey: string; result?: unknown; error?: string },
  deps: Pick<JobServiceDeps, "invalidate" | "now"> = defaultDeps,
): Promise<Job> {
  if (input.result !== undefined && input.error !== undefined) {
    throw new ApiError("invalid_input", "Give a result or an error, not both.");
  }
  const row = await targetJob(input.roomId, input.id, input.agentKey);
  if (input.error !== undefined) {
    const error = input.error.trim();
    if (!error || error.length > JOB_LIMITS.errorChars) {
      throw new ApiError("invalid_input", `error must be 1 to ${JOB_LIMITS.errorChars} characters.`);
    }
    return changeUnfinished(input.roomId, row, { state: "failed", error, finished_at: deps.now() }, deps);
  }
  if (jsonNestsDeeperThan(input.result, JOB_LIMITS.jsonDepth)) {
    throw new ApiError("invalid_input", `result nests deeper than ${JOB_LIMITS.jsonDepth} levels.`);
  }
  if (jsonBytes(input.result) > JOB_LIMITS.resultBytes) {
    throw new ApiError("too_large", `result is larger than ${JOB_LIMITS.resultBytes} bytes.`);
  }
  const schema = row.result_schema as JobResultSchema | null;
  if (schema) {
    if (input.result === undefined) throw new ApiError("invalid_input", "This job expects a result that matches its resultSchema.");
    const problems = jobResultProblems(schema, input.result);
    if (problems.length > 0) {
      throw new ApiError("invalid_input", `The result does not match the job's resultSchema:\n${problems.join("\n")}`);
    }
  }
  return changeUnfinished(input.roomId, row, {
    state: "done",
    result: input.result ?? null,
    finished_at: deps.now(),
  }, deps);
}
