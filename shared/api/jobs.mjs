// Jobs: structured work handed to an agent in the room.
// Methods are added here with defineMethod from ./core.mjs; see docs/api/README.md.
import { z } from "zod";

import { ActorPrincipal, ActorVia } from "./actor.mjs";
import { defineMethod, queryInt } from "./core.mjs";

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
  /** Nesting of `input` and `result`, so no step that walks them can run out of stack. */
  jsonDepth: 32,
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

/**
 * Whether a JSON value nests deeper than `limit` objects or arrays. Walks level
 * by level without recursion, so a hostile value cannot exhaust the stack.
 * @param {unknown} value
 * @param {number} limit
 * @returns {boolean}
 */
export function jsonNestsDeeperThan(value, limit) {
  let level = typeof value === "object" && value !== null ? [value] : [];
  for (let depth = 1; level.length > 0; depth++) {
    if (depth > limit) return true;
    /** @type {object[]} */
    const next = [];
    for (const node of level) {
      for (const child of Object.values(node)) if (typeof child === "object" && child !== null) next.push(child);
    }
    level = next;
  }
  return false;
}

/**
 * A job id or a line that reads like the job footer. The server writes the
 * footer; an instruction that carried one could point the agent at another job.
 */
const FOOTER_LIKE = /job_[0-9a-f]{32}|^Job /im;

/**
 * @param {string} instruction
 * @returns {boolean}
 */
export function instructionLooksLikeJobFooter(instruction) {
  return FOOTER_LIKE.test(instruction);
}

const JsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
// A result schema's property names become object keys when it is converted.
const PropertyName = z.string().min(1).max(100).regex(/^(?!(?:__proto__|constructor|prototype)$)/, "This property name is reserved.");

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
    return z.record(PropertyName, JobResultSchema).optional();
  },
  required: z.array(PropertyName).max(100).optional(),
  additionalProperties: z.boolean().optional(),
  /** @returns {z.ZodOptional<typeof JobResultSchema>} */
  get items() {
    return JobResultSchema.optional();
  },
});

/** @typedef {z.infer<typeof JobResultSchema>} JobResultSchema */

// Each schema level is two JSON levels (`properties` then the name); the
// exact level count is checked on the server once this bound has held.
const RESULT_SCHEMA_JSON_DEPTH = JOB_LIMITS.resultSchemaDepth * 2 + 2;

/**
 * A result schema as a caller sends it: refused before it is parsed when it
 * nests too deep, since parsing a recursive schema recurses too.
 */
export const JobResultSchemaInput = z.preprocess((value, ctx) => {
  if (jsonNestsDeeperThan(value, RESULT_SCHEMA_JSON_DEPTH)) {
    ctx.issues.push({ code: "custom", message: `resultSchema nests deeper than ${JOB_LIMITS.resultSchemaDepth} levels.`, input: value });
    return z.NEVER;
  }
  // zod drops a "__proto__" key from a record without a word; say so instead.
  if (hasOwnKeyAnywhere(value, "__proto__")) {
    ctx.issues.push({ code: "custom", message: "resultSchema may not use the property name \"__proto__\".", input: value });
    return z.NEVER;
  }
  return value;
}, JobResultSchema);

/**
 * @param {unknown} value already bounded in depth
 * @param {string} key
 * @returns {boolean}
 */
function hasOwnKeyAnywhere(value, key) {
  /** @type {unknown[]} */
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Object.hasOwn(node, key)) return true;
    pending.push(...Object.values(node));
  }
  return false;
}

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
    + "must match it. The instruction may not contain a job id or a line that starts with \"Job \": the server writes "
    + "the job's footer itself. Read the job again with jobs.get, or wait for the `jobs` event.",
  path: "/rooms/:room/jobs",
  input: z.strictObject({
    agent: z.string().min(1).max(300).optional(),
    instruction: z.string().trim().min(1).max(JOB_LIMITS.instructionChars),
    input: z.unknown().optional(),
    resultSchema: JobResultSchemaInput.optional(),
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
    limit: queryInt({ min: 1, max: 100, default: 20 }),
  }),
  output: z.object({ jobs: z.array(Job) }),
  rateClass: "read",
});

export const cancelJob = defineMethod({
  name: "jobs.cancel",
  area: "jobs",
  kind: "write",
  capability: "jobs.read",
  description:
    "Cancel a job that has not finished. A page or app may cancel only the jobs started through it, for the same "
    + "person; a person acting directly may cancel the jobs they started, and a room admin any job. A finished job "
    + "answers `conflict`.",
  path: "/rooms/:room/jobs/:id/cancel",
  input: z.strictObject({ id: z.string().min(1).max(100) }),
  output: Job,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const methods = /** @type {const} */ ([startJob, getJob, listJobs, cancelJob]);
