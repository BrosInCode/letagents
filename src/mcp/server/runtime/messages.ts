import {
  buildRoomAgentPrompt,
  normalizeAgentPromptKind,
} from "../../../shared/room-agent-prompts.js";

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
    agent_prompt: buildRoomAgentPrompt("join"),
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

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function threadRecord(record: AgentReadableMessageRecord): AgentReadableMessageRecord | null {
  return isRecord(record.thread) ? record.thread : null;
}

function threadRootId(record: AgentReadableMessageRecord): string | null {
  const ownId = messageId(record);
  const thread = threadRecord(record);
  const fromThread = stringField(thread?.root_message_id) ?? stringField(thread?.parent_id);
  if (fromThread) {
    return fromThread;
  }
  const fromRecord = stringField(record.thread_parent_id) ?? stringField(record.thread_root_id);
  if (fromRecord && fromRecord !== ownId) {
    return fromRecord;
  }
  return null;
}

function threadReplyToId(record: AgentReadableMessageRecord): string | null {
  const thread = threadRecord(record);
  return stringField(record.thread_reply_to_id)
    ?? stringField(thread?.reply_to_id)
    ?? (threadRootId(record) ? replyReferenceId(record) : null);
}

function threadReplyCount(record: AgentReadableMessageRecord): number {
  const thread = threadRecord(record);
  return numberField(thread?.reply_count_in_result)
    ?? numberField(thread?.reply_count)
    ?? 0;
}

function threadLatestReplyId(record: AgentReadableMessageRecord): string | null {
  const thread = threadRecord(record);
  const direct = stringField(thread?.latest_reply_id_in_result);
  if (direct) return direct;
  const latestReply = thread?.latest_reply;
  return isRecord(latestReply) ? messageId(latestReply) : null;
}

function buildThreadSummaries(
  records: AgentReadableMessageRecord[],
): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const record of records) {
    const parentId = threadRootId(record);
    const id = messageId(record);
    if (!parentId || !id || parentId === id) continue;
    const current = summaries.get(parentId) ?? { count: 0, latestReplyId: null };
    summaries.set(parentId, {
      count: current.count + 1,
      latestReplyId: id,
    });
  }
  return summaries;
}

function withThreadMetadata(
  record: AgentReadableMessageRecord,
  summaries: Map<string, ThreadSummary>,
): AgentReadableMessageRecord {
  const ownId = messageId(record);
  const explicitParentId = threadRootId(record);
  const ownSummary = ownId ? summaries.get(ownId) : undefined;
  const parentId = explicitParentId ?? (ownSummary || threadReplyCount(record) > 0 ? ownId : null);
  if (!parentId) {
    const {
      thread: _thread,
      thread_parent_id: _threadParentId,
      thread_root_id: _threadRootId,
      thread_reply_to_id: _threadReplyToId,
      ...message
    } = record;
    return message;
  }

  const isThreadReply = Boolean(ownId && ownId !== parentId);
  const replyToId = isThreadReply ? threadReplyToId(record) : null;
  const summary = summaries.get(parentId) ?? {
    count: threadReplyCount(record),
    latestReplyId: threadLatestReplyId(record),
  };
  return {
    ...record,
    thread_parent_id: parentId,
    thread_root_id: parentId,
    thread_reply_to_id: replyToId,
    thread: {
      parent_id: parentId,
      root_message_id: parentId,
      reply_to_id: replyToId,
      is_thread_reply: isThreadReply,
      reply_count_in_result: summary.count,
      latest_reply_id_in_result: summary.latestReplyId,
    },
  };
}

function toAgentReadableMessage(
  message: unknown,
  summaries: Map<string, ThreadSummary>,
): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const record = withThreadMetadata(message as AgentReadableMessageRecord, summaries);
  const kind = normalizeAgentPromptKind(record.agent_prompt_kind);
  const text = typeof record.text === "string" ? record.text : null;

  if (!kind || text === null) {
    return record;
  }

  return {
    ...record,
    visible_text: text,
    agent_prompt: buildRoomAgentPrompt(kind),
    prompt_injected: kind === "inline",
  };
}

export function toAgentReadableMessages(messages: unknown[] | undefined): unknown[] {
  const records = (messages ?? []).filter(isRecord);
  const summaries = buildThreadSummaries(records);
  return (messages ?? []).map((message) => toAgentReadableMessage(message, summaries));
}

export function appendIncludePromptOnly(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}include_prompt_only=1`;
}

export function normalizeOptionalToolString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
