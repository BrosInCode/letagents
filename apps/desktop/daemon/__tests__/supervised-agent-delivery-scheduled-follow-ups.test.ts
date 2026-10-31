import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { followUpOrigin, FOLLOW_UP_REASONS, FOLLOW_UP_UNCERTAIN_RESOLVED_DETAIL, NO_REPLY_FOLLOW_UP_DETAIL, OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL, OWNERSHIP_UNVERIFIED_DETAIL, parseTaskContinuation, taskFailurePolicy } from "../task-continuity.js";
import { projectDeliveryReceipts } from "../manifest-view-projection.js";
import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";
import {
  agent,
  deferred,
  waitForAsync,
  ingest,
  RETRY_DELIVERY,
  STOPPED_AFTER_THREE,
  scheduledFault,
  STOPPED_BY_OWNER,
  SKIPPED_BY_OWNER,
  FOLLOW_UP_ENDED_UNCERTAIN,
  scheduledRetryFixture,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("a scheduled follow-up says when it starts, which attempt it is and which message it is for; Try now starts it at once, as that attempt", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const failedAt = retry.clock.nowMs;
    assert.deepEqual(retry.sources, ["1"]);
    assert.deepEqual(retry.waits, [30_000]);
    const first = (await retry.scheduled())!;
    assert.match(first.source_message_id, /^task-continuation:/);
    assert.equal(first.state, "pending");
    assert.deepEqual(first.follow_up, scheduledFault(failedAt + 30_000, 1));
    // What failed stays on the failed message, in the provider's own words. Nothing is blocked, so nothing needs the owner.
    const [failed] = await retry.view();
    assert.deepEqual([failed!.source_message_id, failed!.state, failed!.error, failed!.follow_up], ["1", "acknowledged_failed", retry.fault.error, undefined]);
    assert.deepEqual((await retry.view()).filter((receipt) => receipt.state === "blocked"), []);

    retry.clock.nowMs += 5_000;
    // Try now. The follow-up runs at once, 25 seconds early. The provider still fails, so the next follow-up is
    // attempt 2 with the wait of attempt 2: Try now was attempt 1, not an attempt of its own.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [30_000, 120_000]);
    const second = (await retry.scheduled())!;
    assert.notEqual(second.source_message_id, first.source_message_id);
    assert.deepEqual(second.follow_up, scheduledFault(retry.clock.nowMs + 120_000, 2));
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "pending"]);
    const tried = (await retry.store().receipts(agent.agentId))[1]!;
    assert.ok(tried.timeline.some((event) => event.phase === "retry_scheduled" && event.detail === "Started now, as its owner asked."));

    // Try now again, and once more: attempt 2, then attempt 3, the last. After it the follow-up waits for the owner.
    await retry.delivery().retry(retry.claude, second.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));
    await retry.delivery().retry(retry.claude, third.source_message_id);
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation", "continuation"], "three follow-ups in all, however they were started");
    assert.deepEqual(retry.waits, [30_000, 120_000, 600_000]);
    assert.equal(await retry.scheduled(), null, "the blocked follow-up is not a scheduled one");
    const blocked = (await retry.view()).find((receipt) => receipt.state === "blocked")!;
    assert.equal(blocked.error, STOPPED_AFTER_THREE);
    // It has no room message of its own. It names the one the work began with, so that message can say that the
    // automatic attempts are over, with Retry for this follow-up.
    assert.deepEqual(blocked.follow_up, { for_message_id: "1", state: "waiting_for_owner", reason: "attempts_failed", scheduled: null });
    await ingest(retry.store(), "2");
    assert.equal((await retry.view()).at(-1)!.state, "queued_behind_blocked", "a later message now waits for the owner");
    // Try now is for a follow-up that waits for its time. A message that failed, or one that waits behind, has none.
    await assert.rejects(retry.delivery().retry(retry.claude, "1"), /no longer available/);
    await assert.rejects(retry.delivery().retry(retry.claude, "2"), /no longer available/);
    // The inbox refuses the same by itself: only a follow-up that waits for its time is started now or stopped. Not
    // the follow-up that waits for the owner, not one that ran, and not a room message.
    const items = await retry.store().receipts(agent.agentId);
    assert.deepEqual(items.map((item) => item.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"]);
    for (const item of [items[4]!, items[1]!, items[0]!, items[5]!]) {
      await assert.rejects(retry.store().startTaskContinuationNow(item.inbox_item_id), /already started or ended/, item.state);
      await assert.rejects(retry.store().stopTaskContinuation(item.inbox_item_id, "stopped"), /already started or ended/, item.state);
    }
    assert.deepEqual((await retry.store().receipts(agent.agentId)).map((item) => [item.state, item.next_attempt_at_ms]), items.map((item) => [item.state, item.next_attempt_at_ms]),
      "and nothing changed");
  } finally { await retry.cleanup(); }
});

test("Stop trying ends a scheduled follow-up before anything starts: no other is made, and the next message goes ahead", async () => {
  const retry = await scheduledRetryFixture("codex");
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    assert.deepEqual(first.follow_up, scheduledFault(retry.clock.nowMs + 30_000, 1));
    // A message that arrives during the wait is kept behind the follow-up: it is queued, and nothing runs.
    await ingest(retry.store(), "2");
    retry.clock.nowMs += 5_000;
    await retry.delivery().pump(retry.claude);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "pending", "pending"]);
    assert.deepEqual(retry.sources, ["1"]);
    retry.providerRecovers();

    await retry.delivery().skipMessage(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view()).at(-1)!.state === "acknowledged_no_reply");
    assert.deepEqual(retry.sources, ["1", "2"], "no follow-up turn was started, and the message that waited ran");
    assert.deepEqual(retry.waits, [30_000], "nothing else was scheduled");
    const receipts = await retry.store().receipts(agent.agentId);
    assert.deepEqual(receipts.map((item) => [item.source_message_id.replace(/:.*/, ""), item.state]),
      [["1", "acknowledged_failed"], ["task-continuation", "cancelled_by_user"], ["2", "acknowledged_no_reply"]]);
    assert.equal(receipts[0]!.last_error, retry.fault.error, "the failed message keeps the provider's own words");
    assert.equal(receipts[1]!.last_error, STOPPED_BY_OWNER);
    assert.equal(receipts[1]!.next_attempt_at_ms, null);
    // The failed message is where its owner reads that: the stopped follow-up names it, and keeps the reason.
    const stopped = (await retry.view())[1]!;
    assert.deepEqual([stopped.follow_up, stopped.error], [{ for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: false, scheduled: null }, STOPPED_BY_OWNER]);
    assert.ok(receipts[1]!.timeline.some((event) => event.phase === "user_cancelled"));
    assert.equal(await retry.scheduled(), null);
    // It is over: neither control finds it again, and a later pump starts nothing for the old failure.
    await assert.rejects(retry.delivery().skipMessage(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.delivery().retry(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await retry.delivery().pump(retry.claude);
    assert.deepEqual(retry.sources, ["1", "2"]);
  } finally { await retry.cleanup(); }
});

