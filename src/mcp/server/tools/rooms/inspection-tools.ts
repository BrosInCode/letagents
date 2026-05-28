import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { getRoomFromConfig } from "../../../config-reader.js";
import { getGitRemoteIdentity } from "../../../git-remote.js";
import {
  currentAgentIdentity,
  currentAgentIdentityKey,
  currentRoom,
  getConversationIdentity,
  getCurrentLiveSessionPayload,
  getStoredAgentIdentity,
  getStoredAuth,
  listStoredCodexLiveSessions,
  toPublicAgentIdentity,
  toPublicRoomState,
  withJoinRoomAgentPrompt,
} from "../../runtime.js";
import {
  findExistingConfig,
  resolveGitRoot,
} from "../../repo-context.js";
import { jsonToolResponse } from "./response.js";

export function registerRoomInspectionTools(server: McpServer): void {
  server.tool(
    "get_current_room",
    "Get information about the currently joined room, including how it was joined.",
    {
      conversation_id: z
        .string()
        .optional()
        .describe("Optional conversation ID to report the conversation-scoped identity instead of the global one."),
    },
    async ({ conversation_id }) => jsonToolResponse(getCurrentRoomPayload(conversation_id))
  );

  server.tool(
    "check_repo",
    "Inspect the current repository context for Let Agents Chat. " +
      "Shows the git repo root, detected .letagents.json path, auto-derived room name from git remote, " +
      "and current room state. Useful for troubleshooting auto-join issues.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Directory to inspect. Defaults to the current process directory."),
    },
    async ({ cwd: targetDir }) => jsonToolResponse(getRepoInspectionPayload(targetDir))
  );
}

function getCurrentRoomPayload(conversationId?: string) {
  if (!currentRoom) {
    return {
      connected: false,
      message: "Not currently in any room",
      current_local_codex_session: getCurrentLiveSessionPayload(),
      local_codex_session_count: listStoredCodexLiveSessions().length,
    };
  }

  const auth = getStoredAuth();
  return withJoinRoomAgentPrompt({
    connected: true,
    ...toPublicRoomState(currentRoom),
    current_local_codex_session: getCurrentLiveSessionPayload(currentRoom.room_id),
    local_codex_session_count: listStoredCodexLiveSessions().length,
    agent_identity: toPublicAgentIdentity(
      getConversationIdentity(conversationId)
        ?? currentAgentIdentity
        ?? getStoredAgentIdentity(currentAgentIdentityKey)
    ),
    auth: auth
      ? {
          source: process.env.LETAGENTS_TOKEN ? "env" : "local_state",
          expires_at: auth.expires_at ?? null,
          account: auth.account ?? null,
        }
      : null,
  });
}

function getRepoInspectionPayload(targetDir?: string) {
  const startDir = targetDir || process.cwd();
  const repoRoot = resolveGitRoot(startDir);
  const configDir = repoRoot ? findExistingConfig(startDir) : null;
  const configPath = configDir ? join(configDir, ".letagents.json") : null;
  const configuredRoom = repoRoot ? getRoomFromConfig(startDir) : null;
  const derivedRoom = repoRoot ? getGitRemoteIdentity(repoRoot) : null;
  const detectedRoom = configuredRoom || derivedRoom;
  const currentRoomMatchesContext = Boolean(
    currentRoom && detectedRoom && currentRoom.room_id === detectedRoom
  );

  return {
    cwd: startDir,
    repo_context_status: repoRoot ? "git_repo_detected" : "not_inside_git_repo",
    git_repo_root: repoRoot ?? null,
    config_file: configPath ?? null,
    config_contents: readConfigContents(configPath),
    configured_room_from_file: configuredRoom ?? null,
    derived_room_from_git: derivedRoom ?? null,
    detected_room_from_context: detectedRoom ?? null,
    current_room: toPublicRoomState(currentRoom),
    current_room_scope: currentRoomScope(currentRoomMatchesContext, detectedRoom),
    warning: repoWarning({ repoRoot, detectedRoom, currentRoomMatchesContext }),
    join_hint: joinHint({ repoRoot, detectedRoom, currentRoomMatchesContext }),
  };
}

function readConfigContents(configPath: string | null): unknown {
  if (!configPath || !existsSync(configPath)) return null;

  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return "<parse error>";
  }
}

function currentRoomScope(
  currentRoomMatchesContext: boolean,
  detectedRoom: string | null
): string {
  if (!currentRoom) return "none";
  return currentRoomMatchesContext && detectedRoom
    ? "matches_detected_repo_context"
    : "existing_joined_session_not_derived_from_inspected_cwd";
}

function repoWarning(input: {
  repoRoot: string | null;
  detectedRoom: string | null;
  currentRoomMatchesContext: boolean;
}): string | null {
  if (!input.repoRoot && currentRoom) {
    return "The inspected cwd is not inside a git repo. current_room is only the previously joined MCP room session, not a room derived from this cwd.";
  }
  if (input.repoRoot && currentRoom && input.detectedRoom && !input.currentRoomMatchesContext) {
    return "The current joined room differs from the room detected for this repo context.";
  }
  return null;
}

function joinHint(input: {
  repoRoot: string | null;
  detectedRoom: string | null;
  currentRoomMatchesContext: boolean;
}): string | null {
  if (!input.repoRoot) {
    return "Not inside a git repo. Use create_room, join_code, or join_room to connect manually.";
  }
  if (!input.detectedRoom) {
    return "Run initialize_repo to set up .letagents.json, or use join_room/join_code to connect.";
  }
  return input.currentRoomMatchesContext
    ? null
    : "Use join_room with detected_room_from_context to switch this MCP session to the repo room.";
}
