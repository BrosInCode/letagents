/** Antigravity adapter state: launch over `agy acp`, the ACP update stream, permission answers, exit and stop. */
import { isBirthEvidence } from "../../../../../../shared/process-tree.mjs";
import type { NativeExecutionFact, TurnOutcome } from "../../../../shared/execution-protocol.js";
import { ProviderContinuationMissingError, type ProviderActivityEvent, type ProviderAdapterCapabilities, type ProviderAttachTerminal, type ProviderConnectionRef, type ProviderContinuationRef, type ProviderHandle, type ProviderSpawnRequest, type ProviderStreamEvent, type ProviderTerminalPayload } from "../provider-adapter.js";
import { attestProviderSpawnPolicy, launchNoticeSaidOnce, spawnUsesHomeHarness } from "../provider-spawn-configuration.js";
import { DEFAULT_STOP_GRACE_MS, delay, observeFencedExit, ProviderProcessCustody, safeStreamPayload, sameProcessBirthIdentity, terminateFreshLaunch, type ProviderProcessExit } from "../provider-evidence.js";
import { nativeExecutionId, nativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import { daemonStateDirEnvironment } from "../windows-child-environment.js";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { AcpConnection, AcpConnectionClosedError, AcpRpcError, acpRecord, acpString, type AcpJsonRecord } from "./acp-connection.js";
import { DEFAULT_ANTIGRAVITY_DEPENDENCIES, type AntigravityChild, type AntigravityProviderAdapterDependencies } from "./child-process.js";
import { AntigravityHandle } from "./handle.js";
import { antigravityToolDisplay } from "./tool-display.js";
import { antigravityNativePermission, antigravityPathForms, antigravityToolPath } from "./permissions.js";
import { claudeToolOperation } from "../../../../../../shared/claude-tool-operation.mjs";
import { type AntigravityEffort, isAntigravityEffort, splitAntigravityModelId, ANTIGRAVITY_CAPABILITIES, ANTIGRAVITY_SIGN_IN_LINE, ANTIGRAVITY_SIGN_IN_REQUIRED, antigravityAcpArgs, antigravityAgentDataDir, antigravityAuthorityFromPolicy, defaultAntigravityDataRoot, isAntigravityQuestion, isAntigravitySignInError, isRoomServerToolCall, requireSupportedAntigravityVersion, resolveAntigravityExecutable } from "./launch.js";

export interface AntigravityProviderAdapterOptions {
  agyBin?: string;
  dependencies?: Partial<AntigravityProviderAdapterDependencies>;
  /** Where each agent's own Antigravity data folder lives. */
  dataRoot?: string;
  /** Launch budget: process start, ACP handshake and the session. */
  initTimeoutMs?: number;
  /** How long a stopped turn gets to return its `cancelled` result. */
  turnControlTimeoutMs?: number;
  /** How long a room turn stays open for a command it left running; defaults to thirty minutes. */
  backgroundCommandWaitLimitMs?: number;
  /** After such a command ends, how long agy's own reply to it gets to begin; defaults to two minutes. */
  backgroundReplyWaitMs?: number;
  /** The quiet time after agy's last update before a held turn counts as answered; defaults to three seconds. */
  backgroundQuietMs?: number;
  stopGraceMs?: number;
}

export const ANTIGRAVITY_INIT_TIMEOUT_MS = 90_000;
export const ANTIGRAVITY_TURN_CONTROL_TIMEOUT_MS = 15_000;

type AntigravityConnection = Extract<ProviderConnectionRef, { kind: "antigravity_acp" }>;

/** The line about left-out LetAgents servers: said when what was left out changes. */
const ownerSetupNotices = launchNoticeSaidOnce();

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort === "low" ? "Low" : effort === "medium" ? "Medium" : effort === "high" ? "High" : effort;
}

/** The agy permission option of one kind, or null when it offers none. */
function optionOfKind(options: unknown, kinds: readonly string[]): string | null {
  if (!Array.isArray(options)) return null;
  for (const kind of kinds) {
    for (const option of options) {
      const record = acpRecord(option);
      if (record?.kind === kind && typeof record.optionId === "string") return record.optionId;
    }
  }
  return null;
}

function toolOperation(kind: unknown): Extract<NativeExecutionFact, { domain: "execution" }>["operation"] {
  switch (kind) {
    case "execute": return "command";
    case "read":
    case "search": return "file_read";
    case "edit":
    case "delete":
    case "move": return "file_change";
    case "fetch": return "network";
    default: return "other";
  }
}