test("a scheduled follow-up keeps its time across a daemon restart, and Try now and Stop trying work after one", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const dueAt = first.follow_up!.scheduled!.at_ms;
    assert.equal(dueAt, retry.clock.nowMs + 30_000);

    // The daemon is down for 12 seconds of the 30. The next daemon waits the 18 that are left, to the same time.
    await retry.restartDaemon(12_000);
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.waits, [30_000, 18_000]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 1));
    assert.deepEqual(retry.sources, ["1"], "nothing ran early");

    // Try now on the new daemon: attempt 1 runs, fails, and attempt 2 is scheduled two minutes ahead.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    const second = (await retry.scheduled())!;
    assert.deepEqual(second.follow_up, scheduledFault(retry.clock.nowMs + 120_000, 2));

    // Down again, for longer than the wait. The time has passed, so the next daemon starts attempt 2 without waiting.
    await retry.restartDaemon(150_000);
    await waitForAsync(async () => retry.sources.length === 3);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    await waitForAsync(async () => retry.waits.length === 4);
    assert.equal(retry.waits.at(-1), 600_000);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // Stop trying on a daemon that was started during the wait.
    await retry.restartDaemon(60_000);
    await waitForAsync(async () => retry.waits.length === 5);
    assert.equal(retry.waits.at(-1), 540_000);
    await retry.delivery().skipMessage(retry.claude, third.source_message_id);
    assert.equal(await retry.scheduled(), null);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "cancelled_by_user"]);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the third follow-up never ran");
    // And it stays stopped across one more restart, and still says so on the failed message.
    await retry.restartDaemon(1_000);
    await retry.delivery().pump(retry.claude);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    assert.equal(retry.waits.length, 5);
    const stopped = (await retry.view()).at(-1)!;
    assert.deepEqual([stopped.follow_up, stopped.error], [{ for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: false, scheduled: null }, STOPPED_BY_OWNER]);
  } finally { await retry.cleanup(); }
});

