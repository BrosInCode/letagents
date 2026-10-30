/** Launch policy normalization, the bounded MCP launch contract and the default adapter dependencies. */
import { isLocalRoomApi, LOCAL_ROOM_API_ORIGIN } from "../../../../../../shared/room-api-origin.mjs";
import { CODEX_READ_ONLY_ROOM_TOOLS } from "../../../../../../shared/codex-read-only-room-tools.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { codexAppServerEnvironment, launchManagedCodexAppServer, resolveCodexAppServerUrl, waitForLaunchedCodexAppServer } from "../codex-app-server.js";
import { sandboxedCodexLoadRefusal } from "../codex-agent-home.js";
import { assertLiveCodexIsolationUnchanged, assertLiveCodexProjectUnchanged, readCodexCommandLine } from "../codex-home-harness.js";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { CodexRpcClient } from "../codex-rpc-client.js";
import { LETAGENTS_MCP_RUNTIME_TREE_SHA256, resolveLetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import { writeCodexSupervisorBridgeContext } from "../codex-supervisor-bridge-context.js";
import type { ProviderAdapterCapabilities } from "../provider-adapter.js";
import { defaultGetProcessIdentity, defaultObserveProcessExit, defaultSignalProcess, delay } from "../provider-evidence.js";
import type { CodexProviderAdapterDependencies } from "./types.js";
import { recordValue } from "./notifications.js";

// Electron as Node takes 8-13 s to load this runtime in an emulated Windows VM.
export const MCP_RUNTIME_CONTRACT_DEADLINE_MS = process.platform === "win32" ? 30_000 : 8_000;

export const BASE_CODEX_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    controlProbe: "rpc",
    approvals: { kinds: ["command", "file_change", "network"], recovery: "connection_only", denyScope: "request" },
  },
  deliveryModes: ["mcp_polling", "daemon_inbox"],
  // P0 task_28 did not prove native mid-turn injection or approval bridging.
  // Resume is populated per app-server after a protocol-level probe.
  resume: false,
  midTurnInjection: false,
  // Codex applies a correction natively: interrupt the current turn and resume
  // the same turn with the correction, without losing it.
  midTurnCorrection: true,
  transcriptAccess: true,
  permissionPromptBridging: false,
  survivesRestart: true,
  turnControl: "native_interrupt",
};

export const RESERVED_POLICY_KEYS = new Set(["threadId", "cwd", "input", "sandbox"]);
/** What an access level decides for a Codex thread. With the owner's setup a thread is given these alone. */
export const CODEX_ACCESS_LEVEL_OPTIONS = ["approvalPolicy", "sandboxPolicy", "approvalsReviewer"] as const;

export function normalizeLaunchPolicy(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex launchPolicy must be the native app-server policy object.");
  }
  const policy = value as Record<string, unknown>;
  for (const key of RESERVED_POLICY_KEYS) {
    if (Object.hasOwn(policy, key)) {
      throw new Error(`Codex launchPolicy cannot override reserved field '${key}'.`);
    }
  }
  const { sandboxPolicy, ...namedPolicy } = policy;
  const reviewer = namedPolicy.approvalsReviewer ?? "user";
  if (reviewer !== "user" && reviewer !== "auto_review") {
    throw new Error("Codex launchPolicy names an unsupported approval reviewer.");
  }
  // Always name the reviewer, so the owner's own Codex settings cannot choose it.
  const threadPolicy: Record<string, unknown> = { ...namedPolicy, approvalsReviewer: reviewer };
  const sandbox = recordValue(sandboxPolicy);
  // Codex reviews its own escalations only beneath project-only writes.
  if (reviewer === "auto_review" && (sandbox?.type !== "workspaceWrite" || threadPolicy.approvalPolicy !== "on-request")) {
    throw new Error("Codex launchPolicy names automatic review outside the Auto access level.");
  }
  if (sandboxPolicy === undefined) return threadPolicy;
  if (sandbox?.type === "dangerFullAccess" && Object.keys(sandbox).length === 1) {
    return { ...threadPolicy, sandbox: "danger-full-access" };
  }
  if (
    sandbox?.type === "readOnly"
    && sandbox.networkAccess === false
    && Object.keys(sandbox).length === 2
  ) {
    return { ...threadPolicy, sandbox: "read-only" };
  }
  // Project-only writes exist solely beneath Codex's own approval review.
  // The thread takes the owner's settings for network access; every turn
  // restates this exact policy, and the turn's policy is the one Codex applies.
  if (
    sandbox?.type === "workspaceWrite"
    && sandbox.networkAccess === false
    && Object.keys(sandbox).length === 2
    && reviewer === "auto_review"
  ) {
    return { ...threadPolicy, sandbox: "workspace-write" };
  }
  throw new Error("Codex launchPolicy contains an unsupported thread sandbox policy.");
}

