// The core of the LetAgents API contract: how a method is described, the one
// error shape, and the rate classes. Server routes, client types, the page
// bridge and MCP tool schemas all read these definitions; none restates them.
import { z } from "zod";

import { isCapabilityName } from "./capabilities.mjs";

/** Inside `api: 1` the contract only grows; the compatibility test enforces it. */
export const API_VERSION = 1;

export const API_AREAS = /** @type {const} */ ([
  "rooms",
  "people",
  "agents",
  "messages",
  "tasks",
  "planning",
  "work_items",
  "git",
  "memory",
  "data",
  "intents",
  "jobs",
  "events",
  "pages",
]);

/**
 * - `read`: returns room data, changes nothing.
 * - `intent`: proposes a write; room policy decides and an executor does it.
 * - `job`: hands structured work to an agent.
 * - `write`: changes LetAgents-owned data directly (documents, page settings).
 */
export const METHOD_KINDS = /** @type {const} */ (["read", "intent", "job", "write"]);

export const HTTP_VERBS = /** @type {const} */ (["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * - `json`: one JSON body, checked against `output`.
 * - `stream`: the handler writes the response itself (server-sent events);
 *   `output` describes one event's data.
 */
export const RESPONSE_KINDS = /** @type {const} */ (["json", "stream"]);

/**
 * Per-actor limits. A method names its class; the server counts each actor
 * (principal plus page, job or integration) per class.
 */
export const RATE_CLASSES = Object.freeze({
  read: Object.freeze({ limit: 300, windowMs: 60_000 }),
  search: Object.freeze({ limit: 30, windowMs: 60_000 }),
  write: Object.freeze({ limit: 120, windowMs: 60_000 }),
  post: Object.freeze({ limit: 20, windowMs: 60_000 }),
  intent: Object.freeze({ limit: 30, windowMs: 60_000 }),
  job: Object.freeze({ limit: 10, windowMs: 60_000 }),
});

/**
 * The plan's codes, plus the three every HTTP API needs: `invalid_input`
 * (the input does not match the method's schema), `unauthenticated` (no
 * sign-in) and `internal` (a server fault; the message says nothing more).
 */
export const API_ERROR_CODES = /** @type {const} */ ([
  "invalid_input",
  "unauthenticated",
  "not_granted",
  "not_participant",
  "not_found",
  "no_source",
  "source_unavailable",
  "rate_limited",
  "conflict",
  "too_large",
  "declined",
  "pending_approval",
  "internal",
]);

/** @typedef {typeof API_AREAS[number]} ApiArea */
/** @typedef {typeof METHOD_KINDS[number]} MethodKind */
/** @typedef {typeof HTTP_VERBS[number]} HttpVerb */
/** @typedef {typeof RESPONSE_KINDS[number]} ResponseKind */
/** @typedef {keyof typeof RATE_CLASSES} RateClass */
/** @typedef {typeof API_ERROR_CODES[number]} ApiErrorCode */
/** @typedef {import("./capabilities.mjs").CapabilityName} CapabilityName */

/** @type {Readonly<Record<ApiErrorCode, number>>} */
export const API_ERROR_HTTP_STATUS = Object.freeze({
  invalid_input: 400,
  unauthenticated: 401,
  not_granted: 403,
  not_participant: 403,
  declined: 403,
  pending_approval: 403,
  not_found: 404,
  no_source: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
  source_unavailable: 503,
});

/**
 * Codes any method may return without listing them: they come from the
 * shared route pipeline (input check, sign-in, the room in the URL, room
 * access, capability, rate limit), not from the method's own handler.
 */
export const COMMON_ERROR_CODES = /** @type {const} */ ([
  "invalid_input",
  "unauthenticated",
  "not_found",
  "not_participant",
  "not_granted",
  "rate_limited",
  "source_unavailable",
  "internal",
]);

export const ApiErrorBody = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});

/** @typedef {z.infer<typeof ApiErrorBody>} ApiErrorBody */

/** The error every API transport throws and answers with: `{ code, message, retryAfterMs? }`. */
export class ApiError extends Error {
  /**
   * @param {ApiErrorCode} code
   * @param {string} message
   * @param {{ retryAfterMs?: number, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    /** @type {ApiErrorCode} */
    this.code = code;
    /** @type {number | undefined} */
    this.retryAfterMs = options.retryAfterMs;
  }

  /** @returns {number} */
  get status() {
    return API_ERROR_HTTP_STATUS[this.code];
  }

  /** @returns {ApiErrorBody} */
  toBody() {
    return this.retryAfterMs === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfterMs: this.retryAfterMs };
  }

  /**
   * Rebuilds the error from a response body; anything else becomes `internal`.
   * @param {unknown} body
   * @returns {ApiError}
   */
  static fromBody(body) {
    const parsed = ApiErrorBody.safeParse(body);
    if (!parsed.success) return new ApiError("internal", "The server answered with an unknown error.");
    return new ApiError(parsed.data.code, parsed.data.message, { retryAfterMs: parsed.data.retryAfterMs });
  }
}

