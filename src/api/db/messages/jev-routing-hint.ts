import { and, asc, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { isPromptOnlyAgentMessage } from "../../../shared/room-agent-prompts.js";
import { createBoundedExecutor } from "../../bounded-async.js";
import {
  JEV_MAX_CANDIDATE_AGENTS,
  buildJevEvaluationRequest,
  electJevResponders,
  evaluateWithJev,
  readJevRoutingConfig,
  type JevElectionReason,
  type JevRoutingConversationEntry,
  type JevRoutingMode,
} from "../../messages/jev-conversation-routing.js";
import { db } from "../client.js";
import { message_agent_receipts, messages, room_agent_sessions, rooms } from "../schema.js";
import type { MessageRecipientAgentTarget } from "../types.js";
import { MAX_ACCOUNT_ROUTING_TARGETS } from "./account-agent-routing.js";

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

/** The routing mode configured for this process, or null when Jev is off or unusable. */
export function planJevRoutingMode(): JevRoutingMode | null {
  const resolution = readJevRoutingConfig();
  if (resolution.status === "off") return null;
  if (resolution.status === "missing_api_key") {
    if (!warnedMissingApiKey) {
      warnedMissingApiKey = true;
      console.warn(`[jev routing] LETAGENTS_JEV_ROUTING=${resolution.mode} but no TYPESAFE_API_KEY / AI_GATEWAY_API_KEY is set; routing stays deterministic`);
    }
    return null;
  }
  return resolution.config.mode;
}

/**
 * Everything the deferred pass needs, captured inside the send transaction so
 * it never re-derives eligibility. The message is already committed when the
 * pass runs; the pass only appends routing authority.
 */
export interface DeferredJevRoutingPlan {
  mode: JevRoutingMode;
  roomId: string;
  message: {
    number: number;
    publisher_agent_key: string | null;
  };
  /** What the deterministic ladder did (shadow) or would have done (active). */
  heuristic: { reason: string; agentKeys: readonly string[] } | null;
}

export interface JevConversationRoutingHint {
  mode: JevRoutingMode;
  /** Durable agent_keys Jev elected; re-validated against owned sessions before receipts exist. */
  elected: readonly string[];
  electionReason: JevElectionReason;
  needsResponse: number | null;
  choice: string | null;
  probabilitiesByAgentKey: Record<string, number>;
  confidence: number | null;
  /** Per-agent P(should respond); the multi-responder signal. */
  respondByAgentKey: Record<string, number>;
  candidateAgentKeys: readonly string[];
  latencyMs: number;
}

/**
 * Ask Jev who should respond to an already-committed untagged message. Reads
 * the room population and recent conversation outside any send transaction.
 * Any failure returns null and the caller falls back to the deterministic
 * ladder.
 */
export async function resolveJevConversationRoutingHint(
  plan: DeferredJevRoutingPlan,
): Promise<JevConversationRoutingHint | null> {
  const resolution = readJevRoutingConfig();
  if (resolution.status !== "enabled") return null;
  const [room] = await db.select({ enabled: rooms.jev_routing_enabled }).from(rooms).where(eq(rooms.id, plan.roomId));
  if (!room?.enabled) return null;
  const { config } = resolution;
  const { roomId } = plan;
  // Re-read visibility and text at dispatch, rather than exporting a stale
  // copy captured before a rental projection or redaction changed it.
  const [message] = await db.select().from(messages).where(and(
    eq(messages.room_id, roomId), eq(messages.number, plan.message.number),
    sql`${messages.visibility} IS NULL`, sql`${messages.rental_session_id} IS NULL`,
  ));
  if (!message) return null;
  const [replyTo] = message.reply_to_number === null ? [] : await db.select().from(messages).where(and(
    eq(messages.room_id, roomId), eq(messages.number, message.reply_to_number),
    sql`${messages.visibility} IS NULL`, sql`${messages.rental_session_id} IS NULL`,
  ));
  const publisherAgentKey = message.publisher_agent_key?.trim() || null;
  const humanSender = message.source === "browser" && !publisherAgentKey;

  try {
    const sessions = await db
      .select({
        session_id: room_agent_sessions.session_id,
        agent_key: room_agent_sessions.agent_key,
        display_name: room_agent_sessions.display_name,
        runtime: room_agent_sessions.runtime,
        model: room_agent_sessions.model,
        charter: room_agent_sessions.charter,
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
    // A later session for the same key may carry the model/charter the first
    // one predates; keep the first non-empty value.
    const agentsByKey = new Map<string, { display_name: string; runtime: string | null; model: string | null; charter: string | null }>();
    for (const session of sessions) {
      const existing = agentsByKey.get(session.agent_key);
      if (!existing) {
        agentsByKey.set(session.agent_key, {
          display_name: session.display_name, runtime: session.runtime, model: session.model, charter: session.charter,
        });
      } else {
        existing.model ??= session.model;
        existing.charter ??= session.charter;
      }
    }
    // Rooms of one or two agents keep the deterministic small-room rule.
    if (agentsByKey.size <= 2) return null;
    const candidates = [...agentsByKey].filter(([agentKey]) => agentKey !== publisherAgentKey);
    if (candidates.length === 0 || candidates.length > JEV_MAX_CANDIDATE_AGENTS) return null;

    const rows = await db
      .select({
        number: messages.number,
        sender: messages.sender,
        text: messages.text,
        source: messages.source,
        agent_prompt_kind: messages.agent_prompt_kind,
        publisher_agent_key: messages.publisher_agent_key,
      })
      .from(messages)
      .where(and(eq(messages.room_id, roomId), sql`${messages.number} < ${message.number}`, sql`${messages.visibility} IS NULL`, sql`${messages.rental_session_id} IS NULL`))
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
        model: agent.model,
        charter: agent.charter,
        recent_messages: snippetsByAgentKey.get(agentKey) ?? [],
      })),
      recent_conversation: context.slice(0, RECENT_CONVERSATION_ENTRIES).reverse().map(({ entry }) => entry),
      latest_message: {
        from: message.sender,
        kind: humanSender ? "human" : "agent",
        text: message.text,
        replying_to: replyTo ? { from: replyTo.sender, kind: "human", text: replyTo.text } : null,
      },
    });
    const { answers, latencyMs } = await runBoundedJevEvaluation(() => evaluateWithJev(config, request));
    const election = electJevResponders(answers, request.agentKeyByOption);
    if (election.reason === "unparseable" || election.reason === "unknown_option") return null;
    return {
      mode: config.mode,
      elected: election.elected,
      electionReason: election.reason,
      needsResponse: election.needsResponse,
      choice: election.choice,
      probabilitiesByAgentKey: election.probabilitiesByAgentKey,
      confidence: election.confidence,
      respondByAgentKey: election.respondByAgentKey,
      candidateAgentKeys: candidates.map(([agentKey]) => agentKey),
      latencyMs,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.name : "Error";
    console.warn(`[jev routing] inference unavailable for ${roomId}; routing stays deterministic (${detail})`);
    return null;
  }
}