export function codexTurnPolicy(value: unknown): Readonly<Record<string, unknown>> {
  normalizeLaunchPolicy(value);
  const policy = value as Record<string, unknown>;
  if (!["never", "on-request"].includes(String(policy.approvalPolicy)) || !recordValue(policy.sandboxPolicy)) {
    throw new Error("Codex turn requires its exact applied approval and sandbox policy.");
  }
  return Object.freeze({
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy: Object.freeze(structuredClone(policy.sandboxPolicy as Record<string, unknown>)),
    // Every turn restates the reviewer, so neither a resumed thread nor the
    // owner's Codex settings can move approvals to another one.
    approvalsReviewer: policy.approvalsReviewer ?? "user",
  });
}

/**
 * Give the LetAgents MCP workplace the work-attempt cwd while preserving the
 * user's installed command, auth, and environment. No bearer or curated HOME
 * is injected here; desktop MCP setup remains the source of those values.
 */
export function codexMcpWorkplaceConfigOverrides(cwd: string): string[] {
  return [`mcp_servers.letagents.cwd=${JSON.stringify(cwd)}`];
}

export function readMcpRuntimeContract(entryPath: string, apiUrl?: string): Promise<unknown> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let deadlineExpired = false;
    let killedAtDeadline = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(process.execPath, [entryPath, "--letagents-runtime-contract"], {
      encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      // The read-only contract probe needs neither user auth nor daemon authority.
      env: { ELECTRON_RUN_AS_NODE: "1", ...(isLocalRoomApi(apiUrl) ? { LETAGENTS_API_URL: LOCAL_ROOM_API_ORIGIN } : {}) },
    }, (error, stdout) => {
      if (deadline) clearTimeout(deadline);
      if (error) {
        // Never expose stderr, paths, environment or the child-process Error message.
        const code = typeof error.code === "number" ? error.code : "unavailable";
        const signal = error.signal === "SIGKILL" ? "SIGKILL" : error.signal ? "other" : "none";
        const failure = new Error(`The verified LetAgents MCP runtime contract could not be read. Exit: ${code}; signal: ${signal}; killed: ${Boolean(error.killed)}; elapsed: ${Date.now() - startedAt}ms; output: ${Buffer.byteLength(stdout)} bytes.`);
        // Retain the successful deadline-kill gate. A delayed exit notification
        // cannot prove which SIGKILL caused termination; retries still require
        // a fresh valid contract. Other observed failures remain fail-closed.
        if (killedAtDeadline && error.signal === "SIGKILL" && error.code == null) {
          Object.assign(failure, { transientProviderStart: true });
        }
        return reject(failure);
      }
      if (deadlineExpired) {
        // Timeout cleanup can discard unread stdout from a child that already
        // exited successfully while this process's event loop was delayed.
        return reject(Object.assign(new Error(`The verified LetAgents MCP runtime contract exceeded its ${process.platform === "win32" ? "thirty" : "eight"}-second deadline. Elapsed: ${Date.now() - startedAt}ms.`), { transientProviderStart: true }));
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("The verified LetAgents MCP runtime contract is malformed.")); }
    });
    deadline = setTimeout(() => {
      // Record the deadline before destroying pipes, even if the child has
      // already exited. Preserve an already observed unsuccessful exit.
      deadlineExpired = child.signalCode === null && (child.exitCode === null || child.exitCode === 0);
      // Match execFile's timeout cleanup: a descendant must not keep the
      // callback waiting by retaining the probe's output pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && child.signalCode === null) killedAtDeadline = child.kill("SIGKILL");
    }, MCP_RUNTIME_CONTRACT_DEADLINE_MS);
    deadline.unref();
    child.stdin?.end();
  });
}

