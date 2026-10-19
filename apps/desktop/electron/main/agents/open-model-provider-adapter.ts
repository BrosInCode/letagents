import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NO_REPLY_FAILURE } from "../../../../../shared/room-turn-no-reply.mjs";
import { LETAGENTS_NPX_ARGS } from "../mcp-config.js";
import { ProviderContinuationMissingError, PROCESS_ENDED_DURING_TURN, sameProviderConnectionIdentity, synthesizeTerminalPayload, type ProviderActivityEvent, type ProviderAdapter, type ProviderAdapterCapabilities, type ProviderAttachTerminal, type ProviderConnectionRef, type ProviderContinuationRef, type ProviderContinuationRepairRequest, type ProviderContinuationRepairResult, type ProviderHandle, type ProviderObservedState, type ProviderRoomTurnOptions, type ProviderRoomTurnRecoveryRequest, type ProviderRoomTurnRequest, type RoomTurnImageDelivery, type ProviderRoomTurnResult, type ProviderSpawnRequest, type ProviderStopOptions, type ProviderStreamEvent, type ProviderTerminalPayload, ProviderTurnControlError, type ProviderTurnControlOptions, type ProviderTurnControlResult } from "./provider-adapter.js";
import { attestProviderSpawnPolicy } from "./provider-spawn-configuration.js";
import { DEFAULT_STOP_GRACE_MS, delay, redactCredentialText, safeStreamPayload, sameProcessBirthIdentity, terminateFreshLaunch, type ProviderProcessExit } from "./provider-evidence.js";
import { credentialBoundaryPluginSource, minimalOpenCodeEnvironment, OPEN_MODEL_OPENCODE_PROVIDER_ID, OPENCODE_SERVER_USERNAME, openCodeAuthContent, openCodeConfig, parseConfiguredOpenModel, parseConfiguredOpenModelImageInput, seedOpenCodeConfigHome, shieldOwnerInstructions, supervisedOpenCodeMcpEnvironment, workspaceOpenCodeEnvironment, supervisedOpenCodePermissionProfileId } from "./opencode-launch-contract.js";
import { managedCommitEnvironmentFor } from "./managed-agent-commit-identity.js";
import { resolveOpenModelLimits } from "./open-model-limits.js";
import { OPENCODE_RUNTIME_VERSION, resolveOpenCodeBinary } from "./opencode-runtime.js";
import { nativeExecutionId, nativeLifecycleCheckpoint, ProviderExecutionObserver } from "./provider-execution-observer.js";
import type { ControlProbeResult, HardControlEvidence, NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription, TurnOutcome } from "../../../shared/execution-protocol.js";
import { assistantsFor, eventReferencesSession, finalAssistantFor, messageCompleted, messageError, messageFinishReason, messageText, mintNativeUserMessageId, nativelyOrderedMessageId, OpenCodePermissionReplyError, OpenCodeServerClient, parseOpenCodePermissionEvent, record, turnUserMessageIds, type JsonRecord, type OpenCodeEvent, type OpenCodeMessage, type OpenCodePart, type OpenCodePermissionRequest, type OpenCodePermissionTurnCorrelation, type OpenCodeRuntimeAuth } from "./opencode-server-client.js";
import { CAPABILITIES, MAX_ASSISTANT_STEPS, type OpenCodePermissionObservation, type OpenModelProviderAdapterDependencies, type OpenModelProviderAdapterOptions, SESSION_ORDERING_SCAN_LIMIT, START_TIMEOUT_MS, TURN_CONTROL_TIMEOUT_MS, TURN_TIMEOUT_MS } from "./open-model/types.js";
import { MAX_CONSECUTIVE_DENIED_STEPS, TOOL_CALLS_UNFINISHED, type TurnStep, boundedRoomTurnPrompt, classifyTurn, deniedToolCall, deniedToolState, roomTurnImageParts, unansweredCompletionReason, unfinishedToolCalls } from "./open-model/turn-results.js";
import { OPEN_MODEL_PROVIDER_RETRY_METHOD, OpenCodeBoundedTurnError, type OpenCodeRetryStatus, OpenCodeRuntimeGoneError, OpenCodeStartTimeoutError, OpenCodeTerminalTurnError, openCodeRetryStatus, openModelProviderRetrySummary, safeProviderErrorMessage } from "./open-model/errors.js";
import { type OpenCodeRuntimeControl, defaultDependencies, nextEventBefore, readRuntimeControl, resolveBeforeDeadline, safeRuntimeId, terminalFromExit, withRuntimeLaunchOwnership, writeRuntimeControl } from "./open-model/runtime-launch.js";
export type { OpenModelProviderAdapterDependencies } from "./open-model/types.js";
export type { OpenModelProviderAdapterOptions } from "./open-model/types.js";
export type { OpenCodePermissionObservation } from "./open-model/types.js";
export { OPEN_MODEL_PROVIDER_RETRY_METHOD } from "./open-model/errors.js";
export { openModelProviderRetrySummary } from "./open-model/errors.js";
export { OpenCodeStartTimeoutError } from "./open-model/errors.js";
export { OpenCodeRuntimeGoneError } from "./open-model/errors.js";