test("a follow-up says which room message its work began with, and where it stands: scheduled, waiting for its owner, or ended unstarted", () => {
  const receipt = (over: Record<string, unknown>) => ({ inbox_item_id: "item", agent_id: "agent", room_id: "room", source_message_id: "msg", fifo_sequence: 1,
    state: "pending", receipt_state: "pending", attempt_count: 0, action_id: "action", reply_client_message_id: "reply", provider_turn_id: null, outcome: null, last_error: null,
    failure_code: null, blocked_by_inbox_item_id: null, next_attempt_at_ms: null, terminal_reason: null, created_at: "t", updated_at: "t", acknowledged_at: null,
    canonical_message_id: null, timeline: [], ...over }) as unknown as Parameters<typeof projectDeliveryReceipts>[0][number];
  const followUps = (receipts: ReturnType<typeof receipt>[]) => projectDeliveryReceipts(receipts, null)!.map((item) => item.follow_up ?? null);
  const failed = receipt({ inbox_item_id: "a", source_message_id: "msg_1", state: "acknowledged_failed", receipt_state: "acknowledged_failed" });
  const followUp = (id: string, parent: string, over: Record<string, unknown> = {}) =>
    receipt({ inbox_item_id: id, source_message_id: `task-continuation:${parent}`, next_attempt_at_ms: 5_000, ...over });
  const ran = { state: "acknowledged_failed", receipt_state: "acknowledged_failed", provider_turn_id: "turn", next_attempt_at_ms: null };
  // The chain back to the room message says which attempt this is.
  assert.deepEqual(followUps([failed, followUp("b", "a")]), [null, scheduledFault(5_000, 1, "msg_1")]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b")]), [null, null, scheduledFault(5_000, 2, "msg_1")]);
  // A receipt that is no longer kept: the attempt is counted as far as the chain goes, and no message is named.
  assert.deepEqual(followUps([followUp("c", "b")]), [scheduledFault(5_000, 1, null)]);
  // A turn that ended without a reply gets one automatic attempt, not three. The kind that the daemon saved with the follow-up
  // says which it is, and wins over the text.
  const noReplyOnce = { for_message_id: "msg_1", state: "scheduled", scheduled: { at_ms: 5_000, attempt: 1, attempts: 1, kind: "no_reply" } };
  assert.deepEqual(followUps([failed, followUp("b", "a", { follow_up_kind: "no_reply" })]), [null, noReplyOnce]);
  assert.deepEqual(followUps([failed, followUp("b", "a", { follow_up_kind: "provider_fault" })]), [null, scheduledFault(5_000, 1, "msg_1")]);
  assert.deepEqual(followUps([failed, followUp("b", "a", { follow_up_kind: "provider_fault", last_error: NO_REPLY_FOLLOW_UP_DETAIL })]), [null, scheduledFault(5_000, 1, "msg_1")]);
  assert.deepEqual(followUps([failed, followUp("b", "a", { follow_up_kind: "no_reply", last_error: "The provider failed temporarily. The agent will try again by itself." })]), [null, noReplyOnce]);
  // A follow-up that an earlier daemon made has no saved kind, and may still wait as this daemon takes over: its text says which it is.
  assert.deepEqual(followUps([failed, followUp("b", "a", { last_error: NO_REPLY_FOLLOW_UP_DETAIL })]), [null, noReplyOnce]);
  assert.deepEqual(followUps([failed, followUp("b", "a", { last_error: "The provider failed temporarily. The agent will try again by itself." })]), [null, scheduledFault(5_000, 1, "msg_1")]);
  assert.deepEqual(followUps([failed, followUp("b", "a")]), [null, scheduledFault(5_000, 1, "msg_1")]);

  // A follow-up that waits for its owner has no time. It still names the room message: after all three automatic
  // attempts it is four follow-ups back, and after its owner used Retry on that one, five.
  const waiting = { for_message_id: "msg_1", state: "waiting_for_owner", reason: "attempts_failed", scheduled: null };
  const blocked = { state: "blocked", receipt_state: "blocked", next_attempt_at_ms: null, last_error: STOPPED_AFTER_THREE };
  assert.deepEqual(followUps([failed, followUp("b", "a", blocked)]), [null, waiting]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b", ran), followUp("d", "c", ran), followUp("e", "d", blocked)]), [null, null, null, null, waiting]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b", ran), followUp("d", "c", ran), followUp("e", "d", ran), followUp("f", "e", blocked)]),
    [null, null, null, null, null, waiting]);
  // The chain has no length of its own. An owner who used Retry many times is still told on the room message.
  const chain = (length: number) => Array.from({ length }, (_, index) => followUp(`f${index}`, index === 0 ? "a" : `f${index - 1}`, ran));
  assert.deepEqual(followUps([failed, ...chain(9), followUp("last", "f8", blocked)]).at(-1), waiting);
  assert.deepEqual(followUps([failed, ...chain(40), followUp("last", "f39", blocked)]).at(-1), waiting);
  // A record that names itself does not loop: the chain ends there, and no room message is named.
  assert.deepEqual(followUps([followUp("x", "y", blocked), followUp("y", "x", ran)]), [{ ...waiting, for_message_id: null }, null]);
  // A message that waits behind it is shown as that, but it is not a follow-up.
  assert.deepEqual(followUps([failed, followUp("b", "a", blocked), receipt({ inbox_item_id: "c", source_message_id: "msg_2", receipt_state: "queued_behind_blocked" })]), [null, waiting, null]);
  // Why it waits for its owner: its attempts were used up, its tasks could not be read, or another block, whose text says what it is.
  for (const [last_error, reason] of [[STOPPED_AFTER_THREE, "attempts_failed"], [OWNERSHIP_UNVERIFIED_DETAIL, "ownership_unverified"],
    [OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL, "ownership_unverified"], [`The model provider needs authentication or account access. ${RETRY_DELIVERY}`, "other"], [null, "other"]] as const) {
    assert.equal(followUps([failed, followUp("b", "a", { ...blocked, last_error })])[1]!.reason, reason, String(last_error));
  }

  // A follow-up that ended with nothing started says so, with its reason, for each way that it can end so.
  for (const [state, reason, code] of [
    ["cancelled_by_user", STOPPED_BY_OWNER, "stopped_by_owner"],
    ["cancelled_by_user", SKIPPED_BY_OWNER, "skipped"],
    ["acknowledged_no_reply", "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.", "agent_changed"],
    ["acknowledged_no_reply", "The agent did not try again: the task is finished, or is no longer this agent's.", "task_not_held"],
    ["acknowledged_no_reply", "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.", "uncertain_action"],
    // What an earlier version wrote is still read: the old words of an uncertain result, and the old words of Skip.
    ["acknowledged_no_reply", "The agent did not try again: an earlier action has an uncertain result. Check that result, then send an instruction to continue only the verified unfinished work.", "uncertain_action"],
    ["acknowledged_no_reply", "The agent did not try again: an earlier action has an uncertain result. The agent's inspector lists it. Check it, then send an instruction to continue only the verified work.", "uncertain_action"],
    ["cancelled_by_user", "You skipped the next attempt, so the agent did not try again. The task and its work lease are left as they are.", "skipped"],
  ] as const) {
    const [, projected] = projectDeliveryReceipts([failed, followUp("b", "a", { state, receipt_state: state, next_attempt_at_ms: null, last_error: reason })], null)!;
    assert.deepEqual([projected!.follow_up, projected!.error], [{ for_message_id: "msg_1", state: "ended", reason: code, scheduled: null }, reason], reason);
    // The room message shows at most 180 characters of a reason.
    assert.ok(reason.length <= 180, reason);
  }
  assert.ok(STOPPED_AFTER_THREE.length <= 180);
  // An uncertain result is one only while an action of the failed turn still is. When the daemon's record says that none is, the reason
  // is `uncertain_resolved`, and the receipt says so in words that ask nothing. No answer (a parent that is no longer kept): it still is.
  const uncertainEnded = (over: Record<string, unknown>) => followUp("b", "a", { state: "acknowledged_no_reply", receipt_state: "acknowledged_no_reply", next_attempt_at_ms: null,
    last_error: FOLLOW_UP_ENDED_UNCERTAIN, ...over });
  for (const [answer, reason, error] of [[true, "uncertain_action", FOLLOW_UP_ENDED_UNCERTAIN], [undefined, "uncertain_action", FOLLOW_UP_ENDED_UNCERTAIN],
    [false, "uncertain_resolved", FOLLOW_UP_UNCERTAIN_RESOLVED_DETAIL]] as const) {
    const [, projected] = projectDeliveryReceipts([failed, uncertainEnded(answer === undefined ? {} : { follow_up_uncertain: answer })], null)!;
    assert.deepEqual([projected!.follow_up!.reason, projected!.error], [reason, error], String(answer));
  }
  // The answer is read for that reason alone: it changes nothing for any other.
  assert.equal(projectDeliveryReceipts([failed, followUp("b", "a", { state: "cancelled_by_user", receipt_state: "cancelled_by_user", next_attempt_at_ms: null, last_error: STOPPED_BY_OWNER, follow_up_uncertain: false })], null)![1]!.follow_up!.reason, "stopped_by_owner");
  assert.ok(FOLLOW_UP_UNCERTAIN_RESOLVED_DETAIL.length <= 180);

  // Not a follow-up to show: one that runs, one whose turn ran, one that is pending with no time, and a room message.
  // One that ended with a turn, or with a text that is not one of those reasons, is not one that ended unstarted.
  for (const other of [followUp("b", "a", { state: "dispatching", receipt_state: "dispatching" }), followUp("b", "a", ran),
    followUp("b", "a", { next_attempt_at_ms: null }),
    followUp("b", "a", { state: "acknowledged_no_reply", receipt_state: "acknowledged_no_reply", next_attempt_at_ms: null, provider_turn_id: "turn", last_error: STOPPED_BY_OWNER }),
    followUp("b", "a", { state: "cancelled_by_user", receipt_state: "cancelled_by_user", next_attempt_at_ms: null, last_error: STOPPED_AFTER_THREE }),
    followUp("b", "a", { state: "cancelled_by_user", receipt_state: "cancelled_by_user", next_attempt_at_ms: null }),
    followUp("b", "a", { state: "acknowledged", receipt_state: "acknowledged", next_attempt_at_ms: null, last_error: STOPPED_BY_OWNER }),
    receipt({ inbox_item_id: "b", source_message_id: "msg_2", next_attempt_at_ms: 5_000 }),
    receipt({ inbox_item_id: "b", source_message_id: "msg_2", state: "blocked", receipt_state: "blocked" })]) {
    assert.deepEqual(followUps([failed, other]), [null, null], JSON.stringify(other));
  }
});

test("after a turn that ended without a reply the follow-up says that it is the only automatic attempt, and a repeat ends the series on the failed message", async () => {
  const retry = await scheduledRetryFixture("codex");
  try {
    // Every turn ends without a reply: the model stopped, and no provider fault is reported.
    retry.fault.error = NO_REPLY_FAILURE.emptyAnswer;
    delete retry.fault.claudeApiFailure;
    await retry.say("1", 1);
    assert.deepEqual(retry.waits, [10_000]);
    const first = (await retry.scheduled())!;
    assert.equal(first.error, "The model stopped before writing a reply. The agent will try again once, after a short wait.");
    assert.deepEqual(first.follow_up, { for_message_id: "1", state: "scheduled", scheduled: { at_ms: retry.clock.nowMs + 10_000, attempt: 1, attempts: 1, kind: "no_reply" } });

    // Try now. It ends without a reply again: no second attempt, nothing waits for the owner, and the reason is on the room message.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_failed");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    const receipts = await retry.view();
    assert.deepEqual(receipts.map((receipt) => [receipt.state, receipt.follow_up]), [["acknowledged_failed", undefined], ["acknowledged_failed", undefined]]);
    assert.match(receipts[0]!.error!, /It happened again, so the unfinished task was not continued automatically\. Existing work is preserved; send a message to continue it\.$/);
    assert.equal(receipts[1]!.error, receipts[0]!.error);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [10_000]);
  } finally { await retry.cleanup(); }
});

