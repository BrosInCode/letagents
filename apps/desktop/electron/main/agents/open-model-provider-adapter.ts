import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { resolveOpenCodeBinary } from "./opencode-runtime.js";

const PROVIDER_ID = "letagents-open-model";
const SERVER_USERNAME = "opencode";
const START_TIMEOUT_MS = 30_000;
const TURN_POLL_MS = 250;
const TURN_TIMEOUT_MS = 30 * 60_000;
const NO_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

type JsonRecord = Record<string, unknown>;
type OpenCodePart = JsonRecord & { id?: unknown; type?: unknown; text?: unknown };
type OpenCodeMessage = {
  info?: JsonRecord;
  parts?: OpenCodePart[];
};

type RuntimeAuth = { username: string; password: string };

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
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): string;
}

export interface OpenModelProviderAdapterOptions {
  binary?: string;
  runtimeRoot?: string;
  dependencies?: Partial<OpenModelProviderAdapterDependencies>;
  startTimeoutMs?: number;
  turnTimeoutMs?: number;
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

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

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

function assistantFor(messages: OpenCodeMessage[], userMessageId: string): OpenCodeMessage | null {
  return messages.find((message) => {
    const info = record(message.info);
    return info?.role === "assistant" && info.parentID === userMessageId;
  }) ?? null;
}

function messageText(message: OpenCodeMessage | null): string | null {
  if (!message) return null;
  const text = (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("")
    .trim();
  return text || null;
}

function messageCompleted(message: OpenCodeMessage | null): boolean {
  const info = record(message?.info);
  const time = record(info?.time);
  return typeof time?.completed === "number" || Boolean(info?.error);
}

function serverStatus(value: unknown, sessionId: string): string {
  const statuses = record(value);
  const status = record(statuses?.[sessionId]);
  return typeof status?.type === "string" ? status.type : "idle";
}

function safeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}

function minimalOpenCodeEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...extra };
}

