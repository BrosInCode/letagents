/**
 * "Needs me" refinement for My work (ticket connectors PR6). On request, Jev
 * answers one Choice question per card: is the card waiting on a person, on
 * an agent, or on nothing? The answer is cached per card and last message,
 * so asking again before anyone writes about the card costs no Jev call. It
 * is advice for the page: nothing is written anywhere.
 */
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import {
  JEV_NEEDS_ME_MESSAGES_MAX,
  JEV_NEEDS_ME_STATES,
  type JevNeedsMeState,
  type MyWorkJevNeedsMe,
} from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { visibleMessageCondition } from "../../db/messages/visibility.js";
import { external_items, messages, room_tracker_filters, task_mentions, tasks, tracker_connections } from "../../db/schema.js";
import { parseScopedId } from "../../db/utils.js";
import type { JevEndpoint } from "../../messages/jev-conversation-routing.js";
import { askJevChoices, JEV_UNTRUSTED_TEXT_NOTE, textForJev, type JevEvaluate } from "./choice.js";
import type { JevQuestionStore } from "./store.js";

export const JEV_NEEDS_ME_MIN_SCORE = 0.5;
const MESSAGE_MAX_CHARS = 300;

const OPTIONS: Record<JevNeedsMeState, string> = {
  waiting_on_human: "The next step is for a person: a question, a review, a decision or an approval is waiting for a human.",
  waiting_on_agent: "The next step is for an agent: an agent was asked to do something, or is doing it, and has not finished.",
  nothing: "Nothing waits: the work is finished, quiet, or nobody has been asked for anything.",
};

/** The card, and its ticket's connection, when Jev may be asked about it. */
export interface NeedsMeCard {
  room_id: string;
  task_id: string;
  title: string;
  key: string | null;
  status: string;
  ticket_state: string | null;
  connection_id: string;
}

export interface NeedsMeMessage {
  number: number;
  from: "human" | "agent";
  text: string;
}

export function buildJevNeedsMeQuestion(card: NeedsMeCard, recent: readonly NeedsMeMessage[]) {
  return {
    state: {
      note: JEV_UNTRUSTED_TEXT_NOTE,
      task: "Say who the next step on this work card waits for.",
      card: { title_untrusted: textForJev(card.title, 200), key: card.key, work_state: card.status, ticket_state: card.ticket_state },
      // Oldest first, as a conversation reads.
      recent_messages_untrusted: [...recent].sort((a, b) => a.number - b.number)
        .map((message) => ({ from: message.from, text: textForJev(message.text, MESSAGE_MAX_CHARS) })),
    },
    questions: {
      waiting_on: {
        instructions: "Who does the next step on this card wait for?",
        options: { ...OPTIONS },
      },
    },
  };
}

/**
 * The card when its ticket's connection has the Jev switch on and is active.
 * Null otherwise: no Jev call (invariant 7).
 */
export async function findNeedsMeCard(roomId: string, taskId: string): Promise<NeedsMeCard | null> {
  const number = parseScopedId(taskId, "task");
  if (number === null) return null;
  const [row] = await db.select({
    title: tasks.title,
    key: external_items.key,
    status: tasks.status,
    ticket_state: tasks.ticket_state,
    connection_id: tracker_connections.id,
  }).from(tasks)
    .innerJoin(external_items, eq(external_items.id, tasks.external_item_id))
    .innerJoin(tracker_connections, eq(tracker_connections.id, external_items.connection_id))
    // Consent is the connection owner's, for the rooms they point at their tracker: the room's
    // enabled filter on this connection, set by its owner (as for a link question).
    .innerJoin(room_tracker_filters, and(
      eq(room_tracker_filters.room_id, tasks.room_id),
      eq(room_tracker_filters.connection_id, tracker_connections.id),
      eq(room_tracker_filters.enabled, true),
      eq(room_tracker_filters.created_by_account_id, tracker_connections.account_id),
    ))
    .where(and(
      eq(tasks.room_id, roomId),
      eq(tasks.number, number),
      eq(tracker_connections.jev_linking_enabled, true),
      eq(tracker_connections.status, "active"),
    ))
    .limit(1);
  return row ? { room_id: roomId, task_id: `task_${number}`, ...row } : null;
}

