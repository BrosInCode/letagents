import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getRoomFromConfig } from "../../../config-reader.js";
import { getGitRemoteIdentity } from "../../../git-remote.js";
import { resolveGitRoot } from "../../repo-context.js";
import {
  API_URL,
  currentAgentIdentity,
  currentAgentIdentityKey,
  currentRoom,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  toPublicAgentIdentity,
  toPublicRoomState,
  toPublicStoredRoomSession,
} from "../../runtime.js";
import { jsonTextResponse } from "./responses.js";

export function registerGetOnboardingStatusTool(server: McpServer): void {
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

      return jsonTextResponse({
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
          currentAgentIdentity ?? getStoredAgentIdentity(currentAgentIdentityKey),
        ),
        current_room: toPublicRoomState(currentRoom),
        saved_current_room: toPublicStoredRoomSession(savedCurrentRoom),
        detected_room_from_context: detectedRoom,
        repo_root: repoRoot,
        next_step: nextStep,
      });
    },
  );
}
