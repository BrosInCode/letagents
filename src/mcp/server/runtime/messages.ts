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

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function explicitThreadRootId(record: AgentReadableMessageRecord): string | null {
  const direct = normalizedString(record.thread_root_id) ?? normalizedString(record.threadRootId);
  if (direct) return direct;

  const thread = record.thread;
  if (!isRecord(thread)) return null;
  return (
    normalizedString(thread.root_message_id) ??
    normalizedString(thread.rootMessageId) ??
    normalizedString(thread.parent_id) ??
    normalizedString(thread.parentId)
  );
}

function effectiveThreadRootId(record: AgentReadableMessageRecord): string | null {
  return explicitThreadRootId(record) ?? messageId(record);
}

function isExplicitThreadReply(record: AgentReadableMessageRecord): boolean {
  const id = messageId(record);
  const rootId = explicitThreadRootId(record);
  return Boolean(id && rootId && rootId !== id);
}

function buildThreadSummaries(
  records: AgentReadableMessageRecord[],
): Map<string, ThreadSummary> {
  const summaries = new Map<string, ThreadSummary>();
  for (const record of records) {
    if (!isExplicitThreadReply(record)) continue;
    const parentId = effectiveThreadRootId(record);
    const id = messageId(record);
    if (!parentId || !id) continue;
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
  const parentId = effectiveThreadRootId(record);
  if (!parentId) {
    return record;
  }

  const isThreadReply = isExplicitThreadReply(record);
  const replyToId = isThreadReply ? replyReferenceId(record) : null;
  const summary = summaries.get(parentId) ?? { count: 0, latestReplyId: null };
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

export function toAgentReadableMessages(messages: unknown[] | undefined, contextMessages: unknown[] = []): unknown[] {
  const records = (messages ?? []).filter(isRecord);
  void contextMessages;
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
