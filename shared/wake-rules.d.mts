export type WakeRuleEvent =
  | "timer"
  | "task.status_changed"
  | "github.check_completed"
  | "github.review_submitted"
  | "github.pr_closed";
export type WakeRuleStatus = "active" | "fired" | "expired" | "cancelled" | "retired";
export type WakeTaskStatus =
  | "proposed" | "accepted" | "assigned" | "in_progress" | "blocked" | "in_review" | "merged" | "done" | "cancelled";
export type WakeCheckConclusion =
  | "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale";
export type WakeReviewState = "approved" | "changes_requested" | "commented";

export interface WakeRuleArguments {
  at?: string;
  task_id?: string;
  to?: WakeTaskStatus[];
  branch?: string;
  pr?: number;
  mine?: true;
  conclusions?: WakeCheckConclusion[];
  states?: WakeReviewState[];
  merged_only?: true;
}

export interface WakeRuleInput {
  event: WakeRuleEvent;
  arguments?: Record<string, unknown>;
  repeat?: boolean;
  expires_at?: string;
  note?: string | null;
}

export interface ParsedWakeRuleInput {
  event: WakeRuleEvent;
  arguments: WakeRuleArguments;
  repeat: boolean;
  expires_at: string;
  note: string | null;
}

export interface WakeRuleActor { kind: "agent" | "human"; id: string; label: string }

/** A rule as the API returns it to agents, people and apps. */
export interface WakeRule extends ParsedWakeRuleInput {
  id: string;
  room_id: string;
  agent_key: string;
  agent_name: string;
  status: WakeRuleStatus;
  created_at: string;
  updated_at: string;
  fire_count: number;
  last_fired_at: string | null;
  /** The room message that last woke the agent, when it fired or expired. */
  wake_message_id: string | null;
  cancelled_by: WakeRuleActor | null;
  /** Why the rule ended before its expiry, e.g. "#7 was merged" or "task_4 is done". */
  ended_reason: string | null;
}

export interface WakeRulePage {
  room_id: string;
  active: WakeRule[];
  /** Rules that fired, expired, were cancelled or retired in the last 7 days, newest first. */
  recent: WakeRule[];
}

/** Supplied by each app to the shared wake-rule components. */
export interface WakeRuleApi {
  list(roomId: string): Promise<WakeRulePage>;
  cancel(roomId: string, ruleId: string): Promise<WakeRule>;
  restore(roomId: string, ruleId: string): Promise<WakeRule>;
}

/** `ended`: what the rule waited for can no longer happen; `endedReason` says why. */
export type WakeNoticeOutcome = "fired" | "expired" | "ended";

export interface WakeCheckFact { name: string; conclusion: string; url: string | null }
export interface WakeCheckPushFact { head_ref: string | null; checks: WakeCheckFact[] }
export interface WakeOccurrenceFacts {
  task_id?: string;
  status?: string;
  previous_status?: string;
  pr?: number | null;
  /** CI: every settled push that mattered, each with the latest result of its checks. */
  pushes?: WakeCheckPushFact[];
  reviewer?: string | null;
  state?: string;
  merged?: boolean;
  url?: string | null;
  /** The newest event considered, so a repeating rule only looks after it. */
  cursor_at?: string;
}

export const WAKE_RULE_EVENTS: readonly WakeRuleEvent[];
export const WAKE_RULE_STATUSES: readonly WakeRuleStatus[];
export const WAKE_NOTICE_SOURCE: "wake_rule";
export const WAKE_RULE_LIMITS: Readonly<{
  activePerAgent: number;
  defaultTtlMs: number;
  maxTtlMs: number;
  minLeadMs: number;
  noteMaxLength: number;
  branchMaxLength: number;
  repeatDebounceMs: number;
  checkSettleMs: number;
  timerGraceMs: number;
}>;
export const WAKE_TASK_STATUSES: readonly WakeTaskStatus[];
export const WAKE_CHECK_CONCLUSIONS: readonly WakeCheckConclusion[];
export const WAKE_REVIEW_STATES: readonly WakeReviewState[];

export class WakeRuleError extends Error { status: number; constructor(message: string, status?: number) }

export function parseWakeRuleInput(value: unknown, now?: Date): ParsedWakeRuleInput;
export function wakeRuleIdentityKey(event: WakeRuleEvent, args: WakeRuleArguments): string;
export function isFailedCheckConclusion(conclusion: string): boolean;

type Describable = Pick<WakeRule, "event" | "arguments">;
export interface WakeRuleDescribeOptions { formatTime?: (iso: string) => string }
export function describeWakeRule(rule: Describable, options?: WakeRuleDescribeOptions): { preposition: "for" | "until"; object: string };
export function wakeRuleLabel(rule: Describable, options?: WakeRuleDescribeOptions): string;
export function describeWakeOccurrence(rule: Describable, facts: WakeOccurrenceFacts): string;
export function formatWakeNotice(input: {
  rule: Pick<WakeRule, "id" | "event" | "arguments" | "note" | "repeat" | "expires_at"> & { fire_count?: number };
  outcome: WakeNoticeOutcome;
  facts: WakeOccurrenceFacts;
  agentName: string | null | undefined;
  /** This wake is the rule's last: what it watched is over. Required for `ended`. */
  endedReason?: string | null;
}): { text: string; display_text: string };

export function formatWakeClock(iso: string, now?: Date, locale?: string): string;
export function formatWakeSpan(ms: number): string;
export function wakeRuleTiming(
  rule: Pick<WakeRule, "event" | "arguments" | "created_at">,
  now?: Date,
  locale?: string,
): { text: string; datetime: string };
export function summarizeWakeRuleParts(
  rules: readonly Pick<WakeRule, "event" | "arguments" | "created_at">[] | null | undefined,
  now?: Date,
  locale?: string,
): { label: string; detail: string } | null;
export function summarizeWakeRules(
  rules: readonly Pick<WakeRule, "event" | "arguments" | "created_at">[] | null | undefined,
  now?: Date,
  locale?: string,
): string | null;
