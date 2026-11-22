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
  assertMessageFileContentsAvailable,
  discardMessageAttachments,
  readMessageFileContents,
  type MessageFileContent,
  localRoomAttachmentError,
  readMessageAttachmentFiles,
  stageMessageAttachments,
} from "../../runtime/message-attachments.js";
import { ApiError } from "../../runtime/api.js";
import {
  getDaemonToolExecutionContext,
  markMutationRejectedBeforeCommit,
  markPreDispatchError,
} from "../../runtime/daemon-tool-context.js";
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
  files?: MessageFileContent[];
};

type AgentSessionCredentialPayload = Record<string, string>;

export function buildSendMessageRequestBody(input: {
  sender: string;
  text: string;
  gif?: RoomGif | null;
  replyTarget?: string;
  resolvedThreadRoot?: string;
  uploadIds?: readonly string[];
  clientMessageId?: string;
  credentials: AgentSessionCredentialPayload;
}): Record<string, unknown> {
  return {
    sender: input.sender,
    text: input.text,
    ...(input.gif ? { gif: input.gif } : {}),
    ...(input.uploadIds?.length ? { attachments: input.uploadIds.map((upload_id) => ({ upload_id })) } : {}),
    reply_to: input.replyTarget,
    ...(input.resolvedThreadRoot ? { thread_root_id: input.resolvedThreadRoot } : {}),
    ...(input.clientMessageId ? { client_message_id: input.clientMessageId } : {}),
    ...input.credentials,
  };
}

function boundedEffectClientMessageId(): string | undefined {
  const effectId = getDaemonToolExecutionContext()?.effectId?.trim();
  if (!effectId) return undefined;
  return `bounded-effect:${effectId}`.slice(0, 240);
}

/** Only a registration that offers the field passes it on; anything else never reaches the file reader. */
function fileAttachmentsInput(options: SendToolOptions, rest: Record<string, unknown>): { attachments?: string[]; files?: MessageFileContent[] } {
  return {
    ...(options.fileAttachments && Array.isArray(rest.attachments) ? { attachments: rest.attachments as string[] } : {}),
    ...(options.fileContents && Array.isArray(rest.files) ? { files: rest.files as MessageFileContent[] } : {}),
  };
}

type SendToolOptions = { fileAttachments?: boolean; fileContents?: boolean };

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
    throw markPreDispatchError(new Error("reply_to and thread_parent_id must match when both are provided."));
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
    throw markPreDispatchError(new Error("No room is currently selected. Join a room first or pass room_id."));
  }
  const localRoomId = targetRoomId ?? getCurrentRoom()?.room_id ?? targetProjectId;
  try {
    if (input.attachments) assertMessageFileAttachmentsAvailable();
    if (input.files) assertMessageFileContentsAvailable();
  } catch (error) {
    if (error instanceof Error) throw markPreDispatchError(error);
    throw error;
  }
  if ((input.attachments || input.files) && localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    throw markPreDispatchError(localRoomAttachmentError());
  }
  if ((input.attachments?.length ?? 0) + (input.files?.length ?? 0) > MESSAGE_ATTACHMENT_LIMITS.maxFiles) {
    throw markPreDispatchError(new Error(`Attach at most ${MESSAGE_ATTACHMENT_LIMITS.maxFiles} files to one message (attachments and files together). Nothing was posted.`));
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
    if (input.gif) throw markPreDispatchError(new Error("GIFs require a cloud room."));
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
  if ((input.attachments || input.files) && !targetRoomId) {
    throw markPreDispatchError(new Error("Attachments need a room. Join one with join_room, or pass room_id. Nothing was posted."));
  }
  // Files from the workspace and files given as content: all read and checked before any upload.
  let fromWorkspace: Awaited<ReturnType<typeof readMessageAttachmentFiles>>;
  let given: ReturnType<typeof readMessageFileContents>;
  try {
    fromWorkspace = input.attachments && targetRoomId ? await readMessageAttachmentFiles(input.attachments) : [];
    given = input.files && targetRoomId
      ? readMessageFileContents(input.files, fromWorkspace.reduce((sum, file) => sum + file.bytes.byteLength, 0))
      : [];
  } catch (error) {
    if (error instanceof Error) throw markPreDispatchError(error);
    throw error;
  }
  const staged = targetRoomId && (fromWorkspace.length || given.length)
    ? await stageMessageAttachments(targetRoomId, [...fromWorkspace, ...given])
    : [];
  const clientMessageId = boundedEffectClientMessageId();
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
          ...(clientMessageId ? { clientMessageId } : {}),
          credentials: agentSessionCredentials(agentSession),
        })),
      },
    });
  } catch (error) {
    if (staged.length && targetRoomId) {
      try {
        await discardMessageAttachments(targetRoomId, staged);
      } catch {
        // Best-effort cleanup of staged uploads; preserve the primary send error.
      }
    }
    if (error instanceof ApiError
      && Number.isInteger(error.status)
      && error.status >= 400
      && error.status < 500
      && error.status !== 408) {
      throw markMutationRejectedBeforeCommit(error);
    }
    throw error;
  }
  touchCurrentRoom();
  // Presence is an ancillary post-commit update. Its failure (e.g. HTTP 403 or
  // transient error) must never erase a committed message receipt or cause a
  // caller to retry and duplicate the posted message.
  try {
    await syncRoomPresence(
      targetRoomId ?? getCurrentRoom()?.room_id ?? null,
      identity,
      getRememberedRoomPresence(targetRoomId ?? getCurrentRoom()?.room_id ?? null, identity),
      agentSession
    );
  } catch {
    // Preserve the committed message receipt even when presence sync fails.
  }

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
  .describe("Optional files to attach: 1 to 4 paths inside your project folder, absolute or relative to this MCP server's working folder. Up to 25 MB each and 100 MB together. Files that may hold credentials (.env, keys, .git and similar) are refused. If any file is refused, nothing is posted. A single self-contained .html file runs inside the room message in the LetAgents desktop app as a locked demo with no network: put all CSS, JavaScript and images (as data: URLs) in the file, keep it under about 560 px tall, and support light and dark mode. Dialogs, pop-ups, forms and printing do not work there.");

const filesInput = z
  .array(z.object({
    name: z.string().min(1).max(255).describe("The file's name, with its extension, for example \"pricing-demo.html\" or \"chart.png\". The extension sets its type."),
    content: z.string().min(1).describe("The file's content: its text, or its bytes in base64 when encoding is \"base64\"."),
    encoding: z.enum(["utf8", "base64"]).optional().describe("\"utf8\" (default) for text such as HTML, Markdown, JSON or code; \"base64\" for an image or other binary file."),
  }).strict())
  .min(1)
  .max(MESSAGE_ATTACHMENT_LIMITS.maxFiles)
  .optional()
  .describe("Optional files to attach, given as content (no folder needed): 1 to 4, together with any attachments. Over the remote LetAgents endpoint one tool call is at most 256 KB, so keep files there under about 180 KB together. Names that usually hold credentials (.env, keys) are refused. If any file is refused, nothing is posted. A single self-contained .html file runs inside the room message in the LetAgents desktop app as a locked demo with no network: put all CSS, JavaScript and images (as data: URLs) in the file, keep it under about 560 px tall, and support light and dark mode. People can pin notes and draw on it; read them with read_demo_marks.");

export function registerSendMessageTool(server: McpServer, options: SendToolOptions = {}): void {
  const attachments: Record<string, typeof attachmentsInput | typeof filesInput> = {
    ...(options.fileAttachments ? { attachments: attachmentsInput } : {}),
    ...(options.fileContents ? { files: filesInput } : {}),
  };
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
