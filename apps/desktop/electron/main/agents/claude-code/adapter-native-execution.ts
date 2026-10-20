import { claudeToolOperation } from "../../../../../../shared/claude-tool-operation.mjs";
import type { NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { nativeExecutionId, nativeLifecycleCheckpoint, type NativeLifecycleCheckpoint } from "../provider-execution-observer.js";
import { ClaudeAdapterCore } from "./adapter-core.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import { claudeTerminalDiscriminator, sessionIdOf } from "./stream-messages.js";
import type { ClaudeStreamMessage } from "./types.js";

/** Native execution facts: exact turn lifecycle, tool correlation and permission closure. */
export class ClaudeAdapterNativeExecution extends ClaudeAdapterCore {
  protected closePermission(handle: ClaudeProviderHandle, id: string): void {
    const pending = handle.permissionRequests.get(id) ?? handle.permissionClosures.get(id);
    if (!pending || this.handles.get(handle.workAttemptId) !== handle || !handle.permissionControlAvailable
      || handle.providerConnection.kind !== "claude_cli" || !handle.providerConnection.processIdentity
      || this.deps.getProcessIdentity(handle.pid!) !== handle.providerConnection.processIdentity) return;
    handle.permissionClosures.delete(id);
    handle.permissionRequests.delete(id);
    const event = { type: "request_closed" as const, request: structuredClone(pending.native),
      providerContinuationId: handle.providerContinuationId, providerTurnId: pending.turnId };
    for (const listener of handle.permissionClosureListeners) {
      try { listener(event); } catch { /* Closure is observation, never a decision. */ }
    }
    handle.permissionsChanged();
  }

  protected contextualInterruptTurnId(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
  ): string | null {
    const turnId = handle.pendingInterruptTurnId;
    // Delivery may detach/recover its waiter while this native turn stays live.
    // Its transient roomTurnOperationId is not native interruption authority.
    if (!turnId
      || handle.activeRoomTurnId !== turnId
      || handle.executionTurnId !== turnId
      || message.type !== "result"
      || sessionIdOf(message) !== handle.providerContinuationId
      || message.subtype !== "error_during_execution"
      || message.is_error !== true
      || !(message.terminal_reason === "aborted_streaming" && message.user_message_uuid == null
        || ["aborted_streaming", "aborted_tools"].includes(String(message.terminal_reason)) && message.user_message_uuid === turnId)) return null;
    return turnId;
  }

  protected contextualInterruptReplayTurnId(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
  ): string | null {
    const turnId = handle.contextualInterruptTerminalTurnId;
    if (!turnId
      || handle.activeRoomTurnId !== null
      || handle.executionTurnId !== null
      || message.type !== "result"
      || sessionIdOf(message) !== handle.providerContinuationId
      || message.subtype !== "error_during_execution"
      || message.is_error !== true
      || !(message.terminal_reason === "aborted_streaming" && message.user_message_uuid == null
        || ["aborted_streaming", "aborted_tools"].includes(String(message.terminal_reason)) && message.user_message_uuid === turnId)) return null;
    return turnId;
  }

  protected observeNativeExecution(
    handle: ClaudeProviderHandle,
    message: ClaudeStreamMessage,
    contextualInterruptTurnId: string | null = null,
    contextualInterruptReplayTurnId: string | null = null,
  ): NativeLifecycleCheckpoint | null {
    const replay = handle.executionTerminalCheckpoint;
    if (message.type === "result" && replay
      && message.session_id === handle.providerContinuationId
      && (message.user_message_uuid === replay.providerTurnId
        || contextualInterruptReplayTurnId === replay.providerTurnId)
      && claudeTerminalDiscriminator(message) === replay.terminalDiscriminator) {
      return replay.nativeLifecycle;
    }
    const turnId = handle.executionTurnId;
    if (!turnId || message.session_id !== handle.providerContinuationId
      || !nativeExecutionId(handle.providerContinuationId)) return null;
    const emit = (fact: NativeExecutionFact) => handle.execution.emit(fact,
      handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.processIdentity ?? undefined : undefined,
      handle.providerConnection.kind === "claude_cli" ? handle.providerConnection.pid ?? undefined : undefined);
    const turn = { providerTurnId: turnId, providerContinuationId: handle.providerContinuationId };
    // command_uuid names the user turn, never a shell command. Only an exact
    // native started event proves receipt; writing stdin alone is insufficient.
    if (message.type === "command_lifecycle" && message.command_uuid === turnId && message.state === "started") {
      const nativeLifecycle = nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_active",
        providerContinuationId: handle.providerContinuationId,
        providerTurnId: turnId,
        nativeProcessPid: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.pid ?? undefined : undefined,
        nativeProcessIdentity: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.processIdentity ?? undefined : undefined,
      });
      if (!handle.executionTurnStarted) {
        handle.executionTurnStarted = true;
        emit({ domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
          nativeEventId: nativeLifecycle.nativeEventId, ...turn });
      }
      return nativeLifecycle;
    } else if (message.type === "result"
      && (message.user_message_uuid === turnId || contextualInterruptTurnId === turnId)) {
      const hasLegacyTerminalShape = typeof message.subtype === "string" && Boolean(message.subtype)
        && (message.subtype === "success" ? typeof message.is_error === "boolean" : message.is_error === true);
      if (handle.lifecycleAuthorityMode !== "typed" && !hasLegacyTerminalShape) return null;
      const terminalDiscriminator = claudeTerminalDiscriminator(message);
      const subtype = typeof message.subtype === "string" ? message.subtype.toLowerCase() : "";
      const turnOutcome = contextualInterruptTurnId === turnId || subtype === "interrupted" ? "interrupted"
        : subtype === "success" && message.is_error === false ? "completed" : "failed";
      const nativeLifecycle = nativeLifecycleCheckpoint({
        provider: this.id,
        workAttemptId: handle.workAttemptId,
        phase: "turn_terminal",
        providerContinuationId: handle.providerContinuationId,
        providerTurnId: turnId,
        nativeProcessPid: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.pid ?? undefined : undefined,
        nativeProcessIdentity: handle.providerConnection.kind === "claude_cli"
          ? handle.providerConnection.processIdentity ?? undefined : undefined,
        terminalDiscriminator,
      });
      emit({ domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none", ...turn,
        nativeEventId: nativeLifecycle.nativeEventId,
        turnOutcome });
      handle.executionTerminalCheckpoint = {
        providerTurnId: turnId,
        terminalDiscriminator,
        nativeLifecycle,
      };
      for (const [id, pending] of new Map([...handle.permissionClosures, ...handle.permissionRequests])) {
        if (pending.turnId === turnId) this.closePermission(handle, id);
      }
      handle.executionTurnId = null;
      handle.executionTurnStarted = false;
      handle.executionTools.clear();
      handle.clearPermissions();
      return nativeLifecycle;
    } else if (handle.executionTurnStarted && (message.type === "assistant" || message.type === "user")
      && message.parent_tool_use_id == null
      && (message.user_message_uuid == null || message.user_message_uuid === turnId)) {
      // Tool messages carry session/tool identity, not the caller's turn UUID.
      // Do not attribute a bootstrap or previous-turn tail before exact receipt.
      const body = message.message as { content?: unknown } | undefined;
      if (!Array.isArray(body?.content)) return null;
      for (const value of body.content) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const block = value as Record<string, unknown>;
        if (message.type === "assistant" && block.type === "tool_use" && nativeExecutionId(block.id)
          && typeof block.name === "string" && !handle.executionTools.has(block.id)) {
          // Tool requests precede permission. Record correlation only, never
          // claim execution.started (nor expose agent-authored input/text).
          const operation = claudeToolOperation(block.name);
          handle.executionTools.set(block.id, { operation, completed: false, name: block.name, input: structuredClone(block.input) });
        } else if (message.type === "user" && block.type === "tool_result" && nativeExecutionId(block.tool_use_id)) {
          const tool = handle.executionTools.get(block.tool_use_id);
          if (!tool || tool.completed || (block.is_error !== undefined && typeof block.is_error !== "boolean")
            || (typeof block.content !== "string" && !Array.isArray(block.content))) continue;
          tool.completed = true;
          for (const [id, pending] of new Map([...handle.permissionClosures, ...handle.permissionRequests])) {
            if (pending.turnId === turnId && pending.native.request.tool_use_id === block.tool_use_id) this.closePermission(handle, id);
          }
          // The host denied this exact tool and Claude reports it as an error: the tool never ran. Any other
          // error result stays a generic failure, which cannot say what became of an approval.
          const denied = tool.hostDenied === true && block.is_error === true;
          emit({ domain: "execution", kind: "completed", executionId: block.tool_use_id, operation: tool.operation,
            outcome: denied ? "denied_before_start" : block.is_error === true ? "failed" : "succeeded",
            sideEffects: denied || tool.operation === "file_read" ? "none" : "possible", ...turn });
        }
      }
    }
    return null;
  }
}
