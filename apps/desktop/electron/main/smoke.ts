import electron from "electron";
import type { App } from "electron";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopAccountRoomEntry,
  DesktopAuthStatus,
  DesktopRoomSnapshot,
} from "../ipc-types.js";
import {
  localChatDatabasePath,
  localFilesPath,
} from "./chat-storage/settings.js";
import { readySourceStates } from "./rooms/snapshot/snapshots.js";

const smokeRoomIdentifier = "smoke-room";
const smokeCodexWorkerSessionId = "worker_smoke_codex";
const smokeCodexLiveSessionId = "local_smoke_codex";
const smokeCodexReasoningSessionId = "reasoning_smoke_codex";
let smokeUserDataPath: string | null = null;

function electronApp(): App {
  const app = (electron as { app?: App }).app;
  if (!app) {
    throw new Error("Electron app is unavailable outside the Electron runtime.");
  }
  return app;
}

export function isDesktopSmokeCheck(): boolean {
  return process.env.LETAGENTS_DESKTOP_SMOKE_CHECK === "1";
}

export function configureDesktopSmokeEnvironment(): void {
  if (!isDesktopSmokeCheck()) return;

  smokeUserDataPath = mkdtempSync(join(tmpdir(), "letagents-desktop-smoke-"));
  electronApp().setPath("userData", smokeUserDataPath);
  process.env.LETAGENTS_STATE_PATH ||= join(smokeUserDataPath, "letagents-state.json");
  process.once("exit", () => {
    if (smokeUserDataPath) {
      rmSync(smokeUserDataPath, { recursive: true, force: true });
    }
  });
}