class OpenModelHandle implements ProviderHandle {
  private observed: ProviderObservedState;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  sequence = 0;
  terminal: ProviderTerminalPayload | null = null;
  activeRoomTurnId: string | null = null;
  compaction: { messageId: string; startedAt: string } | null = null;
  /** True once every user message in the session is known to use OpenCode's ascending ID scheme. */
  nativeOrderingVerified = false;
  readonly execution: ProviderExecutionObserver;
  controlLoss: HardControlEvidence | null = null;
  observedTurn: { id: string; terminal: TurnOutcome | "lost" | null } | null = null;
  launchNotices: readonly string[] = [];
  /** This runtime was started with image input for its model, so it takes the activating message's images. */
  imageInput = false;

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
  protected readonly binary: string;
  protected readonly deps: OpenModelProviderAdapterDependencies;
  protected readonly startTimeoutMs: number;
  protected readonly turnTimeoutMs: number;
  protected readonly turnControlTimeoutMs: number;
  protected readonly maxAssistantSteps: number;
  protected readonly stopGraceMs: number;
  protected readonly runtimeRoot: string;
  protected readonly handles = new Map<string, OpenModelHandle>();

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

  compactionProgress(workAttemptId: string): { state: "compacting"; startedAt: string } | null {
    const handle = this.handles.get(workAttemptId);
    return handle?.activeRoomTurnId && !handle.terminal && handle.compaction
      ? { state: "compacting", startedAt: handle.compaction.startedAt } : null;
  }

  protected observeCompaction(handle: OpenModelHandle, info: JsonRecord | null): void {
    if (!info || info.sessionID !== undefined && info.sessionID !== handle.providerContinuationId) return;
    const active = info.summary === true && typeof info.id === "string" && !messageCompleted({ info });
    const previous = handle.compaction;
    if (active) {
      const created = record(info.time)?.created;
      handle.compaction = { messageId: info.id as string, startedAt: previous && previous.messageId === info.id ? previous.startedAt
        : typeof created === "number" && Number.isFinite(created) && Math.abs(created) < 8.64e15 ? new Date(created).toISOString() : this.deps.now() };
    } else handle.compaction = null;
    if (Boolean(previous) === Boolean(handle.compaction)) return;
    this.emitStream(handle, { kind: "provider_event", method: "letagents/compaction",
      summary: active ? "Compacting conversation" : "Conversation compaction ended",
      payload: { state: active ? "compacting" : "ended" } });
  }

