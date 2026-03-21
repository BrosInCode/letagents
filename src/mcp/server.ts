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
import {
  clearPendingDeviceAuth,
  clearStoredAuth,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  readLocalState,
  saveRoomSession,
  setPendingDeviceAuth,
  setStoredAuth,
  touchRoomSession,
  type StoredAccount,
} from "./local-state.js";
import {
  encodeRoomIdPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "./room-id.js";

// ---------------------------------------------------------------------------
// Room State
// ---------------------------------------------------------------------------

interface RoomState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  joined_via: JoinedVia;
}

let currentRoom: RoomState | null = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");
const AGENT_NAME = (process.env.LETAGENTS_AGENT_NAME || process.env.AGENT_NAME || "").trim();
const AGENT_DISPLAY_NAME = (process.env.LETAGENTS_AGENT_DISPLAY_NAME || "").trim();
const AGENT_OWNER_LABEL = (process.env.LETAGENTS_AGENT_OWNER_LABEL || "").trim();

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

class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function getLetagentsToken(): string {
  return process.env.LETAGENTS_TOKEN || getStoredAuth()?.token || "";
}

function getAuthorizationHeader(): string | null {
  const letagentsToken = getLetagentsToken();
  if (letagentsToken) {
    return `Bearer ${letagentsToken}`;
  }

  return null;
}

function isMissingRouteError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405) &&
    /Cannot (GET|POST|PATCH)|Not Found|Cannot GET \/rooms|Cannot POST \/rooms/i.test(error.body)
  );
}

async function apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  const authorizationHeader = getAuthorizationHeader();
  if (authorizationHeader && !headers.Authorization) {
    headers.Authorization = authorizationHeader;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      // Only clear on 401 (invalid/expired credential), NOT on 403
      // (valid credential but insufficient permissions, e.g., private repo access)
      clearStoredAuth();
    }
    throw new ApiError(res.status, body);
  }

  const body = await res.text();
  if (!body) {
    return null as T;
  }

  return JSON.parse(body) as T;
}

function toRoomState(input: {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  joined_via: JoinedVia;
}): RoomState {
  return {
    room_id: input.room_id,
    project_id: input.project_id ?? null,
    code: input.code ?? null,
    joined_via: input.joined_via,
  };
}

function rememberRoom(state: RoomState, lastMessageId?: string): RoomState {
  currentRoom = state;
  saveRoomSession({
    room_id: state.room_id,
    project_id: state.project_id ?? null,
    code: state.code ?? null,
    joined_via: state.joined_via,
    last_message_id: lastMessageId,
  });
  sseClient.unsubscribeAll();
  sseClient.subscribe(
    {
      roomId: state.room_id,
      projectId: state.project_id ?? null,
    },
    (_message: Message) => {
      touchRoomSession(state.room_id);
      server.server.sendResourceListChanged();
    }
  );
  return state;
}

function touchCurrentRoom(lastMessageId?: string): void {
  if (!currentRoom) {
    return;
  }

  touchRoomSession(currentRoom.room_id, lastMessageId);
}

function getTargetRoomId(roomId?: string): string | null {
  return roomId || currentRoom?.room_id || null;
}

function getTargetProjectId(projectId?: string): string | null {
  return projectId || currentRoom?.project_id || null;
}

function getLastMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const messages = (payload as { messages?: Array<{ id?: string }> }).messages;
  const lastMessage = messages?.at(-1);
  return typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
}

async function roomScopedApiCall<T>(input: {
  room_id?: string | null;
  project_id?: string | null;
  room_path: (roomId: string) => string;
  project_path: (projectId: string) => string;
  options?: RequestInit;
}): Promise<T> {
  if (input.room_id) {
    try {
      const result = await apiCall<T>(input.room_path(input.room_id), input.options);
      touchRoomSession(input.room_id, getLastMessageId(result));
      return result;
    } catch (error) {
      if (!input.project_id || !isMissingRouteError(error)) {
        throw error;
      }
    }
  }

  if (!input.project_id) {
    throw new Error("No room_id or project_id is available for this request.");
  }

  const result = await apiCall<T>(input.project_path(input.project_id), input.options);
  if (input.room_id) {
    touchRoomSession(input.room_id, getLastMessageId(result));
  }
  return result;
}

