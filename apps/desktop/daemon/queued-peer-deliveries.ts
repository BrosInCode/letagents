import type { DatabaseSync } from "node:sqlite";
import { createGlobalAgentAddressResolver, isTaskOwnerFollowUpMessageText } from "../../../shared/activation-routing.mjs";
import { isLocalRoomApi } from "../../../shared/room-api-origin.mjs";
import { RoomWorkPublicationStore } from "./room-work-publication-store.js";
import { sameWorkerPublicationOrigin } from "./worker-publication-authority.js";
import type { SupervisedInboxItem } from "./supervised-agent-inbox-store.js";

const addresses = createGlobalAgentAddressResolver([]);
const canonicalId = (value: unknown): value is string => typeof value === "string"
  && /^msg_[1-9]\d{0,9}$/.test(value) && Number(value.slice(4)) <= 2147483647;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const MEMBERS = "peer_batch:members";
const ASSIGNED = "peer_batch_assigned:";
export const PEER_REPORT_PENDING = "peer_batch_report:pending";
export const PEER_REPORT_RESOLVED = "peer_batch_report:resolved";
/** Alias i. A pending remote receipt must survive bounded history retention. */
export const PENDING_PEER_REPORT_SQL = `EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
  WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='${PEER_REPORT_PENDING}')
  AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
  WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='${PEER_REPORT_RESOLVED}')`;
const MAX_MEMBERS = 16;
const MAX_BYTES = 32 * 1024;
export const QUEUED_PEERS_INSTRUCTION = "The following peer messages were already waiting in this thread. "
  + "They are assigned to this same turn together with the activating message, in conversation order; each keeps its author and full content. "
  + "Respond to the conversation in your own voice, with your own reasoning, proposals and disagreements. "
  + "You can address several contributions together without repeating earlier answers or writing a separate acknowledgment for each. "
  + "Do not treat the first speaker as a lead or other participants as reviewers. If nothing useful remains to add, use the normal no-reply outcome.";

export function hasFrozenPeerBatch(database: DatabaseSync, inboxItemId: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?")
    .get(inboxItemId, MEMBERS));
}

