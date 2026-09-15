import { createGlobalAgentAddressResolver, decideAgentMessageActivation, humanConversationFallback } from "./activation-routing.mjs";
import { readProjectedLocalThreadRoutingAgentKeys, ensureRequestedRootsProjected, runLocalSqliteWriteTransactionAsync, LocalThreadRoutingProjectionChangedError } from "./sqlite-thread-routing.mjs";
import { parseSupervisedReplySourceNumber } from "./message-contracts.mjs";
export function ensureLocalSupervisedRoutingSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_supervisor_message_routes (
    room_id TEXT NOT NULL, message_id TEXT NOT NULL, routes_json TEXT NOT NULL,
    PRIMARY KEY(room_id, message_id)
  ) STRICT`);
}
function recentRecipient(db, message) {
    const recent = db.prepare(`SELECT * FROM local_chat_messages WHERE room_id=? AND number<?
    ORDER BY number DESC LIMIT 50`).all(message.room_id, message.number)
        .filter(row => Date.parse(String(row.timestamp)) >= Date.parse(message.timestamp) - 30 * 60_000);
    const human = recent.find(row => row.source === "browser" && !row.publisher_agent_key
        && row.control_authorized === 1 && row.thread_root_number === null);
    if (!human)
        return null;
    const captured = db.prepare("SELECT routes_json FROM local_supervisor_message_routes WHERE room_id=? AND message_id=?")
        .get(message.room_id, `msg_${human.number}`);
    if (!captured)
        return null;
    const recipients = Object.entries(JSON.parse(String(captured.routes_json)))
        .filter(([, route]) => route.decision === "activate").map(([key]) => key);
    if (recipients.length === 1)
        return recipients[0];
    const answered = new Set();
    for (const reply of recent) {
        const key = String(reply.publisher_agent_key || "");
        const prefix = `local-supervised:${key}:`;
        const receipt = String(reply.sync_key || "");
        if (reply.source === "agent" && Number(reply.number) > Number(human.number)
            && recipients.includes(key) && (reply.reply_to_number === human.number
            || (receipt.startsWith(prefix)
                && parseSupervisedReplySourceNumber(receipt.slice(prefix.length)) === human.number)))
            answered.add(key);
    }
    return answered.size === 1 ? [...answered][0] : null;
}
/** Capture all recipients atomically with the message, including the empty-room case. */
export function captureLocalSupervisedRouting(db, row) {
    const reply = row.reply_to_number ? db.prepare("SELECT * FROM local_chat_messages WHERE room_id=? AND number=?")
        .get(row.room_id, row.reply_to_number) : null;
    const registered = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_supervisor_grants'").get();
    const identities = registered
        ? db.prepare("SELECT agent_key,display_name FROM local_supervisor_grants WHERE room_id=? AND revoked_at IS NULL ORDER BY entry_id")
            .all(row.room_id).map(grant => ({ agent_key: String(grant.agent_key), display_name: String(grant.display_name),
            actor_label: String(grant.display_name), agent_instance_id: null, agent_session_id: null, session_kind: "worker" })) : [];
    const id = `msg_${row.number}`;
    const rootId = `msg_${row.thread_root_number ?? row.number}`;
    const threadReply = row.thread_root_number !== null && row.thread_root_number !== row.number;
    const message = { id, text: row.text, sender: row.sender, source: row.source,
        thread_root_id: threadReply ? rootId : null, reply_to: reply ? { id: `msg_${reply.number}`, sender: reply.sender } : null };
    const address = createGlobalAgentAddressResolver(identities)(message);
    const participants = threadReply ? readProjectedLocalThreadRoutingAgentKeys(db, row.room_id, [row.thread_root_number], identities.map(identity => ({ agentKey: identity.agent_key, displayName: identity.display_name, actorLabel: identity.actor_label })))
        .get(row.thread_root_number) ?? new Set() : new Set();
    const fallback = humanConversationFallback({ source: row.source,
        publisherAccountId: row.control_authorized === 1 ? "local-owner" : null, publisherAgentKey: row.publisher_agent_key,
        explicitlyAddressed: address.broadcast || address.hasAgentMention || threadReply || Boolean(reply),
        registeredAgentKeys: identities.map(identity => identity.agent_key),
        recentAgentKey: identities.length > 2 ? recentRecipient(db, row) : null });
    const routes = {};
    for (const identity of identities) {
        const key = identity.agent_key;
        let decision = decideAgentMessageActivation(message, identity, {
            selfMessageIds: new Set(row.source === "agent" && row.publisher_agent_key === key ? [id] : []),
            explicitMentionMessageIds: new Set(address.explicitMentionKeys.has(key) ? [id] : []),
            replyTargetMessageIds: new Set(!threadReply && (reply?.publisher_agent_key
                ? reply.publisher_agent_key === key : address.replyTargetKeys.has(key)) ? [id] : []),
            threadParticipantRootIds: new Set(participants.has(key) ? [rootId] : []),
        });
        if (row.source === "agent" && !row.publisher_agent_key)
            decision = { decision: "silent", reason: "unaddressed", addressed: false };
        if (decision.reason === "unaddressed" && fallback?.agentKeys.includes(key)) {
            decision = { decision: "activate", reason: fallback.reason, addressed: true };
        }
        routes[key] = decision;
    }
    db.prepare("INSERT INTO local_supervisor_message_routes(room_id,message_id,routes_json) VALUES(?,?,?)")
        .run(row.room_id, id, JSON.stringify(routes));
}

/** Repair outside the write lock; a concurrent invalidation rolls back the entire send. */
export async function runLocalSupervisedMessageWrite(db, roomId, threadRootNumber, work) {
  const deadline = performance.now() + 2_000;
  for (;;) {
    if (threadRootNumber) await ensureRequestedRootsProjected(db, roomId, [threadRootNumber]);
    try {
      return await runLocalSqliteWriteTransactionAsync(db, work);
    } catch (error) {
      if (!(error instanceof LocalThreadRoutingProjectionChangedError) || performance.now() >= deadline) throw error;
    }
  }
}