test("a daemon handoff during a ten-minute wait is not held up by it, and the follow-up keeps its saved time", async () => {
  const retry = await scheduledRetryFixture();
  /** Settles like `work`, or says that it did not within a second: a wait of ten minutes must not be awaited. */
  const prompt = (work: Promise<unknown>) => Promise.race([work.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1_000))]);
  try {
    // Two attempts fail, started by Try now. The third waits ten minutes.
    await retry.say("1", 1);
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => retry.waits.length === 2);
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    assert.deepEqual(retry.waits, [30_000, 120_000, 600_000]);
    const third = (await retry.scheduled())!;
    const dueAt = third.follow_up!.scheduled!.at_ms;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // The handoff pauses dispatch and drains the admitted turns. The pump only waits: it holds no turn, so it ends.
    retry.clock.nowMs += 100_000;
    retry.delivery().pauseDispatch();
    assert.equal(await prompt(retry.delivery().drainAdmittedTurns([agent.agentId])), "settled");
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the follow-up did not start early");
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 3), "and it keeps its saved time");
    // While dispatch is paused nothing new starts and nothing waits: a pump ends at once.
    assert.equal(await prompt(retry.delivery().pump(retry.claude)), "settled");
    assert.equal(retry.waits.length, 3);

    // Try now during the pause is accepted and saved, and no turn starts until dispatch goes on.
    await retry.delivery().retry(retry.claude, third.source_message_id);
    assert.equal(await prompt(retry.delivery().drainAdmittedTurns([agent.agentId])), "settled");
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(retry.clock.nowMs, 3), "it is due now, as the same attempt");
    assert.equal(retry.waits.length, 3);
    // The handoff is put off, so the same daemon goes on: the attempt that is due starts.
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation", "continuation"]);
  } finally { await retry.cleanup(); }
});

test("after a daemon handoff the same wait goes on to the saved time, and Try now and Stop trying work at once", async () => {
  const retry = await scheduledRetryFixture();
  /** The handoff's first steps: no new turn is admitted, and the admitted ones are drained. */
  const pauseAndDrain = async () => { retry.delivery().pauseDispatch(); await retry.delivery().drainAdmittedTurns([agent.agentId]); };
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const firstDueAt = first.follow_up!.scheduled!.at_ms;
    // Handoff put off after 10 of the 30 seconds, with nothing but the daemon's own wait in play: the same daemon
    // goes on, and waits the 20 seconds that are left. Not 30 again, and not none.
    retry.clock.nowMs += 10_000;
    await pauseAndDrain();
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.waits, [30_000, 20_000]);
    assert.deepEqual(retry.sources, ["1"], "it did not start at once");
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(firstDueAt, 1));

    // Attempt 1 runs by Try now and fails. Attempt 2 waits two minutes.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    const second = (await retry.scheduled())!;
    const dueAt = second.follow_up!.scheduled!.at_ms;
    assert.equal(dueAt, retry.clock.nowMs + 120_000);

    // Handoff put off after 20 seconds: the same daemon waits the 100 seconds that are left.
    retry.clock.nowMs += 20_000;
    await pauseAndDrain();
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => retry.waits.length === 4);
    assert.deepEqual(retry.waits, [30_000, 20_000, 120_000, 100_000]);
    assert.deepEqual(retry.sources, ["1", "continuation"], "it did not start at once");

    // Handoff done after 30 more seconds: the new daemon waits the 70 that are left, to the same saved time.
    retry.clock.nowMs += 30_000;
    await pauseAndDrain();
    await retry.restartDaemon(0);
    await waitForAsync(async () => retry.waits.length === 5);
    assert.deepEqual(retry.waits, [30_000, 20_000, 120_000, 100_000, 70_000]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 2));
    assert.deepEqual(retry.sources, ["1", "continuation"]);

    // Try now right after the handoff: attempt 2 runs and fails, and attempt 3 waits ten minutes.
    await retry.delivery().retry(retry.claude, second.source_message_id);
    await waitForAsync(async () => retry.waits.length === 6);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // Another handoff, and Stop trying right after it.
    retry.clock.nowMs += 60_000;
    await pauseAndDrain();
    await retry.restartDaemon(0);
    await waitForAsync(async () => retry.waits.length === 7);
    assert.equal(retry.waits.at(-1), 540_000);
    await retry.delivery().skipMessage(retry.claude, third.source_message_id);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "cancelled_by_user"]);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the third follow-up never ran");
  } finally { await retry.cleanup(); }
});

test("a pump that is ended while it reads a follow-up's wait does not sleep that wait", async () => {
  for (const end of ["fence", "pauseDispatch"] as const) {
    const retry = await scheduledRetryFixture();
    try {
      await retry.say("1", 1);
      const first = (await retry.scheduled())!;
      // The next daemon is ended at the worst moment: after it read how long to wait, before it waits.
      const { pump } = await retry.restartDaemon(5_000, retry.claude, () => {
        const store = retry.store();
        const read = store.taskContinuationDelay.bind(store);
        store.taskContinuationDelay = async (inboxItemId) => {
          const delay = await read(inboxItemId);
          retry.delivery()[end]();
          return delay;
        };
      });
      const outcome = await Promise.race([pump.then(() => "ended"), new Promise<string>((resolve) => setTimeout(() => resolve("asleep"), 1_000))]);
      assert.equal(outcome, "ended", end);
      assert.deepEqual(retry.sources, ["1"], `${end}: the follow-up did not start`);
      assert.deepEqual((await retry.scheduled())!.follow_up, first.follow_up, `${end}: and it keeps its saved time`);
    } finally { await retry.cleanup(); }
  }
});

test("Try now and Stop trying come too late for a follow-up whose turn is starting: one turn runs, and nothing is stopped", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    // The turn of the follow-up is held after it was claimed and before its turn id is saved: only its state says
    // that it started.
    const turn = deferred<void>();
    retry.hooks.turnStarts = turn.promise;
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.sources.length === 2);
    const [, running] = await retry.store().receipts(agent.agentId);
    assert.deepEqual([running!.state, running!.provider_turn_id, running!.outcome], ["dispatching", null, null]);
    assert.equal((await retry.view())[1]!.follow_up, undefined, "it is no longer shown as one that waits");

    // Both controls, through the delivery and at the inbox itself.
    await assert.rejects(retry.delivery().retry(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.delivery().skipMessage(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.store().startTaskContinuationNow(running!.inbox_item_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.store().stopTaskContinuation(running!.inbox_item_id, STOPPED_BY_OWNER), /^Error: This automatic attempt has already started or ended\.$/);
    const [, still] = await retry.store().receipts(agent.agentId);
    assert.deepEqual([still!.state, still!.next_attempt_at_ms, still!.last_error], [running!.state, running!.next_attempt_at_ms, running!.last_error], "nothing changed");

    retry.hooks.turnStarts = null;
    turn.resolve();
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.sources, ["1", "continuation"], "the turn ran once");
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "pending"]);
  } finally { await retry.cleanup(); }
});

