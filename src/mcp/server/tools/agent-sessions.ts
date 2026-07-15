import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  scheduleCodexRuntimeStreamBridgeBind,
} from "../../codex-session.js";
import {
  getManagedAgentProvider,
  toManagedAgentStartResponse,
} from "../../managed-agent-providers.js";
import { encodeRoomIdPath, looksLikeInviteCode, normalizeInviteCode, type JoinedVia } from "../../room-id.js";
import {
  AGENT_INSTANCE_UUID,
  RepoRoomAuthRequiredError,
  apiCall,
  agentSessionCredentials,
  currentRoom,
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  endStoredAgentSession,
  ensureAgentIdentity,
  getSessionLivenessRegistration,
  getAgentSessionRepoBranch,
  getStoredAgentSession,
  getTargetRoomId,
  ensureLocalWorkerAgentSession,
  isLocalRoomStorageEnabled,
  joinRoomIdentifier,
  resolveLocalRoomStorageIdentifiers,
  saveAgentSession,
  toPublicAgentSession,
  toPublicRoomState,
  toRepoRoomAuthRequiredResult,
  withAgentIdentity,
  resolveWorkerToolIdentity,
} from "../runtime.js";
import {
  requireValidWorkerBearerRuntime,
  workerModeDisabledToolResult,
} from "../runtime/worker-bearer.js";
import { bindSupervisedWorkerSession } from "../runtime/supervisor-bridge.js";

