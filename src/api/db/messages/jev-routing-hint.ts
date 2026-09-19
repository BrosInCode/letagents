import { and, asc, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { isPromptOnlyAgentMessage } from "../../../shared/room-agent-prompts.js";
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
import { message_agent_receipts, messages, room_agent_sessions } from "../schema.js";
import type { Message, MessageRecipientAgentTarget } from "../types.js";
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
    sender: string;
    text: string;
    source: string | null;
    publisher_agent_key: string | null;
    publisher_account_id: string | null;
    timestamp: string;
  };
  /** The human message this one replied to, if any. A reply to a human is still unaddressed to agents. */
  replyTo: { sender: string; text: string } | null;
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
  const { config } = resolution;
  const { roomId, message } = plan;
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
    if (candidates.length === 0) return null;

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
      .where(and(eq(messages.room_id, roomId), sql`${messages.number} < ${message.number}`))
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
        replying_to: plan.replyTo ? { from: plan.replyTo.sender, kind: "human", text: plan.replyTo.text } : null,
      },
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
      respondByAgentKey: election.respondByAgentKey,
      candidateAgentKeys: candidates.map(([agentKey]) => agentKey),
      latencyMs,
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
async function applyDeferredJevReceipts(
  plan: DeferredJevRoutingPlan,
  decision: { reason: string; agentKeys: readonly string[] },
): Promise<MessageRecipientAgentTarget[]> {
  const wanted = new Set(decision.agentKeys.slice(0, MAX_ACCOUNT_ROUTING_TARGETS));
  const publisherAgentKey = plan.message.publisher_agent_key?.trim() || null;
  return db.transaction(async (tx) => {
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
  });
}

/**
 * The deferred routing pass. Runs after the send transaction committed and
 * the ordinary `message:created` event went out, so the human's send never
 * waits on inference. Active mode applies Jev's election (or the withheld
 * heuristic fallback when Jev is unavailable) and re-publishes the message to
 * exactly the agents that gained authority. Shadow mode only compares.
 */
export async function runDeferredJevRouting(plan: DeferredJevRoutingPlan, canonicalMessage: Message): Promise<void> {
  const hint = await resolveJevConversationRoutingHint(plan);
  const decision = plan.mode !== "active"
    ? null
    : hint
      ? { reason: "jev_routed", agentKeys: hint.elected }
      : plan.heuristic
        ? { reason: plan.heuristic.reason, agentKeys: plan.heuristic.agentKeys }
        : null;
  const targets = decision && decision.agentKeys.length > 0
    ? await applyDeferredJevReceipts(plan, decision)
    : [];
  const applied = targets.map((target) => target.agent_key);
  if (hint) {
    logJevConversationRouting(hint, {
      roomId: plan.roomId,
      messageNumber: plan.message.number,
      heuristicReason: plan.heuristic?.reason ?? null,
      heuristicAgentKeys: plan.heuristic?.agentKeys ?? [],
      appliedAgentKeys: applied,
    });
  } else {
    console.info(
      `[jev routing] ${plan.mode} room=${plan.roomId} msg=msg_${plan.message.number} jev=unavailable`
      + ` heuristic=${plan.heuristic?.reason ?? "none"}[${[...(plan.heuristic?.agentKeys ?? [])].join(",")}]`
      + ` applied=[${applied.join(",")}]`,
    );
  }
  if (targets.length === 0) return;
  // Dynamic imports avoid a db → server module cycle (same pattern as the
  // message-info invalidation in create.ts).
  const [{ messageEvents }, { queueMessageInfoInvalidation }] = await Promise.all([
    import("../../server/events.js"),
    import("../../server/message-info-events.js"),
  ]);
  messageEvents.emit("message:routed", {
    projectId: plan.roomId,
    message: canonicalMessage,
    recipientAgentTargets: targets,
  });
  queueMessageInfoInvalidation(plan.roomId, null);
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