export function custodialPollingTools(value: unknown): string[] {
  const report = recordValue(value);
  const profile = recordValue(recordValue(report?.profiles)?.supervised_mcp_polling);
  const tools = profile?.tools;
  if (report?.format !== 1 || profile?.contract !== "custodial_polling_v1"
    || !Array.isArray(tools) || !tools.every((name) => typeof name === "string")
    || !["wait_for_messages", "read_messages", "send_message"].every((name) => tools.includes(name))
    || tools.some((name) => /^(?:register_agent_session|disconnect_agent_session|start_device_auth|poll_device_auth|clear_saved_auth|resume_room_session|rental_.*)$/.test(name))) {
    throw new Error("The verified LetAgents MCP runtime does not support custodial_polling_v1.");
  }
  return tools;
}

export const REQUIRED_ROOM_TOOLS = ["claim_task", "get_board", "read_messages", "send_message"] as const;

export function boundedCodexTools(value: unknown): string[] {
  const report = recordValue(value);
  const tools = recordValue(recordValue(report?.profiles)?.cursor_supervised_room_turn)?.tools;
  if (report?.format !== 1 || !Array.isArray(tools) || !tools.every((name) => typeof name === "string")
    || !REQUIRED_ROOM_TOOLS.every((name) => tools.includes(name))
    || tools.some((name) => /^(?:wait_for_messages|register_agent_session|disconnect_agent_session|start_device_auth|poll_device_auth|clear_saved_auth|resume_room_session)$/.test(name))) {
    throw new Error("The verified LetAgents MCP runtime does not support Codex supervised room tools.");
  }
  // The pinned runtime exposes its common bounded surface under Cursor's
  // profile. Codex uses the same registration minus Cursor's completion hook.
  return tools.filter((name) => name !== "complete_room_turn");
}

export const boundedMcpEnvironment = {
  LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
  LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
  LETAGENTS_TOKEN: "",
  LETAGENTS_AGENT_SESSION_BEARER: "",
  LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "",
};

/**
 * Version 2: a sandboxed agent runs with a Codex home that has no saved
 * command rules. Version 3: a Read-only agent's conversations name a
 * permission profile that keeps the owner's sign-in file from its commands.
 * A process started under an earlier version is replaced when it is idle, so
 * this number never goes back.
 */
export const CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION = 3;

// The room tools a Read-only agent may use: Codex is told to run these without
// asking and to refuse every other one. Codex 0.153.4 was seen to refuse a
// tool that needs an approval when nobody can be asked ("MCP tool call
// requires approval, but approval policy is never") and to run one approved in
// advance. The background service keeps the same list for itself.
export { CODEX_READ_ONLY_ROOM_TOOLS };

export function boundedLaunchContract(apiUrl: string, tools: string[]): string {
  // Reuse the generated override: approval modes, filters, credentials and
  // command semantics must change the identity too. Birth/workspace coordinates
  // are independently fenced; replace only those variable launch values.
  // The access level is not part of this identity: the daemon compares one
  // contract for every agent of a room server, and a change of access level
  // already replaces the runtime through its configuration revision.
  const override = custodialMcpOverride("<sealed-entry>", "<workspace>", {
    ...boundedMcpEnvironment, LETAGENTS_API_URL: apiUrl,
  }, [...tools].sort());
  return createHash("sha256").update(JSON.stringify({
    version: CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION, provider: "codex", runtimeTree: LETAGENTS_MCP_RUNTIME_TREE_SHA256, override,
  })).digest("hex");
}

