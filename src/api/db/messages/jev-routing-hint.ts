import { and, asc, desc, eq, sql } from "drizzle-orm";

import { isPromptOnlyAgentMessage } from "../../../shared/room-agent-prompts.js";
import { createGlobalAgentAddressResolver } from "../../../shared/activation-routing.js";
import { createBoundedExecutor } from "../../bounded-async.js";
import {
  buildJevEvaluationRequest,
  electJevResponders,
  evaluateWithJev,
  readJevRoutingConfig,
  type JevElectionReason,
  type JevRoutingConversationEntry,
  type JevRoutingMode,
} from "../../messages/jev-conversation-routing.js";
import { db } from "../client.js";
import { messages, room_agent_sessions } from "../schema.js";
import type { AddMessageOptions } from "./create.js";

/** Rooms above this size fall back to deterministic routing rather than ship a huge state. */
const MAX_JEV_ROUTING_SESSIONS = 200;
const RECENT_MESSAGE_WINDOW = 40;
const RECENT_CONVERSATION_ENTRIES = 15;
const AGENT_SNIPPETS_PER_AGENT = 2;
/** Room activity that is context noise for a responder decision. */
const EXCLUDED_CONTEXT_SOURCES = new Set(["system", "github", "managed_agent_failure"]);

// One inference per send; a slow gateway must shed load, not queue sends.
const runBoundedJevEvaluation = createBoundedExecutor({
  label: "jev conversation routing",
  maxConcurrent: 8,
  maxQueued: 16,
  timeoutMs: 5_000,
});

let warnedMissingApiKey = false;

export interface JevConversationRoutingHint {
  mode: JevRoutingMode;
  /** Durable agent_keys Jev elected; re-validated against owned sessions in the transaction. */
  elected: readonly string[];
  electionReason: JevElectionReason;
  needsResponse: number | null;
  choice: string | null;
  probabilitiesByAgentKey: Record<string, number>;
  confidence: number | null;
  candidateAgentKeys: readonly string[];
  latencyMs: number;
}

/**
 * Advisory conversation routing for an untagged top-level message. Runs
 * before the message-insert transaction opens so a network call never holds
 * the connection, and only for the case the deterministic ladder cannot
 * decide: no mention, no broadcast, no reply, no thread, in a room of three
 * or more registered agents. Any failure returns null and routing proceeds
 * exactly as it does without Jev.
 */