test("a follow-up that ends unstarted during its wait says why on the failed message", async () => {
  const AGENT_CHANGED = "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.";
  const TASK_NOT_HELD = "The agent did not try again: the task is finished, or is no longer this agent's.";
  const ended = (reason: string) => ({ for_message_id: "1", state: "ended", reason, ...(reason === "agent_changed" ? { later_person_turn: false } : {}), scheduled: null });
  // The agent comes back as another session, with another conversation, or in another workspace.
  for (const change of [{ agentSessionId: "session-2" }, { providerContinuationId: "thread-2" }, { workAttemptId: "attempt-2" }]) {
    const retry = await scheduledRetryFixture();
    try {
      await retry.say("1", 1);
      const changed = { ...retry.claude, ...change, handle: { ...retry.claude.handle, ...change } };
      await (await retry.restartDaemon(5_000, changed)).pump;
      const receipts = await retry.view();
      assert.deepEqual(receipts.map((receipt) => [receipt.state, receipt.error]), [["acknowledged_failed", retry.fault.error], ["acknowledged_no_reply", AGENT_CHANGED]], JSON.stringify(change));
      assert.deepEqual(receipts[1]!.follow_up, ended("agent_changed"), JSON.stringify(change));
      assert.deepEqual(retry.sources, ["1"], "nothing ran");
      assert.deepEqual(retry.waits, [30_000], "and nothing waits");
    } finally { await retry.cleanup(); }
  }
  // The task was finished, or went to another agent, while the follow-up waited.
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    retry.hooks.held = [];
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_no_reply");
    const receipts = await retry.view();
    assert.deepEqual([receipts[1]!.error, receipts[1]!.follow_up], [TASK_NOT_HELD, ended("task_not_held")]);
    // Whether an action is still uncertain is asked for a follow-up that ended because of one, and for no other.
    assert.equal((await retry.store().receiptProjection(agent.agentId))[1]!.follow_up_uncertain, undefined);
    assert.deepEqual(retry.sources, ["1"], "nothing ran");
  } finally { await retry.cleanup(); }
});

test("a series that ends on an action with an uncertain result says so on the room message it began with", async () => {
  const UNCERTAIN = "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.";
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    // The follow-up's turn starts an action that changes something outside, and fails before the action's result is known.
    const db = new DatabaseSync(retry.path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,'turn-2','request','publish_room_artifact','{}',1,'executing',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString());
    db.close();
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_failed");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    // No other follow-up is made. The failed follow-up has no room message, so the reason is also on the one it began with.
    assert.deepEqual((await retry.view()).map((receipt) => [receipt.source_message_id.replace(/:.*/, ""), receipt.state, receipt.error]),
      [["1", "acknowledged_failed", UNCERTAIN], ["task-continuation", "acknowledged_failed", UNCERTAIN]]);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [30_000], "nothing else waits");
  } finally { await retry.cleanup(); }
});

test("Stop trying at the moment a follow-up's time came is not a delivery fault", async () => {
  const retry = await scheduledRetryFixture();
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...parts: unknown[]) => { warned.push(parts); };
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const item = (await retry.store().receipts(agent.agentId))[1]!;
    // The follow-up is due, and the daemon asks which tasks the agent holds. At that moment its owner stops it.
    retry.hooks.ownedTasks = () => retry.store().stopTaskContinuation(item.inbox_item_id, STOPPED_BY_OWNER);
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "cancelled_by_user");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    assert.deepEqual(retry.sources, ["1"], "nothing ran");
    assert.deepEqual(retry.waits, [30_000], "the pump did not back off as after a fault");
    assert.deepEqual(warned, [], "and it reported none");
    assert.deepEqual([(await retry.view())[1]!.follow_up, (await retry.view())[1]!.error], [{ for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: false, scheduled: null }, STOPPED_BY_OWNER]);
  } finally { console.warn = warn; await retry.cleanup(); }
});

test("a follow-up saves what it is for; a saved kind that this daemon does not know reads as none, and does not wedge the follow-up", async () => {
  const saved = { parentId: "a", attempt: 1, workAttemptId: "w", providerContinuationId: "c", agentSessionId: "s", heldBefore: "2026-10-01T00:00:00.000Z", tasks: null };
  assert.equal(parseTaskContinuation(saved)?.kind, undefined, "a follow-up that an earlier daemon made has none");
  for (const kind of ["provider_fault", "no_reply"]) assert.equal(parseTaskContinuation({ ...saved, kind })?.kind, kind);
  // A kind from a later version, after a downgrade, is read as none. The record stays valid, and has no such field.
  for (const kind of ["rate_limit", "", null, 1]) {
    const read = parseTaskContinuation({ ...saved, kind });
    assert.ok(read, String(kind));
    assert.equal(Object.hasOwn(read!, "kind"), false, String(kind));
    assert.equal(read!.parentId, "a");
  }
  // The policy says which it is for each automatic follow-up, and for no other decision.
  assert.equal(taskFailurePolicy("HTTP 503 Service Unavailable", 1).kind, "provider_fault");
  assert.equal(taskFailurePolicy(NO_REPLY_FAILURE.emptyAnswer, 1).kind, "no_reply");
  for (const stopped of [taskFailurePolicy("HTTP 503", 4), taskFailurePolicy("HTTP 401 unauthorized", 1), taskFailurePolicy(NO_REPLY_FAILURE.emptyAnswer, 2)]) assert.equal(stopped.kind, undefined);

  // Through the daemon: the saved follow-up carries its kind, and the receipt is made from it.
  for (const [error, kind, attempts] of [[NO_REPLY_FAILURE.emptyAnswer, "no_reply", 1], ["HTTP 503 Service Unavailable", "provider_fault", 3]] as const) {
    const retry = await scheduledRetryFixture("codex");
    try {
      retry.fault.error = error;
      delete retry.fault.claudeApiFailure;
      await retry.say("1", 1);
      const [, followUp] = await retry.store().receipts(agent.agentId);
      assert.equal((followUp!.activation.task_continuity as { kind?: string }).kind, kind);
      const projected = (await retry.store().receiptProjection(agent.agentId))[1]!;
      assert.equal(projected.follow_up_kind, kind);
      assert.deepEqual((await retry.view())[1]!.follow_up!.scheduled, { at_ms: projected.next_attempt_at_ms, attempt: 1, attempts, kind });
    } finally { await retry.cleanup(); }
  }
});