export function custodialMcpOverride(
  entryPath: string, cwd: string, environment: Record<string, string>, tools: string[],
  /** The launch is a Read-only agent's: its room tools are the named ones and no others. */
  readOnlyRoomTools = false,
): string {
  const env = Object.entries({ ...environment, ELECTRON_RUN_AS_NODE: "1" })
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ");
  // Native config deep-merges even a parent-table CLI override. Pin each
  // advertised tool so inherited prompt/approve rules cannot alter this policy.
  const toolApprovalModes = tools.map((name) => {
    const mode = readOnlyRoomTools
      // "prompt" needs an approval every time, and Codex refuses that when
      // nobody can be asked. "writes" would not do: under it Codex runs any
      // tool the room server marks as a read, named above or not.
      ? CODEX_READ_ONLY_ROOM_TOOLS.has(name) ? "approve" : "prompt"
      // This verified bounded capability only records final-answer routing. It
      // cannot choose a recipient or send text. Actual message tools remain writes.
      : environment.LETAGENTS_EXECUTION_PROFILE === "supervised_room_turn" && name === "set_reply_thread" ? "approve" : "writes";
    return `${JSON.stringify(name)} = { approval_mode = ${JSON.stringify(mode)} }`;
  }).join(", ");
  // Codex merges installed config beneath CLI overrides. Pin every authority
  // coordinate and clear inherited credential names/tool filters explicitly.
  return `mcp_servers.letagents={ command = ${JSON.stringify(process.execPath)}, args = [${JSON.stringify(entryPath)}], cwd = ${JSON.stringify(cwd)}, env = { ${env} }, env_vars = [], enabled = true, enabled_tools = ${JSON.stringify(tools)}, disabled_tools = [], default_tools_approval_mode = ${JSON.stringify(readOnlyRoomTools ? "prompt" : "writes")}, tools = { ${toolApprovalModes} } }`;
}

export const DEFAULT_DEPENDENCIES: CodexProviderAdapterDependencies = {
  resolveMcpRuntime: (devEntryPath) => resolveLetAgentsMcpRuntime({ devEntryPath, env: desktopRuntimeEnvironment() }),
  readMcpRuntimeContract,
  resolveServerUrl: () => resolveCodexAppServerUrl(null, { dedicated: true }),
  launchServer: (serverUrl, codexBin, options) =>
    launchManagedCodexAppServer(serverUrl, codexBin, options),
  waitForServer: waitForLaunchedCodexAppServer,
  createRpcClient: (serverUrl, onNotification) =>
    new CodexRpcClient(serverUrl, onNotification),
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  readCommandLine: readCodexCommandLine,
  // The owner's own config is found as the launch found it: through the launch's environment.
  assertLiveProjectUnchanged: (codexBin, live) =>
    assertLiveCodexProjectUnchanged(codexBin, live, codexAppServerEnvironment({ homeHarness: true }).env),
  sandboxedLoadRefusal: (codexBin, live, keepWritableFoldersCheck) =>
    sandboxedCodexLoadRefusal(codexBin, { ...live, env: codexAppServerEnvironment().env, keepWritableFoldersCheck }),
  // Asked as the process reads its settings: with the home it runs with.
  assertLiveIsolationUnchanged: (codexBin, live) => assertLiveCodexIsolationUnchanged(codexBin, live, {
    ...codexAppServerEnvironment().env, ...(live.codexHome ? { CODEX_HOME: live.codexHome } : {}),
  }),
  writeSupervisorBridgeContext: writeCodexSupervisorBridgeContext,
  now: () => new Date().toISOString(),
  sleep: delay,
};
