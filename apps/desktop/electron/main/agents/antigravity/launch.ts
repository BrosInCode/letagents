/**
 * How a supervised Antigravity agent is started: the `agy acp` command line,
 * its environment, its own data folder, the access level's native options,
 * and the LetAgents MCP server handed to each ACP session.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProviderAdapterCapabilities } from "../provider-adapter.js";

/** The first agy release whose `agy acp` gives what this adapter uses (ACP v1 sessions, resume, config options). */
export const ANTIGRAVITY_MIN_VERSION = "1.5.12";
export const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google/docs/cli/install";

/** agy's thinking levels (its `thought_level` option), in LetAgents' effort names. */
export const ANTIGRAVITY_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type AntigravityEffort = typeof ANTIGRAVITY_EFFORTS[number];

export function isAntigravityEffort(value: unknown): value is AntigravityEffort {
  return typeof value === "string" && (ANTIGRAVITY_EFFORTS as readonly string[]).includes(value);
}

/**
 * agy names each model once per thinking level (`gemini-4-neon-high`). The
 * family is the model a person picks; the level is the effort.
 */
export function splitAntigravityModelId(id: string): { family: string; effort: AntigravityEffort | null } {
  const match = /^(.+)-(low|medium|high|xhigh)$/.exec(id.trim());
  return match ? { family: match[1]!, effort: match[2] as AntigravityEffort } : { family: id.trim(), effort: null };
}

/** The model's final text when no room reply should be posted. */
export const ANTIGRAVITY_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

/** The name the room's MCP server has inside agy; agy calls its tools `mcp_letagents_<tool>`. */
export const ANTIGRAVITY_ROOM_SERVER_NAME = "letagents";

export const ANTIGRAVITY_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    // Any JSON-RPC answer from agy proves its control loop answers.
    controlProbe: "rpc",
    // Under Ask before writes each agy permission request waits for the owner; it
    // lives only in this process (a new process has no pending request to answer).
    approvals: { kinds: ["command", "file_change", "network"], recovery: "native_instance_only", denyScope: "request" },
  },
  deliveryModes: ["daemon_inbox"],
  // `session/resume` continues the same session id in a new process (verified on agy 1.5.15).
  resume: true,
  // A second `session/prompt` steers a running turn, but that is not the daemon's journaled poke.
  midTurnInjection: false,
  midTurnCorrection: false,
  // The ACP update stream is the live transcript of each turn.
  transcriptAccess: true,
  permissionPromptBridging: true,
  // stdio dies with the supervising process: bounded recovery, not survival.
  survivesRestart: false,
  turnControl: "native_interrupt",
  continuationRepair: "unsupported",
};

/** The access level's native options, as the daemon attests them in the launch policy. */
export type AntigravityLaunchAuthority = {
  /** The ACP session mode: `default` asks before edits and commands; `auto` lets agy's own review decide. */
  agentMode: "default" | "auto";
  /** Start `agy acp` with `--dangerously-skip-permissions`: nothing asks. */
  dangerouslySkipPermissions: boolean;
  /** How this host answers a permission request agy still sends: refuse it, allow it, or ask the owner. */
  hostDecision: "reject" | "allow" | "ask";
};

export const ANTIGRAVITY_AUTHORITY_KEYS = ["agentMode", "dangerouslySkipPermissions", "hostDecision"] as const;

export function antigravityAuthorityForProfile(profileId: string | null | undefined): AntigravityLaunchAuthority {
  switch (profileId) {
    case "full_access": return { agentMode: "default", dangerouslySkipPermissions: true, hostDecision: "allow" };
    case "auto_review": return { agentMode: "auto", dangerouslySkipPermissions: false, hostDecision: "reject" };
    case "ask_before_write": return { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "ask" };
    default: return { agentMode: "default", dangerouslySkipPermissions: false, hostDecision: "reject" };
  }
}