export function seedDesktopSmokeState(): void {
  if (!isDesktopSmokeCheck()) return;

  const userDataPath = electronApp().getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(userDataPath, "letagents-desktop-setup.json"),
    `${JSON.stringify({
      completed: true,
      completedAt: now,
      selectedTargetId: "codex",
      installs: {},
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(userDataPath, "letagents-desktop-auth.json"),
    `${JSON.stringify({
      encryptedToken: "plain:desktop-smoke-token",
      ownerTokenId: "desktop-smoke-owner-token",
      oauthTokenExpiresAt: null,
      account: {
        id: "desktop-smoke-account",
        provider: "github",
        providerUserId: "desktop-smoke-user",
        login: "desktop-smoke",
        displayName: "Desktop Smoke",
        avatarUrl: null,
      },
      pendingDeviceAuth: null,
      savedAt: now,
    }, null, 2)}\n`,
    "utf8",
  );
  seedDesktopSmokeAgentState(now);
}

function seedDesktopSmokeAgentState(now: string): void {
  const statePath = process.env.LETAGENTS_STATE_PATH;
  if (!statePath) return;

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      agent_sessions: {
        [smokeCodexWorkerSessionId]: {
          session_id: smokeCodexWorkerSessionId,
          room_id: smokeRoomIdentifier,
          session_kind: "worker",
          runtime: "codex",
          host_kind: "desktop",
          host_label: "LetAgents Desktop",
          liveness_capability: "desktop_supervised_codex",
          tool_bridge_id: "letagents:codex:smoke",
          actor_label: "MapleRidge",
          agent_key: "codex",
          agent_instance_id: "codex-smoke-instance",
          display_name: "MapleRidge",
          owner_label: "Local desktop",
          ide_label: "Codex",
          created_at: now,
          updated_at: now,
          last_seen_at: now,
        },
      },
      current_agent_session_ids: {
        [smokeRoomIdentifier]: smokeCodexWorkerSessionId,
      },
      current_codex_live_session_ids: {
        [smokeRoomIdentifier]: smokeCodexLiveSessionId,
      },
      codex_live_sessions: {
        [smokeCodexLiveSessionId]: {
          session_id: smokeCodexLiveSessionId,
          room_id: smokeRoomIdentifier,
          room_identifier: smokeRoomIdentifier,
          room_display_name: "Smoke Room",
          display_name: "MapleRidge",
          joined_via: "join_room",
          cwd: process.cwd(),
          stop_phrase: "/stop-codex-room",
          max_minutes: 0,
          delivery_mode: "desktop_events",
          desktop_managed: true,
          deadline_utc: null,
          token: "LOCAL_CODEX_ROOM_smoke",
          thread_id: "thread_smoke_codex",
          turn_id: "turn_smoke_codex",
          server_url: "smoke://codex",
          server_pid: null,
          launched_server: false,
          codex_bin: "codex",
          agent_session_id: smokeCodexWorkerSessionId,
          reasoning_session_id: smokeCodexReasoningSessionId,
          status: "running",
          last_error: null,
          started_at: now,
          updated_at: now,
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

export function desktopSmokeAuthStatus(): DesktopAuthStatus {
  return {
    authenticated: true,
    account: {
      id: "desktop-smoke-account",
      provider: "github",
      providerUserId: "desktop-smoke-user",
      login: "desktop-smoke",
      displayName: "Desktop Smoke",
      avatarUrl: null,
    },
    pendingDeviceAuth: null,
    apiUrl: "smoke",
    tokenStored: true,
    error: null,
  };
}

export function desktopSmokeRoomSnapshot(): DesktopRoomSnapshot {
  const now = new Date().toISOString();
  return {
    roomIdentifier: smokeRoomIdentifier,
    access: {
      status: "ready",
      title: "Room ready",
      message: "",
      roomIdentifier: smokeRoomIdentifier,
      deviceFlowUrl: null,
      code: "SMOKE-ROOM",
      httpStatus: null,
    },
    room: {
      identifier: smokeRoomIdentifier,
      code: "SMOKE-ROOM",
      name: "Smoke Room",
      displayName: "Smoke Room",
      role: "admin",
      authenticated: true,
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
      focusParentVisibility: null,
      focusActivityScope: null,
      focusGitHubEventRouting: null,
      focusSettings: null,
      focusArchivedAt: null,
      concludedAt: null,
      conclusionSummary: null,
      conclusionDetails: null,
      gitRoom: null,
    },
    storage: {
      roomIdentifier: smokeRoomIdentifier,
      defaultMode: "cloud",
      overrideMode: "inherit",
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
      databasePath: localChatDatabasePath,
      localFilesPath,
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [
      {
        roomId: smokeRoomIdentifier,
        actorLabel: "MapleRidge",
        agentKey: "codex",
        agentInstanceId: "codex-smoke-instance",
        agentSessionId: smokeCodexWorkerSessionId,
        sessionKind: "worker",
        runtime: "codex",
        displayName: "MapleRidge",
        ownerLabel: "Local desktop",
        ideLabel: "Codex",
        repoBranch: null,
        status: "working",
        statusText: "Smoke checking local supervision",
        lastHeartbeatAt: now,
        freshness: "active",
        activityState: "active",
        sourceFlags: ["delivery", "presence", "messages"],
        livenessObservation: {
          roomId: smokeRoomIdentifier,
          agentSessionId: smokeCodexWorkerSessionId,
          source: "desktop",
          hostId: "desktop-smoke",
          hostKind: "desktop",
          hostLabel: "LetAgents Desktop",
          livenessCapability: "desktop_supervised_codex",
          toolBridgeId: "letagents:codex:smoke",
          lastObservedAt: now,
          lastToolCallAt: now,
          detail: "Smoke local supervised worker",
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    reasoningSessions: [
      {
        id: smokeCodexReasoningSessionId,
        roomId: smokeRoomIdentifier,
        actorLabel: "MapleRidge",
        agentKey: "codex",
        taskId: null,
        title: "Smoke reasoning stream",
        status: "working",
        summary: "Verifying the published reasoning panel.",
        latestPayload: {
          summary: "Verifying the published reasoning panel.",
          goal: "Exercise the local agent detail modal.",
          checking: "Managed session, stop control, and reasoning visibility.",
          next_action: "Return a green smoke result.",
          status: "working",
          confidence: 0.91,
        },
        goal: "Exercise the local agent detail modal.",
        checking: "Managed session, stop control, and reasoning visibility.",
        hypothesis: null,
        blocker: null,
        nextAction: "Return a green smoke result.",
        milestone: null,
        confidence: 0.91,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    recentActivity: [],
    roomArtifacts: [],
    boardSettings: {
      managerMode: "manager_optional",
      activeManager: null,
      pendingIntentCount: 0,
    },
    messages: [
      {
        id: "msg_smoke_1",
        sender: "Desktop Smoke",
        text: "Smoke room ready.",
        attachments: [],
        agentPromptKind: null,
        source: "browser",
        timestamp: now,
        actorLabel: "Desktop Smoke",
        agentIdentity: null,
        threadRootId: "msg_smoke_1",
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      },
      {
        id: "msg_smoke_codex",
        sender: "MapleRidge",
        text: "Published local Codex progress for smoke verification.",
        attachments: [],
        agentPromptKind: null,
        source: "agent",
        timestamp: now,
        actorLabel: "MapleRidge",
        agentIdentity: {
          name: "codex",
          displayName: "MapleRidge",
          ownerLabel: "Local desktop",
          ownerAttribution: "Local desktop's agent",
          ideLabel: "Codex",
          actorLabel: "MapleRidge",
          agentKey: "codex",
          agentSessionId: smokeCodexWorkerSessionId,
        },
        threadRootId: "msg_smoke_codex",
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      },
    ],
    githubEvents: null,
    sourceStates: readySourceStates(),
  };
}

export function desktopSmokeAccountRooms(): DesktopAccountRoomEntry[] {
  return [
    {
      roomIdentifier: smokeRoomIdentifier,
      displayName: "Smoke Room",
      name: "Smoke Room",
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
      role: "admin",
      source: "smoke",
      pinned: true,
      archived: false,
      canLeave: false,
      canDelete: false,
      deleteReason: "Smoke room",
      firstOpenedAt: null,
      lastOpenedAt: null,
      latestMessageId: "msg_smoke_1",
      latestMessageAt: null,
      gitRoom: null,
      focusRooms: [],
    },
  ];
}
