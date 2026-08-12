import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AGENT_PRESENCE_STATUSES, type AgentPresenceStatus } from "../../../../shared/agent-presence.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  addLocalChatMessage,
  agentSessionCredentials,
  currentRoom,
  getFallbackProjectId,
  getRememberedRoomPresence,
  getTargetRoomId,
  isLocalRoomStorageEnabled,
  normalizeOptionalToolString,
  resolveLocalRoomStorageIdentifiers,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toPublicAgentIdentity,
  touchCurrentRoom,
} from "../../runtime.js";
import { jsonToolResponse, missingRoomResponse } from "./response.js";

export function registerPostReasoningTool(server: McpServer): void {
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
        return missingRoomResponse();
      }

      const normalizedSummary = summary.trim();
      if (!normalizedSummary) {
        return jsonToolResponse({ success: false, error: "summary is required" });
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
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;
        let milestoneMessageId: string | null = null;
        const normalizedMilestone = normalizeOptionalToolString(milestone);
        if (normalizedMilestone) {
          const milestoneMessage = await addLocalChatMessage(effectiveLocalRoomId, {
            sender: identity.actor_label,
            text: normalizedMilestone,
            source: "agent",
            publisher_agent_key: agentSession?.agent_key ?? null,
            publisher_agent_session_id: agentSession?.session_id ?? null,
          });
          milestoneMessageId = milestoneMessage.id;
          touchCurrentRoom(milestoneMessageId);
        }

        await syncRoomPresence(effectiveLocalRoomId, identity, {
          status: status ?? getRememberedRoomPresence(effectiveLocalRoomId, identity).status,
          status_text: normalizedSummary,
        }, agentSession);

        const now = new Date().toISOString();
        return jsonToolResponse({
          success: true,
          room_id: effectiveLocalRoomId,
          local: true,
          session: {
            id: `local_reasoning:${identity.actor_label}`,
            actor_label: identity.actor_label,
            agent_key: identity.canonical_key,
            status: status ?? "working",
            summary: normalizedSummary,
            latest_payload: snapshot,
            updated_at: now,
          },
          update: {
            id: `local_reasoning_update:${now}`,
            payload: snapshot,
            created_at: now,
          },
          milestone_message_id: milestoneMessageId,
          agent_identity: toPublicAgentIdentity(identity),
        });
      }

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

      return jsonToolResponse({
        success: true,
        room_id: result?.room_id ?? targetRoomId ?? targetProjectId ?? null,
        session: result?.session ?? null,
        update: result?.update ?? null,
        milestone_message_id: milestoneMessageId,
        agent_identity: toPublicAgentIdentity(identity),
      });
    }
  );
}
