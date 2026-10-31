/** Delivers a system notice to exactly one agent, bypassing routing. */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { chooseAnsweringSession } from "../../../rooms/answering-session.js";
import { getSessionConnections } from "../session-connections.js";
import { room_agent_sessions } from "../../schema.js";
import type { MessageRecipientAgentTarget, MessageRow } from "../../types.js";
import { MAX_ACCOUNT_ROUTING_TARGETS } from "../account-agent-routing.js";
import type { MessageCreateTransaction, AddMessageOptions } from "./types.js";
import { insertMessageReceiptRows } from "./receipt-rows.js";

export async function routeAddressedMessage(
  tx: MessageCreateTransaction,
  roomId: string,
  message: MessageRow,
  addressedTo: NonNullable<AddMessageOptions["addressed_to"]>,
): Promise<MessageRecipientAgentTarget[]> {
  const sessions = await tx
    .select({
      session_id: room_agent_sessions.session_id,
      actor_label: room_agent_sessions.actor_label,
      agent_key: room_agent_sessions.agent_key,
      owner_account_id: room_agent_sessions.owner_account_id,
      created_at: room_agent_sessions.created_at,
      last_seen_at: room_agent_sessions.last_seen_at,
      ended_at: room_agent_sessions.ended_at,
    })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, roomId),
      eq(room_agent_sessions.agent_key, addressedTo.agent_key),
      eq(room_agent_sessions.session_kind, "worker"),
    ))
    .orderBy(sql`${room_agent_sessions.ended_at} IS NULL DESC`, sql`${room_agent_sessions.ended_at} DESC NULLS FIRST`)
    .limit(MAX_ACCOUNT_ROUTING_TARGETS + 1);
  const live = sessions.filter((session) => session.ended_at === null);
  let session: (typeof sessions)[number] | undefined;
  if (live.length > 0) {
    const connections = live.length > 1
      ? (await getSessionConnections(tx, roomId, live.map((candidate) => candidate.session_id))).connected
      : new Set<string>();
    session = chooseAnsweringSession(live, connections);
  } else {
    session = sessions[0];
  }
  if (!session) return [];
  await insertMessageReceiptRows(tx, [{
    id: `rcpt_${randomUUID().replace(/-/g, "")}`,
    message_room_id: roomId,
    message_number: message.number,
    room_id: roomId,
    agent_session_id: session.session_id,
    agent_key: addressedTo.agent_key,
    actor_label: session.actor_label,
    activation_reason: addressedTo.reason,
    receipt_state: "queued",
    created_at: message.timestamp,
    updated_at: message.timestamp,
  }]);
  return [{
    agent_key: addressedTo.agent_key,
    agent_session_id: session.session_id,
    owner_account_id: session.owner_account_id,
  }];
}
