import type { ProviderAdapterCapabilities } from "../provider-adapter.js";

export const INIT_TIMEOUT_MS = 30_000;
// Resuming re-reads the whole saved conversation. With the provider's prompt
// cache expired, a ~110k-token session took 10 s to answer the bootstrap turn
// on an idle machine and over 30 s during a daemon handoff. Waiting costs no
// tokens; failing does, since the deadline is not retried and the user must
// restart the agent by hand.
export const RESUME_INIT_TIMEOUT_MS = 90_000;
// With the owner's own setup on, Claude also starts the owner's MCP servers
// and prints `init` only once each has connected or run out of time. Its own
// limit for that is 30 s, the whole of the budget above, so one server that
// never answers used to fail the launch. The limit is now set explicitly, to
// Claude's own default so that no server is cut off sooner than when the
// owner runs Claude themselves, and the launch's budget grows by the same
// amount. A smaller limit the owner already set is kept. A larger one is
// capped, so the wait always fits the budget.
const OWNER_MCP_STARTUP_TIMEOUT_MS = 30_000;
const OWNER_MCP_STARTUP_TIMEOUT_MAX_MS = 45_000;
// Claude connects stdio servers three at a time, in order, and the room's own
// server comes after the owner's. Three of the owner's that never answer
// would hold the room's server back until they ran out of time, and the
// launch would fail for want of the room. Connecting them all at once means
// no server of the owner's can stand in front of the room's.
const OWNER_MCP_CONNECTION_BATCH_SIZE = 256;

/**
 * What Claude is told when it also starts the owner's servers: how to start
 * MCP servers, and, for a launch that reads the owner's settings alone, to
 * still read the instructions in the agent's work folder (`projectInstructions`).
 */
export function claudeOwnerSetupStartEnvironment(startupMs: number, projectInstructions = false): Record<string, string> {
  return {
    MCP_TIMEOUT: String(startupMs),
    MCP_SERVER_CONNECTION_BATCH_SIZE: String(OWNER_MCP_CONNECTION_BATCH_SIZE),
    MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE: String(OWNER_MCP_CONNECTION_BATCH_SIZE),
    ...(projectInstructions ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } : {}),
  };
}

/**
 * The same values as settings given on the command line. The owner's own
 * `settings.json` may set them in its `env`, and that replaces the process
 * environment; settings given on the command line replace the owner's in turn.
 */
function claudeOwnerSetupSettings(startupMs: number, projectInstructions: boolean): string {
  return JSON.stringify({ env: claudeOwnerSetupStartEnvironment(startupMs, projectInstructions) });
}

/**
 * A policy that names no setting sources reads every one: the owner's, the
 * project's and the folder's local ones. That is Full access. With the
 * owner's setup on, a project's settings, hooks, skills, commands and
 * `.mcp.json` servers would then run beside the owner's own tools, and its
 * settings `env` would reach the owner's servers. Such a launch reads the
 * owner's settings alone, like every other access level does, and is given
 * the work folder as an added directory so the project's `CLAUDE.md` still
 * loads. The other access levels never read a project's instructions, with
 * or without the owner's setup, so they are left as they are.
 */
export function claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs: readonly string[]): boolean {
  return !policyArgs.includes("--setting-sources");
}

/**
 * The arguments with one flag set to one value: where the flag first stands
 * when it is there already, at the end otherwise, and nowhere else. With the
 * owner's setup the launch says what these flags are; nothing the arguments
 * carried before decides them, by being there first or by being there last.
 */
function withFlagSetTo(args: readonly string[], flag: string, value: string | null): string[] {
  const set: string[] = [];
  let placed = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      set.push(args[index]!);
      continue;
    }
    index += 1;
    if (!placed && value !== null) set.push(flag, value);
    placed = true;
  }
  if (!placed && value !== null) set.push(flag, value);
  return set;
}

/** How long the owner's own MCP servers get to start, given the limit the owner's environment already sets. */
export function ownerMcpStartupTimeoutMs(configured: string | undefined): number {
  const own = /^[1-9][0-9]{0,8}$/.test(configured?.trim() ?? "") ? Number(configured!.trim()) : null;
  return own === null ? OWNER_MCP_STARTUP_TIMEOUT_MS : Math.min(own, OWNER_MCP_STARTUP_TIMEOUT_MAX_MS);
}

/** A name from the owner's own configuration, short and printable enough to show. */
export function shownName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return JSON.stringify(value.trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 64));
}

/**
 * One line for each of the owner's MCP servers that Claude did not connect
 * when it started, so the owner can see which one is missing and why the
 * start was slow. The room's own server is checked separately.
 */
export function ownerMcpServerNotices(init: Record<string, unknown>): string[] {
  const notices: string[] = [];
  for (const row of Array.isArray(init.mcp_servers) ? init.mcp_servers : []) {
    if (!row || typeof row !== "object" || row.name === "letagents" || row.status === "connected") continue;
    const name = shownName(row.name);
    if (!name) continue;
    notices.push(row.status === "pending"
      ? `Your MCP server ${name} was still starting when this agent began, so its tools may be missing.`
      : row.status === "needs-auth"
        ? `Your MCP server ${name} needs you to sign in, so this agent is running without it.`
        : `Your MCP server ${name} did not start, so this agent is running without it.`);
    if (notices.length === 8) break;
  }
  return notices;
}