export abstract class AntigravityAdapterBase {
  readonly id = "antigravity" as const;
  protected readonly agyBin: string;
  protected readonly deps: AntigravityProviderAdapterDependencies;
  protected readonly dataRoot: string;
  protected readonly initTimeoutMs: number;
  protected readonly turnControlTimeoutMs: number;
  protected readonly stopGraceMs: number;
  protected readonly backgroundCommandWaitLimitMs: number;
  protected readonly backgroundReplyWaitMs: number;
  protected readonly backgroundQuietMs: number;
  protected readonly handles = new Map<string, AntigravityHandle>();
  protected readonly processCustody: ProviderProcessCustody;
  private readonly pendingAttaches = new Map<string, { ref: ProviderContinuationRef; promise: Promise<ProviderAttachTerminal> }>();

  constructor(options: AntigravityProviderAdapterOptions = {}) {
    this.deps = { ...DEFAULT_ANTIGRAVITY_DEPENDENCIES, ...options.dependencies };
    this.agyBin = options.agyBin || resolveAntigravityExecutable(desktopRuntimeEnvironment());
    this.dataRoot = options.dataRoot ?? defaultAntigravityDataRoot();
    this.initTimeoutMs = options.initTimeoutMs ?? ANTIGRAVITY_INIT_TIMEOUT_MS;
    this.turnControlTimeoutMs = options.turnControlTimeoutMs ?? ANTIGRAVITY_TURN_CONTROL_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.backgroundCommandWaitLimitMs = options.backgroundCommandWaitLimitMs ?? 30 * 60_000;
    this.backgroundReplyWaitMs = options.backgroundReplyWaitMs ?? 2 * 60_000;
    this.backgroundQuietMs = options.backgroundQuietMs ?? 3_000;
    this.processCustody = new ProviderProcessCustody(this.deps);
  }

  capabilities(): ProviderAdapterCapabilities {
    return structuredClone(ANTIGRAVITY_CAPABILITIES);
  }

  runtimeCustody(workAttemptId: string, providerHandle?: ProviderHandle): "absent" | "owned" | "unknown" {
    const handle = this.handles.get(workAttemptId);
    return this.processCustody.state(workAttemptId, handle && handle === providerHandle ? handle.child : undefined);
  }

  protected requireHandle(handle: ProviderHandle): AntigravityHandle {
    const current = this.handles.get(handle.workAttemptId);
    if (!current || current !== handle) throw new Error("Antigravity handle is stale or foreign.");
    return current;
  }

  protected start(req: ProviderSpawnRequest, resumeRef: ProviderContinuationRef | null): Promise<AntigravityHandle> {
    return this.processCustody.acquire(req.workAttemptId, () => this.startAcquired(req, resumeRef));
  }

  private async startAcquired(req: ProviderSpawnRequest, resumeRef: ProviderContinuationRef | null): Promise<AntigravityHandle> {
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) throw new Error(`Antigravity work attempt '${req.workAttemptId}' already has a live process.`);
    if (!req.agentDisplayName?.trim()) throw new Error("Antigravity spawn requires the durable agent display name from the manifest.");
    if (req.deliveryMode !== "daemon_inbox") throw new Error("Antigravity room agents require daemon_inbox delivery.");
    // agy reads files and searches the web without asking at every level, so it cannot work for a guest.
    if (req.supervisorEntryId?.startsWith("supervised_rental_")) throw new Error("Antigravity does not run for a guest: its file reads and web searches cannot be limited.");
    const homeHarness = spawnUsesHomeHarness("antigravity", req);
    const authority = antigravityAuthorityFromPolicy(attestProviderSpawnPolicy("antigravity", req));
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    requireSupportedAntigravityVersion(await this.deps.readVersion(this.agyBin));
    // agy runs a workspace's hooks, plugins and MCP servers at session start, with no request to answer.
    if (!authority.dangerouslySkipPermissions) {
      const refusal = this.deps.workspaceRefusal(req.cwd);
      if (refusal) throw new Error(refusal);
    }

    const supervisorEnv: Record<string, string> = req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId
      ? {
        LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId,
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath,
        ...daemonStateDirEnvironment(req.supervisorSocketPath),
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId,
        LETAGENTS_SUPERVISOR_PROVIDER: "antigravity",
        ...(req.supervisorWorkerSession ? {
          LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
          LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
          LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim(),
        } : {}),
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        ...(req.permissionProfileId ? { LETAGENTS_PERMISSION_PROFILE_ID: req.permissionProfileId } : {}),
      }
      : {};
    const roomServer = this.deps.roomServer(req, supervisorEnv);
    const commitEnvironment = await this.deps.resolveCommitEnvironment(req);
    const geminiDir = antigravityAgentDataDir(this.dataRoot, req.supervisorEntryId?.trim() || req.workAttemptId);
    // The owner's own setup is placed in (or taken out of) the agent's folder before agy reads it.
    const ownerSetup = this.deps.prepareOwnerSetup(geminiDir, homeHarness);
    const child = this.deps.launchChild({
      agyBin: this.agyBin,
      args: antigravityAcpArgs({ geminiDir, authority }),
      cwd: req.cwd,
      // The room's coordinates go to its own MCP server alone: agy hands its
      // environment to every server it starts, the owner's own among them.
      env: commitEnvironment,
    });
    const captureBirth = this.processCustody.record(req.workAttemptId, child);
    const processIdentity = captureBirth();
    if (child.pid === null) {
      await child.exited;
      throw new Error("Antigravity launch did not expose a process id; refusing to start an unfenceable writer.");
    }
    if (typeof processIdentity !== "string" || !processIdentity) {
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      throw new Error("Antigravity process identity could not be verified; refusing to start an unfenceable writer.");
    }

