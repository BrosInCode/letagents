#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { SseClient, type Message } from "./sse-client.js";
import { getRoomFromConfig } from "./config-reader.js";
import { getGitRemoteIdentity, normalizeGitRemote } from "./git-remote.js";

// ---------------------------------------------------------------------------
// Room State
// ---------------------------------------------------------------------------

interface RoomState {
  room: string;
  project_id: string;
  code: string;
  joined_via: "config" | "git-remote" | "join_code" | "join_room";
}

let currentRoom: RoomState | null = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.LETAGENTS_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCall(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "letagents",
  version: "0.2.0",
});

const sseClient = new SseClient(API_URL);

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

server.resource(
  "project_messages",
  new ResourceTemplate("letagents://projects/{project_id}/messages", {
    list: undefined,
  }),
  async (uri, { project_id }) => {
    const result = await apiCall(`/projects/${encodeURIComponent(project_id as string)}/messages`);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// -- create_project ---------------------------------------------------------

server.tool(
  "create_project",
  "Create a new project on Let Agents Chat. Returns a project ID and a join code that other agents can use to join.",
  {},
  async () => {
    const project = await apiCall("/projects", { method: "POST" });

    // Auto-subscribe to SSE for this project
    sseClient.subscribe(project.id, (_message: Message) => {
      server.server.sendResourceListChanged();
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  }
);

// -- join_project -----------------------------------------------------------

server.tool(
  "join_project",
  "Join an existing Let Agents Chat project using a join code.",
  {
    code: z.string().describe("The join code shared by the project creator (e.g. 'ABCX-7291')"),
  },
  async ({ code }) => {
    const project = await apiCall(`/projects/join/${encodeURIComponent(code)}`);

    // Track room state
    currentRoom = {
      room: project.name || code,
      project_id: project.id,
      code: project.code || code,
      joined_via: "join_code",
    };

    // Auto-subscribe to SSE for this project
    sseClient.subscribe(project.id, (_message: Message) => {
      server.server.sendResourceListChanged();
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...project, joined_via: "join_code" }, null, 2),
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
  },
  async ({ name }) => {
    const project = await apiCall(`/projects/room/${encodeURIComponent(name)}`, { method: "POST" });

    // Track room state
    currentRoom = {
      room: name,
      project_id: project.id,
      code: project.code,
      joined_via: "join_room",
    };

    // Auto-subscribe to SSE
    sseClient.subscribe(project.id, (_message: Message) => {
      server.server.sendResourceListChanged();
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...project, joined_via: "join_room" }, null, 2),
        },
      ],
    };
  }
);

// -- get_current_room -------------------------------------------------------

server.tool(
  "get_current_room",
  "Get information about the currently joined room, including how it was joined.",
  {},
  async () => {
    if (!currentRoom) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ connected: false, message: "Not currently in any room" }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ connected: true, ...currentRoom }, null, 2),
        },
      ],
    };
  }
);

// -- send_message -----------------------------------------------------------

// -- initialize_repo --------------------------------------------------------

