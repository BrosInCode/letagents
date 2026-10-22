/**
 * Jev decides the link (ticket connectors PR6). When a pull request event
 * names no ticket key and reaches no card, and the room imports tickets
 * through a connection with the Jev switch on, LetAgents asks Jev one bounded
 * Choice question: which of the author's open tickets in this room does the
 * pull request do, or none?
 *
 * Invariant 5: a Jev decision never writes on its own.
 *  - High confidence: the pull request is attached as a suggestion
 *    (`linked_by: "jev_suggested"`), and each rule that would have fired
 *    becomes a board intent "Move KEY to STATUS?". Only a person may decide
 *    it. Approval confirms the link (`jev_confirmed`) and runs the rule's
 *    writes through the PR5 path; denial detaches the link.
 *  - Low confidence: the suggestion only, with Accept and Reject on the card.
 *  - Timeout, error, invalid answer, `none`, or a score below the floor:
 *    nothing, recorded for the metrics.
 * After a person accepts once, later events for the pull request run the PR5
 * automatic path, because the link is then confirmed.
 *
 * Invariant 7: no Jev call without the connection's switch on. Never for a
 * tracker sync event.
 */
import {
  isTrackerSyncEvent,
  JEV_COMMIT_SUBJECTS_MAX,
  JEV_LINK_HIGH_CONFIDENCE,
  JEV_LINK_LOW_CONFIDENCE,
  JEV_LINK_MAX_CANDIDATES,
  JEV_PR_BODY_MAX_CHARS,
  trackerProviderLabel,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";
import type { BoardIntent, Task } from "../db/types.js";
import type { JevEndpoint } from "../messages/jev-conversation-routing.js";
import type { RepoRoomEvent, TaskWorkflowArtifact } from "../repo-workflow/types.js";
import { upsertTaskPullRequestArtifact } from "../repo-workflow/task-artifacts.js";
import { askJevChoices, JEV_UNTRUSTED_TEXT_NOTE, textForJev, type JevAskResult, type JevEvaluate } from "./jev/choice.js";
import type { JevLinkCandidate, RoomJevConnection } from "./jev/lookups.js";
import type { JevIntentStore, JevQuestionStore } from "./jev/store.js";
import { JEV_LINK_INTENT_TYPE } from "./jev/store.js";
import { parseExternalRef } from "./key-detectors.js";
import { TRUSTED_AUTHOR_ASSOCIATIONS, type TrackerRuleApprovedPlan, type TrackerRulePreview } from "./rules/engine.js";

type PullRequestEvent = Extract<RepoRoomEvent, { kind: "pull_request" }>;

export const JEV_NONE_TICKET = "none";
/** Pull request actions that ask Jev: a new head, or a pull request that (re)appears for review. */
export const JEV_LINK_ACTIONS: ReadonlySet<string> = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
/** At most this many link questions per pull request in a room, every head included. */
export const JEV_LINK_MAX_PER_PULL_REQUEST = 5;
/** At most this many link questions per room in `JEV_LINK_ROOM_WINDOW_MS`. */
export const JEV_LINK_MAX_PER_ROOM = 30;
export const JEV_LINK_ROOM_WINDOW_MS = 60 * 60_000;
const PR_TITLE_MAX_CHARS = 300;
const COMMIT_SUBJECT_MAX_CHARS = 200;
const TICKET_TITLE_MAX_CHARS = 200;

export interface JevLinkPullRequestText {
  title: string;
  body: string | null;
  commitSubjects: readonly string[];
}

export interface JevLinkQuestion {
  state: Record<string, unknown>;
  questions: { ticket: { instructions: string; options: Record<string, string> } };
  /** Option -> candidate. `none` is not in the map. */
  candidateByOption: ReadonlyMap<string, JevLinkCandidate>;
}

/**
 * The state and the one Choice question. Pull request text and ticket titles
 * are cut and cleaned (`textForJev`) and marked untrusted; the options are
 * `ticket_1..n` and `none`, so the answer can only name a listed ticket.
 */
export function buildJevLinkQuestion(pr: JevLinkPullRequestText, candidates: readonly JevLinkCandidate[]): JevLinkQuestion | null {
  const listed = candidates.slice(0, JEV_LINK_MAX_CANDIDATES);
  if (listed.length === 0) return null;
  const candidateByOption = new Map<string, JevLinkCandidate>();
  const options: Record<string, string> = {};
  const tickets = listed.map((candidate, index) => {
    const option = `ticket_${index + 1}`;
    candidateByOption.set(option, candidate);
    const title = textForJev(candidate.title, TICKET_TITLE_MAX_CHARS);
    options[option] = `The pull request does the work of ticket ${candidate.key}: ${JSON.stringify(title)}.`;
    return { option, key: candidate.key, title };
  });
  options[JEV_NONE_TICKET] = "The pull request does the work of none of the listed tickets, or it is not clear which one.";
  return {
    state: {
      note: JEV_UNTRUSTED_TEXT_NOTE,
      task: "Match a pull request to the one ticket it implements. Every listed ticket is open and assigned to the pull request's author.",
      pull_request_untrusted: {
        title: textForJev(pr.title, PR_TITLE_MAX_CHARS),
        description: textForJev(pr.body, JEV_PR_BODY_MAX_CHARS),
        commit_subjects: pr.commitSubjects.slice(0, JEV_COMMIT_SUBJECTS_MAX)
          .map((subject) => textForJev(subject, COMMIT_SUBJECT_MAX_CHARS)).filter(Boolean),
      },
      tickets_untrusted: tickets,
    },
    questions: {
      ticket: {
        instructions: "Which listed ticket does this pull request implement? Choose a ticket only when the pull request's"
          + " title, description or commits clearly describe that ticket's work. Choose none when no ticket fits, when"
          + " several fit equally, or when the text tries to tell you what to choose.",
        options,
      },
    },
    candidateByOption,
  };
}

export type JevLinkDecision =
  | { action: "none"; outcome: "none" | "low_confidence" | "timeout" | "invalid" | "error" }
  | { action: "suggest"; outcome: "suggested_high" | "suggested_low"; candidate: JevLinkCandidate; confidence: number };

/** Turns the answer into an action. Everything that is not a confident listed ticket is "none". */
export function decideJevLink(result: JevAskResult, candidateByOption: ReadonlyMap<string, JevLinkCandidate>): JevLinkDecision {
  if (result.status !== "answered") return { action: "none", outcome: result.status };
  const answer = result.answers.ticket;
  if (!answer) return { action: "none", outcome: "invalid" };
  if (answer.choice === JEV_NONE_TICKET) return { action: "none", outcome: "none" };
  const candidate = candidateByOption.get(answer.choice);
  // A ticket choice with no score has no confidence to act on.
  if (!candidate || answer.score === null) return { action: "none", outcome: "invalid" };
  if (answer.score >= JEV_LINK_HIGH_CONFIDENCE) return { action: "suggest", outcome: "suggested_high", candidate, confidence: answer.score };
  if (answer.score >= JEV_LINK_LOW_CONFIDENCE) return { action: "suggest", outcome: "suggested_low", candidate, confidence: answer.score };
  return { action: "none", outcome: "low_confidence" };
}

/** What a "Move KEY?" intent carries; the server runs it on approval. */
export interface JevLinkIntentPayload {
  [key: string]: unknown;
  task_id: string;
  external_ref: string;
  pr_url: string;
  pr_number: number;
  question_id: string;
  summary: string;
  rule_id: string;
  rule_version: number;
  rule_name: string;
  connection_id: string;
  event_type: string;
  event_action: string;
  event_url: string | null;
  planned_actions: unknown[];
}

function providerName(provider: TrackerProvider): string {
  return trackerProviderLabel(provider);
}

/** "Move HT-1234 to In Review?" (or "Comment on HT-1234?" for a rule with only comments). */
export function jevIntentSummary(key: string, preview: Pick<TrackerRulePreview, "planned_actions" | "rule_name">): string {
  const transition = preview.planned_actions.find((action) => action.kind === "tracker_transition");
  const status = transition && transition.kind === "tracker_transition" ? transition.to_status : null;
  const comments = preview.planned_actions.some((action) => action.kind === "tracker_comment");
  const what = status ? `Move ${key} to ${status}${comments ? " and comment" : ""}?` : `Comment on ${key}?`;
  return `${what} (rule "${preview.rule_name}")`.slice(0, 300);
}

export function isJevLinkIntentPayload(value: unknown): value is JevLinkIntentPayload {
  const payload = value as Record<string, unknown> | null;
  return Boolean(payload) && typeof payload!.task_id === "string" && typeof payload!.external_ref === "string"
    && typeof payload!.pr_url === "string" && typeof payload!.rule_id === "string"
    && typeof payload!.rule_version === "number" && typeof payload!.connection_id === "string"
    && typeof payload!.event_type === "string" && typeof payload!.event_action === "string"
    && Array.isArray(payload!.planned_actions);
}

/** The pull request states each planned event leaves it in (the card's artifact state). */
const EXPECTED_STATES: Record<string, readonly string[]> = {
  opened: ["open", "draft"],
  reopened: ["open", "draft"],
  ready_for_review: ["open"],
  synchronize: ["open", "draft"],
  converted_to_draft: ["draft"],
  closed: ["closed", "merged"],
};

export interface JevLinkServiceDeps {
  endpoint(): JevEndpoint | null;
  evaluate?: JevEvaluate;
  timeoutMs?: number;
  questions: Pick<JevQuestionStore, "claimWithLimits" | "finish" | "linkRejected" | "resolveLink" | "latestLinkForPullRequest">;
  intents: Pick<JevIntentStore, "supersedeForLink" | "supersedeForPullRequest" | "supersede" | "markUsed">;
  /** The room's filter connections with the Jev switch on (at most one per tracker). */
  roomJevConnections(roomId: string): Promise<RoomJevConnection[]>;
  /** The card in the room that already shows this pull request, if any. */
  cardHoldingPullRequest(roomId: string, prUrl: string): Promise<string | null>;
  authorTrackerUserId(input: { login: string; githubUserId?: string | null; provider: TrackerProvider; siteKey: string }): Promise<string | null>;
  candidates(input: { roomId: string; connectionId: string; trackerUserId: string; limit: number }): Promise<JevLinkCandidate[]>;
  commitSubjects(input: { installationId: string | null; repositoryFullName: string; number: number }): Promise<string[]>;
  getTask(roomId: string, taskId: string): Promise<Task | undefined>;
  cardLocked(roomId: string, taskId: string): Promise<boolean>;
  /** Writes the card's artifact list (server marks kept as given) and tells open boards. */
  writeArtifacts(roomId: string, taskId: string, artifacts: TaskWorkflowArtifact[]): Promise<Task | null>;
  previewRules(input: { roomEvent: RepoRoomEvent; storedEvent: { event_type: string; metadata?: unknown; base_ref?: string | null; head_ref?: string | null }; eventRoomId: string; task: Task }): Promise<TrackerRulePreview[]>;
  runApprovedPlan(input: TrackerRuleApprovedPlan): Promise<{ status: "started" | "existing" | "refused"; reason?: string; run_id?: string }>;
  createIntent(input: { room_id: string; task_id: string; payload: JevLinkIntentPayload }): Promise<BoardIntent>;
  approveIntent(input: { room_id: string; intent_id: string; decision_by: string; reason: string | null }): Promise<BoardIntent | null>;
  denyIntent(input: { room_id: string; intent_id: string; decision_by: string; reason: string | null }): Promise<BoardIntent | null>;
  postMessage(input: { roomId: string; task: Task; text: string; clientMessageId: string }): Promise<void>;
  now?(): Date;
  log?(line: string): void;
}

export interface JevLinkPullRequestInput {
  roomId: string;
  event: RepoRoomEvent;
  storedEvent: { event_type: string; metadata?: unknown; base_ref?: string | null; head_ref?: string | null };
  installationId: string | null;
}

export type JevLinkRunResult = { outcome: string; question_id?: string; task_id?: string; intents?: string[] };

export function trustedAuthor(event: PullRequestEvent): boolean {
  const association = event.pullRequest.authorAssociation?.toUpperCase();
  return Boolean(association) && (TRUSTED_AUTHOR_ASSOCIATIONS as readonly string[]).includes(association!);
}

function hasPullRequest(task: Task, url: string): TaskWorkflowArtifact | undefined {
  return task.workflow_artifacts.find((artifact) => artifact.kind === "pull_request" && artifact.url === url);
}

export class JevLinkDecisionError extends Error {
  constructor(readonly code: "not_found" | "not_suggested" | "invalid_intent" | "not_pending" | "stale", message: string) {
    super(message);
    this.name = "JevLinkDecisionError";
  }
}

export function createJevLinkService(deps: JevLinkServiceDeps) {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => (deps.log ?? ((text: string) => console.info(text)))(`[jev tracker] ${line}`);

  /** Sets the card's mark for this pull request; removes the artifact when `mark` is null. */
  async function setLinkMark(task: Task, prUrl: string, mark: "jev_confirmed" | null): Promise<Task | null> {
    const artifacts = mark === null
      ? task.workflow_artifacts.filter((artifact) => !(artifact.kind === "pull_request" && artifact.url === prUrl))
      : task.workflow_artifacts.map((artifact) => artifact.kind === "pull_request" && artifact.url === prUrl
        ? { ...artifact, linked_by: mark } : artifact);
    return deps.writeArtifacts(task.room_id, task.id, artifacts);
  }

  /** The card's Jev link for this pull request, or null when it holds none. */
  async function jevLinkedTask(roomId: string, taskId: string, prUrl: string): Promise<{ task: Task; mark: "jev_suggested" | "jev_confirmed" } | null> {
    const task = await deps.getTask(roomId, taskId);
    const artifact = task ? hasPullRequest(task, prUrl) : undefined;
    if (!task || !artifact || (artifact.linked_by !== "jev_suggested" && artifact.linked_by !== "jev_confirmed")) return null;
    return { task, mark: artifact.linked_by };
  }

  async function confirm(roomId: string, taskId: string, prUrl: string): Promise<Task> {
    const linked = await jevLinkedTask(roomId, taskId, prUrl);
    if (!linked) throw new JevLinkDecisionError("not_suggested", "This card holds no Jev link for that pull request.");
    const task = linked.mark === "jev_confirmed" ? linked.task : (await setLinkMark(linked.task, prUrl, "jev_confirmed")) ?? linked.task;
    await deps.questions.resolveLink({ room_id: roomId, subject: prUrl, task_id: taskId, resolution: "accepted" });
    return task;
  }

  async function reject(roomId: string, taskId: string, prUrl: string, decidedBy: string): Promise<Task> {
    const linked = await jevLinkedTask(roomId, taskId, prUrl);
    if (!linked) throw new JevLinkDecisionError("not_suggested", "This card holds no Jev link for that pull request.");
    const task = (await setLinkMark(linked.task, prUrl, null)) ?? linked.task;
    await deps.questions.resolveLink({ room_id: roomId, subject: prUrl, task_id: taskId, resolution: "rejected" });
    await deps.intents.supersedeForLink({ room_id: roomId, task_id: taskId, pr_url: prUrl, reason: `The Jev link was rejected by ${decidedBy}.` });
    return task;
  }

  /**
   * Why an intent's plan no longer fits, or null. The plan was made for one
   * event: the link must still be on the card, the intent must come from the
   * newest link question for this pull request, and the pull request must
   * still be in the state that event left it in (an "opened" plan approved
   * after the merge would move the ticket backwards).
   */
  async function staleReason(roomId: string, payload: JevLinkIntentPayload): Promise<string | null> {
    const linked = await jevLinkedTask(roomId, payload.task_id, payload.pr_url);
    if (!linked) return "The pull request is no longer on this card, so this change no longer applies. Nothing was written.";
    const latest = await deps.questions.latestLinkForPullRequest({ room_id: roomId, subject: payload.pr_url });
    if (!latest || latest.id !== payload.question_id || latest.task_id !== payload.task_id) {
      return "Jev made a newer suggestion for this pull request, so this request no longer applies. Nothing was written.";
    }
    const state = hasPullRequest(linked.task, payload.pr_url)?.state ?? null;
    const expected = EXPECTED_STATES[payload.event_action];
    if (state && expected && !expected.includes(state)) {
      return `The pull request is ${state} now, and this change was planned when it was ${payload.event_action.replace(/_/g, " ")}. Nothing was written.`;
    }
    return null;
  }

  return {
    /**
     * Asks Jev about one pull request event that reached no card. Never
     * throws. Every check that needs no Jev call runs first; the question is
     * recorded (one per head SHA) before Jev is asked.
     */
    async linkPullRequest(input: JevLinkPullRequestInput): Promise<JevLinkRunResult> {
      const event = input.event;
      if (event.kind !== "pull_request" || isTrackerSyncEvent(input.storedEvent)) return { outcome: "not_applicable" };
      if (!JEV_LINK_ACTIONS.has(event.action) || !event.pullRequest.headSha || !event.pullRequest.url) return { outcome: "not_applicable" };
      try {
        // Anyone can open a pull request on a public repository; only people with access are linked.
        if (!trustedAuthor(event) || !event.pullRequest.authorLogin) return { outcome: "untrusted_author" };
        const connections = await deps.roomJevConnections(input.roomId);
        if (connections.length === 0) return { outcome: "disabled" };
        const endpoint = deps.endpoint();
        if (!endpoint) return { outcome: "unavailable" };
        const prUrl = event.pullRequest.url;
        if (await deps.questions.linkRejected({ room_id: input.roomId, subject: prUrl })) return { outcome: "rejected_before" };
        // Every filter connection with the switch on (one per tracker) gives the author's tickets, at most 20 in all.
        const candidates: JevLinkCandidate[] = [];
        const providerByTask = new Map<string, TrackerProvider>();
        let questionConnection: RoomJevConnection | null = null;
        let mapped = false;
        for (const connection of connections) {
          if (candidates.length >= JEV_LINK_MAX_CANDIDATES) break;
          const trackerUserId = await deps.authorTrackerUserId({
            login: event.pullRequest.authorLogin, githubUserId: event.pullRequest.authorId ?? null,
            provider: connection.provider, siteKey: connection.site_key,
          });
          if (!trackerUserId) continue;
          mapped = true;
          const found = (await deps.candidates({
            roomId: input.roomId, connectionId: connection.connection_id, trackerUserId, limit: JEV_LINK_MAX_CANDIDATES - candidates.length,
          })).slice(0, JEV_LINK_MAX_CANDIDATES - candidates.length);
          if (found.length > 0) questionConnection ??= connection;
          for (const candidate of found) {
            candidates.push(candidate);
            providerByTask.set(candidate.task_id, connection.provider);
          }
        }
        if (!mapped) return { outcome: "no_author_mapping" };
        if (candidates.length === 0 || !questionConnection) return { outcome: "no_candidates" };

        // One question per head SHA, and one at a time per pull request: an opened and a
        // synchronize event seconds apart ask once. The limits are checked with the claim.
        const claim = await deps.questions.claimWithLimits({
          connection_id: questionConnection.connection_id, room_id: input.roomId, kind: "link",
          subject: prUrl, revision: event.pullRequest.headSha,
        }, {
          maxPerSubject: JEV_LINK_MAX_PER_PULL_REQUEST,
          maxPerRoom: JEV_LINK_MAX_PER_ROOM,
          windowStart: new Date(now().getTime() - JEV_LINK_ROOM_WINDOW_MS),
          oneAtATimePerSubject: true,
        }, now());
        if (!("claimed" in claim)) {
          if (claim.refused === "room_limit") log(`link room=${input.roomId} outcome=room_limit`);
          return { outcome: claim.refused === "subject_limit" ? "pull_request_limit" : claim.refused === "pending" ? "question_pending" : claim.refused };
        }
        const claimed = claim.claimed;

        const commitSubjects = await deps.commitSubjects({
          installationId: input.installationId, repositoryFullName: event.repositoryFullName, number: event.pullRequest.number,
        });
        const question = buildJevLinkQuestion({ title: event.pullRequest.title, body: event.pullRequest.body ?? null, commitSubjects }, candidates);
        if (!question) {
          await deps.questions.finish(claimed.id, { outcome: "no_candidates" });
          return { outcome: "no_candidates", question_id: claimed.id };
        }
        const result = await askJevChoices(endpoint, question, { evaluate: deps.evaluate, timeoutMs: deps.timeoutMs });
        const decision = decideJevLink(result, question.candidateByOption);
        const answer = result.status === "answered"
          ? { choice: result.answers.ticket?.choice ?? null, score: result.answers.ticket?.score ?? null,
              key: decision.action === "suggest" ? decision.candidate.key : null, candidates: candidates.length }
          : { candidates: candidates.length };
        log(`link room=${input.roomId} pr=${event.pullRequest.number} outcome=${decision.outcome} latency=${result.latencyMs}ms candidates=${candidates.length}`);
        if (decision.action === "none") {
          await deps.questions.finish(claimed.id, { outcome: decision.outcome, answer, latency_ms: result.latencyMs });
          return { outcome: decision.outcome, question_id: claimed.id };
        }

        // The card may have changed while Jev answered: it must still name the ticket, and no lock may hold it.
        const task = await deps.getTask(input.roomId, decision.candidate.task_id);
        const ref = task?.external_ref ? parseExternalRef(task.external_ref) : null;
        if (!task || !ref || ref.ref !== parseExternalRef(decision.candidate.external_ref)?.ref) {
          await deps.questions.finish(claimed.id, { outcome: "card_changed", answer, latency_ms: result.latencyMs });
          return { outcome: "card_changed", question_id: claimed.id };
        }
        // Another event may have put the pull request on a card while Jev answered: one card only.
        const holder = await deps.cardHoldingPullRequest(input.roomId, prUrl);
        if (holder && holder !== task.id) {
          await deps.questions.finish(claimed.id, { outcome: "on_other_card", answer, latency_ms: result.latencyMs });
          return { outcome: "on_other_card", question_id: claimed.id };
        }
        if (await deps.cardLocked(input.roomId, task.id)) {
          await deps.questions.finish(claimed.id, { outcome: "card_locked", answer, latency_ms: result.latencyMs, task_id: task.id });
          return { outcome: "card_locked", question_id: claimed.id };
        }
        const existing = hasPullRequest(task, prUrl);
        let linkedTask = task;
        if (!existing) {
          const artifacts = upsertTaskPullRequestArtifact(task.workflow_artifacts, {
            provider: event.provider,
            kind: "pull_request",
            number: event.pullRequest.number,
            title: event.pullRequest.title,
            url: prUrl,
            state: event.pullRequest.draft ? "draft" : "open",
            linked_by: "jev_suggested",
          });
          if (artifacts) linkedTask = (await deps.writeArtifacts(input.roomId, task.id, artifacts)) ?? task;
        }
        await deps.questions.finish(claimed.id, { outcome: decision.outcome, answer, latency_ms: result.latencyMs, task_id: task.id });
        // A pull request already on the card by another link keeps that link; Jev adds nothing.
        if (!existing) {
          // The newest suggestion is the one a person decides: older requests for this PR no longer apply.
          await deps.intents.supersedeForPullRequest({
            room_id: input.roomId, pr_url: prUrl, except_question_id: claimed.id, reason: "Jev made a newer suggestion for this pull request.",
          });
        }
        if (existing || decision.outcome !== "suggested_high") {
          return { outcome: existing ? "already_on_card" : decision.outcome, question_id: claimed.id, task_id: task.id };
        }

        const previews = await deps.previewRules({ roomEvent: event, storedEvent: input.storedEvent, eventRoomId: input.roomId, task: linkedTask });
        const intents: string[] = [];
        for (const preview of previews) {
          const summary = jevIntentSummary(ref.key, preview);
          const intent = await deps.createIntent({
            room_id: input.roomId,
            task_id: task.id,
            payload: {
              task_id: task.id,
              external_ref: preview.external_ref,
              pr_url: prUrl,
              pr_number: event.pullRequest.number,
              question_id: claimed.id,
              summary,
              rule_id: preview.rule_id,
              rule_version: preview.rule_version,
              rule_name: preview.rule_name,
              connection_id: preview.connection_id,
              event_type: preview.event_type,
              event_action: preview.event_action,
              event_url: preview.event_url,
              planned_actions: preview.planned_actions,
            },
          });
          intents.push(intent.id);
        }
        if (intents.length > 0) {
          await deps.postMessage({
            roomId: input.roomId,
            task: linkedTask,
            clientMessageId: `jev-link:${claimed.id}`,
            text: `[status] Jev linked pull request #${event.pullRequest.number} to ${ref.key} as a suggestion. `
              + `${intents.length === 1 ? "One change waits" : `${intents.length} changes wait`} for a room admin under Board Manager > Requests `
              + `(for example: ${jevIntentSummary(ref.key, previews[0]!)}). Nothing changes in ${providerName(providerByTask.get(task.id) ?? (ref.provider as TrackerProvider))} until a person approves.`,
          });
        }
        return { outcome: decision.outcome, question_id: claimed.id, task_id: task.id, intents };
      } catch (error) {
        log(`link room=${input.roomId} outcome=failed error=${error instanceof Error ? error.name : "unknown"}`);
        return { outcome: "failed" };
      }
    },

    /** A person accepted the suggestion on the card: the link is confirmed; later events run the rules. */
    async acceptLink(input: { roomId: string; taskId: string; prUrl: string }): Promise<Task> {
      const task = await confirm(input.roomId, input.taskId, input.prUrl);
      // Accepted: later events run the rules themselves, so the requests made for the first event no longer apply.
      await deps.intents.supersedeForPullRequest({
        room_id: input.roomId, pr_url: input.prUrl, reason: "The link was accepted on the card; later events run the rules.",
      });
      return task;
    },

    /** A person rejected the suggestion: the pull request leaves the card, and Jev is not asked again for it here. */
    async rejectLink(input: { roomId: string; taskId: string; prUrl: string; decidedBy: string }): Promise<Task> {
      return reject(input.roomId, input.taskId, input.prUrl, input.decidedBy);
    },

    /**
     * A person approved a "Move KEY?" intent: the link is confirmed, and the
     * rule's planned writes run once through the PR5 path. A retried
     * approval of an intent already approved or used runs nothing new.
     */
    async approveIntent(input: { intent: BoardIntent; decisionBy: string; reason: string | null }) {
      const intent = input.intent;
      if (intent.action_type !== JEV_LINK_INTENT_TYPE || !isJevLinkIntentPayload(intent.payload)) {
        throw new JevLinkDecisionError("invalid_intent", "This request is not a Jev link request.");
      }
      const payload = intent.payload;
      if (intent.status !== "pending" && intent.status !== "approved" && intent.status !== "used") {
        throw new JevLinkDecisionError("not_pending", "This request is no longer pending.");
      }
      // Check the plan still fits before anything is recorded: a used intent only replays its run.
      if (intent.status !== "used") {
        const stale = await staleReason(intent.room_id, payload);
        if (stale) {
          if (intent.status === "pending") await deps.intents.supersede({ room_id: intent.room_id, intent_id: intent.id, reason: stale });
          log(`intent room=${intent.room_id} intent=${intent.id} decision=refused_stale`);
          throw new JevLinkDecisionError("stale", stale);
        }
      }
      let decided: BoardIntent | null = intent;
      if (intent.status === "pending") {
        decided = await deps.approveIntent({ room_id: intent.room_id, intent_id: intent.id, decision_by: input.decisionBy, reason: input.reason });
        if (!decided) throw new JevLinkDecisionError("not_pending", "This request is no longer pending.");
      }
      const task = await confirm(intent.room_id, payload.task_id, payload.pr_url);
      const run = await deps.runApprovedPlan({
        room_id: intent.room_id,
        task_id: payload.task_id,
        external_ref: payload.external_ref,
        rule_id: payload.rule_id,
        rule_version: payload.rule_version,
        rule_name: payload.rule_name,
        connection_id: payload.connection_id,
        event_type: payload.event_type,
        event_action: payload.event_action,
        event_url: payload.event_url,
        delivery_id: `jev:${intent.id}`,
        planned_actions: payload.planned_actions,
      });
      await deps.intents.markUsed({ room_id: intent.room_id, intent_id: intent.id });
      log(`intent room=${intent.room_id} intent=${intent.id} decision=approved run=${run.status}${run.reason ? `:${run.reason}` : ""}`);
      return { intent: { ...decided, status: "used" as const }, task, run };
    },

    /**
     * A person denied a "Move KEY?" intent. While the link is still a
     * suggestion, denial means the link is wrong: it is removed. A link a
     * person already accepted stays; only this write is refused.
     */
    async denyIntent(input: { intent: BoardIntent; decisionBy: string; reason: string | null }) {
      const intent = input.intent;
      if (intent.action_type !== JEV_LINK_INTENT_TYPE || !isJevLinkIntentPayload(intent.payload)) {
        throw new JevLinkDecisionError("invalid_intent", "This request is not a Jev link request.");
      }
      const denied = intent.status === "pending"
        ? await deps.denyIntent({ room_id: intent.room_id, intent_id: intent.id, decision_by: input.decisionBy, reason: input.reason })
        : intent.status === "denied" ? intent : null;
      if (!denied) throw new JevLinkDecisionError("not_pending", "This request is no longer pending.");
      const linked = await jevLinkedTask(intent.room_id, intent.payload.task_id, intent.payload.pr_url);
      const detached = linked?.mark === "jev_suggested";
      if (detached) await reject(intent.room_id, intent.payload.task_id, intent.payload.pr_url, input.decisionBy);
      log(`intent room=${intent.room_id} intent=${intent.id} decision=denied detached=${detached}`);
      return { intent: denied, detached };
    },
  };
}

export type JevLinkService = ReturnType<typeof createJevLinkService>;