export async function resolveJevConversationRoutingHint(input: {
  roomId: string;
  sender: string;
  text: string;
  options: AddMessageOptions | undefined;
}): Promise<JevConversationRoutingHint | null> {
  const resolution = readJevRoutingConfig();
  if (resolution.status === "off") return null;
  if (resolution.status === "missing_api_key") {
    if (!warnedMissingApiKey) {
      warnedMissingApiKey = true;
      console.warn(`[jev routing] LETAGENTS_JEV_ROUTING=${resolution.mode} but AI_GATEWAY_API_KEY is unset; routing stays deterministic`);
    }
    return null;
  }
  const { config } = resolution;
  const { roomId, sender, text, options } = input;

  const source = options?.source ?? null;
  const publisherAgentKey = options?.publisher_agent_key?.trim() || null;
  const humanSender = source === "browser" && Boolean(options?.account_id?.trim()) && !publisherAgentKey;
  const agentSender = source === "agent" && Boolean(publisherAgentKey);
  if (!humanSender && !agentSender) return null;
  if (options?.reply_to_message_id || options?.thread_root_message_id) return null;
  if (isPromptOnlyAgentMessage(text, options?.agent_prompt_kind)) return null;
  const shape = createGlobalAgentAddressResolver([])({ sender, text, reply_to: null });
  if (shape.broadcast || shape.hasMention) return null;

  try {
    const sessions = await db
      .select({
        session_id: room_agent_sessions.session_id,
        agent_key: room_agent_sessions.agent_key,
        display_name: room_agent_sessions.display_name,
        runtime: room_agent_sessions.runtime,
      })
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.room_id, roomId),
        eq(room_agent_sessions.session_kind, "worker"),
        sql`${room_agent_sessions.ended_at} IS NULL`,
      ))
      .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
      .limit(MAX_JEV_ROUTING_SESSIONS + 1);
    if (sessions.length > MAX_JEV_ROUTING_SESSIONS) {
      console.warn(`[jev routing] ${roomId} has more than ${MAX_JEV_ROUTING_SESSIONS} worker sessions; routing stays deterministic`);
      return null;
    }
    // Earliest session represents a durable key, matching the send-time loop.
    const agentsByKey = new Map<string, { display_name: string; runtime: string | null }>();
    for (const session of sessions) {
      if (!agentsByKey.has(session.agent_key)) {
        agentsByKey.set(session.agent_key, { display_name: session.display_name, runtime: session.runtime });
      }
    }
    // Rooms of one or two agents keep the deterministic small-room rule.
    if (agentsByKey.size <= 2) return null;
    const candidates = [...agentsByKey].filter(([agentKey]) => agentKey !== publisherAgentKey);
    if (candidates.length === 0) return null;

    const rows = await db
      .select({
        sender: messages.sender,
        text: messages.text,
        source: messages.source,
        agent_prompt_kind: messages.agent_prompt_kind,
        publisher_agent_key: messages.publisher_agent_key,
      })
      .from(messages)
      .where(eq(messages.room_id, roomId))
      .orderBy(desc(messages.number))
      .limit(RECENT_MESSAGE_WINDOW);
    const context = rows
      .filter((row) =>
        !isPromptOnlyAgentMessage(row.text, row.agent_prompt_kind)
        && !EXCLUDED_CONTEXT_SOURCES.has(row.source ?? ""))
      .map((row) => {
        const agentKey = row.publisher_agent_key?.trim() || null;
        const entry: JevRoutingConversationEntry = {
          from: (agentKey && agentsByKey.get(agentKey)?.display_name) || row.sender,
          kind: agentKey || row.source === "agent" ? "agent" : "human",
          text: row.text,
        };
        return { agentKey, entry };
      });
    const snippetsByAgentKey = new Map<string, string[]>();
    for (const { agentKey, entry } of context) {
      if (!agentKey) continue;
      const snippets = snippetsByAgentKey.get(agentKey) ?? [];
      if (snippets.length < AGENT_SNIPPETS_PER_AGENT) snippets.push(entry.text);
      snippetsByAgentKey.set(agentKey, snippets);
    }

    const request = buildJevEvaluationRequest({
      agents: candidates.map(([agentKey, agent]) => ({
        agent_key: agentKey,
        display_name: agent.display_name,
        runtime: agent.runtime,
        recent_messages: snippetsByAgentKey.get(agentKey) ?? [],
      })),
      recent_conversation: context.slice(0, RECENT_CONVERSATION_ENTRIES).reverse().map(({ entry }) => entry),
      latest_message: { from: sender, kind: humanSender ? "human" : "agent", text },
    });
    const { answers, latencyMs } = await runBoundedJevEvaluation(() => evaluateWithJev(config, request));
    const election = electJevResponders(answers, request.agentKeyByOption);
    return {
      mode: config.mode,
      elected: election.elected,
      electionReason: election.reason,
      needsResponse: election.needsResponse,
      choice: election.choice,
      probabilitiesByAgentKey: election.probabilitiesByAgentKey,
      confidence: election.confidence,
      candidateAgentKeys: candidates.map(([agentKey]) => agentKey),
      latencyMs,
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[jev routing] inference unavailable for ${roomId}; routing stays deterministic (${detail})`);
    return null;
  }
}

function formatProbability(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

/**
 * One line per routed message so shadow runs can be measured against the
 * heuristic from logs alone. Message text is never logged.
 */
export function logJevConversationRouting(
  hint: JevConversationRoutingHint,
  context: {
    roomId: string;
    messageNumber: number;
    heuristicReason: string | null;
    heuristicAgentKeys: readonly string[];
    appliedAgentKeys: readonly string[];
  },
): void {
  const heuristic = [...context.heuristicAgentKeys].sort();
  const jev = [...hint.elected].sort();
  const agree = heuristic.length === jev.length && heuristic.every((key, index) => key === jev[index]);
  console.info(
    `[jev routing] ${hint.mode} room=${context.roomId} msg=msg_${context.messageNumber}`
    + ` needs=${formatProbability(hint.needsResponse)} choice=${hint.choice ?? "-"}`
    + ` confidence=${formatProbability(hint.confidence)} election=${hint.electionReason}`
    + ` jev=[${jev.join(",")}] heuristic=${context.heuristicReason ?? "none"}[${heuristic.join(",")}]`
    + ` applied=[${[...context.appliedAgentKeys].join(",")}] agree=${agree}`
    + ` candidates=${hint.candidateAgentKeys.length} latency=${hint.latencyMs}ms`
    + ` probabilities=${JSON.stringify(hint.probabilitiesByAgentKey)}`,
  );
}
