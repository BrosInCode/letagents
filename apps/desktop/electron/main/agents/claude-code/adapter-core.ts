import { ClaudeCompaction } from "../claude-compaction.js";
import { randomUUID } from "node:crypto";
import { ProviderUsageTracker } from "../provider-usage.js";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { synthesizeTerminalPayload, type ProviderActivityEvent, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type ProviderRoomTurnResult, type ProviderStreamEvent, type ProviderStreamEventKind, type ProviderTerminalPayload } from "../provider-adapter.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import { ProviderProcessCustody, DEFAULT_STOP_GRACE_MS, errorMessage, safeStreamPayload, type ProviderProcessExit } from "../provider-evidence.js";
import { resolveClaudeCodeExecutable } from "../claude-code-version.js";
import { CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS, CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS, CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS } from "./background-work-text.js";
import { DEFAULT_DEPENDENCIES } from "./child-process.js";
import { ClaudeRoomTurnObservationDetachedError } from "./errors.js";
import { INIT_TIMEOUT_MS, RESUME_INIT_TIMEOUT_MS } from "./launch-args.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import type { ClaudeCodeProviderAdapterDependencies, ClaudeCodeProviderAdapterOptions, ClaudeRoomTurnTerminal, ClaudeStreamMessage } from "./types.js";

/** Adapter state and the helpers every layer of the Claude Code adapter shares. */
export class ClaudeAdapterCore {
  readonly id = "claude-code" as const;
  protected readonly claudeBin: string;
  protected readonly deps: ClaudeCodeProviderAdapterDependencies;
  protected readonly activitySink?: (event: ProviderActivityEvent) => void;
  protected readonly streamSink?: (event: ProviderStreamEvent) => void;
  protected readonly initTimeoutMs: number;
  protected readonly resumeInitTimeoutMs: number;
  protected readonly compactionTimeoutMs: number;
  protected readonly compactions = new Map<string, ClaudeCompaction>();
  protected readonly handleCompactions = new WeakMap<ClaudeProviderHandle, ClaudeCompaction>();
  protected readonly stopGraceMs: number;
  protected readonly backgroundSubagentWaitLimitMs: number;
  protected readonly backgroundCommandWaitLimitMs: number;
  protected readonly backgroundNoticeStartLimitMs: number;
  protected readonly backgroundWorkNoticeEveryMs: number;
  protected readonly handles = new Map<string, ClaudeProviderHandle>();
  protected readonly processCustody: ProviderProcessCustody;
  protected readonly pendingAttaches = new Map<string, {
    ref: ProviderContinuationRef;
    promise: Promise<ProviderHandle | ProviderAttachTerminal | null>;
  }>();
  protected readonly exitPromises = new WeakMap<ClaudeProviderHandle, Promise<ProviderTerminalPayload>>();

  constructor(options: ClaudeCodeProviderAdapterOptions = {}) {
    this.claudeBin = options.claudeBin || resolveClaudeCodeExecutable(desktopRuntimeEnvironment());
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.processCustody = new ProviderProcessCustody(this.deps);
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.resumeInitTimeoutMs = options.resumeInitTimeoutMs ?? options.initTimeoutMs ?? RESUME_INIT_TIMEOUT_MS;
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? 300_000;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.backgroundSubagentWaitLimitMs = options.backgroundSubagentWaitLimitMs ?? CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS;
    this.backgroundCommandWaitLimitMs = options.backgroundCommandWaitLimitMs ?? CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS;
    this.backgroundNoticeStartLimitMs = options.backgroundNoticeStartLimitMs ?? CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS;
    this.backgroundWorkNoticeEveryMs = options.backgroundWorkNoticeEveryMs ?? 60_000;
  }

  protected readonly usage = new WeakMap<ClaudeProviderHandle, ProviderUsageTracker>();

  /** The room turn that the CLI is running, once it has reported the command as started. */
  protected runningRoomTurn(handle: ClaudeProviderHandle): string | null {
    const turnId = handle.activeRoomTurnId;
    return turnId && !handle.heldRoomTurn && handle.executionTurnStarted && handle.executionTurnId === turnId ? turnId : null;
  }

