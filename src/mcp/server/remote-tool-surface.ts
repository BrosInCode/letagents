import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Set by the API's remote MCP endpoint on the per-connection child process.
 * The npm package never sets it, so stdio behaviour is unchanged.
 */
export const LETAGENTS_REMOTE_TOOL_SURFACE_ENV = "LETAGENTS_REMOTE_TOOL_SURFACE";

/**
 * Tools the remote (streamable HTTP) endpoint does not expose. Each one reads
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

/** Rental provider tools act on the provider host's files and commands. */
export const REMOTE_EXCLUDED_TOOL_PREFIXES: readonly string[] = ["rental_"];

/** Input fields that name a local path. They are removed from remote tool schemas. */
export const REMOTE_STRIPPED_INPUT_FIELDS: readonly string[] = ["cwd"];

export function isRemoteToolSurface(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV]?.trim() === "1";
}

export function isRemoteExcludedTool(name: string): boolean {
  return Object.hasOwn(REMOTE_EXCLUDED_TOOLS, name)
    || REMOTE_EXCLUDED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Wrap a server so registration skips excluded tools and drops local-path
 * input fields. The tool callbacks then fall back to the process working
 * directory, which the remote endpoint sets to an empty per-connection folder.
 */
export function remoteToolServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "tool") return typeof value === "function" ? value.bind(target) : value;
      return (name: string, ...registration: unknown[]) => {
        if (isRemoteExcludedTool(name)) return undefined;
        const args = registration.map((part, index) => {
          const isSchema = index === registration.length - 2
            && part !== null && typeof part === "object" && !Array.isArray(part);
          if (!isSchema) return part;
          const schema = { ...(part as Record<string, unknown>) };
          for (const field of REMOTE_STRIPPED_INPUT_FIELDS) delete schema[field];
          return schema;
        });
        return (target.tool as (...input: unknown[]) => unknown).call(target, name, ...args);
      };
    },
  });
}
