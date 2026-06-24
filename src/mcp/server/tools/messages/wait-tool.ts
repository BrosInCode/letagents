import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPollTimeoutCapMs } from "../../../../shared/poll-timeout-cap.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  appendIncludePromptOnly,
  buildAgentDeliveryHeaders,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLocalChatMessages,
  getLastMessageId,
  getRememberedRoomPresence,
  getTargetRoomId,
  identityFromAgentSession,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  resolveAgentSession,
  roomScopedApiCall,
  syncRoomPresence,
  toAgentReadableMessages,
  touchRoomSession,
  waitForLocalChatMessages,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

const DEFAULT_POLL_TIMEOUT_MS = 30000;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return Boolean(value && typeof value === "object");
}

function messageId(message: MessageRecord): string | null {
  return typeof message.id === "string" && message.id.trim() ? message.id : null;
}

function replyReferenceId(message: MessageRecord): string | null {
  const reply = message.reply_to ?? message.replyTo ?? null;
  if (typeof reply === "string" && reply.trim()) {
    return reply;
  }
  if (isRecord(reply) && typeof reply.id === "string" && reply.id.trim()) {
    return reply.id;
  }
  return null;
}

async function findLocalMessageById(roomId: string, targetMessageId: string): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const result = await getLocalChatMessages(roomId, {
      after: afterCursor,
      include_prompt_only: true,
    });
    const messages = (result.messages ?? []).filter(isRecord);
    const match = messages.find((message) => message.id === targetMessageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = messageId(lastMessage) ?? undefined;
    if (!afterCursor) return null;
  }
}

