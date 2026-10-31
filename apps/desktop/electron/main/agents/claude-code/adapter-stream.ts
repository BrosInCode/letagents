import { isDeepStrictEqual } from "node:util";
import type { ClaudeNativePermissionRequest } from "../../../../shared/provider-permissions.js";
import { ProviderUsageTracker } from "../provider-usage.js";
import { claudeApiErrorCategory, claudeUsageLimitRejected, exactClaudeStreamTerminal } from "../claude-room-turn-evidence.js";
import { ClaudeAdapterBackgroundWork } from "./adapter-background-work.js";
import { shownName } from "./launch-args.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import { assistantTextOf, claudeStreamKind, isClaudeFailedResult, isClaudeTaskNoticeResult, isClaudeTurnLimitResult, parseStreamLine, sessionIdOf, streamMethod, unanswerableClaudeRequest } from "./stream-messages.js";
import type { ClaudeStreamMessage } from "./types.js";

/** Each stdout stream-json line, and each native control request, as the adapter consumes it. */
export class ClaudeAdapterStream extends ClaudeAdapterBackgroundWork {
  protected consumePermission(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): void {
    if (typeof message.request_id !== "string" || !message.request_id.trim() || message.request_id.length > 512) return;
    if (message.type === "control_cancel_request") {
      handle.seenPermissionRequestIds.add(message.request_id);
      this.closePermission(handle, message.request_id);
      return;
    }
    const unanswerable = unanswerableClaudeRequest(message.request);
    if (unanswerable) {
      try {
        handle.child.writeLine(JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: message.request_id, response: unanswerable.response,
        } }));
      } catch { return; /* The CLI is gone; its exit is observed separately. */ }
      // The owner sees in the agent's activity that something was turned down, and whose it was.
      // The daemon builds an agent's activity from its stream, so that is where it is said.
      this.publishStream(handle, "control_request/declined", {}, "provider_event", null, null, unanswerable.summary);
      this.heldRoomTurnPublished(handle);
      return;
    }
    const request = message.request as ClaudeNativePermissionRequest["request"] | undefined;
    const turnId = handle.activeRoomTurnId;
    if (!request || request.agent_id != null || request.subtype !== "can_use_tool"
      || typeof request.tool_name !== "string" || !request.tool_name.trim()
      || typeof request.tool_use_id !== "string" || !request.tool_use_id.trim()
      || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) return;
    if (!turnId || handle.executionTurnId !== turnId || !handle.executionTurnStarted) {
      // No room turn has started, so no approval can be shown: an approval belongs to a turn. This is the answer
      // to the notice of a task whose turn has ended. The CLI would wait for it, and the next prompt behind it.
      try {
        handle.child.writeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
          response: { behavior: "deny", message: "No room turn is open that an approval could be shown for, so this action was not allowed." } } }));
      } catch { return; /* The CLI is gone; its exit is observed separately. */ }
      handle.seenPermissionRequestIds.add(message.request_id);
      this.publishStream(handle, "control_request/declined", {}, "provider_event", null, null,
        `Did not allow the tool ${shownName(request.tool_name)}, which Claude asked for outside a room turn. LetAgents shows an approval only for a turn that is open.`);
      return;
    }
    const native = { id: message.request_id, request: structuredClone(request) };
    const prior = handle.permissionRequests.get(native.id);
    if (prior) {
      // Reused IDs with different payloads are ambiguous and cannot inherit approval.
      if (!isDeepStrictEqual(prior.native, native)) { handle.permissionControlAvailable = false; handle.clearPermissions(); }
      return;
    }
    if (handle.seenPermissionRequestIds.has(native.id)) return;
    handle.seenPermissionRequestIds.add(native.id);
    handle.permissionRequests.set(native.id, { native, turnId, dispatching: false });
    handle.permissionClosures.set(native.id, { native, turnId });
    while (handle.permissionClosures.size > 64) handle.permissionClosures.delete(handle.permissionClosures.keys().next().value!);
    handle.permissionsChanged();
  }

  protected consumeLine(handle: ClaudeProviderHandle, line: string): void {
    const message = parseStreamLine(line);
    if (!message) {
      this.publishStream(handle, "stdout/raw", { line }, "provider_event");
      this.heldRoomTurnPublished(handle);
      return;
    }
    let usage = this.usage.get(handle);
    if (!usage) { usage = new ProviderUsageTracker(handle.providerContinuationId); this.usage.set(handle, usage); }
    usage.snapshot(handle.providerContinuationId);
    usage.claude(message, this.deps.now());
    this.handleCompactions.get(handle)?.observe(message);
    if (message.type === "system" && message.session_id === handle.providerContinuationId && message.parent_tool_use_id == null
      && (message.subtype === "compact_boundary" || (message.subtype === "status"
        && (message.status === "compacting" || message.compact_result === "success" || message.compact_result === "failed")))) {
      handle.roomContext.reset();
    }
    // Native approval payloads stay host-ephemeral; do not publish them to room activity.
    if (message.type === "control_request" || message.type === "control_cancel_request") {
      this.consumePermission(handle, message);
      return;
    }
    const contextualInterruptTurnId = this.contextualInterruptTurnId(handle, message);
    const contextualInterruptReplayTurnId = contextualInterruptTurnId
      ? null
      : this.contextualInterruptReplayTurnId(handle, message);
    if (contextualInterruptTurnId) handle.contextualInterruptResults.add(message);
    let backgroundWork: "same" | "changed" | "tell" = "same";
    if (handle.state !== "failed") {
      backgroundWork = this.observeBackgroundWork(handle, message);
      if (isClaudeTaskNoticeResult(message, handle.providerContinuationId)) {
        // The answer that ends here, or goes on, was given the notice that was first in line.
        const taskId = handle.taskNotices.shift();
        if (taskId !== undefined) handle.noticeAnswerTasks.push(taskId);
        if (!contextualInterruptTurnId && !contextualInterruptReplayTurnId) {
          this.consumeTaskNoticeResult(handle, message);
          return;
        }
        // An interrupt that the owner sent for the running turn can end this answer instead. That stays as it was.
        for (const answered of handle.noticeAnswerTasks.splice(0)) handle.backgroundTasks.delete(answered);
      } else if (this.holdRoomTurn(handle, message)) return;
    }
    const nativeLifecycle = this.observeNativeExecution(
      handle,
      message,
      contextualInterruptTurnId,
      contextualInterruptReplayTurnId,
    );
    // While a turn is held open, what it waits for is what the owner reads: the rows of a sub-agent, and of
    // an answer to a notice, are published as events that Chat does not show in the place of the wait.
    const held = handle.heldRoomTurn;
    const row = message.type === "assistant" || message.type === "user" || message.type === "tool_use_summary";
    this.publishStream(handle, streamMethod(message), message, held && row ? "provider_event" : claudeStreamKind(message),
      nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
    // The line is published first: what it means for a turn that is held open comes after it.
    this.heldRoomTurnPublished(handle, backgroundWork);
    if (nativeLifecycle?.phase === "turn_terminal") this.handleCompactions.get(handle)?.clear();
    const typedAuthority = handle.lifecycleAuthorityMode === "typed";
    if (typedAuthority && nativeLifecycle?.phase === "turn_active") handle.state = "working";
    if (typedAuthority && nativeLifecycle?.phase === "turn_terminal") handle.state = "idle";
    const type = typeof message.type === "string" ? message.type : "";
    if (handle.state === "failed") return;
    // Claude names an API error on the assistant row that carries its text. The row comes before the
    // result, and does not always name its command; the result that follows does.
    const apiErrorCategory = claudeApiErrorCategory(message, handle.providerContinuationId);
    if (apiErrorCategory && handle.activeRoomTurnId
      && (message.user_message_uuid == null || message.user_message_uuid === handle.activeRoomTurnId)) {
      handle.roomTurnApiError = { turnId: handle.activeRoomTurnId, category: apiErrorCategory };
    }
    if (handle.activeRoomTurnId && claudeUsageLimitRejected(message, handle.providerContinuationId)) handle.roomTurnUsageLimit = handle.activeRoomTurnId;
    if (type === "result") {
      const exactTurnId = typeof message.user_message_uuid === "string"
        ? message.user_message_uuid.trim()
        : contextualInterruptTurnId ?? "";
      let exactTurnFailed = false;
      if (exactTurnId) {
        const terminal = contextualInterruptTurnId
          ? { turnId: contextualInterruptTurnId, nativeOutcome: "interrupted" as const, error: "Claude command ended interrupted." }
          : exactClaudeStreamTerminal(message, exactTurnId, handle.providerContinuationId,
            handle.roomTurnApiError?.turnId === exactTurnId ? handle.roomTurnApiError.category : null,
            handle.roomTurnUsageLimit === exactTurnId);
        if (terminal) {
          exactTurnFailed = "error" in terminal && handle.activeRoomTurnId === exactTurnId;
          handle.roomTurnResults.set(exactTurnId, terminal);
          if (!("error" in terminal) && terminal.outcome === "unreadable") handle.roomTurnsWithoutAnswer.add(exactTurnId);
          if (handle.activeRoomTurnId === exactTurnId) handle.activeRoomTurnId = null;
          if (handle.pendingInterruptTurnId === exactTurnId) handle.pendingInterruptTurnId = null;
          if (contextualInterruptTurnId === exactTurnId) {
            handle.contextualInterruptTerminalTurnId = exactTurnId;
          }
          const exactWaiters = [...(handle.roomTurnWaiters.get(exactTurnId) ?? [])];
          for (const waiter of exactWaiters) waiter.resolve(terminal);
        }
      }
      const exactInterrupted = Boolean(contextualInterruptTurnId || contextualInterruptReplayTurnId)
        || (typeof message.subtype === "string"
          && message.subtype.toLowerCase() === "interrupted"
          && sessionIdOf(message) === handle.providerContinuationId);
      if (handle.turnResultWaiters.size) {
        const waiters = [...handle.turnResultWaiters];
        handle.turnResultWaiters.clear();
        for (const resolve of waiters) resolve(message);
      }
      if (exactInterrupted) {
        if (!typedAuthority) handle.state = "idle";
        this.publishActivity(handle, {
          source: "native_harness",
          method: streamMethod(message),
          summary: "Turn interrupted",
          status: "idle",
          checking: "",
          next_action: "awaiting redirected work",
        });
        return;
      }
      if (isClaudeFailedResult(message) || (typedAuthority && exactTurnFailed)) {
        const turnLimited = isClaudeTurnLimitResult(message);
        if (!typedAuthority) handle.state = turnLimited || exactTurnFailed ? "idle" : "failed";
        this.publishActivity(handle, {
          source: "native_harness",
          method: streamMethod(message),
          summary: "Turn failed",
          status: "blocked",
          checking: "Claude Code reported a terminal turn failure.",
          next_action: turnLimited ? "Awaiting next room work." : "Awaiting supervised recovery.",
        });
        return;
      }
      if (!typedAuthority) handle.state = "idle";
      this.publishActivity(handle, {
        source: "native_harness",
        method: streamMethod(message),
        summary: "Turn completed",
        status: "idle",
        checking: "",
        next_action: "awaiting next room work",
      });
      return;
    }
    if (type === "assistant" || type === "user" || type === "tool_use_summary") {
      if (!typedAuthority) handle.state = "working";
      const text = type === "assistant" ? assistantTextOf(message) : null;
      this.publishActivity(handle, {
        source: "native_harness",
        method: streamMethod(message),
        summary: text ? text.slice(0, 240) : `Processing ${streamMethod(message)}`,
        status: "working",
        checking: "",
        next_action: "",
      });
    }
  }
}
