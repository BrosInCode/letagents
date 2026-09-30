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

export type WakeRuleEvaluation =
  | { kind: "fire"; facts: WakeOccurrenceFacts; cursorAt: string; baseline: WakeRuleRow["baseline"] }
  | { kind: "expire" }
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
  if (nowMs >= expiresMs) return { kind: "expire" };
  const fallback = nowMs + WAKE_RULE_FALLBACK_CHECK_MS;
  return {
    kind: "wait",
    nextCheckAt: iso(Math.min(occurrence.nextCheckMs ?? fallback, fallback, expiresMs)),
    ...(occurrence.cursorAt ? { cursorAt: occurrence.cursorAt } : {}),
  };
}

type Occurrence =
  | { kind: "fire"; facts: WakeOccurrenceFacts; cursorAt: string; baseline: WakeRuleRow["baseline"] }
  | { kind: "none"; nextCheckMs?: number; cursorAt?: string };

async function findOccurrence(rule: WakeRuleRow, nowMs: number, deps: WakeRuleEvaluationDeps): Promise<Occurrence> {
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
      if (!status || status === previous || (args.to && !args.to.includes(status as never))) return { kind: "none" };
      return {
        kind: "fire",
        facts: { task_id: args.task_id, status, previous_status: previous ?? "unknown" },
        cursorAt: iso(nowMs),
        baseline: { room_id: taskRoomId, status },
      };
    }
    case "github.check_completed":
      return findCheckOccurrence(rule, nowMs, deps);
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
 * at its expiry: what already happened is reported, not lost.
 */
async function findCheckOccurrence(rule: WakeRuleRow, nowMs: number, deps: WakeRuleEvaluationDeps): Promise<Occurrence> {
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
  const ready = ordered.filter((push) => nowMs >= settleAt(push));
  const settling = ordered.filter((push) => nowMs < settleAt(push));
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
