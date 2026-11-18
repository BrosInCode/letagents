// Agents use the LetAgents API through MCP tools made from this contract: a
// method flagged `agents: "read"` or `agents: "write"` becomes the tool
// `api_<area>_<verb>`, with the method's description, capability and error
// codes as the tool's description and its input schema as the tool's input.
// A new flagged method needs no MCP code.
import { getCapability } from "./capabilities.mjs";
import { COMMON_ERROR_CODES, toJsonSchema } from "./core.mjs";
import { API_METHODS } from "./index.mjs";

/** @typedef {import("./index.mjs").KnownApiMethod} KnownApiMethod */
/** @typedef {import("./core.mjs").AgentAccess} AgentAccess */

export const AGENT_TOOL_PREFIX = "api_";

/**
 * Methods whose MCP tool is written by hand, by the tool's name. The page
 * tools read a workspace file and take the snake_case names of the plan;
 * `get_job` came first, for the agent a job is given to. The generator skips
 * these methods; their flag still says that agents may call them.
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
 * `rooms.get` → `api_rooms_get`, `git.pullRequests` → `api_git_pull_requests`.
 * @param {{ name: string }} method
 * @returns {string}
 */
export function agentToolName(method) {
  return AGENT_TOOL_PREFIX + method.name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toLowerCase();
}

/**
 * The flagged methods that get a generated tool, in contract order.
 * @param {readonly KnownApiMethod[]} [methods]
 * @returns {KnownApiMethod[]}
 */
export function agentToolMethods(methods = API_METHODS) {
  return methods.filter((method) => method.agents !== undefined && !Object.hasOwn(HAND_WRITTEN_AGENT_TOOLS, method.name));
}

/**
 * The tool's description: the method's own words for agents, then what the
 * server checks and what it can answer.
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
 * The generated tools, by name, for lists that cannot load zod (the desktop
 * daemon's read-only lists).
 * @param {readonly KnownApiMethod[]} [methods]
 * @returns {{ name: string, method: string, access: AgentAccess }[]}
 */
export function agentToolCatalog(methods = API_METHODS) {
  return agentToolMethods(methods).map((method) => ({
    name: agentToolName(method),
    method: method.name,
    access: /** @type {AgentAccess} */ (method.agents),
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
