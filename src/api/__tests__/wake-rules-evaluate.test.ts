import assert from "node:assert/strict";
import test from "node:test";

import { WAKE_RULE_LIMITS } from "../../../shared/wake-rules.mjs";
import type { WakeRuleRow } from "../db/wake-rules.js";
import {
  WAKE_RULE_FALLBACK_CHECK_MS,
  evaluateWakeRule,
  type GitHubEventFact,
  type WakeRuleEvaluationDeps,
} from "../wake-rules/evaluate.js";

const created = "2026-09-30T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(created) + minutes * 60_000);

function rule(overrides: Partial<WakeRuleRow>): WakeRuleRow {
  return {
    id: "wake_1", room_id: "room", agent_key: "agent", agent_name: "Fable", created_by_session_id: null,
    event: "timer", arguments: {}, identity_key: "k", note: null, repeat: false, status: "active",
    baseline: null, cursor_at: created, next_check_at: created, expires_at: at(24 * 60).toISOString(),
    fire_count: 0, last_fired_at: null, wake_message_number: null, cancelled_by: null, ended_reason: null, ended_at: null,
    created_at: created, updated_at: created,
    ...overrides,
  };
}

function check(minutes: number, overrides: Partial<GitHubEventFact> = {}): GitHubEventFact {
  return {
    action: "completed", title: "test", state: "success", url: null, actor: null, pr: null,
    head_ref: "feature/billing", head_sha: "sha1", recorded_at: at(minutes).toISOString(), ...overrides,
  };
}

function deps(overrides: Partial<WakeRuleEvaluationDeps> = {}): WakeRuleEvaluationDeps {
  return {
    readTaskStatus: async () => null,
    ownedWork: async () => ({ branches: [], pullRequests: [] }),
    pullRequestBranches: async () => [],
    pullRequestClosed: async () => null,
    githubEventsAfter: async () => [],
    ...overrides,
  };
}

test("a timer waits for its time, then fires", async () => {
  const timer = rule({ event: "timer", arguments: { at: at(30).toISOString() } });
  assert.deepEqual(await evaluateWakeRule(timer, at(10), deps()), { kind: "wait", nextCheckAt: at(15).toISOString() },
    "a far timer still gets a bounded fallback look");
  assert.deepEqual(await evaluateWakeRule(timer, at(28), deps()), { kind: "wait", nextCheckAt: at(30).toISOString() });
  assert.equal((await evaluateWakeRule(timer, at(30), deps())).kind, "fire");
});

test("a task rule fires on a change to a wanted status, from the status it last saw", async () => {
  let status = "in_progress";
  const taskRule = rule({ event: "task.status_changed", arguments: { task_id: "task_41", to: ["in_review"] }, baseline: { room_id: "board", status: "in_progress" } });
  const read = deps({ readTaskStatus: async (roomId, number) => (roomId === "board" && number === 41 ? status : null) });
  assert.equal((await evaluateWakeRule(taskRule, at(1), read)).kind, "wait");
  status = "blocked";
  assert.equal((await evaluateWakeRule(taskRule, at(2), read)).kind, "wait", "blocked is a change, but not one it waits for");
  status = "in_review";
  const fired = await evaluateWakeRule(taskRule, at(3), read);
  assert.deepEqual(fired.kind === "fire" && [fired.facts, fired.baseline], [
    { task_id: "task_41", status: "in_review", previous_status: "in_progress" },
    { room_id: "board", status: "in_review" },
  ]);
});

test("CI wakes once per push, after the checks go quiet", async () => {
  const ciRule = rule({ event: "github.check_completed", arguments: { branch: "feature/billing" } });
  const events = [check(1, { title: "lint" }), check(2, { title: "test", state: "failure", url: "u" }), check(3, { title: "test", state: "success" })];
  const read = deps({ githubEventsAfter: async (input) => {
    assert.deepEqual(input.headRefs, ["feature/billing"]);
    return events;
  } });
  const settling = await evaluateWakeRule(ciRule, at(3.5), read);
  assert.deepEqual(settling, { kind: "wait", nextCheckAt: new Date(at(3).getTime() + WAKE_RULE_LIMITS.checkSettleMs).toISOString() });
  const fired = await evaluateWakeRule(ciRule, at(5), read);
  assert.equal(fired.kind, "fire");
  if (fired.kind === "fire") {
    // A re-run replaces the earlier result of the same check.
    assert.deepEqual(fired.facts.pushes, [{ head_ref: "feature/billing", checks: [
      { name: "lint", conclusion: "success", url: null },
      { name: "test", conclusion: "success", url: null },
    ] }]);
    assert.equal(fired.cursorAt, at(3).toISOString());
  }
});