async function joinRoomIdentifier(identifier: string, joinedVia: JoinedVia): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const roomId = joinedVia === "join_code" ? normalizeInviteCode(identifier) : identifier.trim();

  try {
    const response = await apiCall<Record<string, unknown>>(
      `/rooms/${encodeRoomIdPath(roomId)}/join`,
      { method: "POST" }
    );
    const joinedRoomId =
      typeof response.room_id === "string"
        ? response.room_id
        : roomId;
    const room = rememberRoom(
      toRoomState({
        room_id: joinedRoomId,
        project_id: typeof response.project_id === "string" ? response.project_id : null,
        code:
          typeof response.code === "string"
            ? response.code
            : looksLikeInviteCode(joinedRoomId)
              ? joinedRoomId
              : null,
        joined_via: joinedVia,
      })
    );
    return {
      room,
      response: { ...response, room_id: joinedRoomId },
    };
  } catch (error) {
    if (!isMissingRouteError(error)) {
      throw error;
    }
  }

  if (joinedVia === "join_code") {
    const project = await apiCall<Record<string, unknown>>(
      `/projects/join/${encodeURIComponent(roomId)}`
    );
    const legacyRoomId =
      typeof project.code === "string"
        ? project.code
        : roomId;
    const room = rememberRoom(
      toRoomState({
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        code: typeof project.code === "string" ? project.code : legacyRoomId,
        joined_via: joinedVia,
      })
    );
    return {
      room,
      response: {
        ...project,
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
      },
    };
  }

  const project = await apiCall<Record<string, unknown>>(
    `/projects/room/${encodeURIComponent(roomId)}`,
    { method: "POST" }
  );
  const legacyRoomId =
    typeof project.name === "string" && project.name.trim()
      ? project.name
      : typeof project.code === "string" && project.code.trim()
        ? project.code
        : roomId;
  const room = rememberRoom(
    toRoomState({
      room_id: legacyRoomId,
      project_id: typeof project.id === "string" ? project.id : null,
      code:
        typeof project.code === "string"
          ? project.code
          : looksLikeInviteCode(legacyRoomId)
            ? legacyRoomId
            : null,
      joined_via: joinedVia,
    })
  );
  return {
    room,
    response: {
      ...project,
      room_id: legacyRoomId,
      project_id: typeof project.id === "string" ? project.id : null,
    },
  };
}

async function autoRegisterAgentIdentity(): Promise<void> {
  if (!AGENT_NAME || !currentRoom) {
    return;
  }

  try {
    await apiCall("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: AGENT_NAME,
        display_name: AGENT_DISPLAY_NAME || AGENT_NAME,
        owner_label: AGENT_OWNER_LABEL || undefined,
      }),
    });
  } catch (error) {
    console.error("Agent identity registration failed:", error);
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "letagents",
  version: "0.2.0",
});

const sseClient = new SseClient(API_URL, () => getLetagentsToken());

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

