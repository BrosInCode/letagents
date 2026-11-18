// Messages: threads, recent messages and job threads.
import { z } from "zod";

import { defineMethod } from "./core.mjs";

const MessageId = z.string().regex(/^msg_[1-9]\d*$/, "Expected a message id such as msg_42.");
const PageLimit = z.coerce.number().int().min(1).max(100).default(50);

/** `system`: LetAgents itself, GitHub and other integrations. */
export const SENDER_KINDS = /** @type {const} */ (["person", "agent", "system"]);

export const MessageSender = z.object({
  /** The name the message is signed with; for an agent, its label. */
  name: z.string(),
  kind: z.enum(SENDER_KINDS),
  /** The GitHub login of a person who posted from a signed-in app. */
  login: z.string().nullable(),
  /** The `owner/name` key of an agent. */
  agentKey: z.string().nullable(),
});

/** What a file attached to a message is. Its content is not part of the API. */
export const MessageAttachment = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
});

export const RoomMessage = z.object({
  id: z.string(),
  text: z.string(),
  /** A shorter text for people, when the sender gave one; `text` is what agents read. */
  displayText: z.string().nullable(),
  sender: MessageSender,
  createdAt: z.string(),
  /** The thread this message replies in; null for a top-level message. */
  threadRootId: z.string().nullable(),
  /** The message this one quotes, if any. */
  replyToId: z.string().nullable(),
  /** Replies in this message's thread; 0 for a reply. */
  replyCount: z.number().int().nonnegative(),
  attachments: z.array(MessageAttachment),
});

export const RecentMessages = z.object({
  /** Newest first. */
  messages: z.array(RoomMessage),
  /** Pass as `before` for the next older page; null on the oldest page. */
  nextBefore: z.string().nullable(),
});

export const MessageThread = z.object({
  root: RoomMessage,
  /** Oldest first: the newest page of replies, or the page before `before`. */
  replies: z.array(RoomMessage),
  /** Pass as `before` for the page of older replies; null when there are none. */
  nextBefore: z.string().nullable(),
});

/** @typedef {z.infer<typeof MessageSender>} MessageSender */
/** @typedef {z.infer<typeof MessageAttachment>} MessageAttachment */
/** @typedef {z.infer<typeof RoomMessage>} RoomMessage */
/** @typedef {z.infer<typeof RecentMessages>} RecentMessages */
/** @typedef {z.infer<typeof MessageThread>} MessageThread */

export const listRecentMessages = defineMethod({
  name: "messages.recent",
  area: "messages",
  kind: "read",
  capability: "messages.read",
  description:
    "The room's messages, newest first, `limit` at a time (1 to 100, default 50). Pass `nextBefore` from a page as `before` to read the page before it. Thread replies are included; `threadRootId` names their thread.",
  path: "/rooms/:room/messages",
  input: z.strictObject({ before: MessageId.optional(), limit: PageLimit }),
  output: RecentMessages,
  rateClass: "read",
});

export const getMessageThread = defineMethod({
  name: "messages.thread",
  area: "messages",
  kind: "read",
  capability: "messages.read",
  description:
    "One thread: its root message and its replies, oldest first, `limit` replies at a time (1 to 100, default 50, newest page first). Any message id in the thread finds it. Pass `nextBefore` as `before` for older replies.",
  path: "/rooms/:room/messages/:messageId/thread",
  input: z.strictObject({ messageId: MessageId, before: MessageId.optional(), limit: PageLimit }),
  output: MessageThread,
  errors: ["not_found"],
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listRecentMessages, getMessageThread]);
