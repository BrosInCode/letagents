/**
 * Jev reads a pull request closed without a merge (ticket connectors PR6).
 * When a pull request that a ticket key or an accepted Jev link put on a card
 * closes without a merge, Jev answers one Choice question (abandoned,
 * superseded, moved), and LetAgents posts a proposal in the room. The text is
 * fixed per answer: nothing Jev or the pull request wrote is posted, and
 * nothing is written to the tracker (invariant 5).
 */
import { JEV_EXCEPTION_KINDS, JEV_PR_BODY_MAX_CHARS, trackerProviderLabel, type JevExceptionKind, type TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import type { Task } from "../../db/types.js";
import type { JevEndpoint } from "../../messages/jev-conversation-routing.js";
import type { RepoRoomEvent } from "../../repo-workflow/types.js";
import { parseExternalRef } from "../key-detectors.js";
import { askJevChoices, JEV_UNTRUSTED_TEXT_NOTE, textForJev, type JevEvaluate } from "./choice.js";
import type { RoomJevConnection } from "./lookups.js";
import type { JevQuestionStore } from "./store.js";

/** Below this, no proposal is posted. */
export const JEV_EXCEPTION_MIN_SCORE = 0.5;
/** At most this many questions per closed pull request (every head), and per room in an hour. */
export const JEV_EXCEPTION_MAX_PER_PULL_REQUEST = 3;
export const JEV_EXCEPTION_MAX_PER_ROOM = 30;
const ROOM_WINDOW_MS = 60 * 60_000;
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

const OPTIONS: Record<JevExceptionKind, string> = {
  abandoned: "The work stopped: nobody plans to finish this change.",
  superseded: "Another pull request replaces this one and carries the same work forward.",
  moved: "The work moved to a different ticket or card, or was split into other work.",
};

export function buildJevExceptionQuestion(input: { title: string; body: string | null; key: string; ticketTitle: string; openPullRequests: number }) {
  return {
    state: {
      note: JEV_UNTRUSTED_TEXT_NOTE,
      task: "A pull request for a ticket was closed without being merged. Say what most likely happened to the work.",
      pull_request_untrusted: {
        title: textForJev(input.title, 300),
        description: textForJev(input.body, JEV_PR_BODY_MAX_CHARS),
      },
      ticket_untrusted: { key: input.key, title: textForJev(input.ticketTitle, 200) },
      other_open_pull_requests_on_card: input.openPullRequests,
    },
    questions: {
      closed_without_merge: {
        instructions: "Why was this pull request closed without a merge?",
        options: { ...OPTIONS },
      },
    },
  };
}

/** The proposal posted for each answer. Fixed text: it names only the key, the number and the tracker. */
export function jevExceptionProposal(kind: JevExceptionKind, input: { key: string; number: number; provider: TrackerProvider }): string {
  const tracker = trackerProviderLabel(input.provider);
  const head = `[status] Pull request #${input.number} for ${input.key} closed without a merge. Jev reads it as`;
  const tail = `LetAgents changed nothing in ${tracker}.`;
  if (kind === "abandoned") return `${head} abandoned. Proposal: if the work stopped, move ${input.key} back in ${tracker} or close it there. ${tail}`;
  if (kind === "superseded") return `${head} superseded by another pull request. Proposal: check that the new pull request names ${input.key}, so it attaches to this card. ${tail}`;
  return `${head} work that moved elsewhere. Proposal: check that ${input.key} still describes the work, or move the work to the right card. ${tail}`;
}

export interface JevExceptionDeps {
  endpoint(): JevEndpoint | null;
  evaluate?: JevEvaluate;
  timeoutMs?: number;
  questions: Pick<JevQuestionStore, "claimWithLimits" | "finish">;
  roomJevConnection(roomId: string, provider?: TrackerProvider): Promise<RoomJevConnection | null>;
  ticketTitle(connectionId: string, key: string): Promise<string | null>;
  postMessage(input: { roomId: string; task: Task; text: string; clientMessageId: string }): Promise<void>;
  log?(line: string): void;
}

/**
 * Runs for a pull request closed without a merge on a card it reached by a
 * ticket key or an accepted Jev link. Never throws.
 */
export async function proposeForClosedPullRequest(
  deps: JevExceptionDeps,
  input: { task: Task; event: RepoRoomEvent; linkConfirmed: boolean },
): Promise<{ outcome: string; kind?: JevExceptionKind }> {
  const log = (line: string) => (deps.log ?? ((text: string) => console.info(text)))(`[jev tracker] ${line}`);
  const event = input.event;
  if (event.kind !== "pull_request" || event.action !== "closed" || event.pullRequest.merged === true) return { outcome: "not_applicable" };
  if (!input.linkConfirmed) return { outcome: "not_linked" };
  // A key in an outside contributor's pull request also links it; only people with access are asked about.
  if (!TRUSTED.includes(event.pullRequest.authorAssociation?.toUpperCase() ?? "")) return { outcome: "untrusted_author" };
  const ref = input.task.external_ref ? parseExternalRef(input.task.external_ref) : null;
  if (!ref || (ref.provider !== "jira" && ref.provider !== "linear")) return { outcome: "not_applicable" };
  try {
    const connection = await deps.roomJevConnection(input.task.room_id, ref.provider as TrackerProvider);
    if (!connection) return { outcome: "disabled" };
    const endpoint = deps.endpoint();
    if (!endpoint) return { outcome: "unavailable" };
    const claim = await deps.questions.claimWithLimits({
      connection_id: connection.connection_id, room_id: input.task.room_id, kind: "exception",
      subject: event.pullRequest.url, revision: `closed:${event.pullRequest.headSha ?? "unknown"}`, task_id: input.task.id,
    }, {
      maxPerSubject: JEV_EXCEPTION_MAX_PER_PULL_REQUEST,
      maxPerRoom: JEV_EXCEPTION_MAX_PER_ROOM,
      windowStart: new Date(Date.now() - ROOM_WINDOW_MS),
    });
    if (!("claimed" in claim)) return { outcome: claim.refused === "subject_limit" ? "pull_request_limit" : claim.refused };
    const claimed = claim.claimed;

    const openPullRequests = input.task.workflow_artifacts.filter((artifact) => artifact.kind === "pull_request"
      && artifact.url !== event.pullRequest.url && (artifact.state === "open" || artifact.state === "draft")).length;
    const question = buildJevExceptionQuestion({
      title: event.pullRequest.title,
      body: event.pullRequest.body ?? null,
      key: ref.key,
      ticketTitle: (await deps.ticketTitle(connection.connection_id, ref.key)) ?? input.task.title,
      openPullRequests,
    });
    const result = await askJevChoices(endpoint, question, { evaluate: deps.evaluate, timeoutMs: deps.timeoutMs });
    const answer = result.status === "answered" ? result.answers.closed_without_merge : undefined;
    const kind = answer && (JEV_EXCEPTION_KINDS as readonly string[]).includes(answer.choice) ? answer.choice as JevExceptionKind : null;
    const outcome = result.status !== "answered" ? result.status
      : !kind || answer!.score === null ? "invalid"
      : answer!.score < JEV_EXCEPTION_MIN_SCORE ? "low_confidence" : kind;
    await deps.questions.finish(claimed.id, {
      outcome,
      answer: answer ? { choice: answer.choice, score: answer.score } : null,
      latency_ms: result.latencyMs,
    });
    log(`exception room=${input.task.room_id} pr=${event.pullRequest.number} outcome=${outcome} latency=${result.latencyMs}ms`);
    if (!kind || outcome !== kind) return { outcome };
    await deps.postMessage({
      roomId: input.task.room_id,
      task: input.task,
      clientMessageId: `jev-exception:${claimed.id}`,
      text: jevExceptionProposal(kind, { key: ref.key, number: event.pullRequest.number, provider: ref.provider as TrackerProvider }),
    });
    return { outcome, kind };
  } catch (error) {
    log(`exception room=${input.task.room_id} outcome=failed error=${error instanceof Error ? error.name : "unknown"}`);
    return { outcome: "failed" };
  }
}