server.resource(
  "room_messages",
  new ResourceTemplate("letagents://rooms/{room_id}/messages", {
    list: undefined,
  }),
  async (uri, { room_id }) => {
    const normalizedRoomId = String(room_id);
    const storedSession =
      getStoredRoomSession(normalizedRoomId) ??
      (currentRoom?.room_id === normalizedRoomId ? getStoredCurrentRoom() : null);
    const result = await roomScopedApiCall({
      room_id: normalizedRoomId,
      project_id: storedSession?.project_id ?? null,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (projectId) => `/projects/${encodeURIComponent(projectId)}/messages`,
    });
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
    const project = await apiCall<Record<string, unknown>>("/projects", { method: "POST" });
    const roomId =
      typeof project.code === "string"
        ? project.code
        : typeof project.id === "string"
          ? project.id
          : "unknown-room";
    rememberRoom(
      toRoomState({
        room_id: roomId,
        project_id: typeof project.id === "string" ? project.id : null,
        code: typeof project.code === "string" ? project.code : roomId,
        joined_via: "join_code",
      })
    );
    await autoRegisterAgentIdentity();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...project, room_id: roomId }, null, 2),
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
    const joined = await joinRoomIdentifier(code, "join_code");
    await autoRegisterAgentIdentity();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...joined.response, joined_via: "join_code" }, null, 2),
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
    const joined = await joinRoomIdentifier(name, "join_room");
    await autoRegisterAgentIdentity();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...joined.response, joined_via: "join_room" }, null, 2),
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
          text: JSON.stringify(
            {
              connected: true,
              ...currentRoom,
              auth: getStoredAuth()
                ? {
                    source: process.env.LETAGENTS_TOKEN ? "env" : "local_state",
                    expires_at: getStoredAuth()?.expires_at ?? null,
                    account: getStoredAuth()?.account ?? null,
                  }
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
    room_id: z
      .string()
      .optional()
      .describe("Canonical room ID. Defaults to the current room."),
    project_id: z
      .string()
      .optional()
      .describe("Legacy project ID. Defaults to the current room if joined."),
  },
  async ({ sender, status, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);

    if (!targetRoomId && !targetProjectId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: "No room_id or project_id provided and not currently in a room.",
                hint: "Join a room first with join_project or join_room, or pass room_id explicitly.",
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

    const message = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      options: {
        method: "POST",
        body: JSON.stringify({ sender, text: statusText }),
      },
    });
    touchCurrentRoom(typeof message.id === "string" ? message.id : undefined);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              status_posted: status,
              sender,
              message_id: typeof message.id === "string" ? message.id : null,
              timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
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
  "Add a new task to the project board. Tasks normally start as 'proposed' and must be " +
    "accepted before an agent can claim them, but tasks created by trusted agents already " +
    "active in the room may be auto-accepted. Use this when a human or agent identifies " +
    "work that needs to be done.",
  {
    title: z.string().describe("Short task title, e.g. 'Wire up Jest test runner'"),
    description: z.string().optional().describe("Longer description of what needs to be done"),
    created_by: z.string().describe("Name of the agent or human creating the task"),
    source_message_id: z.string().optional().describe("Optional message ID where task was agreed, e.g. 'msg_42'"),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to current room."),
  },
  async ({ title, description, created_by, source_message_id, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const task = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks`,
      options: {
        method: "POST",
        body: JSON.stringify({ title, description, created_by, source_message_id }),
      },
    });

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
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to current room."),
  },
  async ({ status, open_only, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (open_only !== false) params.set("open", "true");

    const qs = params.toString();
    const result = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks${qs ? `?${qs}` : ""}`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks${qs ? `?${qs}` : ""}`,
    });

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
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to current room."),
  },
  async ({ task_id, assignee, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({ status: "assigned", assignee }),
        },
      });

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
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to current room."),
  },
  async ({ task_id, status, assignee, pr_url, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({ status, assignee, pr_url }),
        },
      });

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
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to current room."),
  },
  async ({ task_id, pr_url, room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({ status: "in_review", pr_url }),
        },
      });

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
                project_id: joined.room.project_id ?? null,
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

// -- send_message -----------------------------------------------------------

server.tool(
  "send_message",
  "Send a message to a Let Agents Chat room.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to the current room."),
    sender: z.string().describe("Name identifying the sending agent (e.g. 'antigravity-agent')"),
    text: z.string().describe("The message text to send"),
  },
  async ({ room_id, project_id, sender, text }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    if (!targetRoomId && !targetProjectId) {
      throw new Error("No room is currently selected. Join a room first or pass room_id.");
    }

    const message = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      options: {
        method: "POST",
        body: JSON.stringify({ sender, text }),
      },
    });
    touchCurrentRoom(typeof (message as { id?: string }).id === "string" ? (message as { id: string }).id : undefined);
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
  "Read all messages from a Let Agents Chat room.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to the current room."),
  },
  async ({ room_id, project_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    const result = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
    });
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
  "Wait for new messages in a Let Agents Chat room. Blocks until new messages arrive or 30 seconds elapse. Use the after_message_id parameter to only receive messages newer than a specific message.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    project_id: z.string().optional().describe("Legacy project ID. Defaults to the current room."),
    after_message_id: z
      .string()
      .optional()
      .describe("Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns all existing messages immediately."),
    timeout: z
      .number()
      .optional()
      .describe("Maximum wait time in milliseconds. If set to 0, the default timeout will be used."),
  },
  async ({ room_id, project_id, after_message_id, timeout }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getTargetProjectId(project_id);
    const serverTimeout = Math.min(
      Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
      MAX_POLL_TIMEOUT_MS
    );
    const clientTimeout = serverTimeout + 5000; // 5s buffer over server timeout

    const params = new URLSearchParams();
    if (after_message_id) params.set("after", after_message_id);
    params.set("timeout", String(serverTimeout));

    const queryString = params.toString();
    const result = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages/poll?${queryString}`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages/poll?${queryString}`,
      options: { signal: AbortSignal.timeout(clientTimeout) },
    });
    if (targetRoomId) {
      touchRoomSession(targetRoomId, getLastMessageId(result));
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
              current_room: currentRoom,
              saved_current_room: savedCurrentRoom,
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
      await autoRegisterAgentIdentity();
    }

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

    const joined = await joinRoomIdentifier(savedRoom.room_id, savedRoom.joined_via);
    await autoRegisterAgentIdentity();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              rejoined_from_local_state: true,
              server_session_resumed: false,
              last_message_id_before_restart: savedRoom.last_message_id ?? null,
              room: joined.room,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

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
    const { autoDetectRepo } = await import("./repo-visibility.js");

    const result = await autoDetectRepo(cwd);

    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not in a git repository or no remote configured",
              suggestion: "Use create_project to create an invite room instead",
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.6.0)");

  // --- Auto-join from repo context ---
  try {
    // 1. Try .letagents.json config
    const configRoom = getRoomFromConfig();
    if (configRoom) {
      await joinRoomIdentifier(configRoom, "config");
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json)`);
      return;
    }

    // 2. Try git remote URL
    const gitRoom = getGitRemoteIdentity();
    if (gitRoom) {
      await joinRoomIdentifier(gitRoom, "git-remote");
      console.error(`🏠 Auto-joined room '${gitRoom}' (inferred from git remote — consider adding a .letagents.json)`);
      return;
    }

    // 3. Fall back to the most recent saved room session
    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      await joinRoomIdentifier(savedCurrentRoom.room_id, savedCurrentRoom.joined_via);
      console.error(`🏠 Rejoined saved room '${savedCurrentRoom.room_id}' (from local state)`);
      return;
    }

    // 4. No context found
    console.error("ℹ️ No .letagents.json, git remote, or saved room found — use join_project or join_room to connect.");
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
