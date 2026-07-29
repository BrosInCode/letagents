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
  assistantFor,
  eventReferencesSession,
  messageCompleted,
  messageText,
  OpenCodeServerClient,
  record,
  type JsonRecord,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodeRuntimeAuth,
} from "./opencode-server-client.js";

const START_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 30 * 60_000;
const NO_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

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

async function nextEventBefore(
  events: AsyncIterator<OpenCodeEvent>,
  deadline: number,
): Promise<IteratorResult<OpenCodeEvent>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("OpenCode bounded turn timed out.");
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      events.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OpenCode bounded turn timed out.")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    const auth: OpenCodeRuntimeAuth = {
      username: OPENCODE_SERVER_USERNAME,
      password: randomBytes(32).toString("base64url"),
    };
    await writeFile(authPath, `${JSON.stringify(auth)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600);
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
    const env = minimalOpenCodeEnvironment(process.env, {
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: openCodeAuthContent(credential.apiKey),
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
    const client = new OpenCodeServerClient(url, auth, this.deps.fetch);
    const ready = await this.waitForHealth(client, launch.exited);
    if (!ready) {
      await terminateFreshLaunch({ pid, exited: launch.exited }, this.deps, this.stopGraceMs);
      throw new Error("Timed out waiting for the supervised OpenCode server.");
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
    const handle = new OpenModelHandle(
      req.workAttemptId,
      pid,
      sessionId,
      connection,
      client,
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
    return handle;
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    // Load-bearing two-writer invariant: attach() may return null when process
    // identity or local control authentication is unreadable. resume() must
    // never interpret that uncertainty as permission to spawn a replacement.
    // Only a terminal identity proves that the saved writer is gone.
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
    const messages = await handle.client.messages(handle.providerContinuationId);
    const assistant = assistantFor(messages, turnId);
    if (assistant && messageCompleted(assistant)) return "terminal";
    const status = await handle.client.status(handle.providerContinuationId);
    return status === "busy" || assistant ? "active" : "unknown";
  }

  async controlTurn(rawHandle: ProviderHandle): Promise<ProviderTurnControlResult> {
    const handle = this.required(rawHandle);
    await handle.client.abort(handle.providerContinuationId);
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
      const sessions = await handle.client.listSessions();
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
      const sessions = await handle.client.listSessions();
      if (sessions.some((session) => session.id === request.expectedProviderContinuationId)) {
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

  private async awaitExactTurn(
    handle: OpenModelHandle,
    turnId: string,
    signal?: AbortSignal,
    recovery = false,
  ): Promise<ProviderRoomTurnResult> {
    const deadline = Date.now() + this.turnTimeoutMs;
    const emittedLengths = new Map<string, number>();
    const partTypes = new Map<string, string>();
    const controller = new AbortController();
    const detach = (): void => controller.abort();
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) controller.abort();
    const events = handle.client.events(controller.signal)[Symbol.asyncIterator]();
    let assistantId: string | null = null;
    const snapshot = async (): Promise<ProviderRoomTurnResult | null> => {
      const assistant = assistantFor(
        await handle.client.messages(handle.providerContinuationId),
        turnId,
      );
      const info = record(assistant?.info);
      if (typeof info?.id === "string") assistantId = info.id;
      this.emitMessageEvidence(handle, assistant, emittedLengths);
      return assistant && messageCompleted(assistant)
        ? classifyTurn(turnId, messageText(assistant))
        : null;
    };

    try {
      // Opening the SSE stream before the snapshot closes the completion race:
      // history repairs anything that happened before subscription, then every
      // later transition is event-driven rather than O(history) polling.
      const connected = await nextEventBefore(events, deadline);
      if (connected.done) throw new Error("OpenCode event stream ended before turn observation.");
      const initial = await snapshot();
      if (initial) return initial;
      if (recovery
        && await handle.client.status(handle.providerContinuationId) !== "busy") {
        return { turnId, outcome: "unreadable", text: null, evidence: "none" };
      }

      while (Date.now() < deadline) {
        if (controller.signal.aborted) {
          throw new Error("OpenCode turn observation detached.");
        }
        const next = await nextEventBefore(events, deadline);
        if (next.done) {
          const repaired = await snapshot();
          if (repaired) return repaired;
          throw new Error("OpenCode event stream ended before the bounded turn completed.");
        }
        const event = next.value;
        const properties = record(event.properties);
        const info = record(properties?.info);
        if (info?.role === "assistant" && info.parentID === turnId
          && typeof info.id === "string") {
          assistantId = info.id;
        }
        if (event.type === "message.part.updated") {
          const part = record(properties?.part);
          if (assistantId && part?.messageID === assistantId) {
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
          && assistantId
          && properties?.messageID === assistantId
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
        const terminalSignal = event.type === "session.idle"
          || event.type === "session.error"
          || (event.type === "message.updated" && messageCompleted({ info: info ?? undefined }));
        if (!terminalSignal) continue;
        const result = await snapshot();
        if (result) return result;
        if (event.type === "session.idle" || event.type === "session.error") {
          return { turnId, outcome: "unreadable", text: null, evidence: "none" };
        }
      }
      throw new Error("OpenCode bounded turn timed out.");
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
      if (await client.health()) return true;
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

async function readRuntimeAuth(path: string): Promise<OpenCodeRuntimeAuth> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) {
    throw new Error("OpenCode server authentication sidecar is invalid.");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<OpenCodeRuntimeAuth>;
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

export const openModelProviderAdapter = new OpenModelProviderAdapter();