export function openCodeConfig(input: {
  model: string;
  baseUrl: string;
  pluginUrl: string;
  cwd: string;
  mcpCommand: string[];
  mcpEnvironment: Record<string, string>;
}): JsonRecord {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    model: `${PROVIDER_ID}/${input.model}`,
    plugin: [input.pluginUrl],
    permission: { "*": "allow" },
    provider: {
      [PROVIDER_ID]: {
        id: PROVIDER_ID,
        name: "LetAgents Open Model",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { baseURL: input.baseUrl },
        models: {
          [input.model]: {
            id: input.model,
            name: input.model,
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 1_000_000, output: 100_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
    },
    mcp: {
      letagents: {
        type: "local",
        command: input.mcpCommand,
        cwd: input.cwd,
        environment: input.mcpEnvironment,
        enabled: true,
      },
    },
  };
}

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

const defaultDependencies: OpenModelProviderAdapterDependencies = {
  launch: defaultLaunch,
  getProcessIdentity: defaultGetProcessIdentity,
  observeProcessExit: defaultObserveProcessExit,
  signalProcess: defaultSignalProcess,
  allocatePort: defaultAllocatePort,
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

  constructor(
    readonly workAttemptId: string,
    readonly pid: number,
    readonly providerContinuationId: string,
    readonly providerConnection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>,
    readonly auth: RuntimeAuth,
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
  private readonly stopGraceMs: number;
  private readonly runtimeRoot: string;
  private readonly handles = new Map<string, OpenModelHandle>();

  constructor(options: OpenModelProviderAdapterOptions = {}) {
    this.binary = options.binary
      || resolveOpenCodeBinary();
    this.deps = { ...defaultDependencies, ...options.dependencies };
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
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
    const auth: RuntimeAuth = {
      username: SERVER_USERNAME,
      password: randomBytes(32).toString("base64url"),
    };
    await writeFile(authPath, `${JSON.stringify(auth)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600);
    const pluginPath = join(runtimeRoot, "credential-boundary.mjs");
    await writeFile(pluginPath, [
      "export default async () => ({",
      '  "shell.env": (_input, output) => {',
      '    output.env.OPENCODE_AUTH_CONTENT = "";',
      '    output.env.OPENCODE_SERVER_PASSWORD = "";',
      '    output.env.OPENCODE_SERVER_USERNAME = "";',
      "  },",
      "});",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    const mcpCommand = req.devMcpServerEntryPath
      ? [process.execPath, req.devMcpServerEntryPath]
      : ["npx", ...LETAGENTS_NPX_ARGS];
    const mcpEnvironment: Record<string, string> = {
      LETAGENTS_API_URL: process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId || "",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath || "",
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId || "",
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession?.agentSessionId || "",
      LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
      LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName?.trim() || "Open Model agent",
      LETAGENTS_SUPERVISOR_PROVIDER: "open-model",
      OPENCODE_AUTH_CONTENT: "",
      OPENCODE_CONFIG_CONTENT: "",
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
    };
    for (const [key, value] of Object.entries(mcpEnvironment)) {
      if (!value && key.startsWith("LETAGENTS_SUPERVISOR_")) {
        throw new Error(`Open Model supervised launch is missing ${key}.`);
      }
    }
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
    const env = minimalOpenCodeEnvironment(process.env, {
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: credential.apiKey
        ? JSON.stringify({ [PROVIDER_ID]: { type: "api", key: credential.apiKey } })
        : "{}",
      XDG_DATA_HOME: join(runtimeRoot, "data"),
      XDG_CACHE_HOME: join(runtimeRoot, "cache"),
      XDG_CONFIG_HOME: join(runtimeRoot, "config"),
      XDG_STATE_HOME: join(runtimeRoot, "state"),
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
    const ready = await this.waitForHealth(url, auth, launch.exited);
    if (!ready) {
      await terminateFreshLaunch({ pid, exited: launch.exited }, this.deps, this.stopGraceMs);
      throw new Error("Timed out waiting for the supervised OpenCode server.");
    }
    const session = await this.requestJson<JsonRecord>(url, auth, "/session", {
      method: "POST",
      body: JSON.stringify({ title: req.agentDisplayName?.trim() || "LetAgents Open Model" }),
    });
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
    const handle = new OpenModelHandle(
      req.workAttemptId,
      pid,
      sessionId,
      connection,
      auth,
      credential.model,
      "idle",
    );
    this.handles.set(req.workAttemptId, handle);
    this.observeTerminal(handle, launch.exited);
    return handle;
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const connection = ref.providerConnection;
    if (connection?.kind !== "opencode_server" || connection.pid === null || !connection.processIdentity) return null;
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
    const auth = await readRuntimeAuth(connection.serverAuthPath);
    if (!await this.health(connection.url, auth)) return null;
    const sessions = await this.requestJson<JsonRecord[]>(connection.url, auth, "/session");
    if (!sessions.some((session) => session.id === ref.providerContinuationId)) {
      throw new ProviderContinuationMissingError(ref.providerContinuationId);
    }
    const config = await this.requestJson<JsonRecord>(connection.url, auth, "/config");
    const configuredModel = parseConfiguredModel(config);
    if (!configuredModel) throw new Error("The attached OpenCode runtime has no configured Open Model.");
    const handle = new OpenModelHandle(
      ref.workAttemptId,
      connection.pid,
      ref.providerContinuationId,
      connection,
      auth,
      configuredModel,
      "idle",
    );
    this.handles.set(ref.workAttemptId, handle);
    this.observeTerminal(handle, this.deps.observeProcessExit(connection.pid, connection.processIdentity));
    return handle;
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    const attached = await this.attach(ref);
    if (attached && !("state" in attached)) return attached;
    if (attached?.state === "terminal") throw new Error("The saved OpenCode process is no longer running.");
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
    const turnId = `msg_${request.actionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 52)}_${randomUUID().slice(0, 8)}`;
    await (options.beforeNativeDispatch ?? options.markDispatched)?.();
    handle.setState("working");
    const response = await this.deps.fetch(
      `${handle.providerConnection.url}/session/${encodeURIComponent(handle.providerContinuationId)}/prompt_async`,
      this.authInit(handle.auth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageID: turnId,
          model: {
            providerID: PROVIDER_ID,
            modelID: handle.configuredModel,
          },
          parts: [{ type: "text", text: boundedRoomTurnPrompt(request) }],
        }),
      }),
    );
    if (!response.ok) {
      handle.setState("idle");
      throw new Error(`OpenCode rejected the bounded turn with HTTP ${response.status}.`);
    }
    await options.checkpointTurnStarted?.(turnId);
    const result = await this.awaitExactTurn(handle, turnId, options.detachSignal);
    await options.checkpointTerminalResult?.(result);
    handle.setState("idle");
    return result;
  }

  async recoverRoomTurn(
    rawHandle: ProviderHandle,
    request: ProviderRoomTurnRecoveryRequest,
    options: { detachSignal?: AbortSignal; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<void> } = {},
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.required(rawHandle);
    const result = await this.awaitExactTurn(handle, request.providerTurnId, options.detachSignal, true);
    await options.checkpointTerminalResult?.(result);
    return result;
  }

  async inspectTurn(rawHandle: ProviderHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.required(rawHandle);
    const messages = await this.messages(handle);
    const assistant = assistantFor(messages, turnId);
    if (assistant && messageCompleted(assistant)) return "terminal";
    const status = await this.status(handle);
    return status === "busy" || assistant ? "active" : "unknown";
  }

  async controlTurn(rawHandle: ProviderHandle): Promise<ProviderTurnControlResult> {
    const handle = this.required(rawHandle);
    const response = await this.deps.fetch(
      `${handle.providerConnection.url}/session/${encodeURIComponent(handle.providerContinuationId)}/abort`,
      this.authInit(handle.auth, { method: "POST" }),
    );
    if (!response.ok) throw new Error(`OpenCode turn abort failed with HTTP ${response.status}.`);
    handle.setState("idle");
    return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" };
  }

  async repairContinuation(
    rawHandle: ProviderHandle,
    request: ProviderContinuationRepairRequest,
    options: { checkpointReplacement: (providerContinuationId: string) => Promise<void> },
  ): Promise<ProviderContinuationRepairResult> {
    const handle = this.required(rawHandle);
    if (request.checkpointedReplacementProviderContinuationId) {
      const sessions = await this.requestJson<JsonRecord[]>(handle.providerConnection.url, handle.auth, "/session");
      if (sessions.some((session) => session.id === request.checkpointedReplacementProviderContinuationId)) {
        const replacement = this.withContinuation(handle, request.checkpointedReplacementProviderContinuationId);
        return {
          handle: replacement,
          outcome: "replaced",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: replacement.providerContinuationId,
        };
      }
    }
    if (!request.forceReplacement) {
      const sessions = await this.requestJson<JsonRecord[]>(handle.providerConnection.url, handle.auth, "/session");
      if (sessions.some((session) => session.id === request.expectedProviderContinuationId)) {
        return {
          handle,
          outcome: "rematerialized",
          previousProviderContinuationId: request.expectedProviderContinuationId,
          replacementProviderContinuationId: request.expectedProviderContinuationId,
        };
      }
    }
    const created = await this.requestJson<JsonRecord>(handle.providerConnection.url, handle.auth, "/session", {
      method: "POST", body: JSON.stringify({ title: "LetAgents restored conversation" }),
    });
    const replacementId = typeof created.id === "string" ? created.id : "";
    if (!replacementId) throw new Error("OpenCode continuation repair did not return a session id.");
    await options.checkpointReplacement(replacementId);
    const replacement = this.withContinuation(handle, replacementId);
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
      handle.auth,
      handle.configuredModel,
      "idle",
    );
    this.handles.set(handle.workAttemptId, replacement);
    return replacement;
  }

  private async awaitExactTurn(
    handle: OpenModelHandle,
    turnId: string,
    signal?: AbortSignal,
    recovery = false,
  ): Promise<ProviderRoomTurnResult> {
    const deadline = Date.now() + this.turnTimeoutMs;
    const emittedLengths = new Map<string, number>();
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("OpenCode turn observation detached.");
      const messages = await this.messages(handle);
      const assistant = assistantFor(messages, turnId);
      this.emitMessageEvidence(handle, assistant, emittedLengths);
      if (assistant && messageCompleted(assistant)) return classifyTurn(turnId, messageText(assistant));
      const status = await this.status(handle);
      if (recovery && status !== "busy" && !assistant) {
        return { turnId, outcome: "unreadable", text: null, evidence: "none" };
      }
      await delay(TURN_POLL_MS);
    }
    throw new Error("OpenCode bounded turn timed out.");
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
      const delta = text.slice(previous);
      const reasoning = part.type === "reasoning";
      this.emitStream(handle, {
        kind: reasoning ? "text_delta" : "text_delta",
        method: reasoning ? "reasoning/summaryTextDelta" : "item/agentMessage/delta",
        summary: reasoning ? delta.trim().slice(0, 320) || "Thinking" : null,
        payload: { partId: id, delta },
      });
    }
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

  private async messages(handle: OpenModelHandle): Promise<OpenCodeMessage[]> {
    return this.requestJson<OpenCodeMessage[]>(
      handle.providerConnection.url,
      handle.auth,
      `/session/${encodeURIComponent(handle.providerContinuationId)}/message`,
    );
  }

  private async status(handle: OpenModelHandle): Promise<string> {
    return serverStatus(
      await this.requestJson<unknown>(handle.providerConnection.url, handle.auth, "/session/status"),
      handle.providerContinuationId,
    );
  }

  private async requestJson<T>(
    url: string,
    auth: RuntimeAuth,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.deps.fetch(`${url}${path}`, this.authInit(auth, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    }));
    if (response.status === 404 && /^\/session\/[^/]+/.test(path)) {
      const continuationId = decodeURIComponent(path.split("/")[2] || "");
      throw new ProviderContinuationMissingError(continuationId);
    }
    if (!response.ok) throw new Error(`OpenCode request failed with HTTP ${response.status}.`);
    return await response.json() as T;
  }

  private authInit(auth: RuntimeAuth, init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
        ...(init.headers ?? {}),
      },
    };
  }

  private async health(url: string, auth: RuntimeAuth): Promise<boolean> {
    try {
      const response = await this.deps.fetch(`${url}/global/health`, this.authInit(auth, {}));
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(
    url: string,
    auth: RuntimeAuth,
    exited: Promise<ProviderProcessExit>,
  ): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    let terminal = false;
    void exited.then(() => { terminal = true; });
    while (!terminal && Date.now() < deadline) {
      if (await this.health(url, auth)) return true;
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

async function readRuntimeAuth(path: string): Promise<RuntimeAuth> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) {
    throw new Error("OpenCode server authentication sidecar is invalid.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeAuth>;
  if (typeof value.username !== "string" || !value.username
    || typeof value.password !== "string" || !value.password) {
    throw new Error("OpenCode server authentication sidecar is malformed.");
  }
  return { username: value.username, password: value.password };
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

function parseConfiguredModel(config: JsonRecord): string | null {
  const model = typeof config.model === "string" ? config.model : "";
  const prefix = `${PROVIDER_ID}/`;
  return model.startsWith(prefix) && model.length > prefix.length ? model.slice(prefix.length) : null;
}

export const openModelProviderAdapter = new OpenModelProviderAdapter();