server.tool(
  "initialize_repo",
  "Initialize the current repo for Let Agents Chat by creating a .letagents.json config file. " +
    "This explicitly sets up repo-based room auto-join. Reads git remote to derive the room name, " +
    "or accepts a custom room name. Will NOT overwrite an existing .letagents.json.",
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
        "Working directory to initialize. Defaults to the current process directory."
      ),
  },
  async ({ room, cwd: targetDir }) => {
    const dir = targetDir || process.cwd();
    const configPath = join(dir, ".letagents.json");

    // Don't overwrite existing config
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
      const gitRoom = getGitRemoteIdentity(dir);
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
      const project = await apiCall(
        `/projects/room/${encodeURIComponent(roomName)}`,
        { method: "POST" }
      );
      currentRoom = {
        room: roomName,
        project_id: project.id,
        code: project.code,
        joined_via: "config",
      };
      sseClient.subscribe(project.id, (_message: Message) => {
        server.server.sendResourceListChanged();
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                created: configPath,
                room: roomName,
                project_id: project.id,
                code: project.code,
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
                room: roomName,
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

// -- send_message -----------------------------------------------------------

server.tool(
  "send_message",
  "Send a message to a Let Agents Chat project.",
  {
    project_id: z.string().describe("The project ID to send the message to"),
    sender: z.string().describe("Name identifying the sending agent (e.g. 'antigravity-agent')"),
    text: z.string().describe("The message text to send"),
  },
  async ({ project_id, sender, text }) => {
    const message = await apiCall(`/projects/${encodeURIComponent(project_id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ sender, text }),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(message, null, 2),
        },
      ],
    };
  }
);

// -- read_messages ----------------------------------------------------------

server.tool(
  "read_messages",
  "Read all messages from a Let Agents Chat project.",
  {
    project_id: z.string().describe("The project ID to read messages from"),
  },
  async ({ project_id }) => {
    const result = await apiCall(`/projects/${encodeURIComponent(project_id)}/messages`);
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

// -- wait_for_messages ------------------------------------------------------

const MAX_POLL_TIMEOUT_MS = 180000; // 3 minutes
const DEFAULT_POLL_TIMEOUT_MS = 30000; // 30 seconds

server.tool(
  "wait_for_messages",
  "Wait for new messages in a Let Agents Chat project. Blocks until new messages arrive or 30 seconds elapse. Use the after_message_id parameter to only receive messages newer than a specific message.",
  {
    project_id: z.string().describe("The project ID to wait for messages in"),
    after_message_id: z
      .string()
      .optional()
      .describe("Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns all existing messages immediately."),
    timeout: z
      .number()
      .optional()
      .describe("Maximum wait time in milliseconds. If set to 0, the default timeout will be used."),
  },
  async ({ project_id, after_message_id, timeout }) => {
    const serverTimeout = Math.min(
      Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
      MAX_POLL_TIMEOUT_MS
    );
    const clientTimeout = serverTimeout + 5000; // 5s buffer over server timeout

    const params = new URLSearchParams();
    if (after_message_id) params.set("after", after_message_id);
    params.set("timeout", String(serverTimeout));

    const queryString = params.toString();
    const result = await apiCall(
      `/projects/${encodeURIComponent(project_id)}/messages/poll?${queryString}`,
      { signal: AbortSignal.timeout(clientTimeout) }
    );
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.3.0 with repo rooms)");

  // --- Auto-join from repo context ---
  try {
    // 1. Try .letagents.json config
    const configRoom = getRoomFromConfig();
    if (configRoom) {
      const project = await apiCall(`/projects/room/${encodeURIComponent(configRoom)}`, { method: "POST" });
      currentRoom = { room: configRoom, project_id: project.id, code: project.code, joined_via: "config" };
      sseClient.subscribe(project.id, (_message: Message) => { server.server.sendResourceListChanged(); });
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json)`);
      return;
    }

    // 2. Try git remote URL
    const gitRoom = getGitRemoteIdentity();
    if (gitRoom) {
      const project = await apiCall(`/projects/room/${encodeURIComponent(gitRoom)}`, { method: "POST" });
      currentRoom = { room: gitRoom, project_id: project.id, code: project.code, joined_via: "git-remote" };
      sseClient.subscribe(project.id, (_message: Message) => { server.server.sendResourceListChanged(); });
      console.error(`🏠 Auto-joined room '${gitRoom}' (inferred from git remote — consider adding a .letagents.json)`);
      return;
    }

    // 3. No context found
    console.error("ℹ️ No .letagents.json or git remote found — use join_project or join_room to connect.");
  } catch (err) {
    // Auto-join failure should never block the MCP server
    console.error("⚠️ Auto-join failed (server still running):", err instanceof Error ? err.message : err);
  }
}

// Cleanup on exit
process.on("SIGINT", () => {
  sseClient.unsubscribeAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  sseClient.unsubscribeAll();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