test("the kind of a follow-up is read for one that waits for its time, and for no other row", async () => {
  const retry = await scheduledRetryFixture();
  const raw = () => new DatabaseSync(retry.path);
  const kinds = async () => (await retry.store().receiptProjection(agent.agentId)).map((receipt) => receipt.follow_up_kind);
  try {
    await retry.say("1", 1);
    // Try now: the first follow-up runs and fails, and the second waits. A message arrives in the meantime.
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => retry.waits.length === 2);
    await ingest(retry.store(), "2");
    const [message, ran, waiting, later] = await retry.store().receipts(agent.agentId);
    assert.deepEqual([message!.state, ran!.state, waiting!.state, later!.state], ["acknowledged_failed", "acknowledged_failed", "pending", "pending"]);
    assert.ok(ran!.next_attempt_at_ms !== null, "the follow-up that ran keeps the time that it had");
    assert.deepEqual(await kinds(), [undefined, undefined, "provider_fault", undefined], "only the follow-up that waits, though the one that ran says the same");

    // The payload of every other row says a kind, and is not read for it: a message, a follow-up that ran, a message that is pending with a time,
    // and a follow-up that is pending with no time.
    const db = raw();
    const say = db.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?");
    for (const row of [message!, ran!, later!]) say.run(JSON.stringify({ ...row.activation, task_continuity: { kind: "no_reply" } }), row.inbox_item_id);
    db.prepare("UPDATE supervised_agent_inbox SET next_attempt_at_ms=? WHERE inbox_item_id=?").run(Date.now(), later!.inbox_item_id);
    assert.deepEqual(await kinds(), [undefined, undefined, "provider_fault", undefined]);
    db.prepare("UPDATE supervised_agent_inbox SET next_attempt_at_ms=NULL WHERE inbox_item_id=?").run(waiting!.inbox_item_id);
    assert.deepEqual(await kinds(), [undefined, undefined, undefined, undefined], "a follow-up with no time does not wait for it");
    db.close();
  } finally { await retry.cleanup(); }
});

test("a kind that this daemon does not know does not make the follow-up invalid: it can still be stopped, and says what it is for by its text", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const [, followUp] = await retry.store().receipts(agent.agentId);
    const db = new DatabaseSync(retry.path);
    db.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?")
      .run(JSON.stringify({ ...followUp!.activation, task_continuity: { ...(followUp!.activation.task_continuity as object), kind: "rate_limit_v9" } }), followUp!.inbox_item_id);
    db.close();
    assert.equal((await retry.store().taskContinuation(followUp!.inbox_item_id))?.parentId, (followUp!.activation.task_continuity as { parentId: string }).parentId, "it is read, with no kind");
    assert.deepEqual((await retry.scheduled())!.follow_up!.scheduled!.kind, "provider_fault");
    // Stop trying reads the follow-up, and used to throw.
    await retry.delivery().skipMessage(retry.claude, followUp!.source_message_id);
    assert.deepEqual([(await retry.view())[1]!.state, (await retry.view())[1]!.follow_up!.reason], ["cancelled_by_user", "stopped_by_owner"]);
  } finally { await retry.cleanup(); }
});

test("Skip on a follow-up that was blocked says what the owner did and nothing about attempts or the task, whatever blocked it; Stop trying keeps its own words", async () => {
  const names = (view: Awaited<ReturnType<Awaited<ReturnType<typeof scheduledRetryFixture>>["view"]>>) => view.at(-1)!;
  const skipsBlocked = async (setup: (retry: Awaited<ReturnType<typeof scheduledRetryFixture>>) => void, blockedWith: string | RegExp, reason: string) => {
    const retry = await scheduledRetryFixture();
    try {
      setup(retry);
      await retry.say("1", 0);
      await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
      const blocked = names(await retry.view());
      if (blockedWith instanceof RegExp) assert.match(blocked.error!, blockedWith); else assert.equal(blocked.error, blockedWith);
      assert.deepEqual([blocked.follow_up!.state, blocked.follow_up!.reason], ["waiting_for_owner", reason]);
      await retry.delivery().skipMessage(retry.claude, blocked.source_message_id);
      const skipped = names(await retry.view());
      assert.deepEqual([skipped.state, skipped.error, skipped.follow_up], ["cancelled_by_user", SKIPPED_BY_OWNER, { for_message_id: "1", state: "ended", reason: "skipped", scheduled: null }]);
      assert.doesNotMatch(skipped.error!, /stopped|still assigned|automatic attempts|did not try/);
      assert.ok(skipped.error!.length <= 180);
      assert.deepEqual(retry.sources, ["1"], "nothing was sent for it");
    } finally { await retry.cleanup(); }
  };
  // (a) The first failure is one that no attempt can help, so the follow-up was made blocked at once: no automatic attempt existed.
  await skipsBlocked((retry) => { retry.fault.error = "HTTP 401 unauthorized"; retry.fault.claudeApiFailure = { status: 401, terminalReason: "api_error", category: "authentication_failed" }; },
    /needs authentication/, "other");
  // (c) Its tasks could not be read, so whether the task is still the agent's is not known.
  await skipsBlocked((retry) => { retry.hooks.ownedTasks = async () => { throw new Error("offline"); }; }, OWNERSHIP_UNVERIFIED_DETAIL, "ownership_unverified");
  // (b) after three attempts is in the test above; here the wait of an attempt that is still scheduled is stopped by the owner, and says that.
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    await retry.delivery().skipMessage(retry.claude, (await retry.scheduled())!.source_message_id);
    const stopped = names(await retry.view());
    assert.deepEqual([stopped.state, stopped.error, stopped.follow_up], ["cancelled_by_user", STOPPED_BY_OWNER, { for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: false, scheduled: null }]);
    // Whether an action is still uncertain is asked for a follow-up that ended because of one, and for no other.
    assert.deepEqual((await retry.store().receiptProjection(agent.agentId)).map((receipt) => receipt.follow_up_uncertain), [undefined, undefined]);
  } finally { await retry.cleanup(); }
  assert.ok(SKIPPED_BY_OWNER.length <= 180);
});

test("a note that asks the owner to send a message says whether a turn started for a message of a person after it, and for no other note", async () => {
  const retry = await scheduledRetryFixture();
  const send = (id: string, source_message: Record<string, unknown>) => retry.store().ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId,
    last_observed_message_id: id, messages: [{ source_message_id: id, source_message: { id, ...source_message }, activation: {} }] });
  /** Send a message, let the agent run for it, and say what the follow-up's receipt says. */
  const answered = async (id: string, source_message: Record<string, unknown>) => {
    await send(id, source_message);
    void retry.delivery().pump(retry.claude).catch(() => undefined);
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.source_message_id === id && receipt.state === "acknowledged_no_reply"));
    return (await retry.view())[1]!.follow_up!;
  };
  const rawFollowUpText = async (text: string) => {
    const db = new DatabaseSync(retry.path);
    db.prepare("UPDATE supervised_agent_inbox SET last_error=? WHERE source_message_id LIKE 'task-continuation:%'").run(text);
    db.close();
  };
  try {
    await retry.say("1", 1);
    await retry.delivery().skipMessage(retry.claude, (await retry.scheduled())!.source_message_id);
    assert.deepEqual((await retry.view())[1]!.follow_up, { for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: false, scheduled: null });
    // The failed message was a person's, and its turn is before the follow-up: it does not count.
    const db0 = new DatabaseSync(retry.path);
    db0.prepare(`UPDATE supervised_agent_inbox SET source_message_json='{"id":"1","source":"browser"}' WHERE source_message_id='1'`).run();
    db0.close();
    assert.equal((await retry.view())[1]!.follow_up!.later_person_turn, false, "a turn before the follow-up");
    retry.providerRecovers();
    // The agent runs for messages that are not a person's: another agent's, one that has an agent's identity though its source is a browser's,
    // a system message, and a message whose body cannot be read. The owner has not done what the note asks.
    assert.equal((await answered("2", { source: "agent", agent_identity: { name: "Oak" } })).later_person_turn, false, "another agent's message");
    assert.equal((await answered("3", { source: "browser", agent_identity: { name: "Oak" } })).later_person_turn, false, "an agent's identity");
    assert.equal((await answered("4", { source: "system", sender: "letagents" })).later_person_turn, false, "a system message");
    const db = new DatabaseSync(retry.path);
    db.prepare("UPDATE supervised_agent_inbox SET source_message_json='not json' WHERE source_message_id IN ('2','3','4')").run();
    db.close();
    assert.equal((await retry.view())[1]!.follow_up!.later_person_turn, false, "bodies that cannot be read are not a person's");
    // The agent runs for a message of a person: the owner has sent one.
    assert.deepEqual(await answered("6", { source: "browser" }), { for_message_id: "1", state: "ended", reason: "stopped_by_owner", later_person_turn: true, scheduled: null });
    // The same for the other note that asks the owner to send a message. A turn before the follow-up does not count: it is not later.
    await rawFollowUpText("The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.");
    assert.deepEqual([(await retry.view())[1]!.follow_up!.reason, (await retry.view())[1]!.follow_up!.later_person_turn], ["agent_changed", true]);
    // Any other note is not asked, and carries no such field: it does not ask the owner to send a message.
    for (const text of [SKIPPED_BY_OWNER, FOLLOW_UP_ENDED_UNCERTAIN, "The agent did not try again: the task is finished, or is no longer this agent's."]) {
      await rawFollowUpText(text);
      assert.equal(Object.hasOwn((await retry.view())[1]!.follow_up!, "later_person_turn"), false, text);
      assert.equal((await retry.store().receiptProjection(agent.agentId))[1]!.follow_up_person_turn, undefined, text);
    }
  } finally { await retry.cleanup(); }
});

