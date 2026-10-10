import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopRoomAgentDeliveryReceipt, DesktopRoomAgentFollowUpReason, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import { AGENT_ATTENTION_GRACE_MS, agentNeedsAttention, buildAgentAttentionItems, trackAgentAttention } from "../src/components/desktop/content/room-inbox/agent-attention";
import { agentInspectorOverallState, projectAgentInspector } from "../src/domain/agent-inspector";
import { agentInspectorSignal } from "../src/domain/agent-inspector-presentation";
import { roomMessageDeliveryReceipts } from "../src/domain/room-message-receipts";
import {
  agentScheduledRetry, retryWaitLabel, scheduledRetryCause, scheduledRetryClockLabel, scheduledRetryDetail, scheduledRetryDueLabel, scheduledRetryLabel, scheduledRetryLabelParts,
  scheduledRetryOutcome, waitingAgentIndicators, waitsBehindScheduledRetry,
} from "../src/domain/scheduled-retry";
import { collapseWorkIndicators, supervisedAgentWorkIndicators, workIndicatorSupersededByAgentMessage } from "../src/domain/managed-agents";

const NOW = Date.parse("2026-10-09T14:30:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function receipt(sourceMessageId: string, state: DesktopRoomAgentDeliveryReceipt["state"], fifoSequence: number,
  overrides: Partial<DesktopRoomAgentDeliveryReceipt> = {}): DesktopRoomAgentDeliveryReceipt {
  return { inboxItemId: `inbox_${fifoSequence}`, sourceMessageId, fifoSequence, replyClientMessageId: `reply_${fifoSequence}`,
    canonicalMessageId: null, state, attemptCount: 0, providerTurnId: null, blockedByMessageId: null, error: null,
    failureCode: null, terminalReason: null, updatedAt: at(40_000), timeline: [], ...overrides };
}