test("a failures-only rule passes over a green push for good and keeps waiting", async () => {
  const failures = rule({ event: "github.check_completed", arguments: { branch: "feature/billing", conclusions: ["failure"] } });
  const green = deps({ githubEventsAfter: async () => [check(1)] });
  const result = await evaluateWakeRule(failures, at(10), green);
  assert.deepEqual(result, {
    kind: "wait",
    nextCheckAt: at(10 + WAKE_RULE_FALLBACK_CHECK_MS / 60_000).toISOString(),
    cursorAt: at(1).toISOString(),
  }, "the cursor moves past the green push, so a busy branch never re-reads it");
});

test("`mine` watches every branch; pushes reporting at once are reported together", async () => {
  const mine = rule({ event: "github.check_completed", arguments: { mine: true, conclusions: ["failure"] } });
  const read = deps({
    ownedWork: async () => ({ branches: ["a", "b"], pullRequests: [] }),
    githubEventsAfter: async () => [
      check(1, { head_ref: "a", head_sha: "a1", title: "test", state: "failure" }),
      check(2, { head_ref: "b", head_sha: "b1", title: "test", state: "success" }),
    ],
  });
  const fired = await evaluateWakeRule(mine, at(5), read);
  assert.deepEqual(fired.kind === "fire" && fired.facts.pushes,
    [{ head_ref: "a", checks: [{ name: "test", conclusion: "failure", url: null }] }],
    "a later green branch does not hide an earlier red one");
  assert.equal(fired.kind === "fire" && fired.cursorAt, at(2).toISOString(), "the green push is passed over with it");
  assert.equal((await evaluateWakeRule(mine, new Date(at(2).getTime() + 10_000), read)).kind, "wait",
    "nothing is reported while an overlapping push is still reporting");
});

test("a repeating rule over two overlapping branches wakes once and loses no failure", async () => {
  // A: success at 1s and 10s; B: failure at 5s, then success on another check at 95s.
  const seconds = (value: number) => value / 60;
  const events = [
    check(seconds(1), { head_ref: "a", head_sha: "a1", title: "a-lint", state: "success" }),
    check(seconds(5), { head_ref: "b", head_sha: "b1", title: "b-test", state: "failure" }),
    check(seconds(10), { head_ref: "a", head_sha: "a1", title: "a-test", state: "success" }),
    check(seconds(95), { head_ref: "b", head_sha: "b1", title: "b-lint", state: "success" }),
  ];
  let current = rule({ event: "github.check_completed", arguments: { mine: true }, repeat: true });
  const read = deps({
    ownedWork: async () => ({ branches: ["a", "b"], pullRequests: [] }),
    githubEventsAfter: async (input) => events.filter((event) => Date.parse(event.recorded_at) > Date.parse(input.after)),
  });
  const wakes: unknown[] = [];
  for (const secondsNow of [100, 190, 260, 400]) {
    const now = at(seconds(secondsNow));
    const result = await evaluateWakeRule(current, now, read);
    if (result.kind === "fire") {
      wakes.push(result.facts.pushes);
      current = { ...current, cursor_at: result.cursorAt, last_fired_at: now.toISOString(), fire_count: current.fire_count + 1 };
    } else if (result.kind === "wait" && result.cursorAt) {
      current = { ...current, cursor_at: result.cursorAt };
    }
  }
  assert.deepEqual(wakes, [[
    { head_ref: "a", checks: [{ name: "a-lint", conclusion: "success", url: null }, { name: "a-test", conclusion: "success", url: null }] },
    { head_ref: "b", checks: [{ name: "b-test", conclusion: "failure", url: null }, { name: "b-lint", conclusion: "success", url: null }] },
  ]]);
});

test("a later push on a branch supersedes CI on its earlier commit", async () => {
  const ciRule = rule({ event: "github.check_completed", arguments: { branch: "feature/billing" } });
  const read = deps({ githubEventsAfter: async () => [
    check(1, { head_sha: "old", title: "test", state: "failure" }),
    check(3, { head_sha: "new", title: "test", state: "success" }),
  ] });
  const fired = await evaluateWakeRule(ciRule, at(10), read);
  assert.deepEqual(fired.kind === "fire" && fired.facts.pushes, [{ head_ref: "feature/billing", checks: [{ name: "test", conclusion: "success", url: null }] }]);
});

