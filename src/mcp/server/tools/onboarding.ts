import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildAgentActorLabel, formatOwnerAttribution } from "../../../shared/agent-identity.js";
import { normalizeAgentBaseName } from "../../../shared/codenames.js";
import { getGitRemoteIdentity } from "../../git-remote.js";
import { getRoomFromConfig } from "../../config-reader.js";
import { looksLikeInviteCode, type JoinedVia } from "../../room-id.js";
import { resolveGitRoot } from "../repo-context.js";
import {
  API_URL,
  apiCall,
  clearAuthenticatedAccountCache,
  clearPendingDeviceAuth,
  clearStoredAuth,
  currentAgentIdentity,
  currentAgentIdentityKey,
  currentRoom,
  detectAgentIdeLabel,
  ensureAgentIdentity,
  getConversationIdentity,
  getLetagentsToken,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  joinRoomIdentifier,
  resolveOwnerContext,
  setAuthenticatedAccountCache,
  setConversationIdentity,
  setPendingDeviceAuth,
  setStoredAuth,
  storeCurrentAgentIdentity,
  toPublicAgentIdentity,
  toPublicRoomState,
  toPublicStoredRoomSession,
  withCanonicalRoomLink,
  type RoomState,
  type StoredAccount,
  type StoredAgentIdentityState,
} from "../runtime.js";

