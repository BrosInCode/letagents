import { normalizeAgentPromptKind } from "../../../shared/room-agent-prompts.js";
import { dispenseRoomAgentPrompt } from "../../agent-prompt-delivery.js";

export function getLastMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const messages = (payload as { messages?: Array<{ id?: string }> }).messages;
  const lastMessage = messages?.at(-1);
  return typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
}

export function withJoinRoomAgentPrompt(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    agent_prompt_kind: "join",
    agent_prompt: dispenseRoomAgentPrompt("join"),
  };
}

type AgentReadableMessageRecord = Record<string, unknown>;

type ThreadSummary = {
  count: number;
  latestReplyId: string | null;
};

function isRecord(value: unknown): value is AgentReadableMessageRecord {
  return Boolean(value && typeof value === "object");
}

function messageId(record: AgentReadableMessageRecord): string | null {
  return typeof record.id === "string" && record.id.trim() ? record.id : null;
}

function replyReference(record: AgentReadableMessageRecord): unknown {
  return record.reply_to ?? record.replyTo ?? null;
}

function replyReferenceId(record: AgentReadableMessageRecord): string | null {
  const reply = replyReference(record);
  if (typeof reply === "string" && reply.trim()) {
    return reply;
  }
  if (isRecord(reply) && typeof reply.id === "string" && reply.id.trim()) {
    return reply.id;
  }
  return null;
}

function resolveThreadParentId(
  record: AgentReadableMessageRecord,
  recordsById: Map<string, AgentReadableMessageRecord>,
): string | null {
  const ownId = messageId(record);
  const firstReplyId = replyReferenceId(record);
  if (!firstReplyId) {
    return ownId;
  }

  let parentId = firstReplyId;
  const seen = new Set<string>(ownId ? [ownId] : []);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = recordsById.get(parentId);
    const nextParentId = parent ? replyReferenceId(parent) : null;
    if (!nextParentId) break;
    parentId = nextParentId;
  }
  return parentId;
}

function explicitThreadRootId(record: AgentReadableMessageRecord): string | null {
  const root = record.thread_root_id ?? record.threadRootId;
  return typeof root === "string" && root.trim() ? root : null;
}

function explicitThreadReplyToId(record: AgentReadableMessageRecord): string | null {
  const replyTo = record.thread_reply_to_id ?? record.threadReplyToId;
  return typeof replyTo === "string" && replyTo.trim() ? replyTo : null;
}

// A message is a thread reply IFF it carries an explicit thread root that differs
// from its own id. `reply_to` alone is only a quote/chip reference, never proof of
// thread membership — so a bare quote-reply (explicit root === its own id) stays
// top-level. Records that carry NO explicit thread_root_id field at all (out-of-band
// or legacy payloads that never went through the message mappers) fall back to
// deriving the root from the reply_to chain so genuine threads still survive. The
// fallback keys on field ABSENCE, never on the value equalling the own id.
function resolveThreadRootId(
  record: AgentReadableMessageRecord,
  recordsById: Map<string, AgentReadableMessageRecord>,
): string | null {
  const explicitRoot = explicitThreadRootId(record);
  if (explicitRoot) {
    return explicitRoot;
  }
  return resolveThreadParentId(record, recordsById);
}

function buildThreadSummaries(
  records: AgentReadableMessageRecord[],
  recordsById: Map<string, AgentReadableMessageRecord>,
): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const record of records) {
    const id = messageId(record);
    const rootId = resolveThreadRootId(record, recordsById);
    // Only genuine thread replies (an explicit root different from the message
    // itself) accrue to a thread. A bare quote-reply roots at itself and must not
    // inflate the reply count of the message it quotes.
    if (!id || !rootId || rootId === id) continue;
    const current = summaries.get(rootId) ?? { count: 0, latestReplyId: null };
    summaries.set(rootId, {
      count: current.count + 1,
      latestReplyId: id,
    });
  }
  return summaries;
}

function withThreadMetadata(
  record: AgentReadableMessageRecord,
  recordsById: Map<string, AgentReadableMessageRecord>,
  summaries: Map<string, ThreadSummary>,
): AgentReadableMessageRecord {
  const ownId = messageId(record);
  const rootId = resolveThreadRootId(record, recordsById);
  if (!rootId) {
    return record;
  }

  // The quote/chip reference is preserved regardless of thread membership.
  const replyToId = explicitThreadReplyToId(record) ?? replyReferenceId(record);
  const isThreadReply = Boolean(ownId && rootId !== ownId);
  const summary = summaries.get(rootId) ?? { count: 0, latestReplyId: null };
  const {
    thread_parent_id: _threadParentId,
    thread_root_id: _threadRootId,
    threadRootId: _threadRootIdCamel,
    thread_reply_to_id: _threadReplyToId,
    threadReplyToId: _threadReplyToIdCamel,
    thread: _thread,
    ...baseRecord
  } = record;
  return {
    ...baseRecord,
    ...(isThreadReply
      ? {
        thread_parent_id: rootId,
        thread_root_id: rootId,
        thread_reply_to_id: replyToId,
      }
      : {}),
    thread: {
      parent_id: rootId,
      root_message_id: rootId,
      reply_to_id: replyToId,
      is_thread_reply: isThreadReply,
      reply_count_in_result: summary.count,
      latest_reply_id_in_result: summary.latestReplyId,
    },
  };
}

function toAgentReadableMessage(
  message: unknown,
  recordsById: Map<string, AgentReadableMessageRecord>,
  summaries: Map<string, ThreadSummary>,
): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const record = withThreadMetadata(message as AgentReadableMessageRecord, recordsById, summaries);
  const kind = normalizeAgentPromptKind(record.agent_prompt_kind);
  const text = typeof record.text === "string" ? record.text : null;

  if (!kind || text === null) {
    return record;
  }

  return {
    ...record,
    visible_text: text,
    agent_prompt: dispenseRoomAgentPrompt(kind),
    prompt_injected: kind === "inline",
  };
}

export function toAgentReadableMessages(messages: unknown[] | undefined, contextMessages: unknown[] = []): unknown[] {
  const records = (messages ?? []).filter(isRecord);
  const contextRecords = contextMessages.filter(isRecord);
  const recordsById = new Map<string, AgentReadableMessageRecord>();
  for (const record of [...contextRecords, ...records]) {
    const id = messageId(record);
    if (id) recordsById.set(id, record);
  }
  const summaries = buildThreadSummaries(records, recordsById);
  return (messages ?? []).map((message) => toAgentReadableMessage(message, recordsById, summaries));
}

export function appendIncludePromptOnly(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}include_prompt_only=1`;
}

export function normalizeOptionalToolString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
