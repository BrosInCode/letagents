import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { getGitRemoteIdentity } from "../../git-remote.js";
import { getRoomFromConfig } from "../../config-reader.js";
import { findExistingConfig, resolveGitRoot } from "../repo-context.js";
import {
  RepoRoomAuthRequiredError,
  createInviteRoom,
  currentAgentIdentity,
  currentAgentIdentityKey,
  currentRoom,
  ensureAgentIdentity,
  getConversationIdentity,
  getCurrentLiveSessionPayload,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  joinInviteCode,
  joinNamedRoom,
  joinRoomIdentifier,
  listStoredCodexLiveSessions,
  normalizeJoinSessionMode,
  toPublicAgentIdentity,
  toPublicRoomState,
  toRepoRoomAuthRequiredResult,
  withJoinRoomAgentPrompt,
} from "../runtime.js";

export function registerRoomJoinTools(server: McpServer): void {
  // -- create_room ------------------------------------------------------------

  server.tool(
    "create_room",
    "Create a new invite room on Let Agents Chat. Returns the room ID and join code.",
    {},
    async () => {
      const created = await createInviteRoom();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(withJoinRoomAgentPrompt(created.response), null, 2),
          },
        ],
      };
    }
  );

  // -- create_project ---------------------------------------------------------

  server.tool(
    "create_project",
    "Legacy alias for create_room. Creates a new invite room and returns its join code.",
    {},
    async () => {
      const created = await createInviteRoom();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(withJoinRoomAgentPrompt(created.response), null, 2),
          },
        ],
      };
    }
  );

  // -- join_code --------------------------------------------------------------

  server.tool(
    "join_code",
    "Join an existing room using an invite code.",
    {
      code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
      session_mode: z
        .enum(["live", "current"])
        .optional()
        .describe("Use 'current' (default) for a normal inline join. Use 'live' to start/reuse a detached local Codex room worker."),
    },
    async ({ code, session_mode }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)), null, 2),
          },
        ],
      };
    }
  );

  // -- join_project -----------------------------------------------------------

  server.tool(
    "join_project",
    "Legacy alias for join_code. Join an existing room using an invite code.",
    {
      code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
      session_mode: z
        .enum(["live", "current"])
        .optional()
        .describe("Use 'current' (default) for a normal inline join. Use 'live' to start/reuse a detached local Codex room worker."),
    },
    async ({ code, session_mode }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)), null, 2),
          },
        ],
      };
    }
  );

  // -- join_room --------------------------------------------------------------

  server.tool(
    "join_room",
    "Join a named room on Let Agents Chat. Creates the room if it doesn't exist. Use this for repo-based room joining.",
    {
      name: z.string().describe("The room name to join (e.g. 'github.com/owner/repo')"),
      session_mode: z
        .enum(["live", "current"])
        .optional()
        .describe("Use 'current' (default) for a normal inline join. Use 'live' to start/reuse a detached local Codex room worker."),
    },
    async ({ name, session_mode }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await joinNamedRoom(name, normalizeJoinSessionMode(session_mode)), null, 2),
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

}