/**
 * One line per problem, with the field path first, for `invalid_input`
 * messages and manifest errors: `limit: Too big: expected number to be <=100`.
 * @param {{ issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>, message: string }> }} error
 * @returns {{ path: string, message: string }[]}
 */
export function describeIssues(error) {
  return error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}

/**
 * @param {ReadonlyArray<PropertyKey>} path
 * @returns {string}
 */
function formatIssuePath(path) {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * @template {string} [Name=string]
 * @template {z.ZodType} [Input=z.ZodType]
 * @template {z.ZodType} [Output=z.ZodType]
 * @typedef {{
 *   name: Name,
 *   area: ApiArea,
 *   kind: MethodKind,
 *   capability: CapabilityName,
 *   capabilityFromInput?(input: z.output<Input>): CapabilityName,
 *   description: string,
 *   path: string,
 *   httpMethod?: HttpVerb,
 *   response?: ResponseKind,
 *   input: Input,
 *   output: Output,
 *   errors?: readonly ApiErrorCode[],
 *   rateClass: RateClass,
 * }} MethodSpec
 */

/**
 * @template {string} [Name=string]
 * @template {z.ZodType} [Input=z.ZodType]
 * @template {z.ZodType} [Output=z.ZodType]
 * @typedef {{
 *   readonly name: Name,
 *   readonly area: ApiArea,
 *   readonly kind: MethodKind,
 *   readonly capability: CapabilityName,
 *   capabilityFromInput?(input: z.output<Input>): CapabilityName,
 *   readonly description: string,
 *   readonly path: string,
 *   readonly httpMethod: HttpVerb,
 *   readonly response: ResponseKind,
 *   readonly input: Input,
 *   readonly output: Output,
 *   readonly errors: readonly ApiErrorCode[],
 *   readonly rateClass: RateClass,
 * }} ApiMethod
 */

/** @typedef {ApiMethod<string, z.ZodType, z.ZodType>} AnyApiMethod */

const METHOD_NAME = /^[a-z][a-z_]*\.[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)*$/;
const PATH_PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Describes one API method. Every route is room-scoped: the path starts with
 * `/rooms/:room`, so access always resolves through the room in the URL.
 * Other `:params` in the path are input fields; the route fills them in.
 * @template {string} Name
 * @template {z.ZodType} Input
 * @template {z.ZodType} Output
 * @param {MethodSpec<Name, Input, Output>} spec
 * @returns {ApiMethod<Name, Input, Output>}
 */
export function defineMethod(spec) {
  const where = `API method ${JSON.stringify(spec.name)}`;
  if (typeof spec.name !== "string" || !METHOD_NAME.test(spec.name)) {
    throw new TypeError(`${where}: the name must look like "<area>.<verb>", for example "rooms.get".`);
  }
  if (!API_AREAS.includes(spec.area)) throw new TypeError(`${where}: unknown area ${JSON.stringify(spec.area)}.`);
  if (!spec.name.startsWith(`${spec.area}.`)) throw new TypeError(`${where}: the name must start with its area, "${spec.area}.".`);
  if (!METHOD_KINDS.includes(spec.kind)) throw new TypeError(`${where}: unknown kind ${JSON.stringify(spec.kind)}.`);
  if (!isCapabilityName(spec.capability)) {
    throw new TypeError(`${where}: unknown capability ${JSON.stringify(spec.capability)}; add it to shared/api/capabilities.mjs first.`);
  }
  if (spec.capabilityFromInput !== undefined && typeof spec.capabilityFromInput !== "function") {
    throw new TypeError(`${where}: capabilityFromInput must be a function of the parsed input.`);
  }
  if (typeof spec.description !== "string" || !spec.description.trim()) {
    throw new TypeError(`${where}: a description is required; MCP tools and the page reference are made from it.`);
  }
  if (!Object.prototype.hasOwnProperty.call(RATE_CLASSES, spec.rateClass)) {
    throw new TypeError(`${where}: unknown rate class ${JSON.stringify(spec.rateClass)}.`);
  }
  if (!(spec.input instanceof z.ZodType) || !(spec.output instanceof z.ZodType)) {
    throw new TypeError(`${where}: input and output must be zod schemas.`);
  }
  const httpMethod = spec.httpMethod ?? (spec.kind === "read" ? "GET" : "POST");
  if (!HTTP_VERBS.includes(httpMethod)) throw new TypeError(`${where}: unknown HTTP method ${JSON.stringify(httpMethod)}.`);
  if (spec.kind === "read" && httpMethod !== "GET") throw new TypeError(`${where}: a read is a GET.`);
  if (typeof spec.path !== "string" || !(spec.path === "/rooms/:room" || spec.path.startsWith("/rooms/:room/"))) {
    throw new TypeError(`${where}: the path must start with "/rooms/:room".`);
  }
  const response = spec.response ?? "json";
  if (!RESPONSE_KINDS.includes(response)) throw new TypeError(`${where}: unknown response kind ${JSON.stringify(response)}.`);
  const inputKeys = spec.input instanceof z.ZodObject ? Object.keys(spec.input.shape) : null;
  for (const [, param] of spec.path.matchAll(PATH_PARAM)) {
    if (param === "room") continue;
    if (!inputKeys?.includes(param)) throw new TypeError(`${where}: the path parameter ":${param}" must be a field of the input object.`);
  }
  const errors = [...(spec.errors ?? [])];
  for (const code of errors) {
    if (!API_ERROR_CODES.includes(code)) throw new TypeError(`${where}: unknown error code ${JSON.stringify(code)}.`);
  }
  return Object.freeze({
    name: spec.name,
    area: spec.area,
    kind: spec.kind,
    capability: spec.capability,
    ...(spec.capabilityFromInput ? { capabilityFromInput: spec.capabilityFromInput } : {}),
    description: spec.description.trim(),
    path: spec.path,
    httpMethod,
    response,
    input: spec.input,
    output: spec.output,
    errors: Object.freeze(errors),
    rateClass: spec.rateClass,
  });
}

/**
 * Whether a method may answer with this code: its own list or a common one.
 * @param {Pick<AnyApiMethod, "errors">} method
 * @param {ApiErrorCode} code
 * @returns {boolean}
 */
export function methodMayReturn(method, code) {
  return method.errors.includes(code) || /** @type {readonly string[]} */ (COMMON_ERROR_CODES).includes(code);
}

/**
 * JSON Schema (draft 2020-12) for a method's input and output. MCP tool
 * inputs use `input`; the compatibility snapshot stores both.
 * @param {Pick<AnyApiMethod, "input" | "output">} method
 * @returns {{ input: Record<string, unknown>, output: Record<string, unknown> }}
 */
export function toJsonSchema(method) {
  return {
    input: /** @type {Record<string, unknown>} */ (z.toJSONSchema(method.input, { io: "input" })),
    output: /** @type {Record<string, unknown>} */ (z.toJSONSchema(method.output, { io: "output" })),
  };
}

// ── Query-string inputs ─────────────────────────────────────────────────
// A GET or DELETE takes its input from the query string, where every value is
// a string; MCP and the page bridge send JSON numbers and booleans. These
// accept both and nothing else: no "" as 0, no "yes" as true.

const INTEGER_TEXT = /^-?\d{1,15}$/;

/**
 * @param {number} min
 * @param {number} max
 */
function queryIntSchema(min, max) {
  const int = z.number().int().min(min).max(max);
  return z.union([int, z.string().regex(INTEGER_TEXT).transform(Number).pipe(int)], {
    error: `Expected a whole number from ${min} to ${max}.`,
  });
}

function queryBoolSchema() {
  return z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")], {
    error: "Expected true or false.",
  });
}

