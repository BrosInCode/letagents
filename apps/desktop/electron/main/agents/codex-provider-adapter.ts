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
  type ThreadReadResult,
  type ThreadReadTurn,
  type TurnStartResult,
} from "./codex-rpc-client.js";
import { buildCodexDevMcpEntryOverrides } from "./codex-dev-mcp-entry.js";
import { writeCodexSupervisorBridgeContext } from "./codex-supervisor-bridge-context.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import { rentalCredentialIsolationMarker } from "./rental-child-environment.js";
import {
  summarizeCodexRuntimeNotification,
  summarizeCodexRuntimeSnapshot,
} from "./codex-runtime-reasoning.js";
import { isActiveCodexTurnStatus } from "./codex-session-status.js";
import { CodexTurnResultAccumulator } from "./codex-turn-result.js";
import {
  buildCodexStartPrompt,
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
  request<T>(method: string, params?: unknown): Promise<T>;
  close(): void;
  onDisconnect(listener: () => void): () => void;
}

export interface CodexProviderAdapterDependencies {
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
  if (/(?:error|warning|failed)/i.test(method)) return "error";
  if (/(?:usage|tokenUsage|rateLimit)/i.test(method)) return "usage";
  if (/(?:mcpToolCall|toolCall|fileChange|webSearch)/i.test(method)) return "tool_lifecycle";
  if (/(?:command|process|terminal)/i.test(method)) return "command_output";
  if (/(?:delta|transcript)/i.test(method)) return "text_delta";
  if (/^turn\//.test(method)) return "turn_lifecycle";
  if (/^item\//.test(method)) return "item_lifecycle";
  return "provider_event";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

class CodexProviderHandle implements ProviderHandle {
  state: ProviderObservedState = "starting";
  stopRequested = false;
  protocolError = false;
  terminal: ProviderTerminalPayload | null = null;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
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
    readonly client: CodexAdapterRpc,
    readonly launch: CodexAppServerLaunch,
  ) {
    this.providerContinuationId = providerContinuationId;
  }

  replaceContinuation(providerContinuationId: string): void {
    if (this.turnWaiters.size) {
      throw new Error("Codex continuation repair cannot replace a thread while a turn observer is active.");
    }
    this.terminalTurns.clear();
    this.roomTurnResults.clearAll();
    this.providerContinuationId = providerContinuationId;
    this.state = "idle";
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

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const handle = this.handles.get(ref.workAttemptId);
    if (
      !handle ||
      handle.terminal ||
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

  async controlTurn(
    providerHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Codex continuation is terminal; no turn can be controlled.");
    const text = correction?.trim() || null;
    const read = await handle.client.request<ThreadReadResult>("thread/read", {
      threadId: handle.providerContinuationId,
      includeTurns: true,
    });
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
    if (turnId) await options.checkpointTurnStarted?.(turnId);
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
      const dispatchRead = await handle.client.request<ThreadReadResult>("thread/read", {
        threadId: handle.providerContinuationId,
        includeTurns: true,
      });
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
      await this.waitForTurnBoundary(handle, turnId!);
      handle.state = "idle";
    }
    if (text) {
      if (!active) await options.markDispatched?.();
      const turn = await handle.client.request<TurnStartResult>("turn/start", {
        threadId: handle.providerContinuationId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (!turn.turn?.id) throw new Error("Codex did not acknowledge the redirected turn.");
      handle.state = "working";
    }
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
    handle.state = "idle";
    return { outcome: "interrupt_dispatched", targetTurnId: turnId };
  }

  /** Execute one durable inbox item on this exact app-server/thread only. */
  async runRoomTurn(
    providerHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) throw new Error("Codex continuation is terminal; no bounded room turn can run.");
    if (!request.inboxItemId.trim() || !request.actionId.trim()) throw new Error("Bounded Codex room turn requires durable inbox and action ids.");
    await options.beforeNativeDispatch?.();
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
    handle.state = "working";
    const terminal = await this.waitForExactRoomTurnTerminal(handle, turnId, options.detachSignal);
    handle.state = terminal.status === "failed" ? "failed" : "idle";
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
    handle.state = "working";
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
        || handle.providerContinuationId !== expected) {
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

  async stop(
    providerHandle: ProviderHandle,
    options: ProviderStopOptions = {},
  ): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    if (handle.pid === null) {
      throw new Error("Cannot stop a Codex app-server without an observed process id.");
    }

    handle.stopRequested = true;
    handle.state = "stopping";
    const exitPromise = this.requireExitPromise(handle);
    if (options.force) {
      this.deps.signalProcess(handle.pid, "SIGKILL");
      return exitPromise;
    }

    this.deps.signalProcess(handle.pid, "SIGTERM");
    const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    const graceful = await Promise.race([
      exitPromise.then((payload) => ({ payload })),
      delay(graceMs).then(() => null),
    ]);
    if (graceful) return graceful.payload;

    this.deps.signalProcess(handle.pid, "SIGKILL");
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

  private async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<CodexProviderHandle> {
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
    const devOverrides = req.devMcpServerEntryPath
      ? await buildCodexDevMcpEntryOverrides(req.devMcpServerEntryPath)
      : [];
    const serverUrl = await this.deps.resolveServerUrl();
    const launch = this.deps.launchServer(serverUrl, this.codexBin, {
      trustedProjectPath: req.cwd,
      configOverrides: [...codexMcpWorkplaceConfigOverrides(req.cwd), ...devOverrides],
      ...(req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId ? {
        env: {
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
          } : { LETAGENTS_EXECUTION_PROFILE: "interactive_desktop" }),
        },
      } : {}),
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
        client,
        observedLaunch,
      );
      this.handles.set(req.workAttemptId, handle);
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

      // Daemon-inbox Codex starts only an idle app-server/thread.  The daemon
      // begins the first native turn after its durable inbox claim exists.
      if (req.deliveryMode === "daemon_inbox") {
        handle.state = "idle";
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
      handle.state = "working";
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
        client,
        launch,
      );
      handle.state = continuationMissing ? "idle" : "working";
      this.handles.set(ref.workAttemptId, handle);
      this.exitPromises.set(handle, launch.exited.then((exit) => this.observeExit(handle!, exit)));
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification);
      }
      if (!continuationMissing) {
        this.publishStream(handle, "thread/read", read, "transcript_snapshot");
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

  private consumeNotification(
    handle: CodexProviderHandle,
    notification: RpcNotification,
  ): void {
    handle.roomTurnResults.observe(notification.method, notification.params);
    const exactTurnId = notificationTurnId(notification.params);
    const exactThreadId = notificationThreadId(notification.params);
    const terminalMatch = /^turn\/(completed|interrupted|failed|cancelled|stopped)$/i.exec(notification.method);
    // Record the durable in-memory terminal edge first. Stream/activity
    // observers are best-effort and must never suppress exact turn settlement.
    if (exactTurnId && exactThreadId === handle.providerContinuationId && terminalMatch) {
      this.noteExactTurnTerminal(handle, exactTurnKey(exactThreadId, exactTurnId), terminalMatch[1]!.toLowerCase());
    }
    // Build the readable summary once and attach the same value to both the
    // ordered stream and the compact activity event. In particular, Codex's
    // approved summaryTextDelta stream is accumulated here; raw reasoning
    // textDelta content remains hidden by summarizeCodexRuntimeNotification.
    const summary = summarizeCodexRuntimeNotification(notification);
    this.publishStream(handle, notification.method, notification.params, streamKind(notification.method), summary.summary);
    // Execution status belongs to the item, never to the reusable app-server.
    // Exact turn settlement above remains independent of this runtime state.
    const lifecycle = isCodexExecutionMethod(notification.method) ? null
      : /(?:^|\/)(?:failed|systemError)$/i.test(notification.method)
      ? "failed"
      : codexLifecycleStatus(notification.params)
        ?? (/^(?:turn|thread)\/(?:completed|interrupted|stopped)$/i.test(notification.method) ? "idle" : null)
        ?? (/^(?:turn|thread)\/(?:started|resumed)$/i.test(notification.method) ? "working" : null);
    if (lifecycle && (handle.state !== "failed" || lifecycle === "failed")) handle.state = lifecycle;
    this.publishActivity(handle, {
      source: "native_harness",
      method: notification.method,
      ...summary,
    });
    if (/^(turn\/completed|item\/completed)$/.test(notification.method)) {
      void this.emitTranscriptTail(handle);
    }
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
        latestTurn,
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