function event(database: DatabaseSync, id: string, key: string, phase: "queued" | "no_reply", timestamp: string, detail: string): void {
  database.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
    SELECT ?,COALESCE((SELECT MAX(event_sequence) FROM supervised_agent_inbox_events WHERE inbox_item_id=?),0)+1,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?)`)
    .run(id, id, key, phase, timestamp, detail, id, key);
}

/** Conservative eligibility: uncertain identities or dedicated instructions keep their own turn. */
export function ordinaryPeerThread(item: Pick<SupervisedInboxItem, "source_message_id" | "source_message" | "activation">): string | null {
  const message = record(item.source_message), activation = item.activation;
  const identity = record(message?.agent_identity), reply = record(message?.reply_to);
  const root = message?.thread_root_id ?? record(message?.thread)?.root_message_id;
  if (!canonicalId(item.source_message_id) || message?.id !== item.source_message_id || message.source !== "agent"
    || typeof identity?.agent_key !== "string" || !identity.agent_key.trim()
    || typeof identity.actor_label !== "string" || !identity.actor_label.trim()
    || !canonicalId(root) || typeof message.text !== "string" || message.agent_prompt_kind != null
    || activation.decision !== "activate" || activation.reason !== "thread_participant" || activation.turn != null
    || Object.keys(activation).some(key => key.startsWith("task_continuity"))
    || (reply && (reply.agent_identity != null || reply.source !== "browser"))
    || isTaskOwnerFollowUpMessageText(message.text)) return null;
  const addressed = addresses(message);
  return addressed.broadcast || addressed.hasMention || addressed.hasAgentMention ? null : root;
}

/** Caller owns the claim transaction; untouched is evaluated BEFORE changing the head state. */
export function freezeQueuedPeers(database: DatabaseSync, head: SupervisedInboxItem,
  rows: readonly (SupervisedInboxItem & { untouched: boolean })[], headUntouched: boolean, timestamp: string): Record<string, unknown> {
  // A retry must use the exact original assignment, never expand or reconstruct it.
  if (hasFrozenPeerBatch(database, head.inbox_item_id)) return head.activation;
  const { queued_peer_messages: _untrusted, queued_notices: _notices, ...activation } = head.activation;
  const root = headUntouched ? ordinaryPeerThread(head) : null;
  if (!root) return activation;
  const pins = new RoomWorkPublicationStore(database);
  const origin = pins.get(head.agent_id, head.room_id, head.source_message_id);
  if (!origin || isLocalRoomApi(origin.apiOrigin) || origin.revision !== 0 || origin.state !== "open") return activation;
  let previous = Number(head.source_message_id.slice(4));
  let bytes = Buffer.byteLength(JSON.stringify(head.source_message), "utf8");
  const members: SupervisedInboxItem[] = [];
  for (const item of rows) {
    if (!item.untouched || item.room_id !== head.room_id || ordinaryPeerThread(item) !== root
      || Number(item.source_message_id.slice(4)) !== previous + 1) break;
    const pin = pins.get(item.agent_id, item.room_id, item.source_message_id);
    if (!pin || pin.revision !== 0 || pin.state !== "open" || !sameWorkerPublicationOrigin(origin, pin)) break;
    const size = Buffer.byteLength(JSON.stringify({ source_message: item.source_message, activation: item.activation }), "utf8");
    if (bytes + size > MAX_BYTES || members.length >= MAX_MEMBERS) break;
    bytes += size;
    members.push(item);
    previous++;
  }
  if (!members.length) return activation;
  event(database, head.inbox_item_id, MEMBERS, "queued", timestamp, JSON.stringify(members.map(item => item.inbox_item_id)));
  for (const item of members) event(database, item.inbox_item_id, `${ASSIGNED}${head.inbox_item_id}`, "queued", timestamp, head.source_message_id);
  return { ...activation, queued_peer_messages: { instruction: QUEUED_PEERS_INSTRUCTION,
    messages: members.map(item => ({ source_message_id: item.source_message_id, source_message: item.source_message,
      activation: Object.fromEntries(Object.entries(item.activation).filter(([key]) => key !== "queued_peer_messages")) })) } };
}

/** Only a successful final parent settlement, never observed context or a native checkpoint, settles members. */
export function settleQueuedPeers(database: DatabaseSync, inboxItemId: string, timestamp: string): void {
  const completed = database.prepare(`SELECT i.agent_id,i.room_id,i.source_message_id FROM supervised_agent_inbox i
    JOIN supervised_agent_terminal_results t ON t.inbox_item_id=i.inbox_item_id AND t.agent_id=i.agent_id AND t.provider_turn_id=i.provider_turn_id
    JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id AND b.agent_id=i.agent_id
      AND b.room_id=i.room_id AND b.provider_turn_id=t.provider_turn_id AND b.origin_execution_generation_id=t.execution_generation_id
    WHERE i.inbox_item_id=? AND ((i.state='acknowledged' AND t.outcome='reply' AND EXISTS (
      SELECT 1 FROM supervised_agent_publications p WHERE p.inbox_item_id=i.inbox_item_id
        AND p.agent_id=i.agent_id AND p.room_id=i.room_id AND p.client_message_id=i.reply_client_message_id
        AND length(p.canonical_message_id)>0))
      OR (i.state='acknowledged_no_reply' AND t.outcome='no_reply'))`).get(inboxItemId);
  if (!completed) return;
  const saved = database.prepare("SELECT detail FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND idempotency_key=?")
    .get(inboxItemId, MEMBERS);
  if (!saved) return;
  const members = JSON.parse(String(saved.detail)) as string[];
  for (const id of members) {
    const child = database.prepare(`SELECT i.inbox_item_id FROM supervised_agent_inbox i
      WHERE i.inbox_item_id=? AND i.agent_id=? AND i.room_id=? AND i.state='pending' AND i.attempt_count=0
        AND i.provider_turn_id IS NULL AND i.outcome IS NULL
        AND EXISTS (SELECT 1 FROM supervised_agent_inbox_events e WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key=?)
        AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b WHERE b.inbox_item_id=i.inbox_item_id)
        AND NOT EXISTS (SELECT 1 FROM turn_control_journals j WHERE j.inbox_item_id=i.inbox_item_id)`)
      .get(id, String(completed.agent_id), String(completed.room_id), `${ASSIGNED}${inboxItemId}`);
    if (!child) continue;
    const detail = `Delivered in the same turn as ${String(completed.source_message_id)}; no separate native turn.`;
    database.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',last_error=?,updated_at=?,acknowledged_at=?
      WHERE inbox_item_id=?`).run(detail, timestamp, timestamp, id);
    event(database, id, PEER_REPORT_PENDING, "no_reply", timestamp, detail);
  }
}

export type PeerReceiptResult = "no_reply" | "replied" | "cancelled";
export function resolvePeerReceipt(database: DatabaseSync, inboxItemId: string, result: PeerReceiptResult, timestamp: string): void {
  if (!["no_reply", "replied", "cancelled"].includes(result)) throw new Error("Invalid grouped receipt result.");
  const row = database.prepare(`SELECT 1 FROM supervised_agent_inbox i WHERE i.inbox_item_id=?
    AND i.state='acknowledged_no_reply' AND ${PENDING_PEER_REPORT_SQL}`).get(inboxItemId);
  if (row) event(database, inboxItemId, PEER_REPORT_RESOLVED, "no_reply", timestamp, `Remote receipt: ${result}.`);
}
