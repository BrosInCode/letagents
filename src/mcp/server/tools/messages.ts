import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_PRESENCE_STATUSES, type AgentPresenceStatus } from "../../../shared/agent-presence.js";
import { getPollTimeoutCapMs } from "../../../shared/poll-timeout-cap.js";
import { classifyPresenceStatusText } from "../../agent-presence.js";
import { encodeRoomIdPath } from "../../room-id.js";
import {
  appendIncludePromptOnly,
  agentSessionCredentials,
  buildAgentDeliveryHeaders,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLastMessageId,
  getRememberedRoomPresence,
  getTargetRoomId,
  heartbeatRoomPresence,
  identityFromAgentSession,
  normalizeOptionalToolString,
  resolveAgentSession,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toAgentReadableMessages,
  toPublicAgentIdentity,
  touchCurrentRoom,
  touchRoomSession,
} from "../runtime.js";

export function registerStatusTools(server: McpServer): void {
  // -- post_status ------------------------------------------------------------

  server.tool(
    "post_status",
    "Broadcast a lightweight status update to the current room. " +
      "Use this to let other agents and humans know what you are currently doing, " +
      "e.g. 'reviewing PR #2', 'waiting for tests', 'writing WISHLIST.md'. " +
      "Status updates are distinct from chat messages and can be filtered separately.",
    {
      sender: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      status: z.string().describe("Short status description (e.g. 'reviewing PR #2', 'idle', 'thinking...')"),
      room_id: z
        .string()
        .optional()
        .describe("Canonical room ID. Defaults to the current room."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this status update. Required for worker status."),
    },
    async ({ sender: _sender, status, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();

      if (!targetRoomId && !targetProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "No room_id provided and not currently in a room.",
                  hint: "Join or create a room first, or pass room_id explicitly.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Status messages use a reserved prefix so the UI (and agents) can distinguish
      // them from normal chat messages without changing the data model.
      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const sender = identity.actor_label;
      const statusText = `[status] ${status}`;

      await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
        status: classifyPresenceStatusText(
          status,
          getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity).status
        ),
        status_text: status,
      }, agentSession);
      const message = await roomScopedApiCall<Record<string, unknown>>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
        options: {
          method: "POST",
          body: JSON.stringify({
            sender,
            text: statusText,
            ...agentSessionCredentials(agentSession),
          }),
        },
      });
      touchCurrentRoom(typeof message.id === "string" ? message.id : undefined);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                status_posted: status,
                sender,
                agent_identity: toPublicAgentIdentity(identity),
                message_id: typeof message.id === "string" ? message.id : null,
                timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // -- post_reasoning ---------------------------------------------------------

  server.tool(
    "post_reasoning",
    "Update a structured, replace-in-place reasoning trace for the current room without spamming chat. " +
      "Use this for visible thought-process updates such as goal, hypothesis, checks in progress, blockers, " +
      "and next action. Optionally persist a milestone summary into room history when something durable changed.",
    {
      summary: z.string().describe("Short current reasoning summary shown in the room UI."),
      goal: z.string().optional().describe("What the agent is trying to achieve right now."),
      checking: z.string().optional().describe("What the agent is verifying or inspecting."),
      hypothesis: z.string().optional().describe("Current working theory or approach."),
      blocker: z.string().optional().describe("Current blocker, if any."),
      next_action: z.string().optional().describe("Immediate next step the agent plans to take."),
      milestone: z.string().optional().describe("Optional durable milestone summary to append to room history."),
      confidence: z.number().min(0).max(1).optional().describe("Optional confidence score between 0 and 1."),
      status: z.enum(AGENT_PRESENCE_STATUSES).optional().describe("Optional explicit presence state override."),
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this reasoning update. Required for worker reasoning."),
    },
    async ({
      summary,
      goal,
      checking,
      hypothesis,
      blocker,
      next_action,
      milestone,
      confidence,
      status,
      room_id,
      conversation_id: _conversation_id,
      agent_session_id,
    }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();

      if (!targetRoomId && !targetProjectId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "No room_id provided and not currently in a room.",
                  hint: "Join or create a room first, or pass room_id explicitly.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const normalizedSummary = summary.trim();
      if (!normalizedSummary) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "summary is required" }, null, 2),
            },
          ],
        };
      }

      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const snapshot = {
        summary: normalizedSummary,
        goal: normalizeOptionalToolString(goal),
        checking: normalizeOptionalToolString(checking),
        hypothesis: normalizeOptionalToolString(hypothesis),
        blocker: normalizeOptionalToolString(blocker),
        next_action: normalizeOptionalToolString(next_action),
        milestone: normalizeOptionalToolString(milestone),
        confidence,
        status,
      };

      const query = new URLSearchParams({
        open: "true",
        actor_label: identity.actor_label,
      });
      const sessionsResult = await roomScopedApiCall<{
        sessions?: Array<{
          id: string;
          task_id?: string | null;
          anchor_message_id?: string | null;
          actor_label: string;
          agent_key?: string | null;
          status?: AgentPresenceStatus | null;
          summary: string;
          latest_payload?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
          closed_at?: string | null;
        }>;
      }>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) =>
          `/rooms/${encodeRoomIdPath(targetRoomId)}/reasoning-sessions?${query.toString()}`,
        project_path: (targetProjectId) =>
          `/projects/${encodeURIComponent(targetProjectId)}/reasoning-sessions?${query.toString()}`,
      });

      const existingSession = sessionsResult.sessions?.[0];
      let result:
        | {
            room_id?: string;
            session: Record<string, unknown>;
            update?: Record<string, unknown>;
          }
        | null = null;

      if (existingSession?.id) {
        result = await roomScopedApiCall<{
          room_id?: string;
          session: Record<string, unknown>;
          update: Record<string, unknown>;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) =>
            `/rooms/${encodeRoomIdPath(targetRoomId)}/reasoning-sessions/${encodeURIComponent(existingSession.id)}/updates`,
          project_path: (targetProjectId) =>
            `/projects/${encodeURIComponent(targetProjectId)}/reasoning-sessions/${encodeURIComponent(existingSession.id)}/updates`,
          options: {
            method: "POST",
            body: JSON.stringify({
              actor_label: identity.actor_label,
              ...agentSessionCredentials(agentSession),
              ...snapshot,
            }),
          },
        });
      } else {
        result = await roomScopedApiCall<{
          room_id?: string;
          session: Record<string, unknown>;
          update: Record<string, unknown>;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) =>
            `/rooms/${encodeRoomIdPath(targetRoomId)}/reasoning-sessions`,
          project_path: (targetProjectId) =>
            `/projects/${encodeURIComponent(targetProjectId)}/reasoning-sessions`,
          options: {
            method: "POST",
            body: JSON.stringify({
              actor_label: identity.actor_label,
              agent_key: identity.canonical_key,
              ...agentSessionCredentials(agentSession),
              ...snapshot,
            }),
          },
        });
      }

      let milestoneMessageId: string | null = null;
      const normalizedMilestone = normalizeOptionalToolString(milestone);
      if (normalizedMilestone) {
        const milestoneMessage = await roomScopedApiCall<Record<string, unknown>>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
          project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
          options: {
            method: "POST",
            body: JSON.stringify({
              sender: identity.actor_label,
              text: normalizedMilestone,
              ...agentSessionCredentials(agentSession),
            }),
          },
        });
        milestoneMessageId =
          typeof milestoneMessage.id === "string" ? milestoneMessage.id : null;
        touchCurrentRoom(milestoneMessageId ?? undefined);
      }

      if (status) {
        await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
          status,
          status_text: normalizedSummary,
        }, agentSession);
      } else {
        await syncRoomPresence(
          targetRoomId ?? currentRoom?.room_id ?? null,
          identity,
          getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity),
          agentSession
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                room_id: result?.room_id ?? targetRoomId ?? targetProjectId ?? null,
                session: result?.session ?? null,
                update: result?.update ?? null,
                milestone_message_id: milestoneMessageId,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

}

