import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "../paths.js";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";
import { LETAGENTS_MCP_RUNTIME_TREE_SHA256 } from "../agents/letagents-mcp-runtime.js";

export function supervisorDaemonSpawnEnvironment(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  sourceWorkspaceRoot = workspaceRoot,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...desktopRuntimeEnvironment(env), ELECTRON_RUN_AS_NODE: "1" };
  // Never trust a caller's cwd/cache-derived dev entry. The desktop's compiled
  // location is the authority for the repo build paired with this dev renderer.
  delete result.LETAGENTS_DEV_MCP_SERVER_ENTRY;
  delete result.LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY;
  delete result.LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256;
  delete result.LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV;
  if (env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()) {
    result.LETAGENTS_DEV_MCP_SERVER_ENTRY = join(sourceWorkspaceRoot, "dist", "mcp", "server.js");
    result.LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY = join(sourceWorkspaceRoot, "dist", "mcp", "server", "daemon-tool-executor.js");
    result.LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV = "1";
  } else if (typeof process.resourcesPath === "string" && process.resourcesPath.trim()) {
    result.LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY = join(
      process.resourcesPath, "app", "runtime", "letagents", "node_modules", "letagents",
      "dist", "mcp", "server", "daemon-tool-executor.js",
    );
  }
  result.LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256 = LETAGENTS_MCP_RUNTIME_TREE_SHA256;
  result.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT = supervisorRuntimeEnvironmentFingerprint(result);
  result.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT = supervisorCompatibilityFingerprint(result);
  return result;
}

const SUPERVISOR_COMPATIBILITY_KEYS = [
  "HOME",
  "LETAGENTS_API_URL",
  "LETAGENTS_LOCAL_CHAT_DB",
  "LETAGENTS_LOCAL_FILES_DIR",
  "LETAGENTS_LOCAL_PROFILE_PATH",
  "LETAGENTS_CHAT_STORAGE_SETTINGS_PATH",
  "LETAGENTS_STATE_PATH",
  "LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY",
  "LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256",
  "LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV",
] as const;

const SUPERVISOR_RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "CODEX_INSTALL_DIR",
  "LETAGENTS_CODEX_BIN",
  "LETAGENTS_CLAUDE_BIN",
  "LETAGENTS_CLAUDE_CODE_BIN",
  "LETAGENTS_CURSOR_AGENT_BIN",
  "LETAGENTS_OPENCODE_BIN",
] as const;

/** State and runtime identity must agree even when retaining a daemon's provider environment. */
export function supervisorCompatibilityFingerprint(env: Readonly<NodeJS.ProcessEnv>): string {
  const home = env.HOME ?? homedir();
  // Read only the keys that enter the hash. Copying all of `process.env` for
  // every call cost about 190 us and ran on every supervisor request.
  const effective: Partial<Record<(typeof SUPERVISOR_COMPATIBILITY_KEYS)[number], string | undefined>> = {
    HOME: home,
    LETAGENTS_API_URL: env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
    // MCP consumes a nonempty state path verbatim, unlike the desktop chat paths.
    LETAGENTS_STATE_PATH: env.LETAGENTS_STATE_PATH || join(home, ".letagents", "mcp-state.json"),
    LETAGENTS_LOCAL_CHAT_DB: env.LETAGENTS_LOCAL_CHAT_DB?.trim() || join(home, ".letagents", "local-chat.sqlite"),
    LETAGENTS_LOCAL_FILES_DIR: env.LETAGENTS_LOCAL_FILES_DIR?.trim() || join(home, ".letagents", "local-files"),
    LETAGENTS_LOCAL_PROFILE_PATH: env.LETAGENTS_LOCAL_PROFILE_PATH?.trim() || join(home, ".letagents", "local-profile.json"),
    LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH?.trim() || join(home, ".letagents", "chat-storage.json"),
    LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY: env.LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY,
    LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256: env.LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256,
    LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV: env.LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV,
  };
  return createHash("sha256")
    .update(JSON.stringify(SUPERVISOR_COMPATIBILITY_KEYS.map((key) => [key, effective[key] ?? null])))
    .digest("hex");
}

/** Opaque equality proof for every environment input that can select a provider executable. */
export function supervisorRuntimeEnvironmentFingerprint(
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      ["compatibility", supervisorCompatibilityFingerprint(env)],
      ...SUPERVISOR_RUNTIME_ENVIRONMENT_KEYS.map((key) => [key, env[key] ?? null]),
    ]))
    .digest("hex");
}