/**
 * Append routing authority for an already-committed message. Re-resolves the
 * owned session population inside its own transaction — the room may have
 * changed since the send — and never duplicates a receipt (unique
 * (message, agent_key) index).
 */
export async function applyDeferredJevReceipts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  plan: DeferredJevRoutingPlan,
  decision: { reason: string; agentKeys: readonly string[] },
): Promise<MessageRecipientAgentTarget[]> {
  const wanted = new Set(decision.agentKeys.slice(0, MAX_ACCOUNT_ROUTING_TARGETS));
  const publisherAgentKey = plan.message.publisher_agent_key?.trim() || null;
  const [visible] = await tx.select({ number: messages.number }).from(messages).where(and(
    eq(messages.room_id, plan.roomId), eq(messages.number, plan.message.number),
    sql`${messages.visibility} IS NULL`, sql`${messages.rental_session_id} IS NULL`,
  ));
  if (!visible) return [];
  const sessions = await tx
    .select({
      session_id: room_agent_sessions.session_id,
      agent_key: room_agent_sessions.agent_key,
      actor_label: room_agent_sessions.actor_label,
      owner_account_id: room_agent_sessions.owner_account_id,
    })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, plan.roomId),
      eq(room_agent_sessions.session_kind, "worker"),
      sql`${room_agent_sessions.ended_at} IS NULL`,
    ))
    .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
    .limit(MAX_JEV_ROUTING_SESSIONS + 1);
  if (sessions.length > MAX_JEV_ROUTING_SESSIONS) return [];
  const groups = new Map<string, { representative: (typeof sessions)[number]; owners: Set<string> }>();
  for (const session of sessions) {
    const group = groups.get(session.agent_key) ?? { representative: session, owners: new Set<string>() };
    group.owners.add(session.owner_account_id);
    groups.set(session.agent_key, group);
  }
  const now = new Date().toISOString();
  const rows = [...wanted].flatMap((agentKey) => {
    const group = groups.get(agentKey);
    // Only a single-owner durable key may receive authority; self never does.
    if (!group || group.owners.size !== 1 || agentKey === publisherAgentKey) return [];
    return [{
      id: `rcpt_${randomUUID().replace(/-/g, "")}`,
      message_room_id: plan.roomId,
      message_number: plan.message.number,
      room_id: plan.roomId,
      agent_session_id: group.representative.session_id,
      agent_key: agentKey,
      actor_label: group.representative.actor_label,
      activation_reason: decision.reason,
      receipt_state: "queued",
      created_at: now,
      updated_at: now,
    }];
  });
  if (rows.length === 0) return [];
  const inserted = await tx
    .insert(message_agent_receipts)
    .values(rows)
    .onConflictDoNothing()
    .returning({ agent_key: message_agent_receipts.agent_key, agent_session_id: message_agent_receipts.agent_session_id });
  return inserted.map((receipt) => ({
    agent_key: receipt.agent_key,
    agent_session_id: receipt.agent_session_id,
    owner_account_id: groups.get(receipt.agent_key)!.representative.owner_account_id,
  }));
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
    + ` respond=${JSON.stringify(hint.respondByAgentKey)}`
    + ` probabilities=${JSON.stringify(hint.probabilitiesByAgentKey)}`,
  );
}