/** @typedef {ReturnType<typeof queryIntSchema>} QueryInt */
/** @typedef {ReturnType<typeof queryBoolSchema>} QueryBool */

/**
 * A whole number from `min` to `max`, as a number or its decimal text.
 * @overload
 * @param {{ min: number, max: number }} options
 * @returns {QueryInt}
 */
/**
 * @overload
 * @param {{ min: number, max: number, default: number }} options
 * @returns {z.ZodDefault<QueryInt>}
 */
/**
 * @param {{ min: number, max: number, default?: number }} options
 * @returns {QueryInt | z.ZodDefault<QueryInt>}
 */
export function queryInt({ min, max, default: fallback }) {
  const schema = queryIntSchema(min, max);
  return fallback === undefined ? schema : schema.default(fallback);
}

/**
 * `true` or `false`, as a boolean or the exact text "true" or "false".
 * @overload
 * @param {{}} [options]
 * @returns {QueryBool}
 */
/**
 * @overload
 * @param {{ default: boolean }} options
 * @returns {z.ZodDefault<QueryBool>}
 */
/**
 * @param {{ default?: boolean }} [options]
 * @returns {QueryBool | z.ZodDefault<QueryBool>}
 */
export function queryBool({ default: fallback } = {}) {
  const schema = queryBoolSchema();
  return fallback === undefined ? schema : schema.default(fallback);
}

/**
 * Input fields of a GET or DELETE method that a query string could never
 * satisfy: a plain number or boolean, with no text form. Use queryInt and
 * queryBool instead.
 * @param {Pick<AnyApiMethod, "name" | "httpMethod" | "input">} method
 * @returns {string[]}
 */
export function queryInputProblems(method) {
  if (method.httpMethod !== "GET" && method.httpMethod !== "DELETE") return [];
  const schema = /** @type {{ properties?: Record<string, any> }} */ (z.toJSONSchema(method.input, { io: "input" }));
  /** @type {string[]} */
  const problems = [];
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const values = property.type === "array" && property.items ? property.items : property;
    const alternatives = /** @type {any[]} */ (values.anyOf ?? values.oneOf ?? [values]);
    const types = alternatives.flatMap((alt) => (Array.isArray(alt.type) ? alt.type : [alt.type]));
    const textForm = types.includes("string") || types.includes(undefined);
    const plain = types.filter((type) => type === "number" || type === "integer" || type === "boolean");
    if (plain.length && !textForm) {
      problems.push(`${method.name}: the query field "${field}" is a plain ${plain[0]}; use queryInt() or queryBool().`);
    }
  }
  return problems;
}
