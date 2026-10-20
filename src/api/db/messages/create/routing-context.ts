/**
 * Collects what send-time routing needs: task leases, the reply target, the
 * routing shape, the active worker sessions, their connections and the thread
 * membership.
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import { createGlobalAgentAddressResolver, isUntrustedExternalActivationSource, isTaskOwnerFollowUpMessageText } from "../../../../shared/activation-routing.js";
import { RequestValidationError } from "../../../validation-error.js";
import { getSessionConnections } from "../session-connections.js";
import { messages, room_agent_sessions } from "../../schema.js";
import type { MessageRow } from "../../types.js";
import { getBoundedActiveWorkLeaseOwners } from "../account-agent-routing.js";
import { getMessageThreadRoutingProjection, type ThreadRoutingProjection } from "../thread-routing-membership.js";
import type { MessageCreateTransaction, AddMessageOptions } from "./types.js";

const MAX_ACTIVE_ROUTING_SESSIONS = 50_000;

/** Reads the inputs of send-time routing for one created message. */
export async function resolveMessageRoutingContext(
  tx: MessageCreateTransaction,
  roomId: string,
  createdMessage: MessageRow,
  addressedTo: NonNullable<AddMessageOptions["addressed_to"]> | null,
  replyToNumber: number | null,
) {
  // Send-time routing snapshot: resolve active worker sessions in this room and insert queued receipts
  const routingStartedAtMs = Date.now();
  const untrustedExternalEvent = isUntrustedExternalActivationSource(createdMessage.source);
  const taskOwnerFollowUp = !untrustedExternalEvent && !addressedTo
    && isTaskOwnerFollowUpMessageText(createdMessage.text);
  const leases = taskOwnerFollowUp
    ? await getBoundedActiveWorkLeaseOwners(tx, roomId)
    : [];

  let replyToMessage: {
    sender: string;
    text: string;
    source?: string;
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
    publisher_account_id?: string | null;
    visibility?: string | null;
    rental_session_id?: string | null;
  } | null = null;
  if (replyToNumber) {
    const [foundReply] = await tx
      .select({
        sender: messages.sender,
        text: messages.text,
        source: messages.source,
        publisher_agent_key: messages.publisher_agent_key,
        publisher_agent_session_id: messages.publisher_agent_session_id,
        publisher_account_id: messages.publisher_account_id,
        visibility: messages.visibility,
        rental_session_id: messages.rental_session_id,
      })
      .from(messages)
      .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
      .limit(1);
    if (foundReply) replyToMessage = {
      sender: foundReply.sender,
      text: foundReply.text,
      source: foundReply.source ?? undefined,
      publisher_agent_key: foundReply.publisher_agent_key,
      publisher_agent_session_id: foundReply.publisher_agent_session_id,
      publisher_account_id: foundReply.publisher_account_id,
      visibility: foundReply.visibility,
      rental_session_id: foundReply.rental_session_id,
    };
  }

  const routingThreadRootNumber = createdMessage.thread_root_number || createdMessage.number;
  const threadRootId = `msg_${routingThreadRootNumber}`;
  let threadRoutingProjection: ThreadRoutingProjection = {
    exactMembers: new Map(),
    legacyAliases: new Map(),
  };
  const messageForRouting = {
    id: `msg_${createdMessage.number}`,
    sender: createdMessage.sender,
    text: createdMessage.text,
    source: createdMessage.source,
    reply_to: replyToMessage,
    thread_root_id: threadRootId,
    thread: {
      root_message_id: threadRootId,
      // Display participants are intentionally not hydrated on the hot
      // write path. Exact membership comes from the indexed projection.
      participants: [],
    },
  };

  // Only address resolution needs the complete room population. Exact
  // thread, reply, and lease authority already yields durable candidates;
  // querying just those keys/sessions avoids enumerating a large room twice
  // for an ordinary one-recipient continuation.
  const routingShape = createGlobalAgentAddressResolver([])(messageForRouting);
  // Replying to a human's message (often your own, to nudge the room) does
  // not address any agent: it stays in the untagged fallback lane instead
  // of the reply-target lane, which has no agent to wake.
  const replyToIsHuman = replyToMessage !== null
    && !replyToMessage.publisher_agent_key
    && replyToMessage.source !== "agent";
  const humanConversationEligible = createdMessage.source === "browser"
    && Boolean(createdMessage.publisher_account_id) && !createdMessage.publisher_agent_key
    && !routingShape.broadcast && !routingShape.hasMention
    && (createdMessage.reply_to_number === null || replyToIsHuman)
    && createdMessage.thread_root_number === null;
  const candidateAgentKeys = new Set<string>();
  const candidateSessionIds = new Set<string>();
  if (replyToMessage?.publisher_agent_key && replyToMessage.publisher_account_id) {
    candidateAgentKeys.add(replyToMessage.publisher_agent_key);
    if (replyToMessage.publisher_agent_session_id) {
      candidateSessionIds.add(replyToMessage.publisher_agent_session_id);
    }
  }
  let leaseNeedsCompletePopulation = false;
  for (const lease of leases) {
    if (lease.agent_key) candidateAgentKeys.add(lease.agent_key);
    if (lease.agent_session_id) candidateSessionIds.add(lease.agent_session_id);
    if (!lease.agent_key && !lease.agent_session_id) leaseNeedsCompletePopulation = true;
  }
  const needsCompletePopulation = humanConversationEligible
    || routingShape.broadcast
    || routingShape.hasMention
    || createdMessage.thread_root_number !== null
    || (
      replyToMessage?.source === "agent"
      && !replyToMessage.publisher_agent_key
      // A threaded legacy reply target is already resolved globally by the
      // participant projection above. Top-level quotes still need the full
      // room alias population to establish uniqueness.
      && !createdMessage.thread_root_number
    )
    || (createdMessage.source === "agent" && !createdMessage.publisher_agent_key)
    || leaseNeedsCompletePopulation;
  const candidateKeys = [...candidateAgentKeys];
  const candidateSessions = [...candidateSessionIds];
  // Keep candidate lookup to O(1) PostgreSQL bind parameters. Expanding a
  // projected 65k+ durable-key set through inArray() exceeds the wire
  // protocol's 65,535 parameter ceiling before the active-session bound can
  // fail closed.
  const candidateKeyCondition = candidateKeys.length > 0
    ? sql`${room_agent_sessions.agent_key} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateKeys)}::jsonb)
        )`
    : undefined;
  const candidateSessionCondition = candidateSessions.length > 0
    ? sql`${room_agent_sessions.session_id} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateSessions)}::jsonb)
        )`
    : undefined;
  const candidateCondition = candidateKeyCondition && candidateSessionCondition
    ? or(
        candidateKeyCondition,
        candidateSessionCondition,
      )
    : candidateKeyCondition ?? candidateSessionCondition;
  const activeSessions = !untrustedExternalEvent && !addressedTo && (needsCompletePopulation || candidateCondition)
    ? await tx
        .select({
          session_id: room_agent_sessions.session_id,
          actor_label: room_agent_sessions.actor_label,
          agent_key: room_agent_sessions.agent_key,
          agent_instance_id: room_agent_sessions.agent_instance_id,
          display_name: room_agent_sessions.display_name,
          session_kind: room_agent_sessions.session_kind,
          owner_account_id: room_agent_sessions.owner_account_id,
          created_at: room_agent_sessions.created_at,
          last_seen_at: room_agent_sessions.last_seen_at,
        })
        .from(room_agent_sessions)
        .where(
          and(
            eq(room_agent_sessions.room_id, roomId),
            eq(room_agent_sessions.session_kind, "worker"),
            sql`${room_agent_sessions.ended_at} IS NULL`,
            needsCompletePopulation ? undefined : candidateCondition,
          )
        )
        // A stable order for the bound below and for routing identities.
        .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
        .limit(MAX_ACTIVE_ROUTING_SESSIONS + 1)
    : [];

  if (activeSessions.length > MAX_ACTIVE_ROUTING_SESSIONS) {
    throw new RequestValidationError("Room has too many active worker sessions to route a message safely.");
  }

  const reachableAgentKeys = new Set<string>();
  let connectedSessionIds: ReadonlySet<string> = new Set<string>();
  // Connections settle two questions: which agent a duplicated name means,
  // and which session answers for an agent that has several. The second
  // needs only the sessions of agents that have more than one.
  const sessionCountByAgentKey = new Map<string, number>();
  for (const session of activeSessions) {
    sessionCountByAgentKey.set(session.agent_key, (sessionCountByAgentKey.get(session.agent_key) ?? 0) + 1);
  }
  const sessionsNeedingConnections = routingShape.hasMention
    ? activeSessions
    : activeSessions.filter((session) => (sessionCountByAgentKey.get(session.agent_key) ?? 0) > 1);
  if (sessionsNeedingConnections.length > 0) {
    const connections = await getSessionConnections(
      tx,
      roomId,
      sessionsNeedingConnections.map((session) => session.session_id),
    );
    connectedSessionIds = connections.connected;
    if (routingShape.hasMention) {
      for (const session of activeSessions) {
        if (connections.reachable.has(session.session_id)) {
          reachableAgentKeys.add(session.agent_key);
        }
      }
    }
  }

  if (createdMessage.thread_root_number && activeSessions.length > 0) {
    threadRoutingProjection = await getMessageThreadRoutingProjection(
      tx,
      roomId,
      [routingThreadRootNumber],
      {
        activeIdentities: activeSessions.map((session) => ({
          actor_label: session.actor_label,
          agent_key: session.agent_key,
          agent_instance_id: session.agent_instance_id,
          agent_session_id: session.session_id,
          display_name: session.display_name,
          session_kind: session.session_kind,
          owner_account_id: session.owner_account_id,
        })),
      },
    );
  }
  return {
    routingStartedAtMs,
    taskOwnerFollowUp,
    leases,
    replyToMessage,
    routingThreadRootNumber,
    threadRoutingProjection,
    messageForRouting,
    routingShape,
    replyToIsHuman,
    humanConversationEligible,
    activeSessions,
    reachableAgentKeys,
    connectedSessionIds,
  };
}

export type MessageRoutingContext = Awaited<ReturnType<typeof resolveMessageRoutingContext>>;
