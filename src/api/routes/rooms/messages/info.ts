import type { Express, Request, Response } from "express";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { db } from "../../../db/client.js";
import { getMessageById } from "../../../db.js";
import {
  messages,
  message_agent_receipts,
  room_agent_observation_spans,
  room_agent_sessions,
  message_human_read_ranges,
  accounts,
} from "../../../db/schema.js";
import { parseScopedId } from "../../../db/utils.js";
import { routeParam, resolveParticipantRoom } from "./helpers.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function formatActivationReason(reason: string): string {
  switch (reason) {
    case "explicit_mention":
    case "direct_mention":
    case "mention":
      return "Mentioned directly";
    case "explicit_other_mention":
      return "Mentioned another agent";
    case "broadcast":
    case "everyone":
      return "Asked with @everyone";
    case "reply_target":
    case "reply":
      return "Replied to this agent";
    case "other_reply_target":
      return "Replied to another agent";
    case "thread_participant":
    case "thread_participation":
    case "thread":
      return "Following this thread";
    case "task_owner":
    case "task_ownership":
    case "task":
      return "Assigned this work";
    case "small_room":
      return "Included in this small room";
    case "recent_conversation":
      return "Continuing your conversation";
    case "self_message":
      return "Published by this agent";
    case "system_event":
      return "System notification";
    case "unaddressed":
      return "Unaddressed message";
    default:
      return reason;
  }
}

