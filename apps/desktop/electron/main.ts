import { app, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DesktopActivityEntry,
  DesktopAppInfo,
  DiagnosticsSnapshot,
  DesktopFocusRoomInfo,
  DesktopRoomMessage,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomSnapshot,
  DesktopTaskSummary,
  RepoStatus,
  RepoWorktreeEntry,
  WorkerSnapshot,
} from "./ipc-types.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(__dirname, "..", "..");
const rendererDistPath = join(__dirname, "..", "dist-renderer", "index.html");
const devServerUrl = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim() || null;
const apiUrl = process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat";

let mainWindow: BrowserWindow | null = null;

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
  });
  return stdout;
}

async function getCurrentBranch(): Promise<string | null> {
  try {
    const stdout = await runGit(["branch", "--show-current"]);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function getWorktrees(): Promise<RepoWorktreeEntry[]> {
  try {
    const stdout = await runGit(["worktree", "list", "--porcelain"]);
    const lines = stdout.split(/\r?\n/);
    const entries: RepoWorktreeEntry[] = [];
    let current: Partial<RepoWorktreeEntry> | null = null;

    for (const line of lines) {
      if (!line.trim()) {
        if (current?.path && current.head) {
          entries.push({
            path: current.path,
            branch: current.branch ?? null,
            head: current.head,
            isCurrent: current.path === workspaceRoot,
          });
        }
        current = null;
        continue;
      }

      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ").trim();
      if (key === "worktree") {
        current = { path: value };
      } else if (current && key === "HEAD") {
        current.head = value;
      } else if (current && key === "branch") {
        current.branch = value.replace(/^refs\/heads\//, "");
      }
    }

    if (current?.path && current.head) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isCurrent: current.path === workspaceRoot,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

async function buildRepoStatus(): Promise<RepoStatus> {
  return {
    rootPath: workspaceRoot,
    branch: await getCurrentBranch(),
    worktrees: await getWorktrees(),
  };
}

function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, "");
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readConfiguredRoomIdentifier(): string | null {
  try {
    const configPath = join(workspaceRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveRoomIdentifier(): Promise<string | null> {
  const configured = readConfiguredRoomIdentifier();
  if (configured) return configured;

  try {
    const stdout = await runGit(["remote", "get-url", "origin"]);
    return normalizeGitRemoteToRoomIdentifier(stdout);
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fetchRoomSnapshot(requestedRoomIdentifier?: string | null): Promise<DesktopRoomSnapshot> {
  const roomIdentifier = requestedRoomIdentifier?.trim() || await resolveRoomIdentifier();
  if (!roomIdentifier) {
    return {
      roomIdentifier: null,
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      recentActivity: [],
      messages: [],
    };
  }

  try {
    const joined = await apiFetch<{
      room_id?: string;
      code?: string;
      name?: string;
      display_name?: string;
      role?: string;
      authenticated?: boolean;
      kind?: "main" | "focus";
      parent_room_id?: string | null;
      focus_key?: string | null;
      source_task_id?: string | null;
      focus_status?: "active" | "concluded" | null;
    }>(`/rooms/${encodeURIComponent(roomIdentifier)}/join`, {
      method: "POST",
    });

    const [focusRoomsData, tasksData, participantsData, activityHistoryData, messagesData] = await Promise.all([
      apiFetch<{ focus_rooms?: Array<{
        room_id: string;
        name: string | null;
        display_name: string;
        code: string | null;
        source_task_id: string | null;
        focus_status: "active" | "concluded" | null;
        created_at: string;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/focus-rooms`).catch(() => ({ focus_rooms: [] })),
      apiFetch<{ tasks?: Array<{
        id: string;
        title: string;
        status: string;
        assignee: string | null;
        updated_at: string;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/tasks`).catch(() => ({ tasks: [] })),
      apiFetch<{ participants?: Array<{
        participant_key: string;
        kind: "human" | "agent";
        display_name: string;
        actor_label: string | null;
        activity_state: "active" | "away" | "offline" | null;
        last_seen_at: string;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/participants`).catch(() => ({ participants: [] })),
      apiFetch<{ entries?: Array<{
        id: string;
        participant: {
          display_name: string;
          kind: "human" | "agent";
          activity_state: "active" | "away" | "offline" | null;
        };
        last_room_activity_at: string;
        current_tasks: Array<{ id: string; title: string; status: string }>;
        completed_tasks: Array<{ id: string; title: string; status: string }>;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/activity-history?page_size=5`).catch(() => ({ entries: [] })),
      apiFetch<{ messages?: Array<{
        id: string;
        sender: string;
        text: string;
        source: string | null;
        timestamp: string;
        reply_to?: {
          id: string;
          sender: string;
          text: string;
          timestamp: string;
        } | null;
        agent_identity?: {
          actor_label?: string | null;
        } | null;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/messages?limit=24&before=latest`).catch(() => ({ messages: [] })),
    ]);

    const room: DesktopRoomInfo = {
      identifier: roomIdentifier,
      code: joined.code || "",
      name: joined.name || roomIdentifier,
      displayName: joined.display_name || joined.name || roomIdentifier,
      role: joined.role || "participant",
      authenticated: Boolean(joined.authenticated),
      kind: joined.kind || "main",
      parentRoomId: joined.parent_room_id || null,
      focusKey: joined.focus_key || null,
      sourceTaskId: joined.source_task_id || null,
      focusStatus: joined.focus_status || null,
    };

    const focusRooms: DesktopFocusRoomInfo[] = (focusRoomsData.focus_rooms || []).map((focusRoom) => ({
      roomId: focusRoom.room_id,
      identifier: focusRoom.room_id,
      displayName: focusRoom.display_name,
      code: focusRoom.code || null,
      sourceTaskId: focusRoom.source_task_id || null,
      focusStatus: focusRoom.focus_status || null,
      createdAt: focusRoom.created_at,
    }));

    const tasks: DesktopTaskSummary[] = (tasksData.tasks || []).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee: task.assignee || null,
      updatedAt: task.updated_at,
    }));

    const participants: DesktopParticipantSummary[] = (participantsData.participants || []).map((participant) => ({
      participantKey: participant.participant_key,
      kind: participant.kind,
      displayName: participant.display_name,
      actorLabel: participant.actor_label || null,
      activityState: participant.activity_state || null,
      lastSeenAt: participant.last_seen_at,
    }));

    const recentActivity: DesktopActivityEntry[] = (activityHistoryData.entries || []).map((entry) => ({
      id: entry.id,
      participantDisplayName: entry.participant.display_name,
      participantKind: entry.participant.kind,
      activityState: entry.participant.activity_state || null,
      lastRoomActivityAt: entry.last_room_activity_at,
      currentTasks: (entry.current_tasks || []).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
      completedTasks: (entry.completed_tasks || []).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
    }));

    const messages: DesktopRoomMessage[] = [...(messagesData.messages || [])]
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp || "");
        const rightTime = Date.parse(right.timestamp || "");
        return leftTime - rightTime;
      })
      .map((message) => ({
        id: message.id,
        sender: message.sender,
        text: message.text,
        source: message.source || null,
        timestamp: message.timestamp,
        actorLabel: message.agent_identity?.actor_label || null,
        replyTo: message.reply_to
          ? {
              id: message.reply_to.id,
              sender: message.reply_to.sender,
              text: message.reply_to.text,
              timestamp: message.reply_to.timestamp,
            }
          : null,
      }));

    return {
      roomIdentifier,
      room,
      focusRooms,
      tasks,
      participants,
      recentActivity,
      messages,
    };
  } catch {
    return {
      roomIdentifier,
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      recentActivity: [],
      messages: [],
    };
  }
}

function buildWorkerSnapshots(): WorkerSnapshot[] {
  return [];
}

function buildDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    apiUrl,
    localMode: "disabled",
    notes: [
      "This desktop app is using the same LetAgents service as the web app.",
      "Local-only storage is not part of this first version yet.",
      "Starting and stopping agents from the app is still being wired up.",
    ],
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "LetAgents Desktop",
    backgroundColor: "#0a0d14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.js"),
    },
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (!existsSync(rendererDistPath)) {
    throw new Error(`Renderer build not found at ${rendererDistPath}`);
  }

  void mainWindow.loadFile(rendererDistPath);
}

ipcMain.handle("desktop:app:get-info", async (): Promise<DesktopAppInfo> => ({
  appName: "LetAgents Desktop",
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  workspaceRoot,
  apiUrl,
}));

ipcMain.handle(
  "desktop:room:get-snapshot",
  async (_event, roomIdentifier?: string | null): Promise<DesktopRoomSnapshot> => fetchRoomSnapshot(roomIdentifier)
);
ipcMain.handle("desktop:repos:get-status", async (): Promise<RepoStatus> => buildRepoStatus());
ipcMain.handle("desktop:workers:list", async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots());
ipcMain.handle(
  "desktop:diagnostics:get-snapshot",
  async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot()
);

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
