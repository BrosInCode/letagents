import { MESSAGE_ATTACHMENT_LIMITS } from "../../../../../shared/message-attachments.mjs";
import type { RoomGif } from "../../../../../shared/room-expressions.mjs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  agentSessionCredentials,
  addLocalChatMessage,
  appendIncludePromptOnly,
  getCurrentRoom,
  getFallbackProjectId,
  getLocalChatMessages,
  getRememberedRoomPresence,
  getTargetRoomId,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toPublicAgentIdentity,
  touchCurrentRoom,
} from "../../runtime.js";
import {
  assertMessageFileAttachmentsAvailable,
  discardMessageAttachments,
  localRoomAttachmentError,
  readMessageAttachmentFiles,
  stageMessageAttachments,
} from "../../runtime/message-attachments.js";
import { findLocalMessageById, findRemoteMessageById } from "./message-lookup.js";
import { jsonToolResponse } from "./response.js";

type MessageRecord = Record<string, unknown>;

type SendMessageInput = {
  room_id?: string;
  text: string;
  gif?: RoomGif | null;
  reply_to?: string;
  thread_parent_id?: string;
  agent_session_id?: string;
  attachments?: string[];
};

type AgentSessionCredentialPayload = Record<string, string>;

export function buildSendMessageRequestBody(input: {
  sender: string;
  text: string;
  gif?: RoomGif | null;
  replyTarget?: string;
  resolvedThreadRoot?: string;
  uploadIds?: readonly string[];
  credentials: AgentSessionCredentialPayload;
}): Record<string, unknown> {
  return {
    sender: input.sender,
    text: input.text,
    ...(input.gif ? { gif: input.gif } : {}),
    ...(input.uploadIds?.length ? { attachments: input.uploadIds.map((upload_id) => ({ upload_id })) } : {}),
    reply_to: input.replyTarget,
    ...(input.resolvedThreadRoot ? { thread_root_id: input.resolvedThreadRoot } : {}),
    ...input.credentials,
  };
}

/** Only a registration that offers the field passes it on; anything else never reaches the file reader. */
function fileAttachmentsInput(options: { fileAttachments?: boolean }, rest: Record<string, unknown>): { attachments?: string[] } {
  return options.fileAttachments && Array.isArray(rest.attachments) ? { attachments: rest.attachments as string[] } : {};
}

function normalizeMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function explicitThreadRootId(message: MessageRecord | null): string | null {
  const root = message?.thread_root_id ?? message?.threadRootId;
  if (typeof root === "string" && root.trim()) {
    return root;
  }
  return null;
}

async function findMessageById(input: {
  localRoomId: string | null;
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<MessageRecord | null> {
  if (input.localRoomId && await isLocalRoomStorageEnabled(input.localRoomId)) {
    const { localRoomId } = await resolveLocalRoomStorageIdentifiers(input.localRoomId);
    return findLocalMessageById(localRoomId || input.localRoomId, input.messageId);
  }
  return findRemoteMessageById({
    roomId: input.roomId,
    projectId: input.projectId,
    messageId: input.messageId,
  });
}

// Resolve the thread root for a send_thread_message target by reading the target's
// explicit thread_root_id (the authoritative root the message mappers already
// populate) instead of walking reply_to. This roots a reply AT a top-level
// quote-reply X (X.thread_root_id === X.id) rather than under the message X quoted.
// When the target carries no explicit root (not found / hidden / out-of-band), treat
// it as its own root — matching the prior lenient behavior, so the create-side
// existence checks fail the same way rather than newly rejecting a valid reply.
async function resolveThreadRootMessageId(input: {
  localRoomId: string | null;
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<string> {
  const message = await findMessageById(input);
  return explicitThreadRootId(message) ?? input.messageId;
}

function initialReplyTarget(input: SendMessageInput): {
  replyTarget: string | undefined;
  shouldResolveThreadRoot: boolean;
} {
  const replyTo = normalizeMessageId(input.reply_to);
  const threadParentId = normalizeMessageId(input.thread_parent_id);
  if (replyTo && threadParentId && replyTo !== threadParentId) {
    throw new Error("reply_to and thread_parent_id must match when both are provided.");
  }
  return {
    replyTarget: threadParentId || replyTo,
    shouldResolveThreadRoot: Boolean(threadParentId),
  };
}

async function sendMessageFromTool(input: SendMessageInput): Promise<ReturnType<typeof jsonToolResponse>> {
  const targetRoomId = getTargetRoomId(input.room_id);
  const targetProjectId = getFallbackProjectId();
  if (!targetRoomId && !targetProjectId) {
    throw new Error("No room is currently selected. Join a room first or pass room_id.");
  }
  const localRoomId = targetRoomId ?? getCurrentRoom()?.room_id ?? targetProjectId;
  if (input.attachments) {
    assertMessageFileAttachmentsAvailable();
    if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) throw localRoomAttachmentError();
  }

  const { identity, agentSession } = await resolveWorkerToolIdentity({
    roomId: targetRoomId ?? getCurrentRoom()?.room_id ?? null,
    agentSessionId: input.agent_session_id,
  });
  const { replyTarget, shouldResolveThreadRoot } = initialReplyTarget(input);
  // The quote/chip reference stays the literal target the caller pointed at; the
  // thread root is resolved separately from that target's explicit thread_root_id,
  // so a reply to a top-level quote-reply roots at it rather than under what it quoted.
  const resolvedThreadRoot = replyTarget && shouldResolveThreadRoot
    ? await resolveThreadRootMessageId({
      localRoomId,
      roomId: targetRoomId,
      projectId: targetProjectId,
      messageId: replyTarget,
    })
    : undefined;

  if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    if (input.gif) throw new Error("GIFs require a cloud room.");
    const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
    const message = await addLocalChatMessage(sqliteRoomId || localRoomId, {
      sender: identity.actor_label,
      text: input.text,
      reply_to: replyTarget,
      ...(resolvedThreadRoot ? { thread_root_id: resolvedThreadRoot } : {}),
      source: "agent",
      publisher_agent_key: agentSession?.agent_key ?? null,
      publisher_agent_session_id: agentSession?.session_id ?? null,
    });
    touchCurrentRoom();
    return jsonToolResponse({
      ...message,
      agent_identity: toPublicAgentIdentity(identity),
    });
  }

  // Every file is read and staged before the message is posted, with the same
  // credential, and a refused file posts nothing.
  if (input.attachments && !targetRoomId) {
    throw new Error("Attachments need a room. Join one with join_room, or pass room_id. Nothing was posted.");
  }
  const staged = input.attachments && targetRoomId
    ? await stageMessageAttachments(targetRoomId, await readMessageAttachmentFiles(input.attachments))
    : [];
  let message: Record<string, unknown>;
  try {
    message = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      // The project route cannot take attachments, so a send with files never falls back to it.
      project_id: staged.length ? null : targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      options: {
        method: "POST",
        body: JSON.stringify(buildSendMessageRequestBody({
          sender: identity.actor_label,
          text: input.text,
          ...(input.gif ? { gif: input.gif } : {}),
          replyTarget,
          resolvedThreadRoot,
          uploadIds: staged.map((file) => file.uploadId),
          credentials: agentSessionCredentials(agentSession),
        })),
      },
    });
  } catch (error) {
    if (staged.length && targetRoomId) await discardMessageAttachments(targetRoomId, staged);
    throw error;
  }
  touchCurrentRoom();
  await syncRoomPresence(
    targetRoomId ?? getCurrentRoom()?.room_id ?? null,
    identity,
    getRememberedRoomPresence(targetRoomId ?? getCurrentRoom()?.room_id ?? null, identity),
    agentSession
  );

  // The `replied` receipt transition is server-owned: message creation marks
  // the publisher's receipt on the reply target atomically with the reply
  // itself, for MCP workers and supervised daemon publications alike.

  return jsonToolResponse({
    ...message,
    agent_identity: toPublicAgentIdentity(identity),
  });
}

