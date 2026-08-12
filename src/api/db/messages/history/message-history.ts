import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../client.js";
import { message_attachments, messages } from "../../schema.js";
import {
  toMessageAttachment,
  toMessageReplyReference,
  toMessageWithReply,
} from "../../mappers.js";
import type {
  Message,
  MessageAttachment,
  MessageReplyReference,
  MessageRow,
  MessageThreadSummary,
} from "../../types.js";
import { clampLimit, parseScopedId } from "../../utils.js";
import {
  getMessageAccountAgentRouting,
} from "../account-agent-routing.js";
import {
  messageAttachmentSelection,
  messageReplySelection,
  messageRowSelection,
} from "../selections.js";
import { visibleMessageCondition } from "../visibility.js";
import {
  buildEmptyThreadSummariesForRoots,
  buildThreadSummariesForRoots,
} from "./thread-summaries.js";

interface MessageHydrationOptions {
  accountId?: string | null;
  accountAgentRouting?: boolean;
  threadSummaries?: ReadonlyMap<number, MessageThreadSummary>;
}

type MessageHistoryOptions = {
  limit?: number;
  after?: string;
  include_prompt_only?: boolean;
  account_id?: string | null;
  account_agent_routing?: boolean;
};

export async function getMessages(
  roomId: string,
  options?: MessageHistoryOptions,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "msg") : null;
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(
      afterNumber
        ? and(eq(messages.room_id, roomId), sql`${messages.number} > ${afterNumber}`, visibilityCondition)
        : and(eq(messages.room_id, roomId), visibilityCondition),
    )
    .orderBy(asc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getLatestMessages(
  roomId: string,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessagesBefore(
  roomId: string,
  beforeMessageId: string | undefined,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const beforeNumber = beforeMessageId ? parseScopedId(beforeMessageId, "msg") : null;
  if (!beforeNumber) {
    return getLatestMessages(roomId, options);
  }

  const limit = clampLimit(options?.limit);
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`${messages.number} < ${beforeNumber}`, visibilityCondition))
    .orderBy(desc(messages.number))
    .limit(limit + 1);

  const has_more = rows.length > limit;
  const bounded = (has_more ? rows.slice(0, limit) : rows).reverse();
  const hydratedMessages = await hydrateMessageReplies(roomId, bounded, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });

  return {
    messages: hydratedMessages,
    has_more,
  };
}

export async function getMessageById(
  roomId: string,
  messageId: string,
  options?: {
    include_prompt_only?: boolean;
    account_id?: string | null;
    account_agent_routing?: boolean;
  },
): Promise<Message | null> {
  const messageNumber = parseScopedId(messageId, "msg");
  if (!messageNumber) {
    return null;
  }
  const visibilityCondition = visibleMessageCondition(options?.include_prompt_only);

  const rows = await db
    .select(messageRowSelection)
    .from(messages)
    .where(and(eq(messages.room_id, roomId), eq(messages.number, messageNumber), visibilityCondition))
    .limit(1);
  if (rows.length === 0) {
    return null;
  }

  const [hydrated] = await hydrateMessageReplies(roomId, rows, {
    accountId: options?.account_id,
    accountAgentRouting: options?.account_agent_routing,
  });
  return hydrated ?? null;
}

export async function hydrateMessageReplies(
  roomId: string,
  bounded: MessageRow[],
  options?: MessageHydrationOptions,
): Promise<Message[]> {
  const accountRoutingPromise = options?.accountId && options.accountAgentRouting
    ? getMessageAccountAgentRouting(db, roomId, options.accountId, bounded)
    : Promise.resolve(new Map());
  const replyToNumbers = Array.from(new Set(
    bounded
      .map((row) => row.reply_to_number)
      .filter((value): value is number => value !== null),
  ));

  const replyMap = new Map<number, MessageReplyReference>();
  if (replyToNumbers.length > 0) {
    const replyRows = await db
      .select(messageReplySelection)
      .from(messages)
      .where(and(eq(messages.room_id, roomId), inArray(messages.number, replyToNumbers)));

    for (const replyRow of replyRows) {
      replyMap.set(replyRow.number, toMessageReplyReference(replyRow));
    }
  }

  const messageNumbers = bounded.map((row) => row.number);
  const attachmentMap = new Map<number, MessageAttachment[]>();
  if (messageNumbers.length > 0) {
    const attachmentRows = await db
      .select(messageAttachmentSelection)
      .from(message_attachments)
      .where(
        and(
          eq(message_attachments.room_id, roomId),
          inArray(message_attachments.message_number, messageNumbers),
        ),
      )
      .orderBy(asc(message_attachments.message_number), asc(message_attachments.attachment_number));

    for (const attachmentRow of attachmentRows) {
      const list = attachmentMap.get(attachmentRow.message_number) ?? [];
      list.push(toMessageAttachment(attachmentRow));
      attachmentMap.set(attachmentRow.message_number, list);
    }
  }

  const materializedSummaries = options?.threadSummaries ?? await buildThreadSummariesForRoots(
    roomId,
    Array.from(new Set(bounded.map((row) => row.thread_root_number ?? row.number))),
    options?.accountId ?? null,
  );
  const threadSummaries = new Map(materializedSummaries);
  const missingThreadRootNumbers = Array.from(new Set(
    bounded
      .filter((row) => row.thread_root_number !== null)
      .map((row) => row.thread_root_number!)
      .filter((rootNumber) => !threadSummaries.has(rootNumber)),
  ));
  if (missingThreadRootNumbers.length > 0) {
    const emptySummaries = await buildEmptyThreadSummariesForRoots(
      roomId,
      missingThreadRootNumbers,
      options?.accountId ?? null,
    );
    for (const [rootNumber, summary] of emptySummaries) {
      threadSummaries.set(rootNumber, summary);
    }
  }

  const accountRouting = await accountRoutingPromise;
  return bounded.map((row) => {
    const threadRootNumber = row.thread_root_number ?? row.number;
    const threadSummary = threadSummaries.get(threadRootNumber) ?? null;
    const message = toMessageWithReply(
      row,
      row.reply_to_number ? replyMap.get(row.reply_to_number) ?? null : null,
      attachmentMap.get(row.number) ?? [],
      threadSummary && (threadSummary.reply_count > 0 || row.thread_root_number) ? threadSummary : null,
    );
    return options?.accountId && options.accountAgentRouting
      ? { ...message, account_agent_routing: accountRouting.get(row.number) ?? null }
      : message;
  });
}

export async function getMessagesAfter(
  roomId: string,
  afterMessageId: string | undefined,
  options?: Omit<MessageHistoryOptions, "after">,
): Promise<{ messages: Message[]; has_more: boolean }> {
  return getMessages(roomId, { ...options, after: afterMessageId });
}