/** Read the attested authority from a launch policy; anything else in it is refused. */
export function antigravityAuthorityFromPolicy(policy: Record<string, unknown>): AntigravityLaunchAuthority {
  for (const key of Object.keys(policy)) {
    if (!(ANTIGRAVITY_AUTHORITY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Antigravity launch policy contains unsupported native option '${key}'.`);
    }
  }
  const { agentMode, dangerouslySkipPermissions, hostDecision } = policy;
  if ((agentMode !== "default" && agentMode !== "auto") || typeof dangerouslySkipPermissions !== "boolean"
    || (hostDecision !== "reject" && hostDecision !== "allow" && hostDecision !== "ask")) {
    throw new Error("Antigravity launch policy does not carry a complete access level.");
  }
  if (dangerouslySkipPermissions !== (hostDecision === "allow")) {
    throw new Error("Antigravity launch policy mixes two access levels.");
  }
  return { agentMode, dangerouslySkipPermissions, hostDecision };
}

export function antigravityAcpArgs(input: { geminiDir: string; authority: AntigravityLaunchAuthority }): string[] {
  return [
    "acp",
    // The agent's own data folder: its conversations, settings and MCP config.
    // Nothing of the owner's own Antigravity setup (MCP servers, plugins,
    // skills, permission rules) loads from here. Sign-in stays in the OS keychain.
    "--gemini-dir", input.geminiDir,
    ...(input.authority.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
  ];
}

/**
 * The agent's own Antigravity data folder. One per agent, so its conversation
 * survives a restart and `session/resume` finds it again.
 */
export function antigravityAgentDataDir(root: string, agentKey: string): string {
  const name = createHash("sha256").update(agentKey).digest("hex").slice(0, 24);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function defaultAntigravityDataRoot(): string {
  return join(homedir(), ".letagents", "antigravity-agents");
}

const STRIPPED_ENVIRONMENT = new Set([
  // Owner and fixed worker credentials: daemon turns borrow exact-generation authority instead.
  "LETAGENTS_TOKEN",
  "LETAGENTS_AGENT_SESSION_BEARER",
  // agy reads these to pick another home or credential source than the agent's own.
  "GEMINI_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AGY_ADC_AUTH",
  "AGY_ACP_FORCE_FILE_STORAGE",
  // A browser opened by a headless agent goes nowhere the owner sees.
  "BROWSER",
  "ELECTRON_RUN_AS_NODE",
]);

/** The environment `agy acp` runs in: the owner's, minus credentials and overrides it must not inherit. */
export function antigravityChildEnvironment(base: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined || STRIPPED_ENVIRONMENT.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  // The desktop app owns which agy runs; an update mid-session would change it under a live agent.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

/** The `agy` the desktop starts: an explicit override, the one on PATH, or the installer's default location. */
export function resolveAntigravityExecutable(env: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform = process.platform): string {
  const override = env.LETAGENTS_ANTIGRAVITY_BIN?.trim();
  if (override) return override;
  const names = platform === "win32" ? ["agy.exe", "agy.cmd"] : ["agy"];
  for (const folder of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (isFile(candidate)) return candidate;
    }
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const installed = platform === "win32"
    ? join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(home, ".local", "bin", "agy");
  return isFile(installed) ? installed : "agy";
}

function isFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

/** `agy --version` prints a bare version such as `1.5.15`. */
export function parseAntigravityVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

export function antigravityVersionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const have = version.split(".").map(Number);
  const want = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((have[index] ?? 0) !== (want[index] ?? 0)) return (have[index] ?? 0) > (want[index] ?? 0);
  }
  return true;
}

export function requireSupportedAntigravityVersion(versionOutput: string): string {
  const version = parseAntigravityVersion(versionOutput);
  if (!version) {
    throw new Error("Antigravity CLI version could not be read. Install the Antigravity CLI (agy), then try again.");
  }
  if (!antigravityVersionAtLeast(version, ANTIGRAVITY_MIN_VERSION)) {
    throw new Error(`Antigravity CLI ${version} is too old for LetAgents agents. Run \`agy update\` to get ${ANTIGRAVITY_MIN_VERSION} or newer, then try again.`);
  }
  return version;
}

/** agy prints this on stdout, not as JSON, when it has no sign-in to use. */
export const ANTIGRAVITY_SIGN_IN_LINE = /^Open the following link to authenticate/i;

export const ANTIGRAVITY_SIGN_IN_REQUIRED = "Antigravity is not signed in on this computer. Run `agy` in a terminal once and sign in with Google, then start the agent again.";

/** An ACP error that means "no usable sign-in". */
export function isAntigravitySignInError(code: number | null, message: string): boolean {
  return code === -32000 || /authenticat|sign.?in|log.?in required|no browser is available/i.test(message);
}

/** The LetAgents MCP server as one ACP `mcpServers` entry (stdio: command, args, env as name/value pairs). */
export function antigravityRoomServer(input: {
  command: string;
  entryPath: string;
  env: Record<string, string>;
}): { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } {
  return {
    name: ANTIGRAVITY_ROOM_SERVER_NAME,
    command: input.command,
    args: [input.entryPath],
    env: Object.entries({ ...input.env, ELECTRON_RUN_AS_NODE: "1" }).map(([name, value]) => ({ name, value })),
  };
}

/** Whether an ACP tool call belongs to the room's own MCP server. */
export function isRoomServerToolCall(toolCall: Record<string, unknown> | null): boolean {
  if (!toolCall) return false;
  const prefix = `mcp_${ANTIGRAVITY_ROOM_SERVER_NAME}_`;
  const name = typeof toolCall.name === "string" ? toolCall.name : "";
  if (name.startsWith(prefix)) return true;
  const title = typeof toolCall.title === "string" ? toolCall.title : "";
  if (/^Run(?:ning)? /.test(title) && title.replace(/^Run(?:ning)? /, "").replace(/\?$/, "").startsWith(prefix)) return true;
  // When MCP tools did not fit its context, agy calls them through `call_mcp_tool`.
  const input = toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput as Record<string, unknown> : null;
  return name === "call_mcp_tool" && input?.ServerName === ANTIGRAVITY_ROOM_SERVER_NAME;
}

/** Native questions with fixed answers (`interaction_…`) need a person; no access level answers them. */
export function isAntigravityQuestion(toolCall: Record<string, unknown> | null): boolean {
  return typeof toolCall?.toolCallId === "string" && toolCall.toolCallId.startsWith("interaction_");
}
