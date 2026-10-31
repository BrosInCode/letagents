import { safeStreamPayload } from "../provider-evidence.js";
import { exactClaudeStreamTerminal } from "../claude-room-turn-evidence.js";
import { ClaudeAdapterNativeExecution } from "./adapter-native-execution.js";
import { CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_FINISHED_METHOD, CLAUDE_BACKGROUND_WORK_METHOD, CLAUDE_BACKGROUND_WORK_NOTICE_EVERY_LINES, CLAUDE_BACKGROUND_WORK_TEXT, claudeBackgroundWorkWaitSummary } from "./background-work-text.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import { claudeStreamKind, sessionIdOf, shownTaskDescription, streamMethod } from "./stream-messages.js";
import type { ClaudeHeldRoomTurn, ClaudeRoomTurnTerminal, ClaudeStreamMessage } from "./types.js";

/** Room turns that stay open for background work they started. */
export class ClaudeAdapterBackgroundWork extends ClaudeAdapterNativeExecution {
  /**
   * Follow the background work of the CLI: what started, what ended, and what the model has been told. Says
   * whether this changed what a turn that is held open waits for, and whether its owner is to be told again.
   */
  protected observeBackgroundWork(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): "same" | "changed" | "tell" {
    if (sessionIdOf(message) !== handle.providerContinuationId || message.parent_tool_use_id != null) return "same";
    const held = handle.heldRoomTurn;
    let added = false;
    const remember = (task: Record<string, unknown>) => {
      if (typeof task.task_id !== "string" || !task.task_id || task.task_id.length > 128 || handle.backgroundTasks.has(task.task_id)) return;
      if (handle.backgroundTasks.size >= 256) handle.backgroundTasks.delete(handle.backgroundTasks.keys().next().value!);
      // Work that the answer to a notice starts belongs to the turn that is held open for that notice.
      handle.backgroundTasks.set(task.task_id, { turnId: held?.turnId ?? this.runningRoomTurn(handle),
        description: shownTaskDescription(task.description), type: task.task_type, sinceMs: Date.parse(this.deps.now()) });
      added = true;
    };
    if (message.type === "assistant" || message.type === "user") {
      if (message.type === "user") {
        // The turn that is running goes on, and its next request to the model takes every notice that waits
        // (captured for a tool's result; taken to hold for each row that the CLI adds to a turn, because a
        // notice that is wrongly waited for holds its turn open).
        if (this.runningRoomTurn(handle)) {
          // The room turn took them: its own answer is the answer to them.
          for (const taskId of handle.taskNotices.splice(0)) handle.backgroundTasks.delete(taskId);
        } else {
          // The answer to a notice took them. Its own notice stays the first in line until its result.
          handle.noticeAnswerTasks.push(...handle.taskNotices.splice(1));
        }
      }
      // While a turn is held open, only the answer to a notice writes these rows: it has begun.
      if (held) held.answering = true;
      return held ? "changed" : "same";
    }
    if (message.type !== "system") return "same";
    if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      for (const task of message.tasks) if (task && typeof task === "object") remember(task as Record<string, unknown>);
    } else if (message.subtype === "task_started" && message.is_backgrounded === true) {
      remember(message);
    } else if (message.subtype === "task_notification" && typeof message.task_id === "string") {
      const task = handle.backgroundTasks.get(message.task_id);
      // A task that ran inside its tool call reported to the model there, and is not known here.
      if (!task) return "same";
      // The model is not told of a command that was stopped. It is told of a sub-agent that was stopped on
      // request, and not of one that an interrupt stopped (each captured). The two look the same here. An
      // interrupt comes only from this adapter, when a turn ends. So work that was stopped when its turn is
      // not open any more was stopped by that interrupt, or by the model in a later request, which takes the
      // notice itself. No answer to this notice follows: it is not put in line, where it would stand before
      // the notice of a later turn's work. In its own open turn it is put in line, for the turn's next request.
      const open = held?.turnId ?? this.runningRoomTurn(handle);
      if (message.status === "stopped" && (task.type === "local_bash" || !(open && task.turnId === open))) handle.backgroundTasks.delete(message.task_id);
      else if (handle.taskNotices.push(message.task_id) > 256) handle.taskNotices.shift();
      return held && task.turnId === held.turnId ? "tell" : "changed";
    }
    return added && held ? "tell" : "same";
  }

  /**
   * The work of the held turn that the model has not answered about. Work that still runs keeps the turn open
   * until `waitsUntilMs`: the limit of its kind, counted from the turn's own result, or from the start of work
   * that began later.
   */
  protected heldRoomTurnWork(handle: ClaudeProviderHandle, held: ClaudeHeldRoomTurn): Array<{ description: string; kind: "subagent" | "command" | "other"; running: boolean; waitsUntilMs: number }> {
    return [...handle.backgroundTasks].filter(([, task]) => task.turnId === held.turnId).map(([taskId, task]) => {
      const kind = task.type === "local_agent" ? "subagent" as const : task.type === "local_bash" ? "command" as const : "other" as const;
      return { description: task.description, kind, running: !handle.taskNotices.includes(taskId) && !handle.noticeAnswerTasks.includes(taskId),
        waitsUntilMs: Math.max(held.sinceMs, task.sinceMs) + (kind === "subagent" ? this.backgroundSubagentWaitLimitMs : this.backgroundCommandWaitLimitMs) };
    });
  }

  /** The turn's own result has arrived. Keep the turn open when work that it started has not been reported to the model. */
  protected holdRoomTurn(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): boolean {
    const turnId = handle.activeRoomTurnId;
    // A turn that the owner is stopping ends as it did before.
    if (!turnId || handle.heldRoomTurn || message.type !== "result" || message.user_message_uuid !== turnId
      || handle.pendingInterruptTurnId === turnId
      || ![...handle.backgroundTasks.values()].some((task) => task.turnId === turnId)) return false;
    const own = exactClaudeStreamTerminal(message, turnId, handle.providerContinuationId);
    // Only an answer is held, or the model's word that it has none. A turn that failed ends as it did before.
    if (!own || "error" in own || own.outcome === "unreadable") return false;
    const held: ClaudeHeldRoomTurn = {
      turnId, result: message, answers: own.outcome === "reply" ? [own.text] : [], sinceMs: Date.parse(this.deps.now()),
      answering: false, answerDueSinceMs: null, endedSinceMs: null, linesSinceNotice: 0, wake: null,
      notice: setInterval(() => this.heldRoomTurnChanged(handle, true), this.backgroundWorkNoticeEveryMs),
    };
    // A wait must not keep a process alive that has nothing else to do.
    held.notice.unref?.();
    handle.heldRoomTurn = held;
    if (handle.lifecycleAuthorityMode !== "typed") handle.state = "working";
    this.heldRoomTurnChanged(handle, true);
    return true;
  }

  /**
   * Look at the held turn again: after its work changed, when a limit is reached, and at a fixed pace. The
   * turn ends when no work keeps it open. With `tell`, a turn that stays open says again what it waits for.
   */
  protected heldRoomTurnChanged(handle: ClaudeProviderHandle, tell = false): void {
    const held = handle.heldRoomTurn;
    if (!held) return;
    const now = Date.parse(this.deps.now());
    const work = this.heldRoomTurnWork(handle, held);
    // Work that still runs keeps the turn open up to its limit. Work that has ended keeps it open for the answer.
    const waitsFor = work.filter((task) => !task.running || now < task.waitsUntilMs);
    const lastMs = held.sinceMs + this.backgroundSubagentWaitLimitMs;
    if (!waitsFor.length || now >= lastMs) {
      this.settleHeldRoomTurn(handle, held, work.length ? "limit" : "answered");
      return;
    }
    const runs = waitsFor.some((task) => task.running);
    held.endedSinceMs = runs ? null : held.endedSinceMs ?? now;
    // All of it has ended: the CLI has only its answer to give, and it gives that at once.
    held.answerDueSinceMs = held.answering || runs ? null : held.answerDueSinceMs ?? now;
    const answerDueMs = held.answerDueSinceMs === null ? Infinity : held.answerDueSinceMs + this.backgroundNoticeStartLimitMs;
    if (now >= answerDueMs) {
      this.settleHeldRoomTurn(handle, held, "no_answer");
      return;
    }
    const nextMs = Math.min(lastMs, answerDueMs, ...waitsFor.filter((task) => task.running).map((task) => task.waitsUntilMs));
    if (held.wake) clearTimeout(held.wake);
    held.wake = setTimeout(() => this.heldRoomTurnChanged(handle), Math.max(1, nextMs - now));
    held.wake.unref?.();
    if (!tell) return;
    // Say that the turn is held open, for what, and for how long. The daemon builds an agent's activity from its stream.
    held.linesSinceNotice = 0;
    const summary = claudeBackgroundWorkWaitSummary(waitsFor, now - held.sinceMs, now - (held.endedSinceMs ?? now), this.backgroundCommandWaitLimitMs);
    this.publishStream(handle, CLAUDE_BACKGROUND_WORK_METHOD,
      { waiting_for: waitsFor.filter((task) => task.running).map((task) => task.description), waited_ms: now - held.sinceMs }, "provider_event", null, null, summary);
    this.publishActivity(handle, { source: "native_harness", method: CLAUDE_BACKGROUND_WORK_METHOD, summary, status: "working", checking: "", next_action: "" });
  }

  /**
   * A line was published. While a turn is held open, each line moves the wait away from the newest events of
   * the agent, which is all that the daemon keeps: after some lines the turn says again what it waits for.
   */
  protected heldRoomTurnPublished(handle: ClaudeProviderHandle, backgroundWork: "same" | "changed" | "tell" = "same"): void {
    const held = handle.heldRoomTurn;
    if (held && (held.linesSinceNotice += 1) >= CLAUDE_BACKGROUND_WORK_NOTICE_EVERY_LINES) backgroundWork = "tell";
    if (backgroundWork !== "same") this.heldRoomTurnChanged(handle, backgroundWork === "tell");
  }

  /** A result of the answer to a task's notice. The notice that was first in line is among `noticeAnswerTasks` now. */
  protected consumeTaskNoticeResult(handle: ClaudeProviderHandle, message: ClaudeStreamMessage): void {
    const held = handle.heldRoomTurn;
    // Notices that went to the model with one request each get a result. All but the last of these results
    // are empty and have no turn of the model in them (captured): the answer goes on, for the notices still in line.
    if (message.subtype === "success" && message.is_error === false && message.num_turns === 0 && !String(message.result ?? "").trim()
      && handle.taskNotices.length > 0) {
      this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event");
      this.heldRoomTurnChanged(handle);
      return;
    }
    // The answer has ended. It was about every notice that it was given, and it is the held turn's when any of them is.
    const startedBy = handle.noticeAnswerTasks.splice(0).map((taskId) => {
      const turnId = handle.backgroundTasks.get(taskId)?.turnId ?? null;
      handle.backgroundTasks.delete(taskId);
      return turnId;
    });
    if (held) held.answering = false;
    // Read as a turn's own result: the same shapes are an answer, no answer, or a failure with its text.
    const answer = exactClaudeStreamTerminal({ ...message, user_message_uuid: "notice" }, "notice", handle.providerContinuationId);
    const failed = !answer || "error" in answer;
    if (!held || !startedBy.includes(held.turnId)) {
      // No open turn waits for it: its turn has ended, or the work never had one. Nothing is posted, and no turn ends on it.
      this.publishStream(handle, handle.activeRoomTurnId ? CLAUDE_BACKGROUND_WORK_ANSWER_METHOD : CLAUDE_BACKGROUND_WORK_FINISHED_METHOD,
        message, "provider_event", null, null, failed ? CLAUDE_BACKGROUND_WORK_TEXT.notPostedUnfinished : CLAUDE_BACKGROUND_WORK_TEXT.notPosted);
      // No room turn runs, and the answer has ended: the agent is idle.
      if (!handle.activeRoomTurnId && handle.state === "working") handle.state = "idle";
      this.heldRoomTurnChanged(handle, true);
      return;
    }
    if (failed) {
      this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event", null, null,
        `${CLAUDE_BACKGROUND_WORK_TEXT.answerFailed} ${String(safeStreamPayload(answer?.error ?? "").payload).slice(0, 300)}`);
      this.settleHeldRoomTurn(handle, held, "answer_failed");
      return;
    }
    this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, message, "provider_event");
    if (answer.outcome === "reply") held.answers.push(answer.text);
    this.heldRoomTurnChanged(handle, true);
  }

  /** End the turn that was held open: now its own result line is published, and its waiters get what it has. */
  protected settleHeldRoomTurn(
    handle: ClaudeProviderHandle,
    held: ClaudeHeldRoomTurn,
    ended: "answered" | "answer_failed" | "limit" | "no_answer" | "owner",
  ): void {
    if (handle.heldRoomTurn !== held) return;
    const left = this.heldRoomTurnWork(handle, held);
    // An answer to a notice runs, or is due: one of its lines was seen, or a notice waits for it.
    const answerRuns = held.answering || handle.taskNotices.length > 0 || handle.noticeAnswerTasks.length > 0;
    handle.heldRoomTurn = null;
    clearInterval(held.notice);
    if (held.wake) clearTimeout(held.wake);
    const { turnId } = held;
    // Empty texts are left out, and so is a text that repeats the text before it. Two tasks can have the same answer.
    const said = held.answers.map((text) => text.trim()).filter(Boolean).filter((text, index, all) => text !== all[index - 1]);
    // One plain line says what the reply lacks, and why. Work that still runs past its limit is the usual case, and no fault.
    const runs = (kind: "subagent" | "command" | "other") => left.some((task) => task.running && task.kind === kind);
    const lacks = ended === "owner" ? [CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded] : [
      ...(ended === "answer_failed" || (ended === "limit" && left.some((task) => !task.running)) ? [CLAUDE_BACKGROUND_WORK_TEXT.notReported] : []),
      // A sub-agent that still runs is stopped with the turn, below.
      ...(runs("subagent") ? [ended === "limit" ? CLAUDE_BACKGROUND_WORK_TEXT.subagentTimedOut : CLAUDE_BACKGROUND_WORK_TEXT.subagentStopped] : []),
      ...(runs("other") ? [CLAUDE_BACKGROUND_WORK_TEXT.stillRunning] : runs("command") ? [CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns] : []),
    ];
    // A turn in which the model wrote nothing for the room posts nothing.
    const terminal: ClaudeRoomTurnTerminal = said.length
      ? { turnId, outcome: "reply", text: [...said, ...(lacks.length ? [lacks.join(" ")] : [])].join("\n\n"), evidence: "stream" }
      : { turnId, outcome: "no_reply", text: null, evidence: "stream" };
    try {
      if (ended === "owner" || (ended !== "answered" && (answerRuns || runs("subagent")))) {
        // The CLI must be free for the next prompt. An approval that the answer asked for is denied: with the
        // turn its card goes, and nobody could give it any more. Then the answer is interrupted (each captured).
        // The interrupt stops a sub-agent too: no turn waits for its report any more, and the reply says so.
        try {
          for (const pending of handle.permissionRequests.values()) {
            if (pending.turnId !== turnId || pending.dispatching) continue;
            handle.child.writeLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: pending.native.id,
              response: { behavior: "deny", message: "The turn ended before this action was approved." } } }));
          }
          this.writeInterrupt(handle);
        } catch { /* The CLI is gone; its exit is observed separately. */ }
      }
      // A command that passed its limit is no news for the owner. Any other limit is.
      if (ended === "no_answer" || (ended === "limit" && left.some((task) => !task.running || task.kind === "subagent"))) {
        this.publishStream(handle, CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, {}, "provider_event", null, null,
          ended === "limit" ? CLAUDE_BACKGROUND_WORK_TEXT.limitReached : CLAUDE_BACKGROUND_WORK_TEXT.noAnswerBegan);
      }
      const nativeLifecycle = this.observeNativeExecution(handle, held.result);
      this.publishStream(handle, streamMethod(held.result), held.result, claudeStreamKind(held.result),
        nativeLifecycle?.nativeEventId ?? null, nativeLifecycle?.phase ?? null);
      if (nativeLifecycle?.phase === "turn_terminal") this.handleCompactions.get(handle)?.clear();
    } finally {
      // Whatever a listener does with those lines, the turn is over: nothing may wait for it any longer.
      handle.roomTurnResults.set(turnId, terminal);
      if (handle.activeRoomTurnId === turnId) handle.activeRoomTurnId = null;
      for (const waiter of [...(handle.roomTurnWaiters.get(turnId) ?? [])]) waiter.resolve(terminal);
      // A Stop that was on its way when the turn ended reads this as the result that came first.
      const boundaries = [...handle.turnResultWaiters];
      handle.turnResultWaiters.clear();
      for (const resolve of boundaries) resolve(held.result);
      if (handle.state === "working") handle.state = "idle";
    }
    this.publishActivity(handle, { source: "native_harness", method: streamMethod(held.result),
      summary: "Turn completed", status: "idle", checking: "", next_action: "awaiting next room work" });
  }
}
