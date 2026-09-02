import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LETAGENTS_NPX_ARGS } from "../mcp-config.js";
import {
  ProviderContinuationMissingError,
  sameProviderConnectionIdentity,
  synthesizeTerminalPayload,
  type ProviderActivityEvent,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderAttachTerminal,
  type ProviderConnectionRef,
  type ProviderContinuationRef,
  type ProviderContinuationRepairRequest,
  type ProviderContinuationRepairResult,
  type ProviderHandle,
  type ProviderObservedState,
  type ProviderRoomTurnOptions,
  type ProviderRoomTurnRecoveryRequest,
  type ProviderRoomTurnRequest,
  type ProviderRoomTurnResult,
  type ProviderSpawnRequest,
  type ProviderStopOptions,
  type ProviderStreamEvent,
  type ProviderTerminalPayload,
  ProviderTurnControlError,
  type ProviderTurnControlOptions,
  type ProviderTurnControlResult,
} from "./provider-adapter.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import {
  DEFAULT_STOP_GRACE_MS,
  defaultGetProcessIdentity,
  defaultObserveProcessExit,
  defaultSignalProcess,
  delay,
  safeStreamPayload,
  sameProcessBirthIdentity,
  terminateFreshLaunch,
  type ProviderProcessExit,
} from "./provider-evidence.js";
import {
  credentialBoundaryPluginSource,
  minimalOpenCodeEnvironment,
  OPEN_MODEL_OPENCODE_PROVIDER_ID,
  OPENCODE_SERVER_USERNAME,
  openCodeAuthContent,
  openCodeConfig,
  parseConfiguredOpenModel,
  supervisedOpenCodeMcpEnvironment,
} from "./opencode-launch-contract.js";
import { resolveOpenCodeBinary } from "./opencode-runtime.js";
import { nativeExecutionId, nativeLifecycleCheckpoint, ProviderExecutionObserver } from "./provider-execution-observer.js";
import type { ControlProbeResult, HardControlEvidence, NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription, TurnOutcome } from "../../../shared/execution-protocol.js";
import {
  assistantsFor,
  eventReferencesSession,
  finalAssistantFor,
  messageCompleted,
  messageError,
  messageFinishReason,
  messageText,
  mintNativeUserMessageId,
  nativelyOrderedMessageId,
  OpenCodePermissionReplyError,
  OpenCodeServerClient,
  parseOpenCodePermissionEvent,
  record,
  type JsonRecord,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodePart,
  type OpenCodePermissionRequest,
  type OpenCodePermissionTurnCorrelation,
  type OpenCodeRuntimeAuth,
} from "./opencode-server-client.js";

const START_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 30 * 60_000;
const TURN_CONTROL_TIMEOUT_MS = 5_000;
const MAX_ASSISTANT_STEPS = 32;
const NO_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";
// A session that ever received a user message outside OpenCode's ascending ID
// scheme can never satisfy the native loop-exit predicate again; the whole
// transcript must be scanned once before this process dispatches into it.
const SESSION_ORDERING_SCAN_LIMIT = 4_096;

export interface OpenModelProviderAdapterDependencies {
  launch(input: {
    binary: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): { child: ChildProcess; exited: Promise<ProviderProcessExit> };
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  allocatePort(): Promise<number>;
  discoverRuntimeConnection(runtimeRoot: string): Promise<{ pid: number; url: string } | null>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): string;
}

export interface OpenModelProviderAdapterOptions {
  binary?: string;
  runtimeRoot?: string;
  dependencies?: Partial<OpenModelProviderAdapterDependencies>;
  startTimeoutMs?: number;
  turnTimeoutMs?: number;
  turnControlTimeoutMs?: number;
  maxAssistantSteps?: number;
  stopGraceMs?: number;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  deliveryModes: ["daemon_inbox"],
  resume: true,
  midTurnInjection: false,
  // Open Model cannot resume an interrupted turn; corrections are delivered via
  // stop-then-resend on the same OpenCode session.
  midTurnCorrection: false,
  transcriptAccess: true,
  permissionPromptBridging: false,
  survivesRestart: true,
  turnControl: "native_interrupt",
  continuationRepair: "same_process",
  execution: {
    controlProbe: "http",
    approvals: { kinds: ["command", "file_change"], recovery: "native_instance_only", denyScope: "session" },
  },
};

/** Native request data is host-ephemeral; it is never an execution fact or room projection. */
export type OpenCodePermissionObservation =
  | { type: "snapshot"; requests: OpenCodePermissionRequest[] }
  | { type: "degraded" }
  | { type: "unavailable"; reason: HardControlEvidence | "handle_replaced" };

function boundedRoomTurnPrompt(request: ProviderRoomTurnRequest): string {
  return [
    "You are handling one daemon-owned room inbox item in an exact bounded turn.",
    "The daemon owns observation, credentials, retries, and publication. Do not register a session, authenticate, poll, or manage runtime lifecycle.",
    "You may use the discovered LetAgents product tools for bounded room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    `If no response should be published, return exactly ${NO_REPLY_SENTINEL} with no other text.`,
    `Inbox item: ${request.inboxItemId}`,
    `Recent bounded room context: ${JSON.stringify(request.observedContext ?? [])}`,
    `Source message: ${JSON.stringify(request.sourceMessage)}`,
    `Activation: ${JSON.stringify(request.activation)}`,
  ].join("\n");
}

function classifyTurn(turnId: string, text: string | null): ProviderRoomTurnResult {
  const normalized = text?.trim() || null;
  if (!normalized) return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  if (normalized === NO_REPLY_SENTINEL) {
    return { turnId, outcome: "no_reply", text: null, evidence: "transcript" };
  }
  return { turnId, outcome: "reply", text: normalized, evidence: "transcript" };
}

function safeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

type OpenCodeRuntimeControl = OpenCodeRuntimeAuth & {
  lifecycleAuthorityMode?: "legacy" | "typed_shadow" | "typed";
  connection?: {
    url: string;
    pid: number;
    processIdentity: string;
  };
};