    let handle: AntigravityHandle | null = null;
    let signInRequired = false;
    const early: Array<[string, AcpJsonRecord | null]> = [];
    const connection = new AcpConnection(child, {
      onNotification: (method, params) => {
        if (handle) this.observeNotification(handle, method, params);
        else early.push([method, params]);
      },
      onRequest: (method, params, id) => {
        if (method === "session/request_permission" && handle) return this.answerPermission(handle, params, id);
        if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
        throw new AcpRpcError(`Method not supported: ${method}`, -32601);
      },
      onNonJsonLine: (line) => { if (ANTIGRAVITY_SIGN_IN_LINE.test(line)) signInRequired = true; },
    });
    const failure = Symbol("failure");
    const deadline = delay(this.initTimeoutMs).then(() => ({ [failure]: new Error(`Antigravity did not start within ${Math.round(this.initTimeoutMs / 1000)} s.`) }));
    const exitedEarly = child.exited.then(() => ({ [failure]: new Error(signInRequired ? ANTIGRAVITY_SIGN_IN_REQUIRED
      : `Antigravity exited while it was starting.${child.stderrTail() ? ` ${child.stderrTail().slice(-600)}` : ""}`) }));
    const step = async <T>(work: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([work.then(value => ({ value })), deadline, exitedEarly]);
      if (failure in outcome) throw outcome[failure];
      return outcome.value;
    };
    try {
      const init = acpRecord(await step(connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "letagents", title: "LetAgents", version: "1" },
      })));
      const capabilities = acpRecord(init?.agentCapabilities);
      const sessionCapabilities = acpRecord(capabilities?.sessionCapabilities);
      if (resumeRef && !acpRecord(sessionCapabilities?.resume)) {
        throw new Error("This Antigravity CLI cannot resume a conversation. Run `agy update`, then try again.");
      }
      let session: AcpJsonRecord | null;
      let sessionId: string;
      try {
        if (resumeRef) {
          session = acpRecord(await step(connection.request("session/resume", {
            sessionId: resumeRef.providerContinuationId, cwd: req.cwd, mcpServers: [roomServer],
          })));
          sessionId = resumeRef.providerContinuationId;
        } else {
          session = acpRecord(await step(connection.request("session/new", { cwd: req.cwd, mcpServers: [roomServer] })));
          sessionId = acpString(session?.sessionId) ?? "";
          if (!nativeExecutionId(sessionId)) throw new Error("Antigravity did not return a session id.");
        }
      } catch (error) {
        if (signInRequired || (error instanceof AcpRpcError && isAntigravitySignInError(error.code, error.message))) {
          throw new Error(ANTIGRAVITY_SIGN_IN_REQUIRED);
        }
        if (resumeRef && error instanceof AcpRpcError) throw new ProviderContinuationMissingError(resumeRef.providerContinuationId);
        throw error;
      }
      const modes = (acpRecord(session?.modes)?.availableModes ?? []) as unknown[];
      const modeIds = new Set(modes.map(mode => acpRecord(mode)?.id).filter((id): id is string => typeof id === "string"));
      if (authority.agentMode === "auto" && !modeIds.has("auto")) {
        throw new Error("Antigravity did not offer its Auto mode for this account. Choose another access level, then try again.");
      }
      // Set the mode explicitly: a resumed session may carry another one.
      await step(connection.request("session/set_mode", { sessionId, modeId: authority.agentMode }));
      const applied = await this.applyModelAndEffort(connection, sessionId, session, req, step);
      handle = new AntigravityHandle(
        req.workAttemptId, child.pid, sessionId, lifecycleAuthorityMode,
        { kind: "antigravity_acp", pid: child.pid, processIdentity },
        child, connection, authority,
        observeFencedExit(child, child.pid, processIdentity, child.exited, this.deps),
        this.deps.now,
      );
      handle.state = "idle";
      handle.currentModel = applied.model;
      handle.geminiDir = geminiDir;
      handle.cwd = req.cwd;
      const ownerNotice = ownerSetupNotices.whenChanged(req.supervisorEntryId, ownerSetup.notices[0] ?? null);
      handle.launchNotices = [...(ownerNotice ? [ownerNotice] : []), ...applied.notices];
      handle.ownerSetup = homeHarness;
      this.handles.set(req.workAttemptId, handle);
      void handle.exitEvidence.then(exit => this.observeExit(handle!, exit));
      for (const [method, params] of early.splice(0)) this.observeNotification(handle, method, params);
      try { req.onNativeStarted?.(); } catch { /* a host hint cannot fail the launch */ }
      this.emitExecution(handle, { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" });
      return handle;
    } catch (error) {
      if (handle) ownerSetupNotices.forget(req.supervisorEntryId, handle.launchNotices);
      connection.close(error instanceof Error ? error : new Error(String(error)));
      if (handle && this.handles.get(req.workAttemptId) === handle) this.handles.delete(req.workAttemptId);
      child.markIntentionalClose();
      await terminateFreshLaunch({ pid: child.pid, exited: child.exited, processIdentity }, this.deps, this.stopGraceMs);
      throw error;
    }
  }

  /**
   * Put the session on the agent's model and thinking level. The model a
   * person picks is a family (`gemini-4-neon`); its level is agy's
   * `thought_level` option. A full per-level id (`gemini-4-neon-high`) is
   * split the same way. A level the model does not offer is left at agy's own
   * and said in a launch notice, as for the other providers.
   */
  private async applyModelAndEffort(
    connection: AcpConnection,
    sessionId: string,
    session: AcpJsonRecord | null,
    req: ProviderSpawnRequest,
    step: <T>(work: Promise<T>) => Promise<T>,
  ): Promise<{ model: string | null; notices: string[] }> {
    let options: unknown[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
    const option = (category: string) => options.map(acpRecord).find((entry) => entry?.category === category || entry?.id === category) ?? null;
    const values = (entry: AcpJsonRecord | null): string[] => (Array.isArray(entry?.options) ? entry.options : []).flatMap((value: unknown) => {
      const record = acpRecord(value);
      if (Array.isArray(record?.options)) return (record.options as unknown[]).map((inner) => acpString(acpRecord(inner)?.value)).filter((id): id is string => Boolean(id));
      const id = acpString(record?.value);
      return id ? [id] : [];
    });
    const setOption = async (configId: string, value: string) => {
      const result = acpRecord(await step(connection.request("session/set_config_option", { sessionId, configId, value })));
      if (Array.isArray(result?.configOptions)) options = result.configOptions;
    };
    const notices: string[] = [];
    const requestedModel = req.model?.trim() || null;
    let effort: AntigravityEffort | null = isAntigravityEffort(req.reasoningEffort) ? req.reasoningEffort : null;
    try {
      if (requestedModel) {
        const modelOption = option("model");
        const offered = values(modelOption);
        const split = splitAntigravityModelId(requestedModel);
        if (modelOption && offered.includes(requestedModel)) {
          await setOption(String(modelOption.id), requestedModel);
        } else if (modelOption && split.effort && offered.includes(split.family)) {
          await setOption(String(modelOption.id), split.family);
          // An id that names its thinking level (`gemini-4-neon-low`) says it outright; a saved effort does not override it.
          effort = split.effort;
        } else if (modelOption) {
          // agy listed the models this account has, and this one is not among them.
          throw new AcpRpcError(`Model '${requestedModel}' is not offered.`, -32602);
        } else {
          await step(connection.request("session/set_model", { sessionId, modelId: requestedModel }));
        }
      }
    } catch (error) {
      if (error instanceof AcpRpcError) throw new Error(`Antigravity does not offer the model '${requestedModel}' to this account. Choose another model, then try again.`);
      throw error;
    }
    const thought = option("thought_level");
    if (effort && thought) {
      if (values(thought).includes(effort)) await setOption(String(thought.id), effort);
      else {
        const current = acpString(option("thought_level")?.currentValue);
        notices.push(`Antigravity offers no ${effortLabel(effort)} thinking for this model, so it runs at ${current ? effortLabel(current) : "its default level"}.`);
      }
    }
    const modelNow = acpString(option("model")?.currentValue) ?? requestedModel ?? acpString(acpRecord(session?.models)?.currentModelId);
    return { model: modelNow, notices };
  }

  /** How this host answers a permission request: room tools always run; the access level decides the rest. */
  protected answerPermission(handle: AntigravityHandle, params: AcpJsonRecord | null, id: string | number): AcpJsonRecord | Promise<AcpJsonRecord> {
    const toolCall = acpRecord(params?.toolCall);
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (params?.sessionId !== handle.providerContinuationId || handle.terminal || handle.stopRequested) return cancelled;
    // A request with no room turn open (agy woke itself after a background command) has nobody to answer for.
    if (!handle.activeTurn) return cancelled;
    if (isAntigravityQuestion(toolCall)) {
      this.emitStream(handle, { kind: "approval", method: "session/request_permission", summary: "Antigravity asked a question that needs a person; it was not answered.",
        payload: { decision: "cancelled", title: acpString(toolCall?.title) } });
      return cancelled;
    }
    const roomTool = isRoomServerToolCall(toolCall);
    // The files this turn's room message carried are staged outside the workspace, where agy asks before reading.
    const stagedPath = acpString(toolCall?.kind) === "read" ? antigravityToolPath(toolCall) : null;
    const stagedRead = Boolean(stagedPath && antigravityPathForms(stagedPath).some((form) => handle.activeTurn?.stagedFiles?.has(form)));
    if (!roomTool && !stagedRead && handle.authority.hostDecision === "ask" && toolCall) {
      // Ask before writes: the request waits for the owner's answer on a desktop approval card.
      if (!handle.permissionControlAvailable) return cancelled;
      const native = antigravityNativePermission(id, toolCall);
      const turnId = handle.activeTurn.turnId;
      (handle.activeTurn.requestedTools ??= new Map()).set(native.request.tool_use_id, native.request.tool_name);
      return new Promise<AcpJsonRecord>((settle) => {
        handle.permissionRequests.set(native.id, {
          native, turnId, toolCallId: native.request.tool_use_id, options: params?.options, dispatching: false, settle,
        });
        // The request closes when its tool ends, its turn ends, or it is cancelled, answered or not.
        handle.permissionClosures.set(native.request.tool_use_id, { native, turnId });
        handle.permissionsChanged();
        this.emitStream(handle, { kind: "approval", method: "session/request_permission",
          summary: `Waiting for your approval: ${acpString(toolCall.title) ?? native.request.tool_name}`,
          payload: { decision: "asked", toolCallId: native.request.tool_use_id, kind: acpString(toolCall.kind), title: acpString(toolCall.title) } });
      });
    }
    const allow = roomTool || stagedRead || handle.authority.hostDecision === "allow";
    const optionId = allow ? optionOfKind(params?.options, ["allow_once", "allow_always"]) : optionOfKind(params?.options, ["reject_once", "reject_always"]);
    if (!optionId) return cancelled;
    if (!allow) {
      handle.activeTurn.refusedTool = true;
      const refused = acpString(toolCall?.toolCallId);
      if (refused) (handle.activeTurn.deniedTools ??= new Set()).add(refused);
    }
    this.emitStream(handle, { kind: "approval", method: "session/request_permission",
      summary: allow ? null : `Refused by this agent's access level: ${acpString(toolCall?.title) ?? "a tool call"}`,
      payload: { decision: allow ? "allowed" : "refused", toolCallId: acpString(toolCall?.toolCallId), kind: acpString(toolCall?.kind), title: acpString(toolCall?.title) } });
    return { outcome: { outcome: "selected", optionId } };
  }

  /** One ACP notification: the update stream of the agent's session. */
  protected observeNotification(handle: AntigravityHandle, method: string, params: AcpJsonRecord | null): void {
    if (method !== "session/update" || params?.sessionId !== handle.providerContinuationId) return;
    const update = acpRecord(params.update);
    const kind = acpString(update?.sessionUpdate);
    if (!update || !kind) return;
    const turn = handle.activeTurn;
    if (turn) turn.lastUpdateAt = Date.now();
    switch (kind) {
      case "agent_message_chunk": {
        const text = acpRecord(update.content)?.type === "text" ? acpRecord(update.content)?.text : null;
        if (typeof text !== "string" || !text) return;
        turn?.text.push(text);
        this.emitStream(handle, { kind: "text_delta", method: "item/agentMessage/delta", summary: null, payload: { delta: text } });
        return;
      }
      case "agent_thought_chunk": {
        const text = acpRecord(update.content)?.text;
        if (typeof text !== "string" || !text) return;
        this.emitStream(handle, { kind: "text_delta", method: "reasoning/summaryTextDelta", summary: null, payload: { delta: text } });
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.observeToolCall(handle, update);
        return;
      case "usage_update": {
        const used = update.used;
        const size = update.size;
        if (turn) turn.lastUsageAt = Date.now();
        if (typeof used === "number" && Number.isSafeInteger(used) && used >= 0) {
          handle.usage = { ...handle.usage, context: {
            usedTokens: used,
            capacityTokens: typeof size === "number" && Number.isSafeInteger(size) && size > 0 ? size : null,
            observedAt: this.deps.now(),
          } };
        }
        this.emitStream(handle, { kind: "usage", method: "session/usage_update", summary: null, payload: { used, size } });
        return;
      }
      case "plan":
        this.emitStream(handle, { kind: "provider_event", method: "session/plan", summary: null, payload: { entries: update.entries } });
        return;
      default:
        // Commands, config, mode and title updates carry nothing the room shows.
        return;
    }
  }

  private observeToolCall(handle: AntigravityHandle, update: AcpJsonRecord): void {
    const toolCallId = acpString(update.toolCallId);
    if (!toolCallId) return;
    const status = acpString(update.status) ?? "pending";
    const turn = handle.activeTurn;
    if (turn) {
      if (turn.toolStatuses.get(toolCallId) === status) return;
      turn.toolStatuses.set(toolCallId, status);
    }
    if (status === "completed" || status === "failed") handle.closePermissions((id) => id === toolCallId);
    if (turn && (acpString(update.kind) === "execute" || acpString(update.name) === "run_command")) {
      // A daemon (IsDaemon) is meant to outlive the turn; any other command is waited for.
      const daemon = acpRecord(update.rawInput)?.IsDaemon === true;
      if ((status === "pending" || status === "in_progress") && !daemon) turn.openCommands.add(toolCallId);
      else if (turn.openCommands.delete(toolCallId)) turn.lastCommandEndAt = Date.now();
    }
    const title = acpString(update.title) ?? acpString(update.name) ?? "tool";
    if (turn && (status === "completed" || status === "failed") && nativeExecutionId(toolCallId)
      && nativeExecutionId(turn.turnId) && nativeExecutionId(handle.providerContinuationId)) {
      // A tool that had a permission request is named as the approval path knows it.
      const requestedName = turn.requestedTools?.get(toolCallId);
      const operation = requestedName ? claudeToolOperation(requestedName) : toolOperation(update.kind);
      const denied = status === "failed" && turn.deniedTools?.has(toolCallId) === true;
      this.emitExecution(handle, { domain: "execution", kind: "completed", executionId: toolCallId, operation,
        providerContinuationId: handle.providerContinuationId, providerTurnId: turn.turnId,
        sideEffects: denied || operation === "file_read" ? "none" : "possible",
        outcome: status === "completed" ? "succeeded" : denied ? "denied_before_start"
          : turn.cancelRequested ? "interrupted_after_start" : "failed" });
    }
    const rawOutput = acpRecord(update.rawOutput);
    const display = antigravityToolDisplay(update);
    // A call that fails because the owner stopped the turn was interrupted, not broken.
    const shownStatus = status === "in_progress" ? "running"
      : status === "failed" && turn?.cancelRequested ? "interrupted" : status;
    this.emitStream(handle, {
      kind: "tool_lifecycle",
      method: "item/toolCall/updated",
      summary: status === "in_progress" || status === "completed" || status === "failed" ? `${title}${shownStatus === "failed" ? " (failed)" : shownStatus === "interrupted" ? " (stopped)" : ""}` : null,
      payload: {
        callID: toolCallId,
        tool: display.tool,
        kind: acpString(update.kind),
        title,
        status: shownStatus,
        input: display.input ?? null,
        output: typeof rawOutput?.output === "string" ? rawOutput.output : null,
      },
    });
  }

  protected emitExecution(handle: AntigravityHandle, fact: NativeExecutionFact): void {
    handle.execution.emit(fact, handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
  }

  protected emitTurnActive(handle: AntigravityHandle, turnId: string): void {
    handle.observedTurn = { id: turnId, terminal: null };
    if (!nativeExecutionId(turnId) || !nativeExecutionId(handle.providerContinuationId)) return;
    const checkpoint = nativeLifecycleCheckpoint({
      provider: "antigravity", workAttemptId: handle.workAttemptId, phase: "turn_active",
      providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
      nativeProcessPid: handle.providerConnection.pid ?? undefined,
      nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
    });
    this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
      providerContinuationId: handle.providerContinuationId, providerTurnId: turnId, nativeEventId: checkpoint.nativeEventId });
    this.emitStream(handle, { kind: "turn_lifecycle", method: "turn/started", summary: null, payload: null,
      nativeEventId: checkpoint.nativeEventId, nativeLifecyclePhase: checkpoint.phase, lifecycleProjectionOnly: true });
  }

  protected emitTurnTerminal(handle: AntigravityHandle, turnId: string, outcome: TurnOutcome): void {
    if (handle.observedTurn?.id === turnId && handle.observedTurn.terminal) return;
    handle.observedTurn = { id: turnId, terminal: outcome };
    if (!nativeExecutionId(turnId) || !nativeExecutionId(handle.providerContinuationId)) return;
    const checkpoint = nativeLifecycleCheckpoint({
      provider: "antigravity", workAttemptId: handle.workAttemptId, phase: "turn_terminal",
      providerContinuationId: handle.providerContinuationId, providerTurnId: turnId,
      nativeProcessPid: handle.providerConnection.pid ?? undefined,
      nativeProcessIdentity: handle.providerConnection.processIdentity ?? undefined,
      terminalDiscriminator: outcome,
    });
    this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: outcome, sideEffects: "none",
      providerContinuationId: handle.providerContinuationId, providerTurnId: turnId, nativeEventId: checkpoint.nativeEventId });
    this.emitStream(handle, { kind: "turn_lifecycle", method: "turn/completed", summary: null, payload: null,
      nativeEventId: checkpoint.nativeEventId, nativeLifecyclePhase: checkpoint.phase, lifecycleProjectionOnly: true });
  }

  protected emitStream(
    handle: AntigravityHandle,
    input: Pick<ProviderStreamEvent, "kind" | "method"> & Partial<Pick<ProviderStreamEvent, "nativeEventId" | "nativeLifecyclePhase" | "lifecycleProjectionOnly">> & {
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
      provider: "antigravity",
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
    for (const listener of handle.streamListeners) {
      try { listener(event); } catch { /* listeners cannot control the agent */ }
    }
    if (!input.summary) return;
    const activity: ProviderActivityEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: event.observedAt,
      source: "native_harness",
      method: input.method,
      summary: input.summary,
      status: "working",
      checking: input.summary,
      nextAction: "Continue the bounded Antigravity turn.",
    };
    for (const listener of handle.activityListeners) {
      try { listener(activity); } catch { /* listeners cannot control the agent */ }
    }
  }

  /** The process ended: settle the open turn, record the terminal and tell every exit listener. */
  protected observeExit(handle: AntigravityHandle, exit: ProviderProcessExit): void {
    if (handle.terminal) return;
    const endedAt = this.deps.now();
    const stopRequested = handle.stopRequested;
    const exitCode = exit.type === "exit" ? exit.code : null;
    const signal = exit.type === "exit" ? exit.signal : null;
    let terminalCause: ProviderTerminalPayload["terminalCause"];
    if (exit.type === "error") terminalCause = stopRequested ? "stopped" : "crashed";
    else if (signal === "SIGKILL") terminalCause = stopRequested ? "killed" : "crashed";
    else if (signal) terminalCause = stopRequested ? "stopped" : "crashed";
    else terminalCause = exitCode === 0 ? (stopRequested ? "stopped" : "exited") : stopRequested ? "stopped" : "crashed";
    const terminal: ProviderTerminalPayload = { endedAt, exitCode, signal, terminalCause, providerContinuationId: handle.providerContinuationId,
      ...(exit.type === "exit" && handle.providerConnection.processIdentity
        ? { nativeRuntimeDeath: { kind: "antigravity_acp" as const, pid: handle.pid, processIdentity: handle.providerConnection.processIdentity } } : {}) };
    handle.permissionControlAvailable = false;
    handle.cancelPendingPermissions();
    handle.closePermissions(() => true);
    handle.connection.close(new AcpConnectionClosedError("Antigravity's process ended."));
    if (this.handles.get(handle.workAttemptId) === handle) {
      handle.controlLoss = "process_exit";
      if (handle.observedTurn && !handle.observedTurn.terminal) {
        handle.observedTurn.terminal = "lost";
        this.emitExecution(handle, { domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: handle.observedTurn.id });
      }
      this.emitExecution(handle, { domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" });
      this.emitExecution(handle, { domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence: "process_exit" });
    }
    handle.terminal = terminal;
    handle.state = "stopped";
    for (const listener of handle.exitListeners) {
      try { listener(terminal); } catch { /* one listener cannot block the others */ }
    }
    handle.exitListeners.clear();
  }

  /**
   * A stdio child has no reconnectable channel: its pipes died with the
   * supervisor that spawned it. Attach either returns this adapter's own live
   * handle, or proves the recorded child gone, fencing it first if it still
   * runs, so a successor never writes beside it.
   */
  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const handle = this.handles.get(ref.workAttemptId);
    if (handle && !handle.terminal && handle.providerContinuationId === ref.providerContinuationId
      && handle.lifecycleAuthorityMode === (ref.lifecycleAuthorityMode ?? "typed_shadow")
      && handle.providerConnection.pid === ref.providerConnection?.pid
      && ref.providerConnection?.kind === "antigravity_acp"
      && Boolean(ref.providerConnection.processIdentity)
      && ref.providerConnection.processIdentity === handle.providerConnection.processIdentity) {
      return handle;
    }
    if (handle) return null;
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "antigravity_acp") return null;
    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (pending.ref.providerContinuationId !== ref.providerContinuationId
        || pending.ref.providerConnection?.pid !== connection.pid) return null;
      return pending.promise;
    }
    const attaching = this.fenceRecordedChild(connection, ref.providerContinuationId).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) this.pendingAttaches.delete(ref.workAttemptId);
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  /** Stop an exact recorded process birth that this adapter cannot reattach. */
  async stopRef(ref: ProviderContinuationRef, options: { force?: boolean; graceMs?: number } = {}): Promise<ProviderTerminalPayload> {
    const connection = ref.providerConnection;
    const graceMs = options.graceMs ?? this.stopGraceMs;
    if (!ref.workAttemptId?.trim() || !ref.providerContinuationId?.trim() || connection?.kind !== "antigravity_acp"
      || !Number.isSafeInteger(connection.pid) || connection.pid! <= 0 || !isBirthEvidence(connection.processIdentity)
      || !Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("Antigravity exact-reference stop requires an exact continuation and process birth.");
    }
    const known = [...this.handles.values()].find(handle => handle.pid === connection.pid
      && sameProcessBirthIdentity(handle.providerConnection.processIdentity ?? "", connection.processIdentity!));
    if (known && (known.workAttemptId !== ref.workAttemptId || known.providerContinuationId !== ref.providerContinuationId)) {
      throw new Error("Antigravity exact-reference stop conflicts with the known native process owner.");
    }
    if (known) {
      known.stopRequested = true;
      known.state = "stopping";
      known.child.markIntentionalClose();
    }
    const result = await this.fenceRecordedChild(connection, ref.providerContinuationId, { force: options.force === true, graceMs });
    return result.terminal;
  }

  protected async fenceRecordedChild(
    connection: AntigravityConnection,
    providerContinuationId: string,
    stop?: { force: boolean; graceMs: number },
  ): Promise<ProviderAttachTerminal> {
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error("Antigravity attach is ambiguous; the durable endpoint has no verified process identity.");
    }
    const pid = connection.pid;
    const birth = connection.processIdentity;
    const terminal = (signal: string | null, terminalCause: ProviderTerminalPayload["terminalCause"]): ProviderAttachTerminal => ({
      state: "terminal",
      terminal: { endedAt: this.deps.now(), exitCode: null, signal, terminalCause, providerContinuationId,
        nativeRuntimeDeath: { kind: "antigravity_acp", pid, processIdentity: birth } },
    });
    const sameBirth = (): boolean => {
      const identity = this.deps.getProcessIdentity(pid);
      if (identity === undefined) throw new Error("Antigravity attach is ambiguous; the recorded process identity cannot be verified.");
      return identity !== null && sameProcessBirthIdentity(identity, birth);
    };
    if (!sameBirth()) return terminal(null, "crashed");
    // The previous supervisor's stdin closing is the agent's stop request; let it end by itself first.
    const exitedNaturally = !stop && await Promise.race([
      this.deps.observeProcessExit(pid, birth).then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (exitedNaturally || !sameBirth()) return terminal(null, "crashed");
    const signal = stop?.force ? "SIGKILL" : "SIGTERM";
    this.deps.signalProcess(pid, signal, birth);
    await delay(stop?.graceMs ?? this.stopGraceMs);
    if (!sameBirth()) return terminal(signal, signal === "SIGKILL" ? "killed" : "stopped");
    if (stop?.force) throw new Error("Antigravity exact-reference stop has not yet proved the recorded process birth is gone.");
    this.deps.signalProcess(pid, "SIGKILL", birth);
    if (stop) {
      await delay(stop.graceMs);
      if (sameBirth()) throw new Error("Antigravity exact-reference stop has not yet proved the recorded process birth is gone.");
    } else {
      await this.deps.observeProcessExit(pid, birth);
    }
    return terminal("SIGKILL", "killed");
  }

  async stop(providerHandle: ProviderHandle, options: { force?: boolean; graceMs?: number } = {}): Promise<ProviderTerminalPayload> {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) return handle.terminal;
    handle.stopRequested = true;
    handle.state = "stopping";
    handle.permissionControlAvailable = false;
    handle.cancelPendingPermissions();
    handle.child.markIntentionalClose();
    const ended = new Promise<ProviderTerminalPayload>((resolve) => {
      if (handle.terminal) resolve(handle.terminal);
      else handle.exitListeners.add(resolve);
    });
    const identity = handle.providerConnection.processIdentity;
    const graceMs = options.graceMs ?? this.stopGraceMs;
    if (process.platform === "win32" && handle.child.terminate) {
      void handle.child.terminate({ graceful: !options.force, graceMs }).catch(() => undefined);
      return ended;
    }
    if (options.force) {
      this.deps.signalProcess(handle.pid, "SIGKILL", identity);
      return ended;
    }
    this.deps.signalProcess(handle.pid, "SIGTERM", identity);
    const graceful = await Promise.race([ended.then(payload => ({ payload })), delay(graceMs).then(() => null)]);
    if (graceful) return graceful.payload;
    this.deps.signalProcess(handle.pid, "SIGKILL", identity);
    return ended;
  }

  onExit(providerHandle: ProviderHandle, listener: (payload: ProviderTerminalPayload) => void): () => void {
    const handle = this.requireHandle(providerHandle);
    if (handle.terminal) {
      const terminal = handle.terminal;
      queueMicrotask(() => listener(terminal));
      return () => {};
    }
    handle.exitListeners.add(listener);
    return () => handle.exitListeners.delete(listener);
  }

  onActivity(providerHandle: ProviderHandle, listener: (event: ProviderActivityEvent) => void): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.activityListeners.add(listener);
    return () => handle.activityListeners.delete(listener);
  }

  onStream(providerHandle: ProviderHandle, listener: (event: ProviderStreamEvent) => void): () => void {
    const handle = this.requireHandle(providerHandle);
    handle.streamListeners.add(listener);
    return () => handle.streamListeners.delete(listener);
  }
}

export type { AntigravityChild };
