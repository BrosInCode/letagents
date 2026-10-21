import {
  STATUS_NAME_MAX_LENGTH,
  TRACKER_RULE_BRANCH_MAX_LENGTH,
  TRACKER_RULE_CHECK_CONCLUSIONS,
  TRACKER_RULE_EVENT_ACTIONS,
  TRACKER_RULE_EVENTS,
  TRACKER_RULE_MAX_ACTIONS,
  TRACKER_RULE_MAX_APPROVALS,
  TRACKER_RULE_NAME_MAX_LENGTH,
  TRACKER_RULE_REVIEW_STATES,
  TRACKER_RULE_TEMPLATE_MAX_LENGTH,
  TRACKER_RULE_TEMPLATE_VARIABLES,
  type TrackerRuleAction,
  type TrackerRuleEvent,
  type TrackerRuleInput,
  type TrackerRuleTrigger,
} from "../../../../shared/ticket-connectors.mjs";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const TRIGGER_KEYS = new Set(["event", "action", "merged", "draft", "baseBranch", "reviewState", "approvalsAtLeast", "conclusion"]);
/** Trigger fields that only make sense for one event. */
const EVENT_ONLY_FIELDS: Record<string, TrackerRuleEvent> = {
  merged: "pull_request",
  draft: "pull_request",
  reviewState: "pull_request_review",
  approvalsAtLeast: "pull_request_review",
  conclusion: "check_run",
};
const ROOM_ID_MAX_LENGTH = 512;
// Git refuses these in a ref name; refusing them here keeps the field a plain branch name.
const BRANCH_NAME = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\u0000-\u001f\u007f]+(?<!\/)(?<!\.lock)$/;
const TEMPLATE_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

/** Strict: unknown keys, wrong types and fields that do not fit the event are refused. */
export function parseTrackerRuleTrigger(raw: unknown): ParseResult<TrackerRuleTrigger> {
  if (!isRecord(raw)) return fail("The trigger must be an object.");
  const extra = unknownKey(raw, TRIGGER_KEYS);
  if (extra) return fail(`The trigger has an unknown field "${extra}".`);
  const event = raw.event;
  if (typeof event !== "string" || !(TRACKER_RULE_EVENTS as readonly string[]).includes(event)) {
    return fail(`The trigger event must be one of ${TRACKER_RULE_EVENTS.join(", ")}.`);
  }
  const ruleEvent = event as TrackerRuleEvent;
  const actions = TRACKER_RULE_EVENT_ACTIONS[ruleEvent];
  if (typeof raw.action !== "string" || !actions.includes(raw.action)) {
    return fail(`The trigger action for ${ruleEvent} must be one of ${actions.join(", ")}.`);
  }
  for (const [field, only] of Object.entries(EVENT_ONLY_FIELDS)) {
    if (raw[field] !== undefined && only !== ruleEvent) return fail(`"${field}" applies only to ${only} triggers.`);
  }
  const trigger: TrackerRuleTrigger = { event: ruleEvent, action: raw.action };
  for (const field of ["merged", "draft"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "boolean") return fail(`"${field}" must be true or false.`);
    trigger[field] = raw[field] as boolean;
  }
  if (raw.merged !== undefined && raw.action !== "closed") return fail(`"merged" applies only to the closed action.`);
  if (raw.baseBranch !== undefined) {
    if (ruleEvent === "check_run") return fail(`"baseBranch" does not apply to check_run triggers.`);
    if (typeof raw.baseBranch !== "string" || raw.baseBranch.length > TRACKER_RULE_BRANCH_MAX_LENGTH
      || !BRANCH_NAME.test(raw.baseBranch)) {
      return fail(`"baseBranch" must be a branch name such as main.`);
    }
    trigger.baseBranch = raw.baseBranch;
  }
  if (raw.reviewState !== undefined) {
    if (typeof raw.reviewState !== "string" || !TRACKER_RULE_REVIEW_STATES.includes(raw.reviewState)) {
      return fail(`"reviewState" must be one of ${TRACKER_RULE_REVIEW_STATES.join(", ")}.`);
    }
    trigger.reviewState = raw.reviewState;
  }
  if (raw.approvalsAtLeast !== undefined) {
    const count = raw.approvalsAtLeast;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > TRACKER_RULE_MAX_APPROVALS) {
      return fail(`"approvalsAtLeast" must be a whole number from 1 to ${TRACKER_RULE_MAX_APPROVALS}.`);
    }
    trigger.approvalsAtLeast = count;
  }
  if (raw.conclusion !== undefined) {
    if (typeof raw.conclusion !== "string" || !TRACKER_RULE_CHECK_CONCLUSIONS.includes(raw.conclusion)) {
      return fail(`"conclusion" must be one of ${TRACKER_RULE_CHECK_CONCLUSIONS.join(", ")}.`);
    }
    trigger.conclusion = raw.conclusion;
  }
  return { ok: true, value: trigger };
}

