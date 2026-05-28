import { getRoomFromConfig } from "../../config-reader.js";
import { getGitRemoteIdentity } from "../../git-remote.js";
import {
  encodeRoomIdPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "../../room-id.js";
import {
  getCurrentCodexLiveSession,
  getStoredCurrentRoom,
} from "../../local-state.js";
import {
  startLocalCodexSession,
  toPublicCodexLiveSession,
} from "../../codex-session.js";
import {
  apiCall,
  isMissingRouteError,
} from "./api.js";
import {
  RepoRoomAuthRequiredError,
  maybeHandleRepoRoomAuthRequired,
} from "./device-auth.js";
import {
  ensureAgentIdentity,
  toPublicAgentIdentity,
  withAgentIdentity,
} from "./identity.js";
import { withJoinRoomAgentPrompt } from "./messages.js";
import { syncRoomPresence } from "./presence.js";
import {
  rememberRoom,
  toPublicRoomResponse,
  toRoomState,
  type RoomState,
} from "./room-state.js";

export type JoinSessionMode = "live" | "current";

export function normalizeJoinSessionMode(value: unknown): JoinSessionMode {
  return String(value || "").trim().toLowerCase() === "live" ? "live" : "current";
}

export function getCurrentLiveSessionPayload(roomId?: string): Record<string, unknown> | null {
  const session = getCurrentCodexLiveSession(roomId);
  return session ? toPublicCodexLiveSession(session) : null;
}

export async function joinRoomIdentifier(identifier: string, joinedVia: JoinedVia): Promise<{
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
    const agentIdentity = await ensureAgentIdentity();
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
        display_name: typeof response.display_name === "string" ? response.display_name : null,
        joined_via: joinedVia,
      })
    );
    await syncRoomPresence(room.room_id, agentIdentity, {
      status: "idle",
      status_text: "available in room",
    });
    return {
      room,
      response: {
        ...response,
        room_id: joinedRoomId,
        agent_identity: toPublicAgentIdentity(agentIdentity),
      },
    };
  } catch (error) {
    await maybeHandleRepoRoomAuthRequired(error, roomId);
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
    const agentIdentity = await ensureAgentIdentity();
    const room = rememberRoom(
      toRoomState({
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        code: typeof project.code === "string" ? project.code : legacyRoomId,
        display_name: typeof project.display_name === "string" ? project.display_name : null,
        joined_via: joinedVia,
      })
    );
    await syncRoomPresence(room.room_id, agentIdentity, {
      status: "idle",
      status_text: "available in room",
    });
    return {
      room,
      response: {
        ...project,
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        agent_identity: toPublicAgentIdentity(agentIdentity),
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
  const agentIdentity = await ensureAgentIdentity();
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
      display_name: typeof project.display_name === "string" ? project.display_name : null,
      joined_via: joinedVia,
    })
  );
  await syncRoomPresence(room.room_id, agentIdentity, {
    status: "idle",
    status_text: "available in room",
  });
  return {
    room,
    response: {
      ...project,
      room_id: legacyRoomId,
      project_id: typeof project.id === "string" ? project.id : null,
      agent_identity: toPublicAgentIdentity(agentIdentity),
    },
  };
}

export async function createInviteRoom(): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const project = await apiCall<Record<string, unknown>>("/projects", { method: "POST" });
  const roomId =
    typeof project.code === "string"
      ? project.code
      : typeof project.id === "string"
        ? project.id
        : "unknown-room";

  const room = rememberRoom(
    toRoomState({
      room_id: roomId,
      project_id: typeof project.id === "string" ? project.id : null,
      code: typeof project.code === "string" ? project.code : roomId,
      display_name: typeof project.display_name === "string" ? project.display_name : null,
      joined_via: "join_code",
    })
  );
  const agentIdentity = await ensureAgentIdentity();
  await syncRoomPresence(room.room_id, agentIdentity, {
    status: "idle",
    status_text: "available in room",
  });

  return {
    room,
    response: {
      ...toPublicRoomResponse(project, roomId),
      agent_identity: toPublicAgentIdentity(agentIdentity),
    },
  };
}

export async function buildJoinResponse(input: {
  joined: { room: RoomState; response: Record<string, unknown> };
  room_identifier: string;
  joined_via: JoinedVia;
  session_mode: JoinSessionMode;
}): Promise<Record<string, unknown>> {
  const basePayload = await withAgentIdentity({
    ...toPublicRoomResponse(input.joined.response, input.joined.room.room_id),
    joined_via: input.joined_via,
    session_mode: input.session_mode,
  });

  if (input.session_mode === "current") {
    return withJoinRoomAgentPrompt(basePayload);
  }

  const liveSession = await startLocalCodexSession({
    room_id: input.joined.room.room_id,
    room_identifier: input.room_identifier,
    room_code: input.joined.room.code ?? null,
    room_display_name: input.joined.room.display_name ?? null,
    joined_via: input.joined_via,
    cwd: process.cwd(),
  });

  return withJoinRoomAgentPrompt({
    ...basePayload,
    local_codex_session: toPublicCodexLiveSession(liveSession.session),
    local_codex_session_started: !liveSession.reused,
    local_codex_session_reused: liveSession.reused,
  });
}

export async function joinInviteCode(
  code: string,
  sessionMode: JoinSessionMode
): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(code, "join_code");
  return buildJoinResponse({
    joined,
    room_identifier: normalizeInviteCode(code),
    joined_via: "join_code",
    session_mode: sessionMode,
  });
}

export async function joinNamedRoom(
  name: string,
  sessionMode: JoinSessionMode
): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(name, "join_room");
  return buildJoinResponse({
    joined,
    room_identifier: name.trim(),
    joined_via: "join_room",
    session_mode: sessionMode,
  });
}

export async function autoJoinFromContext(): Promise<void> {
  try {
    const configRoom = getRoomFromConfig();
    if (configRoom) {
      await joinRoomIdentifier(configRoom, "config");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json)`);
      return;
    }

    const gitRoom = getGitRemoteIdentity();
    if (gitRoom) {
      await joinRoomIdentifier(gitRoom, "git-remote");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${gitRoom}' (inferred from git remote — consider adding a .letagents.json)`);
      return;
    }

    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      await joinRoomIdentifier(savedCurrentRoom.room_id, savedCurrentRoom.joined_via);
      await ensureAgentIdentity();
      console.error(`🏠 Rejoined saved room '${savedCurrentRoom.room_id}' (from local state)`);
      return;
    }

    console.error("ℹ️ No .letagents.json, git remote, or saved room found — use create_room, join_code, or join_room to connect.");
  } catch (err) {
    if (err instanceof RepoRoomAuthRequiredError) {
      console.error(
        `🔐 Repo room auth required for '${err.roomId}'. Open ${err.pendingAuth.verification_uri} and enter code ${err.pendingAuth.user_code}, then run poll_device_auth.`
      );
      return;
    }

    console.error("⚠️ Auto-join failed (server still running):", err instanceof Error ? err.message : err);
  }
}
