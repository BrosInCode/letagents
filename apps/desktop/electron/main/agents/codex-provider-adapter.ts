import {
  launchCodexAppServer,
  resolveCodexAppServerUrl,
  waitForLaunchedCodexAppServer,
  type CodexAppServerExit,
  type CodexAppServerLaunch,
} from "./codex-app-server.js";
import {
  CodexRpcClient,
  type RpcNotification,
  type ThreadReadResult,
  type TurnStartResult,
} from "./codex-rpc-client.js";
import { buildCodexDevMcpEntryOverrides } from "./codex-dev-mcp-entry.js";
import { writeCodexSupervisorBridgeContext } from "./codex-supervisor-bridge-context.js";
import {
  summarizeCodexRuntimeNotification,
  summarizeCodexRuntimeSnapshot,
} from "./codex-runtime-reasoning.js";
import { isActiveCodexTurnStatus } from "./codex-session-status.js";
import {
  buildCodexStartPrompt,
  DEFAULT_CODEX_STOP_PHRASE,
  looksLikeInviteCode,
  makeCodexStopToken,
} from "./codex-start-prompt.js";
import {
  synthesizeTerminalPayload,
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
}

export interface CodexProviderAdapterOptions {
  codexBin?: string;
  dependencies?: Partial<CodexProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
}

const BASE_CODEX_CAPABILITIES: ProviderAdapterCapabilities = {
  // P0 task_28 did not prove native mid-turn injection or approval bridging.
  // Resume is populated per app-server after a protocol-level probe.
  resume: false,
  midTurnInjection: false,
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

function streamKind(method: string): ProviderStreamEventKind {
  if (/(?:approval|requestApproval|guardian)/i.test(method)) return "approval";
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

  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    readonly providerContinuationId: string,
    readonly providerConnection: ProviderConnectionRef,
    readonly client: CodexAdapterRpc,
    readonly launch: CodexAppServerLaunch,
  ) {}

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
  private readonly pendingAttaches = new Map<string, Promise<CodexProviderHandle | ProviderAttachTerminal | null>>();
  private readonly exitPromises = new WeakMap<CodexProviderHandle, Promise<ProviderTerminalPayload>>();
  // P0 proved app-server thread/resume on the supported Codex runtime. Start
  // optimistic so a fresh reconciler can select resume, then durably downgrade
  // if an exact continuation resume returns method-not-found. Do not probe with
  // a synthetic thread id: some app-server versions treat that as a fatal
  // protocol error, which must never prevent a genuinely fresh thread/start.
  private resumeSupported = true;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.codexBin = options.codexBin || process.env.LETAGENTS_CODEX_BIN || "codex";
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
  }

  capabilities(): ProviderAdapterCapabilities {
    return { ...BASE_CODEX_CAPABILITIES, resume: this.resumeSupported };
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const handle = this.handles.get(ref.workAttemptId);
    if (
      !handle ||
      handle.terminal ||
      handle.providerContinuationId !== ref.providerContinuationId
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
    if (pending) return pending;
    const attaching = this.attachRunning(ref, connection).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId) === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, attaching);
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
    const latestTurn = read.thread?.turns?.at(-1);
    const turnId = latestTurn?.id;
    const rawStatus = typeof latestTurn?.status === "string"
      ? latestTurn.status
      : latestTurn?.status?.status;
    const terminal = /^(?:completed|interrupted|failed|cancelled|stopped)$/i.test(String(rawStatus ?? ""));
    const active = Boolean(turnId && isActiveCodexTurnStatus(rawStatus));
    if (turnId && !active && !terminal) {
      throw new Error("Codex returned an unknown latest-turn state; refusing ambiguous turn control.");
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

    const policy = normalizeLaunchPolicy(req.launchPolicy);
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

      const prompt = buildCodexStartPrompt({
        roomIdentifier: req.roomId,
        joinedVia: looksLikeInviteCode(req.roomId) ? "join_code" : "join_room",
        cwd: req.cwd,
        deliveryMode: "mcp_polling",
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
      const read = await client.request<ThreadReadResult>("thread/read", {
        threadId: ref.providerContinuationId,
        includeTurns: true,
      });
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
      handle.state = "working";
      this.handles.set(ref.workAttemptId, handle);
      this.exitPromises.set(handle, launch.exited.then((exit) => this.observeExit(handle!, exit)));
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification);
      }
      this.publishStream(handle, "thread/read", read, "transcript_snapshot");
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
    this.publishStream(handle, notification.method, notification.params, streamKind(notification.method));
    const lifecycle = /(?:^|\/)(?:failed|systemError)$/i.test(notification.method)
      ? "failed"
      : codexLifecycleStatus(notification.params)
        ?? (/^(?:turn|thread)\/(?:completed|interrupted|stopped)$/i.test(notification.method) ? "idle" : null)
        ?? (/^(?:turn|thread)\/(?:started|resumed)$/i.test(notification.method) ? "working" : null);
    if (lifecycle && (handle.state !== "failed" || lifecycle === "failed")) handle.state = lifecycle;
    const summary = summarizeCodexRuntimeNotification(notification);
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

  private async waitForTurnBoundary(handle: CodexProviderHandle, turnId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
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

  private publishStream(
    handle: CodexProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
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
