export type WakeRuleEvent =
  | "timer"
  | "task.status_changed"
  | "github.check_completed"
  | "github.review_submitted"
  | "github.pr_closed"
  | "room.message";
export type WakeRuleStatus = "active" | "fired" | "expired" | "cancelled" | "retired" | "paused" | "pending_confirmation";
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
  /** room.message: messages for this agent (mentions, replies, its threads, notices addressed to it). The default. */
  mentions_me?: true;
  /** room.message: every top-level message except the agent's own (and other agents', unless include_agents). */
  any?: true;
  /** room.message with any: also messages from other agents. */
  include_agents?: true;
}

/** Where a room.message rule delivers. Accepted on input only; never returned. */
export interface WakeRuleWebhookInput {
  url: string;
  secret: string;
  /** Sent as `Authorization: Bearer <bearer>` to receivers that require a sender key. Stored sealed; never returned. */
  bearer?: string;
}
export interface WakeRuleEmailInput { to: string }

export interface WakeRuleInput {
  event: WakeRuleEvent;
  arguments?: Record<string, unknown>;
  repeat?: boolean;
  expires_at?: string | null;
  note?: string | null;
  /** room.message needs exactly one of webhook or email; every other event refuses both. */
  webhook?: WakeRuleWebhookInput;
  email?: WakeRuleEmailInput;
}

export interface ParsedWakeRuleInput {
  event: WakeRuleEvent;
  arguments: WakeRuleArguments;
  repeat: boolean;
  /** Always set for new rules (a room.message rule lasts 30 days by default); null only on rules made before that. */
  expires_at: string | null;
  note: string | null;
}

/** How a room.message rule reaches its agent. */
export type WakeRuleDeliveryKind = "webhook" | "email" | "mcp_event";

/**
 * How a room.message rule's deliveries go. Everyone in the room sees the kind
 * and whether it is paused; the counts and the last result are shown only to
 * the account that owns the agent. The target (URL, secret, address) is never returned.
 */
export interface WakeRuleDeliverySummary {
  kind: WakeRuleDeliveryKind;
  paused: boolean;
  /** Owner only: whether a webhook sender key (`webhook.bearer`) is stored. Never the key. */
  has_bearer?: boolean;
  delivered_count?: number;
  /** Deliveries in a row that failed for good; five pause the rule. */
  consecutive_failures?: number;
  /** Matches that arrived while an hourly budget was spent; they folded into the delivery that waits for the hour's end. */
  over_cap_count?: number;
  last_status?: number | null;
  last_error?: string | null;
  last_attempt_at?: string | null;
  /** Owner only: whether the last attempt (and so `last_status` and `last_error`) was a person's test, not a delivery of a room message. */
  last_attempt_was_test?: boolean;
  /**
   * MCP Events subscriptions only (owner view): the id ChatGPT holds, its event
   * name, when it must renew, and the delivered-up-to cursor (the subscribe
   * answer may give a lower watermark while events still wait to go out).
   */
  subscription_id?: string;
  event_name?: string;
  refresh_before?: string | null;
  cursor?: string | null;
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
  /** Set for a rule that reaches its agent outside the room, by webhook (absent from older servers). */
  delivery?: WakeRuleDeliverySummary | null;
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

/** One of the viewer's own agents in a room, as the webhook wake-up form's agent picker lists it. */
export interface WakeWebhookAgent {
  agent_key: string;
  agent_name: string;
  /** Whether the agent holds a live session in the room now. */
  live: boolean;
  last_seen_at: string;
}

/** What a person fills in to wake one of their agents by webhook. The secret is made by the app and shown once. */
export interface WakeWebhookFormInput {
  url: string;
  secret: string;
  /** The receiver's sender key, sent as `Authorization: Bearer`. */
  bearer?: string;
  note?: string | null;
}

/** The answer to a person's test delivery: the receiver's status, or 0 and an error class when no answer came. */
export interface WakeRuleTestResult {
  status: number;
  error_class: string | null;
  /** The test delivery's id (the `delivery_id` the receiver saw), or null when nothing was sent. */
  delivery_id: string | null;
  /** True when the receiver accepted the test and that resumed a paused rule. */
  resumed: boolean;
}

/** Supplied by each app to the shared webhook wake-up form. */
export interface WakeWebhookApi {
  listAgents(roomId: string): Promise<WakeWebhookAgent[]>;
  add(roomId: string, agentKey: string, input: WakeWebhookFormInput): Promise<{ rule: WakeRule; created: boolean }>;
  test(roomId: string, ruleId: string): Promise<WakeRuleTestResult>;
  cancel(roomId: string, ruleId: string): Promise<WakeRule>;
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
export const WAKE_RULE_DELIVERY_KINDS: readonly WakeRuleDeliveryKind[];
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
  webhookMaxTtlMs: number;
  webhookCoalesceMs: number;
  webhookHourlyCap: number;
  roomHourlyCap: number;
  hostHourlyCapPerAccount: number;
  deliveryRulesPerAccount: number;
  emailConfirmationsPerAddressPerDay: number;
  emailConfirmationsPerAccountPerDay: number;
  mcpEventDefaultTtlMs: number;
  mcpEventMinTtlMs: number;
  mcpEventMaxTtlMs: number;
  mcpEventReplayMax: number;
  mcpEventHeldMax: number;
  mcpEventSecretRotationMs: number;
  mcpEventVerificationCacheMs: number;
  mcpEventMaxBodyBytes: number;
  mcpEventSecretMinBytes: number;
  mcpEventSecretMaxBytes: number;
  webhookPauseAfterFailures: number;
  webhookTextPreviewMax: number;
  webhookUrlMaxLength: number;
  webhookSecretMinLength: number;
  webhookSecretMaxLength: number;
  webhookBearerMinLength: number;
  webhookBearerMaxLength: number;
  emailMaxLength: number;
  emailConfirmTtlMs: number;
  emailConfirmResendMs: number;
  emailPendingPerAccount: number;
}>;
export const WAKE_TASK_STATUSES: readonly WakeTaskStatus[];
export const WAKE_CHECK_CONCLUSIONS: readonly WakeCheckConclusion[];
export const WAKE_REVIEW_STATES: readonly WakeReviewState[];

export class WakeRuleError extends Error { status: number; constructor(message: string, status?: number) }

export function parseWakeRuleInput(value: unknown, now?: Date): ParsedWakeRuleInput;
export function parseWakeRuleWebhook(value: unknown): WakeRuleWebhookInput;
export function parseWakeRuleEmail(value: unknown): WakeRuleEmailInput;
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