  protected async assertPriorStartupProcessGone(authPath: string): Promise<void> {
    let control: OpenCodeRuntimeControl;
    try {
      control = await readRuntimeControl(authPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (control.startupIntent) {
      throw new Error(
        "The previous OpenCode startup intent has no durable process identity; refusing to start a competing runtime. An operator must verify the prior runtime is gone before clearing the sidecar.",
      );
    }
    for (const process of [control.startupProcess, control.connection]) {
      if (!process) continue;
      const currentIdentity = this.deps.getProcessIdentity(process.pid);
      if (currentIdentity === null) continue;
      if (!process.processIdentity || currentIdentity === undefined) {
        throw new Error(
          "The previous OpenCode startup process identity could not be verified; refusing to start a competing runtime.",
        );
      }
      if (!sameProcessBirthIdentity(currentIdentity, process.processIdentity)) continue;
      throw new Error(
        "The previous OpenCode startup process is still running; refusing to start a competing runtime.",
      );
    }
  }

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
    const runtimeRoot = join(this.runtimeRoot, safeRuntimeId(req.workAttemptId));
    // The daemon singleton owns one provider router per live process. This
    // target-local queue therefore serializes every live admission for one
    // runtime path, while startupIntent remains the cross-process crash fence.
    return withRuntimeLaunchOwnership(runtimeRoot, () =>
      this.spawnWithRuntimeOwnership(req, lifecycleAuthorityMode, credential, runtimeRoot));
  }

  /**
   * A scratch workspace's repository keeps OpenCode from importing plugins
   * above it only if Git, run as OpenCode will run it, reads the repository.
   * This never fails the launch. A problem comes back as an owner-visible
   * launch notice, which the daemon records in the agent's activity.
   */
  protected async checkScratchWorkspaceBoundary(
    workspace: string,
    runtimeRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const problem = await this.deps.probeGit(workspace, env)
      .catch((error: unknown) => `git check failed: ${String(error)}`);
    if (!problem) return null;
    console.warn("[open_model_workspace_boundary]", JSON.stringify({ runtimeRoot, detail: problem }));
    return `Plugin boundary not in effect: ${problem}. OpenCode cannot see this room's workspace repository, so plugins in folders above the workspace can load into it.`;
  }

  protected async spawnWithRuntimeOwnership(
    req: ProviderSpawnRequest,
    lifecycleAuthorityMode: NonNullable<ProviderSpawnRequest["lifecycleAuthorityMode"]>,
    credential: NonNullable<ProviderSpawnRequest["providerCredential"]>,
    runtimeRoot: string,
  ): Promise<ProviderHandle> {
    const appliedConfigurationRevision = attestProviderSpawnPolicy("open-model", req);
    void appliedConfigurationRevision;
    // Refused before anything is written or launched.
    const workspaceEnvironment = workspaceOpenCodeEnvironment(req.workspaceKind);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(runtimeRoot, 0o700);
    const authPath = join(runtimeRoot, "server-auth.json");
    await this.assertPriorStartupProcessGone(authPath);
    const auth: OpenCodeRuntimeAuth = {
      username: OPENCODE_SERVER_USERNAME,
      password: randomBytes(32).toString("base64url"),
    };
    const initialControl: OpenCodeRuntimeControl = { ...auth, lifecycleAuthorityMode };
    await writeRuntimeControl(authPath, initialControl);
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
    const limits = await resolveOpenModelLimits(credential, this.deps.fetch);
    const config = openCodeConfig({
      model: credential.model,
      limits,
      baseUrl: credential.baseUrl,
      pluginUrl: pathToFileURL(pluginPath).href,
      cwd: req.cwd,
      mcpCommand,
      mcpEnvironment,
      permissionProfileId: supervisedOpenCodePermissionProfileId(req.permissionProfileId),
      imageInput: req.imageInput === true,
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
    // The shared cache cannot cover OpenCode's plugin SDK, which installs
    // into the isolated config directory rather than the cache.
    const configHome = join(runtimeRoot, "config");
    // The seed only saves time. A directory it cannot write leaves OpenCode
    // on its own install path, which must not block the launch.
    await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION).catch(() => undefined);
    // This one is not best-effort: without it the owner's personal
    // instructions reach the agent, so a launch that cannot write it fails.
    await shieldOwnerInstructions(configHome);
    const env = minimalOpenCodeEnvironment(process.env, {
      // Resolve gh's config before isolating OpenCode's XDG directories. Keep
      // the existing credential store location, never copy its credentials.
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || (process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "gh")
        : process.platform === "win32" && process.env.APPDATA
          ? join(process.env.APPDATA, "GitHub CLI")
          : join(process.env.HOME || homedir(), ".config", "gh")),
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: openCodeAuthContent(credential.apiKey),
      XDG_DATA_HOME: join(runtimeRoot, "data"),
      XDG_CACHE_HOME: sharedCacheRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(runtimeRoot, "state"),
      BUN_INSTALL_CACHE_DIR: join(sharedCacheRoot, "bun-install"),
      ...workspaceEnvironment,
    }, await managedCommitEnvironmentFor(req));
    const launchNotice = req.workspaceKind === "room_scratch"
      ? await this.checkScratchWorkspaceBoundary(req.cwd, runtimeRoot, env)
      : null;
    const intentControl: OpenCodeRuntimeControl = {
      ...initialControl,
      startupIntent: { url },
    };
    await writeRuntimeControl(authPath, intentControl);
    const launch = this.deps.launch({
      binary: this.binary,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: req.cwd,
      env,
    });
    if (launch.child.pid === undefined || launch.child.pid === null) {
      await launch.exited;
      try {
        const currentControl = await readRuntimeControl(authPath);
        if (currentControl.username !== intentControl.username
          || currentControl.password !== intentControl.password
          || currentControl.lifecycleAuthorityMode !== intentControl.lifecycleAuthorityMode
          || currentControl.startupIntent?.url !== intentControl.startupIntent?.url
          || currentControl.startupProcess
          || currentControl.connection) {
          throw new Error("The durable startup intent no longer matches this launch.");
        }
        await writeRuntimeControl(authPath, initialControl);
      } catch (error) {
        throw new Error(
          "OpenCode launch failed without a process id, but its startup intent could not be safely cleared; automatic recovery remains blocked.",
          { cause: error },
        );
      }
      throw new Error("OpenCode launch did not expose a process id.");
    }
    const pid = launch.child.pid;
    await writeRuntimeControl(authPath, {
      ...auth,
      lifecycleAuthorityMode,
      startupProcess: { url, pid, processIdentity: null },
    });
    const identity = this.deps.getProcessIdentity(pid);
    if (!identity) {
      throw new Error("OpenCode process identity could not be verified.");
    }
    const client = new OpenCodeServerClient(url, auth, this.deps.fetch);
    let sessionId: string;
    let connection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>;
    // One budget covers the whole launch. The first session bootstraps the
    // OpenCode instance, so it gets whatever the health wait left over rather
    // than the shorter steady-state control deadline.
    const launchDeadline = Date.now() + this.startTimeoutMs;
    let phase: "health" | "session" = "health";
    try {
      await writeRuntimeControl(authPath, {
        ...auth,
        lifecycleAuthorityMode,
        startupProcess: { url, pid, processIdentity: identity },
      });
      const ready = await this.waitForHealth(client, launch.exited, launchDeadline);
      if (!ready) throw new OpenCodeStartTimeoutError("health");
      phase = "session";
      const session = await client.createSession(
        req.agentDisplayName?.trim() || "LetAgents Open Model",
        AbortSignal.timeout(Math.max(1, launchDeadline - Date.now())),
      );
      sessionId = typeof session.id === "string" ? session.id : "";
      if (!sessionId) {
        throw new Error("OpenCode did not return a session id.");
      }
      connection = {
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
    } catch (error) {
      await terminateFreshLaunch({ pid, exited: launch.exited, processIdentity: identity }, this.deps, this.stopGraceMs);
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new OpenCodeStartTimeoutError(phase);
      }
      throw error;
    }
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
    handle.imageInput = req.imageInput === true;
    if (launchNotice) handle.launchNotices = [launchNotice];
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
    // Death evidence does not depend on who holds lifecycle authority. Checking
    // it first lets the daemon settle a dead generation whose authority mode no
    // longer matches; otherwise it stays live with no handle and never recovers.
    const identity = this.deps.getProcessIdentity(connection.pid);
    if (identity === null || (typeof identity === "string" && !sameProcessBirthIdentity(identity, connection.processIdentity))) {
      const terminal = synthesizeTerminalPayload({
        exitCode: null, signal: null, providerContinuationId: ref.providerContinuationId,
        endedAt: this.deps.now(),
      });
      // A cached handle may not have observed its own exit yet; finishing it
      // emits the lost turn/control events its observers are waiting for.
      const stale = this.handles.get(ref.workAttemptId);
      if (stale) this.finish(stale, terminal, true);
      return { state: "terminal", terminal } satisfies ProviderAttachTerminal;
    }
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
    const runtimeConfig = await client.config();
    const configuredModel = parseConfiguredOpenModel(runtimeConfig);
    if (!configuredModel) throw new Error("The attached OpenCode runtime has no configured Open Model.");
    // OpenCode looks for its instruction files again on every turn, so a
    // runtime launched before the shield existed gains it here. Unlike a
    // launch, this is best-effort: the runtime is already running, and
    // refusing to attach would only take a working agent away. The sidecar
    // path comes from a persisted reference, so nothing is written unless it
    // is this adapter's own directory for the work attempt.
    const ownRuntimeRoot = join(this.runtimeRoot, safeRuntimeId(ref.workAttemptId));
    if (connection.serverAuthPath === join(ownRuntimeRoot, "server-auth.json")) {
      await shieldOwnerInstructions(join(ownRuntimeRoot, "config")).catch(() => undefined);
    }
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
    // The runtime keeps the configuration it started with, whatever was saved since.
    handle.imageInput = parseConfiguredOpenModelImageInput(runtimeConfig);
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

  protected async resolveAttachConnection(ref: ProviderContinuationRef): Promise<{
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
    // Terminal identity is proof the process is gone: the daemon must recover
    // by starting a fresh runtime, not retry resume against a corpse. This is
    // checked before the authority comparison so a dead runtime born under an
    // older mode is replaced instead of refused on every attempt.
    if (attached && "state" in attached) throw new OpenCodeRuntimeGoneError();
    if ((ref.lifecycleAuthorityMode ?? "typed_shadow") !== (req.lifecycleAuthorityMode ?? "typed_shadow")) {
      throw new Error("Open Model resume lifecycle authority does not match the frozen provider birth.");
    }
    if (attached) return attached;
    throw new Error("The saved OpenCode process could not be authenticated; refusing to start a competing runtime.");
  }

  async poke(): Promise<void> {
    throw new Error("Open Model does not support mid-turn message injection.");
  }

  /** Only a runtime started with image input for its model takes images. */
  roomTurnImageDelivery(rawHandle: ProviderHandle): RoomTurnImageDelivery {
    try { return this.required(rawHandle).imageInput ? "memory" : null; } catch { return null; }
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
      parts: [{ type: "text", text: boundedRoomTurnPrompt(request) }, ...(handle.imageInput ? roomTurnImageParts(request) : [])],
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
      if (error instanceof OpenCodeTerminalTurnError && error.terminalResult) {
        try {
          await options.checkpointTerminalResult?.(error.terminalResult);
        } finally {
          if (handle.activeRoomTurnId === turnId) {
            handle.activeRoomTurnId = null;
            handle.setState("idle");
          }
        }
        throw error;
      }
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
    if (request.originProcessEnded && request.providerContinuationId
      && request.providerContinuationId !== handle.providerContinuationId) {
      const result = await this.readEarlierSessionTurn(handle, request.providerContinuationId, request.providerTurnId);
      await options.checkpointTerminalResult?.(result);
      return result;
    }
    handle.activeRoomTurnId = request.providerTurnId;
    if (handle.observedTurn?.id !== request.providerTurnId) handle.observedTurn = { id: request.providerTurnId, terminal: null };
    this.emitTurnActive(handle, request.providerTurnId);
    try {
      const result = await this.awaitExactTurn(handle, request.providerTurnId, options.detachSignal, true, request.recordEnding === true);
      await options.checkpointTerminalResult?.(result);
      handle.activeRoomTurnId = null;
      handle.setState("idle");
      return result;
    } catch (error) {
      if (error instanceof OpenCodeTerminalTurnError && error.terminalResult) {
        try {
          await options.checkpointTerminalResult?.(error.terminalResult);
        } finally {
          if (handle.activeRoomTurnId === request.providerTurnId) {
            handle.activeRoomTurnId = null;
            handle.setState("idle");
          }
        }
        throw error;
      }
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

  /**
   * A turn of a session that an earlier process of this agent ran. Every
   * process starts a session of its own, and the sessions of the processes
   * before it stay in the agent's runtime directory, where this one can read
   * them. The process that ran the turn has ended, so the turn is over: this
   * only reads what its session kept of it. An answer is the answer, an
   * error is the failure, and a turn that the session shows without either
   * was cut off by the exit. Nothing is recorded for the running session.
   */
  protected async readEarlierSessionTurn(handle: OpenModelHandle, sessionId: string, turnId: string): Promise<ProviderRoomTurnResult> {
    if (!nativeExecutionId(sessionId) || !nativeExecutionId(turnId)) {
      throw new Error("Open Model turn recovery requires an exact session and turn.");
    }
    const messages = await handle.client.messages(sessionId);
    const turnUserIds = turnUserMessageIds(messages, turnId);
    const finalAssistant = finalAssistantFor(messages, turnId, turnUserIds);
    const failure = safeProviderErrorMessage(finalAssistant);
    if (failure) {
      return { turnId, providerContinuationId: sessionId, outcome: "failed", text: null, evidence: "transcript", error: failure };
    }
    // A last step that called tools is not where the turn ends: it was to go
    // on with their results, and the process ended first. What the model said
    // before the calls is not an answer. Only a call that was refused ends
    // the turn there, as the live turn does, whatever was said before it. And
    // only the turn's last step can end it: a finished step with a later one
    // begun is half-way. A last step that ended without an answer (at the
    // output limit, filtered, or empty) says why, as the live turn does.
    const last = finalAssistant !== null && finalAssistant === assistantsFor(messages, turnId, turnUserIds).at(-1);
    const refused = !last ? null
      : messageFinishReason(finalAssistant) === "tool-calls" && deniedToolCall(finalAssistant) ? NO_REPLY_FAILURE.deniedTool
        : unansweredCompletionReason(finalAssistant);
    if (refused) return { turnId, providerContinuationId: sessionId, outcome: "failed", text: null, evidence: "transcript", error: refused };
    const answered = last && messageCompleted(finalAssistant) && messageFinishReason(finalAssistant) !== "tool-calls"
      ? classifyTurn(turnId, messageText(finalAssistant)) : null;
    if (answered && answered.outcome !== "unreadable") return answered;
    return { turnId, providerContinuationId: sessionId, outcome: "interrupted", text: null, evidence: "transcript",
      error: PROCESS_ENDED_DURING_TURN };
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

  /**
   * Read-only native linkage; pending-request and durable admission checks remain separate.
   * `roomTurnId` is the caller's durable turn; it is used only when the transcript proves it.
   */
  async correlatePermissionTurn(
    rawHandle: ProviderHandle,
    expectedRequest: OpenCodePermissionRequest,
    options: { roomTurnId?: string } = {},
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
      const result = await handle.client.correlatePermissionTurn(sessionId, expectedRequest, assertCurrentInstance,
        options.roomTurnId);
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

  protected controlProof(handle: OpenModelHandle): ControlProbeResult | null {
    if (handle.controlLoss) return { state: "lost", controlEvidence: handle.controlLoss };
    const identity = this.deps.getProcessIdentity(handle.pid);
    if (identity === undefined) return { state: "degraded" };
    if (identity === null) return { state: "lost", controlEvidence: "process_exit" };
    return sameProcessBirthIdentity(identity, handle.providerConnection.processIdentity!)
      ? null : { state: "lost", controlEvidence: "process_birth_changed" };
  }

  protected emitExecution(handle: OpenModelHandle, fact: NativeExecutionFact): void {
    handle.execution.emit(fact, handle.providerConnection.processIdentity ?? undefined,
      handle.providerConnection.pid ?? undefined);
  }

  protected emitRuntimeReady(handle: OpenModelHandle): void {
    this.emitExecution(handle, {
      domain: "runtime",
      kind: "state_changed",
      state: "ready",
      sideEffects: "none",
    });
  }

  protected emitTurnActive(handle: OpenModelHandle, turnId: string): void {
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

  protected emitTurnTerminal(handle: OpenModelHandle, turnId: string, outcome: TurnOutcome): void {
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

  protected emitLifecycleProjection(
    handle: OpenModelHandle,
    method: "turn/started" | "turn/completed",
    nativeEventId: string,
    nativeLifecyclePhase: "turn_active" | "turn_terminal",
  ): void {
    this.emitStream(handle, { kind: "turn_lifecycle", method, summary: null, payload: null,
      nativeEventId, nativeLifecyclePhase, lifecycleProjectionOnly: true });
  }

  protected required(handle: ProviderHandle): OpenModelHandle {
    const current = this.handles.get(handle.workAttemptId);
    if (!current || current !== handle) throw new Error("Open Model handle is stale or foreign.");
    return current;
  }

  protected withContinuation(handle: OpenModelHandle, continuationId: string): OpenModelHandle {
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
  protected async assertNativelyOrderedSession(handle: OpenModelHandle): Promise<void> {
    if (handle.nativeOrderingVerified) return;
    if (!await this.sessionNativelyOrdered(handle.client, handle.providerContinuationId)) {
      throw new ProviderContinuationMissingError(handle.providerContinuationId);
    }
    handle.nativeOrderingVerified = true;
  }

  protected async sessionNativelyOrdered(
    client: OpenCodeServerClient,
    sessionId: string,
  ): Promise<boolean> {
    const messages = await client.messages(sessionId, SESSION_ORDERING_SCAN_LIMIT);
    return messages.every((message) => {
      const info = record(message.info);
      return info?.role !== "user" || nativelyOrderedMessageId(info.id);
    });
  }

  protected async awaitExactTurn(
    handle: OpenModelHandle,
    turnId: string,
    signal?: AbortSignal,
    recovery = false,
    recordEnding = false,
  ): Promise<ProviderRoomTurnResult> {
    const deadline = Date.now() + this.turnTimeoutMs;
    const softBounds = handle.lifecycleAuthorityMode === "typed";
    let durationAttentionSent = false;
    let stepAttentionSent = false;
    const emittedLengths = new Map<string, number>();
    const partTypes = new Map<string, string>();
    // callID -> last-emitted tool status. message.part.updated re-sends the
    // full tool part on every pending→running→completed/error transition, and
    // snapshot() re-emits history on reconnect, so dedup by (callID, status).
    const toolStatuses = new Map<string, string>();
    const assistantIds = new Set<string>();
    const typedAssistantIds = new Set<string>();
    // The prompt, plus any message OpenCode added while compacting this turn;
    // the steps after a compaction answer those, not the prompt.
    const turnUserIds = new Set([turnId]);
    const reexaminedAssistantIds = new Set<string>();
    // A compaction summary is OpenCode's own record, not the agent's answer.
    const summaryIds = new Set<string>();
    // The turn's steps (compaction summaries aside), for the denial bound.
    const steps = new Map<string, TurnStep>();
    const noteStep = (info: JsonRecord | null): void => {
      if (info?.role !== "assistant" || info.summary === true || typeof info.id !== "string") return;
      const step = steps.get(info.id)
        ?? { created: Number.MAX_SAFE_INTEGER, completed: false, aborted: false, text: false, tools: new Map() };
      const time = record(info.time);
      if (typeof time?.created === "number") step.created = time.created;
      if (typeof time?.completed === "number" || info.error) step.completed = true;
      if (record(info.error)?.name === "MessageAbortedError") step.aborted = true;
      steps.set(info.id, step);
    };
    const noteStepPart = (messageId: string, part: JsonRecord | null): void => {
      const step = steps.get(messageId);
      if (!step || !part) return;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) step.text = true;
      const callId = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : null;
      if (part.type !== "tool" || !callId) return;
      const state = record(part.state);
      step.tools.set(callId, state?.status === "completed" || state?.status === "error" ? deniedToolState(state) : null);
    };
    const keepsRetryingDeniedCalls = (): boolean => {
      const ordered = [...steps.entries()]
        .sort(([leftId, left], [rightId, right]) => left.created - right.created || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0))
        .map(([, step]) => step);
      let index = ordered.length - 1;
      const newest = ordered[index];
      // The step after the denied ones may still be starting, or may have
      // been ended by an abort. Once it writes text or runs a tool, the model
      // has moved on from what it was refused.
      if (newest && (!newest.completed || newest.aborted || (!newest.text && newest.tools.size === 0))) {
        if (newest.text || [...newest.tools.values()].some((denied) => denied === false)) return false;
        index -= 1;
      }
      let deniedSteps = 0;
      for (; index >= 0; index -= 1) {
        const step = ordered[index]!;
        const outcomes = [...step.tools.values()];
        if (!step.completed || !outcomes.length || !outcomes.every((denied) => denied === true)) break;
        deniedSteps += 1;
      }
      return deniedSteps >= MAX_CONSECUTIVE_DENIED_STEPS;
    };
    // Attempt numbers restart when a later step of the same turn fails, so
    // the scheduled time is part of what makes a retry distinct.
    const retriesNotified = new Set<string>();
    const controller = new AbortController();
    const detach = (): void => controller.abort();
    signal?.addEventListener("abort", detach, { once: true });
    if (signal?.aborted) controller.abort();
    const events = handle.client.events(controller.signal)[Symbol.asyncIterator]();
    const emitAttention = (kind: "duration_guardrail" | "step_guardrail"): void => {
      this.emitStream(handle, {
        kind: "provider_event",
        method: "letagents/turnAttention",
        summary: kind === "duration_guardrail"
          ? "Open Model is still working past its duration guardrail."
          : "Open Model is still working past its step guardrail.",
        payload: kind === "duration_guardrail"
          ? { kind, turnId, limitMs: this.turnTimeoutMs }
          : { kind, turnId, limit: this.maxAssistantSteps },
      });
    };
    const enforceStepBound = (assistantCount: number): void => {
      if (assistantCount <= this.maxAssistantSteps) return;
      if (!softBounds) {
        throw new OpenCodeBoundedTurnError(
          `OpenCode exceeded the bounded turn limit of ${this.maxAssistantSteps} assistant steps.`,
        );
      }
      if (!stepAttentionSent) {
        stepAttentionSent = true;
        emitAttention("step_guardrail");
      }
    };
    const nextObservedEvent = async (): Promise<IteratorResult<OpenCodeEvent>> => {
      if (!softBounds) return nextEventBefore(events, deadline);
      if (durationAttentionSent) return events.next();
      const pending = events.next();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        durationAttentionSent = true;
        emitAttention("duration_guardrail");
        return pending;
      }
      let timeout: NodeJS.Timeout | undefined;
      try {
        const observed = await Promise.race([
          pending.then((value) => ({ kind: "event" as const, value })),
          new Promise<{ kind: "attention" }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "attention" }), remainingMs);
          }),
        ]);
        if (observed.kind === "event") return observed.value;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      durationAttentionSent = true;
      emitAttention("duration_guardrail");
      return pending;
    };
    const snapshot = async (): Promise<{
      assistantCount: number;
      result: ProviderRoomTurnResult | null;
      terminalOutcome: TurnOutcome | null;
      endedOutcome: TurnOutcome | null;
    }> => {
      const messages = await handle.client.messages(
        handle.providerContinuationId,
        Math.max(64, this.maxAssistantSteps + 1),
      );
      for (const id of turnUserMessageIds(messages, turnId)) turnUserIds.add(id);
      const assistants = assistantsFor(messages, turnId, turnUserIds);
      for (const assistant of assistants) {
        const info = record(assistant.info);
        if (typeof info?.id === "string") assistantIds.add(info.id);
        if (info?.summary === true && typeof info.id === "string") summaryIds.add(info.id);
        const exactSession = info?.sessionID === undefined || info.sessionID === handle.providerContinuationId;
        if (exactSession && typeof info?.id === "string") typedAssistantIds.add(info.id);
        if (info?.summary === true) continue;
        noteStep(info);
        for (const part of assistant.parts ?? []) if (typeof info?.id === "string") noteStepPart(info.id, part);
        this.emitMessageEvidence(handle, assistant, emittedLengths, toolStatuses,
          exactSession ? turnId : undefined);
      }
      this.observeCompaction(handle, record(assistants.at(-1)?.info));
      enforceStepBound(assistants.length);
      const finalAssistant = finalAssistantFor(messages, turnId, turnUserIds);
      const finalInfo = record(finalAssistant?.info);
      const exactSession = finalInfo?.sessionID === undefined || finalInfo.sessionID === handle.providerContinuationId;
      // A turn ended for retrying denied calls reads back as that, not as the
      // abort that ended it.
      const deniedSettlement = exactSession && keepsRetryingDeniedCalls();
      const terminalError = deniedSettlement && messageError(finalAssistant)?.name === "MessageAbortedError"
        ? null : safeProviderErrorMessage(finalAssistant);
      if (terminalError) {
        const terminalResult = exactSession ? {
          turnId,
          providerContinuationId: handle.providerContinuationId,
          outcome: "failed" as const,
          text: null,
          evidence: "transcript" as const,
          error: terminalError,
        } : null;
        if (terminalResult) this.emitTurnTerminal(handle, turnId, "failed");
        throw new OpenCodeTerminalTurnError(terminalError, terminalResult);
      }
      const completed = finalAssistant && messageCompleted(finalAssistant) ? finalAssistant : null;
      // Only the turn's last step can settle it; an earlier finished step
      // with a later step still unfinished is not the turn's answer.
      const unanswered = deniedSettlement ? NO_REPLY_FAILURE.deniedTool
        : completed && exactSession && completed === assistants.at(-1)
          ? unansweredCompletionReason(completed)
          : null;
      const result: ProviderRoomTurnResult | null = !completed ? null
        : unanswered ? {
          turnId,
          providerContinuationId: handle.providerContinuationId,
          outcome: "failed",
          text: null,
          evidence: "transcript",
          error: unanswered,
        }
        // At the session's boundary, a last step whose tool calls never
        // returned leaves the turn without an answer; its text came before them.
        : unfinishedToolCalls(completed) ? {
          turnId,
          providerContinuationId: handle.providerContinuationId,
          outcome: "interrupted",
          text: null,
          evidence: "transcript",
          error: TOOL_CALLS_UNFINISHED,
        }
        : classifyTurn(turnId, messageText(completed));
      const endedOutcome: TurnOutcome | null = exactSession && result
        ? result.outcome === "unreadable" || result.outcome === "failed" || result.outcome === "interrupted" ? result.outcome : "completed" : null;
      return {
        assistantCount: assistants.length,
        result,
        // A step settled by a denied tool call is the turn's last, despite its finish reason.
        terminalOutcome: messageFinishReason(finalAssistant) !== "tool-calls" || unanswered ? endedOutcome : null,
        endedOutcome,
      };
    };
    const resultAtSessionBoundary = (
      observed: Awaited<ReturnType<typeof snapshot>>,
      ended = false,
    ): ProviderRoomTurnResult => {
      // Legacy session-status fallbacks remain unchanged, but typed authority
      // must not invent a native terminal from a missing/busy status entry.
      // A last step that ended on tool calls is the turn's ending only when
      // it is known to be: OpenCode reported this session idle, or the daemon
      // re-reads a turn its record still holds open. Left open there, the
      // turn refuses the agent's next one and stops its record.
      const outcome = observed.terminalOutcome ?? (ended ? observed.endedOutcome : null);
      if (outcome) this.emitTurnTerminal(handle, turnId, outcome);
      return observed.result ?? { turnId, outcome: "unreadable", text: null, evidence: "none" };
    };

    try {
      // Opening the SSE stream before the snapshot closes the completion race:
      // history repairs anything that happened before subscription, then every
      // later transition is event-driven rather than O(history) polling.
      const connected = await nextObservedEvent();
      if (connected.done) throw new Error("OpenCode event stream ended before turn observation.");
      const initial = await snapshot();
      if (await handle.client.status(handle.providerContinuationId) !== "busy"
        && (recovery || initial.assistantCount > 0)) {
        return resultAtSessionBoundary(initial, recordEnding);
      }
      if (keepsRetryingDeniedCalls()) return await this.endDeniedTurn(handle, turnId);

      while (softBounds || Date.now() < deadline) {
        if (controller.signal.aborted) {
          throw new Error("OpenCode turn observation detached.");
        }
        const next = await nextObservedEvent();
        if (next.done) {
          const repaired = await snapshot();
          if (await handle.client.status(handle.providerContinuationId) !== "busy") {
            return resultAtSessionBoundary(repaired, recordEnding);
          }
          throw new Error("OpenCode event stream ended before the bounded turn completed.");
        }
        const event = next.value;
        const properties = record(event.properties);
        const info = record(properties?.info);
        if (info?.role === "assistant" && typeof info.parentID === "string" && typeof info.id === "string"
          && !turnUserIds.has(info.parentID) && info.sessionID === handle.providerContinuationId
          && !reexaminedAssistantIds.has(info.id)) {
          // A step in this session that answers another message: after a
          // compaction, the transcript shows whether it is still this turn.
          reexaminedAssistantIds.add(info.id);
          await snapshot();
        }
        if (info?.role === "assistant" && typeof info.parentID === "string" && turnUserIds.has(info.parentID)
          && typeof info.id === "string") {
          assistantIds.add(info.id);
          if (info.summary === true) summaryIds.add(info.id);
          this.observeCompaction(handle, info);
          if (info.sessionID === handle.providerContinuationId) typedAssistantIds.add(info.id);
          noteStep(info);
          enforceStepBound(assistantIds.size);
        }
        if (event.type === "message.part.updated") {
          const part = record(properties?.part);
          if (typeof part?.messageID === "string" && assistantIds.has(part.messageID)
            && !summaryIds.has(part.messageID)) {
            if (typeof part.id === "string" && typeof part.type === "string") {
              partTypes.set(part.id, part.type);
            }
            noteStepPart(part.messageID, part);
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
          && !summaryIds.has(properties.messageID)
          && properties?.field === "text"
          && typeof properties.partID === "string"
          && typeof properties.delta === "string") {
          const partId = properties.partID;
          if (partTypes.get(partId) === "text") {
            const step = steps.get(properties.messageID);
            if (step) step.text = true;
          }
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
        // A step counts for the bound once it has ended, with every call it made.
        if (keepsRetryingDeniedCalls()) return await this.endDeniedTurn(handle, turnId);
        if (!eventReferencesSession(event, handle.providerContinuationId)) continue;
        if (event.type === "session.status") {
          const retry = openCodeRetryStatus(properties?.status);
          const retryKey = retry ? `${retry.attempt}:${retry.next ?? ""}` : null;
          if (retry && retryKey && !retriesNotified.has(retryKey)) {
            retriesNotified.add(retryKey);
            this.emitProviderRetry(handle, turnId, retry);
          }
          continue;
        }
        if (event.type === "session.idle") {
          return resultAtSessionBoundary(await snapshot(), true);
        }
        if (event.type === "session.compacted") {
          this.observeCompaction(handle, {});
          continue;
        }
        if (event.type === "session.error") {
          const error = record(properties?.error);
          if (error) {
            const summary = error.name === "ContextOverflowError"
              ? "Model context limit reached. OpenCode is recovering the conversation."
              : safeProviderErrorMessage({ info: { error } });
            this.emitStream(handle, { kind: "provider_event", method: "letagents/providerNotice",
              summary, payload: { kind: "provider_error" } });
          }
          await snapshot();
          // Context overflow is a recoverable OpenCode step: it emits session.error
          // before creating its compaction message. A busy session can still answer.
          if (await handle.client.status(handle.providerContinuationId) === "busy") continue;
          // Native errors can precede the failed assistant's durable update. An
          // earlier completed step is not evidence that this turn succeeded.
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
      this.observeCompaction(handle, {});
      controller.abort();
      signal?.removeEventListener("abort", detach);
      await events.return?.(undefined).catch(() => undefined);
    }
  }

  /**
   * Ends a turn whose model keeps retrying tool calls that are denied. It
   * settles as the turn that stopped at its first denial would, so a task
   * owner's single follow-up turn is told the call was denied.
   */
  protected async endDeniedTurn(handle: OpenModelHandle, turnId: string): Promise<ProviderRoomTurnResult> {
    try {
      await handle.client.abort(handle.providerContinuationId);
      await this.waitForSessionIdle(handle, this.turnControlTimeoutMs);
    } catch (error) {
      throw new OpenCodeBoundedTurnError(
        "OpenCode kept retrying denied tool calls, and its native abort could not be verified; the exact turn will not be rerun automatically.",
        { cause: error },
      );
    }
    this.emitTurnTerminal(handle, turnId, "failed");
    return { turnId, providerContinuationId: handle.providerContinuationId, outcome: "failed", text: null,
      evidence: "transcript", error: NO_REPLY_FAILURE.deniedTool };
  }

  protected async abortBoundedTurn(
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

  protected async waitForSessionIdle(
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

  protected emitMessageEvidence(
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
  protected emitToolCall(
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

  protected emitTextDelta(
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

  protected emitProviderRetry(handle: OpenModelHandle, turnId: string, retry: OpenCodeRetryStatus): void {
    // The provider's own words stay in the payload, for diagnostics only.
    // Credentials are redacted before the cut so a key cannot be split by it.
    const redaction = retry.message === null ? null : redactCredentialText(retry.message);
    const message = redaction === null ? null : redaction.value
      .replace(/https?:\/\/\S+/gi, "provider settings")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    this.emitStream(handle, {
      kind: "provider_event",
      method: OPEN_MODEL_PROVIDER_RETRY_METHOD,
      summary: openModelProviderRetrySummary(retry.attempt),
      payloadRedacted: redaction?.redacted === true,
      payload: {
        kind: "provider_retry",
        turnId,
        attempt: retry.attempt,
        message,
        nextRetryAt: retry.next === null ? null : new Date(retry.next).toISOString(),
      },
    });
  }

  protected emitStream(
    handle: OpenModelHandle,
    input: Pick<ProviderStreamEvent, "kind" | "method"> & Partial<Pick<ProviderStreamEvent,
      "nativeEventId" | "nativeLifecyclePhase" | "lifecycleProjectionOnly">> & {
      summary: string | null;
      payload: unknown;
      /** The caller already redacted part of the payload. */
      payloadRedacted?: boolean;
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
      payloadRedacted: safe.payloadRedacted || input.payloadRedacted === true,
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

  protected async waitForHealth(
    client: OpenCodeServerClient,
    exited: Promise<ProviderProcessExit>,
    deadline: number,
  ): Promise<boolean> {
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

  protected observeTerminal(handle: OpenModelHandle, exited: Promise<ProviderProcessExit>): void {
    void exited.then((exit) => {
      this.finish(handle, terminalFromExit(exit, handle.providerContinuationId, this.deps.now(), false), exit.type === "exit");
    });
  }

  protected finish(handle: OpenModelHandle, terminal: ProviderTerminalPayload, processExited: boolean): void {
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

export const openModelProviderAdapter = new OpenModelProviderAdapter();
