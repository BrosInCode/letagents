/**
 * Rule drafting (ticket connectors PR6): a plain sentence in, rule JSON out
 * for the PR5 editor. Jev is a choice model, so the draft is a set of Choice
 * questions over the fields a rule can hold (event, action, merged, draft,
 * review state, check result, target status among the connection's own
 * status names, comment or not). The server builds the rule from the chosen
 * options and validates it with `parseTrackerRuleInput`, exactly as a typed
 * rule. Nothing is saved: the person reviews the draft and presses Save.
 */
import {
  DEFAULT_STATUS_MAPS,
  JEV_RULE_DRAFT_MAX_CHARS,
  TRACKER_RULE_CHECK_CONCLUSIONS,
  TRACKER_RULE_EVENT_ACTIONS,
  TRACKER_RULE_NAME_MAX_LENGTH,
  type TrackerProvider,
  type TrackerRuleAction,
  type TrackerRuleDraftResult,
  type TrackerRuleInput,
  type TrackerRuleTrigger,
} from "../../../../shared/ticket-connectors.mjs";
import type { JevEndpoint } from "../../messages/jev-conversation-routing.js";
import { parseTrackerRuleInput } from "../rules/validate.js";
import { askJevChoices, JEV_UNTRUSTED_TEXT_NOTE, textForJev, type JevChoiceAnswer, type JevEvaluate } from "./choice.js";
import type { JevQuestionStore } from "./store.js";

/** A required field (event, action) needs at least this score; an optional one at least `OPTIONAL_MIN`. */
export const RULE_DRAFT_REQUIRED_MIN = 0.5;
export const RULE_DRAFT_OPTIONAL_MIN = 0.6;
export const RULE_DRAFT_MAX_STATUSES = 30;
export const RULE_DRAFT_COMMENT_TEMPLATE = "PR {{pr_number}} by {{author}}: {{pr_url}}";

const ANY = "any";

function options(values: readonly string[], describe: (value: string) => string, any?: string): Record<string, string> {
  const result: Record<string, string> = Object.fromEntries(values.map((value) => [value, describe(value)]));
  if (any) result[ANY] = any;
  return result;
}

/** The connection's status names: its status map, else the tracker's defaults. At most 30. */
export function ruleDraftStatusNames(provider: TrackerProvider, statusMap: Record<string, string>): string[] {
  const names = Object.keys(statusMap).length > 0 ? Object.keys(statusMap) : Object.keys(DEFAULT_STATUS_MAPS[provider]);
  // `type:<type>` entries are categories, not statuses a rule can move a ticket to.
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && !/^type:/i.test(name)))]
    .slice(0, RULE_DRAFT_MAX_STATUSES);
}

export function buildRuleDraftQuestions(sentence: string, statusNames: readonly string[]) {
  const statusOptions: Record<string, string> = {};
  const statusByOption = new Map<string, string>();
  statusNames.forEach((name, index) => {
    const option = `status_${index + 1}`;
    statusByOption.set(option, name);
    statusOptions[option] = `Move the ticket to the status ${JSON.stringify(textForJev(name, 100))}.`;
  });
  statusOptions.no_status = "The sentence does not ask to change the ticket's status.";
  return {
    statusByOption,
    request: {
      state: {
        note: JEV_UNTRUSTED_TEXT_NOTE,
        task: "Turn a sentence that describes an automation rule into its fields. A rule reacts to a GitHub pull request,"
          + " review or check event and then moves a ticket to a status, comments on it, or both.",
        sentence_untrusted: textForJev(sentence, JEV_RULE_DRAFT_MAX_CHARS),
        statuses_untrusted: statusNames.map((name) => textForJev(name, 100)),
      },
      questions: {
        event: {
          instructions: "Which GitHub event starts the rule?",
          options: {
            pull_request: "Something happens to a pull request (opened, ready for review, closed, merged, a new push).",
            pull_request_review: "A review of a pull request is submitted or dismissed.",
            check_run: "A CI check finishes.",
          },
        },
        pr_action: {
          instructions: "If the event is about a pull request, what happens to it? (Merged and closed are both `closed`.)",
          options: options(TRACKER_RULE_EVENT_ACTIONS.pull_request, (action) => `The pull request is ${action.replace(/_/g, " ")}.`),
        },
        merged: {
          instructions: "If the pull request is closed, does the sentence say it was merged?",
          options: { merged: "It was merged.", not_merged: "It was closed without a merge.", [ANY]: "The sentence does not say." },
        },
        draft: {
          instructions: "Does the sentence say whether the pull request is a draft?",
          options: { draft: "Only draft pull requests.", not_draft: "Only pull requests that are not drafts.", [ANY]: "The sentence does not say." },
        },
        review_state: {
          instructions: "If the event is a review, which review result does the sentence name?",
          options: options(["approved", "changes_requested", "commented", "dismissed"], (state) => `The review is ${state.replace(/_/g, " ")}.`, "The sentence does not say."),
        },
        conclusion: {
          instructions: "If the event is a check, which result does the sentence name?",
          options: options(TRACKER_RULE_CHECK_CONCLUSIONS, (conclusion) => `The check ended as ${conclusion.replace(/_/g, " ")}.`, "The sentence does not say."),
        },
        status: {
          instructions: "Which status should the ticket move to?",
          options: statusOptions,
        },
        comment: {
          instructions: "Does the sentence ask to add a comment to the ticket?",
          options: { comment: "Yes, add a comment.", no_comment: "No comment." },
        },
      },
    },
  };
}

