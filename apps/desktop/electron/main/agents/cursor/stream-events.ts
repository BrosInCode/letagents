// Cursor stream-json parsing, native execution observation, and stream/activity publication.

import type { ProviderActivityEvent, ProviderStreamEvent, ProviderStreamEventKind } from "../provider-adapter.js";
import type { NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { nativeExecutionId, nativeLifecycleCheckpoint, type NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import { MAX_CURSOR_SESSION_ID_LENGTH, CURSOR_SESSION_ID_PATTERN } from "../cursor-provider-constants.js";
import { cursorLiveDisplayProjections } from "../cursor-live-display.js";
import {
  cursorNativeToolEnvelope,
  cursorNativeToolTerminalResult,
} from "../cursor-native-tool.js";
import { safeStreamPayload, type ProviderProcessExit } from "../provider-evidence.js";
import { CursorProviderHandle, type CursorStreamMessage, type LiveTurn } from "./lane-state.js";
import { CURSOR_PENDING_CONTINUATION_PREFIX } from "./launch-arguments.js";
import type { CursorProviderAdapter } from "./provider-adapter.js";

function cursorStreamKind(message: CursorStreamMessage): ProviderStreamEventKind {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "assistant") return "text_delta";
  // Cursor's documented `user` event is the prompt echo, not a tool result.
  if (type === "user") return "provider_event";
  if (type === "tool_call" || type === "tool_use" || type === "tool_use_summary") return "tool_lifecycle";
  if (type === "result") return "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

function streamMethod(message: CursorStreamMessage): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${type}/${subtype}` : type;
}

export function sessionIdOf(message: CursorStreamMessage): string | null {
  if (typeof message.session_id !== "string") return null;
  const sessionId = message.session_id.trim();
  return sessionId
    && sessionId.length <= MAX_CURSOR_SESSION_ID_LENGTH
    && CURSOR_SESSION_ID_PATTERN.test(sessionId)
    ? sessionId
    : null;
}

export function consumeLine(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turn: LiveTurn, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: CursorStreamMessage | null = null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      message = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as CursorStreamMessage
        : null;
    } catch {
      message = null;
    }
  }
  if (!message) {
    adapter.publishStream(handle, "stdout/raw", { line: trimmed }, "provider_event");
    return;
  }
  const sessionId = sessionIdOf(message);
  if (Object.hasOwn(message, "session_id") && !sessionId) {
    handle.protocolError = true;
    adapter.publishStream(handle, "session/invalid", {
      reason: "provider emitted an invalid or option-shaped session identity",
    }, "error");
    adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
    return;
  }
  const pendingContinuation = handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX) === true;
  if (sessionId && handle.providerContinuationId && !pendingContinuation && handle.providerContinuationId !== sessionId) {
    // A stranger session must never silently become this lane's continuation
    // (same rule as the Claude adapter's same-id assertion).
    handle.protocolError = true;
    adapter.publishStream(handle, "session/mismatch", {
      expectedSessionId: handle.providerContinuationId,
      observedSessionId: sessionId,
    }, "error");
    adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
    return;
  }
  if (message.type === "result"
    && (!turn.sawInit || !sessionId || sessionId !== handle.providerContinuationId)) {
    handle.protocolError = true;
    adapter.publishStream(handle, "result/session_invalid", {
      reason: "Cursor result did not carry the exact verified turn session identity.",
    }, "error");
    adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
    return;
  }
  const safeProviderPayload = safeStreamPayload(message);
  const nativeLifecycle = adapter.observeNativeExecution(handle, turn, message, sessionId);
  const duplicateInit = message.type === "system" && message.subtype === "init" && turn.sawInit;
  // The daemon uses the first verified init as the per-turn display boundary.
  // Preserve duplicate same-session init as diagnostics under a distinct
  // method so it cannot erase assistant/tool output already shown this turn.
  adapter.publishSafeStream(handle, duplicateInit ? "system/init_duplicate" : streamMethod(message), safeProviderPayload,
    cursorStreamKind(message), nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
  const rawEventSequence = handle.streamSequence;
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "system") {
    // Readiness AND identity adoption are STRICT: only a genuine system/init
    // event that carried a session id counts (msg_1807). Other events may
    // carry session ids that are asserted against an established continuation
    // above, but never establish one themselves.
    if (message.subtype === "init") {
      if (!sessionId) {
        handle.protocolError = true;
        adapter.publishStream(handle, "session/missing", {
          reason: "init carried no session id",
        }, "error");
        adapter.signalExactProcess(turn.pid, turn.processIdentity, "SIGTERM");
        return;
      }
      if (!handle.protocolError) {
        handle.providerContinuationId = sessionId;
        turn.sawInit = true;
      }
    }
    return;
  }
  // Display projections require the exact session established by init.
  // Missing/foreign identities remain raw diagnostic evidence only.
  if (turn.sawInit && sessionId && sessionId === handle.providerContinuationId) {
    for (const projection of cursorLiveDisplayProjections(
      safeProviderPayload.payload,
      turn.controlTurnId,
      String(rawEventSequence),
    )) {
      if (projection.method === "item/toolCall/updated") {
        const callId = typeof projection.payload.callID === "string" ? projection.payload.callID : null;
        if (callId) {
          if (projection.payload.status === "running") {
            if (turn.liveDisplayTools.has(callId)) continue;
            turn.liveDisplayTools.set(callId, {
              tool: typeof projection.payload.tool === "string" ? projection.payload.tool : "tool",
              input: projection.payload.input ?? null,
              completed: false,
            });
          } else {
            const active = turn.liveDisplayTools.get(callId);
            if (!active || active.completed || active.tool !== projection.payload.tool) continue;
            active.completed = true;
          }
        }
      }
      adapter.publishStream(handle, projection.method, projection.payload, projection.kind);
    }
  }
  if (type === "result") {
    adapter.interruptLiveDisplayTools(handle, turn);
    turn.sawResult = true;
    turn.resultWasError = message.subtype !== "success" || message.is_error !== false;
    turn.resultText = typeof message.result === "string" ? message.result : null;
    turn.providerRequestId = typeof message.request_id === "string" && message.request_id.trim()
      ? message.request_id.trim()
      : null;
    return;
  }
  if (type === "assistant" || type === "tool_call" || type === "tool_use" || type === "user") {
    adapter.publishActivity(handle, {
      source: "native_harness",
      method: streamMethod(message),
      summary: `Processing ${streamMethod(message)}`,
      status: "working",
      checking: "",
      next_action: "",
    });
  }
}

export function interruptLiveDisplayTools(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turn: LiveTurn): void {
  for (const [callID, tool] of turn.liveDisplayTools) {
    if (tool.completed) continue;
    adapter.publishStream(handle, "item/toolCall/updated", {
      callID,
      tool: tool.tool,
      status: "interrupted",
      input: tool.input,
      output: null,
      error: null,
    }, "tool_lifecycle");
  }
  turn.liveDisplayTools.clear();
}

export function observeNativeExecution(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turn: LiveTurn, message: CursorStreamMessage, sessionId: string | null): NativeLifecycleCheckpoint | null {
  if (!sessionId || !nativeExecutionId(sessionId) || handle.protocolError) return null;
  const replay = turn.executionTerminalCheckpoint;
  if (replay) {
    return message.type === "result"
      && sessionId === replay.sessionId
      && message.subtype === replay.subtype
      && message.is_error === replay.isError
      ? replay.nativeLifecycle : null;
  }
  if (turn.executionTurnFinished) return null;
  const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact, turn.processIdentity, turn.pid);
  const nativeTurn = { providerContinuationId: sessionId, providerTurnId: turn.controlTurnId };
  if (message.type === "system" && message.subtype === "init" && !turn.sawInit) {
    const nativeLifecycle = nativeLifecycleCheckpoint({
      provider: adapter.id,
      workAttemptId: handle.workAttemptId,
      phase: "turn_active",
      providerContinuationId: sessionId,
      providerTurnId: turn.controlTurnId,
      nativeProcessPid: turn.pid,
      nativeProcessIdentity: turn.processIdentity,
    });
    turn.executionContinuationId = sessionId;
    emit({ domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" });
    emit({ domain: "control", kind: "state_changed", state: "unprobeable", sideEffects: "none" });
    emit({ domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
      nativeEventId: nativeLifecycle.nativeEventId, ...nativeTurn });
    return nativeLifecycle;
  }
  if (!turn.sawInit || sessionId !== handle.providerContinuationId) return null;
  if (message.type === "result") {
    if (typeof message.subtype !== "string" || !message.subtype
      || (message.subtype === "success" ? message.is_error !== false : message.is_error !== true)) return null;
    const nativeLifecycle = nativeLifecycleCheckpoint({
      provider: adapter.id,
      workAttemptId: handle.workAttemptId,
      phase: "turn_terminal",
      providerContinuationId: sessionId,
      providerTurnId: turn.controlTurnId,
      nativeProcessPid: turn.pid,
      nativeProcessIdentity: turn.processIdentity,
      terminalDiscriminator: `${message.subtype}:${message.is_error ? "error" : "ok"}`,
    });
    turn.executionTerminalCheckpoint = {
      sessionId,
      subtype: message.subtype,
      isError: message.is_error === true,
      nativeLifecycle,
    };
    return nativeLifecycle;
  }
  const nativeTool = cursorNativeToolEnvelope(message as Record<string, unknown>);
  if (!nativeTool) return null;
  const { executionId, subtype, tool, operation } = nativeTool;
  const identity = { domain: "execution" as const, executionId, operation, ...nativeTurn };
  const prior = turn.executionTools.get(executionId);
  if (subtype === "started" && !prior) {
    // Native toolCallStarted precedes permission/spawn outcomes. It proves
    // request identity, not that a process ran or a file was touched.
    turn.executionTools.set(executionId, { tool, completed: false });
  } else if (subtype === "completed" && prior && !prior.completed && prior.tool === tool) {
    const terminal = cursorNativeToolTerminalResult(nativeTool);
    if (!terminal) return null;
    prior.completed = true;
    emit({
      ...identity,
      kind: "completed",
      outcome: terminal.outcome,
      ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
      sideEffects: terminal.sideEffects,
    });
  }
  return null;
}

export function observeNativeExit(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turn: LiveTurn, exit: ProviderProcessExit): void {
  if (exit.type !== "exit") return;
  if (!turn.executionTurnFinished) {
    adapter.observeValidatedTurnTerminal(handle, turn, turn.interruptRequested
      ? "interrupted"
      : turn.sawResult && turn.executionTerminalCheckpoint
        ? turn.resultWasError ? "failed" : "completed"
        : "lost");
  }
  adapter.observeNativeRuntimeExit(handle, turn, exit);
}

export function observeValidatedTurnTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
  outcome: "completed" | "failed" | "interrupted" | "lost",
): void {
  if (turn.executionTurnFinished) return;
  const sessionId = turn.executionContinuationId ?? handle.providerContinuationId;
  if (nativeExecutionId(sessionId)) {
    const nativeLifecycle = turn.executionTerminalCheckpoint?.nativeLifecycle ?? nativeLifecycleCheckpoint({
      provider: adapter.id,
      workAttemptId: handle.workAttemptId,
      phase: "turn_terminal",
      providerContinuationId: sessionId,
      providerTurnId: turn.controlTurnId,
      nativeProcessPid: turn.pid,
      nativeProcessIdentity: turn.processIdentity,
      terminalDiscriminator: outcome,
    });
    handle.execution.emit(outcome === "lost"
      ? { domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none",
        providerContinuationId: sessionId, providerTurnId: turn.controlTurnId,
        nativeEventId: nativeLifecycle.nativeEventId }
      : { domain: "turn", kind: "state_changed", state: "terminal", turnOutcome: outcome,
        sideEffects: "none", providerContinuationId: sessionId, providerTurnId: turn.controlTurnId,
        nativeEventId: nativeLifecycle.nativeEventId }, turn.processIdentity, turn.pid);
  }
  turn.executionTools.clear();
  turn.executionTurnFinished = true;
}

export function observeNativeRuntimeExit(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turn: LiveTurn, exit: ProviderProcessExit): void {
  if (turn.executionRuntimeFinished) return;
  const controlEvidence = exit.type === "exit" ? "process_exit" as const : "native_session_terminated" as const;
  const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact, turn.processIdentity, turn.pid);
  emit({ domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence });
  emit({ domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence });
  turn.executionRuntimeFinished = true;
}

export function publishStream(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  method: string,
  providerPayload: unknown,
  kind: ProviderStreamEventKind,
): void {
  adapter.publishSafeStream(handle, method, safeStreamPayload(providerPayload), kind);
}

export function publishSafeStream(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  method: string,
  safe: ReturnType<typeof safeStreamPayload>,
  kind: ProviderStreamEventKind,
  nativeEventId: string | null = null,
  nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
): void {
  const event: ProviderStreamEvent = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    observedAt: adapter.deps.now(),
    sequence: ++handle.streamSequence,
    provider: adapter.id,
    kind,
    method,
    ...(handle.liveTurn?.processIdentity
      ? { nativeProcessIdentity: handle.liveTurn.processIdentity }
      : {}),
    ...(handle.liveTurn?.pid ? { nativeProcessPid: handle.liveTurn.pid } : {}),
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(nativeLifecyclePhase ? { nativeLifecyclePhase } : {}),
    ...safe,
    durablePayloadRef: null,
  };
  adapter.streamSink?.(event);
  for (const listener of handle.streamListeners) listener(event);
}

export function publishActivity(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
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
    observedAt: adapter.deps.now(),
    source: input.source,
    method: input.method,
    summary: input.summary,
    status: input.status,
    checking: input.checking,
    nextAction: input.next_action,
  };
  adapter.activitySink?.(event);
  for (const listener of handle.activityListeners) listener(event);
}