async function findRemoteMessageById(input: {
  roomId: string | null;
  projectId: string | null;
  targetMessageId: string;
}): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams();
    if (afterCursor) params.set("after", afterCursor);
    const queryString = params.toString();
    const result = await roomScopedApiCall<{
      messages?: MessageRecord[];
      has_more?: boolean;
    }>({
      room_id: input.roomId,
      project_id: input.projectId,
      room_path: (roomId) =>
        appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(roomId)}/messages${queryString ? `?${queryString}` : ""}`),
      project_path: (projectId) =>
        appendIncludePromptOnly(`/projects/${encodeURIComponent(projectId)}/messages${queryString ? `?${queryString}` : ""}`),
    });
    const messages = (result.messages ?? []).filter(isRecord);
    const match = messages.find((message) => message.id === input.targetMessageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = messageId(lastMessage) ?? undefined;
    if (!afterCursor) return null;
  }
}

async function collectThreadContextMessages(input: {
  messages: unknown[];
  localRoomId: string | null;
  roomId: string | null;
  projectId: string | null;
}): Promise<MessageRecord[]> {
  const records = input.messages.filter(isRecord);
  const knownIds = new Set(records.map(messageId).filter((id): id is string => Boolean(id)));
  const seenIds = new Set(knownIds);
  const pendingIds = records
    .map(replyReferenceId)
    .filter((id): id is string => Boolean(id && !knownIds.has(id)));
  const contextMessages: MessageRecord[] = [];
  const useLocalStorage = Boolean(
    input.localRoomId && await isLocalRoomStorageEnabled(input.localRoomId)
  );
  const localIdentifiers = useLocalStorage
    ? await resolveLocalRoomStorageIdentifiers(input.localRoomId)
    : { localRoomId: input.localRoomId };
  const sqliteRoomId = localIdentifiers.localRoomId || input.localRoomId;

  while (pendingIds.length > 0) {
    const nextId = pendingIds.shift();
    if (!nextId || seenIds.has(nextId)) continue;
    seenIds.add(nextId);
    const message = useLocalStorage && input.localRoomId
      ? await findLocalMessageById(sqliteRoomId || input.localRoomId, nextId)
      : await findRemoteMessageById({
        roomId: input.roomId,
        projectId: input.projectId,
        targetMessageId: nextId,
      });
    if (!message) continue;
    contextMessages.push(message);
    const parentId = replyReferenceId(message);
    if (parentId && !seenIds.has(parentId)) {
      pendingIds.push(parentId);
    }
  }

  return contextMessages;
}

export function registerWaitForMessagesTool(server: McpServer): void {
  server.tool(
    "wait_for_messages",
    "Wait for new messages in a Let Agents Chat room (HTTP long-poll). Threaded replies include thread_parent_id/thread.root_message_id; use send_thread_message with that id to keep focused side discussion out of the main room. For multi-hour runs, call in a loop: always pass after_message_id from the last message you processed so an empty result means 'nothing new yet', not 'stop working'. If someone posted a premature 'I will wait' closing line, use send_message with a brief continue instruction. Per-call wait is capped (default max 180s unless LETAGENTS_POLL_MAX_MS is set on API and MCP).",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      after_message_id: z
        .string()
        .optional()
        .describe("Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns all existing messages immediately."),
      timeout: z
        .number()
        .optional()
        .describe(
          "Maximum wait time in milliseconds (min 1000, capped by LETAGENTS_POLL_MAX_MS / server). If set to 0, the default timeout will be used."
        ),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use. Without this, the MCP transport is treated as controller traffic and is hidden from connected-agent activity."),
    },
    async ({ room_id, after_message_id, timeout, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      const identity = await ensureAgentIdentity();
      const agentSession = resolveAgentSession(targetRoomId ?? currentRoom?.room_id ?? null, agent_session_id);
      const maxPollMs = getPollTimeoutCapMs();
      const serverTimeout = Math.min(
        Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
        maxPollMs
      );
      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;
        const result = await waitForLocalChatMessages(effectiveLocalRoomId, {
          after: after_message_id,
          timeoutMs: serverTimeout,
          include_prompt_only: true,
        });
        touchRoomSession(effectiveLocalRoomId, getLastMessageId(result));
        const threadContext = await collectThreadContextMessages({
          messages: result.messages,
          localRoomId: effectiveLocalRoomId,
          roomId: targetRoomId,
          projectId: targetProjectId,
        });
        return jsonToolResponse({
          room_id: effectiveLocalRoomId,
          messages: toAgentReadableMessages(result.messages, threadContext),
        });
      }

      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, agentSession ? identityFromAgentSession(agentSession) : identity),
        agentSession
      );
      const clientTimeout =
        serverTimeout + (serverTimeout > 120_000 ? 120_000 : 5_000);

      const params = new URLSearchParams();
      if (after_message_id) params.set("after", after_message_id);
      params.set("timeout", String(serverTimeout));

      const queryString = params.toString();
      const deliveryHeaders = buildAgentDeliveryHeaders(agentSession);
      const firstResult = await roomScopedApiCall<{
        messages?: Array<{ id?: string }>;
        has_more?: boolean;
        room_id?: string;
        project_id?: string;
      }>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) =>
          appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages/poll?${queryString}`),
        project_path: (targetProjectId) =>
          appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages/poll?${queryString}`),
        options: {
          signal: AbortSignal.timeout(clientTimeout),
          headers: deliveryHeaders,
        },
      });

      const allMessages: unknown[] = [...(firstResult.messages ?? [])];
      const roomIdFromResponse = firstResult.room_id || firstResult.project_id;

      if (firstResult.has_more && allMessages.length > 0) {
        let afterCursor = (allMessages[allMessages.length - 1] as { id?: string })?.id;

        while (afterCursor) {
          const pageParams = new URLSearchParams();
          pageParams.set("after", afterCursor);
          const qs = pageParams.toString();

          const page = await roomScopedApiCall<{
            messages?: Array<{ id?: string }>;
            has_more?: boolean;
          }>({
            room_id: targetRoomId,
            project_id: targetProjectId,
            room_path: (targetRoomId) =>
              appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages?${qs}`),
            project_path: (targetProjectId) =>
              appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages?${qs}`),
          });

          const msgs = page.messages ?? [];
          allMessages.push(...msgs);

          if (!page.has_more || msgs.length === 0) break;
          afterCursor = (msgs[msgs.length - 1] as { id?: string })?.id;
        }
      }

      const threadContext = await collectThreadContextMessages({
        messages: allMessages,
        localRoomId,
        roomId: targetRoomId,
        projectId: targetProjectId,
      });
      const output: Record<string, unknown> = { messages: toAgentReadableMessages(allMessages, threadContext) };
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }

      if (targetRoomId) {
        touchRoomSession(targetRoomId, getLastMessageId(output));
      }
      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, agentSession ? identityFromAgentSession(agentSession) : identity),
        agentSession
      );
      return jsonToolResponse(output);
    }
  );
}
