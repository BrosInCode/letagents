import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  agentSessionCredentials,
  addLocalChatMessage,
  appendIncludePromptOnly,
  currentRoom,
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
import { jsonToolResponse } from "./response.js";

type MessageRecord = Record<string, unknown>;

type SendMessageInput = {
  room_id?: string;
  text: string;
  reply_to?: string;
  thread_parent_id?: string;
  agent_session_id?: string;
};

function normalizeMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function replyReferenceId(message: MessageRecord | null): string | null {
  const reply = message?.reply_to ?? message?.replyTo ?? null;
  if (typeof reply === "string" && reply.trim()) {
    return reply;
  }
  if (reply && typeof reply === "object" && typeof (reply as { id?: unknown }).id === "string") {
    const id = (reply as { id: string }).id.trim();
    return id || null;
  }
  return null;
}

async function findLocalMessageById(roomId: string, messageId: string): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const result = await getLocalChatMessages(roomId, {
      after: afterCursor,
      include_prompt_only: true,
    });
    const messages = (result.messages ?? []) as MessageRecord[];
    const match = messages.find((message) => message.id === messageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
    if (!afterCursor) return null;
  }
}

async function findRemoteMessageById(input: {
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams();
    if (afterCursor) query.set("after", afterCursor);
    const qs = query.toString();
    const result = await roomScopedApiCall<{
      messages?: MessageRecord[];
      has_more?: boolean;
    }>({
      room_id: input.roomId,
      project_id: input.projectId,
      room_path: (roomId) =>
        appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(roomId)}/messages${qs ? `?${qs}` : ""}`),
      project_path: (projectId) =>
        appendIncludePromptOnly(`/projects/${encodeURIComponent(projectId)}/messages${qs ? `?${qs}` : ""}`),
    });
    const messages = result.messages ?? [];
    const match = messages.find((message) => message.id === input.messageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
    if (!afterCursor) return null;
  }
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

async function resolveThreadRootMessageId(input: {
  localRoomId: string | null;
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<string> {
  let currentId = input.messageId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(currentId)) return currentId;
    seen.add(currentId);
    const message = await findMessageById({ ...input, messageId: currentId });
    const parentId = replyReferenceId(message);
    if (!parentId) return currentId;
    currentId = parentId;
  }
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

  const { identity, agentSession } = await resolveWorkerToolIdentity({
    roomId: targetRoomId ?? currentRoom?.room_id ?? null,
    agentSessionId: input.agent_session_id,
  });
  const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
  const { replyTarget, shouldResolveThreadRoot } = initialReplyTarget(input);
  const resolvedReplyTarget = replyTarget && shouldResolveThreadRoot
    ? await resolveThreadRootMessageId({
      localRoomId,
      roomId: targetRoomId,
      projectId: targetProjectId,
      messageId: replyTarget,
    })
    : replyTarget;

  if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
    const message = await addLocalChatMessage(sqliteRoomId || localRoomId, {
      sender: identity.actor_label,
      text: input.text,
      reply_to: resolvedReplyTarget,
      ...(shouldResolveThreadRoot ? { thread_root_id: resolvedReplyTarget } : {}),
      source: "agent",
    });
    touchCurrentRoom(message.id);
    return jsonToolResponse({
      ...message,
      agent_identity: toPublicAgentIdentity(identity),
    });
  }

  const message = await roomScopedApiCall<Record<string, unknown>>({
    room_id: targetRoomId,
    project_id: targetProjectId,
    room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
    project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
    options: {
      method: "POST",
      body: JSON.stringify({
        sender: identity.actor_label,
        text: input.text,
        reply_to: resolvedReplyTarget,
        ...(shouldResolveThreadRoot ? { thread_root_id: resolvedReplyTarget } : {}),
        ...agentSessionCredentials(agentSession),
      }),
    },
  });
  touchCurrentRoom(typeof (message as { id?: string }).id === "string" ? (message as { id: string }).id : undefined);
  await syncRoomPresence(
    targetRoomId ?? currentRoom?.room_id ?? null,
    identity,
    getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity),
    agentSession
  );

  return jsonToolResponse({
    ...message,
    agent_identity: toPublicAgentIdentity(identity),
  });
}

export function registerSendMessageTool(server: McpServer): void {
  server.tool(
    "send_message",
    "Send a message to a Let Agents Chat room. For focused side discussion, prefer send_thread_message or pass thread_parent_id so the reply stays in that message thread instead of polluting the main room.",
    {
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
    },
    async ({ room_id, sender: _sender, text, reply_to, thread_parent_id, conversation_id: _conversation_id, agent_session_id }) =>
      sendMessageFromTool({ room_id, text, reply_to, thread_parent_id, agent_session_id })
  );

  server.tool(
    "send_thread_message",
    "Reply inside an existing message thread without posting a top-level room message. Use this when discussion should drill into one topic and keep the main room clean.",
    {
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
    },
    async ({ room_id, text, thread_parent_id, conversation_id: _conversation_id, agent_session_id }) =>
      sendMessageFromTool({ room_id, text, thread_parent_id, agent_session_id })
  );
}