export function registerMessageTools(server: McpServer): void {
  // -- send_message -----------------------------------------------------------

  server.tool(
    "send_message",
    "Send a message to a Let Agents Chat room. Use a short nudge (e.g. continue the plan) if another participant stopped after a closing message — silence does not always mean work is finished.",
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
        .describe("Optional message id to quote-reply to (for example `msg_42`)."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this message. Required for worker messages."),
    },
    async ({ room_id, sender: _sender, text, reply_to, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        throw new Error("No room is currently selected. Join a room first or pass room_id.");
      }

      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const message = await roomScopedApiCall<Record<string, unknown>>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
        options: {
          method: "POST",
          body: JSON.stringify({
            sender: identity.actor_label,
            text,
            reply_to,
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
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...message,
                agent_identity: toPublicAgentIdentity(identity),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // -- read_messages ----------------------------------------------------------

  server.tool(
    "read_messages",
    "Read all messages from a Let Agents Chat room. For long-running work, prefer wait_for_messages with after_message_id so you only process new lines and do not treat an empty poll as the end of the mission.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    },
    async ({ room_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();

      // Paginate through all pages to honor the "read all messages" contract
      const allMessages: unknown[] = [];
      let afterCursor: string | undefined;
      let roomIdFromResponse: string | undefined;

      for (;;) {
        const query = new URLSearchParams();
        if (afterCursor) query.set("after", afterCursor);

        const qs = query.toString();
        const result = await roomScopedApiCall<{
          messages?: Array<{ id?: string }>;
          has_more?: boolean;
          room_id?: string;
          project_id?: string;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) =>
            appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages${qs ? `?${qs}` : ""}`),
          project_path: (targetProjectId) =>
            appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages${qs ? `?${qs}` : ""}`),
        });

        roomIdFromResponse = roomIdFromResponse || result.room_id || result.project_id;
        const msgs = result.messages ?? [];
        allMessages.push(...msgs);

        if (!result.has_more || msgs.length === 0) break;

        // Use the last message ID as the cursor for the next page
        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg?.id) break;
        afterCursor = lastMsg.id;
      }
      await heartbeatRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, await ensureAgentIdentity());

      const output: Record<string, unknown> = { messages: toAgentReadableMessages(allMessages) };
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );

  // -- wait_for_messages ------------------------------------------------------

  const DEFAULT_POLL_TIMEOUT_MS = 30000; // 30 seconds

  server.tool(
    "wait_for_messages",
    "Wait for new messages in a Let Agents Chat room (HTTP long-poll). For multi-hour runs, call in a loop: always pass after_message_id from the last message you processed so an empty result means 'nothing new yet', not 'stop working'. If someone posted a premature 'I will wait' closing line, use send_message with a brief continue instruction. Per-call wait is capped (default max 180s unless LETAGENTS_POLL_MAX_MS is set on API and MCP).",
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
      const identity = await ensureAgentIdentity();
      const agentSession = resolveAgentSession(targetRoomId ?? currentRoom?.room_id ?? null, agent_session_id);
      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, agentSession ? identityFromAgentSession(agentSession) : identity),
        agentSession
      );
      const maxPollMs = getPollTimeoutCapMs();
      const serverTimeout = Math.min(
        Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
        maxPollMs
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
          `/rooms/${encodeRoomIdPath(targetRoomId)}/messages/poll?${queryString}`,
        project_path: (targetProjectId) =>
          `/projects/${encodeURIComponent(targetProjectId)}/messages/poll?${queryString}`,
        options: {
          signal: AbortSignal.timeout(clientTimeout),
          headers: deliveryHeaders,
        },
      });

      const allMessages: unknown[] = [...(firstResult.messages ?? [])];
      const roomIdFromResponse = firstResult.room_id || firstResult.project_id;

      // If the immediate response has more pages, paginate through them
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
              `/rooms/${encodeRoomIdPath(targetRoomId)}/messages?${qs}`,
            project_path: (targetProjectId) =>
              `/projects/${encodeURIComponent(targetProjectId)}/messages?${qs}`,
          });

          const msgs = page.messages ?? [];
          allMessages.push(...msgs);

          if (!page.has_more || msgs.length === 0) break;
          afterCursor = (msgs[msgs.length - 1] as { id?: string })?.id;
          if (!afterCursor) break;
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
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );
}