export function registerAgentSessionTools(server: McpServer): void {
  // -- register_agent_session -------------------------------------------------

  server.tool(
    "register_agent_session",
    "Register this MCP client as an explicit room agent session. Unregistered MCP traffic is treated as controller traffic and stays out of the connected-agent roster.",
    {
      room_id: z
        .string()
        .optional()
        .describe("Canonical room ID. Defaults to the current room."),
      session_kind: z
        .enum(["worker", "controller"])
        .optional()
        .describe("Agent session kind. Workers appear in connected agent activity; controllers do not. Defaults to worker."),
      runtime: z
        .string()
        .optional()
        .describe("Runtime label such as codex, antigravity, or custom harness name."),
      display_name: z
        .string()
        .optional()
        .describe("Human-readable label for this worker session. Use distinct labels when one MCP process controls multiple workers."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory used to detect the worker's active git branch. Defaults to the MCP server's working directory."),
    },
    async ({ room_id, session_kind, runtime, display_name, cwd }) => {
      const targetRoomId = getTargetRoomId(room_id);
      if (!targetRoomId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "No room_id provided and not currently in a room.",
                  hint: "Join a room first, or pass room_id explicitly.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const requestedRuntime = runtime?.trim() || detectAgentRuntimeLabel();
      const repoBranch = getAgentSessionRepoBranch(cwd);
      if (await isLocalRoomStorageEnabled(targetRoomId)) {
        const session = await ensureLocalWorkerAgentSession(targetRoomId, {
          sessionKind: session_kind ?? "worker",
          runtime: requestedRuntime,
          displayName: display_name,
          repoBranch,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  local: true,
                  agent_session: toPublicAgentSession(session),
                  agent_session_id: session.session_id,
                  use_agent_session_id: "Pass this exact local agent_session_id to wait_for_messages, send_message, send_thread_message, post_status, and task tools for this same-machine local room.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const { cloudRoomId } = await resolveLocalRoomStorageIdentifiers(targetRoomId);
      const apiRoomId = cloudRoomId || targetRoomId;
      if (requireValidWorkerBearerRuntime().mode === "worker") {
        // The supplied bearer is issued for an existing server-side agent
        // session. Do not call the owner-only registration endpoint or write
        // any session credential to local storage.
        const { agentSession } = await resolveWorkerToolIdentity({ roomId: apiRoomId });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  worker_bearer_mode: true,
                  agent_session: toPublicAgentSession(agentSession),
                  agent_session_id: agentSession.session_id,
                  use_agent_session_id: "This local worker-bearer session marker may be passed to room tools. The supplied bearer remains the only server credential.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const identity = await ensureAgentIdentity();
      if (!identity.canonical_key) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "Authenticated agent identity is required before registering an agent session.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const created = await apiCall<Record<string, unknown>>(
        `/rooms/${encodeRoomIdPath(apiRoomId)}/agent-sessions`,
        {
          method: "POST",
          body: JSON.stringify({
            actor_key: identity.canonical_key,
            actor_label: identity.actor_label,
            ide_label: identity.ide_label ?? detectAgentIdeLabel(),
            agent_instance_id: AGENT_INSTANCE_UUID,
            display_name: display_name?.trim() || identity.display_name,
            session_kind: session_kind ?? "worker",
            runtime: requestedRuntime,
            repo_branch: repoBranch,
            registration_liveness: getSessionLivenessRegistration(requestedRuntime),
          }),
        }
      );

      const sessionId = typeof created.session_id === "string" ? created.session_id : "";
      const sessionToken = typeof created.session_token === "string" ? created.session_token : "";
      if (!sessionId || !sessionToken) {
        throw new Error("Agent session registration response was missing session credentials.");
      }

      const session = saveAgentSession({
        session_id: sessionId,
        session_token: sessionToken,
        room_id: typeof created.room_id === "string" ? created.room_id : apiRoomId,
        session_kind: created.session_kind === "controller" ? "controller" : "worker",
        runtime: typeof created.runtime === "string" ? created.runtime : "unknown",
        host_id: typeof created.host_id === "string" ? created.host_id : null,
        host_kind: typeof created.host_kind === "string" ? created.host_kind : null,
        host_label: typeof created.host_label === "string" ? created.host_label : null,
        liveness_capability: typeof created.liveness_capability === "string" ? created.liveness_capability : null,
        tool_bridge_id: typeof created.tool_bridge_id === "string" ? created.tool_bridge_id : null,
        actor_label: typeof created.actor_label === "string" ? created.actor_label : identity.actor_label,
        agent_key: typeof created.agent_key === "string" ? created.agent_key : identity.canonical_key,
        agent_instance_id: typeof created.agent_instance_id === "string" ? created.agent_instance_id : AGENT_INSTANCE_UUID,
        display_name: typeof created.display_name === "string" ? created.display_name : identity.display_name,
        owner_label: typeof created.owner_label === "string" ? created.owner_label : identity.owner_label,
        ide_label: typeof created.ide_label === "string" ? created.ide_label : identity.ide_label ?? detectAgentIdeLabel(),
        repo_branch: typeof created.repo_branch === "string" ? created.repo_branch : repoBranch,
        created_at: typeof created.created_at === "string" ? created.created_at : new Date().toISOString(),
        updated_at: typeof created.updated_at === "string" ? created.updated_at : new Date().toISOString(),
        last_seen_at: typeof created.last_seen_at === "string" ? created.last_seen_at : new Date().toISOString(),
        ended_at: typeof created.ended_at === "string" ? created.ended_at : null,
      });

      await bindSupervisedWorkerSession(session);
      scheduleCodexRuntimeStreamBridgeBind(session);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                agent_session: toPublicAgentSession(session),
                agent_session_id: session.session_id,
                use_agent_session_id: "Pass this exact agent_session_id to wait_for_messages, send_message, send_thread_message, post_status, and task tools for this specific worker. Do not rely on a shared current session.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // -- disconnect_agent_session ----------------------------------------------

  server.tool(
    "disconnect_agent_session",
    "Disconnect/end a registered worker session from a room. Pass the exact agent_session_id for the worker to disconnect.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room or the stored session room."),
      agent_session_id: z.string().optional().describe("Registered agent session to disconnect."),
    },
    async ({ room_id, agent_session_id }) => {
      let targetRoomId = getTargetRoomId(room_id);
      const localSession = agent_session_id
        ? getStoredAgentSession(agent_session_id)
        : null;
      if (!targetRoomId && localSession) {
        targetRoomId = localSession.room_id;
      }
      if (!targetRoomId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "No room_id provided and not currently in a room.",
                  hint: "Join a room first, pass room_id, or pass a locally stored agent_session_id.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const targetSessionId = agent_session_id || localSession?.session_id;
      if (!targetSessionId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "agent_session_id is required to disconnect a worker session.",
                  hint: "Pass the exact agent_session_id returned by register_agent_session.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (localSession?.ended_at) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  already_ended: true,
                  agent_session: toPublicAgentSession(localSession),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const requestBody =
        localSession?.session_id === targetSessionId && localSession.session_kind === "worker"
          ? agentSessionCredentials(localSession)
          : {};

      if (await isLocalRoomStorageEnabled(targetRoomId)) {
        const endedSession = endStoredAgentSession(targetSessionId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  local: true,
                  agent_session: toPublicAgentSession(endedSession),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const { cloudRoomId } = await resolveLocalRoomStorageIdentifiers(targetRoomId);
      const apiRoomId = cloudRoomId || targetRoomId;
      const result = await apiCall<Record<string, unknown>>(
        `/rooms/${encodeRoomIdPath(apiRoomId)}/agent-sessions/${encodeURIComponent(targetSessionId)}/disconnect`,
        {
          method: "POST",
          body: JSON.stringify(requestBody),
        }
      );

      const endedAt =
        result.agent_session && typeof result.agent_session === "object" && "ended_at" in result.agent_session
          ? String((result.agent_session as { ended_at?: unknown }).ended_at ?? new Date().toISOString())
          : new Date().toISOString();
      const endedLocalSession =
        localSession?.session_id === targetSessionId
          ? endStoredAgentSession(targetSessionId, endedAt)
          : null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                room_id: targetRoomId,
                agent_session_id: targetSessionId,
                agent_session: result.agent_session ?? toPublicAgentSession(endedLocalSession),
                delivery_session: result.delivery_session ?? null,
                local_state: endedLocalSession ? "ended" : "unchanged",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // -- local Codex live sessions ---------------------------------------------

  server.tool(
    "start_local_codex_session",
    "Start or reuse a detached local Codex live session for a LetAgents room. The worker will join the room, keep polling, contribute in discussion, and do repo work from the current working directory when asked.",
    {
      room: z
        .string()
        .describe("Invite code or room name to run as a detached local Codex worker."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for repo work. Defaults to the current process directory."),
      stop_phrase: z
        .string()
        .optional()
        .describe("Exact room message text that tells the worker to stop. Defaults to /stop-codex-room."),
      max_minutes: z
        .number()
        .optional()
        .describe("Optional hard stop in minutes. Defaults to 0, which means run until stopped."),
    },
    async ({ room, cwd, stop_phrase, max_minutes }) => {
      const disabled = workerModeDisabledToolResult("Local Codex session orchestration");
      if (disabled) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(disabled, null, 2) }],
        };
      }
      const joinedVia: JoinedVia = looksLikeInviteCode(room) ? "join_code" : "join_room";

      try {
        const joined = await joinRoomIdentifier(room, joinedVia);
        const provider = getManagedAgentProvider("codex");
        const liveSession = await provider.startLocalSession({
          room_id: joined.room.room_id,
          room_identifier: joinedVia === "join_code" ? normalizeInviteCode(room) : room.trim(),
          room_code: joined.room.code ?? null,
          room_display_name: joined.room.display_name ?? null,
          joined_via: joinedVia,
          cwd: cwd || process.cwd(),
          stop_phrase,
          max_minutes,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                await withAgentIdentity({
                  success: true,
                  room: toPublicRoomState(joined.room),
                  ...toManagedAgentStartResponse(provider, liveSession),
                }),
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        if (error instanceof RepoRoomAuthRequiredError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(toRepoRoomAuthRequiredResult(error), null, 2),
              },
            ],
          };
        }

        throw error;
      }
    }
  );

  server.tool(
    "status_local_codex_session",
    "Inspect the current detached local Codex live session, or a specific one by session_id.",
    {
      session_id: z
        .string()
        .optional()
        .describe("Optional session id. Defaults to the current local Codex live session."),
    },
    async ({ session_id }) => {
      const disabled = workerModeDisabledToolResult("Local Codex session orchestration");
      if (disabled) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(disabled, null, 2) }],
        };
      }
      const provider = getManagedAgentProvider("codex");
      const status = await provider.inspectLocalSession(session_id, currentRoom?.room_id);
      if (!status) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "No local Codex live session found." }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                session: provider.toPublicLiveSession(status.session),
                server_reachable: status.server_reachable,
                thread_status: status.thread_status,
                turn_status: status.turn_status,
                recent_items: status.recent_items,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "stop_local_codex_session",
    "Stop the current detached local Codex live session, or a specific one by session_id.",
    {
      session_id: z
        .string()
        .optional()
        .describe("Optional session id. Defaults to the current local Codex live session."),
      shutdown_server: z
        .boolean()
        .optional()
        .describe("If true, also terminate the spawned codex app-server process when possible."),
    },
    async ({ session_id, shutdown_server }) => {
      const disabled = workerModeDisabledToolResult("Local Codex session orchestration");
      if (disabled) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(disabled, null, 2) }],
        };
      }
      const provider = getManagedAgentProvider("codex");
      const stopped = await provider.stopLocalSession({
        session_id,
        room_id: currentRoom?.room_id,
        shutdown_server,
      });

      if (!stopped) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "No local Codex live session found." }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                session: provider.toPublicLiveSession(stopped),
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
