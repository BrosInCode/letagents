/**
 * The suggested reply for a person's composer. Agents attach `suggested_reply`
 * to the messages they send: what they expect the person to say next. This
 * module picks which one a person sees in a room.
 *
 * 1. Read the room's newest main-room messages (threads have their own composer).
 * 2. Keep only what came after the person's own last message: once they spoke,
 *    older suggestions are answered or stale.
 * 3. For each agent, its newest message in that span counts. It is a candidate
 *    when it carries a suggestion and it answers this person: it replies to
 *    their message, or the latest person who spoke before it is them.
 * 4. No candidate: nothing. One: that one. Several: Jev picks the reply this
 *    person is most likely to send, from the recent conversation. When Jev is
 *    off, slow or unsure, the newest candidate wins.
 *
 * Pure apart from the one Jev call; the route reads the rows.
 */
import { askJevChoices, JEV_UNTRUSTED_TEXT_NOTE, textForJev, type JevEvaluate } from "../connectors/jev/choice.js";
import type { JevEndpoint } from "./jev-conversation-routing.js";
import { SUGGESTED_REPLY_MAX_CHARS } from "../../../shared/suggested-reply.mjs";

export { SUGGESTED_REPLY_MAX_CHARS };
/** How many recent main-room messages the pick reads. */
export const SUGGESTED_REPLY_WINDOW = 30;
/** Jev answers within this time, or the newest candidate wins. */
export const SUGGESTED_REPLY_JEV_TIMEOUT_MS = 3_000;
const CONVERSATION_TEXT_MAX_CHARS = 400;

export interface SuggestedReplyRow {
  number: number;
  sender: string;
  text: string;
  source: string | null;
  publisher_agent_key: string | null;
  publisher_account_id: string | null;
  reply_to_number: number | null;
  suggested_reply: string | null;
}

export interface SuggestedReplyCandidate {
  message_number: number;
  agent_key: string;
  from: string;
  text: string;
}

export interface SuggestedReply {
  message_id: string;
  agent_key: string;
  from: string;
  text: string;
}

function isHuman(row: SuggestedReplyRow): boolean {
  return row.source === "browser" && !row.publisher_agent_key;
}

function isAgent(row: SuggestedReplyRow): row is SuggestedReplyRow & { publisher_agent_key: string } {
  return row.source === "agent" && Boolean(row.publisher_agent_key);
}

/** Steps 2 and 3. `rows` are oldest first. Candidates come back oldest first. */
export function suggestedReplyCandidates(rows: readonly SuggestedReplyRow[], viewerAccountId: string): SuggestedReplyCandidate[] {
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  let start = 0;
  rows.forEach((row, index) => {
    if (isHuman(row) && row.publisher_account_id === viewerAccountId) start = index + 1;
  });
  const newestByAgent = new Map<string, { row: SuggestedReplyRow; humanBefore: SuggestedReplyRow | null }>();
  let humanBefore: SuggestedReplyRow | null = null;
  rows.forEach((row, index) => {
    if (isHuman(row)) humanBefore = row;
    if (index < start || !isAgent(row)) return;
    newestByAgent.set(row.publisher_agent_key, { row, humanBefore });
  });
  const candidates: SuggestedReplyCandidate[] = [];
  for (const [agentKey, { row, humanBefore: lastHuman }] of newestByAgent) {
    const text = row.suggested_reply?.trim();
    if (!text) continue;
    const repliedTo = row.reply_to_number != null ? byNumber.get(row.reply_to_number) ?? null : null;
    const asked = repliedTo && isHuman(repliedTo) ? repliedTo : lastHuman;
    if (asked?.publisher_account_id !== viewerAccountId) continue;
    candidates.push({ message_number: row.number, agent_key: agentKey, from: row.sender, text });
  }
  return candidates.sort((a, b) => a.message_number - b.message_number);
}

function toSuggestion(candidate: SuggestedReplyCandidate): SuggestedReply {
  return { message_id: `msg_${candidate.message_number}`, agent_key: candidate.agent_key, from: candidate.from, text: candidate.text };
}

/** Step 4. */
export async function pickSuggestedReply(input: {
  rows: readonly SuggestedReplyRow[];
  viewerAccountId: string;
  endpoint: JevEndpoint | null;
  evaluate?: JevEvaluate;
}): Promise<SuggestedReply | null> {
  const candidates = suggestedReplyCandidates(input.rows, input.viewerAccountId);
  if (candidates.length === 0) return null;
  const newest = candidates[candidates.length - 1]!;
  if (candidates.length === 1 || !input.endpoint) return toSuggestion(newest);
  const options = Object.fromEntries(candidates.map((candidate, index) => [
    `reply_${index + 1}`,
    `The person sends: "${textForJev(candidate.text, SUGGESTED_REPLY_MAX_CHARS)}" (suggested by ${textForJev(candidate.from, 80)}).`,
  ]));
  const result = await askJevChoices(input.endpoint, {
    state: {
      note: JEV_UNTRUSTED_TEXT_NOTE,
      person: "the_viewer",
      untrusted_recent_conversation: input.rows.map((row) => ({
        from: isHuman(row) ? (row.publisher_account_id === input.viewerAccountId ? "the_viewer" : "another person") : textForJev(row.sender, 80),
        kind: isHuman(row) ? "human" : isAgent(row) ? "agent" : "system",
        text: textForJev(row.text, CONVERSATION_TEXT_MAX_CHARS),
      })),
    },
    questions: {
      next_reply: {
        instructions: "Agents in this room each suggested what the_viewer will say next. Which suggestion is"
          + " the_viewer most likely to send now? Prefer the one that answers the question or decision the"
          + " conversation is waiting on from the_viewer, and the agent the_viewer was most recently working with.",
        options,
      },
    },
  }, { evaluate: input.evaluate, timeoutMs: SUGGESTED_REPLY_JEV_TIMEOUT_MS });
  if (result.status !== "answered") return toSuggestion(newest);
  const index = Number(result.answers.next_reply?.choice.slice("reply_".length)) - 1;
  return toSuggestion(candidates[index] ?? newest);
}

/**
 * Remembers each room and person's pick by the room's newest message, so a
 * room that has not changed costs no Jev call, and concurrent asks share one.
 */
export class SuggestedReplyCache {
  private readonly entries = new Map<string, Promise<SuggestedReply | null>>();

  constructor(private readonly maxEntries = 1_000) {}

  get(key: string, load: () => Promise<SuggestedReply | null>): Promise<SuggestedReply | null> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const pending = load().catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return pending;
  }
}
