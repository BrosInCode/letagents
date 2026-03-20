#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { SseClient, type Message } from "./sse-client.js";
import { getRoomFromConfig } from "./config-reader.js";
import { getGitRemoteIdentity } from "./git-remote.js";

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

/**
 * Resolve the root of the git repository containing `dir`.
 * Returns null if `dir` is not inside a git repo.
 */
function resolveGitRoot(dir: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Walk from `startDir` up to the filesystem root, returning the first
 * directory that contains `.letagents.json`, or null if none found.
 */
function findExistingConfig(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".letagents.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break; // reached fs root
    current = parent;
  }
  return null;
}

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

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              cwd: startDir,
              git_repo_root: repoRoot ?? null,
              config_file: configPath ?? null,
              config_contents: configContents,
              derived_room_from_git: derivedRoom ?? null,
              current_room: currentRoom ?? null,
              join_hint: !currentRoom
                ? repoRoot
                  ? "Run initialize_repo to set up .letagents.json, or join_room/join_project to connect."
                  : "Not inside a git repo. Use join_project or join_room to connect manually."
                : null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- post_status ------------------------------------------------------------

server.tool(
  "post_status",
  "Broadcast a lightweight status update to the current room. " +
    "Use this to let other agents and humans know what you are currently doing, " +
    "e.g. 'reviewing PR #2', 'waiting for tests', 'writing WISHLIST.md'. " +
    "Status updates are distinct from chat messages and can be filtered separately.",
  {
    sender: z.string().describe("Name of the agent posting the status (e.g. 'codex-agent')"),
    status: z.string().describe("Short status description (e.g. 'reviewing PR #2', 'idle', 'thinking...')"),
    project_id: z
      .string()
      .optional()
      .describe("Project ID to post status to. Defaults to the current room if joined."),
  },
  async ({ sender, status, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;

    if (!targetProjectId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: "No project_id provided and not currently in a room.",
                hint: "Join a room first with join_project or join_room, or pass project_id explicitly.",
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
    const statusText = `[status] ${status}`;

    const message = await apiCall(
      `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ sender, text: statusText }),
      }
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              status_posted: status,
              sender,
              message_id: message.id,
              timestamp: message.timestamp,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- Task Board Tools -------------------------------------------------------

const TASK_STATUSES = [
  "proposed", "accepted", "assigned", "in_progress",
  "blocked", "in_review", "merged", "done", "cancelled",
] as const;

server.tool(
  "add_task",
  "Add a new task to the project board. Tasks start as 'proposed' and must be " +
    "accepted before an agent can claim them. Use this when a human or agent " +
    "identifies work that needs to be done.",
  {
    title: z.string().describe("Short task title, e.g. 'Wire up Jest test runner'"),
    description: z.string().optional().describe("Longer description of what needs to be done"),
    created_by: z.string().describe("Name of the agent or human creating the task"),
    source_message_id: z.string().optional().describe("Optional message ID where task was agreed, e.g. 'msg_42'"),
    project_id: z.string().optional().describe("Project ID. Defaults to current room."),
  },
  async ({ title, description, created_by, source_message_id, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;
    if (!targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const task = await apiCall(
      `/projects/${encodeURIComponent(targetProjectId)}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({ title, description, created_by, source_message_id }),
      }
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true, task }, null, 2) }],
    };
  }
);

server.tool(
  "get_board",
  "Get the current task board for the project. By default shows only open tasks " +
    "(not done/cancelled). Agents should check this on startup and when idle to " +
    "see if there is unassigned work to claim.",
  {
    status: z.enum(TASK_STATUSES).optional().describe("Filter by specific status"),
    open_only: z.boolean().optional().describe("If true (default), only show tasks not done/cancelled"),
    project_id: z.string().optional().describe("Project ID. Defaults to current room."),
  },
  async ({ status, open_only, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;
    if (!targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (open_only !== false) params.set("open", "true");

    const qs = params.toString();
    const result = await apiCall(
      `/projects/${encodeURIComponent(targetProjectId)}/tasks${qs ? `?${qs}` : ""}`
    );

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) }],
    };
  }
);

server.tool(
  "claim_task",
  "Claim an accepted task. The task must be in 'accepted' " +
    "status. This sets the assignee to you and moves the status to 'assigned'. " +
    "Do NOT claim proposed tasks — they need to be accepted first.",
  {
    task_id: z.string().describe("The task ID to claim, e.g. 'task_1'"),
    assignee: z.string().describe("Your agent name, e.g. 'antigravity'"),
    project_id: z.string().optional().describe("Project ID. Defaults to current room."),
  },
  async ({ task_id, assignee, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;
    if (!targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await apiCall(
        `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "assigned", assignee }),
        }
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, task: updated }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

server.tool(
  "update_task",
  "Update a task's status or assignee. Status transitions are validated — " +
    "only valid transitions are allowed (e.g. in_progress → in_review, " +
    "but NOT proposed → in_progress).",
  {
    task_id: z.string().describe("The task ID to update"),
    status: z.enum(TASK_STATUSES).optional().describe("New status for the task"),
    assignee: z.string().optional().describe("New assignee for the task"),
    pr_url: z.string().optional().describe("PR URL to link to the task"),
    project_id: z.string().optional().describe("Project ID. Defaults to current room."),
  },
  async ({ task_id, status, assignee, pr_url, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;
    if (!targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await apiCall(
        `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status, assignee, pr_url }),
        }
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, task: updated }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

server.tool(
  "complete_task",
  "Submit a task for review. Moves the task to 'in_review' status. " +
    "Optionally attach a PR URL. After this, a reviewer must confirm " +
    "the work is merged before it can be marked done.",
  {
    task_id: z.string().describe("The task ID to submit for review"),
    pr_url: z.string().optional().describe("GitHub PR URL for the work"),
    project_id: z.string().optional().describe("Project ID. Defaults to current room."),
  },
  async ({ task_id, pr_url, project_id }) => {
    const targetProjectId = project_id || currentRoom?.project_id;
    if (!targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await apiCall(
        `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "in_review", pr_url }),
        }
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, task: updated }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

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
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.3.1)");

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
