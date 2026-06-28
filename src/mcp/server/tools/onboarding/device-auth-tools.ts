import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getRoomFromConfig } from "../../../config-reader.js";
import { looksLikeInviteCode, type JoinedVia } from "../../../room-id.js";
import {
  apiCall,
  clearAuthenticatedAccountCache,
  clearPendingDeviceAuth,
  clearStoredAuth,
  currentRoom,
  ensureAgentIdentity,
  getPendingDeviceAuth,
  getStoredAuth,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
  setAuthenticatedAccountCache,
  setPendingDeviceAuth,
  setStoredAuth,
  toPublicAgentIdentity,
  withCanonicalRoomLink,
  type RoomState,
  type StoredAccount,
} from "../../runtime.js";
import { jsonTextResponse } from "./responses.js";

export function registerDeviceAuthTools(server: McpServer): void {
  registerStartDeviceAuthTool(server);
  registerPollDeviceAuthTool(server);
  registerClearSavedAuthTool(server);
}

function registerStartDeviceAuthTool(server: McpServer): void {
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
        return jsonTextResponse({
          success: true,
          reused_existing_request: true,
          ...existing,
        });
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

      return jsonTextResponse({
        success: true,
        ...pendingAuth,
      });
    },
  );
}

function registerPollDeviceAuthTool(server: McpServer): void {
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
        return jsonTextResponse({
          success: false,
          error: "No pending device auth request found.",
        });
      }

      const requestId = request_id || pendingAuth?.request_id;
      if (!requestId) {
        return jsonTextResponse({
          success: false,
          error: "A request_id is required when nothing is saved locally.",
        });
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

        return jsonTextResponse({ success: true, ...result });
      }

      if (result.status === "denied" || result.status === "expired") {
        clearPendingDeviceAuth();
        clearStoredAuth();
        clearAuthenticatedAccountCache();
        return jsonTextResponse({ success: false, ...result });
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
        const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
          roomToJoin,
          joinedVia,
          { fallbackToRepo: true }
        );
        joinedRoom = joined.room;
      }

      const agentIdentity = await ensureAgentIdentity();

      return jsonTextResponse({
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
      });
    },
  );
}

function registerClearSavedAuthTool(server: McpServer): void {
  server.tool(
    "clear_saved_auth",
    "Clear any locally saved LetAgents auth token and pending device auth request.",
    {},
    async () => {
      clearPendingDeviceAuth();
      clearStoredAuth();
      clearAuthenticatedAccountCache();
      return jsonTextResponse({
        success: true,
        env_token_still_present: Boolean(process.env.LETAGENTS_TOKEN),
      });
    },
  );
}
