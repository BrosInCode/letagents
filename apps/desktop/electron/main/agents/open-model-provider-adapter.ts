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
import {
  assistantsFor,
  eventReferencesSession,
  finalAssistantFor,
  messageCompleted,
  messageError,
  messageText,
  mintNativeUserMessageId,
  nativelyOrderedMessageId,
  OpenCodeServerClient,
  record,
  type JsonRecord,
  type OpenCodeEvent,
  type OpenCodeMessage,
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
  maxAssistantSteps?: number;
  stopGraceMs?: number;
}

const CAPABILITIES: ProviderAdapterCapabilities = {
  deliveryModes: ["daemon_inbox"],
  resume: true,
  midTurnInjection: false,
  transcriptAccess: true,
  permissionPromptBridging: false,
  survivesRestart: true,
  turnControl: "native_interrupt",
  continuationRepair: "same_process",
};

function boundedRoomTurnPrompt(request: ProviderRoomTurnRequest): string {
  return [
    "You are handling one daemon-owned room inbox item in an exact bounded turn.",
    `Your durable charter: ${request.charter?.trim() || "Help thoughtfully within the room."}`,
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

  constructor(
    readonly workAttemptId: string,
    readonly pid: number,
    readonly providerContinuationId: string,
    readonly providerConnection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>,
    readonly client: OpenCodeServerClient,
    readonly configuredModel: string,
    initialState: ProviderObservedState,
  ) {
    this.observed = initialState;
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
    await writeRuntimeControl(authPath, auth);
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
      connection: { url, pid, processIdentity: identity },
    });
    const handle = new OpenModelHandle(
      req.workAttemptId,
      pid,
      sessionId,
      connection,
      client,
      credential.model,
      "idle",
    );
    handle.nativeOrderingVerified = true;
    this.handles.set(req.workAttemptId, handle);
    this.observeTerminal(handle, launch.exited);
    return handle;
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const resolved = await this.resolveAttachConnection(ref);
    if (!resolved) return null;
    const { connection, control, recoveredLegacyConnection } = resolved;
    const cached = this.handles.get(ref.workAttemptId);
    if (cached
      && cached.providerContinuationId === ref.providerContinuationId
      && cached.providerConnection.url === connection.url
      && cached.providerConnection.processIdentity === connection.processIdentity) return cached;
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
      connection,
      client,
      configuredModel,
      "idle",
    );
    this.handles.set(ref.workAttemptId, handle);
    this.observeTerminal(handle, this.deps.observeProcessExit(connection.pid, connection.processIdentity));
    if (recoveredLegacyConnection) {
      await writeRuntimeControl(connection.serverAuthPath, {
        ...auth,
        connection: {
          url: connection.url,
          pid: connection.pid,
          processIdentity: connection.processIdentity,
        },
      });
    }
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
      }
      throw error;
    }
  }

  async recoverRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: { detachSignal?: AbortSignal; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<void> } = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    handle.activeRoomTurnId = request.providerTurnId;
    try {
      const result = await this.awaitExactTurn(handle, request.providerTurnId, options.detachSignal, true);
      await options.checkpointTerminalResult?.(result);
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return result;
    } catch (error) {
      if (error instanceof OpenCodeBoundedTurnError) {
        await this.abortBoundedTurn(handle, request.providerTurnId, error);
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
    if (await handle.client.status(handle.providerContinuationId) !== "busy") {
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" };
    }
    const activeTurnId = handle.activeRoomTurnId;
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
    await this.waitForSessionIdle(handle, TURN_CONTROL_TIMEOUT_MS).catch((error) => {
      throw new ProviderTurnControlError(
        `OpenCode accepted the abort, but its turn boundary could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        "uncertain",
      );
    });
    if (activeTurnId === null || handle.activeRoomTurnId === activeTurnId) {
      handle.activeRoomTurnId = null;
    }
    handle.setState("idle");
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
    this.finish(handle, terminal);
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
      handle.providerConnection,
      handle.client,
      handle.configuredModel,
      "idle",
    );
    this.handles.set(handle.workAttemptId, replacement);
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
    const assistantIds = new Set<string>();
    const controller = new AbortController();
    const detach = (): void => controller.abort();
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) controller.abort();
    const events = handle.client.events(controller.signal)[Symbol.asyncIterator]();
    const snapshot = async (): Promise<{
      assistantCount: number;
      result: ProviderRoomTurnResult | null;
    }> => {
      const messages = await handle.client.messages(
        handle.providerContinuationId,
        Math.max(64, this.maxAssistantSteps + 1),
      );
      const assistants = assistantsFor(messages, turnId);
      for (const assistant of assistants) {
        const info = record(assistant.info);
        if (typeof info?.id === "string") assistantIds.add(info.id);
        this.emitMessageEvidence(handle, assistant, emittedLengths);
      }
      if (assistants.length > this.maxAssistantSteps) {
        throw new OpenCodeBoundedTurnError(
          `OpenCode exceeded the bounded turn limit of ${this.maxAssistantSteps} assistant steps.`,
        );
      }
      const finalAssistant = finalAssistantFor(messages, turnId);
      const terminalError = safeProviderErrorMessage(finalAssistant);
      if (terminalError) throw new OpenCodeTerminalTurnError(terminalError);
      return {
        assistantCount: assistants.length,
        result: finalAssistant && messageCompleted(finalAssistant)
          ? classifyTurn(turnId, messageText(finalAssistant))
          : null,
      };
    };
    const resultAtSessionBoundary = (
      observed: Awaited<ReturnType<typeof snapshot>>,
    ): ProviderRoomTurnResult => observed.result
      ?? { turnId, outcome: "unreadable", text: null, evidence: "none" };

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
      await this.waitForSessionIdle(handle, TURN_CONTROL_TIMEOUT_MS);
    } catch (error) {
      throw new OpenCodeBoundedTurnError(
        `${reason.message} Native abort could not be verified; the exact turn will not be rerun automatically.`,
        { cause: error },
      );
    }
    if (handle.activeRoomTurnId === turnId) handle.activeRoomTurnId = null;
    handle.setState("idle");
    throw reason;
  }

  private async waitForSessionIdle(
    handle: OpenModelHandle,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await handle.client.status(handle.providerContinuationId) !== "busy") return;
      await delay(50);
    }
    throw new Error("OpenCode remained busy after native abort.");
  }

  private emitMessageEvidence(
    handle: OpenModelHandle,
    message: OpenCodeMessage | null,
    emittedLengths: Map<string, number>,
  ): void {
    for (const part of message?.parts ?? []) {
      const id = typeof part.id === "string" ? part.id : `${part.type ?? "part"}`;
      const text = typeof part.text === "string" ? part.text : "";
      const previous = emittedLengths.get(id) ?? 0;
      if (text.length <= previous) continue;
      emittedLengths.set(id, text.length);
      this.emitTextDelta(handle, id, text.slice(previous), part.type === "reasoning");
    }
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
    input: Pick<ProviderStreamEvent, "kind" | "method"> & {
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
      this.finish(handle, terminalFromExit(exit, handle.providerContinuationId, this.deps.now(), false));
    });
  }

  private finish(handle: OpenModelHandle, terminal: ProviderTerminalPayload): void {
    if (handle.terminal) return;
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