function agent(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_copper", roomId: "room-a", displayName: "CopperRidge", agentKey: "emmymay/copper", provider: "claude-code",
    model: null, charter: "Build the app.", desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "EmmyMay", createdAt: at(3_600_000), workspacePath: "/tmp/copper",
    workAttemptId: "attempt_1", agentSessionId: "session_1", agentSessionBindingState: "active", bindingUpdatedAt: at(10_000),
    executionGenerationId: "generation_1", providerContinuationId: "continuation_1", providerPid: 123,
    workplaceLiveness: { state: "healthy", observedAt: at(10_000), detail: null },
    nativeLiveness: { state: "healthy", observedAt: at(10_000), detail: null },
    restartCount: 0, lastTerminal: null, activity: [],
    roomAgentState: {
      connection: { state: "connected", observedAt: at(10_000), detail: null },
      ingress: { state: "observing", observedAt: at(10_000), detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [], lastTurnControlSequence: 0, turnControl: null, ...overrides,
  };
}

const FAILED = "API Error: Repeated 529 Overloaded errors. The API is at capacity.";
const STOPPED_BY_OWNER = "You stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue.";
const ATTEMPTS_FAILED = "All three automatic attempts failed. The agent now waits for you: check the provider, then use Retry delivery to try again. Existing work is preserved.";
const clock = (atMs: number) => new Date(atMs).toISOString().slice(11, 16);

/** An agent whose turn for msg_1 failed 40 seconds ago, and that tries again by itself in 100 seconds: after a short provider fault, unless `kind` says otherwise. */
function retryingAgent(retry: { atMs?: number; attempt?: number; attempts?: number; kind?: "provider_fault" | "no_reply"; forMessageId?: string | null } = {},
  later: DesktopRoomAgentDeliveryReceipt[] = []): DesktopSupervisorManifestEntry {
  const base = agent();
  return agent({
    roomAgentState: { ...base.roomAgentState!, inbox: { state: "queued", pendingCount: 1 + later.length, blockedByMessageId: null, detail: "Room delivery is queued." },
      turn: { state: "idle", inboxItemId: "inbox_2", sourceMessageId: "task-continuation:inbox_1", providerTurnId: null,
        detail: "The provider failed temporarily. The agent will try again by itself." } },
    deliveryReceipts: [
      receipt("msg_1", "acknowledged_failed", 1, { error: FAILED, attemptCount: 1, providerTurnId: "turn_1" }),
      receipt("task-continuation:inbox_1", "pending", 2, { followUp: { forMessageId: retry.forMessageId === undefined ? "msg_1" : retry.forMessageId, state: "scheduled",
        scheduled: { atMs: retry.atMs ?? NOW + 100_000, attempt: retry.attempt ?? 2, attempts: retry.attempts ?? 3, kind: retry.kind ?? "provider_fault" } } }),
      ...later,
    ],
  });
}

/** The same agent after its last automatic attempt failed: the follow-up waits for its owner. */
function stoppedAgent(): DesktopSupervisorManifestEntry {
  const base = agent();
  const detail = ATTEMPTS_FAILED;
  return agent({
    roomAgentState: { ...base.roomAgentState!, inbox: { state: "blocked", pendingCount: 1, blockedByMessageId: "task-continuation:inbox_4", detail },
      turn: { state: "failed", inboxItemId: "inbox_5", sourceMessageId: "task-continuation:inbox_4", providerTurnId: null, detail } },
    deliveryAttention: { reason: "message_blocked", sourceMessageId: "task-continuation:inbox_4", blockedSince: at(AGENT_ATTENTION_GRACE_MS + 60_000), detail,
      waitingCount: 0, providerWorkStarted: false, retry: "start_turn", canSkip: true, skipUnavailableReason: null },
    deliveryReceipts: [
      receipt("msg_1", "acknowledged_failed", 1, { error: FAILED }),
      receipt("task-continuation:inbox_4", "blocked", 5, { error: detail, updatedAt: at(AGENT_ATTENTION_GRACE_MS + 60_000),
        followUp: { forMessageId: "msg_1", state: "waiting_for_owner", reason: "attempts_failed", scheduled: null } }),
    ],
  });
}

/** The same agent after its follow-up ended with nothing started, for `reason`, which the daemon names `code`. A daemon that names none sends no code. */
function endedAgent(reason: string, state: "cancelled_by_user" | "acknowledged_no_reply" = "cancelled_by_user",
  code: DesktopRoomAgentFollowUpReason | null = "stopped_by_owner", laterPersonTurn?: boolean): DesktopSupervisorManifestEntry {
  return agent({ deliveryReceipts: [
    receipt("msg_1", "acknowledged_failed", 1, { error: FAILED }),
    receipt("task-continuation:inbox_1", state, 2, { error: reason, followUp: { forMessageId: "msg_1", state: "ended", ...(code ? { reason: code } : {}), ...(laterPersonTurn === undefined ? {} : { laterPersonTurn }), scheduled: null } }),
  ] });
}

test("the time left is in whole seconds and minutes, rounded up, and nothing is left at or after the time", () => {
  assert.equal(retryWaitLabel(25_000), "25 s");
  assert.equal(retryWaitLabel(24_001), "25 s", "a started second is still to wait");
  assert.equal(retryWaitLabel(1), "1 s");
  assert.equal(retryWaitLabel(59_000), "59 s");
  assert.equal(retryWaitLabel(59_001), "1 min");
  assert.equal(retryWaitLabel(60_000), "1 min");
  assert.equal(retryWaitLabel(100_000), "1 min 40 s");
  assert.equal(retryWaitLabel(120_000), "2 min");
  assert.equal(retryWaitLabel(600_000), "10 min");
  assert.equal(retryWaitLabel(599_001), "10 min");
  for (const none of [0, -1, -600_000, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(retryWaitLabel(none), null, String(none));
});

test("the label counts down to the saved time, and at that time says only what is true before the turn has started", () => {
  const retry = { atMs: NOW + 100_000, attempt: 2, attempts: 3 };
  assert.equal(scheduledRetryLabel(retry, NOW), "Trying again in 1 min 40 s (attempt 2 of 3)");
  // The label is two parts, so that a narrow receipt can wrap between them and nowhere else: the number stays with its unit.
  assert.deepEqual(scheduledRetryLabelParts(retry, NOW), ["Trying again in 1 min 40 s", "(attempt 2 of 3)"]);
  assert.deepEqual(scheduledRetryLabelParts(retry, NOW + 100_000), ["About to try again", "(attempt 2 of 3)"]);
  assert.deepEqual(scheduledRetryLabelParts({ ...retry, attempts: 1 }, NOW), ["Trying again in 1 min 40 s", "(the only automatic attempt)"]);
  assert.equal(scheduledRetryLabel(retry, NOW + 1_000), "Trying again in 1 min 39 s (attempt 2 of 3)");
  // The app was closed for 70 seconds, or the machine slept: the label is read from the saved time again, not counted on.
  assert.equal(scheduledRetryLabel(retry, NOW + 70_000), "Trying again in 30 s (attempt 2 of 3)");
  assert.equal(scheduledRetryLabel(retry, NOW + 99_500), "Trying again in 1 s (attempt 2 of 3)");
  // At the time and after it nothing may have started yet: dispatch can be paused, or the turn can wait to be admitted.
  // The label does not say that the agent tries now. When the turn starts, the agent shows as working instead.
  assert.equal(scheduledRetryLabel(retry, NOW + 100_000), "About to try again (attempt 2 of 3)");
  assert.equal(scheduledRetryLabel(retry, NOW + 3_600_000), "About to try again (attempt 2 of 3)");
  assert.equal(scheduledRetryLabel({ atMs: NOW + 30_000, attempt: 1, attempts: 3 }, NOW), "Trying again in 30 s (attempt 1 of 3)");
  assert.equal(scheduledRetryLabel({ atMs: NOW + 600_000, attempt: 3, attempts: 3 }, NOW), "Trying again in 10 min (attempt 3 of 3)");
  // A turn that ended without a reply gets one attempt: the label does not say "of 3".
  assert.equal(scheduledRetryLabel({ atMs: NOW + 10_000, attempt: 1, attempts: 1 }, NOW), "Trying again in 10 s (the only automatic attempt)");
  assert.equal(scheduledRetryLabel({ atMs: NOW + 10_000, attempt: 1, attempts: 1 }, NOW + 10_000), "About to try again (the only automatic attempt)");

  // A place that does not tick shows a clock time.
  assert.equal(scheduledRetryClockLabel(retry, NOW, clock), "Trying again at 14:31 (attempt 2 of 3)");
  assert.equal(scheduledRetryClockLabel(retry, NOW + 99_999, clock), "Trying again at 14:31 (attempt 2 of 3)");
  assert.equal(scheduledRetryClockLabel(retry, NOW + 100_000, clock), "About to try again (attempt 2 of 3)");
  assert.equal(scheduledRetryClockLabel({ atMs: NOW + 10_000, attempt: 1, attempts: 1 }, NOW, clock), "Trying again at 14:30 (the only automatic attempt)");
  assert.match(scheduledRetryClockLabel(retry, NOW), /^Trying again at \S.* \(attempt 2 of 3\)$/);
  // The live strip's row does not change while the agent waits: its text is true before and after the time.
  assert.equal(scheduledRetryDueLabel(retry, clock), "Waiting to try again, due at 14:31 (attempt 2 of 3)");
  assert.equal(scheduledRetryDueLabel({ atMs: NOW + 10_000, attempt: 1, attempts: 1 }, clock), "Waiting to try again, due at 14:30 (the only automatic attempt)");
  assert.match(scheduledRetryDueLabel(retry), /^Waiting to try again, due at \S.* \(attempt 2 of 3\)$/);
});

test("the owner reads what the agent tries again after, and what happens when it fails again: three attempts after a provider fault, one after a turn with no reply", () => {
  const fault = (attempt: number) => ({ attempt, attempts: 3, kind: "provider_fault" as const });
  assert.equal(scheduledRetryOutcome(fault(1)), "If all 3 attempts fail, the agent stops and waits for you.");
  assert.equal(scheduledRetryOutcome(fault(2)), "If all 3 attempts fail, the agent stops and waits for you.");
  assert.equal(scheduledRetryOutcome(fault(3)), "This is the last automatic attempt. If it fails, the agent stops and waits for you.");
  assert.equal(scheduledRetryCause(fault(1)), "A provider problem stopped the last turn.");
  // After a turn that ended without a reply there is one attempt, no provider problem, and nothing waits for the owner after it.
  const noReply = { attempt: 1, attempts: 1, kind: "no_reply" as const };
  assert.equal(scheduledRetryOutcome(noReply), "If it ends without a reply again, the agent stops. Send it a message to continue.");
  assert.equal(scheduledRetryCause(noReply), "The last turn ended without a reply.");
  assert.equal(scheduledRetryDetail({ ...fault(2), atMs: NOW + 100_000 }, NOW).replace(/at \S.* \(/, "at TIME ("),
    "A provider problem stopped the last turn. Trying again at TIME (attempt 2 of 3). If all 3 attempts fail, the agent stops and waits for you.");
  assert.equal(scheduledRetryDetail({ ...noReply, atMs: NOW + 10_000 }, NOW + 10_000),
    "The last turn ended without a reply. About to try again (the only automatic attempt). If it ends without a reply again, the agent stops. Send it a message to continue.");
});

test("an agent's scheduled attempt is its follow-up that waits for its time, and the messages after it wait for it", () => {
  const queued = receipt("msg_2", "pending", 3);
  const entry = retryingAgent({}, [queued]);
  const retry = agentScheduledRetry(entry.deliveryReceipts)!;
  assert.deepEqual(retry, { atMs: NOW + 100_000, attempt: 2, attempts: 3, kind: "provider_fault", forMessageId: "msg_1", sourceMessageId: "task-continuation:inbox_1", fifoSequence: 2 });
  // A message that arrived during the wait is behind the attempt. The failed message and the follow-up itself are not.
  assert.equal(waitsBehindScheduledRetry(queued, retry), true);
  assert.equal(waitsBehindScheduledRetry(entry.deliveryReceipts![0]!, retry), false);
  assert.equal(waitsBehindScheduledRetry(entry.deliveryReceipts![1]!, retry), false);
  assert.equal(waitsBehindScheduledRetry(receipt("msg_0", "pending", 1), retry), false, "nothing before the attempt waits for it");
  assert.equal(waitsBehindScheduledRetry(receipt("msg_2", "dispatching", 3), retry), false);
  assert.equal(waitsBehindScheduledRetry(queued, null), false);

  assert.equal(agentScheduledRetry(agent().deliveryReceipts), null);
  assert.equal(agentScheduledRetry(undefined), null);
  assert.equal(agentScheduledRetry(stoppedAgent().deliveryReceipts), null, "a follow-up that waits for its owner is not scheduled");
  assert.equal(agentScheduledRetry(endedAgent(STOPPED_BY_OWNER).deliveryReceipts), null, "nor is one that its owner stopped");
  // The attempt runs: its receipt is no longer waiting, whatever it still carries.
  const running = retryingAgent();
  running.deliveryReceipts![1]!.state = "dispatching";
  assert.equal(agentScheduledRetry(running.deliveryReceipts), null);
});

test("an agent that waits to try again is online and says so, for the kind of wait that it is; it does not need its owner until the last attempt has failed", () => {
  const retrying = retryingAgent({ atMs: NOW + 100_000 });
  assert.equal(agentInspectorOverallState(retrying), "online");
  assert.equal(agentNeedsAttention(retrying), false);
  const projection = projectAgentInspector(retrying, { roomId: retrying.roomId })!;
  const signal = agentInspectorSignal(projection, NOW);
  assert.deepEqual([signal.state, signal.label, signal.tone, signal.moving], ["retry_scheduled", "Waiting to try again", "amber", false]);
  assert.match(signal.detail, /^A provider problem stopped the last turn\. Trying again at \S.* \(attempt 2 of 3\)\. If all 3 attempts fail, the agent stops and waits for you\.$/);
  // The same state, read a second before the time and at the time: the line follows the clock it is given, not the state push.
  assert.match(agentInspectorSignal(projection, NOW + 99_000).detail, / Trying again at \S.* \(attempt 2 of 3\)\. /);
  assert.equal(agentInspectorSignal(projection, NOW + 100_000).detail,
    "A provider problem stopped the last turn. About to try again (attempt 2 of 3). If all 3 attempts fail, the agent stops and waits for you.");
  // The last automatic attempt says that it is the last.
  assert.match(agentInspectorSignal(projectAgentInspector(retryingAgent({ attempt: 3 }), { roomId: "room-a" })!, NOW).detail,
    /\(attempt 3 of 3\)\. This is the last automatic attempt\. If it fails, the agent stops and waits for you\.$/);
  // After a turn that ended without a reply the line names no provider problem, no three attempts, and no wait for the owner.
  const noReply = agentInspectorSignal(projectAgentInspector(retryingAgent({ atMs: NOW + 10_000, attempt: 1, attempts: 1, kind: "no_reply" }), { roomId: "room-a" })!, NOW);
  assert.equal(noReply.label, "Waiting to try again");
  assert.match(noReply.detail, /^The last turn ended without a reply\. Trying again at \S.* \(the only automatic attempt\)\. If it ends without a reply again, the agent stops\. Send it a message to continue\.$/);
  assert.doesNotMatch(noReply.detail, /provider|of 3|waits for you/);

  // An agent with nothing scheduled keeps its usual line.
  const idle = projectAgentInspector(agent(), { roomId: "room-a" })!;
  assert.equal(idle.now, null);
  assert.deepEqual([agentInspectorSignal(idle).state, agentInspectorSignal(idle).label], ["online", "Online"]);

  // After the last attempt the follow-up is blocked: that needs the owner, and is not shown as an attempt that waits.
  const stopped = stoppedAgent();
  assert.equal(agentInspectorOverallState(stopped), "needs_attention");
  assert.equal(agentNeedsAttention(stopped), true);
  const stoppedProjection = projectAgentInspector(stopped, { roomId: "room-a" })!;
  assert.equal(stoppedProjection.now?.kind, "attention");
  assert.notEqual(agentInspectorSignal(stoppedProjection).state, "retry_scheduled");
});

test("Needs you does not fire for a scheduled attempt, however long it waits, and fires for the follow-up that waits for the owner", () => {
  const longAgo = at(AGENT_ATTENTION_GRACE_MS + 3_600_000);
  const retrying = retryingAgent({ atMs: NOW + 600_000, attempt: 3 }, [receipt("msg_2", "pending", 3)]);
  assert.deepEqual(buildAgentAttentionItems({ agents: [retrying], agentFirstSeenAt: { [retrying.id]: longAgo }, nowMs: NOW }), []);
  assert.deepEqual(trackAgentAttention({}, [retrying], NOW), {}, "the agent is not counted as stuck while it waits");
  // Past due, and still nothing for the owner to do: the daemon starts the attempt.
  assert.deepEqual(buildAgentAttentionItems({ agents: [retryingAgent({ atMs: NOW - 60_000 })], agentFirstSeenAt: { supervised_copper: longAgo }, nowMs: NOW }), []);

  const stopped = stoppedAgent();
  const items = buildAgentAttentionItems({ agents: [stopped], nowMs: NOW });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]!.kind, items[0]!.roomIdentifier], ["agent_attention", "room-a"]);
  assert.ok(stopped.id in trackAgentAttention({}, [stopped], NOW));
});

test("the attempt shows on the message the failed work began with, and a message that arrived during the wait says that it waits for it", () => {
  const retrying = retryingAgent({}, [receipt("msg_2", "pending", 3), receipt("msg_3", "pending", 4)]);
  const other = agent({ id: "supervised_oak", displayName: "OakField", deliveryReceipts: [receipt("msg_1", "acknowledged", 1), receipt("msg_2", "dispatching", 2)] });
  const grouped = roomMessageDeliveryReceipts([retrying, other]);
  const retry = { atMs: NOW + 100_000, attempt: 2, attempts: 3, kind: "provider_fault", forMessageId: "msg_1", sourceMessageId: "task-continuation:inbox_1", fifoSequence: 2 };
  // The failed message: what failed, and the attempt with the id that its two controls name.
  assert.deepEqual(grouped.msg_1!.map((item) => [item.agentName, item.state, item.error, item.scheduledRetry, item.followUpNote]),
    [["CopperRidge", "acknowledged_failed", FAILED, retry, null], ["OakField", "acknowledged", null, null, null]]);
  // The messages after it, for that agent alone: each waits for the attempt, and links to the failed message.
  assert.deepEqual(grouped.msg_2!.map((item) => [item.agentName, item.state, item.blockedByMessageId, item.scheduledRetry]),
    [["CopperRidge", "queued_behind_retry", "msg_1", null], ["OakField", "dispatching", null, null]]);
  assert.deepEqual(grouped.msg_3!.map((item) => [item.state, item.blockedByMessageId]), [["queued_behind_retry", "msg_1"]]);
  // The follow-up has no room message: its own receipt is on no message that the room shows.
  assert.deepEqual(Object.keys(grouped).sort(), ["msg_1", "msg_2", "msg_3", "task-continuation:inbox_1"]);
  assert.equal(grouped["task-continuation:inbox_1"]![0]!.scheduledRetry, null);

  // An attempt whose first message is no longer kept shows on no message; the room's live strip and the agent's status line still have it.
  assert.deepEqual(roomMessageDeliveryReceipts([retryingAgent({ forMessageId: null })]).msg_1!.map((item) => [item.scheduledRetry, item.followUpNote]), [[null, null]]);
  // An agent that its owner paused or stopped does not try again at the saved time: nothing counts down, and nothing says that it waits for it.
  for (const desiredState of ["paused", "stopped"] as const) {
    const halted = roomMessageDeliveryReceipts([{ ...retrying, desiredState }]);
    assert.deepEqual(halted.msg_1!.map((item) => [item.state, item.scheduledRetry]), [["acknowledged_failed", null]], desiredState);
    assert.deepEqual(halted.msg_2!.map((item) => [item.state, item.blockedByMessageId]), [["pending", null]], desiredState);
  }
  assert.deepEqual(roomMessageDeliveryReceipts([]), {});
});

test("after the last automatic attempt the failed message says that the agent waits for its owner, with Retry for the follow-up", () => {
  const stopped = stoppedAgent();
  const grouped = roomMessageDeliveryReceipts([{ ...stopped, deliveryReceipts: [...stopped.deliveryReceipts!,
    receipt("msg_2", "queued_behind_blocked", 6, { blockedByMessageId: "task-continuation:inbox_4" })] }]);
  // The failed message keeps the provider's own words, and has the follow-up's text and its id for Retry.
  assert.deepEqual(grouped.msg_1!.map((item) => [item.state, item.error, item.scheduledRetry, item.followUpNote]), [["acknowledged_failed", FAILED, null,
    { state: "waiting_for_owner", sourceMessageId: "task-continuation:inbox_4", text: ATTEMPTS_FAILED, canRetry: true, reason: "attempts_failed" }]]);
  // The follow-up's own receipt is as it was, and a later message links to the failed message, which the room can show.
  assert.deepEqual(grouped["task-continuation:inbox_4"]!.map((item) => [item.state, item.retry, item.scheduledRetry, item.followUpNote]), [["blocked", "start_turn", null, null]]);
  assert.deepEqual(grouped.msg_2!.map((item) => [item.state, item.blockedByMessageId]), [["queued_behind_blocked", "msg_1"]]);

  // Retry from the message starts the follow-up's turn. Any other way to recover it is in the agent's inspector.
  const note = (over: Partial<DesktopSupervisorManifestEntry>, followUp: Partial<DesktopRoomAgentDeliveryReceipt> = {}) => {
    const entry = { ...stopped, ...over };
    entry.deliveryReceipts = [stopped.deliveryReceipts![0]!, { ...stopped.deliveryReceipts![1]!, ...followUp }];
    return roomMessageDeliveryReceipts([entry]).msg_1![0]!.followUpNote;
  };
  assert.equal(note({ deliveryAttention: undefined })!.canRetry, true, "no attention record: the daemon decides what Retry does");
  for (const retry of ["reread_saved_turn", "publish_saved_reply", "restore_conversation"] as const) {
    assert.equal(note({ deliveryAttention: { ...stopped.deliveryAttention!, retry } })!.canRetry, false, retry);
  }
  assert.equal(note({}, { failureCode: "provider_continuation_missing" })!.canRetry, false);
  assert.equal(note({ deliveryAttention: { ...stopped.deliveryAttention!, sourceMessageId: "msg_9", retry: "reread_saved_turn" } })!.canRetry, true, "attention for another message says nothing of this one");
  // A follow-up whose first message is no longer kept shows on no message. Needs you still has it.
  assert.equal(note({}, { followUp: { forMessageId: null, state: "waiting_for_owner", scheduled: null } }), null);
  // Its reason crosses to the note, and a daemon that names none gives none.
  assert.equal(note({})!.reason, "attempts_failed");
  assert.equal(note({}, { followUp: { forMessageId: "msg_1", state: "waiting_for_owner", scheduled: null } })!.reason, null);
  // Whatever a later turn does, the note of a follow-up that waits for its owner stays: it holds every later message, and Retry is still the way on.
  const withLaterTurn = { ...stopped, deliveryReceipts: [...stopped.deliveryReceipts!, receipt("msg_2", "acknowledged", 6, { providerTurnId: "turn_9" })] };
  assert.equal(roomMessageDeliveryReceipts([withLaterTurn]).msg_1![0]!.followUpNote?.state, "waiting_for_owner");
});

test("a follow-up that ended with nothing started says why on the failed message, and stays there; one that asks nothing of its owner goes when the agent has run for a later message", () => {
  const UNCERTAIN = "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.";
  const cases: ReadonlyArray<readonly [string, "cancelled_by_user" | "acknowledged_no_reply", DesktopRoomAgentFollowUpReason, boolean]> = [
    // A note that asks the owner to act stays: a turn for a later message, which can be one of another agent that was queued, does not
    // show that they did. "Send it a message to continue" is such an ask, whether the owner stopped the attempts or the agent changed.
    [STOPPED_BY_OWNER, "cancelled_by_user", "stopped_by_owner", false],
    ["The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.", "acknowledged_no_reply", "agent_changed", false],
    // An earlier action has a result that the owner must check, in the agent's inspector. No turn for another message checks it.
    [UNCERTAIN, "acknowledged_no_reply", "uncertain_action", false],
    // A note that asks nothing goes once the agent has run for a later message.
    ["You skipped the next attempt, and the task and its work lease are left as they are.", "cancelled_by_user", "skipped", true],
    ["The agent did not try again: the task is finished, or is no longer this agent's.", "acknowledged_no_reply", "task_not_held", true],
    ["The agent did not try again: an earlier action had an uncertain result, and that result is now known.", "acknowledged_no_reply", "uncertain_resolved", true],
  ];
  for (const [reason, state, code, goes] of cases) {
    const ended = endedAgent(reason, state, code);
    // Later messages were answered, or read, with no turn of the agent's own: the note is still on the failed message.
    ended.deliveryReceipts!.push(receipt("msg_2", "acknowledged", 3), receipt("msg_3", "acknowledged_no_reply", 4));
    const grouped = roomMessageDeliveryReceipts([ended]);
    assert.deepEqual(grouped.msg_1!.map((item) => [item.state, item.error, item.scheduledRetry, item.followUpNote]), [["acknowledged_failed", FAILED, null,
      { state: "ended", sourceMessageId: "task-continuation:inbox_1", text: reason, canRetry: false, reason: code }]], reason);
    assert.deepEqual([grouped.msg_2![0]!.followUpNote, grouped.msg_3![0]!.followUpNote], [null, null]);
    // A turn started for a later message, for example a message of another agent that was queued. What failed stays, with its error.
    const later = (turn: string | null, fifoSequence = 3, entry = ended) => roomMessageDeliveryReceipts([{ ...entry, deliveryReceipts: [...entry.deliveryReceipts!.slice(0, 2),
      receipt("msg_2", "acknowledged", fifoSequence, { providerTurnId: turn })] }]).msg_1![0]!;
    assert.equal(later(null).followUpNote?.state, "ended", reason);
    assert.equal(later("turn_2").followUpNote?.state ?? null, goes ? null : "ended", `${code}: ${goes ? "goes" : "stays"} when the agent has run for a later message`);
    assert.deepEqual([later("turn_2").state, later("turn_2").error], ["acknowledged_failed", FAILED]);
    // A turn that started before the follow-up does not count: it is the failed turn itself.
    assert.equal(later("turn_2", 0).followUpNote?.state, "ended", reason);
    // A daemon that names no reason, and one that names a reason that this version does not know: the note stays, as it is safe to keep.
    for (const unnamed of [endedAgent(reason, state, null), endedAgent(reason, state, "a_reason_of_a_later_version" as DesktopRoomAgentFollowUpReason)]) {
      assert.equal(later("turn_2", 3, unnamed).followUpNote?.state, "ended", `${reason}: no reason that it can rely on`);
    }
    // It shows whether the agent runs or not: it is over, and it is not a wait.
    assert.deepEqual(roomMessageDeliveryReceipts([{ ...ended, desiredState: "stopped" }]).msg_1![0]!.followUpNote, grouped.msg_1![0]!.followUpNote);
  }
  // A note that asks the owner to send a message goes when the owner has: the daemon says that a turn started for a message of a person that
  // came after the follow-up. A turn for another agent's message does not: the daemon says false, and the note stays whatever turns ran. A
  // daemon that does not say keeps the note.
  const AGENT_CHANGED = "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.";
  for (const [text, state, code] of [[STOPPED_BY_OWNER, "cancelled_by_user", "stopped_by_owner"], [AGENT_CHANGED, "acknowledged_no_reply", "agent_changed"]] as const) {
    const note = (laterPersonTurn: boolean | undefined, turns = true) => {
      const entry = endedAgent(text, state, code, laterPersonTurn);
      if (turns) entry.deliveryReceipts!.push(receipt("msg_2", "acknowledged", 3, { providerTurnId: "turn_2" }));
      return roomMessageDeliveryReceipts([entry]).msg_1![0]!.followUpNote;
    };
    assert.equal(note(true), null, `${code}: the owner sent a message and the agent ran for it`);
    assert.equal(note(true, false), null, `${code}: the daemon's word is enough`);
    assert.equal(note(false)?.state, "ended", `${code}: a turn ran, but not for a person's message`);
    assert.equal(note(false, false)?.state, "ended", code);
    assert.equal(note(undefined)?.state, "ended", `${code}: a daemon that does not say keeps the note, whatever turns ran`);
    assert.equal(note(undefined, false)?.state, "ended", code);
    assert.equal(note(true)?.reason ?? null, null);
  }
  // The uncertain-result note never goes this way. A note that asks nothing goes by any later turn, whatever the daemon says of a person.
  assert.equal(roomMessageDeliveryReceipts([endedAgent(UNCERTAIN, "acknowledged_no_reply", "uncertain_action", true)]).msg_1![0]!.followUpNote?.state, "ended");
  const skippedNote = (laterPersonTurn?: boolean) => {
    const entry = endedAgent("You skipped the next attempt, and the task and its work lease are left as they are.", "cancelled_by_user", "skipped", laterPersonTurn);
    entry.deliveryReceipts!.push(receipt("msg_2", "acknowledged", 3, { providerTurnId: "turn_2" }));
    return roomMessageDeliveryReceipts([entry]).msg_1![0]!.followUpNote;
  };
  assert.deepEqual([skippedNote(false), skippedNote(undefined), skippedNote(true)], [null, null, null]);
  // Each message has the follow-up of its own work, and each agent its own.
  const two = agent({ deliveryReceipts: [
    receipt("msg_1", "acknowledged_failed", 1, { error: FAILED }),
    receipt("task-continuation:inbox_1", "cancelled_by_user", 2, { error: STOPPED_BY_OWNER, followUp: { forMessageId: "msg_1", state: "ended", scheduled: null } }),
    receipt("msg_2", "acknowledged_failed", 3, { error: FAILED }),
    receipt("task-continuation:inbox_3", "pending", 4, { followUp: { forMessageId: "msg_2", state: "scheduled", scheduled: { atMs: NOW + 30_000, attempt: 1, attempts: 3, kind: "provider_fault" } } }),
  ] });
  const other = agent({ id: "supervised_oak", displayName: "OakField", deliveryReceipts: [receipt("msg_1", "acknowledged_failed", 1, { error: FAILED })] });
  const grouped = roomMessageDeliveryReceipts([two, other]);
  assert.deepEqual(grouped.msg_1!.map((item) => [item.agentName, item.followUpNote?.state ?? null, item.scheduledRetry?.attempt ?? null]), [["CopperRidge", "ended", null], ["OakField", null, null]]);
  assert.deepEqual(grouped.msg_2!.map((item) => [item.followUpNote, item.scheduledRetry?.attempt]), [[null, 1]]);
});

test("an agent that waits to try again has a row in the room's live strip, with the same time and attempt, also when the failed message is no longer kept", () => {
  const retrying = retryingAgent();
  assert.deepEqual(waitingAgentIndicators([retrying], "room-a", clock), [{
    id: "supervised_copper:waiting", displayName: "CopperRidge", summary: "Waiting to try again, due at 14:31 (attempt 2 of 3)",
    startedAt: new Date(NOW + 100_000).toISOString(), agentSessionId: "session_1", agentKey: "emmymay/copper", sourceMessageId: null, waiting: true,
  }]);
  // The failed message's receipt is no longer kept: the attempt shows on no message, and the row is still there.
  const unplaced = retryingAgent({ forMessageId: null });
  assert.deepEqual(roomMessageDeliveryReceipts([unplaced]).msg_1!.map((item) => item.scheduledRetry), [null]);
  assert.deepEqual(waitingAgentIndicators([unplaced], "room-a", clock).map((row) => row.summary), ["Waiting to try again, due at 14:31 (attempt 2 of 3)"]);
  assert.deepEqual(waitingAgentIndicators([retryingAgent({ atMs: NOW + 10_000, attempt: 1, attempts: 1, kind: "no_reply" })], "Room-A ", clock).map((row) => row.summary),
    ["Waiting to try again, due at 14:30 (the only automatic attempt)"]);

  // Only for this room, only while the attempt waits, and only for an agent that runs.
  assert.deepEqual(waitingAgentIndicators([retrying], "room-b", clock), []);
  assert.deepEqual(waitingAgentIndicators([retrying], null, clock), []);
  assert.deepEqual(waitingAgentIndicators([agent(), stoppedAgent(), endedAgent(STOPPED_BY_OWNER)], "room-a", clock), []);
  assert.deepEqual(waitingAgentIndicators([{ ...retrying, desiredState: "paused" }, { ...retrying, desiredState: "stopped" }], "room-a", clock), []);
  // The strip's rule for an agent that works holds for one that waits: bound, with no condition, and connected.
  assert.deepEqual(waitingAgentIndicators([{ ...retrying, condition: "auth_blocked" }, { ...retrying, agentSessionBindingState: "historical" },
    { ...retrying, roomAgentState: { ...retrying.roomAgentState!, connection: { state: "reconnecting", observedAt: at(0), detail: null } } },
    { ...retrying, roomAgentState: undefined }], "room-a", clock), []);
  const running = retryingAgent();
  running.deliveryReceipts![1]!.state = "dispatching";
  assert.deepEqual(waitingAgentIndicators([running], "room-a", clock), []);

  // The agent is not working, so it has no working row: the two never show together. No room message retires the row
  // that waits, and it has a place among the rows that the strip shows when few agents work.
  assert.deepEqual(supervisedAgentWorkIndicators([retrying], [], "room-a"), []);
  const [row] = waitingAgentIndicators([retrying], "room-a", clock);
  assert.equal(workIndicatorSupersededByAgentMessage(row!, [{ id: "msg_1", agentIdentity: null }, { id: "msg_2", agentIdentity: { agentSessionId: "session_1" } as never }]), false);
  const working = Array.from({ length: 6 }, (_, index) => ({ id: `w${index}`, displayName: `W${index}`, summary: "Working", startedAt: new Date(NOW - index * 1_000).toISOString() }));
  // It stays among the rows that the strip shows, as long as it does not take the place of a row of work.
  assert.ok(collapseWorkIndicators([...working.slice(0, 2), row!]).visible.some((item) => item.id === "supervised_copper:waiting"));
  assert.ok(!collapseWorkIndicators([...working, row!]).visible.some((item) => item.id === "supervised_copper:waiting"), "a row of work is never hidden by it");
  assert.deepEqual(collapseWorkIndicators([...working, row!]).visible.map((item) => item.id), ["w0", "w1", "w2"]);
});
