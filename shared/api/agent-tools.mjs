// Agents use the LetAgents API through two MCP tools made from this contract:
// `letagents_api_read` calls the methods flagged `agents: "read"` and
// `letagents_api_write` the methods flagged `agents: "write"`. One tool per
// method grew every agent's tool list by dozens of tools, and some clients cap
// a request at 128; two tools keep the read/write split that the read-only
// tool lists need, since those lists name tools, not arguments. A new flagged
// method needs no MCP code.
import { getCapability } from "./capabilities.mjs";
import { COMMON_ERROR_CODES, toJsonSchema } from "./core.mjs";
import { API_METHODS } from "./index.mjs";

/** @typedef {import("./index.mjs").KnownApiMethod} KnownApiMethod */
/** @typedef {import("./core.mjs").AgentAccess} AgentAccess */

/** The MCP tool that calls the flagged methods of each access. */
export const AGENT_API_TOOLS = Object.freeze({
  read: "letagents_api_read",
  write: "letagents_api_write",
});

/**
 * Methods whose MCP tool is written by hand, by the tool's name. The page
 * tools read a workspace file and take the snake_case names of the plan;
 * `get_job` came first, for the agent a job is given to. The API tools leave
 * these methods out; their flag still says that agents may call them.
 */
export const HAND_WRITTEN_AGENT_TOOLS = Object.freeze({
  "jobs.get": "get_job",
  "pages.list": "list_pages",
  "pages.document": "read_page",
  "pages.diagnostics": "read_page_diagnostics",
  "pages.create": "publish_page",
  "pages.publishVersion": "publish_page",
});

/**
 * The flagged methods the API tools call, in contract order; with `access`,
 * only those of one tool.
 * @param {readonly KnownApiMethod[]} [methods]
 * @param {AgentAccess} [access]
 * @returns {KnownApiMethod[]}
 */
export function agentToolMethods(methods = API_METHODS, access) {
  return methods.filter((method) => method.agents !== undefined
    && (access === undefined || method.agents === access)
    && !Object.hasOwn(HAND_WRITTEN_AGENT_TOOLS, method.name));
}

/** A method's line in its tool's description stays short: the tool lists them all on every turn. */
export const AGENT_METHOD_PURPOSE_CHARS = 60;

/**
 * One line of the tool's description: `tasks.get(taskId): One board task by id`.
 * Optional fields end in `?`. The purpose is the description's first sentence, cut short.
 * @param {Pick<import("./core.mjs").AnyApiMethod, "name" | "description" | "input">} method
 * @returns {string}
 */
export function agentMethodLine(method) {
  const shape = /** @type {Record<string, { isOptional?: () => boolean }>} */ (
    /** @type {{ shape?: Record<string, unknown> }} */ (method.input).shape ?? {});
  const fields = Object.entries(shape).map(([name, schema]) => schema.isOptional?.() ? `${name}?` : name);
  return `${method.name}(${fields.join(", ")}): ${methodPurpose(method.description)}`;
}

/** @param {string} description */
function methodPurpose(description) {
  const clause = description.split(/(?<=[a-z0-9)`"])\. /)[0].replace(/\.$/, "").replaceAll("`", "");
  if (clause.length <= AGENT_METHOD_PURPOSE_CHARS) return clause;
  const cut = clause.slice(0, AGENT_METHOD_PURPOSE_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,(]+$/, "")}…`;
}

/**
 * A method's full description: its own words for agents, then what the
 * server checks and what it can answer. The API tools give it on request
 * (describe: true) and with a refused input.
 * @param {Pick<import("./core.mjs").AnyApiMethod, "name" | "description" | "capability" | "capabilityFromInput" | "errors" | "kind" | "input" | "output">} method
 * @returns {string}
 */
export function agentToolDescription(method) {
  const own = method.errors.filter((code) => !(/** @type {readonly string[]} */ (COMMON_ERROR_CODES)).includes(code));
  const byInput = capabilitiesByInput(method);
  const capability = byInput
    ? `Capability by ${byInput.field}: ${byInput.text}.`
    : `Capability ${method.capability}: ${getCapability(method.capability).label.toLowerCase()}.`;
  return [
    method.description,
    `LetAgents API method ${method.name}, in the room you are in (or room_id). ${capability}`,
    method.kind === "read" ? "Reads only." : "",
    `Refusals are { success: false, error: <code>, message }${own.length ? `; this method's own codes: ${own.join(", ")}` : ""}; any method can also answer not_participant, not_granted, rate_limited (with retryAfterMs) or source_unavailable.`,
  ].filter(Boolean).join(" ");
}

/**
 * The API tools by name with the methods each calls, for lists that cannot
 * load zod (the desktop daemon's read-only lists).
 * @param {readonly KnownApiMethod[]} [methods]
 * @returns {{ name: string, access: AgentAccess, methods: string[] }[]}
 */
export function agentToolCatalog(methods = API_METHODS) {
  return /** @type {const} */ (["read", "write"]).map((access) => ({
    name: AGENT_API_TOOLS[access],
    access,
    methods: agentToolMethods(methods, access).map((method) => method.name),
  }));
}

/**
 * For a method whose capability follows its input (`capabilityFromInput`):
 * the input field that picks it and each capability with its values, found by
 * asking the method about every value of each enum field. `data.*`: by scope;
 * `intents.propose`: by kind.
 * @param {Pick<import("./core.mjs").AnyApiMethod, "capability" | "capabilityFromInput" | "input" | "output">} method
 * @returns {{ field: string, text: string } | null}
 */
export function capabilitiesByInput(method) {
  const pick = method.capabilityFromInput;
  if (!pick) return null;
  const properties = /** @type {Record<string, { enum?: unknown[] }>} */ (toJsonSchema(method).input.properties ?? {});
  for (const [field, property] of Object.entries(properties)) {
    if (!Array.isArray(property.enum)) continue;
    /** @type {Map<string, string[]>} */
    const byCapability = new Map();
    for (const value of property.enum) {
      let capability;
      try {
        capability = pick({ [field]: value }) ?? method.capability;
      } catch {
        continue;
      }
      byCapability.set(capability, [...(byCapability.get(capability) ?? []), String(value)]);
    }
    if (byCapability.size > 1) {
      return { field, text: [...byCapability].map(([capability, values]) => `${capability} (${values.join(", ")})`).join(", ") };
    }
  }
  return null;
}