/** The placeholder names a template uses; unknown names make the template invalid. */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(TEMPLATE_PLACEHOLDER)].map((match) => match[1]!);
}

export function parseTrackerRuleAction(raw: unknown, index: number): ParseResult<TrackerRuleAction> {
  const label = `Action ${index + 1}`;
  if (!isRecord(raw)) return fail(`${label} must be an object.`);
  if (raw.kind === "transition") {
    const extra = unknownKey(raw, new Set(["kind", "toStatus"]));
    if (extra) return fail(`${label} has an unknown field "${extra}".`);
    const toStatus = typeof raw.toStatus === "string" ? raw.toStatus.trim() : "";
    if (!toStatus || toStatus.length > STATUS_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(toStatus)) {
      return fail(`${label}: name the tracker status to move the ticket to (1 to ${STATUS_NAME_MAX_LENGTH} characters).`);
    }
    return { ok: true, value: { kind: "transition", toStatus } };
  }
  if (raw.kind === "comment") {
    const extra = unknownKey(raw, new Set(["kind", "template"]));
    if (extra) return fail(`${label} has an unknown field "${extra}".`);
    const template = typeof raw.template === "string" ? raw.template.trim() : "";
    if (!template || template.length > TRACKER_RULE_TEMPLATE_MAX_LENGTH) {
      return fail(`${label}: the comment must be 1 to ${TRACKER_RULE_TEMPLATE_MAX_LENGTH} characters.`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(template)) return fail(`${label}: the comment has control characters.`);
    const unknown = templatePlaceholders(template)
      .find((name) => !(TRACKER_RULE_TEMPLATE_VARIABLES as readonly string[]).includes(name));
    if (unknown !== undefined) {
      return fail(`${label}: "{{${unknown}}}" is not a template variable. Use ${TRACKER_RULE_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ")}.`);
    }
    return { ok: true, value: { kind: "comment", template } };
  }
  return fail(`${label} must be a transition or a comment.`);
}

const INPUT_KEYS = new Set(["name", "room_id", "enabled", "trigger", "actions"]);

/** Validates a whole rule as the editor sends it. Strict, like the parts. */
export function parseTrackerRuleInput(raw: unknown): ParseResult<TrackerRuleInput> {
  if (!isRecord(raw)) return fail("Send the rule as an object.");
  const extra = unknownKey(raw, INPUT_KEYS);
  if (extra) return fail(`The rule has an unknown field "${extra}".`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > TRACKER_RULE_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return fail(`Give the rule a name of 1 to ${TRACKER_RULE_NAME_MAX_LENGTH} characters.`);
  }
  let roomId: string | null = null;
  if (raw.room_id !== undefined && raw.room_id !== null) {
    if (typeof raw.room_id !== "string" || !raw.room_id.trim() || raw.room_id.length > ROOM_ID_MAX_LENGTH) {
      return fail("The room must be a room id, or empty for every room.");
    }
    roomId = raw.room_id.trim();
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return fail("enabled must be true or false.");
  const trigger = parseTrackerRuleTrigger(raw.trigger);
  if (!trigger.ok) return trigger;
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > TRACKER_RULE_MAX_ACTIONS) {
    return fail(`A rule needs 1 to ${TRACKER_RULE_MAX_ACTIONS} actions.`);
  }
  const actions: TrackerRuleAction[] = [];
  for (const [index, entry] of raw.actions.entries()) {
    const action = parseTrackerRuleAction(entry, index);
    if (!action.ok) return action;
    actions.push(action.value);
  }
  if (actions.filter((action) => action.kind === "transition").length > 1) {
    return fail("A rule can move the ticket to one status only.");
  }
  return {
    ok: true,
    value: {
      name,
      room_id: roomId,
      ...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
      trigger: trigger.value,
      actions,
    },
  };
}
