import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Set by the API's remote MCP endpoint on the per-connection child process.
 * The npm package never sets it, so stdio behaviour is unchanged.
 */
export const LETAGENTS_REMOTE_TOOL_SURFACE_ENV = "LETAGENTS_REMOTE_TOOL_SURFACE";

/**
 * Tools the remote (streamable HTTP) endpoint does not expose, with reasons. Each one reads
 * or writes the local filesystem, runs git or another program, or keeps state
 * that only means something on the caller's own machine. Over the remote
 * endpoint "local" is the LetAgents server, so these are excluded rather than
 * pointed at it.
 */
export const REMOTE_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  begin_workspace_capture: "Snapshots files in a local folder; the server has no caller workspace.",
  publish_workspace_capture: "Publishes a local workspace capture; depends on begin_workspace_capture.",
  check_repo: "Inspects a local git checkout.",
  check_repo_visibility: "Reads the git remote of a local checkout.",
  initialize_repo: "Writes .letagents.json into a local checkout.",
  start_local_codex_session: "Starts a Codex process on the machine running the MCP server.",
  status_local_codex_session: "Reports a local Codex process.",
  stop_local_codex_session: "Stops a local Codex process.",
  start_device_auth: "The remote endpoint is already authenticated by the bearer token.",
  poll_device_auth: "The remote endpoint is already authenticated by the bearer token.",
  clear_saved_auth: "No saved local auth exists on the remote endpoint.",
  get_onboarding_status: "Reports local auth bootstrap, which the remote endpoint does not use.",
  resume_room_session: "Local room sessions do not survive a remote connection.",
};

/**
 * The exact tools the remote endpoint exposes. A tool added to the shared
 * registry stays off the remote surface until it is added here (or to the
 * exclusions above), and the parity tests fail until it is classified.
 */
export const REMOTE_ALLOWED_TOOLS: readonly string[] = [
  "add_task", "add_wake_rule", "approve_board_intent", "assign_board_manager", "cancel_wake_rule",
  "claim_task", "claim_task_review", "complete_task", "create_project", "create_room", "deny_board_intent",
  "disconnect_agent_session", "expand_room_history_summary", "get_board", "get_board_settings",
  "get_current_room", "get_human_requests", "get_room_artifacts", "get_room_events", "get_room_guidelines",
  "get_room_history_summary", "get_room_memory", "handoff_task_lease", "join_code", "join_project",
  "join_room", "list_board_intents", "list_wake_rules", "post_reasoning", "post_status",
  "publish_room_artifact", "react_to_message", "read_messages", "register_agent_session",
  "register_board_intent", "register_task_claim_intent", "register_task_close_intent",
  "register_task_create_intent", "register_task_lease_action_intent", "release_board_manager",
  "release_task_lease", "release_task_review", "remember_room_fact", "request_human_input", "search_gifs",
  "send_message", "send_thread_message", "set_agent_name", "set_board_manager_mode",
  "submit_review_verdict", "update_task", "wait_for_messages",
];
const REMOTE_ALLOWED = new Set(REMOTE_ALLOWED_TOOLS);

/** Rental provider tools act on the provider host's files and commands. */
export const REMOTE_EXCLUDED_TOOL_PREFIXES: readonly string[] = ["rental_"];

/**
 * Array elements plus object keys allowed in one remote tool call's
 * arguments. Far above any real call (the largest are task and message
 * payloads), far below what exhausts the child's heap.
 */
export const REMOTE_MAX_TOOL_INPUT_ELEMENTS = 10_000;

/** Input fields that name a local path. They are removed from remote tool schemas. */
export const REMOTE_STRIPPED_INPUT_FIELDS: readonly string[] = ["cwd"];

export function isRemoteToolSurface(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV]?.trim() === "1";
}

export function isRemoteExcludedTool(name: string): boolean {
  return Object.hasOwn(REMOTE_EXCLUDED_TOOLS, name)
    || REMOTE_EXCLUDED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isRemoteAllowedTool(name: string): boolean {
  return REMOTE_ALLOWED.has(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutLocalPaths(schema: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...schema };
  for (const field of REMOTE_STRIPPED_INPUT_FIELDS) delete stripped[field];
  return stripped;
}

/**
 * Strip local-path fields from a `server.tool(name, ...rest, callback)`
 * registration. Throws on a shape it does not recognise, so a new form can
 * never keep `cwd` by accident.
 */
function stripToolRegistration(name: string, registration: unknown[]): unknown[] {
  const callback = registration.at(-1);
  if (typeof callback !== "function") throw new Error(`Remote tool ${name}: registration has no callback.`);
  const middle = registration.slice(0, -1);
  // Accepted: (cb), (description, cb), (schema, cb), (description, schema, cb),
  // (description, schema, annotations, cb), (schema, annotations, cb).
  const strings = middle.filter((part) => typeof part === "string");
  const objects = middle.filter(isPlainObject);
  if (strings.length + objects.length !== middle.length || strings.length > 1 || objects.length > 2
    || (strings.length === 1 && typeof middle[0] !== "string")) {
    throw new Error(`Remote tool ${name}: unrecognised registration shape.`);
  }
  const schemaIndex = middle.findIndex(isPlainObject);
  return registration.map((part, index) => index === schemaIndex ? withoutLocalPaths(part as Record<string, unknown>) : part);
}

/**
 * Wrap a server so only allowed tools register and local-path input fields
 * are dropped. The tool callbacks then fall back to the process working
 * directory, which the remote endpoint sets to an empty per-connection folder.
 */
export function remoteToolServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "tool") {
        return (name: string, ...registration: unknown[]) => {
          if (!isRemoteAllowedTool(name)) return undefined;
          return (target.tool as (...input: unknown[]) => unknown)
            .call(target, name, ...stripToolRegistration(name, registration));
        };
      }
      if (property === "registerTool") {
        return (name: string, config: unknown, callback: unknown) => {
          if (!isRemoteAllowedTool(name)) return undefined;
          if (!isPlainObject(config) || typeof callback !== "function"
            || (config.inputSchema !== undefined && !isPlainObject(config.inputSchema))) {
            throw new Error(`Remote tool ${name}: unrecognised registerTool shape.`);
          }
          const nextConfig = config.inputSchema === undefined ? config
            : { ...config, inputSchema: withoutLocalPaths(config.inputSchema as Record<string, unknown>) };
          return (target.registerTool as (...input: unknown[]) => unknown).call(target, name, nextConfig, callback);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
