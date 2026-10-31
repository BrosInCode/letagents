import type { TrackerRuleEvent, TrackerRuleTrigger } from "../../../../shared/ticket-connectors.mjs";

/** What the matcher knows about one repo event. Unknown facts are null. */
export interface TrackerRuleEventFacts {
  event: TrackerRuleEvent;
  action: string;
  merged?: boolean | null;
  draft?: boolean | null;
  baseBranch?: string | null;
  reviewState?: string | null;
  /** Reviewers whose latest review approves, this event included. Null when not counted. */
  approvals?: number | null;
  conclusion?: string | null;
}

export interface MatchableTrackerRule {
  id: string;
  enabled: boolean;
  trigger: TrackerRuleTrigger;
}

function lower(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

/** Whether every field the trigger sets matches the event. A fact that is unknown never matches a set field. */
export function triggerMatches(trigger: TrackerRuleTrigger, facts: TrackerRuleEventFacts): boolean {
  if (trigger.event !== facts.event || trigger.action !== facts.action) return false;
  if (trigger.merged !== undefined && (facts.merged ?? null) !== trigger.merged) return false;
  if (trigger.draft !== undefined && (facts.draft ?? null) !== trigger.draft) return false;
  if (trigger.baseBranch !== undefined && facts.baseBranch !== trigger.baseBranch) return false;
  if (trigger.reviewState !== undefined && lower(facts.reviewState) !== trigger.reviewState) return false;
  if (trigger.approvalsAtLeast !== undefined
    && (typeof facts.approvals !== "number" || facts.approvals < trigger.approvalsAtLeast)) return false;
  if (trigger.conclusion !== undefined && lower(facts.conclusion) !== trigger.conclusion) return false;
  return true;
}

/**
 * Every enabled rule whose trigger matches, in the order given. Pure: the
 * caller loads the rules and the facts, and decides what a match does.
 */
export function matchTrackerRules<R extends MatchableTrackerRule>(
  rules: readonly R[],
  facts: TrackerRuleEventFacts,
): R[] {
  return rules.filter((rule) => rule.enabled && triggerMatches(rule.trigger, facts));
}

/** Whether any rule needs the approval count, so the caller counts only when it must. */
export function rulesNeedApprovalCount(rules: readonly MatchableTrackerRule[]): boolean {
  return rules.some((rule) => rule.enabled && rule.trigger.approvalsAtLeast !== undefined);
}