/** The newest visible messages that name the card's ticket, written by a person or an agent. */
export async function readNeedsMeMessages(roomId: string, taskId: string): Promise<NeedsMeMessage[]> {
  const number = parseScopedId(taskId, "task");
  if (number === null) return [];
  const rows = await db.select({
    number: messages.number,
    text: messages.text,
    agent: messages.publisher_agent_key,
  }).from(task_mentions)
    .innerJoin(messages, and(eq(messages.room_id, task_mentions.room_id), eq(messages.number, task_mentions.message_number)))
    .where(and(
      eq(task_mentions.room_id, roomId),
      eq(task_mentions.task_number, number),
      visibleMessageCondition(),
      or(isNull(messages.visibility), eq(messages.visibility, "rental_visible")),
      or(isNotNull(messages.publisher_agent_key), isNotNull(messages.publisher_account_id)),
      sql`btrim(${messages.text}) <> ''`,
    ))
    .orderBy(desc(messages.number))
    .limit(JEV_NEEDS_ME_MESSAGES_MAX);
  return rows.map((row) => ({ number: row.number, from: row.agent ? "agent" : "human", text: row.text }));
}

export interface JevNeedsMeDeps {
  endpoint(): JevEndpoint | null;
  evaluate?: JevEvaluate;
  timeoutMs?: number;
  questions: Pick<JevQuestionStore, "claim" | "finish" | "find">;
  card(roomId: string, taskId: string): Promise<NeedsMeCard | null>;
  messages(roomId: string, taskId: string): Promise<NeedsMeMessage[]>;
  log?(line: string): void;
}

function isState(value: unknown): value is JevNeedsMeState {
  return typeof value === "string" && (JEV_NEEDS_ME_STATES as readonly string[]).includes(value);
}

export async function askJevNeedsMe(deps: JevNeedsMeDeps, input: { roomId: string; taskId: string }): Promise<MyWorkJevNeedsMe> {
  const unavailable: MyWorkJevNeedsMe = { task_id: input.taskId, room_id: input.roomId, state: "unavailable", confidence: null, cached: false };
  const card = await deps.card(input.roomId, input.taskId);
  if (!card) return unavailable;
  const recent = await deps.messages(input.roomId, card.task_id);
  const revision = recent.length ? `msg_${Math.max(...recent.map((message) => message.number))}` : "none";
  const question = { kind: "needs_me" as const, room_id: input.roomId, subject: card.task_id, revision };
  const earlier = await deps.questions.find(question);
  if (earlier) {
    const answer = earlier.answer as { state?: unknown; score?: unknown } | null;
    return isState(earlier.outcome) && isState(answer?.state)
      ? { ...unavailable, task_id: card.task_id, state: answer.state, confidence: typeof answer.score === "number" ? answer.score : null, cached: true }
      : { ...unavailable, task_id: card.task_id, cached: true };
  }
  const endpoint = deps.endpoint();
  if (!endpoint) return { ...unavailable, task_id: card.task_id };
  const claimed = await deps.questions.claim({ ...question, connection_id: card.connection_id, task_id: card.task_id });
  if (!claimed) return { ...unavailable, task_id: card.task_id };
  const result = await askJevChoices(endpoint, buildJevNeedsMeQuestion(card, recent), { evaluate: deps.evaluate, timeoutMs: deps.timeoutMs });
  const answer = result.status === "answered" ? result.answers.waiting_on : undefined;
  const state = answer && isState(answer.choice) && answer.score !== null && answer.score >= JEV_NEEDS_ME_MIN_SCORE ? answer.choice : null;
  const outcome = result.status !== "answered" ? result.status : state ?? (answer?.score === null ? "invalid" : "low_confidence");
  await deps.questions.finish(claimed.id, {
    outcome,
    answer: answer ? { state, choice: answer.choice, score: answer.score } : null,
    latency_ms: result.latencyMs,
  });
  (deps.log ?? ((text: string) => console.info(text)))(`[jev tracker] needs_me room=${input.roomId} task=${card.task_id} outcome=${outcome} latency=${result.latencyMs}ms`);
  return state
    ? { ...unavailable, task_id: card.task_id, state, confidence: answer!.score }
    : { ...unavailable, task_id: card.task_id };
}