test("a one-shot rule reports a ready failure at once, however long another branch keeps reporting", async () => {
  const seconds = (value: number) => value / 60;
  // B started first and re-runs a check on its commit every minute; A failed once.
  const events = [check(seconds(0.5), { head_ref: "b", head_sha: "b1", title: "slow", state: "success" })];
  events.push(check(seconds(1), { head_ref: "a", head_sha: "a1", title: "test", state: "failure" }));
  for (let second = 60; second <= 1800; second += 60) {
    events.push(check(seconds(second), { head_ref: "b", head_sha: "b1", title: "slow", state: "success" }));
  }
  const readAt = (nowSeconds: number) => deps({
    ownedWork: async () => ({ branches: ["a", "b"], pullRequests: [] }),
    githubEventsAfter: async (input) => events.filter((event) =>
      Date.parse(event.recorded_at) <= Math.min(Date.parse(input.until), at(seconds(nowSeconds)).getTime())),
  });
  const oneShot = rule({ event: "github.check_completed", arguments: { mine: true, conclusions: ["failure"] }, expires_at: at(seconds(600)).toISOString() });
  const fired = await evaluateWakeRule(oneShot, at(seconds(100)), readAt(100));
  assert.deepEqual(fired.kind === "fire" && fired.facts.pushes, [{ head_ref: "a", checks: [{ name: "test", conclusion: "failure", url: null }] }]);

  const repeating = { ...oneShot, repeat: true };
  assert.equal((await evaluateWakeRule(repeating, at(seconds(100)), readAt(100))).kind, "wait", "a repeating rule waits so it cannot report B twice");
  assert.equal((await evaluateWakeRule(repeating, at(seconds(600)), readAt(600))).kind, "fire", "at its expiry it reports what happened instead of losing it");
});

test("a job re-run on an older commit does not hide the newest push", async () => {
  const ciRule = rule({ event: "github.check_completed", arguments: { branch: "feature/billing" } });
  const read = deps({ githubEventsAfter: async () => [
    check(1, { head_sha: "old", title: "test", state: "failure" }),
    check(2, { head_sha: "new", title: "test", state: "success" }),
    check(3, { head_sha: "old", title: "test", state: "success" }),
  ] });
  const fired = await evaluateWakeRule(ciRule, at(10), read);
  assert.deepEqual(fired.kind === "fire" && fired.facts.pushes, [{ head_ref: "feature/billing", checks: [{ name: "test", conclusion: "success", url: null }] }]);
  assert.equal(fired.kind === "fire" && fired.cursorAt, at(2).toISOString(), "the cursor follows the newest push, not the re-run");
});

test("a repeating rule wakes at most once a minute, whatever prompts the check", async () => {
  const repeating = rule({
    event: "github.review_submitted", arguments: { pr: 9 }, repeat: true,
    last_fired_at: at(10).toISOString(), fire_count: 1,
  });
  const reviews = deps({ githubEventsAfter: async () => [{ ...check(10.1), action: "submitted", state: "commented", pr: 9 }] });
  assert.deepEqual(await evaluateWakeRule(repeating, new Date(at(10).getTime() + 5_000), reviews),
    { kind: "wait", nextCheckAt: new Date(at(10).getTime() + WAKE_RULE_LIMITS.repeatDebounceMs).toISOString() });
  assert.equal((await evaluateWakeRule(repeating, at(11.5), reviews)).kind, "fire");
});

test("GitHub reads are bounded by the rule's cursor and expiry", async () => {
  const review = rule({ event: "github.review_submitted", arguments: { pr: 9 }, cursor_at: at(3).toISOString(), expires_at: at(60).toISOString() });
  let seen: unknown;
  await evaluateWakeRule(review, at(5), deps({ githubEventsAfter: async (input) => { seen = input; return []; } }));
  assert.deepEqual(seen, {
    ruleRoomId: "room", eventType: "pull_request_review", action: "submitted",
    after: at(3).toISOString(), until: at(60).toISOString(), pullRequests: [9],
  });
});

test("`mine` follows the agent's current work, not the work it had when it asked", async () => {
  const mine = rule({ event: "github.pr_closed", arguments: { mine: true, merged_only: true } });
  let pullRequests: number[] = [];
  const read = deps({
    ownedWork: async () => ({ branches: [], pullRequests }),
    githubEventsAfter: async (input) => (input.pullRequests ?? []).includes(12) && input.action === "closed"
      ? [{ ...check(4), action: "closed", state: "closed", pr: 12 }, { ...check(5), action: "closed", state: "merged", pr: 12, url: "pr-url" }]
      : [],
  });
  assert.equal((await evaluateWakeRule(mine, at(6), read)).kind, "wait");
  pullRequests = [12];
  const fired = await evaluateWakeRule(mine, at(6), read);
  assert.deepEqual(fired.kind === "fire" && fired.facts, { pr: 12, merged: true, url: "pr-url" }, "a close without merge is skipped");
});

test("a review rule reports the reviewer and state; an event on expiry still wins", async () => {
  const review = rule({ event: "github.review_submitted", arguments: { pr: 9, states: ["approved"] }, expires_at: at(60).toISOString() });
  const read = deps({ githubEventsAfter: async () => [
    { ...check(10), action: "submitted", state: "COMMENTED", pr: 9, actor: "ada" },
    { ...check(20), action: "submitted", state: "APPROVED", pr: 9, actor: "grace", url: "review-url" },
  ] });
  const fired = await evaluateWakeRule(review, at(61), read);
  assert.deepEqual(fired.kind === "fire" && fired.facts, { pr: 9, reviewer: "grace", state: "approved", url: "review-url" });
  assert.deepEqual(await evaluateWakeRule(review, at(61), deps()), { kind: "expire" });
});