function defaultLaunch(input: {
  binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
}): { child: ChildProcess; exited: Promise<ProviderProcessExit> } {
  const child = spawn(input.binary, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise<ProviderProcessExit>((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    child.once("exit", (code, signal) => resolve({ type: "exit", code, signal }));
  });
  child.unref();
  return { child, exited };
}

async function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function defaultDiscoverRuntimeConnection(
  runtimeRoot: string,
): Promise<{ pid: number; url: string } | null> {
  let owners: string;
  try {
    owners = await execFileText(
      "/usr/sbin/lsof",
      ["-t", "--", join(runtimeRoot, "data", "opencode", "opencode.db")],
    );
  } catch {
    return null;
  }
  const pids = [...new Set(owners.split(/\s+/)
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const candidates: Array<{ pid: number; url: string }> = [];
  for (const pid of pids) {
    let command: string;
    try {
      command = (await execFileText("/bin/ps", ["-p", String(pid), "-o", "command="])).trim();
    } catch {
      continue;
    }
    if (!/(?:^|\s)serve(?:\s|$)/.test(command)
      || !/(?:^|\s)--hostname(?:=|\s+)127\.0\.0\.1(?:\s|$)/.test(command)) continue;
    const port = Number(command.match(/(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/)?.[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) continue;
    candidates.push({ pid, url: `http://127.0.0.1:${port}` });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

async function nextEventBefore(
  events: AsyncIterator<OpenCodeEvent>,
  deadline: number,
): Promise<IteratorResult<OpenCodeEvent>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new OpenCodeBoundedTurnError("OpenCode bounded turn timed out.");
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      events.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new OpenCodeBoundedTurnError("OpenCode bounded turn timed out.")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Bound a single in-flight operation to a wall-clock deadline. A hung server
 * response must never stretch a turn-control budget past its ceiling, so the
 * losing operation is abandoned (its late rejection is swallowed to avoid an
 * unhandled rejection).
 */
async function resolveBeforeDeadline<T>(operation: Promise<T>, deadline: number, message: string): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) { void operation.catch(() => undefined); throw new Error(message); }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    void operation.catch(() => undefined);
  }
}

class OpenCodeBoundedTurnError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

/**
 * The fresh OpenCode server did not answer health checks inside the launch
 * budget. The launch was terminated, nothing durable changed, and another
 * attempt is expected to succeed — the daemon may retry automatically.
 */
export class OpenCodeStartTimeoutError extends Error {
  readonly transientProviderStart = true;

  constructor() {
    super("Timed out waiting for the supervised OpenCode server.");
    this.name = "OpenCodeStartTimeoutError";
  }
}

/**
 * The saved OpenCode process is provably gone — attach returned terminal
 * identity, so resume can never reattach it. This continuation cannot be
 * recovered; the daemon must start a fresh runtime generation rather than
 * retry resume against a corpse. Distinct from an unverifiable process (see
 * resume() below), which may still be alive and is worth a bounded retry.
 */
export class OpenCodeRuntimeGoneError extends Error {
  readonly providerRuntimeGone = true;

  constructor() {
    super("The saved OpenCode process is no longer running.");
    this.name = "OpenCodeRuntimeGoneError";
  }
}

class OpenCodeTerminalTurnError extends Error {
  // A provider-declared terminal error is authoritative evidence that this
  // exact turn produced no publishable answer. Block it without rerunning the
  // model; a human can correct the provider account/model and send new work.
  readonly roomTurnRecoveryOutcome = "terminal_failure" as const;
}

function safeProviderErrorMessage(message: OpenCodeMessage | null): string | null {
  const failure = messageError(message);
  if (!failure) return null;
  const status = failure.statusCode ? ` (HTTP ${failure.statusCode})` : "";
  if (failure.statusCode === 402) {
    return `Open Model request was rejected because the model provider account could not cover this turn's output budget${status}. Add provider credit or choose another model, then send a new message.`;
  }
  if (failure.statusCode === 401 || failure.statusCode === 403) {
    return `Open Model authentication or model access was rejected by the provider${status}. Check the API key and model access, then send a new message.`;
  }
  if (failure.statusCode === 429) {
    return `Open Model was rate-limited by the model provider${status}. Wait for the provider limit to reset, then send a new message.`;
  }
  const detail = failure.message
    ?.replace(/https?:\/\/\S+/gi, "provider settings")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  return `Open Model request failed at the model provider${status}${detail ? `: ${detail}` : "."}`;
}

const defaultDependencies: OpenModelProviderAdapterDependencies = {
  launch: defaultLaunch,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  signalProcess: defaultSignalProcess,
  allocatePort: defaultAllocatePort,
  discoverRuntimeConnection: defaultDiscoverRuntimeConnection,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date().toISOString(),
};

class OpenModelHandle implements ProviderHandle {
  private observed: ProviderObservedState;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  sequence = 0;
  terminal: ProviderTerminalPayload | null = null;
  activeRoomTurnId: string | null = null;
  /** True once every user message in the session is known to use OpenCode's ascending ID scheme. */
  nativeOrderingVerified = false;
  readonly execution: ProviderExecutionObserver;
  controlLoss: HardControlEvidence | null = null;
  observedTurn: { id: string; terminal: TurnOutcome | "lost" | null } | null = null;

  constructor(
    readonly workAttemptId: string,
    readonly pid: number,
    readonly providerContinuationId: string,
    readonly lifecycleAuthorityMode: "legacy" | "typed_shadow" | "typed",
    readonly providerConnection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>,
    readonly client: OpenCodeServerClient,
    readonly configuredModel: string,
    initialState: ProviderObservedState,
    now: () => string,
  ) {
    this.observed = initialState;
    this.execution = new ProviderExecutionObserver(now);
  }

  observedState(): ProviderObservedState { return this.observed; }
  setState(value: ProviderObservedState): void { this.observed = value; }
}

export class OpenModelProviderAdapter implements ProviderAdapter {
  readonly id = "open-model" as const;
  private readonly binary: string;
  private readonly deps: OpenModelProviderAdapterDependencies;
  private readonly startTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly turnControlTimeoutMs: number;
  private readonly maxAssistantSteps: number;
  private readonly stopGraceMs: number;
  private readonly runtimeRoot: string;
  private readonly handles = new Map<string, OpenModelHandle>();

  constructor(options: OpenModelProviderAdapterOptions = {}) {
    this.binary = options.binary
      || resolveOpenCodeBinary();
    this.deps = { ...defaultDependencies, ...options.dependencies };
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.turnControlTimeoutMs = options.turnControlTimeoutMs ?? TURN_CONTROL_TIMEOUT_MS;
    this.maxAssistantSteps = options.maxAssistantSteps ?? MAX_ASSISTANT_STEPS;
    if (!Number.isSafeInteger(this.maxAssistantSteps) || this.maxAssistantSteps < 1) {
      throw new Error("Open Model maxAssistantSteps must be a positive integer.");
    }
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.runtimeRoot = options.runtimeRoot
      ?? join(homedir(), ".letagents", "opencode-runtime");
  }

  capabilities(): ProviderAdapterCapabilities { return { ...CAPABILITIES }; }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    if (lifecycleAuthorityMode === "typed" && req.deliveryMode !== "daemon_inbox") {
      throw new Error("Typed Open Model lifecycle authority requires daemon-inbox delivery.");
    }
    if (req.deliveryMode !== "daemon_inbox") {
      throw new Error("Open Model supports daemon-owned bounded room delivery only.");
    }
    if (!req.providerCredential?.baseUrl.trim() || !req.providerCredential.model.trim()) {
      throw new Error("Open Model is waiting for its desktop-held endpoint credential.");
    }
    const credential = req.providerCredential;
    const appliedConfigurationRevision = attestProviderSpawnPolicy("open-model", req);
    void appliedConfigurationRevision;
    const runtimeRoot = join(this.runtimeRoot, safeRuntimeId(req.workAttemptId));
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(runtimeRoot, 0o700);
    const authPath = join(runtimeRoot, "server-auth.json");
    const auth: OpenCodeRuntimeAuth = {
      username: OPENCODE_SERVER_USERNAME,
      password: randomBytes(32).toString("base64url"),
    };
    await writeRuntimeControl(authPath, { ...auth, lifecycleAuthorityMode });
    const pluginPath = join(runtimeRoot, "credential-boundary.mjs");
    await writeFile(pluginPath, credentialBoundaryPluginSource(), {
      encoding: "utf8",
      mode: 0o600,
    });
    const mcpCommand = req.devMcpServerEntryPath
      ? [process.execPath, req.devMcpServerEntryPath]
      : ["npx", ...LETAGENTS_NPX_ARGS];
    const mcpEnvironment = supervisedOpenCodeMcpEnvironment(
      req,
      process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
    );
    const config = openCodeConfig({
      model: credential.model,
      baseUrl: credential.baseUrl,
      pluginUrl: pathToFileURL(pluginPath).href,
      cwd: req.cwd,
      mcpCommand,
      mcpEnvironment,
    });
    const port = await this.deps.allocatePort();
    const url = `http://127.0.0.1:${port}`;
    // Sessions, config, and auth stay isolated per runtime; the cache does
    // not. OpenCode installs the provider npm package (~61MB of node_modules)
    // on first start, and a cold per-agent cache re-downloads it on every
    // launch — minutes on a slow network, spent inside the startup window
    // where health connections can be accepted but never answered.
    const sharedCacheRoot = join(this.runtimeRoot, "shared-cache");
    await mkdir(sharedCacheRoot, { recursive: true, mode: 0o700 });
    const env = minimalOpenCodeEnvironment(process.env, {
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: openCodeAuthContent(credential.apiKey),
      XDG_DATA_HOME: join(runtimeRoot, "data"),
      XDG_CACHE_HOME: sharedCacheRoot,
      XDG_CONFIG_HOME: join(runtimeRoot, "config"),
      XDG_STATE_HOME: join(runtimeRoot, "state"),
      BUN_INSTALL_CACHE_DIR: join(sharedCacheRoot, "bun-install"),
    });
    const launch = this.deps.launch({
      binary: this.binary,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: req.cwd,
      env,
    });
    if (launch.child.pid === undefined || launch.child.pid === null) {
      await launch.exited;
      throw new Error("OpenCode launch did not expose a process id.");
    }
    const pid = launch.child.pid;
    const identity = this.deps.getProcessIdentity(pid);
    if (!identity) {
      await terminateFreshLaunch({ pid, exited: launch.exited }, this.deps, this.stopGraceMs);
      throw new Error("OpenCode process identity could not be verified.");
    }
    const client = new OpenCodeServerClient(url, auth, this.deps.fetch);
    const ready = await this.waitForHealth(client, launch.exited);
    if (!ready) {
      await terminateFreshLaunch({ pid, exited: launch.exited }, this.deps, this.stopGraceMs);
      throw new OpenCodeStartTimeoutError();
    }
    const session = await client.createSession(
      req.agentDisplayName?.trim() || "LetAgents Open Model",
    );
    const sessionId = typeof session.id === "string" ? session.id : "";
    if (!sessionId) {
      await terminateFreshLaunch({ pid, exited: launch.exited }, this.deps, this.stopGraceMs);
      throw new Error("OpenCode did not return a session id.");
    }
    const connection: Extract<ProviderConnectionRef, { kind: "opencode_server" }> = {
      kind: "opencode_server",
      url,
      pid,
      processIdentity: identity,
      serverAuthPath: authPath,
    };
    await writeRuntimeControl(authPath, {
      ...auth,
      lifecycleAuthorityMode,
      connection: { url, pid, processIdentity: identity },
    });
    const handle = new OpenModelHandle(
      req.workAttemptId,
      pid,
      sessionId,
      lifecycleAuthorityMode,
      connection,
      client,
      credential.model,
      "idle",
      this.deps.now,
    );
    handle.nativeOrderingVerified = true;
    this.handles.set(req.workAttemptId, handle);
    this.observeTerminal(handle, launch.exited);
    this.emitRuntimeReady(handle);
    return handle;
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const lifecycleAuthorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    const resolved = await this.resolveAttachConnection(ref);
    if (!resolved) return null;
    const { connection, control, recoveredLegacyConnection } = resolved;
    if ((control.lifecycleAuthorityMode ?? "typed_shadow") !== lifecycleAuthorityMode) return null;
    const cached = this.handles.get(ref.workAttemptId);
    if (cached) {
      return cached.providerContinuationId === ref.providerContinuationId
        && cached.lifecycleAuthorityMode === lifecycleAuthorityMode
        && cached.providerConnection.url === connection.url
        && cached.providerConnection.processIdentity === connection.processIdentity
        ? cached
        : null;
    }
    const identity = this.deps.getProcessIdentity(connection.pid);
    if (identity === null || (typeof identity === "string" && !sameProcessBirthIdentity(identity, connection.processIdentity))) {
      return {
        state: "terminal",
        terminal: synthesizeTerminalPayload({
          exitCode: null, signal: null, providerContinuationId: ref.providerContinuationId,
          endedAt: this.deps.now(),
        }),
      } satisfies ProviderAttachTerminal;
    }
    if (identity === undefined) return null;
    const auth: OpenCodeRuntimeAuth = {
      username: control.username,
      password: control.password,
    };
    const client = new OpenCodeServerClient(connection.url, auth, this.deps.fetch);
    if (!await client.health()) return null;
    const sessions = await client.listSessions();
    if (!sessions.some((session) => session.id === ref.providerContinuationId)) {
      throw new ProviderContinuationMissingError(ref.providerContinuationId);
    }
    const configuredModel = parseConfiguredOpenModel(await client.config());
    if (!configuredModel) throw new Error("The attached OpenCode runtime has no configured Open Model.");
    const handle = new OpenModelHandle(
      ref.workAttemptId,
      connection.pid,
      ref.providerContinuationId,
      lifecycleAuthorityMode,
      connection,
      client,
      configuredModel,
      "idle",
      this.deps.now,
    );
    this.handles.set(ref.workAttemptId, handle);
    this.observeTerminal(handle, this.deps.observeProcessExit(connection.pid, connection.processIdentity));
    if (recoveredLegacyConnection) {
      await writeRuntimeControl(connection.serverAuthPath, {
        ...auth,
        lifecycleAuthorityMode,
        connection: {
          url: connection.url,
          pid: connection.pid,
          processIdentity: connection.processIdentity,
        },
      });
    }
    this.emitRuntimeReady(handle);
    return handle;
  }

  private async resolveAttachConnection(ref: ProviderContinuationRef): Promise<{
    connection: Extract<ProviderConnectionRef, { kind: "opencode_server" }> & {
      pid: number;
      processIdentity: string;
    };
    control: OpenCodeRuntimeControl;
    recoveredLegacyConnection: boolean;
  } | null> {
    const persisted = ref.providerConnection;
    const defaultAuthPath = join(
      this.runtimeRoot,
      safeRuntimeId(ref.workAttemptId),
      "server-auth.json",
    );
    const authPath = persisted?.kind === "opencode_server"
      ? persisted.serverAuthPath
      : defaultAuthPath;
    let control: OpenCodeRuntimeControl;
    try {
      control = await readRuntimeControl(authPath);
    } catch {
      return null;
    }
    if (persisted?.kind === "opencode_server") {
      if (persisted.pid === null || !persisted.processIdentity) return null;
      return {
        connection: {
          ...persisted,
          pid: persisted.pid,
          processIdentity: persisted.processIdentity,
        },
        control,
        recoveredLegacyConnection: false,
      };
    }
    const recorded = control.connection;
    const discovered = recorded ?? await this.deps.discoverRuntimeConnection(
      join(this.runtimeRoot, safeRuntimeId(ref.workAttemptId)),
    );
    if (!discovered) return null;
    const processIdentity = recorded
      ? recorded.processIdentity
      : this.deps.getProcessIdentity(discovered.pid);
    if (!processIdentity) return null;
    return {
      connection: {
        kind: "opencode_server",
        url: discovered.url,
        pid: discovered.pid,
        processIdentity,
        serverAuthPath: authPath,
      },
      control,
      recoveredLegacyConnection: !recorded,
    };
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    if ((ref.lifecycleAuthorityMode ?? "typed_shadow") !== (req.lifecycleAuthorityMode ?? "typed_shadow")) {
      throw new Error("Open Model resume lifecycle authority does not match the frozen provider birth.");
    }
    // Load-bearing two-writer invariant: attach() may return null when process
    // identity or local control authentication is unreadable. resume() must
    // never interpret that uncertainty as permission to spawn a replacement.
    // Only a terminal identity proves that the saved writer is gone.
    const attached = await this.attach(ref);
    if (attached && !("state" in attached)) return attached;
    // Terminal identity is proof the process is gone: the daemon must recover
    // by starting a fresh runtime, not retry resume against a corpse.
    if (attached?.state === "terminal") throw new OpenCodeRuntimeGoneError();
    throw new Error("The saved OpenCode process could not be authenticated; refusing to start a competing runtime.");
  }

  async poke(): Promise<void> {
    throw new Error("Open Model does not support mid-turn message injection.");
  }

  async runRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRequest,
    options: ProviderRoomTurnOptions = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    await this.assertNativelyOrderedSession(handle);
    // The turn id becomes the OpenCode user message ID, so it must be minted
    // in OpenCode's own ascending scheme; any other shape convinces its loop
    // that an unanswered user message always remains and the model is
    // re-invoked until the bounded-turn abort fires.
    const turnId = mintNativeUserMessageId(Date.now());
    await (options.beforeNativeDispatch ?? options.markDispatched)?.();
    handle.setState("working");
    await handle.client.promptAsync(handle.providerContinuationId, {
      messageID: turnId,
      model: {
        providerID: OPEN_MODEL_OPENCODE_PROVIDER_ID,
        modelID: handle.configuredModel,
      },
      parts: [{ type: "text", text: boundedRoomTurnPrompt(request) }],
    }).catch((error) => {
      handle.setState("idle");
      throw error;
    });
    handle.activeRoomTurnId = turnId;
    handle.observedTurn = { id: turnId, terminal: null };
    this.emitTurnActive(handle, turnId);
    await options.checkpointTurnStarted?.(turnId);
    try {
      const result = await this.awaitExactTurn(handle, turnId, options.detachSignal);
      await options.checkpointTerminalResult?.(result);
      handle.setState("idle");
      handle.activeRoomTurnId = null;
      return result;
    } catch (error) {
      if (error instanceof OpenCodeBoundedTurnError) {
        await this.abortBoundedTurn(handle, turnId, error);
      } else if (handle.activeRoomTurnId === turnId) {
        // A non-bounded failure (network, read, or checkpoint error) must not
        // leave the handle projecting "working" with a stale active turn id.
        handle.activeRoomTurnId = null;
        handle.setState("idle");
      }
      throw error;
    }
  }

  async recoverRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointTerminalResult"> = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    handle.activeRoomTurnId = request.providerTurnId;
    if (handle.observedTurn?.id !== request.providerTurnId) handle.observedTurn = { id: request.providerTurnId, terminal: null };
    this.emitTurnActive(handle, request.providerTurnId);
    try {
      const result = await this.awaitExactTurn(handle, request.providerTurnId, options.detachSignal, true);
      await options.checkpointTerminalResult?.(result);
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return result;
    } catch (error) {
      if (error instanceof OpenCodeBoundedTurnError) {
        await this.abortBoundedTurn(handle, request.providerTurnId, error);
      } else if (handle.activeRoomTurnId === request.providerTurnId) {
        // Mirror runRoomTurn: a non-bounded failure must not leave a leaked
        // "working" projection with a stale active turn id.
        handle.activeRoomTurnId = null;
        handle.setState("idle");
      }
      throw error;
    }
  }

  async inspectTurn(rawHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.required(rawHandle);
    const status = await handle.client.status(handle.providerContinuationId);
    if (status === "busy") return "active";
    const messages = await handle.client.messages(handle.providerContinuationId);
    const assistants = assistantsFor(messages, turnId);
    return assistants.some(messageCompleted) ? "terminal" : assistants.length > 0 ? "active" : "unknown";
  }

  async controlTurn(
    rawHandle: ProviderHandle,
    correction?: string | null,
    options: ProviderTurnControlOptions = {},
  ): Promise<ProviderTurnControlResult> {
    const handle = this.required(rawHandle);
    if (correction?.trim()) {
      throw new ProviderTurnControlError(
        "Open Model can stop the active bounded turn, but cannot start an unjournaled correction turn.",
        "not_applied",
      );
    }
    const expectedTurnId = options.targetTurnId?.trim() || null;
    if (await handle.client.status(handle.providerContinuationId) !== "busy") {
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" };
    }
    const activeTurnId = handle.activeRoomTurnId;
    if (expectedTurnId && activeTurnId !== expectedTurnId) {
      // A completed or superseded exact turn is a no-op. Never let retry of A
      // inherit abort authority over the session's newer active B.
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" };
    }
    if (!activeTurnId) {
      throw new ProviderTurnControlError(
        "OpenCode has no exact active-turn identity; refusing session-wide abort authority.",
        "uncertain",
      );
    }
    if (activeTurnId) await options.checkpointTurnStarted?.(activeTurnId);
    await options.markDispatched?.();
    if (await handle.client.status(handle.providerContinuationId) !== "busy"
      || (activeTurnId !== null && handle.activeRoomTurnId !== activeTurnId)) {
      throw new ProviderTurnControlError(
        "OpenCode reached a terminal turn boundary before native abort dispatch.",
        "not_applied",
      );
    }
    await handle.client.abort(handle.providerContinuationId);
    await this.waitForSessionIdle(handle, this.turnControlTimeoutMs).catch((error) => {
      throw new ProviderTurnControlError(
        `OpenCode accepted the abort, but its turn boundary could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        "uncertain",
      );
    });
    if (activeTurnId === null || handle.activeRoomTurnId === activeTurnId) {
      handle.activeRoomTurnId = null;
    }
    handle.setState("idle");
    this.emitTurnTerminal(handle, activeTurnId, "interrupted");
    return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
  }

  async repairContinuation(
    rawHandle: ProviderHandle,
    request: ProviderContinuationRepairRequest,
    options: { checkpointReplacement: (providerContinuationId: string) => Promise<void> },
  ): Promise<ProviderContinuationRepairResult> {
    const handle = this.required(rawHandle);
    // A session poisoned by out-of-scheme user message IDs still exists but can
    // never complete another native turn, so it is not rematerializable; only a
    // fresh session restores the loop-exit invariant.
    if (request.checkpointedReplacementProviderContinuationId) {
      const sessions = await handle.client.listSessions();
      if (sessions.some((session) => session.id === request.checkpointedReplacementProviderContinuationId)
        && await this.sessionNativelyOrdered(handle.client, request.checkpointedReplacementProviderContinuationId)) {
        const replacement = this.withContinuation(handle, request.checkpointedReplacementProviderContinuationId);
        replacement.nativeOrderingVerified = true;
        return {
          handle: replacement,
          outcome: "replaced",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: replacement.providerContinuationId,
        };
      }
    }
    if (!request.forceReplacement) {
      const sessions = await handle.client.listSessions();
      if (sessions.some((session) => session.id === request.expectedProviderContinuationId)
        && await this.sessionNativelyOrdered(handle.client, request.expectedProviderContinuationId)) {
        handle.nativeOrderingVerified = true;
        return {
          handle,
          outcome: "rematerialized",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: request.expectedProviderContinuationId,
        };
      }
    }
    const created = await handle.client.createSession("LetAgents restored conversation");
    const replacementId = typeof created.id === "string" ? created.id : "";
    if (!replacementId) throw new Error("OpenCode continuation repair did not return a session id.");
    await options.checkpointReplacement(replacementId);
    const replacement = this.withContinuation(handle, replacementId);
    replacement.nativeOrderingVerified = true;
    return {
      handle: replacement,
      outcome: "replaced",
      previousProviderContinuationId: request.expectedProviderContinuationId,
      replacementProviderContinuationId: replacementId,
    };
  }

  async stop(rawHandle: ProviderHandle, options: ProviderStopOptions = {}): Promise<ProviderTerminalPayload> {
    const handle = this.required(rawHandle);
    if (handle.terminal) return handle.terminal;
    handle.setState("stopping");
    const identity = this.deps.getProcessIdentity(handle.pid);
    if (identity && sameProcessBirthIdentity(identity, handle.providerConnection.processIdentity!)) {
      this.deps.signalProcess(handle.pid, options.force ? "SIGKILL" : "SIGTERM");
      if (!options.force) {
        await delay(options.graceMs ?? this.stopGraceMs);
        const next = this.deps.getProcessIdentity(handle.pid);
        if (next && sameProcessBirthIdentity(next, handle.providerConnection.processIdentity!)) {
          this.deps.signalProcess(handle.pid, "SIGKILL");
        }
      }
    }
    const exit = await this.deps.observeProcessExit(handle.pid, handle.providerConnection.processIdentity!);
    const terminal = terminalFromExit(exit, handle.providerContinuationId, this.deps.now(), true);
    this.finish(handle, terminal, exit.type === "exit");
    return terminal;
  }

  onExit(rawHandle: ProviderHandle, listener: (payload: ProviderTerminalPayload) => void): () => void {
    const handle = this.required(rawHandle);
    if (handle.terminal) queueMicrotask(() => listener(handle.terminal!));
    else handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(rawHandle: ProviderHandle, listener: (event: ProviderActivityEvent) => void): () => void {
    const handle = this.required(rawHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(rawHandle: ProviderHandle, listener: (event: ProviderStreamEvent) => void): () => void {
    const handle = this.required(rawHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }

  onExecution(rawHandle: ProviderHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription {
    return this.required(rawHandle).execution.subscribe(listener);
  }

  async probeControl(rawHandle: ProviderHandle): Promise<ControlProbeResult> {
    const handle = this.required(rawHandle);
    let result = this.controlProof(handle);
    if (!result) {
      const response = await handle.client.probeControl();
      // A refused HTTP request alone is not proof that the native instance died.
      result = this.controlProof(handle) ?? { state: response.state };
    }
    if (result.state === "lost") handle.controlLoss = result.controlEvidence;
    this.emitExecution(handle, { domain: "control", kind: "state_changed", sideEffects: "none", ...result });
    return result;
  }

  /** Read-only native linkage; pending-request and durable admission checks remain separate. */
  async correlatePermissionTurn(
    rawHandle: ProviderHandle,
    expectedRequest: OpenCodePermissionRequest,
  ): Promise<OpenCodePermissionTurnCorrelation> {
    try {
      const handle = this.required(rawHandle);
      const sessionId = handle.providerContinuationId;
      const connection = { ...handle.providerConnection };
      const assertCurrentInstance = (): void => {
        if (this.required(rawHandle) !== handle || handle.terminal || handle.observedState() === "stopping"
          || handle.providerContinuationId !== sessionId || handle.pid !== connection.pid
          || !sameProviderConnectionIdentity(connection, handle.providerConnection) || this.controlProof(handle)) {
          throw new Error("OpenCode permission correlation instance could not be verified.");
        }
      };
      const result = await handle.client.correlatePermissionTurn(sessionId, expectedRequest, assertCurrentInstance);
      assertCurrentInstance();
      return result;
    } catch {
      return { outcome: "correlation_unproven" };
    }
  }

  /** Host-only native decision boundary; durable decision/retry policy belongs to the caller. */
  async replyPermission(
    rawHandle: ProviderHandle,
    expectedRequest: OpenCodePermissionRequest,
    reply: "once" | "reject",
    options?: { beforeNativeDispatch: () => Promise<void>; assertNativeDispatch?: () => void },
  ) {
    const currentHandle = (): OpenModelHandle => {
      const current = this.handles.get(rawHandle.workAttemptId);
      if (!current || current !== rawHandle || current.terminal
        || current.observedState() === "stopping" || this.controlProof(current)) {
        throw new OpenCodePermissionReplyError("not_dispatched");
      }
      return current;
    };
    const handle = currentHandle();
    let dispatched = false;
    try {
      return await handle.client.replyPermission(handle.providerContinuationId, expectedRequest, reply, () => {
        currentHandle();
        options?.assertNativeDispatch?.();
        dispatched = true;
      }, options?.beforeNativeDispatch);
    } finally {
      if (dispatched) {
        // A replacement may answer even with 404. Neither that response nor
        // loss of the original instance proves that the decision did not land.
        try { currentHandle(); } catch { throw new OpenCodePermissionReplyError("uncertain"); }
      }
    }
  }

  async observePermissions(
    rawHandle: ProviderHandle,
    listener: (event: OpenCodePermissionObservation) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const handle = this.required(rawHandle);
    const notify = (event: OpenCodePermissionObservation): void => {
      if (!signal.aborted) { try { listener(event); } catch { /* Observation never controls native work. */ } }
    };
    const available = (): boolean => {
      if (this.handles.get(handle.workAttemptId) !== handle) {
        notify({ type: "unavailable", reason: "handle_replaced" });
        return false;
      }
      const proof = this.controlProof(handle);
      if (!proof) return true;
      if (proof.state === "lost") {
        handle.controlLoss = proof.controlEvidence;
        notify({ type: "unavailable", reason: proof.controlEvidence });
      } else notify({ type: "degraded" });
      return false;
    };
    while (!signal.aborted && available()) {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      let revision = 0;
      let pending = false;
      let listing = false;
      const refresh = (): void => {
        revision += 1;
        pending = true;
        if (listing) return;
        listing = true;
        void (async () => {
          try {
            while (pending && !controller.signal.aborted) {
              pending = false;
              const observedRevision = revision;
              const requests = await handle.client.listPendingPermissions(handle.providerContinuationId, controller.signal);
              if (controller.signal.aborted) return;
              if (!available()) { controller.abort(); return; }
              // SSE is consumed while the GET runs. Never publish a snapshot
              // overtaken by an ask/reply, nor resurrect a queued stale ask.
              if (observedRevision === revision) notify({ type: "snapshot", requests });
            }
          } catch {
            if (!controller.signal.aborted) { notify({ type: "degraded" }); controller.abort(); }
          } finally { listing = false; }
        })();
      };
      try {
        for await (const event of handle.client.events(controller.signal)) {
          if (controller.signal.aborted || !available()) break;
          if (event.type === "server.instance.disposed") {
            handle.controlLoss = "control_epoch_gone";
            this.emitExecution(handle, { domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "control_epoch_gone" });
            notify({ type: "unavailable", reason: "control_epoch_gone" });
            return;
          }
          if (event.type === "server.connected") refresh();
          const permission = parseOpenCodePermissionEvent(event);
          if (permission?.properties.sessionID === handle.providerContinuationId) refresh();
        }
      } catch {
        if (!signal.aborted) notify({ type: "degraded" });
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
      }
      if (signal.aborted || !available()) return;
      notify({ type: "degraded" });
      // Reconnect the observation channel only. No prompt replay or native abort.
      await new Promise<void>((resolve) => {
        const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 250);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }

  private controlProof(handle: OpenModelHandle): ControlProbeResult | null {
    if (handle.controlLoss) return { state: "lost", controlEvidence: handle.controlLoss };
    const identity = this.deps.getProcessIdentity(handle.pid);
    if (identity === undefined) return { state: "degraded" };
    if (identity === null) return { state: "lost", controlEvidence: "process_exit" };
    return sameProcessBirthIdentity(identity, handle.providerConnection.processIdentity!)
      ? null : { state: "lost", controlEvidence: "process_birth_changed" };
  }

  private emitExecution(handle: OpenModelHandle, fact: NativeExecutionFact): void {
    handle.execution.emit(fact, handle.providerConnection.processIdentity ?? undefined,
      handle.providerConnection.pid ?? undefined);
  }

  private emitRuntimeReady(handle: OpenModelHandle): void {
    this.emitExecution(handle, {
      domain: "runtime",
      kind: "state_changed",
      state: "ready",
      sideEffects: "none",
    });
  }

  private emitTurnActive(handle: OpenModelHandle, turnId: string): void {
    if (!nativeExecutionId(turnId) || !nativeExecutionId(handle.providerContinuationId)) return;
    const checkpoint = nativeLifecycleCheckpoint({
      provider: "open-model",
      workAttemptId: handle.workAttemptId,
      phase: "turn_active",
      providerContinuationId: handle.providerContinuationId,
      providerTurnId: turnId,
      nativeProcessPid: handle.providerConnection.pid ?? undefined,
      nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
    });
    this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
      providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
      nativeEventId: checkpoint.nativeEventId });
    this.emitLifecycleProjection(handle, "turn/started", checkpoint.nativeEventId, checkpoint.phase);
  }

  private emitTurnTerminal(handle: OpenModelHandle, turnId: string, outcome: TurnOutcome): void {
    if (!nativeExecutionId(turnId) || !nativeExecutionId(handle.providerContinuationId)
      || (handle.observedTurn?.id === turnId && handle.observedTurn.terminal)) return;
    handle.observedTurn = { id: turnId, terminal: outcome };
    const checkpoint = nativeLifecycleCheckpoint({
      provider: "open-model",
      workAttemptId: handle.workAttemptId,
      phase: "turn_terminal",
      providerContinuationId: handle.providerContinuationId,
      providerTurnId: turnId,
      nativeProcessPid: handle.providerConnection.pid ?? undefined,
      nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
      terminalDiscriminator: outcome,
    });
    this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: outcome,
      sideEffects: "none", providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
      nativeEventId: checkpoint.nativeEventId });
    this.emitLifecycleProjection(handle, "turn/completed", checkpoint.nativeEventId, checkpoint.phase);
  }

  private emitLifecycleProjection(
    handle: OpenModelHandle,
    method: "turn/started" | "turn/completed",
    nativeEventId: string,
    nativeLifecyclePhase: "turn_active" | "turn_terminal",
  ): void {
    this.emitStream(handle, { kind: "turn_lifecycle", method, summary: null, payload: null,
      nativeEventId, nativeLifecyclePhase, lifecycleProjectionOnly: true });
  }

  private required(handle: ProviderHandle): OpenModelHandle {
    const current = this.handles.get(handle.workAttemptId);
    if (!current || current !== handle) throw new Error("Open Model handle is stale or foreign.");
    return current;
  }

  private withContinuation(handle: OpenModelHandle, continuationId: string): OpenModelHandle {
    const replacement = new OpenModelHandle(
      handle.workAttemptId,
      handle.pid,
      continuationId,
      handle.lifecycleAuthorityMode,
      handle.providerConnection,
      handle.client,
      handle.configuredModel,
      "idle",
      this.deps.now,
    );
    this.handles.set(handle.workAttemptId, replacement);
    this.observeTerminal(replacement, this.deps.observeProcessExit(handle.pid, handle.providerConnection.processIdentity!));
    this.emitRuntimeReady(replacement);
    return replacement;
  }

  /**
   * Refuses to dispatch model work into a session whose transcript already
   * contains a user message outside OpenCode's ascending ID scheme (minted by
   * a pre-2.0.68 daemon). OpenCode sorts such an ID after every assistant
   * reply forever, so its loop can never reach a natural turn boundary again.
   * Failing with the continuation-missing contract routes the session through
   * the daemon's journaled repair, which replaces it before any model call.
   */
  private async assertNativelyOrderedSession(handle: OpenModelHandle): Promise<void> {
    if (handle.nativeOrderingVerified) return;
    if (!await this.sessionNativelyOrdered(handle.client, handle.providerContinuationId)) {
      throw new ProviderContinuationMissingError(handle.providerContinuationId);
    }
    handle.nativeOrderingVerified = true;
  }

  private async sessionNativelyOrdered(
    client: OpenCodeServerClient,
    sessionId: string,
  ): Promise<boolean> {
    const messages = await client.messages(sessionId, SESSION_ORDERING_SCAN_LIMIT);
    return messages.every((message) => {
      const info = record(message.info);
      return info?.role !== "user" || nativelyOrderedMessageId(info.id);
    });
  }

  private async awaitExactTurn(
    handle: OpenModelHandle,
    turnId: string,
    signal?: AbortSignal,
    recovery = false,
  ): Promise<ProviderRoomTurnResult> {
    const deadline = Date.now() + this.turnTimeoutMs;
    const emittedLengths = new Map<string, number>();
    const partTypes = new Map<string, string>();
    // callID -> last-emitted tool status. message.part.updated re-sends the
    // full tool part on every pending→running→completed/error transition, and
    // snapshot() re-emits history on reconnect, so dedup by (callID, status).
    const toolStatuses = new Map<string, string>();
    const assistantIds = new Set<string>();
    const typedAssistantIds = new Set<string>();
    const controller = new AbortController();
    const detach = (): void => controller.abort();
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) controller.abort();
    const events = handle.client.events(controller.signal)[Symbol.asyncIterator]();
    const snapshot = async (): Promise<{
      assistantCount: number;
      result: ProviderRoomTurnResult | null;
      terminalOutcome: TurnOutcome | null;
    }> => {
      const messages = await handle.client.messages(
        handle.providerContinuationId,
        Math.max(64, this.maxAssistantSteps + 1),
      );
      const assistants = assistantsFor(messages, turnId);
      for (const assistant of assistants) {
        const info = record(assistant.info);
        if (typeof info?.id === "string") assistantIds.add(info.id);
        const exactSession = info?.sessionID === undefined || info.sessionID === handle.providerContinuationId;
        if (exactSession && typeof info?.id === "string") typedAssistantIds.add(info.id);
        this.emitMessageEvidence(handle, assistant, emittedLengths, toolStatuses,
          exactSession ? turnId : undefined);
      }
      if (assistants.length > this.maxAssistantSteps) {
        throw new OpenCodeBoundedTurnError(
          `OpenCode exceeded the bounded turn limit of ${this.maxAssistantSteps} assistant steps.`,
        );
      }
      const finalAssistant = finalAssistantFor(messages, turnId);
      const finalInfo = record(finalAssistant?.info);
      const exactSession = finalInfo?.sessionID === undefined || finalInfo.sessionID === handle.providerContinuationId;
      const terminalError = safeProviderErrorMessage(finalAssistant);
      if (terminalError) {
        if (exactSession) this.emitTurnTerminal(handle, turnId, "failed");
        throw new OpenCodeTerminalTurnError(terminalError);
      }
      const result = finalAssistant && messageCompleted(finalAssistant) ? classifyTurn(turnId, messageText(finalAssistant)) : null;
      return {
        assistantCount: assistants.length,
        result,
        terminalOutcome: exactSession && result && messageFinishReason(finalAssistant) !== "tool-calls"
          ? result.outcome === "unreadable" ? "unreadable" : "completed" : null,
      };
    };
    const resultAtSessionBoundary = (
      observed: Awaited<ReturnType<typeof snapshot>>,
    ): ProviderRoomTurnResult => {
      // Legacy session-status fallbacks remain unchanged, but typed authority
      // must not invent a native terminal from a missing/busy status entry.
      if (observed.terminalOutcome) this.emitTurnTerminal(handle, turnId, observed.terminalOutcome);
      return observed.result ?? { turnId, outcome: "unreadable", text: null, evidence: "none" };
    };

    try {
      // Opening the SSE stream before the snapshot closes the completion race:
      // history repairs anything that happened before subscription, then every
      // later transition is event-driven rather than O(history) polling.
      const connected = await nextEventBefore(events, deadline);
      if (connected.done) throw new Error("OpenCode event stream ended before turn observation.");
      const initial = await snapshot();
      if (await handle.client.status(handle.providerContinuationId) !== "busy"
        && (recovery || initial.assistantCount > 0)) {
        return resultAtSessionBoundary(initial);
      }

      while (Date.now() < deadline) {
        if (controller.signal.aborted) {
          throw new Error("OpenCode turn observation detached.");
        }
        const next = await nextEventBefore(events, deadline);
        if (next.done) {
          const repaired = await snapshot();
          if (await handle.client.status(handle.providerContinuationId) !== "busy") {
            return resultAtSessionBoundary(repaired);
          }
          throw new Error("OpenCode event stream ended before the bounded turn completed.");
        }
        const event = next.value;
        const properties = record(event.properties);
        const info = record(properties?.info);
        if (info?.role === "assistant" && info.parentID === turnId
          && typeof info.id === "string") {
          assistantIds.add(info.id);
          if (info.sessionID === handle.providerContinuationId) typedAssistantIds.add(info.id);
          if (assistantIds.size > this.maxAssistantSteps) {
            throw new OpenCodeBoundedTurnError(
              `OpenCode exceeded the bounded turn limit of ${this.maxAssistantSteps} assistant steps.`,
            );
          }
        }
        if (event.type === "message.part.updated") {
          const part = record(properties?.part);
          if (typeof part?.messageID === "string" && assistantIds.has(part.messageID)) {
            if (typeof part.id === "string" && typeof part.type === "string") {
              partTypes.set(part.id, part.type);
            }
            this.emitMessageEvidence(
              handle,
              { parts: [part] as OpenCodeMessage["parts"] },
              emittedLengths,
              toolStatuses,
              typedAssistantIds.has(part.messageID) ? turnId : undefined,
            );
          }
        }
        if (event.type === "message.part.delta"
          && typeof properties?.messageID === "string"
          && assistantIds.has(properties.messageID)
          && properties?.field === "text"
          && typeof properties.partID === "string"
          && typeof properties.delta === "string") {
          const partId = properties.partID;
          emittedLengths.set(
            partId,
            (emittedLengths.get(partId) ?? 0) + properties.delta.length,
          );
          this.emitTextDelta(
            handle,
            partId,
            properties.delta,
            partTypes.get(partId) === "reasoning",
          );
        }
        if (!eventReferencesSession(event, handle.providerContinuationId)) continue;
        if (event.type === "session.idle") {
          return resultAtSessionBoundary(await snapshot());
        }
        if (event.type === "session.error") {
          await snapshot();
          return { turnId, outcome: "unreadable", text: null, evidence: "none" };
        }
      }
      throw new OpenCodeBoundedTurnError("OpenCode bounded turn timed out.");
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("OpenCode turn observation detached.", { cause: error });
      }
      throw error;
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", detach);
      await events.return?.(undefined).catch(() => undefined);
    }
  }

  private async abortBoundedTurn(
    handle: OpenModelHandle,
    turnId: string,
    reason: OpenCodeBoundedTurnError,
  ): Promise<never> {
    try {
      await handle.client.abort(handle.providerContinuationId);
      await this.waitForSessionIdle(handle, this.turnControlTimeoutMs);
    } catch (error) {
      throw new OpenCodeBoundedTurnError(
        `${reason.message} Native abort could not be verified; the exact turn will not be rerun automatically.`,
        { cause: error },
      );
    }
    if (handle.activeRoomTurnId === turnId) handle.activeRoomTurnId = null;
    handle.setState("idle");
    this.emitTurnTerminal(handle, turnId, "interrupted");
    throw reason;
  }

  private async waitForSessionIdle(
    handle: OpenModelHandle,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Bound each status probe to the remaining budget: a server that never
      // answers status must not stretch a Stop far past its control timeout.
      const status = await resolveBeforeDeadline(
        handle.client.status(handle.providerContinuationId),
        deadline,
        "OpenCode status probe did not return before the turn-control deadline.",
      );
      if (status !== "busy") return;
      await delay(50);
    }
    throw new Error("OpenCode remained busy after native abort.");
  }

  private emitMessageEvidence(
    handle: OpenModelHandle,
    message: OpenCodeMessage | null,
    emittedLengths: Map<string, number>,
    toolStatuses?: Map<string, string>,
    turnId?: string,
  ): void {
    for (const part of message?.parts ?? []) {
      if (part.type === "tool") {
        if (toolStatuses) this.emitToolCall(handle, part, toolStatuses, turnId);
        continue;
      }
      const id = typeof part.id === "string" ? part.id : `${part.type ?? "part"}`;
      const text = typeof part.text === "string" ? part.text : "";
      const previous = emittedLengths.get(id) ?? 0;
      if (text.length <= previous) continue;
      emittedLengths.set(id, text.length);
      this.emitTextDelta(handle, id, text.slice(previous), part.type === "reasoning");
    }
  }

  /**
   * Surface an OpenCode tool call (name, arguments, result) as a live-feed
   * event. The method stays a neutral "updated" — the daemon classifies stream
   * lifecycle from method/kind, so a terminal-sounding method or an error kind
   * would wrongly mark the whole turn idle/failed; tool status rides in the
   * payload instead. Deduped by (callID, status) because the full part is
   * re-sent on every transition and re-observed on reconnect.
   */
  private emitToolCall(
    handle: OpenModelHandle,
    part: OpenCodePart,
    toolStatuses: Map<string, string>,
    turnId?: string,
  ): void {
    const state = record(part.state);
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    const callId = typeof part.callID === "string" ? part.callID
      : typeof part.id === "string" ? part.id : tool;
    const status = typeof state?.status === "string" ? state.status : "pending";
    if (toolStatuses.get(callId) === status) return;
    toolStatuses.set(callId, status);
    if (turnId && (nativeExecutionId(part.callID) || nativeExecutionId(part.id)) && nativeExecutionId(callId) && nativeExecutionId(turnId)
      && nativeExecutionId(handle.providerContinuationId)
      && (part.sessionID === undefined || part.sessionID === handle.providerContinuationId)
      && (status === "completed" || status === "error")) {
      const operation = tool === "bash" ? "command"
        : ["read", "glob", "grep", "list"].includes(tool) ? "file_read"
          : ["edit", "write", "patch", "apply_patch"].includes(tool) ? "file_change"
            : ["webfetch", "websearch"].includes(tool) ? "network"
              : tool === "question" ? "question" : "other";
      // OpenCode sets running before permission evaluation. Only a terminal
      // tool result is execution evidence here; error text cannot prove a
      // before-start denial or distinguish it from partial side effects.
      const exit = record(state?.metadata)?.exit;
      const exitCode = typeof exit === "number" && Number.isSafeInteger(exit) && exit >= -2_147_483_648 && exit <= 2_147_483_647 ? exit : undefined;
      // Pinned ShellTool metadata.exit is the actual child code, or null after
      // native timeout/abort. Tool-call success alone says nothing about exit.
      if (operation !== "command" || status === "error" || exit === null || exitCode !== undefined) {
        this.emitExecution(handle, { domain: "execution", kind: "completed", executionId: callId, operation,
          providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
          sideEffects: operation === "file_read" || operation === "question" ? "none" : "possible",
          outcome: status === "error" ? "failed" : operation === "command"
            ? exit === null ? "interrupted_after_start" : exitCode === 0 ? "succeeded" : "failed"
            : "succeeded",
          ...(operation === "command" && exitCode !== undefined ? { exitCode } : {}),
        });
      }
    }
    const title = typeof state?.title === "string" ? state.title : "";
    this.emitStream(handle, {
      kind: "tool_lifecycle",
      method: "item/toolCall/updated",
      summary: `${tool}${title ? ` · ${title}` : ""}`,
      payload: {
        partId: typeof part.id === "string" ? part.id : null,
        callID: callId,
        tool,
        status,
        input: state?.input ?? null,
        output: typeof state?.output === "string" ? state.output : null,
        error: typeof state?.error === "string" ? state.error : null,
        providerExecuted: record(part.metadata)?.providerExecuted === true,
      },
    });
  }

  private emitTextDelta(
    handle: OpenModelHandle,
    partId: string,
    delta: string,
    reasoning: boolean,
  ): void {
    this.emitStream(handle, {
      kind: "text_delta",
      method: reasoning ? "reasoning/summaryTextDelta" : "item/agentMessage/delta",
      summary: reasoning ? delta.trim().slice(0, 320) || "Thinking" : null,
      payload: { partId, delta },
    });
  }

  private emitStream(
    handle: OpenModelHandle,
    input: Pick<ProviderStreamEvent, "kind" | "method"> & Partial<Pick<ProviderStreamEvent,
      "nativeEventId" | "nativeLifecyclePhase" | "lifecycleProjectionOnly">> & {
      summary: string | null;
      payload: unknown;
    },
  ): void {
    const safe = safeStreamPayload(input.payload);
    const event: ProviderStreamEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      sequence: ++handle.sequence,
      provider: "open-model",
      kind: input.kind,
      method: input.method,
      ...(input.nativeEventId ? { nativeEventId: input.nativeEventId } : {}),
      ...(input.nativeLifecyclePhase ? { nativeLifecyclePhase: input.nativeLifecyclePhase } : {}),
      ...(input.lifecycleProjectionOnly ? { lifecycleProjectionOnly: true as const } : {}),
      summary: input.summary,
      payload: safe.payload,
      payloadTruncated: safe.payloadTruncated,
      payloadRedacted: safe.payloadRedacted,
      durablePayloadRef: null,
    };
    for (const listener of handle.streamListeners) listener(event);
    if (input.summary) {
      const activity: ProviderActivityEvent = {
        workAttemptId: handle.workAttemptId,
        providerContinuationId: handle.providerContinuationId,
        observedAt: event.observedAt,
        source: "native_harness",
        method: input.method,
        summary: input.summary,
        status: "working",
        checking: input.summary,
        nextAction: "Continue the bounded Open Model turn.",
      };
      for (const listener of handle.activityListeners) listener(activity);
    }
  }

  private async waitForHealth(
    client: OpenCodeServerClient,
    exited: Promise<ProviderProcessExit>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    let terminal = false;
    void exited.then(() => { terminal = true; });
    while (!terminal && Date.now() < deadline) {
      // The launch budget stays authoritative even if one health request
      // hangs: OpenCode can accept a startup-era connection it never answers,
      // and an unbounded await here once stretched a 30s budget to five
      // minutes of silent "Starting Open Model".
      const healthy = await Promise.race([
        client.health(),
        delay(Math.max(1, deadline - Date.now())).then(() => false),
      ]);
      if (healthy) return true;
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
    return false;
  }

  private observeTerminal(handle: OpenModelHandle, exited: Promise<ProviderProcessExit>): void {
    void exited.then((exit) => {
      this.finish(handle, terminalFromExit(exit, handle.providerContinuationId, this.deps.now(), false), exit.type === "exit");
    });
  }

  private finish(handle: OpenModelHandle, terminal: ProviderTerminalPayload, processExited: boolean): void {
    if (handle.terminal) return;
    if (this.handles.get(handle.workAttemptId) === handle) {
      const actual = this.deps.getProcessIdentity(handle.pid);
      const evidence = processExited || actual === null ? "process_exit"
        : typeof actual === "string" && !sameProcessBirthIdentity(actual, handle.providerConnection.processIdentity!) ? "process_birth_changed" : null;
      if (evidence && handle.observedTurn && !handle.observedTurn.terminal) {
        handle.observedTurn.terminal = "lost";
        this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: handle.observedTurn.id });
      }
      if (evidence) {
        handle.controlLoss = evidence;
        this.emitExecution(handle, { domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: evidence });
        this.emitExecution(handle, { domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence: evidence });
      } else this.emitExecution(handle, { domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" });
    }
    handle.terminal = terminal;
    handle.setState("stopped");
    if (this.handles.get(handle.workAttemptId) === handle) this.handles.delete(handle.workAttemptId);
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
  }
}

async function readRuntimeControl(path: string): Promise<OpenCodeRuntimeControl> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8_192) {
    throw new Error("OpenCode server authentication sidecar is invalid.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<OpenCodeRuntimeControl>;
  if (typeof value.username !== "string" || !value.username
    || typeof value.password !== "string" || !value.password) {
    throw new Error("OpenCode server authentication sidecar is malformed.");
  }
  if (value.lifecycleAuthorityMode !== undefined
    && value.lifecycleAuthorityMode !== "legacy"
    && value.lifecycleAuthorityMode !== "typed_shadow"
    && value.lifecycleAuthorityMode !== "typed") {
    throw new Error("OpenCode server authentication sidecar contains an invalid lifecycle authority.");
  }
  if (value.connection !== undefined
    && (typeof value.connection !== "object"
      || typeof value.connection.url !== "string"
      || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.connection.url)
      || !Number.isSafeInteger(value.connection.pid)
      || value.connection.pid < 1
      || typeof value.connection.processIdentity !== "string"
      || !value.connection.processIdentity)) {
    throw new Error("OpenCode server authentication sidecar contains invalid connection evidence.");
  }
  return {
    username: value.username,
    password: value.password,
    ...(value.lifecycleAuthorityMode ? { lifecycleAuthorityMode: value.lifecycleAuthorityMode } : {}),
    ...(value.connection ? { connection: value.connection } : {}),
  };
}

async function writeRuntimeControl(path: string, value: OpenCodeRuntimeControl): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function terminalFromExit(
  exit: ProviderProcessExit,
  continuationId: string,
  endedAt: string,
  stopRequested: boolean,
): ProviderTerminalPayload {
  return synthesizeTerminalPayload({
    exitCode: exit.type === "exit" ? exit.code : null,
    signal: exit.type === "exit" ? exit.signal : null,
    providerContinuationId: continuationId,
    endedAt,
    stopRequested,
  });
}

export const openModelProviderAdapter = new OpenModelProviderAdapter();
