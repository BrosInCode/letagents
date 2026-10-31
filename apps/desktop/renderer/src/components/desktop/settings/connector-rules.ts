import {
  TRACKER_RULE_CHECK_CONCLUSIONS,
  TRACKER_RULE_EVENT_ACTIONS,
  TRACKER_RULE_REVIEW_STATES,
  TRACKER_RULE_TEMPLATE_VARIABLES,
  type TrackerRuleAction,
  type TrackerRuleEvent,
  type TrackerRuleInput,
  type TrackerRuleTrigger,
  type TrackerRuleVersionView,
  type TrackerRuleView,
} from "../../../../../../../shared/ticket-connectors.mjs";

export const ruleEventOptions: Array<{ value: TrackerRuleEvent; label: string }> = [
  { value: "pull_request", label: "Pull request" },
  { value: "pull_request_review", label: "Pull request review" },
  { value: "check_run", label: "Check run" },
];

const ACTION_LABELS: Record<string, string> = {
  opened: "opened",
  reopened: "reopened",
  ready_for_review: "ready for review",
  converted_to_draft: "changed to draft",
  synchronize: "new commits pushed",
  closed: "closed",
  submitted: "submitted",
  dismissed: "dismissed",
  completed: "completed",
};

export function ruleActionOptions(event: TrackerRuleEvent): Array<{ value: string; label: string }> {
  return TRACKER_RULE_EVENT_ACTIONS[event].map((value) => ({ value, label: ACTION_LABELS[value] ?? value }));
}

export const reviewStateOptions = TRACKER_RULE_REVIEW_STATES.map((value) => ({ value, label: value.split("_").join(" ") }));
export const checkConclusionOptions = TRACKER_RULE_CHECK_CONCLUSIONS.map((value) => ({ value, label: value.split("_").join(" ") }));
export const templateVariableHint = TRACKER_RULE_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ");

/** "" means "any". */
export type TriState = "" | "true" | "false";

/** The editor's form state. Strings, so inputs and selects bind directly. */
export interface RuleDraft {
  id: string | null;
  name: string;
  room_id: string;
  enabled: boolean;
  event: TrackerRuleEvent;
  action: string;
  merged: TriState;
  draft: TriState;
  baseBranch: string;
  reviewState: string;
  approvalsAtLeast: string;
  conclusion: string;
  actions: TrackerRuleAction[];
}

function triState(value: boolean | undefined): TriState {
  return value === undefined ? "" : value ? "true" : "false";
}

export function emptyRuleDraft(): RuleDraft {
  return {
    id: null,
    name: "",
    room_id: "",
    enabled: true,
    event: "pull_request",
    action: "opened",
    merged: "",
    draft: "false",
    baseBranch: "",
    reviewState: "",
    approvalsAtLeast: "",
    conclusion: "",
    actions: [{ kind: "transition", toStatus: "" }],
  };
}

/**
 * The editor state for a rule, a saved version, or a rule drafted elsewhere
 * (PR6 turns a sentence into a `TrackerRuleInput` and hands it to the editor
 * through this function; the person still presses Save).
 */
export function ruleDraftFrom(
  rule: Pick<TrackerRuleInput, "name" | "room_id" | "trigger" | "actions"> & { enabled?: boolean },
  id: string | null = null,
): RuleDraft {
  const trigger = rule.trigger;
  return {
    id,
    name: rule.name,
    room_id: rule.room_id ?? "",
    enabled: rule.enabled ?? true,
    event: trigger.event,
    action: trigger.action,
    merged: triState(trigger.merged),
    draft: triState(trigger.draft),
    baseBranch: trigger.baseBranch ?? "",
    reviewState: trigger.reviewState ?? "",
    approvalsAtLeast: trigger.approvalsAtLeast === undefined ? "" : String(trigger.approvalsAtLeast),
    conclusion: trigger.conclusion ?? "",
    actions: rule.actions.map((action) => ({ ...action })),
  };
}

/** Which trigger fields the editor shows for an event and action. */
export function ruleFieldsFor(event: TrackerRuleEvent, action: string) {
  return {
    merged: event === "pull_request" && action === "closed",
    draft: event === "pull_request",
    baseBranch: event !== "check_run",
    reviewState: event === "pull_request_review",
    approvalsAtLeast: event === "pull_request_review",
    conclusion: event === "check_run",
  };
}

/** The rule the server receives. Fields that do not fit the event are left out; the server checks the rest. */
export function ruleInputFromDraft(draft: RuleDraft): TrackerRuleInput {
  const fields = ruleFieldsFor(draft.event, draft.action);
  const trigger: TrackerRuleTrigger = { event: draft.event, action: draft.action };
  if (fields.merged && draft.merged) trigger.merged = draft.merged === "true";
  if (fields.draft && draft.draft) trigger.draft = draft.draft === "true";
  if (fields.baseBranch && draft.baseBranch.trim()) trigger.baseBranch = draft.baseBranch.trim();
  if (fields.reviewState && draft.reviewState) trigger.reviewState = draft.reviewState;
  if (fields.approvalsAtLeast && draft.approvalsAtLeast.trim()) trigger.approvalsAtLeast = Number(draft.approvalsAtLeast);
  if (fields.conclusion && draft.conclusion) trigger.conclusion = draft.conclusion;
  return {
    name: draft.name.trim(),
    room_id: draft.room_id || null,
    enabled: draft.enabled,
    trigger,
    actions: draft.actions.map((action) => action.kind === "transition"
      ? { kind: "transition", toStatus: action.toStatus.trim() }
      : { kind: "comment", template: action.template.trim() }),
  };
}

/** One line: "Pull request opened, not draft, into main → In Review, comment". */
export function ruleSummary(rule: Pick<TrackerRuleView | TrackerRuleVersionView, "trigger" | "actions">): string {
  const trigger = rule.trigger;
  const event = ruleEventOptions.find((option) => option.value === trigger.event)?.label ?? trigger.event;
  const parts = [`${event} ${ACTION_LABELS[trigger.action] ?? trigger.action}`];
  if (trigger.merged !== undefined) parts.push(trigger.merged ? "merged" : "not merged");
  if (trigger.draft !== undefined) parts.push(trigger.draft ? "draft" : "not draft");
  if (trigger.baseBranch) parts.push(`into ${trigger.baseBranch}`);
  if (trigger.reviewState) parts.push(trigger.reviewState.split("_").join(" "));
  if (trigger.approvalsAtLeast !== undefined) parts.push(`${trigger.approvalsAtLeast}+ approvals`);
  if (trigger.conclusion) parts.push(trigger.conclusion.split("_").join(" "));
  const actions = rule.actions.map((action) => action.kind === "transition" ? `move to ${action.toStatus}` : "comment");
  return `${parts.join(", ")} → ${actions.join(", ")}`;
}