test("Skip on a follow-up that a restart blocked while it was claimed does not say that the agent did not try again: whether it did is not known", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    await retry.delivery().fenceAndDrain();
    // The follow-up was claimed, and the delivery restarted. Recovery cannot tell whether anything was sent for it, so it blocks it.
    const store = retry.store();
    const claimed = (await store.head(agent.agentId))!;
    assert.match(claimed.source_message_id, /^task-continuation:/);
    await store.transition(claimed.inbox_item_id, "dispatching");
    await store.normalizeStartupRecovery(agent.agentId);
    const blocked = (await store.get(claimed.inbox_item_id))!;
    assert.deepEqual([blocked.state, blocked.provider_turn_id, blocked.attempt_count], ["blocked", null, 0]);
    assert.match(blocked.last_error!, /acknowledgement is unsafe/);
    const skipped = await store.skipBlocked(claimed.inbox_item_id);
    assert.equal(skipped.last_error, SKIPPED_BY_OWNER);
    assert.doesNotMatch(skipped.last_error!, /did not try|not try again|never/);
  } finally { await retry.cleanup(); }
});

test("a follow-up whose tasks cannot be read when its time comes is blocked with its own words, which tell the owner to use Retry delivery", async () => {
  assert.notEqual(OWNERSHIP_UNVERIFIED_DETAIL, OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL);
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    // Its tasks were read when it was made. They cannot be read when it is due.
    retry.hooks.ownedTasks = async () => { throw new Error("offline"); };
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    const blocked = (await retry.view())[1]!;
    assert.equal(blocked.error, OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL);
    assert.deepEqual([blocked.follow_up!.state, blocked.follow_up!.reason], ["waiting_for_owner", "ownership_unverified"]);
    assert.equal(retry.sources.length, 1, "nothing was sent");
  } finally { await retry.cleanup(); }
});

