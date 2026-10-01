import {
  WAKE_RULE_LIMITS,
  type WakeCheckFact,
  type WakeOccurrenceFacts,
} from "../../../shared/wake-rules.mjs";
import type { WakeRuleRow } from "../db/wake-rules.js";

/**
 * Event-driven checks wake a rule within moments. This bound only matters
 * when a live signal was lost (an instance restarted mid-event): the rule
 * still reads durable state, so it fires late rather than never.
 */
export const WAKE_RULE_FALLBACK_CHECK_MS = 5 * 60 * 1000;

/**
 * A merge ends a pull request at once. A close without one may be undone:
 * closing and reopening is a common way to re-run CI, so it ends the rules
 * on that pull request only once it has stayed closed this long.
 */
export const WAKE_RULE_UNMERGED_CLOSE_GRACE_MS = 10 * 60 * 1000;

export type WakeRuleEvaluation =
  /** `endedReason`: this wake is the rule's last, because what it watched is over. */
  | { kind: "fire"; facts: WakeOccurrenceFacts; cursorAt: string; baseline: WakeRuleRow["baseline"]; endedReason?: string }
  | { kind: "expire" }
  /**
   * What the rule watched is over and nothing it waits for happened. `wake`
   * when the agent never got what it waited for: it is told once that the
   * wait ended. A rule that already woke it ends quietly.
   */
  | { kind: "retire"; reason: string; wake: boolean }
  /** `cursorAt` moves the rule past events that settled without qualifying. */
  | { kind: "wait"; nextCheckAt: string; cursorAt?: string };

/**
 * Reads of durable state. GitHub reads take the rule's room and look across
 * every room of the same repository: events land in a branch room, a focus
 * room or the repository room depending on routing.
 */
export interface WakeRuleEvaluationDeps {
  readTaskStatus(roomId: string, taskNumber: number): Promise<string | null>;
  ownedWork(agentKey: string, ruleRoomId: string): Promise<{ branches: string[]; pullRequests: number[] }>;
  pullRequestBranches(ruleRoomId: string, pr: number): Promise<string[]>;
  /** How and when the pull request was closed, or null while it is open (or was reopened). */
  pullRequestClosed(ruleRoomId: string, pr: number): Promise<{ merged: boolean; closed_at: string } | null>;
  githubEventsAfter(input: {
    ruleRoomId: string;
    eventType: "check_run" | "pull_request_review" | "pull_request";
    action: "completed" | "submitted" | "closed";
    /** Exclusive lower bound on when the event was recorded. */
    after: string;
    /** Inclusive upper bound: events recorded after a rule expired never fire it. */
    until: string;
    headRefs?: readonly string[];
    pullRequests?: readonly number[];
  }): Promise<GitHubEventFact[]>;
}