test("a rule on a pull request ends quietly when it merges, unless it waits for that", async () => {
  let closed: { merged: boolean } | null = null;
  const reviews: GitHubEventFact[] = [];
  const read = deps({
    pullRequestClosed: async (roomId, pr) => (roomId === "room" && pr === 7 ? closed : null),
    githubEventsAfter: async (input) => (input.eventType === "pull_request" && closed ? [{ ...check(5), action: "closed", state: "merged", pr: 7, url: "pr-url" }] : input.eventType === "pull_request_review" ? reviews : []),
  });
  const review = rule({ event: "github.review_submitted", arguments: { pr: 7 }, repeat: true });
  const ci = rule({ event: "github.check_completed", arguments: { pr: 7 } });
  const merge = rule({ event: "github.pr_closed", arguments: { pr: 7 }, repeat: true });
  assert.equal((await evaluateWakeRule(review, at(4), read)).kind, "wait", "an open pull request keeps its rules");

  closed = { merged: true };
  assert.deepEqual(await evaluateWakeRule(review, at(6), read), { kind: "retire", reason: "#7 was merged" });
  assert.deepEqual(await evaluateWakeRule(ci, at(6), read), { kind: "retire", reason: "#7 was merged" });
  assert.deepEqual(await evaluateWakeRule(review, at(24 * 60 + 1), read), { kind: "retire", reason: "#7 was merged" },
    "a retired rule sends no expiry notice either");
  const final = await evaluateWakeRule(merge, at(6), read);
  assert.deepEqual(final.kind === "fire" && [final.facts, final.endedReason], [{ pr: 7, merged: true, url: "pr-url" }, "#7 was merged"],
    "a rule waiting for the merge wakes for it once, then ends");

  // A review that came in before the merge is still reported, as the rule's last wake.
  reviews.push({ ...check(4), action: "submitted", state: "APPROVED", pr: 7, actor: "grace" });
  const lastReview = await evaluateWakeRule(review, at(6), read);
  assert.deepEqual(lastReview.kind === "fire" && [lastReview.facts.reviewer, lastReview.endedReason], ["grace", "#7 was merged"]);

  closed = { merged: false };
  const mergeOnly = rule({ event: "github.pr_closed", arguments: { pr: 7, merged_only: true } });
  assert.deepEqual(await evaluateWakeRule(mergeOnly, at(6), deps({ pullRequestClosed: async () => closed })), { kind: "retire", reason: "#7 was closed" });
  const mine = rule({ event: "github.review_submitted", arguments: { mine: true } });
  assert.equal((await evaluateWakeRule(mine, at(6), deps({ pullRequestClosed: async () => assert.fail("`mine` is not one pull request") }))).kind, "wait");
});

test("a task rule ends when the task is done or cancelled, waking only a rule that waits for it", async () => {
  let status = "in_review";
  const read = deps({ readTaskStatus: async () => status });
  const baseline = { room_id: "board", status: "in_progress" };
  const toReview = rule({ event: "task.status_changed", arguments: { task_id: "task_4", to: ["in_review"] }, baseline: { room_id: "board", status: "in_review" }, repeat: true });
  const anyChange = rule({ event: "task.status_changed", arguments: { task_id: "task_4" }, baseline, repeat: true });
  const toDone = rule({ event: "task.status_changed", arguments: { task_id: "task_4", to: ["merged", "done"] }, baseline, repeat: true });

  status = "done";
  assert.deepEqual(await evaluateWakeRule(toReview, at(5), read), { kind: "retire", reason: "task_4 is done" });
  for (const watching of [anyChange, toDone]) {
    const fired = await evaluateWakeRule(watching, at(5), read);
    assert.deepEqual(fired.kind === "fire" && [fired.facts.status, fired.endedReason], ["done", "task_4 is done"]);
  }
  status = "cancelled";
  assert.deepEqual(await evaluateWakeRule(toDone, at(5), read), { kind: "retire", reason: "task_4 was cancelled" });
  status = "merged";
  const merged = await evaluateWakeRule(toDone, at(5), read);
  assert.equal(merged.kind === "fire" && merged.endedReason, undefined, "merged is not the end of a task");

  // A rule made on a finished task waits for it to be reopened; it is not ended by the state it began in.
  status = "done";
  const reopen = rule({ event: "task.status_changed", arguments: { task_id: "task_4", to: ["accepted"] }, baseline: { room_id: "board", status: "done" } });
  assert.equal((await evaluateWakeRule(reopen, at(5), read)).kind, "wait");
});
