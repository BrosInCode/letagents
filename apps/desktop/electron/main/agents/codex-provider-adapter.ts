import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import type { CodexPermissionFileChange, ProviderPermissionDispatchOptions } from "../../../shared/provider-permissions.js";
import {
  launchCodexAppServer,
  resolveCodexAppServerUrl,
  waitForLaunchedCodexAppServer,
  type CodexAppServerExit,
  type CodexAppServerLaunch,
} from "./codex-app-server.js";
import { resolveCodexExecutable } from "./codex-executable.js";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";
import {
  CodexRpcClient,
  type RpcNotification,
  type RpcServerRequest,
  type ThreadReadResult,
  type ThreadReadTurn,
  type TurnStartResult,
} from "./codex-rpc-client.js";
import { buildCodexDevMcpEntryOverrides } from "./codex-dev-mcp-entry.js";
import { resolveLetAgentsMcpRuntime, type LetAgentsMcpRuntime } from "./letagents-mcp-runtime.js";
import { writeCodexSupervisorBridgeContext } from "./codex-supervisor-bridge-context.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import { rentalCredentialIsolationMarker } from "./rental-child-environment.js";
import {
  ProviderExecutionObserver,
  nativeExecutionId,
  nativeLifecycleCheckpoint,
  type NativeLifecycleCheckpoint,
} from "./provider-execution-observer.js";
import type { ControlProbeResult, HardControlEvidence, NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../../../shared/execution-protocol.js";
import {
  summarizeCodexRuntimeNotification,
  summarizeCodexRuntimeSnapshot,
} from "./codex-runtime-reasoning.js";
import { extractThreadStatus, extractTurnStatus, isActiveCodexTurnStatus } from "./codex-session-status.js";
import { CodexTurnResultAccumulator } from "./codex-turn-result.js";
import {
  buildCodexStartPrompt,
  buildCustodialPollingPrompt,
  DEFAULT_CODEX_STOP_PHRASE,
  looksLikeInviteCode,
  makeCodexStopToken,
} from "./codex-start-prompt.js";
import {
  synthesizeTerminalPayload,
  sameProviderConnectionIdentity,
  type ProviderActivityEvent,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderAttachTerminal,
  type ProviderConnectionRef,
  type ProviderContinuationRef,
  type ProviderHandle,
  type CustodialPollingActivationRequest,
  type CustodialPollingActivationOptions,
  type ProviderObservedState,
  type ProviderSpawnRequest,
  type ProviderStopOptions,
  type ProviderTurnControlResult,
  type ProviderTurnControlOptions,
  ProviderTurnControlError,
  type ProviderRoomTurnRequest,
  type ProviderRoomTurnRecoveryRequest,
  type ProviderRoomTurnResult,
  type ProviderRoomTurnOptions,
  type ProviderContinuationRepairRequest,
  type ProviderContinuationRepairResult,
  ProviderContinuationMissingError,
  type ProviderStreamEvent,
  type ProviderStreamEventKind,
  type ProviderTerminalPayload,
} from "./provider-adapter.js";
import {
  DEFAULT_STOP_GRACE_MS,
  defaultGetProcessIdentity,
  defaultObserveProcessExit,
  defaultSignalProcess,
  delay,
  errorMessage,
  observeFencedExit,
  safeStreamPayload,
  sameProcessBirthIdentity,
  terminateFreshLaunch,
} from "./provider-evidence.js";

type CodexThreadResult = { thread?: { id?: string } };

function isUnmaterializedEmptyThreadRead(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not materialized yet")
    && message.includes("includeturns is unavailable before first user message");
}

function isMissingContinuation(error: unknown, continuationId: string): boolean {
  const message = errorMessage(error).trim();
  return new RegExp(`^thread not found:\\s*${escapeRegExp(continuationId)}$`, "i").test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CodexAdapterRpc {
  connect(): Promise<void>;
  request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  close(): void;
  onDisconnect(listener: () => void): () => void;
  currentConnectionId(): string | null;
  listPendingRequests(): readonly RpcServerRequest[];
  onPendingRequestsChanged(listener: () => void): () => void;
  respond(request: RpcServerRequest, result: unknown): void;
}

/** Native approval payloads stay host-ephemeral, outside execution facts and room projections. */
export type CodexPermissionObservation =
  | { type: "snapshot"; requests: readonly RpcServerRequest[] }
  | { type: "degraded" }
  | { type: "unavailable" };

export class CodexPermissionReplyError extends Error {
  constructor(readonly outcome: "not_dispatched" | "uncertain") {
    super(`Codex permission decision ${outcome}.`);
    this.name = "CodexPermissionReplyError";
  }
}

export interface CodexProviderAdapterDependencies {
  resolveMcpRuntime(devEntryPath?: string): LetAgentsMcpRuntime;
  readMcpRuntimeContract(entryPath: string): Promise<unknown>;
  resolveServerUrl(): Promise<string>;
  launchServer(
    serverUrl: string,
    codexBin: string,
    options: { trustedProjectPath: string; configOverrides: string[]; env?: Record<string, string> },
  ): CodexAppServerLaunch;
  waitForServer(serverUrl: string, launch: CodexAppServerLaunch): Promise<boolean>;
  createRpcClient(
    serverUrl: string,
    onNotification: (notification: RpcNotification) => void,
  ): CodexAdapterRpc;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<CodexAppServerExit>;
  writeSupervisorBridgeContext(
    cwd: string,
    context: {
      entry_id: string;
      room_id: string;
      work_attempt_id: string;
      execution_generation_id: string;
    },
  ): Promise<void>;
  now(): string;
  sleep(ms: number): Promise<void>;
}

export interface CodexProviderAdapterOptions {
  codexBin?: string;
  dependencies?: Partial<CodexProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
}

const BASE_CODEX_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    controlProbe: "rpc",
    approvals: { kinds: ["command", "file_change"], recovery: "connection_only", denyScope: "request" },
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

const RESERVED_POLICY_KEYS = new Set(["threadId", "cwd", "input"]);
const PS_BIRTH_EVIDENCE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4}(?:\s|$)/;

function normalizeLaunchPolicy(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex launchPolicy must be the native app-server policy object.");
  }
  const policy = value as Record<string, unknown>;
  for (const key of RESERVED_POLICY_KEYS) {
    if (Object.hasOwn(policy, key)) {
      throw new Error(`Codex launchPolicy cannot override reserved field '${key}'.`);
    }
  }
  // Deliberately return the original values without mapping profile names or
  // inventing LetAgents permission semantics. The Add Agent native policy is
  // forwarded to app-server unchanged (plan v10 §4.8 / P0 cell h).
  return policy;
}

/**
 * Give the LetAgents MCP workplace the work-attempt cwd while preserving the
 * user's installed command, auth, and environment. No bearer or curated HOME
 * is injected here; desktop MCP setup remains the source of those values.
 */
export function codexMcpWorkplaceConfigOverrides(cwd: string): string[] {
  return [`mcp_servers.letagents.cwd=${JSON.stringify(cwd)}`];
}

function readMcpRuntimeContract(entryPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [entryPath, "--letagents-runtime-contract"], {
      encoding: "utf8", timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      // The read-only contract probe needs neither user auth nor daemon authority.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }, (error, stdout) => {
      if (error) return reject(new Error("The verified LetAgents MCP runtime contract could not be read."));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("The verified LetAgents MCP runtime contract is malformed.")); }
    });
    child.stdin?.end();
  });
}

function custodialPollingTools(value: unknown): string[] {
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

function custodialMcpOverride(entryPath: string, cwd: string, environment: Record<string, string>, tools: string[]): string {
  const env = Object.entries({ ...environment, ELECTRON_RUN_AS_NODE: "1" })
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ");
  // Codex merges installed config beneath CLI overrides. Pin every authority
  // coordinate and clear inherited credential names/tool filters explicitly.
  return `mcp_servers.letagents={ command = ${JSON.stringify(process.execPath)}, args = [${JSON.stringify(entryPath)}], cwd = ${JSON.stringify(cwd)}, env = { ${env} }, env_vars = [], enabled = true, enabled_tools = ${JSON.stringify(tools)}, disabled_tools = [] }`;
}

function isCodexExecutionMethod(method: string): boolean {
  return /^(?:item\/|command\/exec(?:\/|$))/i.test(method);
}

function streamKind(method: string): ProviderStreamEventKind {
  if (/(?:approval|requestApproval|guardian)/i.test(method)) return "approval";
  // Preserve execution identity even when a command/tool reports failure.
  // Runtime process errors still go through the error classifier below.
  if (isCodexExecutionMethod(method)) {
    if (/(?:mcpToolCall|toolCall|fileChange|webSearch)/i.test(method)) return "tool_lifecycle";
    if (/(?:command|process|terminal)/i.test(method)) return "command_output";
  }
  // A failed turn is still turn lifecycle evidence. Keep its identity ahead of
  // the generic error label so daemon policy cannot mistake it for app-server
  // failure.
  if (/^turn\//.test(method)) return "turn_lifecycle";
  if (/(?:error|warning|failed)/i.test(method)) return "error";
  if (/(?:usage|tokenUsage|rateLimit)/i.test(method)) return "usage";
  if (/(?:mcpToolCall|toolCall|fileChange|webSearch)/i.test(method)) return "tool_lifecycle";
  if (/(?:command|process|terminal)/i.test(method)) return "command_output";
  if (/(?:delta|transcript)/i.test(method)) return "text_delta";
  if (/^item\//.test(method)) return "item_lifecycle";
  return "provider_event";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function terminalTurnOutcome(
  method: string,
  turn: Record<string, unknown> | null,
): "completed" | "failed" | "interrupted" | null {
  const terminal = /^turn\/(completed|failed|interrupted|cancelled|stopped)$/i.exec(method)?.[1]?.toLowerCase();
  if (!terminal) return null;
  if (terminal === "failed") return "failed";
  if (terminal !== "completed") return "interrupted";
  const status = extractTurnStatus(turn)?.trim().toLowerCase() ?? null;
  if (status === "completed" || status === "failed") return status;
  return /^(?:interrupted|cancelled|stopped)$/.test(status ?? "") ? "interrupted" : null;
}

function transcriptLifecycleTurn(value: unknown): { id: unknown; status: unknown } | null {
  const turn = recordValue(value);
  return turn ? { id: turn.id, status: turn.status } : null;
}

function permissionParams(request: RpcServerRequest): Record<string, unknown> | null {
  if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") return null;
  const params = recordValue(request.params);
  return params && nativeExecutionId(params.threadId) && nativeExecutionId(params.turnId)
    && nativeExecutionId(params.itemId) && Number.isSafeInteger(params.startedAtMs)
    && (params.startedAtMs as number) >= 0 ? params : null;
}

function permissionFileChanges(value: unknown): CodexPermissionFileChange[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 128) return null;
  const path = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0
    && input.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(input);
  const changes: CodexPermissionFileChange[] = [];
  for (const entry of value) {
    const item = recordValue(entry); const kind = recordValue(item?.kind);
    if (!item || Object.keys(item).length !== 3 || !path(item.path) || typeof item.diff !== "string"
      || item.diff.length > 24 * 1024 || !kind) return null;
    if (kind.type === "add" || kind.type === "delete") {
      if (Object.keys(kind).length !== 1) return null;
      changes.push({ path: item.path, kind: { type: kind.type }, diff: item.diff });
    } else if (kind.type === "update" && Object.keys(kind).length === 2
      && (kind.move_path === null || path(kind.move_path))) {
      changes.push({ path: item.path, kind: { type: "update", move_path: kind.move_path }, diff: item.diff });
    } else return null;
  }
  return Buffer.byteLength(JSON.stringify(changes)) <= 24 * 1024 ? changes : null;
}

function codexLifecycleStatus(value: unknown): "failed" | "idle" | "working" | null {
  const root = recordValue(value);
  if (!root) return null;
  const candidates = [
    root.status,
    root.threadStatus,
    root.turnStatus,
    recordValue(root.thread)?.status,
    recordValue(root.turn)?.status,
  ].flatMap((candidate) => {
    const nested = recordValue(candidate);
    return [candidate, nested?.type, nested?.status];
  });
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (/^(?:systemError|error|failed)$/i.test(candidate)) return "failed";
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (/^(?:completed|interrupted|idle|stopped)$/i.test(candidate)) return "idle";
    if (/^(?:active|inProgress|running|queued|pending)$/i.test(candidate)) return "working";
  }
  return null;
}

function hasExplicitCodexSystemError(value: unknown): boolean {
  const root = recordValue(value);
  if (!root) return false;
  const candidates = [root.status, root.threadStatus, recordValue(root.thread)?.status]
    .flatMap((candidate) => {
      const nested = recordValue(candidate);
      return [candidate, nested?.type, nested?.status];
    });
  return candidates.some((candidate) => typeof candidate === "string"
    && /^(?:systemError|error_during_execution)$/i.test(candidate));
}

function notificationTurnId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.turn);
  const candidate = root?.turnId ?? root?.turn_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function notificationThreadId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.thread);
  const candidate = root?.threadId ?? root?.thread_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function exactTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function boundedRoomTurnPrompt(request: ProviderRoomTurnRequest): string {
  return [
    "You are handling one daemon-owned room inbox item in an exact bounded turn.",
    "The daemon owns observation, credentials, retries, and publication. Do not register a session, authenticate, poll, or manage runtime lifecycle.",
    "You may use the discovered LetAgents product tools for room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    "If no response should be published, return exactly LETAGENTS_NO_ROOM_REPLY with no other text.",
    `Inbox item: ${request.inboxItemId}`,
    `Recent bounded room context: ${JSON.stringify(request.observedContext ?? [])}`,
    `Source message: ${JSON.stringify(request.sourceMessage)}`,
    `Activation: ${JSON.stringify(request.activation)}`,
  ].join("\n");
}

class CodexRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}
class CodexRoomTurnObservationDetachedError extends Error {}

function isMethodNotFound(error: unknown): boolean {
  return /(?:-32601|method\s+not\s+found|unknown\s+method|unsupported\s+method)/i.test(
    errorMessage(error),
  );
}

function configuredMcpServerNames(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [
        ...((value as { data?: unknown }).data && Array.isArray((value as { data?: unknown }).data)
          ? (value as { data: unknown[] }).data
          : []),
        ...((value as { servers?: unknown }).servers && Array.isArray((value as { servers?: unknown }).servers)
          ? (value as { servers: unknown[] }).servers
          : []),
      ]
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const name = (row as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

function isTransientWorkplaceProbeFailure(error: unknown): boolean {
  return /(?:timed?\s*out|timeout|aborted|temporar(?:y|ily)|unavailable|connection\s+(?:closed|reset)|socket\s+hang\s+up)/i.test(
    errorMessage(error),
  );
}

async function requireLetAgentsWorkplace(client: CodexAdapterRpc): Promise<void> {
  let response: unknown;
  try {
    response = await client.request("mcpServerStatus/list", {});
  } catch (error) {
    // This RPC is only an observability probe. The daemon already injects the
    // exact LetAgents MCP config into the Codex app-server launch, and the
    // worker's register_agent_session + wait evidence is the authoritative
    // readiness gate. A busy MCP host can time this probe out while the room
    // worker is healthy; do not kill or strand that durable execution.
    if (isTransientWorkplaceProbeFailure(error)) return;
    throw new Error(`Unable to verify the LetAgents MCP workplace: ${errorMessage(error)}`);
  }
  if (!configuredMcpServerNames(response).some((name) => name.toLowerCase() === "letagents")) {
    throw new Error(
      "LetAgents MCP server is not configured in Codex; refusing to launch without the room workplace.",
    );
  }
}

const DEFAULT_DEPENDENCIES: CodexProviderAdapterDependencies = {
  resolveMcpRuntime: (devEntryPath) => resolveLetAgentsMcpRuntime({ devEntryPath, env: desktopRuntimeEnvironment() }),
  readMcpRuntimeContract,
  resolveServerUrl: () => resolveCodexAppServerUrl(null, { dedicated: true }),
  launchServer: (serverUrl, codexBin, options) =>
    launchCodexAppServer(serverUrl, codexBin, options),
  waitForServer: waitForLaunchedCodexAppServer,
  createRpcClient: (serverUrl, onNotification) =>
    new CodexRpcClient(serverUrl, onNotification),
  signalProcess: defaultSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  writeSupervisorBridgeContext: writeCodexSupervisorBridgeContext,
  now: () => new Date().toISOString(),
  sleep: delay,
};

function isCodexRuntimeUnavailable(state: ProviderObservedState): boolean {
  return state === "failed" || state === "stopping" || state === "stopped";
}

class CodexProviderHandle implements ProviderHandle {
  custodyLaunchAgentSessionId?: string;
  readonly execution: ProviderExecutionObserver;
  readonly nativeActiveTurns = new Map<string, { providerContinuationId: string; providerTurnId: string }>();
  readonly nativeActiveOperations = new Map<string, Extract<NativeExecutionFact, { domain: "execution" }>>();
  nativeRuntimeUnavailable: HardControlEvidence | null = null;
  state: ProviderObservedState = "starting";
  stopRequested = false;
  protocolError = false;
  terminal: ProviderTerminalPayload | null = null;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  readonly permissionInvalidationListeners = new Set<() => void>();
  streamSequence = 0;
  /** At most one terminal fact per recent native turn; never infer a latest turn. */
  readonly terminalTurns = new Map<string, string>();
  readonly turnWaiters = new Map<string, { owner: symbol; resolve: (status: string) => void; reject: (error: Error) => void }>();
  readonly roomTurnResults = new CodexTurnResultAccumulator();
  providerContinuationId: string;

  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    providerContinuationId: string,
    readonly providerConnection: ProviderConnectionRef,
    readonly lifecycleAuthorityMode: "legacy" | "typed_shadow" | "typed",
    readonly client: CodexAdapterRpc,
    readonly launch: CodexAppServerLaunch,
    now: () => string,
  ) {
    this.providerContinuationId = providerContinuationId;
    this.execution = new ProviderExecutionObserver(now);
    client.onDisconnect(() => {
      if (this.nativeRuntimeUnavailable) return;
      this.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
        providerConnection.processIdentity ?? undefined, providerConnection.pid ?? undefined);
    });
  }

  replaceContinuation(providerContinuationId: string): void {
    if (this.turnWaiters.size) {
      throw new Error("Codex continuation repair cannot replace a thread while a turn observer is active.");
    }
    if (!this.setLiveState("idle")) {
      throw new Error("Codex continuation repair cannot replace a thread on an unavailable runtime.");
    }
    this.terminalTurns.clear();
    this.roomTurnResults.clearAll();
    this.providerContinuationId = providerContinuationId;
    this.invalidatePermissions();
  }

  setLiveState(state: "idle" | "working"): boolean {
    if (isCodexRuntimeUnavailable(this.state)) return false;
    this.state = state;
    return true;
  }

  invalidatePermissions(): void {
    for (const listener of this.permissionInvalidationListeners) {
      try { listener(); } catch { /* Observation never controls native work. */ }
    }
  }

  observedState(): ProviderObservedState {
    return this.state;
  }
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private readonly codexBin: string;
  private readonly deps: CodexProviderAdapterDependencies;
  private readonly activitySink?: (event: ProviderActivityEvent) => void;
  private readonly streamSink?: (event: ProviderStreamEvent) => void;
  private readonly handles = new Map<string, CodexProviderHandle>();
  private readonly pollingLaunches = new WeakMap<CodexProviderHandle, { roomId: string; cwd: string; configurationRevision: number | undefined; agentSessionId: string }>();
  private readonly pollingDispatches = new WeakSet<CodexProviderHandle>();
  private readonly nonPollingLaunches = new WeakSet<CodexProviderHandle>();
  private readonly pendingAttaches = new Map<string, {
    ref: ProviderContinuationRef;
    promise: Promise<CodexProviderHandle | ProviderAttachTerminal | null>;
  }>();
  private readonly exitPromises = new WeakMap<CodexProviderHandle, Promise<ProviderTerminalPayload>>();
  // P0 proved app-server thread/resume on the supported Codex runtime. Start
  // optimistic so a fresh reconciler can select resume, then durably downgrade
  // if an exact continuation resume returns method-not-found. Do not probe with
  // a synthetic thread id: some app-server versions treat that as a fatal
  // protocol error, which must never prevent a genuinely fresh thread/start.
  private resumeSupported = true;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.codexBin = options.codexBin || resolveCodexExecutable({ env: desktopRuntimeEnvironment() });
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
  }

  capabilities(): ProviderAdapterCapabilities {
    return {
      ...BASE_CODEX_CAPABILITIES,
      resume: this.resumeSupported,
      continuationRepair: "same_process",
    };
  }

  async preflightCustodialPolling(input: { devMcpServerEntryPath?: string }): Promise<void> {
    await this.resolveCustodialPollingRuntime(input.devMcpServerEntryPath);
  }

  private async resolveCustodialPollingRuntime(devEntryPath?: string): Promise<{ runtime: LetAgentsMcpRuntime; tools: string[] }> {
    const runtime = this.deps.resolveMcpRuntime(devEntryPath);
    const tools = custodialPollingTools(await this.deps.readMcpRuntimeContract(runtime.entryPath));
    return { runtime, tools };
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const authorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    const handle = this.handles.get(ref.workAttemptId);
    if (
      !handle ||
      handle.terminal ||
      handle.lifecycleAuthorityMode !== authorityMode ||
      handle.providerContinuationId !== ref.providerContinuationId ||
      !sameProviderConnectionIdentity(handle.providerConnection, ref.providerConnection)
    ) {
      if (handle) return null;
    } else {
      return handle;
    }
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "codex_app_server") {
      return null;
    }
    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (
        pending.ref.providerContinuationId !== ref.providerContinuationId
        || (pending.ref.lifecycleAuthorityMode ?? "typed_shadow") !== authorityMode
        || !sameProviderConnectionIdentity(pending.ref.providerConnection, connection)
      ) return null;
      return pending.promise;
    }
    const attaching = this.attachRunning(ref, connection).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Codex resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error("Codex mid-turn injection is not enabled: P0 proved room delivery, not native poke.");
  }

  private permissionAuthority(
    handle: CodexProviderHandle, continuation: string, connection: ProviderConnectionRef, rpcConnection: string | null,
  ): "current" | "degraded" | "unavailable" {
    if (handle.terminal || handle.stopRequested || handle.protocolError || this.handles.get(handle.workAttemptId) !== handle
      || handle.providerContinuationId !== continuation || !sameProviderConnectionIdentity(handle.providerConnection, connection)
      || !rpcConnection || handle.client.currentConnectionId() !== rpcConnection) return "unavailable";
    if (handle.pid === null || handle.pid !== connection.pid || !connection.processIdentity) return "degraded";
    try {
      const actual = this.deps.getProcessIdentity(handle.pid);
      if (actual === undefined) return "degraded";
      return typeof actual === "string" && sameProcessBirthIdentity(actual, connection.processIdentity) ? "current" : "unavailable";
    } catch { return "degraded"; }
  }

  /** Connection-only observation: disconnect loses pending authority, never reconnects or replays it. */
  async observePermissions(
    rawHandle: ProviderHandle, listener: (event: CodexPermissionObservation) => void, signal: AbortSignal,
  ): Promise<void> {
    const handle = this.requireHandle(rawHandle);
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      let disposed = false;
      const finish = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        handle.permissionInvalidationListeners.delete(refresh);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const refresh = () => {
        if (disposed || signal.aborted) return;
        const authority = this.permissionAuthority(handle, continuation, connection, rpcConnection);
        const event: CodexPermissionObservation = authority === "current"
          ? { type: "snapshot", requests: handle.client.listPendingRequests().filter(request =>
            request.connectionId === rpcConnection && permissionParams(request)?.threadId === continuation) }
          : { type: authority };
        try { listener(event); } catch { /* Observation never controls native work. */ }
        if (authority === "unavailable") finish();
      };
      const unsubscribe = handle.client.onPendingRequestsChanged(refresh);
      handle.permissionInvalidationListeners.add(refresh);
      signal.addEventListener("abort", finish, { once: true });
      refresh();
    });
  }

  /** Read the exact live proposed edits; historical thread items are not pending-edit evidence. */
  async inspectPermissionFileChanges(rawHandle: ProviderHandle, request: RpcServerRequest): Promise<readonly CodexPermissionFileChange[] | null> {
    try {
      const handle = this.handles.get(rawHandle.workAttemptId);
      if (!handle || handle !== rawHandle || request.method !== "item/fileChange/requestApproval") return null;
      const params = permissionParams(request);
      const continuation = handle.providerContinuationId;
      const connection = { ...handle.providerConnection };
      const rpcConnection = handle.client.currentConnectionId();
      const current = () => this.permissionAuthority(handle, continuation, connection, rpcConnection) === "current"
        && request.connectionId === rpcConnection && handle.client.listPendingRequests().includes(request)
        && !handle.terminalTurns.has(exactTurnKey(continuation, params!.turnId as string));
      if (!params || params.threadId !== continuation || !current()) return null;
      const response = recordValue(await handle.client.request("thread/turns/list", {
        threadId: continuation, limit: 1, sortDirection: "desc", itemsView: "full",
      }));
      if (!current() || !Array.isArray(response?.data) || response.data.length !== 1) return null;
      const turn = recordValue(response.data[0]);
      if (!turn || turn.id !== params.turnId || turn.status !== "inProgress" || turn.itemsView !== "full" || !Array.isArray(turn.items)) return null;
      const matches = turn.items.filter(item => recordValue(item)?.id === params.itemId);
      const item = recordValue(matches[0]);
      if (matches.length !== 1 || !item || item.type !== "fileChange" || item.status !== "inProgress") return null;
      return permissionFileChanges(item.changes);
    } catch { return null; }
  }

  /** Host-only dispatch. A successful WebSocket send is NOT evidence that Codex applied the decision. */
  async replyPermission(rawHandle: ProviderHandle, expectedRequest: RpcServerRequest, reply: "once" | "reject",
    options?: ProviderPermissionDispatchOptions):
    Promise<{ outcome: "sent"; scope: "request" }> {
    const handle = this.handles.get(rawHandle.workAttemptId);
    if (!handle || handle !== rawHandle) throw new CodexPermissionReplyError("not_dispatched");
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    const params = expectedRequest && permissionParams(expectedRequest);
    const fileChange = expectedRequest?.method === "item/fileChange/requestApproval";
    const expectedChanges = fileChange ? permissionFileChanges(options?.expectedFileChanges) : null;
    const decision = reply === "once" ? "accept" : reply === "reject" ? "decline" : null;
    if (!params || params.threadId !== continuation || !decision || (fileChange && !expectedChanges)
      || (decision === "accept" && expectedRequest.method === "item/fileChange/requestApproval" && params.grantRoot != null)
      || (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes(decision)))) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    const assertCurrent = () => {
      if (this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current"
        || expectedRequest.connectionId !== rpcConnection || !handle.client.listPendingRequests().includes(expectedRequest)
        || handle.terminalTurns.has(exactTurnKey(continuation, params.turnId as string))) {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    };
    assertCurrent();
    if (fileChange) {
      if (!isDeepStrictEqual(await this.inspectPermissionFileChanges(handle, expectedRequest), expectedChanges)) {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    } else {
      const boundary = await this.inspectTurnBoundary(handle);
      if (boundary.state !== "active" || boundary.providerContinuationId !== continuation || boundary.providerTurnId !== params.turnId) {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    }
    if (options) await options.beforeNativeDispatch();
    if (fileChange && !isDeepStrictEqual(await this.inspectPermissionFileChanges(handle, expectedRequest), expectedChanges)) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    // No await or observer callback between the final fence and native response.
    assertCurrent();
    options?.assertNativeDispatch?.();
    try { handle.client.respond(expectedRequest, { decision }); }
    catch { throw new CodexPermissionReplyError("uncertain"); }
    if (this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current") {
      throw new CodexPermissionReplyError("uncertain");
    }
    return { outcome: "sent", scope: "request" };
  }

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Codex continuation is terminal; no turn can be controlled.");
    const assertRuntimeAvailable = () => {
      if (isCodexRuntimeUnavailable(handle.state)) {
        throw new ProviderTurnControlError("Codex turn control lost live runtime authority.", "uncertain");
      }
    };
    assertRuntimeAvailable();
    const text = correction?.trim() || null;
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    assertRuntimeAvailable();
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new Error("Codex turn control resolved a different continuation thread.");
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    const selectedTurn = expectedTurnId
      ? read.thread?.turns?.find((candidate) => candidate.id === expectedTurnId)
      : read.thread?.turns?.at(-1);
    if (expectedTurnId && !selectedTurn) {
      throw new ProviderTurnControlError(
        "Codex no longer exposes the exact checkpointed turn; refusing to target a newer latest turn.",
        "uncertain",
      );
    }
    const turnId = selectedTurn?.id;
    const rawStatus = typeof selectedTurn?.status === "string"
      ? selectedTurn.status
      : selectedTurn?.status?.status;
    const terminal = /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(rawStatus ?? ""));
    const active = Boolean(turnId && isActiveCodexTurnStatus(rawStatus));
    const newerActiveTurnExists = Boolean(expectedTurnId && read.thread?.turns?.some((candidate) => {
      if (candidate.id === expectedTurnId) return false;
      const candidateStatus = typeof candidate.status === "string" ? candidate.status : candidate.status?.status;
      return isActiveCodexTurnStatus(candidateStatus);
    }));
    if (turnId && !active && !terminal) {
      throw new Error("Codex returned an unknown latest-turn state; refusing ambiguous turn control.");
    }
    if (turnId) {
      await options.checkpointTurnStarted?.(turnId);
      assertRuntimeAvailable();
    }
    if (newerActiveTurnExists) {
      if (text) {
        throw new ProviderTurnControlError(
          "Codex's checkpointed turn ended and a newer turn is active; the correction was not applied to that successor.",
          "not_applied",
        );
      }
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" };
    }
    if (active) {
      await options.markDispatched?.();
      assertRuntimeAvailable();
      const dispatchRead = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      assertRuntimeAvailable();
      const dispatchTurn = dispatchRead.thread?.turns?.find((candidate) => candidate.id === turnId);
      const dispatchStatus = typeof dispatchTurn?.status === "string"
        ? dispatchTurn.status
        : dispatchTurn?.status?.status;
      if (!dispatchTurn || !isActiveCodexTurnStatus(dispatchStatus)) {
        throw new ProviderTurnControlError(
          "Codex reached a terminal turn boundary before native interrupt dispatch.",
          "not_applied",
        );
      }
      await handle.client.request("turn/interrupt", {
        threadId: handle.providerContinuationId,
        turnId,
      });
      assertRuntimeAvailable();
      await this.waitForTurnBoundary(handle, turnId!);
      assertRuntimeAvailable();
      handle.setLiveState("idle");
    }
    if (text) {
      if (!active) {
        await options.markDispatched?.();
        assertRuntimeAvailable();
      }
      const turn = await handle.client.request<TurnStartResult>("turn/start", {
        threadId: handle.providerContinuationId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      assertRuntimeAvailable();
      if (!turn.turn?.id) throw new Error("Codex did not acknowledge the redirected turn.");
      handle.setLiveState("working");
    }
    assertRuntimeAvailable();
    return {
      capability: "native_interrupt",
      interrupted: active,
      resumed: Boolean(text),
      state: text ? "working" : "idle",
    };
  }

  async inspectTurn(providerHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.requireHandle(providerHandle);
    const exactTurnId = turnId.trim();
    if (!exactTurnId) return "unknown";
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) return "unknown";
    const turn = read.thread?.turns?.find((candidate) => candidate.id === exactTurnId);
    const status = typeof turn?.status === "string" ? turn.status : turn?.status?.status;
    if (!turn || !status) return "unknown";
    if (isActiveCodexTurnStatus(status)) return "active";
    return /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status)) ? "terminal" : "unknown";
  }

  /** Discovery only: MCP waiting is still an active turn, never an idle boundary. */
  async inspectTurnBoundary(providerHandle: ProviderHandle): Promise<NativeTurnBoundary> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const identity = connection.processIdentity;
    const current = () => {
      if (handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== continuation
        || !sameProviderConnectionIdentity(connection, handle.providerConnection)
        || handle.pid === null || handle.pid !== connection.pid || !identity) return false;
      const actual = this.deps.getProcessIdentity(handle.pid);
      return typeof actual === "string" && sameProcessBirthIdentity(actual, identity);
    };
    try {
      if (!nativeExecutionId(continuation) || !identity || !current()) return { state: "unknown" };
      // This may read a large history: it is explicit reconciliation, not a heartbeat.
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: continuation, includeTurns: true,
      });
      if (!current() || read?.thread?.id !== continuation || !Array.isArray(read.thread.turns)) return { state: "unknown" };
      let active: string | null = null;
      let latest: string | null = null;
      const seen = new Set<string>();
      for (const turn of read.thread.turns) {
        const id = turn?.id;
        const status = extractTurnStatus(turn);
        if (!nativeExecutionId(id) || seen.has(id)) return { state: "unknown" };
        seen.add(id);
        latest = id;
        if (isActiveCodexTurnStatus(status)) {
          if (active) return { state: "unknown" };
          active = id;
        } else if (!/^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(status ?? "")) {
          return { state: "unknown" };
        }
      }
      if (active) return { state: "active", providerContinuationId: continuation, nativeProcessIdentity: identity, providerTurnId: active };
      // A cached handle state or an active thread with no visible turn cannot
      // certify idle. Even a valid empty list requires native idle as well.
      if (extractThreadStatus(read.thread) !== "idle") return { state: "unknown" };
      return { state: "idle", providerContinuationId: continuation, nativeProcessIdentity: identity, latestProviderTurnId: latest };
    } catch {
      // Timeouts and unavailable snapshots are uncertainty, not runtime failure.
      return { state: "unknown" };
    }
  }

  async inspectCustodialPollingActivation(providerHandle: ProviderHandle, providerTurnId: string):
    Promise<{ state: "active" | "unknown" } | { state: "terminal"; outcome: "completed" | "failed" | "interrupted" }> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = structuredClone(handle.providerConnection);
    const current = () => {
      const actual = handle.pid === null ? undefined : this.deps.getProcessIdentity(handle.pid);
      return !handle.terminal && this.handles.get(handle.workAttemptId) === handle
        && handle.providerContinuationId === continuation && sameProviderConnectionIdentity(connection, handle.providerConnection)
        && handle.pid === connection.pid && typeof actual === "string" && Boolean(connection.processIdentity)
        && sameProcessBirthIdentity(actual, connection.processIdentity!);
    };
    try {
      if (!nativeExecutionId(providerTurnId) || !current()) return { state: "unknown" };
      const read = await handle.client.request<ThreadReadResult>("thread/read", { threadId: continuation, includeTurns: true });
      if (!current() || read?.thread?.id !== continuation || !Array.isArray(read.thread.turns)) return { state: "unknown" };
      const matches = read.thread.turns.filter(turn => turn?.id === providerTurnId);
      if (matches.length !== 1) return { state: "unknown" };
      const status = extractTurnStatus(matches[0])?.toLowerCase();
      if (isActiveCodexTurnStatus(status)) return { state: "active" };
      if (status === "completed" || status === "failed") return { state: "terminal", outcome: status };
      if (status === "interrupted" || status === "cancelled" || status === "stopped") return { state: "terminal", outcome: "interrupted" };
      return { state: "unknown" };
    } catch { return { state: "unknown" }; }
  }

  async activateCustodialPolling(providerHandle: ProviderHandle, request: CustodialPollingActivationRequest,
    options: CustodialPollingActivationOptions): Promise<{ providerTurnId: string }> {
    const handle = this.requireHandle(providerHandle);
    const input = structuredClone(request);
    const receipt = input.launchReceipt;
    const launch = this.pollingLaunches.get(handle);
    const continuation = handle.providerContinuationId;
    const connection = structuredClone(handle.providerConnection);
    const bounded = (value: unknown, limit = 512): value is string => typeof value === "string"
      && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
    if (![input.operationId, input.roomId, input.agentDisplayName, input.workerSession?.agentSessionId].every(value => bounded(value))
      || !bounded(input.cwd, 4096) || !/^(?:msg_)?\d+$/.test(input.workerSession?.roomCursor ?? "")
      || input.workerSession.roomCursor.length > 512 || !receipt || receipt.contract !== "custodial_polling_v1"
      || !Number.isSafeInteger(receipt.configurationRevision) || receipt.configurationRevision < 1
      || receipt.workAttemptId !== handle.workAttemptId || receipt.providerContinuationId !== continuation
      || receipt.agentSessionId !== input.workerSession.agentSessionId
      || !sameProviderConnectionIdentity(receipt.providerConnection, connection)
      || (launch && (launch.roomId !== input.roomId || launch.cwd !== input.cwd || launch.agentSessionId !== input.workerSession.agentSessionId
        || launch.configurationRevision !== receipt.configurationRevision))
      || typeof options.beforeNativeDispatch !== "function" || typeof options.checkpointTurnStarted !== "function") {
      throw new Error("Custodial polling activation requires exact applied launch authority.");
    }
    // A recovered handle cannot rediscover launch env from thread/read. The
    // privileged daemon supplies the durable receipt, revalidated in its
    // beforeNativeDispatch transaction. A known noncustodial launch is rejected.
    if (this.nonPollingLaunches.has(handle)) throw new Error("This runtime was not launched for custodial polling.");
    const assertCurrent = () => {
      const actual = handle.pid === null ? undefined : this.deps.getProcessIdentity(handle.pid);
      if (options.detachSignal?.aborted || handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== continuation || !sameProviderConnectionIdentity(handle.providerConnection, connection)
        || handle.pid !== connection.pid || !connection.processIdentity || typeof actual !== "string"
        || !sameProcessBirthIdentity(actual, connection.processIdentity)) throw new Error("Custodial polling activation lost its exact native runtime.");
    };
    assertCurrent();
    if (this.pollingDispatches.has(handle)) throw new Error("Custodial polling activation is already in progress.");
    this.pollingDispatches.add(handle);
    try {
      const boundary = await this.inspectTurnBoundary(handle);
      assertCurrent();
      if (boundary.state !== "idle") throw new Error("Custodial polling activation requires native idle evidence.");
      await options.beforeNativeDispatch();
      assertCurrent();
      const result = await handle.client.request<TurnStartResult>("turn/start", {
        threadId: continuation, cwd: input.cwd,
        input: [{ type: "text", text: buildCustodialPollingPrompt(input) }],
      });
      const id = result?.turn?.id;
      if (!nativeExecutionId(id)) throw new Error("Custodial polling activation returned no exact native turn ID.");
      await options.checkpointTurnStarted(id);
      return { providerTurnId: id };
    } finally { this.pollingDispatches.delete(handle); }
  }

  /**
   * Stops the one legacy polling turn selected by durable identity.  First
   * invocation discovers the latest active turn once; every replay with a
   * target id is exact and must never redirect to a newer turn.
   */
  async controlExactTurn(
    providerHandle: ProviderHandle,
    options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal },
  ): Promise<{ outcome: "no_active" | "terminal" | "interrupt_dispatched"; targetTurnId: string | null }> {
    const handle = this.requireHandle(providerHandle);
    const assertAttached = () => {
      if (options.detachSignal?.aborted) throw new Error("Codex exact turn control observation detached.");
    };
    assertAttached();
    const expected = options.targetTurnId?.trim() || null;
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new ProviderTurnControlError("Codex exact turn control resolved a different continuation thread.", "uncertain");
    }
    assertAttached();
    const turn = expected
      ? read.thread?.turns?.find((candidate) => candidate.id === expected)
      : read.thread?.turns?.at(-1);
    if (!turn) {
      if (!expected) return { outcome: "no_active", targetTurnId: null };
      throw new ProviderTurnControlError("Codex exact turn control cannot find the persisted target turn.", "uncertain");
    }
    const turnId = turn.id?.trim();
    const status = typeof turn.status === "string" ? turn.status : turn.status?.status;
    if (!turnId || !status) throw new ProviderTurnControlError("Codex exact turn control found an unknown target state.", "uncertain");
    // Discovery itself is durable fencing. Even a completed latest turn must
    // be recorded before returning, otherwise a crash can later rediscover a
    // newer unrelated latest turn while the cutover still says "prepared".
    await options.checkpointTargetTurn(turnId);
    assertAttached();
    if (/^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status))) {
      return { outcome: "terminal", targetTurnId: turnId };
    }
    if (!isActiveCodexTurnStatus(status)) throw new ProviderTurnControlError("Codex exact turn control found an unknown target state.", "uncertain");
    // This is deliberately the final callback boundary before native I/O.
    await options.markDispatched();
    assertAttached();
    const dispatchRead = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    const dispatchTurn = dispatchRead.thread?.turns?.find((candidate) => candidate.id === turnId);
    const dispatchStatus = typeof dispatchTurn?.status === "string" ? dispatchTurn.status : dispatchTurn?.status?.status;
    if (!dispatchTurn || /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(dispatchStatus ?? ""))) {
      return { outcome: "terminal", targetTurnId: turnId };
    }
    if (!isActiveCodexTurnStatus(dispatchStatus)) {
      throw new ProviderTurnControlError("Codex exact turn control found an unknown target state after dispatch.", "uncertain");
    }
    assertAttached();
    await handle.client.request("turn/interrupt", { threadId: handle.providerContinuationId, turnId });
    await this.waitForTurnBoundary(handle, turnId, options.detachSignal);
    handle.setLiveState("idle");
    return { outcome: "interrupt_dispatched", targetTurnId: turnId };
  }

  /** Execute one durable inbox item on this exact app-server/thread only. */
  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (!request.inboxItemId.trim() || !request.actionId.trim()) throw new Error("Bounded Codex room turn requires durable inbox and action ids.");
    const assertRuntimeAvailable = () => {
      if (handle.terminal || isCodexRuntimeUnavailable(handle.state)) {
        throw new Error("Codex runtime is unavailable; no bounded room turn can start.");
      }
    };
    assertRuntimeAvailable();
    await options.beforeNativeDispatch?.();
    assertRuntimeAvailable();
    handle.roomTurnResults.beginTurnStart(handle.providerContinuationId);
    let started: TurnStartResult;
    try {
      started = await handle.client.request<TurnStartResult>("turn/start", {
        threadId: handle.providerContinuationId,
        input: [{ type: "text", text: boundedRoomTurnPrompt(request), text_elements: [] }],
      });
    } catch (error) {
      handle.roomTurnResults.abandonTurnStart(handle.providerContinuationId);
      if (isMissingContinuation(error, handle.providerContinuationId)) {
        throw new ProviderContinuationMissingError(handle.providerContinuationId);
      }
      throw error;
    }
    const turnId = started.turn?.id?.trim();
    if (!turnId) {
      handle.roomTurnResults.abandonTurnStart(handle.providerContinuationId);
      throw new Error("Codex did not acknowledge the bounded room turn.");
    }
    handle.roomTurnResults.bindTurnStart(handle.providerContinuationId, turnId);
    // The durable id must exist before any terminal observation can race it.
    try {
      await options.checkpointTurnStarted?.(turnId);
    } catch (error) {
      // If terminal evidence raced the checkpoint but persistence failed, do
      // not retain that completed turn for a later unrelated invocation.
      handle.terminalTurns.delete(exactTurnKey(handle.providerContinuationId, turnId));
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw error;
    }
    handle.setLiveState("working");
    const terminal = await this.waitForExactRoomTurnTerminal(handle, turnId, options.detachSignal);
    // A bounded turn outcome does not describe the reusable app-server. The
    // daemon settles the exact turn separately; only process/control evidence
    // may make this handle failed.
    handle.setLiveState("idle");
    if (terminal.status !== "completed") {
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new Error(`Codex bounded room turn ${turnId} ended ${terminal.status}.`);
    }
    const result = handle.roomTurnResults.normalize(handle.providerContinuationId, turnId, terminal.turn);
    const terminalResult = { turnId, ...result };
    await options.checkpointTerminalResult?.(terminalResult);
    handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
    return terminalResult;
  }

  /** Reattach only the durable exact turn; never issue a second turn/start. */
  async recoverRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    const turnId = request.providerTurnId.trim();
    if (!turnId) throw new CodexRoomTurnRecoveryError("Codex room-turn recovery requires an exact persisted turn id.");
    handle.roomTurnResults.track(handle.providerContinuationId, turnId);
    const read = await handle.client.request<ThreadReadResult>("thread/read", { threadId: handle.providerContinuationId, includeTurns: true });
    if (read.thread?.id !== handle.providerContinuationId) throw new CodexRoomTurnRecoveryError("Codex room-turn recovery resolved a different continuation thread.");
    const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) {
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new CodexRoomTurnRecoveryError("Codex room-turn recovery cannot find the persisted exact turn.");
    }
    const status = String(typeof turn.status === "string" ? turn.status : turn.status?.status ?? "").toLowerCase();
    if (/^(?:completed|interrupted|failed|cancelled|stopped)$/.test(status)) {
      handle.terminalTurns.delete(exactTurnKey(handle.providerContinuationId, turnId));
      return this.roomTurnResultFromTerminal(handle, turnId, status, turn, options.checkpointTerminalResult);
    }
    if (!isActiveCodexTurnStatus(status)) {
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new CodexRoomTurnRecoveryError("Codex room-turn recovery found an unknown exact turn state.");
    }
    handle.setLiveState("working");
    const terminal = await this.waitForExactRoomTurnTerminal(handle, turnId, options.detachSignal);
    return this.roomTurnResultFromTerminal(handle, turnId, terminal.status, terminal.turn, options.checkpointTerminalResult);
  }

  /**
   * Verify a missing durable conversation over a short materialization grace
   * window, then create a replacement thread on this exact live app-server.
   * The handle object is retained so process-exit and stream ownership remain
   * singular; only its fenced continuation identity changes.
   */
  async repairContinuation(
    providerHandle: ProviderHandle,
    request: ProviderContinuationRepairRequest,
    options: {
      checkpointReplacement: (providerContinuationId: string) => Promise<void>;
      detachSignal?: AbortSignal;
    },
  ): Promise<ProviderContinuationRepairResult> {
    const handle = this.requireHandle(providerHandle);
    const expected = request.expectedProviderContinuationId.trim();
    if (!expected || expected !== handle.providerContinuationId
      || request.workAttemptId !== handle.workAttemptId) {
      throw new Error("Codex continuation repair no longer targets the exact active handle.");
    }
    if (handle.terminal) throw new Error("Codex continuation repair requires a live provider process.");
    if (handle.turnWaiters.size) throw new Error("Codex continuation repair is unsafe while a provider turn is active.");

    const assertAttached = () => {
      if (options.detachSignal?.aborted) {
        throw new CodexRoomTurnObservationDetachedError("Codex continuation repair detached.");
      }
      if (handle.terminal || this.handles.get(handle.workAttemptId) !== handle
        || handle.providerContinuationId !== expected || isCodexRuntimeUnavailable(handle.state)) {
        throw new Error("Codex continuation repair lost exact provider authority.");
      }
    };

    // Probe at absolute offsets 0s, 1s, 3s, and 7s. The waits are therefore
    // the differences between offsets, not 1s + 3s + 7s (which would turn the
    // advertised seven-second grace into eleven seconds).
    const policy = normalizeLaunchPolicy(request.launchPolicy);
    const probeDelays = [0, 1_000, 2_000, 4_000];
    const probe = async (threadId: string): Promise<boolean> => {
      for (const waitMs of probeDelays) {
        if (waitMs) await this.deps.sleep(waitMs);
        assertAttached();
        try {
          // A metadata-only thread/read can succeed for a persisted Codex
          // thread that the live app-server still cannot execute. thread/resume
          // is the materialization boundary: only its exact acknowledgement is
          // evidence that a following turn/start may use this continuation.
          const resumed = await handle.client.request<CodexThreadResult>("thread/resume", {
            threadId,
            cwd: request.cwd,
            ...policy,
            ...(request.model ? { model: request.model } : {}),
            ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          });
          assertAttached();
          if (resumed.thread?.id === threadId) return true;
          throw new Error("Codex continuation repair resolved a different thread.");
        } catch (error) {
          if (isMethodNotFound(error)) {
            this.resumeSupported = false;
            throw new Error("Codex app-server cannot materialize a saved conversation because thread/resume is unavailable.");
          }
          if (!isMissingContinuation(error, threadId)) throw error;
        }
      }
      return false;
    };

    const checkpointedReplacement = request.checkpointedReplacementProviderContinuationId?.trim() || null;
    if (checkpointedReplacement) {
      if (checkpointedReplacement === expected) {
        throw new Error("A checkpointed replacement must differ from the missing conversation.");
      }
      if (!await probe(checkpointedReplacement)) {
        throw new Error("The checkpointed replacement conversation is unavailable; refusing to create another orphan.");
      }
      await options.checkpointReplacement(checkpointedReplacement);
      assertAttached();
      handle.replaceContinuation(checkpointedReplacement);
      return {
        handle,
        outcome: "replaced",
        previousProviderContinuationId: expected,
        replacementProviderContinuationId: checkpointedReplacement,
      };
    }

    if (!request.forceReplacement && await probe(expected)) {
      return {
        handle,
        outcome: "rematerialized",
        previousProviderContinuationId: expected,
        replacementProviderContinuationId: expected,
      };
    }

    assertAttached();
    const started = await handle.client.request<CodexThreadResult>("thread/start", {
      cwd: request.cwd,
      ...policy,
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    });
    const replacement = started.thread?.id?.trim();
    if (!replacement || replacement === expected) {
      throw new Error("Codex continuation repair did not return a distinct replacement thread.");
    }
    // This is the commit barrier: an uncheckpointed thread remains an idle
    // orphan and can never become authoritative.
    await options.checkpointReplacement(replacement);
    assertAttached();
    handle.replaceContinuation(replacement);
    return {
      handle,
      outcome: "replaced",
      previousProviderContinuationId: expected,
      replacementProviderContinuationId: replacement,
    };
  }

  async stopRef(
    ref: ProviderContinuationRef,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    ref = { ...ref, providerConnection: ref.providerConnection && { ...ref.providerConnection } };
    const connection = ref.providerConnection;
    const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const force = options.force === true;
    if (!ref.workAttemptId?.trim() || !ref.providerContinuationId?.trim()
      || connection?.kind !== "codex_app_server" || !connection.url?.trim()
      || !Number.isSafeInteger(connection.pid) || connection.pid! <= 0
      || typeof connection.processIdentity !== "string" || !PS_BIRTH_EVIDENCE.test(connection.processIdentity.trim())
      || !Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Codex exact-reference stop requires an exact continuation and process birth.");
    }
    const pid = connection.pid!;
    const birth = connection.processIdentity;
    const isGone = () => {
      const current = this.deps.getProcessIdentity(pid);
      if (current === null) return true;
      // Unequal malformed ps output is uncertainty, not PID-reuse evidence.
      if (typeof current !== "string" || !PS_BIRTH_EVIDENCE.test(current.trim())) {
        throw new Error("Codex exact-reference stop is ambiguous because process birth cannot be verified.");
      }
      return !sameProcessBirthIdentity(current, birth);
    };
    const terminal = () => synthesizeTerminalPayload({
      endedAt: this.deps.now(), exitCode: null, signal: null,
      providerContinuationId: ref.providerContinuationId, stopRequested: true,
    });
    if (isGone()) return terminal();
    const known = [...this.handles.values()].find((handle) => handle.pid === pid
      && handle.providerConnection.processIdentity
      && sameProcessBirthIdentity(handle.providerConnection.processIdentity, birth));
    if (known && (known.workAttemptId !== ref.workAttemptId
      || known.providerContinuationId !== ref.providerContinuationId
      || !sameProviderConnectionIdentity(known.providerConnection, connection))) {
      throw new Error("Codex exact-reference stop conflicts with the known native process owner.");
    }
    if (known) { known.stopRequested = true; known.state = "stopping"; known.invalidatePermissions(); }
    const awaitAbsence = async () => {
      const deadline = Date.now() + graceMs;
      for (;;) {
        if (isGone()) return true;
        if (Date.now() >= deadline) return false;
        await delay(Math.min(25, deadline - Date.now()));
      }
    };
    this.deps.signalProcess(pid, force ? "SIGKILL" : "SIGTERM");
    if (await awaitAbsence()) return terminal();
    if (!force) {
      // Never escalate into a reused PID, nor accept a cached protocol error.
      if (isGone()) return terminal();
      this.deps.signalProcess(pid, "SIGKILL");
      if (await awaitAbsence()) return terminal();
    }
    throw new Error("Codex exact-reference stop has not yet proved the recorded process birth is gone.");
  }

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    if (handle.pid === null) {
      throw new Error("Cannot stop a Codex app-server without an observed process id.");
    }
    const pid = handle.pid;
    const processIdentity = handle.providerConnection.processIdentity;
    const assertProcessIdentity = () => {
      const currentIdentity = this.deps.getProcessIdentity(pid);
      if (!processIdentity || typeof currentIdentity !== "string"
        || !sameProcessBirthIdentity(currentIdentity, processIdentity)) {
        throw new Error("Cannot stop the Codex app-server because its exact process birth cannot be verified.");
      }
    };

    assertProcessIdentity();
    handle.stopRequested = true;
    handle.state = "stopping";
    handle.invalidatePermissions();
    const exitPromise = this.requireExitPromise(handle);
    if (options.force) {
      this.deps.signalProcess(pid, "SIGKILL");
      return exitPromise;
    }

    this.deps.signalProcess(pid, "SIGTERM");
    const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const graceful = await Promise.race([
      exitPromise.then((payload) => ({ payload })),
      delay(graceMs).then(() => null),
    ]);
    if (graceful) return graceful.payload;

    // A PID observed before the grace period may now belong to another child.
    assertProcessIdentity();
    this.deps.signalProcess(pid, "SIGKILL");
    return exitPromise;
  }

  onExit(
    providerHandle: ProviderHandle,
    listener: (payload: ProviderTerminalPayload) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) {
      queueMicrotask(() => listener(handle.terminal!));
      return () => {};
    }
    handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(
    providerHandle: ProviderHandle,
    listener: (event: ProviderActivityEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(
    providerHandle: ProviderHandle,
    listener: (event: ProviderStreamEvent) => void,
  ): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }

  onExecution(handle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.requireHandle(handle).execution.subscribe(listener);
  }

  async probeControl(providerHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.nativeRuntimeUnavailable) {
      return { state: "lost", controlEvidence: handle.nativeRuntimeUnavailable };
    }
    const proof = (): ControlProbeResult | null => {
      const expected = handle.providerConnection.processIdentity;
      if (handle.pid === null || !expected) return { state: "degraded" };
      const actual = this.deps.getProcessIdentity(handle.pid);
      if (actual === undefined) return { state: "degraded" };
      if (actual === null) return { state: "lost", controlEvidence: "process_exit" };
      if (!sameProcessBirthIdentity(actual, expected)) return { state: "lost", controlEvidence: "process_birth_changed" };
      return null;
    };
    let result = proof();
    if (!result) {
      try {
        // Pinned 0.144.1 has no ping. A single loaded-ID page is a cheap RPC
        // round trip, unlike thread/read which can serialize a whole history.
        const response = await handle.client.request<unknown>("thread/loaded/list", { limit: 1 }, { timeoutMs: 2_000 });
        const data = recordValue(response);
        result = proof() ?? (Array.isArray(data?.data) && data.data.length <= 1 && data.data.every(nativeExecutionId)
          ? { state: "responsive" } : { state: "degraded" });
      } catch (error) {
        result = proof() ?? { state: isMethodNotFound(error) ? "unprobeable" : "degraded" };
      }
    }
    if (handle.nativeRuntimeUnavailable) {
      return { state: "lost", controlEvidence: handle.nativeRuntimeUnavailable };
    }
    handle.execution.emit({ domain: "control", kind: "state_changed", sideEffects: "none", ...result },
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    return result;
  }

  private async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<CodexProviderHandle> {
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    if (lifecycleAuthorityMode === "typed" && req.deliveryMode !== "daemon_inbox") {
      throw new Error("Typed Codex lifecycle authority requires daemon-inbox delivery.");
    }
    if (req.pollingContract !== undefined && req.pollingContract !== "custodial_polling_v1") {
      throw new Error("Unsupported Codex polling contract.");
    }
    const custodialPolling = req.pollingContract === "custodial_polling_v1";
    if (custodialPolling) {
      req = { ...req, supervisorWorkerSession: req.supervisorWorkerSession && { ...req.supervisorWorkerSession } };
      resumeRef = resumeRef && { ...resumeRef };
    }
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) {
      throw new Error(`Codex work attempt '${req.workAttemptId}' already has a live process.`);
    }
    if (!req.agentDisplayName?.trim()) {
      throw new Error("Codex spawn requires the durable agent display name from the manifest.");
    }

    const policy = normalizeLaunchPolicy(attestProviderSpawnPolicy("codex", req));
    const supervisorCoordinates = [
      req.supervisorEntryId,
      req.supervisorSocketPath,
      req.supervisorExecutionGenerationId,
    ];
    const hasSupervisorCoordinate = supervisorCoordinates.some((value) => Boolean(value?.trim()));
    const hasCompleteSupervisorCoordinates = supervisorCoordinates.every((value) => Boolean(value?.trim()));
    if (hasSupervisorCoordinate && !hasCompleteSupervisorCoordinates) {
      throw new Error("Codex supervisor bridge coordinates are incomplete.");
    }
    let custodialRuntime: LetAgentsMcpRuntime | null = null;
    let custodialTools: string[] = [];
    let custodialApiUrl: string | null = null;
    if (custodialPolling) {
      if (req.deliveryMode !== "mcp_polling" || !hasCompleteSupervisorCoordinates
        || !req.roomId.trim() || !req.workAttemptId.trim() || !req.supervisorWorkerSession?.agentSessionId.trim()
        || !req.supervisorWorkerSession.apiUrl?.trim()) {
        throw new Error("Custodial polling requires exact supervisor, worker, room and API coordinates.");
      }
      try {
        const apiUrl = new URL(req.supervisorWorkerSession.apiUrl);
        if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/"
          || (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname)))) throw new Error();
        custodialApiUrl = apiUrl.origin;
      } catch { throw new Error("Custodial polling requires an exact safe worker API origin."); }
      ({ runtime: custodialRuntime, tools: custodialTools } = await this.resolveCustodialPollingRuntime(req.devMcpServerEntryPath));
    }
    if (hasCompleteSupervisorCoordinates) {
      await this.deps.writeSupervisorBridgeContext(req.cwd, {
        entry_id: req.supervisorEntryId!,
        room_id: req.roomId,
        work_attempt_id: req.workAttemptId,
        execution_generation_id: req.supervisorExecutionGenerationId!,
        ...(req.supervisorWorkerSession ? {
          agent_session_id: req.supervisorWorkerSession.agentSessionId,
          ...(req.agentDisplayName?.trim() ? { agent_display_name: req.agentDisplayName.trim() } : {}),
        } : {}),
      });
    }
    const devOverrides = !custodialPolling && req.devMcpServerEntryPath
      ? await buildCodexDevMcpEntryOverrides(req.devMcpServerEntryPath)
      : [];
    const supervisorEnvironment: Record<string, string> | undefined = req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId
      ? {
          LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId,
          LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath,
          LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
          LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId,
          LETAGENTS_SUPERVISOR_PROVIDER: "codex",
          ...(req.supervisorWorkerSession ? {
            LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
            LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
            ...(req.agentDisplayName?.trim() ? {
              LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim(),
            } : {}),
          } : {}),
          ...(req.deliveryMode === "daemon_inbox" ? {
            LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
            LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
            ...(req.supervisorEntryId.startsWith("supervised_rental_") ? {
              [rentalCredentialIsolationMarker]: "1",
            } : {}),
          } : { LETAGENTS_EXECUTION_PROFILE: custodialPolling ? "supervised_mcp_polling" : "interactive_desktop" }),
          ...(custodialPolling ? {
            LETAGENTS_API_URL: custodialApiUrl!,
            LETAGENTS_SUPERVISED_BOUNDED_TURNS: "",
            LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "",
            LETAGENTS_TOKEN: "",
            LETAGENTS_AGENT_SESSION_BEARER: "",
          } : {}),
        } : undefined;
    const serverUrl = await this.deps.resolveServerUrl();
    const launch = this.deps.launchServer(serverUrl, this.codexBin, {
      trustedProjectPath: req.cwd,
      configOverrides: custodialRuntime
        ? [custodialMcpOverride(custodialRuntime.entryPath, req.cwd, supervisorEnvironment!, custodialTools)]
        : [...codexMcpWorkplaceConfigOverrides(req.cwd), ...devOverrides],
      ...(supervisorEnvironment ? { env: supervisorEnvironment } : {}),
    });
    const ready = await this.deps.waitForServer(serverUrl, launch);
    if (!ready) {
      if (launch.pid !== null) this.deps.signalProcess(launch.pid, "SIGTERM");
      throw new Error(`Timed out waiting for Codex app-server at ${serverUrl}`);
    }
    if (launch.pid === null) {
      // Node exposes no safe signalling target in this state. Fail closed until
      // the launch itself proves terminal instead of retrying beside an orphan.
      await launch.exited;
      throw new Error(
        "Codex app-server launch did not expose a process id; refusing to start an unfenceable writer.",
      );
    }
    const processIdentity = this.deps.getProcessIdentity(launch.pid);
    if (typeof processIdentity !== "string" || !processIdentity) {
      await terminateFreshLaunch(launch, this.deps);
      throw new Error(
        "Codex app-server process identity could not be verified; refusing to start an unfenceable writer.",
      );
    }

    let handle: CodexProviderHandle | null = null;
    const pendingNotifications: RpcNotification[] = [];
    const client = this.deps.createRpcClient(serverUrl, (notification) => {
      if (!handle) {
        pendingNotifications.push(notification);
        return;
      }
      this.consumeNotification(handle, notification);
    });
    const observedLaunch: CodexAppServerLaunch = {
      pid: launch.pid,
      exited: observeFencedExit(client, launch.pid, processIdentity, launch.exited, this.deps),
    };

    try {
      await client.connect();
      await requireLetAgentsWorkplace(client);
      if (resumeRef && !this.resumeSupported) {
        throw new Error(
          "Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.",
        );
      }
      let threadResult: CodexThreadResult;
      if (resumeRef) {
        try {
          threadResult = await client.request<CodexThreadResult>("thread/resume", {
            threadId: resumeRef.providerContinuationId,
            cwd: req.cwd,
            ...policy,
            ...(req.model ? { model: req.model } : {}),
            ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
          });
        } catch (error) {
          if (!isMethodNotFound(error)) throw error;
          this.resumeSupported = false;
          throw new Error(
            "Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.",
          );
        }
      } else {
        threadResult = await client.request<CodexThreadResult>("thread/start", {
          cwd: req.cwd,
          ...policy,
          ...(req.model ? { model: req.model } : {}),
          ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
        });
      }
      const threadId = threadResult.thread?.id;
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      if (resumeRef && threadId !== resumeRef.providerContinuationId) {
        throw new Error("Codex app-server resumed a different thread than requested.");
      }

      handle = new CodexProviderHandle(
        req.workAttemptId,
        launch.pid,
        threadId,
        { kind: "codex_app_server", url: serverUrl, pid: launch.pid, processIdentity },
        lifecycleAuthorityMode,
        client,
        observedLaunch,
        this.deps.now,
      );
      handle.setLiveState("idle");
      this.emitNativeExecution(handle, {
        domain: "runtime",
        kind: "state_changed",
        state: "ready",
        sideEffects: "none",
      });
      this.handles.set(req.workAttemptId, handle);
      if (custodialPolling) {
        handle.custodyLaunchAgentSessionId = req.supervisorWorkerSession!.agentSessionId;
        this.pollingLaunches.set(handle, { roomId: req.roomId, cwd: req.cwd, configurationRevision: req.configurationRevision,
          agentSessionId: req.supervisorWorkerSession!.agentSessionId });
      }
      else this.nonPollingLaunches.add(handle);
      const exitPromise = observedLaunch.exited.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification);
      }

      if (resumeRef) {
        // Read the durable continuation before starting its next turn. Besides
        // producing activity evidence, this verifies that the exact resumed
        // thread exposes its prior transcript to the new native process.
        await this.emitTranscriptTail(handle);
      }

      // Both custodial profiles return idle. Daemon-inbox starts work only
      // after its inbox claim; custodial polling activation is a later action.
      if (req.deliveryMode === "daemon_inbox" || custodialPolling) {
        handle.setLiveState("idle");
        return handle;
      }

      const prompt = buildCodexStartPrompt({
        roomIdentifier: req.roomId,
        joinedVia: looksLikeInviteCode(req.roomId) ? "join_code" : "join_room",
        cwd: req.cwd,
        deliveryMode: req.deliveryMode ?? "mcp_polling",
        stopPhrase: DEFAULT_CODEX_STOP_PHRASE,
        token: makeCodexStopToken(),
        suggestedDisplayName: req.agentDisplayName.trim(),
        deadlineUtc: null,
        maxMinutes: 0,
        ...(resumeRef && req.supervisorWorkerSession
          ? { resumeWorker: req.supervisorWorkerSession }
          : {}),
      });
      const turn = await client.request<TurnStartResult>("turn/start", {
        threadId,
        cwd: req.cwd,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      if (!turn.turn?.id) {
        throw new Error("Codex app-server did not return a turn id.");
      }
      handle.setLiveState("working");
      void this.emitTranscriptTail(handle);
      return handle;
    } catch (error) {
      if (handle) handle.protocolError = true;
      client.close();
      if (launch.pid !== null) this.deps.signalProcess(launch.pid, "SIGTERM");
      throw error;
    }
  }

  private async attachRunning(
    ref: ProviderContinuationRef,
    connection: Extract<ProviderConnectionRef, { kind: "codex_app_server" }>,
  ): Promise<CodexProviderHandle | ProviderAttachTerminal | null> {
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error(
        "Codex app-server attach is ambiguous; refusing to launch a second writer: the durable endpoint has no verified process identity.",
      );
    }
    const initialIdentity = this.deps.getProcessIdentity(connection.pid);
    if (initialIdentity === undefined) {
      throw new Error(
        "Codex app-server attach is ambiguous; refusing to launch a second writer: the recorded process identity cannot be verified.",
      );
    }
    if (initialIdentity === null || !sameProcessBirthIdentity(initialIdentity, connection.processIdentity)) {
      return {
        state: "terminal",
        terminal: {
          endedAt: this.deps.now(),
          exitCode: null,
          signal: null,
          terminalCause: "crashed",
          providerContinuationId: ref.providerContinuationId,
        },
      };
    }
    let handle: CodexProviderHandle | null = null;
    let exactEndpointVerified = false;
    const pendingNotifications: RpcNotification[] = [];
    const client = this.deps.createRpcClient(connection.url, (notification) => {
      if (!handle) pendingNotifications.push(notification);
      else this.consumeNotification(handle, notification);
    });
    try {
      await client.connect();
      await requireLetAgentsWorkplace(client);
      let read: ThreadReadResult;
      let continuationMissing = false;
      let exactEmptyFallback = false;
      try {
        read = await client.request<ThreadReadResult>("thread/read", {
          threadId: ref.providerContinuationId,
          includeTurns: true,
        });
      } catch (error) {
        if (isMissingContinuation(error, ref.providerContinuationId)) {
          // The process endpoint is still authenticated below. Preserve a live
          // handle so the daemon can journal and repair this missing
          // continuation without launching a competing app-server.
          continuationMissing = true;
          read = { thread: { id: ref.providerContinuationId, turns: [] } };
        } else {
          if (!isUnmaterializedEmptyThreadRead(error)) throw error;
          // Codex creates daemon-inbox threads before their first room turn.
          // Those threads deliberately reject includeTurns, but the metadata
          // read still proves that this exact live endpoint owns the durable
          // continuation. Never use this fallback for generic read failures.
          read = await client.request<ThreadReadResult>("thread/read", {
            threadId: ref.providerContinuationId,
            includeTurns: false,
          });
          exactEmptyFallback = true;
        }
      }
      if (read.thread?.id !== ref.providerContinuationId) {
        throw new Error("Codex app-server did not verify the exact durable continuation thread.");
      }
      exactEndpointVerified = true;
      if (connection.pid === null || !connection.processIdentity) {
        throw new Error("durable endpoint has no verified process identity");
      }
      const currentIdentity = this.deps.getProcessIdentity(connection.pid);
      if (currentIdentity === undefined) {
        throw new Error("durable endpoint process identity cannot be verified");
      }
      if (currentIdentity === null || !sameProcessBirthIdentity(currentIdentity, connection.processIdentity)) {
        throw new Error("durable endpoint process identity no longer matches its recorded birth");
      }
      const observedExit = this.deps.observeProcessExit(
        connection.pid,
        connection.processIdentity,
      );
      const exitEvidence = observeFencedExit(
        client,
        connection.pid,
        connection.processIdentity,
        observedExit,
        this.deps,
      );
      const launch: CodexAppServerLaunch = { pid: connection.pid, exited: exitEvidence };
      handle = new CodexProviderHandle(
        ref.workAttemptId,
        connection.pid,
        ref.providerContinuationId,
        connection,
        ref.lifecycleAuthorityMode ?? "typed_shadow",
        client,
        launch,
        this.deps.now,
      );
      handle.setLiveState(continuationMissing ? "idle" : "working");
      this.handles.set(ref.workAttemptId, handle);
      this.exitPromises.set(handle, launch.exited.then((exit) => this.observeExit(handle!, exit)));
      const queuedTurnLifecycle = pendingNotifications.some(notification =>
        this.queuedTurnLifecycleIsAmbiguous(handle!, notification));
      this.reconstructAttachedExecution(
        handle,
        continuationMissing ? null : read,
        exactEmptyFallback,
        queuedTurnLifecycle,
      );
      if (!continuationMissing) {
        this.publishStream(handle, "thread/read", {
          threadId: handle.providerContinuationId,
          threadStatus: read.thread?.status,
          latestTurn: transcriptLifecycleTurn(read.thread?.turns?.at(-1)),
        }, "transcript_snapshot");
      }
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification, false);
      }
      return handle;
    } catch (error) {
      client.close();
      const currentIdentity = connection.pid !== null && connection.processIdentity
        ? this.deps.getProcessIdentity(connection.pid)
        : undefined;
      if (
        !exactEndpointVerified
        && connection.pid !== null
        && connection.processIdentity
        && currentIdentity !== undefined
        && (currentIdentity === null || !sameProcessBirthIdentity(currentIdentity, connection.processIdentity))
      ) {
        return {
          state: "terminal",
          terminal: {
            endedAt: this.deps.now(),
            exitCode: null,
            signal: null,
            terminalCause: "crashed",
            providerContinuationId: ref.providerContinuationId,
          },
        };
      }
      throw new Error(
        `Codex app-server attach is ambiguous; refusing to launch a second writer: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Rebuild only the bounded native boundary returned by the exact attach
   * read. The daemon still owns turn identity: it accepts this candidate only
   * when it matches an already-durable provider-turn binding.
   */
  private reconstructAttachedExecution(
    handle: CodexProviderHandle,
    read: ThreadReadResult | null,
    exactEmptyFallback: boolean,
    queuedTurnLifecycle: boolean,
  ): void {
    this.emitNativeExecution(handle, {
      domain: "runtime",
      kind: "state_changed",
      state: "ready",
      sideEffects: "none",
    });
    if (queuedTurnLifecycle) {
      // The app-server protocol gives notifications no ordering token relative
      // to thread/read. Coexisting snapshot and lifecycle evidence is therefore
      // ambiguous even when both shapes are individually readable.
      handle.execution.markUnavailable();
      return;
    }
    if (read === null) {
      // A proven-missing continuation has no native turn to reconstruct. Keep
      // this source recoverable: same-process continuation repair replaces the
      // thread on this handle and must not inherit a permanent observation gap.
      return;
    }
    if (exactEmptyFallback) return;
    const turns = read.thread?.turns;
    if (!Array.isArray(turns)) {
      handle.execution.markUnavailable();
      return;
    }
    const turn = turns.at(-1);
    if (!turn) return;
    const providerTurnId = turn?.id;
    const status = extractTurnStatus(turn)?.trim().toLowerCase() ?? null;
    if (!nativeExecutionId(providerTurnId) || !status) {
      handle.execution.markUnavailable();
      return;
    }
    const identity = {
      providerContinuationId: handle.providerContinuationId,
      providerTurnId,
    };
    if (isActiveCodexTurnStatus(status)) {
      this.emitNativeExecution(handle, {
        ...identity,
        domain: "turn",
        kind: "state_changed",
        state: "active",
        sideEffects: "none",
      });
      return;
    }
    const outcome = status === "completed" || status === "failed"
      ? status
      : /^(?:interrupted|cancelled|stopped)$/.test(status) ? "interrupted" : null;
    if (!outcome) {
      handle.execution.markUnavailable();
      return;
    }
    this.emitNativeExecution(handle, {
      ...identity,
      domain: "turn",
      kind: "state_changed",
      state: "terminal",
      turnOutcome: outcome,
      sideEffects: "none",
    });
  }

  private queuedTurnLifecycleIsAmbiguous(
    handle: CodexProviderHandle,
    notification: RpcNotification,
  ): boolean {
    if (!(notification.method === "turn/started"
      || /^turn\/(?:completed|failed|interrupted|cancelled|stopped)$/i.test(notification.method))) return false;
    const params = recordValue(notification.params);
    if (!params || !nativeExecutionId(params.threadId)) return true;
    return params.threadId === handle.providerContinuationId;
  }

  private emitNativeExecution(handle: CodexProviderHandle, fact: NativeExecutionFact): void {
    if (handle.nativeRuntimeUnavailable) return;
    if (fact.domain === "execution") {
      const key = JSON.stringify([fact.providerContinuationId, fact.providerTurnId, fact.executionId]);
      if (fact.kind === "completed") handle.nativeActiveOperations.delete(key);
      else handle.nativeActiveOperations.set(key, fact);
    } else if (fact.domain === "turn") {
      const key = JSON.stringify([fact.providerContinuationId, fact.providerTurnId]);
      if (fact.state === "active") {
        handle.nativeActiveTurns.set(key, {
          providerContinuationId: fact.providerContinuationId,
          providerTurnId: fact.providerTurnId,
        });
      } else handle.nativeActiveTurns.delete(key);
    }
    handle.execution.emit(
      fact,
      handle.providerConnection.processIdentity ?? undefined,
      handle.providerConnection.pid ?? undefined,
    );
  }

  private consumeNotification(
    handle: CodexProviderHandle,
    notification: RpcNotification,
    correlateLifecycle = true,
  ): void {
    const nativeLifecycle = this.observeNativeExecution(handle, notification, correlateLifecycle);
    handle.roomTurnResults.observe(notification.method, notification.params);
    const exactTurnId = notificationTurnId(notification.params);
    const exactThreadId = notificationThreadId(notification.params);
    const terminalMatch = /^turn\/(completed|interrupted|failed|cancelled|stopped)$/i.exec(notification.method);
    // Record the durable in-memory terminal edge first. Stream/activity
    // observers are best-effort and must never suppress exact turn settlement.
    if (exactTurnId && exactThreadId === handle.providerContinuationId && terminalMatch) {
      const nativeStatus = recordValue(recordValue(notification.params)?.turn)?.status;
      const terminalStatus = typeof nativeStatus === "string"
        && /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(nativeStatus)
        ? nativeStatus.toLowerCase()
        : terminalMatch[1]!.toLowerCase();
      this.noteExactTurnTerminal(handle, exactTurnKey(exactThreadId, exactTurnId), terminalStatus);
    }
    // Build the readable summary once and attach the same value to both the
    // ordered stream and the compact activity event. In particular, Codex's
    // approved summaryTextDelta stream is accumulated here; raw reasoning
    // textDelta content remains hidden by summarizeCodexRuntimeNotification.
    const summary = summarizeCodexRuntimeNotification(notification);
    this.publishStream(handle, notification.method, notification.params, streamKind(notification.method), summary.summary,
      nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
    // Execution status belongs to the item, never to the reusable app-server.
    // Exact turn settlement above remains independent of this runtime state.
    const lifecycle = isCodexExecutionMethod(notification.method) ? null
      : terminalMatch ? "idle"
      : /(?:^|\/)(?:failed|systemError)$/i.test(notification.method)
      ? "failed"
      : codexLifecycleStatus(notification.params)
        ?? (/^(?:turn|thread)\/(?:completed|interrupted|stopped)$/i.test(notification.method) ? "idle" : null)
        ?? (/^(?:turn|thread)\/(?:started|resumed)$/i.test(notification.method) ? "working" : null);
    if (handle.lifecycleAuthorityMode === "typed") {
      if (nativeLifecycle?.phase === "turn_active") handle.setLiveState("working");
      else if (nativeLifecycle?.phase === "turn_terminal") handle.setLiveState("idle");
    } else if (lifecycle === "failed") handle.state = "failed";
    else if (lifecycle) handle.setLiveState(lifecycle);
    this.publishActivity(handle, {
      source: "native_harness",
      method: notification.method,
      ...summary,
    });
    if (/^(turn\/completed|item\/completed)$/.test(notification.method)) {
      void this.emitTranscriptTail(handle);
    }
  }

  private observeNativeExecution(
    handle: CodexProviderHandle,
    notification: RpcNotification,
    correlateLifecycle = true,
  ): NativeLifecycleCheckpoint | null {
    if (handle.nativeRuntimeUnavailable) return null;
    const params = recordValue(notification.params);
    const explicitRuntimeFailure = notification.method === "process/systemError"
      || (notification.method === "thread/status/changed"
        && params?.threadId === handle.providerContinuationId
        && hasExplicitCodexSystemError(params));
    if (explicitRuntimeFailure) {
      this.emitNativeRuntimeUnavailable(handle, "native_session_terminated");
      return null;
    }
    if (!params || params.threadId !== handle.providerContinuationId || !nativeExecutionId(params.threadId)) return null;
    const terminalMethod = /^turn\/(?:completed|failed|interrupted|cancelled|stopped)$/i.test(notification.method);
    const turn = recordValue(params.turn);
    if (params.turnId !== undefined && turn?.id !== undefined && params.turnId !== turn.id) {
      if (terminalMethod) this.markNativeExecutionUnavailable(handle);
      return null;
    }
    const providerTurnId = params.turnId ?? turn?.id;
    if (!nativeExecutionId(providerTurnId)) {
      if (terminalMethod) this.markNativeExecutionUnavailable(handle);
      return null;
    }
    const identity = { providerContinuationId: params.threadId, providerTurnId };
    const emit = (fact: NativeExecutionFact) => this.emitNativeExecution(handle, fact);
    if (notification.method === "turn/started") {
      const nativeLifecycle = correlateLifecycle ? nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_active",
        providerContinuationId: params.threadId,
        providerTurnId,
        nativeProcessPid: handle.providerConnection.pid ?? undefined,
        nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
      }) : null;
      emit({ domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" });
      emit({ ...identity, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
        ...(nativeLifecycle ? { nativeEventId: nativeLifecycle.nativeEventId } : {}) });
      return nativeLifecycle;
    }
    if (terminalMethod) {
      const outcome = terminalTurnOutcome(notification.method, turn);
      if (outcome) {
        const nativeLifecycle = correlateLifecycle ? nativeLifecycleCheckpoint({
          provider: this.id,
          workAttemptId: handle.workAttemptId,
          phase: "turn_terminal",
          providerContinuationId: params.threadId,
          providerTurnId,
          nativeProcessPid: handle.providerConnection.pid ?? undefined,
          nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
          terminalDiscriminator: outcome,
        }) : null;
        emit({ ...identity, domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: outcome,
          sideEffects: "none", ...(nativeLifecycle ? { nativeEventId: nativeLifecycle.nativeEventId } : {}) });
        return nativeLifecycle;
      }
      this.markNativeExecutionUnavailable(handle);
      return null;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      if (nativeExecutionId(params.itemId) && typeof params.delta === "string" && params.delta.length > 0) {
        emit({ ...identity, domain: "execution", executionId: params.itemId, operation: "command", kind: "output", outputBytes: Buffer.byteLength(params.delta), sideEffects: "possible" });
      }
      return null;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") return null;
    const item = recordValue(params.item);
    if (!item || !nativeExecutionId(item.id)) return null;
    const operation = item.type === "commandExecution" ? "command"
      : item.type === "fileChange" ? "file_change" : item.type === "mcpToolCall" ? "other" : null;
    if (!operation) return null;
    const base = { ...identity, domain: "execution" as const, executionId: item.id, operation } as const;
    if (notification.method === "item/started") {
      // item/started can precede requestApproval. Only an actual PTY process
      // proves command start here; other items remain terminal-only evidence.
      if (operation === "command" && item.status === "inProgress" && nativeExecutionId(item.processId)) {
        emit({ ...base, kind: "started", sideEffects: "possible" });
      }
      return null;
    }
    if (item.status === "declined" && (operation === "command" || operation === "file_change")) {
      emit({ ...base, kind: "completed", outcome: "denied_before_start", sideEffects: "none" });
    } else if (item.status === "completed" || item.status === "failed") {
      const exitCode = operation === "command" && Number.isInteger(item.exitCode)
        && Number(item.exitCode) >= -2147483648 && Number(item.exitCode) <= 2147483647 ? Number(item.exitCode) : undefined;
      emit({ ...base, kind: "completed", outcome: item.status === "failed" || (exitCode !== undefined && exitCode !== 0) ? "failed" : "succeeded",
        sideEffects: operation === "file_change" && item.status === "completed" ? "observed" : "possible",
        ...(exitCode !== undefined ? { exitCode } : {}) });
    }
    return null;
  }

  private markNativeExecutionUnavailable(handle: CodexProviderHandle): void {
    handle.execution.markUnavailable();
    handle.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
  }

  private emitNativeRuntimeUnavailable(
    handle: CodexProviderHandle,
    controlEvidence: "process_exit" | "native_session_terminated",
  ): void {
    if (handle.nativeRuntimeUnavailable) return;
    handle.nativeRuntimeUnavailable = controlEvidence;
    handle.state = "failed";
    const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact,
      handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    for (const fact of handle.nativeActiveOperations.values()) {
      emit({ domain: "execution", kind: "completed", executionId: fact.executionId, operation: fact.operation,
        providerContinuationId: fact.providerContinuationId, providerTurnId: fact.providerTurnId,
        outcome: "lost_after_start", sideEffects: fact.sideEffects });
    }
    handle.nativeActiveOperations.clear();
    for (const turn of handle.nativeActiveTurns.values()) {
      emit({ ...turn, domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none" });
    }
    handle.nativeActiveTurns.clear();
    emit({ domain: "control", kind: "state_changed", state: "lost", controlEvidence, sideEffects: "none" });
    emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence, sideEffects: "none" });
  }

  private async emitTranscriptTail(handle: CodexProviderHandle): Promise<void> {
    try {
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      const latestTurn = read.thread?.turns?.at(-1);
      this.publishStream(handle, "thread/read", {
        threadId: handle.providerContinuationId,
        threadStatus: read.thread?.status,
        latestTurn: transcriptLifecycleTurn(latestTurn),
      }, "transcript_snapshot");
      const snapshot = summarizeCodexRuntimeSnapshot({
        threadStatus: typeof read.thread?.status === "string"
          ? read.thread.status
          : read.thread?.status?.type,
        turnStatus: typeof latestTurn?.status === "string"
          ? latestTurn.status
          : latestTurn?.status?.status,
        recentItems: latestTurn?.items ?? latestTurn?.output ?? [],
      });
      if (!snapshot) return;
      this.publishActivity(handle, {
        source: "transcript_tail",
        method: "thread/read",
        ...snapshot,
      });
    } catch {
      // Runtime evidence is best effort and must never end the worker turn.
    }
  }

  private async waitForTurnBoundary(handle: CodexProviderHandle, turnId: string, detachSignal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (detachSignal?.aborted) throw new Error("Codex exact turn control observation detached.");
      const read = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
      const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
      const status = typeof turn?.status === "string" ? turn.status : turn?.status?.status;
      if (!turn || /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(status ?? ""))) return;
      await delay(50);
    }
    throw new Error("Codex did not prove the active turn reached an interrupted boundary.");
  }

  /** Terminal correlation is event-driven and deliberately thread+turn exact. */
  private async waitForExactRoomTurnTerminal(
    handle: CodexProviderHandle,
    turnId: string,
    detachSignal?: AbortSignal,
  ): Promise<{ status: string; turn: ThreadReadTurn }> {
    const status = await this.waitForExactTurnNotification(handle, exactTurnKey(handle.providerContinuationId, turnId), detachSignal);
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
    if (read.thread?.id !== handle.providerContinuationId) {
      throw new Error("Codex bounded room turn read resolved a different continuation thread.");
    }
    const turn = read.thread?.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error("Codex bounded room turn is missing from its exact continuation thread.");
    const readStatus = String(typeof turn.status === "string" ? turn.status : turn.status?.status ?? "").toLowerCase();
    if (readStatus !== status || !/^(?:completed|interrupted|failed|cancelled|stopped)$/.test(readStatus)) {
      throw new Error(`Codex bounded room turn ${turnId} terminal event did not match its exact thread state.`);
    }
    return { status: readStatus, turn };
  }

  private async roomTurnResultFromTerminal(
    handle: CodexProviderHandle,
    turnId: string,
    status: string,
    turn: ThreadReadTurn,
    checkpointTerminalResult?: ProviderRoomTurnOptions["checkpointTerminalResult"],
  ): Promise<ProviderRoomTurnResult> {
    // A terminal native turn leaves the reusable app-server at an idle turn
    // boundary even when that turn failed or was interrupted.
    handle.setLiveState("idle");
    if (status !== "completed") {
      handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
      throw new CodexRoomTurnRecoveryError(`Codex bounded room turn ${turnId} ended ${status}.`);
    }
    const result = handle.roomTurnResults.normalize(handle.providerContinuationId, turnId, turn);
    const terminalResult = { turnId, ...result };
    await checkpointTerminalResult?.(terminalResult);
    handle.roomTurnResults.clear(handle.providerContinuationId, turnId);
    return terminalResult;
  }

  private waitForExactTurnNotification(handle: CodexProviderHandle, key: string, detachSignal?: AbortSignal): Promise<string> {
    const cached = handle.terminalTurns.get(key);
    if (cached) { handle.terminalTurns.delete(key); return Promise.resolve(cached); }
    if (handle.turnWaiters.has(key)) throw new Error("Codex bounded room turn already has a terminal waiter.");
    if (detachSignal?.aborted) return Promise.reject(new CodexRoomTurnObservationDetachedError("Codex room-turn observation detached."));
    return new Promise<string>((resolve, reject) => {
      const onDetach = () => {
        const current = handle.turnWaiters.get(key);
        if (current?.owner === owner) handle.turnWaiters.delete(key);
        reject(new CodexRoomTurnObservationDetachedError("Codex room-turn observation detached."));
      };
      const owner = Symbol(key);
      const waiter = {
        owner,
        resolve: (status: string) => {
          detachSignal?.removeEventListener("abort", onDetach);
          resolve(status);
        },
        reject: (error: Error) => {
          detachSignal?.removeEventListener("abort", onDetach);
          reject(error);
        },
      };
      handle.turnWaiters.set(key, waiter);
      detachSignal?.addEventListener("abort", onDetach, { once: true });
    });
  }

  private noteExactTurnTerminal(handle: CodexProviderHandle, key: string, status: string): void {
    const waiter = handle.turnWaiters.get(key);
    if (waiter) {
      handle.turnWaiters.delete(key);
      waiter.resolve(status);
      return;
    }
    handle.terminalTurns.set(key, status);
    while (handle.terminalTurns.size > 64) handle.terminalTurns.delete(handle.terminalTurns.keys().next().value!);
  }

  private publishStream(
    handle: CodexProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
    summary: string | null = null,
    nativeEventId: string | null = null,
    nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
  ): void {
    const safe = safeStreamPayload(providerPayload);
    const event: ProviderStreamEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      sequence: ++handle.streamSequence,
      provider: this.id,
      kind,
      method,
      ...(nativeEventId ? { nativeEventId } : {}),
      ...(nativeLifecyclePhase ? { nativeLifecyclePhase } : {}),
      summary,
      ...safe,
      durablePayloadRef: null,
    };
    this.streamSink?.(event);
    for (const listener of handle.streamListeners) listener(event);
  }

  private publishActivity(
    handle: CodexProviderHandle,
    input: {
      source: ProviderActivityEvent["source"];
      method: string | null;
      summary: string;
      status: ProviderActivityEvent["status"];
      checking: string;
      next_action: string;
    },
  ): void {
    const event: ProviderActivityEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      source: input.source,
      method: input.method,
      summary: input.summary,
      status: input.status,
      checking: input.checking,
      nextAction: input.next_action,
    };
    this.activitySink?.(event);
    for (const listener of handle.activityListeners) listener(event);
  }

  private observeExit(
    handle: CodexProviderHandle,
    exit: CodexAppServerExit,
  ): ProviderTerminalPayload {
    if (exit.type === "exit") {
      this.emitNativeRuntimeUnavailable(handle, "process_exit");
    } else if (!handle.nativeRuntimeUnavailable) {
      handle.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
        handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    }
    const terminal = exit.type === "error"
      ? {
        ...synthesizeTerminalPayload({
          endedAt: this.deps.now(),
          exitCode: null,
          signal: null,
          providerContinuationId: handle.providerContinuationId,
          stopRequested: handle.stopRequested,
        }),
        terminalCause: "protocol_error" as const,
      }
      : synthesizeTerminalPayload({
        endedAt: this.deps.now(),
        exitCode: exit.code,
        signal: exit.signal,
        providerContinuationId: handle.providerContinuationId,
        stopRequested: handle.stopRequested,
      });
    if (handle.protocolError) terminal.terminalCause = "protocol_error";
    handle.terminal = terminal;
    handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
      ? "stopped"
      : "failed";
    handle.client.close();
    for (const waiter of handle.turnWaiters.values()) {
      waiter.reject(new Error("Codex app-server exited before the bounded room turn reached a terminal event."));
    }
    handle.turnWaiters.clear();
    handle.terminalTurns.clear();
    handle.roomTurnResults.clearAll();
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.handles.delete(handle.workAttemptId);
    }
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
    return terminal;
  }

  private requireHandle(handle: ProviderHandle): CodexProviderHandle {
    if (!(handle instanceof CodexProviderHandle)) {
      throw new Error("Provider handle does not belong to CodexProviderAdapter.");
    }
    return handle;
  }

  private requireExitPromise(handle: CodexProviderHandle): Promise<ProviderTerminalPayload> {
    const promise = this.exitPromises.get(handle);
    if (!promise) throw new Error("Codex provider handle is missing its exit observation.");
    return promise;
  }
}