test("a follow-up that finds an action with an uncertain result before it starts ends with that reason, and the message keeps saying so", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    // While the follow-up waits, an action of the failed turn is found to have an uncertain result.
    const db = new DatabaseSync(retry.path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,'turn-1','request','publish_room_artifact','{}',1,'uncertain',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString());
    db.close();
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_no_reply");
    const [, ended] = await retry.view();
    assert.deepEqual([ended!.follow_up, ended!.error], [{ for_message_id: "1", state: "ended", reason: "uncertain_action", scheduled: null }, ended!.error]);
    assert.equal(ended!.error, FOLLOW_UP_ENDED_UNCERTAIN);
    assert.deepEqual((await retry.store().receiptProjection(agent.agentId)).map((receipt) => receipt.follow_up_uncertain), [undefined, true]);
    assert.deepEqual(retry.sources, ["1"], "nothing ran");
    // The daemon has no control for its owner to resolve an action. It leaves its uncertain state only when the action's own completion is
    // recorded. Until then the note stays, and it names where the owner sees the action.
    assert.match(ended!.error!, /inspector/);
    assert.deepEqual((await retry.view())[1]!.follow_up!.reason, "uncertain_action");
    await retry.store().completeEffect({ effect_id: "effect", result: { done: true } });
    const [message, resolved] = await retry.view();
    assert.deepEqual([resolved!.follow_up, resolved!.error], [{ for_message_id: "1", state: "ended", reason: "uncertain_resolved", scheduled: null }, FOLLOW_UP_UNCERTAIN_RESOLVED_DETAIL]);
    assert.equal(message!.error, retry.fault.error, "the failed message keeps the provider's own words");
    // A failed action is a result too.
    const db2 = new DatabaseSync(retry.path);
    db2.prepare("UPDATE supervised_agent_effects SET state='uncertain' WHERE effect_id='effect'").run();
    db2.close();
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_action", "uncertain again: the reason is again the one that keeps the note");
    await retry.store().completeEffect({ effect_id: "effect", error: "The tool failed." });
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_resolved");
    // An action that is still executing is not a result either, and neither is one that is kept as a tombstone, which is how an uncertain
    // action is kept when many are: the daemon asks the live table and the compact one.
    const db4 = new DatabaseSync(retry.path);
    db4.prepare("UPDATE supervised_agent_effects SET state='executing' WHERE effect_id='effect'").run();
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_action", "executing");
    db4.prepare("UPDATE supervised_agent_effects SET state='completed' WHERE effect_id='effect'").run();
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_resolved", "completed, and no tombstone");
    db4.prepare(`INSERT INTO supervised_agent_effect_tombstones
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('tombstone',?,?,?,'turn-1','request-2','publish_room_artifact','0000000000000000000000000000000000000000000000000000000000000000',2,1,'uncertain',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString());
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_action", "a tombstone of the turn that is uncertain");
    db4.prepare("DELETE FROM supervised_agent_effect_tombstones WHERE effect_id='tombstone'").run();
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_resolved");
    // Whatever else goes wrong in asking, a projection of every receipt does not fail for one of them, and the note stays.
    const store = retry.store() as unknown as { hasUncertainTaskEffects: () => boolean };
    const ask = store.hasUncertainTaskEffects;
    store.hasUncertainTaskEffects = () => { throw new Error("the record cannot be read"); };
    assert.equal((await retry.view())[1]!.follow_up!.reason, "uncertain_action", "a failure to ask");
    store.hasUncertainTaskEffects = ask;
    // The failed turn is kept without its binding, which the daemon does not write today. A projection must not throw for it: the turn cannot be
    // matched to its actions, so it is taken as uncertain, and the note stays.
    db4.prepare("DELETE FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").run(message!.inbox_item_id);
    const unbound = await retry.view();
    assert.deepEqual([unbound[1]!.follow_up!.reason, unbound[1]!.error], ["uncertain_action", FOLLOW_UP_ENDED_UNCERTAIN]);
    // The failed turn's receipt is no longer kept, so the daemon cannot ask about its actions. It does not say that they are resolved.
    db4.prepare("DELETE FROM supervised_agent_inbox WHERE source_message_id='1'").run();
    db4.close();
    const kept = await retry.view();
    assert.deepEqual([kept.length, kept[0]!.follow_up!.reason, kept[0]!.follow_up!.for_message_id, kept[0]!.error], [1, "uncertain_action", null, FOLLOW_UP_ENDED_UNCERTAIN]);
  } finally { await retry.cleanup(); }
});

test("the origin of a series of follow-ups is found however long it is, and the walk ends for a record that names itself", () => {
  type Item = { inbox_item_id: string; source_message_id: string; activation: Record<string, unknown> };
  const item = (id: string, parent: string | null): Item => ({ inbox_item_id: id, source_message_id: parent ? `task-continuation:${parent}` : "msg_1",
    activation: parent ? { task_continuity: { parentId: parent, attempt: 1, workAttemptId: "w", providerContinuationId: "c", agentSessionId: "s", heldBefore: "2026-10-01T00:00:00.000Z", tasks: null } } : {} });
  const find = (items: Item[]) => { let loads = 0; return { loads: () => loads, load: (id: string) => { loads += 1; assert.ok(loads < 100, "the walk does not end"); return items.find((candidate) => candidate.inbox_item_id === id); } }; };
  const chain = [item("f0", null), ...Array.from({ length: 30 }, (_, index) => item(`f${index + 1}`, `f${index}`))];
  assert.equal(followUpOrigin(chain.at(-1)!, find(chain).load).inbox_item_id, "f0", "a chain of 30 is walked to its end");
  // The earliest follow-up that is kept is the origin when its parent is no longer there.
  assert.equal(followUpOrigin(chain.at(-1)!, find(chain.slice(5)).load).inbox_item_id, "f5");
  // Two records that name each other.
  const loop = find([item("x", "y"), item("y", "x")]);
  assert.equal(followUpOrigin(item("x", "y"), loop.load).inbox_item_id, "y");
  assert.ok(loop.loads() <= 2);
  assert.equal(followUpOrigin(item("a", "a"), find([]).load).inbox_item_id, "a", "one that names itself");
});

test("the daemon, the manifest wire and the desktop name the same reasons for a follow-up", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const listed = read("../../electron/main/supervisor-daemon/entry-mapping.ts").match(/const FOLLOW_UP_REASONS = \[([^\]]*)\]/)![1]!.match(/"[a-z_]+"/g)!.map((text) => text.slice(1, -1));
  assert.deepEqual(listed, [...FOLLOW_UP_REASONS]);
  for (const path of ["../types.ts", "../../electron/ipc-types/agents.ts"]) for (const reason of FOLLOW_UP_REASONS) assert.ok(read(path).includes(`"${reason}"`), `${path}: ${reason}`);
});

test("when its owner skips the follow-up that waits for them after three attempts, the room message it is for says that they skipped it", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    for (const waiting of [2, 3]) {
      await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
      await waitForAsync(async () => retry.waits.length === waiting);
    }
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    const blocked = (await retry.view()).at(-1)!;
    assert.deepEqual([blocked.state, blocked.error, blocked.follow_up], ["blocked", STOPPED_AFTER_THREE, { for_message_id: "1", state: "waiting_for_owner", reason: "attempts_failed", scheduled: null }]);
    // It was made blocked and nothing has touched it since, so nothing was ever sent to a provider for it.
    assert.equal(await retry.store().isUntouchedBlockedFollowUp(blocked.inbox_item_id), true);
    assert.equal(await retry.store().isUntouchedBlockedFollowUp((await retry.view())[0]!.inbox_item_id), false, "a room message is not one");

    // Skip, as the agent's inspector does it. Before, the follow-up kept no text, and the message said nothing of it.
    await retry.delivery().skipMessage(retry.claude, blocked.source_message_id);
    const skipped = (await retry.view()).at(-1)!;
    assert.deepEqual([skipped.state, skipped.error, skipped.follow_up], ["cancelled_by_user", SKIPPED_BY_OWNER, { for_message_id: "1", state: "ended", reason: "skipped", scheduled: null }]);
    assert.equal(await retry.store().isUntouchedBlockedFollowUp(blocked.inbox_item_id), false, "it is no longer blocked");
    assert.equal((await retry.view())[0]!.error, retry.fault.error, "the failed message keeps the provider's own words");
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation", "continuation"], "and nothing more ran");
  } finally { await retry.cleanup(); }
});

test("an owner who used Retry on a follow-up many times is still told on the room message where the series began", async () => {
  const UNCERTAIN = "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.";
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    // Three automatic follow-ups run by Try now. The fourth waits for the owner.
    for (const waiting of [2, 3]) {
      await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
      await waitForAsync(async () => retry.waits.length === waiting);
    }
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    const blockedHead = async () => (await retry.view()).find((receipt) => receipt.state === "blocked");
    await waitForAsync(async () => Boolean(await blockedHead()));
    // The owner uses Retry again and again: each follow-up that fails makes the next, which waits for the owner.
    for (let used = 1; used <= 5; used += 1) {
      const before = (await blockedHead())!;
      await retry.delivery().retry(retry.claude, before.source_message_id);
      await waitForAsync(async () => { const next = await blockedHead(); return next !== undefined && next.inbox_item_id !== before.inbox_item_id; });
    }
    // Eight follow-ups have run and the ninth waits. It names the room message all the same, which it did not for the ninth.
    assert.equal((await retry.view()).filter((receipt) => receipt.source_message_id.startsWith("task-continuation:")).length, 9);
    assert.deepEqual((await blockedHead())!.follow_up, { for_message_id: "1", state: "waiting_for_owner", reason: "attempts_failed", scheduled: null });

    // The ninth runs, and an action that it started has an uncertain result. No other follow-up is made, and the reason
    // is on the message the series began with, however far back that is.
    const db = new DatabaseSync(retry.path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,?,'request','publish_room_artifact','{}',1,'executing',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", `turn-${retry.sources.length + 1}`, new Date().toISOString(), new Date().toISOString());
    db.close();
    await retry.delivery().retry(retry.claude, (await blockedHead())!.source_message_id);
    await waitForAsync(async () => !(await blockedHead()));
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    const receipts = await retry.view();
    assert.equal(receipts[0]!.error, UNCERTAIN, "on the message the series began with");
    assert.equal(receipts.at(-1)!.error, UNCERTAIN, "and on the follow-up that failed");
    assert.equal(receipts.length, 10, "and no other follow-up was made");
  } finally { await retry.cleanup(); }
});