const attachmentsInput = z
  .array(z.string().min(1).max(4096).regex(/^[^\u0000]+$/))
  .min(1)
  .max(MESSAGE_ATTACHMENT_LIMITS.maxFiles)
  .optional()
  .describe("Optional files to attach: 1 to 4 paths inside your project folder, absolute or relative to this MCP server's working folder. Up to 25 MB each and 100 MB together. Files that may hold credentials (.env, keys, .git and similar) are refused. If any file is refused, nothing is posted. A single self-contained .html file opens in the LetAgents desktop app as an interactive demo in a locked window that cannot load anything over the network: put all CSS, JavaScript and images (as data: URLs) inside the file.");

export function registerSendMessageTool(server: McpServer, options: { fileAttachments?: boolean } = {}): void {
  const attachments: Record<string, typeof attachmentsInput> = options.fileAttachments ? { attachments: attachmentsInput } : {};
  server.tool(
    "send_message",
    "Send a message to a Let Agents Chat room. For focused side discussion, prefer send_thread_message or pass thread_parent_id so the reply stays in that message thread instead of polluting the main room.",
    {
      gif: z.object({ provider: z.literal("giphy"), id: z.string().regex(/^[a-zA-Z0-9]{1,128}$/), title: z.string().max(200) }).optional().describe("Optional GIF from search_gifs; use sparingly. If unavailable, continue with text."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      sender: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      text: z.string().describe("The message text to send"),
      reply_to: z
        .string()
        .optional()
        .describe("Optional legacy quote-reply message id. For thread continuation, prefer thread_parent_id or send_thread_message."),
      thread_parent_id: z
        .string()
        .optional()
        .describe("Optional thread parent/root message id. If this points at a reply inside a thread, the tool resolves it to the root where possible."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this message. Required for worker messages."),
      ...attachments,
    },
    async ({ room_id, sender: _sender, text, gif, reply_to, thread_parent_id, conversation_id: _conversation_id, agent_session_id, ...rest }) =>
      sendMessageFromTool({ room_id, text, gif, reply_to, thread_parent_id, agent_session_id, ...fileAttachmentsInput(options, rest) })
  );

  server.tool(
    "send_thread_message",
    "Reply inside an existing message thread without posting a top-level room message. Use this when discussion should drill into one topic and keep the main room clean.",
    {
      gif: z.object({ provider: z.literal("giphy"), id: z.string().regex(/^[a-zA-Z0-9]{1,128}$/), title: z.string().max(200) }).optional().describe("Optional GIF from search_gifs; use sparingly. If unavailable, continue with text."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      text: z.string().describe("The thread reply text to send."),
      thread_parent_id: z
        .string()
        .describe("Thread parent/root message id. You may pass any message id from the thread; the tool resolves replies to the root where possible."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this thread reply. Required for worker messages."),
      ...attachments,
    },
    async ({ room_id, text, gif, thread_parent_id, conversation_id: _conversation_id, agent_session_id, ...rest }) =>
      sendMessageFromTool({ room_id, text, gif, thread_parent_id, agent_session_id, ...fileAttachmentsInput(options, rest) })
  );
}
