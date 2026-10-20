/** Adapter state and construction, compaction progress, native execution and stream publishing, health waits and finishing a handle. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderActivityEvent, ProviderAdapterCapabilities, ProviderHandle, ProviderStreamEvent, ProviderTerminalPayload } from "../provider-adapter.js";
import { DEFAULT_STOP_GRACE_MS, delay, redactCredentialText, safeStreamPayload, sameProcessBirthIdentity, type ProviderProcessExit } from "../provider-evidence.js";
import { resolveOpenCodeBinary } from "../opencode-runtime.js";
import { nativeExecutionId, nativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import type { ControlProbeResult, NativeExecutionFact, TurnOutcome } from "../../../../shared/execution-protocol.js";
import { messageCompleted, OpenCodeServerClient, record, type JsonRecord, type OpenCodeMessage, type OpenCodePart } from "../opencode-server-client.js";
import { CAPABILITIES, MAX_ASSISTANT_STEPS, type OpenModelProviderAdapterDependencies, type OpenModelProviderAdapterOptions, START_TIMEOUT_MS, TURN_CONTROL_TIMEOUT_MS, TURN_TIMEOUT_MS } from "./types.js";
import { OPEN_MODEL_PROVIDER_RETRY_METHOD, type OpenCodeRetryStatus, openModelProviderRetrySummary } from "./errors.js";
import { OpenModelHandle } from "./handle.js";
import { defaultDependencies, terminalFromExit } from "./runtime-launch.js";

export abstract class OpenModelAdapterBase {
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