function confident(answer: JevChoiceAnswer | undefined, min: number): string | null {
  return answer && answer.score !== null && answer.score >= min ? answer.choice : null;
}

/** Builds the rule from the answers, or explains why not. Validated as a typed rule. */
export function ruleFromDraftAnswers(
  sentence: string,
  answers: Record<string, JevChoiceAnswer>,
  statusByOption: ReadonlyMap<string, string>,
): TrackerRuleDraftResult {
  const event = confident(answers.event, RULE_DRAFT_REQUIRED_MIN);
  if (!event) return { draft: null, error: "Jev could not tell which event starts the rule. Write the rule by hand, or say it differently." };
  let trigger: TrackerRuleTrigger;
  if (event === "pull_request") {
    const action = confident(answers.pr_action, RULE_DRAFT_REQUIRED_MIN);
    if (!action) return { draft: null, error: "Jev could not tell what happens to the pull request. Name it, for example \"opened\" or \"merged\"." };
    trigger = { event, action };
    const merged = confident(answers.merged, RULE_DRAFT_OPTIONAL_MIN);
    if (action === "closed" && merged && merged !== ANY) trigger.merged = merged === "merged";
    const draft = confident(answers.draft, RULE_DRAFT_OPTIONAL_MIN);
    if (draft && draft !== ANY && action !== "closed") trigger.draft = draft === "draft";
  } else if (event === "pull_request_review") {
    const state = confident(answers.review_state, RULE_DRAFT_OPTIONAL_MIN);
    trigger = state === "dismissed" ? { event, action: "dismissed" } : { event, action: "submitted" };
    if (state && state !== ANY && state !== "dismissed") trigger.reviewState = state;
  } else {
    trigger = { event: "check_run", action: "completed" };
    const conclusion = confident(answers.conclusion, RULE_DRAFT_OPTIONAL_MIN);
    if (conclusion && conclusion !== ANY) trigger.conclusion = conclusion;
  }
  const actions: TrackerRuleAction[] = [];
  const statusOption = confident(answers.status, RULE_DRAFT_OPTIONAL_MIN);
  const status = statusOption ? statusByOption.get(statusOption) : undefined;
  if (status) actions.push({ kind: "transition", toStatus: status });
  if (confident(answers.comment, RULE_DRAFT_OPTIONAL_MIN) === "comment") actions.push({ kind: "comment", template: RULE_DRAFT_COMMENT_TEMPLATE });
  if (actions.length === 0) return { draft: null, error: "Jev found no status change or comment in the sentence. Name the status to move the ticket to." };
  const name = sentence.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TRACKER_RULE_NAME_MAX_LENGTH) || "Drafted rule";
  const parsed = parseTrackerRuleInput({ name, room_id: null, trigger, actions });
  return parsed.ok ? { draft: parsed.value as TrackerRuleInput, error: null } : { draft: null, error: parsed.error };
}

export interface RuleDraftDeps {
  endpoint(): JevEndpoint | null;
  evaluate?: JevEvaluate;
  timeoutMs?: number;
  questions: Pick<JevQuestionStore, "claim" | "finish">;
  newId(): string;
  log?(line: string): void;
}

/** The connection must have the Jev switch on; the caller checks ownership. */
export async function draftRuleFromSentence(
  deps: RuleDraftDeps,
  input: { connection: { id: string; provider: TrackerProvider; status_map: Record<string, string>; jev_linking_enabled: boolean }; sentence: string },
): Promise<TrackerRuleDraftResult> {
  if (!input.connection.jev_linking_enabled) {
    return { draft: null, error: "Turn on Jev for this connection to draft rules from a sentence." };
  }
  const endpoint = deps.endpoint();
  if (!endpoint) return { draft: null, error: "Jev is not available on this server. Write the rule by hand." };
  const { request, statusByOption } = buildRuleDraftQuestions(input.sentence, ruleDraftStatusNames(input.connection.provider, input.connection.status_map));
  const claimed = await deps.questions.claim({
    connection_id: input.connection.id, room_id: null, kind: "rule_draft", subject: deps.newId(), revision: "-",
  });
  if (!claimed) return { draft: null, error: "The draft could not be started. Try again." };
  const result = await askJevChoices(endpoint, request, { evaluate: deps.evaluate, timeoutMs: deps.timeoutMs });
  const drafted = result.status === "answered"
    ? ruleFromDraftAnswers(input.sentence, result.answers, statusByOption)
    : { draft: null, error: result.status === "timeout" ? "Jev did not answer in time. Try again, or write the rule by hand." : "Jev could not draft this rule. Write the rule by hand." };
  const outcome = result.status !== "answered" ? result.status : drafted.draft ? "drafted" : "not_drafted";
  await deps.questions.finish(claimed.id, { outcome, latency_ms: result.latencyMs });
  (deps.log ?? ((text: string) => console.info(text)))(`[jev tracker] rule_draft connection=${input.connection.id} outcome=${outcome} latency=${result.latencyMs}ms`);
  return drafted;
}