export interface GitHubEventFact {
  action: string;
  title: string | null;
  state: string | null;
  url: string | null;
  actor: string | null;
  pr: number | null;
  head_ref: string | null;
  head_sha: string | null;
  recorded_at: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Decide what a rule should do now, from durable state read through `deps`. */
export async function evaluateWakeRule(
  rule: WakeRuleRow,
  now: Date,
  deps: WakeRuleEvaluationDeps,
): Promise<WakeRuleEvaluation> {
  const nowMs = now.getTime();
  const expiresMs = Date.parse(rule.expires_at);
  // A repeating rule wakes at most once per window, whatever prompted the check.
  const quietUntilMs = rule.repeat && rule.last_fired_at
    ? Date.parse(rule.last_fired_at) + WAKE_RULE_LIMITS.repeatDebounceMs
    : 0;
  if (nowMs < quietUntilMs && quietUntilMs < expiresMs) return { kind: "wait", nextCheckAt: iso(quietUntilMs) };
  const occurrence = await findOccurrence(rule, nowMs, deps);
  if (occurrence.kind === "fire") return occurrence;
  if (occurrence.endedReason) return { kind: "retire", reason: occurrence.endedReason, wake: rule.fire_count === 0 };
  if (nowMs >= expiresMs) return { kind: "expire" };
  const fallback = nowMs + WAKE_RULE_FALLBACK_CHECK_MS;
  return {
    kind: "wait",
    nextCheckAt: iso(Math.min(occurrence.nextCheckMs ?? fallback, fallback, expiresMs)),
    ...(occurrence.cursorAt ? { cursorAt: occurrence.cursorAt } : {}),
  };
}

type Occurrence =
  | { kind: "fire"; facts: WakeOccurrenceFacts; cursorAt: string; baseline: WakeRuleRow["baseline"]; endedReason?: string }
  | { kind: "none"; nextCheckMs?: number; cursorAt?: string; endedReason?: string };

/** A task that reaches one of these has nothing more to wait for. */
const FINISHED_TASK_STATUSES = new Set(["done", "cancelled"]);

function taskEndedReason(taskId: string, status: string): string {
  return status === "done" ? `${taskId} is done` : `${taskId} was cancelled`;
}

/**
 * Whether a rule's pull request has ended for good: merged, or closed past the
 * grace for a reopen. While the grace runs, when to look again.
 */
async function findPullRequestEnd(
  rule: WakeRuleRow,
  pr: number,
  nowMs: number,
  deps: WakeRuleEvaluationDeps,
): Promise<{ reason: string } | { finalAtMs: number } | null> {
  const closed = await deps.pullRequestClosed(rule.room_id, pr);
  if (!closed) return null;
  if (closed.merged) return { reason: `#${pr} was merged` };
  const finalAtMs = Date.parse(closed.closed_at) + WAKE_RULE_UNMERGED_CLOSE_GRACE_MS;
  return nowMs >= finalAtMs ? { reason: `#${pr} was closed without merging` } : { finalAtMs };
}

async function findOccurrence(rule: WakeRuleRow, nowMs: number, deps: WakeRuleEvaluationDeps): Promise<Occurrence> {
  // A rule on one pull request ends with it. What happened before the end is
  // still reported first, CI that had not settled included; the end is read
  // before the events, so none recorded before it is missed.
  const pr = rule.event.startsWith("github.") ? rule.arguments.pr : undefined;
  const end = pr ? await findPullRequestEnd(rule, pr, nowMs, deps) : null;
  const ended = end && "reason" in end ? end.reason : undefined;
  const occurrence = await findWatchedOccurrence(rule, nowMs, deps, { ended: Boolean(ended) });
  if (ended) return { ...occurrence, endedReason: ended };
  if (end && "finalAtMs" in end && occurrence.kind === "none") {
    return { ...occurrence, nextCheckMs: Math.min(occurrence.nextCheckMs ?? end.finalAtMs, end.finalAtMs) };
  }
  return occurrence;
}

async function findWatchedOccurrence(
  rule: WakeRuleRow,
  nowMs: number,
  deps: WakeRuleEvaluationDeps,
  options: { ended: boolean },
): Promise<Occurrence> {
  const args = rule.arguments;
  switch (rule.event) {
    case "timer": {
      const atMs = Date.parse(args.at!);
      return nowMs >= atMs
        ? { kind: "fire", facts: {}, cursorAt: iso(nowMs), baseline: rule.baseline }
        : { kind: "none", nextCheckMs: atMs };
    }
    case "task.status_changed": {
      const taskRoomId = rule.baseline?.room_id ?? rule.room_id;
      const previous = rule.baseline?.status ?? null;
      const status = await deps.readTaskStatus(taskRoomId, Number(args.task_id!.slice("task_".length)));
      if (!status || status === previous) return { kind: "none" };
      // Reaching done or cancelled since the rule last looked ends the rule,
      // with the wake for that status when it is one the rule waits for.
      const endedReason = FINISHED_TASK_STATUSES.has(status) ? taskEndedReason(args.task_id!, status) : undefined;
      if (args.to && !args.to.includes(status as never)) return { kind: "none", ...(endedReason ? { endedReason } : {}) };
      return {
        kind: "fire",
        facts: { task_id: args.task_id, status, previous_status: previous ?? "unknown" },
        cursorAt: iso(nowMs),
        baseline: { room_id: taskRoomId, status },
        ...(endedReason ? { endedReason } : {}),
      };
    }
    case "github.check_completed":
      return findCheckOccurrence(rule, nowMs, deps, options);
    case "github.review_submitted":
    case "github.pr_closed": {
      const pullRequests = args.pr ? [args.pr] : (await deps.ownedWork(rule.agent_key, rule.room_id)).pullRequests;
      if (pullRequests.length === 0) return { kind: "none" };
      const closed = rule.event === "github.pr_closed";
      const events = await deps.githubEventsAfter({
        ruleRoomId: rule.room_id,
        eventType: closed ? "pull_request" : "pull_request_review",
        action: closed ? "closed" : "submitted",
        after: rule.cursor_at,
        until: rule.expires_at,
        pullRequests,
      });
      const match = events.find((event) => closed
        ? !args.merged_only || event.state === "merged"
        : !args.states || args.states.includes((event.state ?? "").toLowerCase() as never));
      if (!match) return events.length ? { kind: "none", cursorAt: events.at(-1)!.recorded_at } : { kind: "none" };
      return {
        kind: "fire",
        facts: closed
          ? { pr: match.pr, merged: match.state === "merged", url: match.url }
          : { pr: match.pr, reviewer: match.actor, state: (match.state ?? "").toLowerCase(), url: match.url },
        cursorAt: match.recorded_at,
        baseline: rule.baseline,
      };
    }
    default:
      return { kind: "none" };
  }
}

interface CheckPush {
  headRef: string;
  firstMs: number;
  newestMs: number;
  newestAt: string;
  checks: WakeCheckFact[];
}

/**
 * CI reports check by check. Each branch's newest commit is one push; a push
 * is ready once no check on it has finished for the settle window.
 *
 * A repeating rule's cursor is one moment, so it only moves past pushes that
 * are all ready: when pushes overlap in time (two branches reporting at
 * once), the ready ones wait for the others, and then every push that matters
 * is reported in one wake. No push is reported twice and none is skipped. A
 * one-shot rule ends when it fires, so it never waits, and nor does a rule
 * at its expiry: what already happened is reported, not lost. When the
 * pull request has ended (`ended`), nothing more is coming for it: every
 * push is reported as it stands, without waiting for its checks to settle.
 */
async function findCheckOccurrence(
  rule: WakeRuleRow,
  nowMs: number,
  deps: WakeRuleEvaluationDeps,
  options: { ended: boolean },
): Promise<Occurrence> {
  const args = rule.arguments;
  const branches = args.branch ? [args.branch]
    : args.pr ? await deps.pullRequestBranches(rule.room_id, args.pr)
      : (await deps.ownedWork(rule.agent_key, rule.room_id)).branches;
  if (branches.length === 0) return { kind: "none" };
  const events = await deps.githubEventsAfter({
    ruleRoomId: rule.room_id, eventType: "check_run", action: "completed",
    after: rule.cursor_at, until: rule.expires_at, headRefs: branches,
  });
  if (events.length === 0) return { kind: "none" };

  // Keep only each branch's newest commit, the one whose checks started last:
  // a later push supersedes CI on an earlier one, even if a job is re-run there.
  // Events arrive oldest first, so the first sighting of a commit is its start.
  const commitStarts = new Map<string, Map<string | null, number>>();
  for (const event of events) {
    const starts = commitStarts.get(event.head_ref ?? "") ?? new Map<string | null, number>();
    if (!starts.has(event.head_sha)) starts.set(event.head_sha, Date.parse(event.recorded_at));
    commitStarts.set(event.head_ref ?? "", starts);
  }
  const newestShaByRef = new Map([...commitStarts].map(([headRef, starts]) =>
    [headRef, [...starts].reduce((newest, candidate) => (candidate[1] > newest[1] ? candidate : newest))[0]] as const));
  const pushes = new Map<string, CheckPush>();
  for (const event of events) {
    const headRef = event.head_ref ?? "";
    if (event.head_sha !== newestShaByRef.get(headRef)) continue;
    const recordedMs = Date.parse(event.recorded_at);
    const push = pushes.get(headRef) ?? { headRef, firstMs: recordedMs, newestMs: recordedMs, newestAt: event.recorded_at, checks: [] };
    push.newestMs = recordedMs;
    push.newestAt = event.recorded_at;
    const name = event.title ?? "check";
    // A re-run replaces the earlier result of the same check.
    push.checks = [...push.checks.filter((check) => check.name !== name), { name, conclusion: event.state ?? "unknown", url: event.url }];
    pushes.set(headRef, push);
  }

  const settleAt = (push: CheckPush) => push.newestMs + WAKE_RULE_LIMITS.checkSettleMs;
  const ordered = [...pushes.values()].sort((left, right) => left.newestMs - right.newestMs);
  const ready = ordered.filter((push) => options.ended || nowMs >= settleAt(push));
  const settling = ordered.filter((push) => !options.ended && nowMs < settleAt(push));
  if (ready.length === 0) return { kind: "none", nextCheckMs: Math.min(...settling.map(settleAt)) };

  const readyUntilMs = ready.at(-1)!.newestMs;
  const overlapping = settling.filter((push) => push.firstMs <= readyUntilMs);
  const mustWait = rule.repeat && nowMs < Date.parse(rule.expires_at);
  if (overlapping.length && mustWait) return { kind: "none", nextCheckMs: Math.max(...overlapping.map(settleAt)) };

  const matters = (push: CheckPush) => !args.conclusions
    || push.checks.some((check) => args.conclusions!.includes(check.conclusion as never));
  const reported = ready.filter(matters);
  const cursorAt = iso(readyUntilMs);
  if (reported.length) {
    return {
      kind: "fire",
      facts: { pr: args.pr ?? null, pushes: reported.map((push) => ({ head_ref: push.headRef || null, checks: push.checks })), cursor_at: cursorAt },
      cursorAt,
      baseline: rule.baseline,
    };
  }
  return {
    kind: "none",
    nextCheckMs: settling.length ? Math.min(...settling.map(settleAt)) : undefined,
    // A `mine` rule keeps re-reading: work claimed later may still own these
    // pushes. And the cursor never passes a push that is still reporting.
    ...(args.mine || overlapping.length ? {} : { cursorAt }),
  };
}
