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
        return jsonToolResponse({
          room_id: effectiveLocalRoomId,
          messages: toAgentReadableMessages(result.messages),
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

      const output: Record<string, unknown> = { messages: toAgentReadableMessages(allMessages) };
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
