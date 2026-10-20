/** Session ordering checks and waiting for one exact OpenCode turn to end, abort or go idle. */
import { NO_REPLY_FAILURE } from "../../../../../../shared/room-turn-no-reply.mjs";
import { ProviderContinuationMissingError, type ProviderRoomTurnResult } from "../provider-adapter.js";
import { delay } from "../provider-evidence.js";
import type { TurnOutcome } from "../../../../shared/execution-protocol.js";
import { assistantsFor, eventReferencesSession, finalAssistantFor, messageCompleted, messageError, messageFinishReason, messageText, nativelyOrderedMessageId, OpenCodeServerClient, record, turnUserMessageIds, type JsonRecord, type OpenCodeEvent, type OpenCodeMessage } from "../opencode-server-client.js";
import { MAX_CONSECUTIVE_DENIED_STEPS, TOOL_CALLS_UNFINISHED, type TurnStep, classifyTurn, deniedToolState, unansweredCompletionReason, unfinishedToolCalls } from "./turn-results.js";
import { OpenCodeBoundedTurnError, OpenCodeTerminalTurnError, openCodeRetryStatus, safeProviderErrorMessage } from "./errors.js";
import { OpenModelAdapterBase } from "./adapter-base.js";
import { OpenModelHandle } from "./handle.js";
import { SESSION_ORDERING_SCAN_LIMIT } from "./types.js";
import { nextEventBefore, resolveBeforeDeadline } from "./runtime-launch.js";

export abstract class OpenModelAdapterTurnWait extends OpenModelAdapterBase {
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
}