export function registerMessageInfoRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^(?:\/api)?\/rooms\/(.+)\/messages\/(msg_\d+)\/info$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const rawMessageId = routeParam(req, 1);
    const messageNumber = parseScopedId(rawMessageId, "msg");
    if (!messageNumber) {
      // Body deliberately avoids the phrase "not found", matching the
      // single-message route, so concealed and nonexistent messages read the same.
      res.status(404).json({ error: "message does not exist in this room" });
      return;
    }

    // The visibility gate is the same getter the single-message route uses, so
    // prompt-only and account-scoped concealment stay indistinguishable from
    // a message that never existed.
    const visibleMessage = await getMessageById(project.id, rawMessageId, {
      include_prompt_only: deps.shouldIncludePromptOnlyMessages(req),
      account_id: req.sessionAccount?.account_id ?? null,
    });
    if (!visibleMessage) {
      res.status(404).json({ error: "message does not exist in this room" });
      return;
    }

    const [targetMessage] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.room_id, project.id), eq(messages.number, messageNumber)))
      .limit(1);

    if (!targetMessage) {
      res.status(404).json({ error: "message does not exist in this room" });
      return;
    }

    // 1. Fetch human readers from message_human_read_ranges. Ranges are
    // scope-safe: a timeline range must never mark thread replies read, and a
    // thread range only covers its own thread.
    const scopeCondition = targetMessage.thread_root_number
      ? and(
        eq(message_human_read_ranges.scope_kind, "thread"),
        eq(message_human_read_ranges.thread_root_number, targetMessage.thread_root_number),
      )
      : eq(message_human_read_ranges.scope_kind, "timeline");
    const readRanges = await db
      .select({
        account_id: message_human_read_ranges.account_id,
        created_at: message_human_read_ranges.created_at,
        account_login: accounts.login,
        account_name: accounts.display_name,
        account_avatar: accounts.avatar_url,
      })
      .from(message_human_read_ranges)
      .leftJoin(accounts, eq(message_human_read_ranges.account_id, accounts.id))
      .where(
        and(
          eq(message_human_read_ranges.room_id, project.id),
          scopeCondition,
          lte(message_human_read_ranges.first_message_sequence, targetMessage.number),
          gte(message_human_read_ranges.last_message_sequence, targetMessage.number)
        )
      );

    // Deduplicate human readers by account, keeping earliest created_at.
    // Account ids stay internal: the projection exposes only public identity.
    const humanReadersMap = new Map<string, { name: string; avatar_url: string | null; seen_at: string }>();
    for (const r of readRanges) {
      if (targetMessage.publisher_account_id && r.account_id === targetMessage.publisher_account_id) {
        continue; // Exclude author self-read
      }
      const existing = humanReadersMap.get(r.account_id);
      if (!existing || new Date(r.created_at) < new Date(existing.seen_at)) {
        humanReadersMap.set(r.account_id, {
          name: r.account_name || r.account_login || "Room member",
          avatar_url: r.account_avatar || null,
          seen_at: r.created_at,
        });
      }
    }
    const seenByPeople = Array.from(humanReadersMap.values());

    // 2. Fetch routed agent receipts
    const receipts = await db
      .select()
      .from(message_agent_receipts)
      .where(
        and(
          eq(message_agent_receipts.message_room_id, project.id),
          eq(message_agent_receipts.message_number, targetMessage.number)
        )
      );

    const routedSessionIds = new Set(receipts.map((r) => r.agent_session_id));

    // Fetch replies referencing targetMessage to populate reply_message_id.
    // Match on durable agent_key (sessions rotate); the earliest reply is
    // canonical. Session id remains only as a legacy fallback.
    const replyMessages = await db
      .select({
        number: messages.number,
        publisher_agent_key: messages.publisher_agent_key,
        publisher_agent_session_id: messages.publisher_agent_session_id,
      })
      .from(messages)
      .where(
        and(
          eq(messages.room_id, project.id),
          eq(messages.reply_to_number, targetMessage.number)
        )
      )
      .orderBy(asc(messages.number));

    const repliesByAgentKey = new Map<string, string>();
    const repliesBySession = new Map<string, string>();
    for (const reply of replyMessages) {
      if (reply.publisher_agent_key && !repliesByAgentKey.has(reply.publisher_agent_key)) {
        repliesByAgentKey.set(reply.publisher_agent_key, `msg_${reply.number}`);
      }
      if (reply.publisher_agent_session_id && !repliesBySession.has(reply.publisher_agent_session_id)) {
        repliesBySession.set(reply.publisher_agent_session_id, `msg_${reply.number}`);
      }
    }

    // 3. Fetch observation spans covering this message (routed agents use them
    // for the honest observed/not-yet-observed distinction; unrouted agents
    // become the quiet "also observed" list).
    const observationSpans = await db
      .select()
      .from(room_agent_observation_spans)
      .where(
        and(
          eq(room_agent_observation_spans.room_id, project.id),
          lte(room_agent_observation_spans.first_message_sequence, targetMessage.number),
          gte(room_agent_observation_spans.last_message_sequence, targetMessage.number)
        )
      );
    const observedAgentKeys = new Set(observationSpans.map((span) => span.agent_key));

    // Map routed agent receipts. A queued receipt only proves routing; the
    // observed flag distinguishes "saw it, no reply yet" from "never saw it".
    const agentsAsked = receipts.map((r) => ({
      receipt_id: r.id,
      agent_key: r.agent_key,
      agent_session_id: r.agent_session_id,
      actor_label: r.actor_label,
      activation_reason: r.activation_reason,
      activation_reason_label: formatActivationReason(r.activation_reason),
      receipt_state: r.receipt_state,
      observed: observedAgentKeys.has(r.agent_key),
      // The stamped canonical number covers supervised publications (no
      // reply_to); the reply_to lookups remain as the legacy fallback.
      reply_message_id: (r.reply_message_number ? `msg_${r.reply_message_number}` : null)
        || repliesByAgentKey.get(r.agent_key)
        || repliesBySession.get(r.agent_session_id)
        || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    const routedAgentKeys = new Set(receipts.map((r) => r.agent_key));
    const quietAgentsMap = new Map<string, { agent_key: string; agent_session_id: string; display_name: string }>();
    for (const span of observationSpans) {
      if (!routedSessionIds.has(span.agent_session_id) && !routedAgentKeys.has(span.agent_key)) {
        quietAgentsMap.set(span.agent_key, {
          agent_key: span.agent_key,
          agent_session_id: span.agent_session_id,
          display_name: span.agent_key,
        });
      }
    }
    if (quietAgentsMap.size > 0) {
      // Quiet observers have no receipt to carry a label; resolve their
      // human-readable names from the room's session registry.
      const namedSessions = await db
        .select({
          agent_key: room_agent_sessions.agent_key,
          display_name: room_agent_sessions.display_name,
        })
        .from(room_agent_sessions)
        .where(and(
          eq(room_agent_sessions.room_id, project.id),
          inArray(room_agent_sessions.agent_key, [...quietAgentsMap.keys()]),
        ))
        .orderBy(asc(room_agent_sessions.created_at));
      for (const session of namedSessions) {
        const quiet = quietAgentsMap.get(session.agent_key);
        if (quiet && session.display_name) quiet.display_name = session.display_name;
      }
    }
    const alsoObserved = Array.from(quietAgentsMap.values());

    // Calculate counts
    const replyCount = receipts.filter((r) => r.receipt_state === "replied").length;

    res.json({
      message: {
        id: `msg_${targetMessage.number}`,
        room_id: targetMessage.room_id,
        number: targetMessage.number,
        sender: targetMessage.sender,
        text_preview: targetMessage.text.slice(0, 200),
        timestamp: targetMessage.timestamp,
        thread_root_id: targetMessage.thread_root_number ? `msg_${targetMessage.thread_root_number}` : `msg_${targetMessage.number}`,
        reply_to_id: targetMessage.reply_to_number ? `msg_${targetMessage.reply_to_number}` : null,
      },
      seen_by_people: seenByPeople,
      agents_asked: agentsAsked,
      also_observed: alsoObserved,
      summary_counts: {
        seen_count: seenByPeople.length,
        asked_count: agentsAsked.length,
        reply_count: replyCount,
        observed_count: alsoObserved.length,
      },
    });
  });
}
