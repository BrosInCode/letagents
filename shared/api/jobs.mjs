// Jobs: structured work handed to an agent in the room.
// Methods are added here with defineMethod from ./core.mjs; see docs/api/README.md.
import { z } from "zod";

import { ActorPrincipal, ActorVia } from "./actor.mjs";
import { defineMethod } from "./core.mjs";

/**
 * - `queued`: posted to the agent; it has not said it started.
 * - `no_agent`: no agent was online in the room, so nothing was posted.
 * - `running`, `needs_input`: the agent is on it, or waits for a person in the job's thread.
 * - `done`, `failed`, `cancelled`: finished; a finished job never changes again.
 */
export const JOB_STATES = /** @type {const} */ (["queued", "no_agent", "running", "needs_input", "done", "failed", "cancelled"]);
export const FINISHED_JOB_STATES = /** @type {const} */ (["done", "failed", "cancelled"]);
/** The states an agent may set while it works; `complete_job` sets `done` or `failed`. */
export const AGENT_JOB_PROGRESS_STATES = /** @type {const} */ (["running", "needs_input"]);

/** @typedef {typeof JOB_STATES[number]} JobState */

export const JOB_LIMITS = Object.freeze({
  instructionChars: 8_000,
  /** Serialized JSON bytes. */
  inputBytes: 32 * 1024,
  resultSchemaBytes: 8 * 1024,
  resultSchemaDepth: 6,
  resultBytes: 64 * 1024,
  progressChars: 500,
  errorChars: 2_000,
});

/** The message id prefix the job's thread root carries as its client message id. */
export const JOB_CLIENT_MESSAGE_ID_PREFIX = "internal:job:";

const JOB_ID = /^job_[0-9a-f]{32}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isJobId(value) {
  return typeof value === "string" && JOB_ID.test(value);
}

/**
 * The job a message is the thread root of, from its client message id; null for any other message.
 * @param {unknown} clientMessageId
 * @returns {string | null}
 */
export function jobIdFromClientMessageId(clientMessageId) {
  if (typeof clientMessageId !== "string" || !clientMessageId.startsWith(JOB_CLIENT_MESSAGE_ID_PREFIX)) return null;
  const id = clientMessageId.slice(JOB_CLIENT_MESSAGE_ID_PREFIX.length);
  return isJobId(id) ? id : null;
}

const JsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * The part of JSON Schema a job's result schema may use: `type` (object,
 * array, string, number, integer, boolean, null), `properties`, `required`,
 * `additionalProperties` (true or false), `items`, `enum` and `description`.
 * Anything else, such as `pattern` or `$ref`, is refused, so a schema can
 * never make the server do unbounded work.
 */
export const JobResultSchema = z.strictObject({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
  description: z.string().max(500).optional(),
  enum: z.array(JsonScalar).min(1).max(100).optional(),
  /** @returns {z.ZodOptional<z.ZodRecord<z.ZodString, typeof JobResultSchema>>} */
  get properties() {
    return z.record(z.string().min(1).max(100), JobResultSchema).optional();
  },
  required: z.array(z.string().min(1).max(100)).max(100).optional(),
  additionalProperties: z.boolean().optional(),
  /** @returns {z.ZodOptional<typeof JobResultSchema>} */
  get items() {
    return JobResultSchema.optional();
  },
});

/** @typedef {z.infer<typeof JobResultSchema>} JobResultSchema */

export const JobCreator = z.object({
  principal: ActorPrincipal.pick({ kind: true, id: true }),
  via: ActorVia.optional(),
});

export const Job = z.object({
  id: z.string(),
  roomId: z.string(),
  state: z.enum(JOB_STATES),
  /** The agent key the job went to; null when no agent was online. */
  agent: z.string().nullable(),
  instruction: z.string(),
  input: z.unknown(),
  resultSchema: JobResultSchema.nullable(),
  /** The agent's latest progress note. */
  progress: z.string().nullable(),
  /** What the agent returned; it matches `resultSchema` when there is one. */
  result: z.unknown(),
  error: z.string().nullable(),
  /** The thread root the job posted (`msg_<n>`): the job's conversation. Null for `no_agent`. */
  messageId: z.string().nullable(),
  createdBy: JobCreator,
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});

/** @typedef {z.infer<typeof JobCreator>} JobCreator */
/** @typedef {z.infer<typeof Job>} Job */

export const startJob = defineMethod({
  name: "jobs.start",
  area: "jobs",
  kind: "job",
  capability: "jobs.start",
  description:
    "Ask one agent in the room to do a piece of work for the viewer. The server picks the agent: the one named in `agent` "
    + "(an agent key) when it is online, otherwise the viewer's most recent agent partner when online, otherwise the first "
    + "online agent. It posts the instruction in the room as the viewer, as a new thread that mentions that agent, and the "
    + "agent answers in that thread and reports through the job. When no agent is online the job is saved with state "
    + "`no_agent` and nothing is posted. `input` is any JSON the agent should work on. `resultSchema` describes the JSON "
    + "result you expect (type, properties, required, additionalProperties, items, enum, description); the agent's result "
    + "must match it. Read the job again with jobs.get, or wait for the `jobs` event.",
  path: "/rooms/:room/jobs",
  input: z.strictObject({
    agent: z.string().min(1).max(300).optional(),
    instruction: z.string().trim().min(1).max(JOB_LIMITS.instructionChars),
    input: z.unknown().optional(),
    resultSchema: JobResultSchema.optional(),
  }),
  output: Job,
  errors: ["too_large"],
  rateClass: "job",
});

export const getJob = defineMethod({
  name: "jobs.get",
  area: "jobs",
  kind: "read",
  capability: "jobs.read",
  description: "One job in this room by id: its state, the agent's latest progress note, and its result or error once it finished.",
  path: "/rooms/:room/jobs/:id",
  input: z.strictObject({ id: z.string().min(1).max(100) }),
  output: Job,
  errors: ["not_found"],
  rateClass: "read",
});

export const listJobs = defineMethod({
  name: "jobs.list",
  area: "jobs",
  kind: "read",
  capability: "jobs.read",
  description: "Jobs in this room, newest first, optionally only those in one state. `limit` is 1 to 100 (default 20).",
  path: "/rooms/:room/jobs",
  input: z.strictObject({
    state: z.enum(JOB_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  output: z.object({ jobs: z.array(Job) }),
  rateClass: "read",
});

export const cancelJob = defineMethod({
  name: "jobs.cancel",
  area: "jobs",
  kind: "write",
  capability: "jobs.start",
  description:
    "Cancel a job that has not finished. Only the person who started it, or a room admin, may cancel it. "
    + "A finished job answers `conflict`.",
  path: "/rooms/:room/jobs/:id/cancel",
  input: z.strictObject({ id: z.string().min(1).max(100) }),
  output: Job,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const methods = /** @type {const} */ ([startJob, getJob, listJobs, cancelJob]);