export const BASE_CLAUDE_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    controlProbe: "unsupported",
    approvals: { kinds: ["command"], recovery: "native_instance_only", denyScope: "request" },
  },
  deliveryModes: ["daemon_inbox"],
  // Empirically proven by the task_36 acceptance spike (msg_1382): `--resume
  // <session_id>` continues the SAME session id. The adapter asserts that
  // identity on every resume and the regression suite pins it.
  resume: true,
  // The spike also settled this cell: ordinary stream-json input is QUEUED to
  // the next turn boundary, and the real mid-turn primitive is
  // `control_request/subtype=interrupt` whose success is only proven by the
  // subsequent interrupted result. That is an interrupt control, not message
  // delivery, so the reconciler's poke rung stays off.
  midTurnInjection: false,
  // Claude Code has no native interrupt+resume; corrections use stop-then-resend.
  midTurnCorrection: false,
  // The live stream-json stdout IS the transcript stream; every message is
  // published as bounded/redacted stream evidence.
  transcriptAccess: true,
  permissionPromptBridging: true,
  // stdio dies with the supervising process: a daemon restart can fence the
  // orphan and resume the continuation, but in-context state since the last
  // message is not a survivable live session. Bounded recovery, not survival.
  survivesRestart: false,
  turnControl: "native_interrupt",
};

// Reserved flags the adapter owns. Everything else in the launch policy is the
// user's native CLI configuration and is forwarded verbatim (no reinterpretation,
// no LetAgents permission semantics — v10 §3/§4.8).
const RESERVED_POLICY_KEYS = new Set([
  "print",
  "inputFormat",
  "input-format",
  "outputFormat",
  "output-format",
  "resume",
  "continue",
  "cwd",
  "verbose",
  // The adapter mints/asserts the session identity (msg_1382 spike).
  "sessionId",
  "session-id",
  // Session persistence is what makes bounded --resume recovery possible;
  // a policy must not silently disable the continuation.
  "noSessionPersistence",
  "no-session-persistence",
  // The managed workplace is injected explicitly so project-level .mcp.json
  // files cannot shadow it or exfiltrate its worker credential.
  "mcpConfig",
  "mcp-config",
  "strictMcpConfig",
  "strict-mcp-config",
  "permissionPromptTool",
  "permission-prompt-tool",
]);

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Mechanically render the opaque Add Agent launch policy as CLI flags:
 * `{ permissionMode: "acceptEdits" }` → `--permission-mode acceptEdits`.
 * Purely syntactic — values are never mapped, renamed, or filtered beyond the
 * adapter-owned reserved flags above.
 */
export function claudeLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (RESERVED_POLICY_KEYS.has(key)) {
      throw new Error(`Claude launchPolicy cannot override reserved flag '${key}'.`);
    }
    if (entry === undefined || entry === null || entry === false) continue;
    const flag = `--${camelToKebab(key)}`;
    if (entry === true) {
      args.push(flag);
    } else if (Array.isArray(entry)) {
      args.push(flag, entry.map((item) => String(item)).join(","));
    } else if (typeof entry === "string" || typeof entry === "number") {
      args.push(flag, String(entry));
    } else {
      throw new Error(`Claude launchPolicy value for '${key}' must be a scalar, boolean, or string array.`);
    }
  }
  return args;
}

/**
 * The exact arguments a room agent's CLI starts with. The room's own server
 * is always named explicitly. Without the owner's own setup it is the only
 * MCP configuration Claude reads, so a repo-tracked .mcp.json cannot shadow
 * it. With that setup on, Claude also reads the owner's own servers, and a
 * server named on the command line still wins over one of the same name.
 */
export function claudeCliLaunchArgs(input: {
  approvalProfileLabel: string | null;
  homeHarness: boolean;
  /** How long the owner's MCP servers get to start. Only read with the owner's setup. */
  ownerMcpStartupMs?: number;
  /** The agent's work folder. Only read with the owner's setup, for a policy that names no setting sources. */
  cwd?: string;
  mcpConfigPath: string;
  policyArgs: readonly string[];
  model?: string | null;
  /** The saved reasoning effort. Read again at each launch, so a change applies from the next start or resume. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  session: { resume: string } | { sessionId: string };
}): string[] {
  const instructionsOnly = input.homeHarness && claudeOwnerSetupReadsProjectInstructionsOnly(input.policyArgs);
  // With the owner's setup these three are what the launch says they are, whatever the arguments said:
  // the owner's settings alone, the launch's own start settings, and no folder but the agent's own.
  const policyArgs = input.homeHarness
    ? [
      ...withFlagSetTo(withFlagSetTo(withFlagSetTo(input.policyArgs,
        "--settings", claudeOwnerSetupSettings(input.ownerMcpStartupMs ?? ownerMcpStartupTimeoutMs(undefined), instructionsOnly)),
      "--setting-sources", "user"), "--add-dir", null),
      ...(instructionsOnly && input.cwd?.trim() ? ["--add-dir", input.cwd] : []),
    ]
    : input.policyArgs;
  return [
    "--print",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    // Auto keeps the bridge: anything Claude declines to decide reaches the host.
    ...(input.approvalProfileLabel ? ["--permission-prompt-tool", "stdio"] : []),
    ...(input.homeHarness ? [] : ["--strict-mcp-config"]),
    "--mcp-config", input.mcpConfigPath,
    ...policyArgs,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...("resume" in input.session ? ["--resume", input.session.resume] : ["--session-id", input.session.sessionId]),
  ];
}