export function registerRoomInspectionTools(server: McpServer): void {
  // -- get_current_room -------------------------------------------------------

  server.tool(
    "get_current_room",
    "Get information about the currently joined room, including how it was joined.",
    {
      conversation_id: z
        .string()
        .optional()
        .describe("Optional conversation ID to report the conversation-scoped identity instead of the global one."),
    },
    async ({ conversation_id }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              currentRoom
                ? withJoinRoomAgentPrompt({
                    connected: true,
                    ...toPublicRoomState(currentRoom),
                    current_local_codex_session: getCurrentLiveSessionPayload(currentRoom.room_id),
                    local_codex_session_count: listStoredCodexLiveSessions().length,
                    agent_identity: toPublicAgentIdentity(
                      getConversationIdentity(conversation_id)
                        ?? currentAgentIdentity
                        ?? getStoredAgentIdentity(currentAgentIdentityKey)
                    ),
                    auth: getStoredAuth()
                      ? {
                          source: process.env.LETAGENTS_TOKEN ? "env" : "local_state",
                          expires_at: getStoredAuth()?.expires_at ?? null,
                          account: getStoredAuth()?.account ?? null,
                        }
                      : null,
                  })
                : {
                    connected: false,
                    message: "Not currently in any room",
                    current_local_codex_session: getCurrentLiveSessionPayload(),  // no room context
                    local_codex_session_count: listStoredCodexLiveSessions().length,
                  },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // -- check_repo -------------------------------------------------------------

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
    async ({ cwd: targetDir }) => {
      const startDir = targetDir || process.cwd();

      const repoRoot = resolveGitRoot(startDir);
      const configDir = repoRoot ? findExistingConfig(startDir) : null;
      const configPath = configDir ? join(configDir, ".letagents.json") : null;

      let configContents: unknown = null;
      if (configPath && existsSync(configPath)) {
        try {
          const { readFileSync } = await import("fs");
          configContents = JSON.parse(readFileSync(configPath, "utf-8"));
        } catch {
          configContents = "<parse error>";
        }
      }

      const derivedRoom = repoRoot ? getGitRemoteIdentity(repoRoot) : null;
      const configuredRoom = repoRoot ? getRoomFromConfig(startDir) : null;
      const detectedRoom = configuredRoom || derivedRoom;
      const publicCurrentRoom = toPublicRoomState(currentRoom);
      const currentRoomMatchesContext = Boolean(
        currentRoom && detectedRoom && currentRoom.room_id === detectedRoom
      );
      const currentRoomScope = !currentRoom
        ? "none"
        : currentRoomMatchesContext
          ? "matches_detected_repo_context"
          : "existing_joined_session_not_derived_from_inspected_cwd";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                cwd: startDir,
                repo_context_status: repoRoot
                  ? "git_repo_detected"
                  : "not_inside_git_repo",
                git_repo_root: repoRoot ?? null,
                config_file: configPath ?? null,
                config_contents: configContents,
                configured_room_from_file: configuredRoom ?? null,
                derived_room_from_git: derivedRoom ?? null,
                detected_room_from_context: detectedRoom ?? null,
                current_room: publicCurrentRoom,
                current_room_scope: currentRoomScope,
                warning: !repoRoot && currentRoom
                  ? "The inspected cwd is not inside a git repo. current_room is only the previously joined MCP room session, not a room derived from this cwd."
                  : repoRoot && currentRoom && detectedRoom && !currentRoomMatchesContext
                    ? "The current joined room differs from the room detected for this repo context."
                    : null,
                join_hint: repoRoot
                  ? detectedRoom
                    ? currentRoomMatchesContext
                      ? null
                      : "Use join_room with detected_room_from_context to switch this MCP session to the repo room."
                    : "Run initialize_repo to set up .letagents.json, or use join_room/join_code to connect."
                  : "Not inside a git repo. Use create_room, join_code, or join_room to connect manually.",
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

export function registerRepoInitializationTool(server: McpServer): void {
  server.tool(
    "initialize_repo",
    "Initialize the current repo for Let Agents Chat by creating a .letagents.json config file. " +
      "This explicitly sets up repo-based room auto-join. Reads git remote to derive the room name, " +
      "or accepts a custom room name. Will NOT overwrite an existing .letagents.json. " +
      "Always writes to the repo root, not the current working directory.",
    {
      room: z
        .string()
        .optional()
        .describe(
          "Custom room name. If omitted, auto-derived from git remote (e.g. 'github.com/owner/repo')"
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory hint for repo detection. Defaults to the current process directory."
        ),
    },
    async ({ room, cwd: targetDir }) => {
      const startDir = targetDir || process.cwd();

      // Resolve true git repo root — never write to a subdirectory
      const repoRoot = resolveGitRoot(startDir);
      if (!repoRoot) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: "Not inside a git repository",
                  hint: "Run this tool from inside a git repo, or pass a 'cwd' pointing to one.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Walk parent dirs from startDir (not repoRoot) to catch configs in subtrees below caller
      const existingConfigDir = findExistingConfig(startDir);
      if (existingConfigDir) {
        const existingPath = join(existingConfigDir, ".letagents.json");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: ".letagents.json already exists",
                  path: existingPath,
                  hint: existingConfigDir === repoRoot
                    ? "Delete the existing file first if you want to reinitialize."
                    : `Found a config in a parent directory (${existingConfigDir}). Delete it or move it to ${repoRoot} to reinitialize.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const configPath = join(repoRoot, ".letagents.json");

      // Safety check (shouldn't be needed after findExistingConfig, but defensive)
      if (existsSync(configPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: ".letagents.json already exists",
                  path: configPath,
                  hint: "Delete the existing file first if you want to reinitialize.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Determine room name
      let roomName = room;
      if (!roomName) {
        const gitRoom = getGitRemoteIdentity(repoRoot);
        if (!gitRoom) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    error:
                      "Cannot derive room name: no git remote found and no custom room name provided",
                    hint: "Pass a 'room' parameter or run from inside a git repo with a remote configured.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        roomName = gitRoom;
      }

      // Write the config file
      const config = { room: roomName };
      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: `Failed to write config: ${err instanceof Error ? err.message : err}`,
                  path: configPath,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Auto-join the room after creating config
      try {
        const joined = await joinRoomIdentifier(roomName, "config");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  created: configPath,
                  room_id: joined.room.room_id,
                  code: joined.room.code ?? null,
                  joined: true,
                  hint: "Consider adding .letagents.json to git so other contributors auto-join the same room.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        // Config was created but auto-join failed
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  created: configPath,
                  room_id: roomName,
                  joined: false,
                  error: `Config created but auto-join failed: ${err instanceof Error ? err.message : err}`,
                  hint: "The .letagents.json was created. Use join_room to manually connect.",
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

export function registerRoomResumeTool(server: McpServer): void {
  server.tool(
    "resume_room_session",
    "Rejoin the last locally saved room context, or a specific saved room, after a restart. This recreates participation in the room; it does not preserve a prior server-side session ID.",
    {
      room_id: z
        .string()
        .optional()
        .describe("Optional saved room ID to resume. Defaults to the last current room."),
    },
    async ({ room_id }) => {
      const savedRoom =
        (room_id ? getStoredRoomSession(room_id) : null) ??
        getStoredCurrentRoom();

      if (!savedRoom) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: "No saved room session found." },
                null,
                2
              ),
            },
          ],
        };
      }

      try {
        const joined = await joinRoomIdentifier(savedRoom.room_id, savedRoom.joined_via);
        const agentIdentity = await ensureAgentIdentity();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                withJoinRoomAgentPrompt({
                  success: true,
                  rejoined_from_local_state: true,
                  server_session_resumed: false,
                  last_message_id_before_restart: savedRoom.last_message_id ?? null,
                  room: toPublicRoomState(joined.room),
                  agent_identity: toPublicAgentIdentity(agentIdentity),
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

}

export function registerRepoVisibilityTool(server: McpServer): void {
  // -- check_repo_visibility --------------------------------------------------

  server.tool(
    "check_repo_visibility",
    "Auto-detect the current repo's git remote and check if it's public or private. Returns the canonical key, provider, visibility, and suggested room type (discoverable for public, invite for private/unknown). Useful for deciding whether to auto-join a discoverable room or create an invite room.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Working directory to detect git remote from. Defaults to the MCP server's working directory."),
    },
    async ({ cwd }) => {
      const { autoDetectRepo } = await import("../../repo-visibility.js");

      const result = await autoDetectRepo(cwd);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Not in a git repository or no remote configured",
                suggestion: "Use create_room to create an invite room instead",
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
