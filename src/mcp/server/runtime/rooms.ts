import { getRoomFromConfig } from "../../config-reader.js";
import {
  buildActiveGitRoomContext,
  getGitCurrentBranch,
  getGitDefaultBranch,
  getGitRoomContext,
} from "../../git-remote.js";
import {
  encodeRoomIdPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "../../room-id.js";
import {
  isLocalRoomStorageEnabled,
  getStoredCurrentRoom,
  getStoredRoomSession,
} from "../../local-state.js";
import {
  getDefaultManagedAgentProvider,
  toManagedAgentStartResponse,
} from "../../managed-agent-providers.js";
import {
  ApiError,
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
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";

export type JoinSessionMode = "live" | "current";

export function normalizeJoinSessionMode(value: unknown): JoinSessionMode {
  return String(value || "").trim().toLowerCase() === "live" ? "live" : "current";
}

export function getCurrentLiveSessionPayload(roomId?: string): Record<string, unknown> | null {
  return getDefaultManagedAgentProvider().getCurrentLiveSessionPayload(roomId);
}

interface JoinRoomIdentifierOptions {
  allowCreate?: boolean;
}

interface GeneratedGitRefRoomIdentifier {
  repoRoom: string;
  refType: "branch" | "tag";
}

function isNotFoundApiError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function parseGeneratedGitRefRoomIdentifier(
  identifier: string
): GeneratedGitRefRoomIdentifier | null {
  const match = /^git-room:github\.com:([^/:\s]+\/[^/:\s]+):(branch|tag):[A-Za-z0-9_-]+$/.exec(
    identifier.trim()
  );
  if (!match) {
    return null;
  }

  return {
    repoRoom: `github.com/${match[1].toLowerCase()}`,
    refType: match[2] as "branch" | "tag",
  };
}

export async function joinRoomIdentifier(
  identifier: string,
  joinedVia: JoinedVia,
  options: JoinRoomIdentifierOptions = {}
): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const roomId = joinedVia === "join_code" ? normalizeInviteCode(identifier) : identifier.trim();

  if (joinedVia !== "join_code" && await isLocalRoomStorageEnabled(roomId)) {
    if (options.allowCreate === false && !getStoredRoomSession(roomId)) {
      throw new ApiError(404, JSON.stringify({ error: "Room not found", room_id: roomId }));
    }

    const agentIdentity = await ensureAgentIdentity();
    const room = rememberRoom(
      toRoomState({
        room_id: roomId,
        project_id: null,
        code: null,
        display_name: roomId,
        joined_via: joinedVia,
        is_local: true,
      })
    );
    return {
      room,
      response: {
        room_id: roomId,
        display_name: roomId,
        joined_via: joinedVia,
        is_local: true,
        agent_identity: toPublicAgentIdentity(agentIdentity),
      },
    };
  }

  try {
    const createQuery = options.allowCreate === false ? "?create=false" : "";
    const response = await apiCall<Record<string, unknown>>(
      `/rooms/${encodeRoomIdPath(roomId)}/join${createQuery}`,
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
        git_room: response.git_room ?? null,
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
    if (options.allowCreate === false) {
      throw error;
    }
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
        git_room: project.git_room ?? null,
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
      git_room: project.git_room ?? null,
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

async function joinExistingRoomIdentifier(
  identifier: string,
  joinedVia: JoinedVia
): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
} | null> {
  try {
    return await joinRoomIdentifier(identifier, joinedVia, { allowCreate: false });
  } catch (error) {
    if (isNotFoundApiError(error)) {
      return null;
    }
    throw error;
  }
}

export async function joinRoomIdentifierWithoutImplicitGitRefCreate(
  identifier: string,
  joinedVia: JoinedVia,
  options: { fallbackToRepo?: boolean } = {}
): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const gitRefRoom = parseGeneratedGitRefRoomIdentifier(identifier);
  if (!gitRefRoom) {
    return joinRoomIdentifier(identifier, joinedVia);
  }

  const joined = await joinExistingRoomIdentifier(identifier, joinedVia);
  if (joined) {
    return joined;
  }

  if (options.fallbackToRepo) {
    return joinRoomIdentifier(gitRefRoom.repoRoom, joinedVia);
  }

  throw new ApiError(404, JSON.stringify({
    error: "Room not found",
    code: "ROOM_NOT_FOUND",
    room_id: identifier.trim(),
  }));
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

  const provider = getDefaultManagedAgentProvider();
  const liveSession = await provider.startLocalSession({
    room_id: input.joined.room.room_id,
    room_identifier: input.room_identifier,
    room_code: input.joined.room.code ?? null,
    room_display_name: input.joined.room.display_name ?? null,
    joined_via: input.joined_via,
    cwd: process.cwd(),
  });

  return withJoinRoomAgentPrompt({
    ...basePayload,
    ...toManagedAgentStartResponse(provider, liveSession),
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

function bindWorkerRoomFromContext(): { room: RoomState; source: string } | null {
  const configRoom = getRoomFromConfig();
  if (configRoom) {
    const gitContext = buildActiveGitRoomContext({
      repoRoom: configRoom,
      currentBranch: getGitCurrentBranch(),
      defaultBranch: getGitDefaultBranch(),
    });
    const roomId = gitContext.activeRoom ?? configRoom;
    return {
      room: rememberRoom(toRoomState({
        room_id: roomId,
        display_name: roomId,
        joined_via: "config",
      })),
      source: ".letagents.json",
    };
  }

  const gitContext = getGitRoomContext();
  if (gitContext.activeRoom) {
    return {
      room: rememberRoom(toRoomState({
        room_id: gitContext.activeRoom,
        display_name: gitContext.activeRoom,
        joined_via: "git-remote",
      })),
      source: "git remote",
    };
  }

  const savedCurrentRoom = getStoredCurrentRoom();
  if (!savedCurrentRoom) {
    return null;
  }
  return {
    room: rememberRoom(toRoomState({
      room_id: savedCurrentRoom.room_id,
      project_id: savedCurrentRoom.project_id,
      code: savedCurrentRoom.code,
      display_name: savedCurrentRoom.display_name,
      git_room: savedCurrentRoom.git_room,
      joined_via: savedCurrentRoom.joined_via,
    })),
    source: "saved local room state",
  };
}

export async function autoJoinFromContext(): Promise<void> {
  try {
    const workerRuntime = requireValidWorkerBearerRuntime();
    if (workerRuntime.mode === "supervised") {
      // The exact room is daemon-owned context, not ambient repository or
      // persisted MCP state. Do not bind a potentially unrelated local room.
      console.error("ℹ️ Daemon-supervised bounded turn leaves room selection to its exact supervisor context.");
      return;
    }
    if (workerRuntime.mode === "worker") {
      const bound = bindWorkerRoomFromContext();
      if (bound) {
        console.error(`🏠 Bound worker bearer to room '${bound.room.room_id}' (from ${bound.source}; no join/create request).`);
      } else {
        console.error("ℹ️ Worker bearer has no .letagents.json, git remote, or saved room to bind locally.");
      }
      return;
    }

    const configRoom = getRoomFromConfig();
    if (configRoom) {
      const gitContext = buildActiveGitRoomContext({
        repoRoom: configRoom,
        currentBranch: getGitCurrentBranch(),
        defaultBranch: getGitDefaultBranch(),
      });
      if (gitContext.activeRefRoom && gitContext.currentBranch) {
        const joinedBranchRoom = await joinExistingRoomIdentifier(gitContext.activeRefRoom, "config");
        if (joinedBranchRoom) {
          await ensureAgentIdentity();
          console.error(`🏠 Auto-joined existing branch room '${gitContext.activeRefRoom}' (from .letagents.json + branch '${gitContext.currentBranch}')`);
          return;
        }
      }

      await joinRoomIdentifier(configRoom, "config");
      await ensureAgentIdentity();
      const branchNote = gitContext.activeRefRoom && gitContext.currentBranch
        ? `; branch '${gitContext.currentBranch}' has no existing Git Room`
        : "";
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json${branchNote})`);
      return;
    }

    const gitContext = getGitRoomContext();
    if (gitContext.repoRoom) {
      if (gitContext.activeRefRoom && gitContext.currentBranch) {
        const joinedBranchRoom = await joinExistingRoomIdentifier(gitContext.activeRefRoom, "git-remote");
        if (joinedBranchRoom) {
          await ensureAgentIdentity();
          console.error(`🏠 Auto-joined existing branch room '${gitContext.activeRefRoom}' (inferred from git remote and branch '${gitContext.currentBranch}' — consider adding a .letagents.json)`);
          return;
        }
      }

      await joinRoomIdentifier(gitContext.repoRoom, "git-remote");
      await ensureAgentIdentity();
      const branchNote = gitContext.activeRefRoom && gitContext.currentBranch
        ? `; branch '${gitContext.currentBranch}' has no existing Git Room`
        : "";
      console.error(`🏠 Auto-joined room '${gitContext.repoRoom}' (inferred from git remote${branchNote} — consider adding a .letagents.json)`);
      return;
    }

    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
        savedCurrentRoom.room_id,
        savedCurrentRoom.joined_via,
        { fallbackToRepo: true }
      );
      await ensureAgentIdentity();
      const fallbackNote = joined.room.room_id !== savedCurrentRoom.room_id
        ? `; saved Git ref room '${savedCurrentRoom.room_id}' was missing`
        : "";
      console.error(`🏠 Rejoined saved room '${joined.room.room_id}' (from local state${fallbackNote})`);
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