export function registerOnboardingTools(server: McpServer): void {
  // -- onboarding -------------------------------------------------------------

  server.tool(
    "get_onboarding_status",
    "Inspect local Let Agents MCP auth and room-session state so a user can finish onboarding without guessing what is missing.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Working directory to inspect for repo context. Defaults to the current process directory."),
    },
    async ({ cwd }) => {
      const workingDir = cwd || process.cwd();
      const repoRoot = resolveGitRoot(workingDir);
      const configRoom = getRoomFromConfig(workingDir);
      const gitRoom = repoRoot ? getGitRemoteIdentity(repoRoot) : null;
      const storedAuth = getStoredAuth();
      const pendingAuth = getPendingDeviceAuth();
      const savedCurrentRoom = getStoredCurrentRoom();
      const detectedRoom = configRoom || gitRoom;

      let nextStep = "join_room";
      if (!storedAuth && pendingAuth) {
        nextStep = "poll_device_auth";
      } else if (savedCurrentRoom && !currentRoom) {
        nextStep = "resume_room_session";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                api_url: API_URL,
                local_state_path: getLocalStatePath(),
                authenticated: Boolean(process.env.LETAGENTS_TOKEN || storedAuth),
                auth_source: process.env.LETAGENTS_TOKEN
                  ? "env"
                  : storedAuth
                    ? "local_state"
                    : "none",
                account: storedAuth?.account ?? null,
                token_expires_at: storedAuth?.expires_at ?? null,
                pending_device_auth: pendingAuth,
                agent_identity: toPublicAgentIdentity(
                  currentAgentIdentity ?? getStoredAgentIdentity(currentAgentIdentityKey)
                ),
                current_room: toPublicRoomState(currentRoom),
                saved_current_room: toPublicStoredRoomSession(savedCurrentRoom),
                detected_room_from_context: detectedRoom,
                repo_root: repoRoot,
                next_step: nextStep,
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
    "start_device_auth",
    "Start GitHub Device Flow for Let Agents Chat and persist the pending request locally. Use this when private repo access or explicit LetAgents auth is needed.",
    {
      room_id: z
        .string()
        .optional()
        .describe("Optional room to associate with this auth request for later auto-join."),
      force: z
        .boolean()
        .optional()
        .describe("If true, replaces any existing pending device auth request."),
    },
    async ({ room_id, force }) => {
      const existing = getPendingDeviceAuth();
      if (existing && !force) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  reused_existing_request: true,
                  ...existing,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const response = await apiCall<{
        request_id: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      }>("/auth/device/start", {
        method: "POST",
      });

      const pendingAuth = setPendingDeviceAuth({
        request_id: response.request_id,
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        interval_seconds: response.interval,
        expires_at: new Date(Date.now() + response.expires_in * 1000).toISOString(),
        started_at: new Date().toISOString(),
        suggested_room_id: room_id ?? currentRoom?.room_id ?? getRoomFromConfig() ?? undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                ...pendingAuth,
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
    "poll_device_auth",
    "Poll a pending GitHub Device Flow request. On success this stores the LetAgents token locally and can optionally join a room immediately.",
    {
      request_id: z
        .string()
        .optional()
        .describe("The device auth request to poll. Defaults to the locally saved pending request."),
      room_id: z
        .string()
        .optional()
        .describe("Optional room to auto-join after authorization succeeds."),
      auto_join: z
        .boolean()
        .optional()
        .describe("If true, tries to join the room immediately after the auth succeeds."),
    },
    async ({ request_id, room_id, auto_join }) => {
      const pendingAuth = request_id
        ? getPendingDeviceAuth()?.request_id === request_id
          ? getPendingDeviceAuth()
          : null
        : getPendingDeviceAuth();

      if (!pendingAuth && !request_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: "No pending device auth request found." },
                null,
                2
              ),
            },
          ],
        };
      }

      const requestId = request_id || pendingAuth?.request_id;
      if (!requestId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: "A request_id is required when nothing is saved locally." },
                null,
                2
              ),
            },
          ],
        };
      }

      const result = await apiCall<{
        status: "pending" | "slow_down" | "authorized" | "denied" | "expired";
        interval?: number;
        expires_in?: number;
        letagents_token?: string;
        expires_at?: string;
        account?: StoredAccount;
      }>(`/auth/device/poll/${encodeURIComponent(requestId)}`);

      if (result.status === "pending" || result.status === "slow_down") {
        if (pendingAuth) {
          setPendingDeviceAuth({
            ...pendingAuth,
            interval_seconds: result.interval ?? pendingAuth.interval_seconds,
            expires_at:
              result.expires_in !== undefined
                ? new Date(Date.now() + result.expires_in * 1000).toISOString()
                : pendingAuth.expires_at,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      }

      if (result.status === "denied" || result.status === "expired") {
        clearPendingDeviceAuth();
        clearStoredAuth();
        clearAuthenticatedAccountCache();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, ...result }, null, 2),
            },
          ],
        };
      }

      if (!result.letagents_token) {
        throw new Error("Device auth completed without a LetAgents token.");
      }

      clearPendingDeviceAuth();
      const storedAuth = setStoredAuth({
        token: result.letagents_token,
        expires_at: result.expires_at,
        account: result.account,
        stored_at: new Date().toISOString(),
        source: "device_flow",
      });
      setAuthenticatedAccountCache(storedAuth.account ?? undefined, storedAuth.account ? "stored" : null, null);

      let joinedRoom: RoomState | null = null;
      const roomToJoin =
        room_id ||
        pendingAuth?.suggested_room_id ||
        currentRoom?.room_id ||
        getRoomFromConfig() ||
        undefined;

      if (auto_join && roomToJoin) {
        const joinedVia: JoinedVia = looksLikeInviteCode(roomToJoin) ? "join_code" : "join_room";
        const joined = await joinRoomIdentifier(roomToJoin, joinedVia);
        joinedRoom = joined.room;
      }

      const agentIdentity = await ensureAgentIdentity();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                status: "authorized",
                account: storedAuth.account ?? null,
                expires_at: storedAuth.expires_at ?? null,
                auto_joined_room: joinedRoom,
                ...(joinedRoom?.room_id
                  ? withCanonicalRoomLink(joinedRoom.room_id, {})
                  : {}),
                agent_identity: toPublicAgentIdentity(agentIdentity),
                hint: "You can change your agent's display name anytime using the set_agent_name tool.",
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
    "clear_saved_auth",
    "Clear any locally saved LetAgents auth token and pending device auth request.",
    {},
    async () => {
      clearPendingDeviceAuth();
      clearStoredAuth();
      clearAuthenticatedAccountCache();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                env_token_still_present: Boolean(process.env.LETAGENTS_TOKEN),
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
    "set_agent_name",
    "Set or change the agent's display name. The agent will be known by this name in the room. Use this to pick a custom name instead of the auto-generated codename.",
    {
      name: z
        .string()
        .min(2)
        .max(64)
        .describe("The desired display name for this agent (2-64 characters)."),
      conversation_id: z
        .string()
        .optional()
        .describe("Optional conversation ID to scope this name change. When provided, only this conversation uses the new name; other conversations keep their own identity."),
    },
    async ({ name: desiredName, conversation_id }) => {
      const trimmedName = desiredName.trim();
      if (trimmedName.length < 2 || trimmedName.length > 64) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: "Name must be between 2 and 64 characters." },
                null,
                2
              ),
            },
          ],
        };
      }

      const authAvailable = Boolean(getLetagentsToken());
      if (!authAvailable) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: "Authentication required. Run start_device_auth first." },
                null,
                2
              ),
            },
          ],
        };
      }

      const slugName = normalizeAgentBaseName(trimmedName);

      try {
        const owner = await resolveOwnerContext();
        const ideLabel = detectAgentIdeLabel();
        const ownerAttribution = formatOwnerAttribution(owner.label);
        const actorLabel = buildAgentActorLabel({
          display_name: trimmedName,
          owner_label: owner.label,
          ide_label: ideLabel,
        });

        // When conversation_id is provided, skip server-side /agents registration
        // to avoid creating stranded durable agent records from ephemeral renames.
        let canonicalKey: string | null = owner.login ? `${owner.login}/${slugName}` : null;
        if (!conversation_id) {
          const registered = await apiCall<Record<string, unknown>>("/agents", {
            method: "POST",
            body: JSON.stringify({
              name: slugName,
              display_name: trimmedName,
              owner_label: owner.label,
            }),
          });
          if (typeof registered.canonical_key === "string") {
            canonicalKey = registered.canonical_key;
          }
        }

        const updatedIdentity: StoredAgentIdentityState = {
          name: slugName,
          display_name: trimmedName,
          owner_label: owner.label,
          owner_attribution: ownerAttribution,
          ide_label: ideLabel,
          actor_label: actorLabel,
          canonical_key: canonicalKey,
          runtime_key: currentAgentIdentityKey,
          source: conversation_id ? "local" : "api",
          resolved_at: new Date().toISOString(),
        };

        if (conversation_id) {
          // Scope to this conversation only
          setConversationIdentity(conversation_id, updatedIdentity);
        } else {
          // Global rename (backward compatible)
          storeCurrentAgentIdentity(updatedIdentity, currentAgentIdentityKey);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Agent name changed to "${trimmedName}".`,
                  agent_identity: toPublicAgentIdentity(
                    conversation_id
                      ? getConversationIdentity(conversation_id)
                      : currentAgentIdentity
                  ),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: `Failed to set name: ${error instanceof Error ? error.message : String(error)}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
