import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { getGitRemoteIdentity } from "../../../git-remote.js";
import {
  joinRoomIdentifier,
} from "../../runtime.js";
import {
  findExistingConfig,
  resolveGitRoot,
} from "../../repo-context.js";
import { jsonToolResponse } from "./response.js";

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
      const repoRoot = resolveGitRoot(startDir);
      if (!repoRoot) {
        return jsonToolResponse({
          success: false,
          error: "Not inside a git repository",
          hint: "Run this tool from inside a git repo, or pass a 'cwd' pointing to one.",
        });
      }

      const existingConfigResponse = getExistingConfigResponse(startDir, repoRoot);
      if (existingConfigResponse) return jsonToolResponse(existingConfigResponse);

      const roomNameResult = resolveRoomName(room, repoRoot);
      if (!roomNameResult.success) return jsonToolResponse(roomNameResult);

      const configPath = join(repoRoot, ".letagents.json");
      try {
        writeFileSync(
          configPath,
          JSON.stringify({ room: roomNameResult.roomName }, null, 2) + "\n",
          "utf-8"
        );
      } catch (err) {
        return jsonToolResponse({
          success: false,
          error: `Failed to write config: ${err instanceof Error ? err.message : err}`,
          path: configPath,
        });
      }

      return jsonToolResponse(
        await joinInitializedRoom({
          configPath,
          roomName: roomNameResult.roomName,
        })
      );
    }
  );
}

function getExistingConfigResponse(startDir: string, repoRoot: string) {
  const existingConfigDir = findExistingConfig(startDir);
  if (existingConfigDir) {
    const existingPath = join(existingConfigDir, ".letagents.json");
    return {
      success: false,
      error: ".letagents.json already exists",
      path: existingPath,
      hint: existingConfigDir === repoRoot
        ? "Delete the existing file first if you want to reinitialize."
        : `Found a config in a parent directory (${existingConfigDir}). Delete it or move it to ${repoRoot} to reinitialize.`,
    };
  }

  const configPath = join(repoRoot, ".letagents.json");
  if (existsSync(configPath)) {
    return {
      success: false,
      error: ".letagents.json already exists",
      path: configPath,
      hint: "Delete the existing file first if you want to reinitialize.",
    };
  }

  return null;
}

function resolveRoomName(room: string | undefined, repoRoot: string) {
  if (room) return { success: true as const, roomName: room };

  const gitRoom = getGitRemoteIdentity(repoRoot);
  if (!gitRoom) {
    return {
      success: false as const,
      error: "Cannot derive room name: no git remote found and no custom room name provided",
      hint: "Pass a 'room' parameter or run from inside a git repo with a remote configured.",
    };
  }

  return { success: true as const, roomName: gitRoom };
}

async function joinInitializedRoom(input: {
  configPath: string;
  roomName: string;
}) {
  try {
    const joined = await joinRoomIdentifier(input.roomName, "config");

    return {
      success: true,
      created: input.configPath,
      room_id: joined.room.room_id,
      code: joined.room.code ?? null,
      joined: true,
      hint: "Consider adding .letagents.json to git so other contributors auto-join the same room.",
    };
  } catch (err) {
    return {
      success: true,
      created: input.configPath,
      room_id: input.roomName,
      joined: false,
      error: `Config created but auto-join failed: ${err instanceof Error ? err.message : err}`,
      hint: "The .letagents.json was created. Use join_room to manually connect.",
    };
  }
}