  /**
   * Ask the CLI to stop what it runs: a turn, the answer to a task's notice, and a sub-agent in the background.
   * A command in the background goes on (each captured).
   */
  protected writeInterrupt(handle: ClaudeProviderHandle): void {
    handle.child.writeLine(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }));
  }

  protected waitForNextTurnResult(handle: ClaudeProviderHandle): Promise<ClaudeStreamMessage> {
    return new Promise<ClaudeStreamMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.turnResultWaiters.delete(done);
        reject(new Error("Claude did not prove the active turn reached an interrupted boundary."));
      }, 10_000);
      const done = (message: ClaudeStreamMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      handle.turnResultWaiters.add(done);
    });
  }

  protected waitForExactRoomTurn(
    handle: ClaudeProviderHandle,
    turnId: string,
    detachSignal?: AbortSignal,
  ): Promise<ClaudeRoomTurnTerminal> {
    const cached = handle.roomTurnResults.get(turnId);
    if (cached) return Promise.resolve(cached);
    if (detachSignal?.aborted) {
      return Promise.reject(new ClaudeRoomTurnObservationDetachedError("Claude room-turn observation detached."));
    }
    return new Promise<ClaudeRoomTurnTerminal>((resolve, reject) => {
      const waiters = handle.roomTurnWaiters.get(turnId) ?? new Set();
      let entry: {
        resolve: (result: ClaudeRoomTurnTerminal) => void;
        reject: (error: Error) => void;
      };
      const cleanup = () => {
        detachSignal?.removeEventListener("abort", detached);
        const current = handle.roomTurnWaiters.get(turnId);
        current?.delete(entry);
        if (current?.size === 0) handle.roomTurnWaiters.delete(turnId);
      };
      const detached = () => {
        cleanup();
        reject(new ClaudeRoomTurnObservationDetachedError("Claude room-turn observation detached."));
      };
      entry = {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      waiters.add(entry);
      handle.roomTurnWaiters.set(turnId, waiters);
      detachSignal?.addEventListener("abort", detached, { once: true });
    });
  }

  protected removeExactRoomTurnWaiters(
    handle: ClaudeProviderHandle,
    turnId: string,
    error: unknown,
  ): void {
    const waiters = [...(handle.roomTurnWaiters.get(turnId) ?? [])];
    for (const waiter of waiters) {
      waiter.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  protected providerRoomTurnResult(handle: ClaudeProviderHandle, terminal: ClaudeRoomTurnTerminal): ProviderRoomTurnResult {
    if ("error" in terminal) {
      return { turnId: terminal.turnId, providerContinuationId: handle.providerContinuationId,
        outcome: terminal.nativeOutcome, text: null, evidence: "stream",
        error: String(safeStreamPayload(terminal.error).payload).slice(0, 2000),
        ...(terminal.unrecognizedResult ? { unrecognizedResult: true as const } : {}),
        ...(terminal.apiFailure ? { claudeApiFailure: terminal.apiFailure } : {}),
        ...(terminal.refusal ? { refusal: true as const } : {}) };
    }
    if (terminal.outcome === "reply") {
      return {
        turnId: terminal.turnId,
        outcome: "reply",
        text: terminal.text,
        evidence: terminal.evidence,
      };
    }
    if (terminal.outcome === "no_reply") {
      return {
        turnId: terminal.turnId,
        outcome: "no_reply",
        text: null,
        evidence: terminal.evidence,
      };
    }
    return { turnId: terminal.turnId, outcome: "unreadable", text: null, evidence: "none" };
  }

  protected publishStream(
    handle: ClaudeProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
    nativeEventId: string | null = null,
    nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
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
      ...(nativeEventId ? { nativeEventId } : {}),
      ...(nativeLifecyclePhase ? { nativeLifecyclePhase } : {}),
      ...(summary ? { summary } : {}),
      ...safe,
      durablePayloadRef: null,
    };
    this.streamSink?.(event);
    for (const listener of handle.streamListeners) listener(event);
  }

  protected publishActivity(
    handle: ClaudeProviderHandle,
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

  protected observeExit(
    handle: ClaudeProviderHandle,
    exit: ProviderProcessExit,
  ): ProviderTerminalPayload {
    handle.pendingInterruptTurnId = null;
    handle.contextualInterruptTerminalTurnId = null;
    handle.permissionControlAvailable = false;
    handle.clearPermissions();
    // A turn that was held open ends like any turn the process ended under: its waiters are told below, and
    // the session is read for it. That gives the turn's own answer with the answers to the notices of its work
    // that the session holds, and one line when the session does not prove that reply complete.
    const held = handle.heldRoomTurn;
    if (held) {
      handle.heldRoomTurn = null;
      clearInterval(held.notice);
      if (held.wake) clearTimeout(held.wake);
    }
    if (exit.type === "exit") {
      handle.executionExitObserved = true;
      const identity = handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined;
      const pid = handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined;
      if (handle.executionTurnId && nativeExecutionId(handle.providerContinuationId)) {
        handle.execution.emit({ domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none",
          providerContinuationId: handle.providerContinuationId, providerTurnId: handle.executionTurnId }, identity, pid);
        handle.executionTurnId = null;
        handle.executionTurnStarted = false;
        handle.executionTools.clear();
      }
      handle.execution.emit({ domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" }, identity, pid);
      handle.execution.emit({ domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence: "process_exit" }, identity, pid);
    }
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
    if (exit.type === "exit" && handle.providerConnection.kind === "claude_cli"
      && handle.providerConnection.pid && handle.providerConnection.processIdentity) {
      (terminal as ProviderTerminalPayload).nativeRuntimeDeath = { kind: "claude_cli",
        pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity };
    }
    if (handle.protocolError) terminal.terminalCause = "protocol_error";
    handle.terminal = terminal;
    handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
      ? "stopped"
      : "failed";
    handle.child.markIntentionalClose();
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.handles.delete(handle.workAttemptId);
    }
    for (const turnId of [...handle.roomTurnWaiters.keys()]) {
      this.removeExactRoomTurnWaiters(
        handle,
        turnId,
        new Error(`Claude exited before bounded room turn ${turnId} reached a terminal boundary.`),
      );
    }
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
    return terminal;
  }

  protected requireHandle(handle: ProviderHandle): ClaudeProviderHandle {
    if (!(handle instanceof ClaudeProviderHandle)) {
      throw new Error("Provider handle does not belong to ClaudeCodeProviderAdapter.");
    }
    return handle;
  }

  protected requireExitPromise(handle: ClaudeProviderHandle): Promise<ProviderTerminalPayload> {
    const promise = this.exitPromises.get(handle);
    if (!promise) throw new Error("Claude provider handle is missing its exit observation.");
    return promise;
  }
}
