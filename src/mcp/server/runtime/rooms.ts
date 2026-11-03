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
  getCurrentAgentSessionSnapshot,
  getLocalStatePath,
  getStoredAgentRoutingStateSnapshot,
  isLocalRoomStorageEnabled,
  getStoredCurrentRoom,
  getStoredRoomSession,
  resolveLocalRoomStorageIdentifiers,
} from "../../local-state.js";
import { heldWorkerConnection } from "../../worker-call-context.js";
import { currentSessionScope } from "./session-scope.js";
import {
  ApiError,
  apiCall,
  isMissingRouteError,
  parseApiErrorPayload,
} from "./api.js";
import {
  RepoRoomAuthRequiredError,
  maybeHandleRepoRoomAuthRequired,
} from "./device-auth.js";
import {
  agentInstanceUuid,
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
import { hasSupervisedWorkerAuthority, requireValidWorkerBearerRuntime } from "./worker-bearer.js";

export type JoinSessionMode = "current";

/** letagents 0.12.46 removed the "live" mode, which started a local Codex worker process. */
export function normalizeJoinSessionMode(value: unknown): JoinSessionMode {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "live") {
    throw new Error("session_mode 'live' was removed in letagents 0.12.46. Join with session_mode 'current' (the default), and run Codex agents from the LetAgents desktop app.");
  }
  if (mode && mode !== "current") {
    throw new Error(`Unknown session_mode '${String(value).trim()}'. Use 'current' (the default).`);
  }
  return "current";
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
  const match = /^github\.com\/([^/\s]+\/[^/\s]+)\/focus\/git:(branch|tag):[A-Za-z0-9_-]+$/.exec(
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
  if (hasSupervisedWorkerAuthority()) {
    throw new Error("Room joins and creation are disabled during a daemon-supervised bounded turn.");
  }
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
        navigation_locator: joinedRoomId === roomId ? null : roomId,
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

const CONTROLLER_ONLY_NEXT_STEP =
  "You joined as this account's controller and can read the room. "
  + "To post as an agent, call register_agent_session with this room_id and a random registration_key "
  + "generated once for this chat, keep the returned worker_id, and pass worker_id to send_message, "
  + "send_thread_message and wait_for_messages. "
  + "If you already have a worker_id or registration_key for this room, reuse it instead.";

const WORKER_HELD_NEXT_STEP =
  "A worker for this room is already held here. "
  + "If it is this chat's, pass its worker_id to the room tools. "
  + "If this chat lost its worker_id, call register_agent_session with recover_lost_worker true, "
  + "this room_id and its display_name. "
  + "A different chat registers with its own registration_key.";

// A legacy registration has no worker_id, so recover_lost_worker does not apply to it.
const LEGACY_WORKER_HELD_NEXT_STEP =
  "A legacy worker registration for this room is already held here. "
  + "If it is this chat's, pass its agent_session_id to the room tools. "
  + "A different chat registers with register_agent_session, this room_id and its own registration_key.";

/**
 * After a join this chat is a controller: it can read the room, but a write
 * tool refuses until the chat has a worker. Say which case this is, unless the
 * chat needs no registration:
 * - A worker-bearer or supervised runtime brings its own worker identity.
 * - A local room starts its local worker on the first write.
 * - If the saved worker state cannot be read in full, nothing is claimed.
 *
 * The check is per process or credential, not per chat. A worker counts as held
 * in three cases. The first is an MCP worker handle this process connected; its
 * chat has a worker_id. The second is a legacy session this process registered.
 * The third is, in a remote /mcp session only, the room's current saved worker
 * session, which an earlier session of the same credential may have made. A
 * legacy registration has no worker_id, so it gets its own text. Outside a
 * remote session the current-session record is not read: in stdio it lives in
 * the state file that every process of this user shares, so a stale worker of
 * another process would look held. Two chats served by the same process or
 * credential see the same answer, so "worker_held" says that a worker exists
 * here. It does not say that the worker is this chat's.
 */
async function workerStatusJoinFields(roomId: string): Promise<Record<string, unknown>> {
  if (requireValidWorkerBearerRuntime().mode !== "owner") return {};
  if (await isLocalRoomStorageEnabled(roomId)) return {};

  const { cloudRoomId } = await resolveLocalRoomStorageIdentifiers(roomId);
  const statePath = getLocalStatePath();
  const instanceId = agentInstanceUuid();
  const inRemoteSession = currentSessionScope() !== null;
  let legacyHeld = false;
  for (const candidateRoomId of new Set([roomId, cloudRoomId ?? roomId])) {
    const routing = getStoredAgentRoutingStateSnapshot(candidateRoomId);
    if (!routing.complete) return {};
    const handleHeld = routing.sessions.some((session) => {
      const pinned = heldWorkerConnection(statePath, session.session_id);
      return pinned != null && pinned.session_token === session.session_token;
    });
    if (handleHeld) return { worker_status: "worker_held", worker_next_step: WORKER_HELD_NEXT_STEP };

    if (routing.sessions.some((session) => session.agent_instance_id === instanceId)) legacyHeld = true;
    if (inRemoteSession) {
      const current = getCurrentAgentSessionSnapshot(candidateRoomId);
      if (!current.complete) return {};
      if (current.session?.session_kind === "worker" && current.session.room_id === candidateRoomId) legacyHeld = true;
    }
  }
  return legacyHeld
    ? { worker_status: "worker_held", worker_next_step: LEGACY_WORKER_HELD_NEXT_STEP }
    : { worker_status: "controller_only", worker_next_step: CONTROLLER_ONLY_NEXT_STEP };
}

export async function createInviteRoom(): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  if (hasSupervisedWorkerAuthority()) {
    throw new Error("Room joins and creation are disabled during a daemon-supervised bounded turn.");
  }
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
      ...await workerStatusJoinFields(room.room_id),
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

  return withJoinRoomAgentPrompt({
    ...basePayload,
    ...await workerStatusJoinFields(input.joined.room.room_id),
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

async function bindWorkerRoomLocator(
  roomLocator: string,
  source: string,
): Promise<{ room: RoomState; source: string }> {
  const response = await apiCall<Record<string, unknown>>(
    `/rooms/resolve/${encodeURIComponent(roomLocator)}`,
  );
  if (response.room_exists !== true) {
    throw new ApiError(404, JSON.stringify({ error: "Room not found", code: "ROOM_NOT_FOUND" }));
  }
  const roomId = typeof response.canonical_room_id === "string"
    ? response.canonical_room_id
    : roomLocator;
  return {
    room: rememberRoom(toRoomState({
      room_id: roomId,
      navigation_locator: roomId === roomLocator ? null : roomLocator,
      project_id: roomId,
      display_name: roomId,
      git_room: response.git_room ?? null,
      joined_via: source === ".letagents.json" ? "config" : "git-remote",
    })),
    source,
  };
}

async function bindWorkerRoomFromContext(): Promise<{ room: RoomState; source: string } | null> {
  const configRoom = getRoomFromConfig();
  if (configRoom) {
    const gitContext = buildActiveGitRoomContext({
      repoRoom: configRoom,
      currentBranch: getGitCurrentBranch(),
      defaultBranch: getGitDefaultBranch(),
    });
    const roomId = gitContext.activeRoomLocator ?? configRoom;
    try {
      return await bindWorkerRoomLocator(roomId, ".letagents.json");
    } catch (error) {
      if (roomId === configRoom || !isNotFoundApiError(error)) throw error;
      return bindWorkerRoomLocator(configRoom, ".letagents.json");
    }
  }

  const gitContext = getGitRoomContext();
  if (gitContext.activeRoomLocator) {
    try {
      return await bindWorkerRoomLocator(gitContext.activeRoomLocator, "git remote");
    } catch (error) {
      if (!gitContext.repoRoom || !isNotFoundApiError(error)) throw error;
      return bindWorkerRoomLocator(gitContext.repoRoom, "git remote");
    }
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

type AutoJoinSource = "config" | "git-remote" | "saved-room";

/**
 * The message for an auto-join that the server refused because the room's host
 * is not GitHub (HTTP 403 `UNSUPPORTED_REPO_PROVIDER`). It names the host, says
 * it is not a supported provider, and names the workaround: a `.letagents.json`
 * file with a `room` field. Returns null for any other failure.
 */
export function describeUnsupportedProviderAutoJoin(
  error: unknown,
  source: AutoJoinSource | null
): string | null {
  const payload = parseApiErrorPayload(error);
  if (!(error instanceof ApiError) || error.status !== 403 || payload?.code !== "UNSUPPORTED_REPO_PROVIDER") {
    return null;
  }

  const roomId = typeof payload.room_id === "string" ? payload.room_id : "";
  const host = roomId.split("/")[0] || "unknown";
  const origin = source === "config"
    ? "the room field in .letagents.json"
    : source === "git-remote"
      ? "the git remote"
      : "the saved room";
  const workaround = source === "config"
    ? "Change the room field in .letagents.json to a github.com/owner/repo room, or to a plain room name without two slashes."
    : "To choose the room yourself, add a .letagents.json file with a room field in the repo root, " +
      'for example {"room": "github.com/owner/repo"}. If the host is an SSH config alias such as ' +
      "git@github-work:owner/repo.git, name the real github.com repository in that field.";
  return (
    `⚠️ Auto-join failed (server still running): the host '${host}' (from ${origin}, room '${roomId}') ` +
    "is not a supported provider. LetAgents repo rooms work for github.com repositories only. " +
    workaround
  );
}

export async function autoJoinFromContext(): Promise<void> {
  let source: AutoJoinSource | null = null;
  try {
    const workerRuntime = requireValidWorkerBearerRuntime();
    if (workerRuntime.mode === "supervised") {
      // The exact room may change after a durable daemon-owned room move.
      // Bind it per tool effect from the supervisor response, never from
      // ambient repository, persisted state, or launch-time environment.
      console.error("ℹ️ Daemon-supervised bounded turn leaves room selection to its exact supervisor context.");
      return;
    }
    if (workerRuntime.mode === "worker") {
      const bound = await bindWorkerRoomFromContext();
      if (bound) {
        console.error(`🏠 Bound worker bearer to existing room '${bound.room.room_id}' (from ${bound.source}).`);
      } else {
        console.error("ℹ️ Worker bearer has no .letagents.json, git remote, or saved room to bind locally.");
      }
      return;
    }

    const configRoom = getRoomFromConfig();
    if (configRoom) {
      source = "config";
      const gitContext = buildActiveGitRoomContext({
        repoRoom: configRoom,
        currentBranch: getGitCurrentBranch(),
        defaultBranch: getGitDefaultBranch(),
      });
      if (gitContext.activeRefRoomLocator && gitContext.currentBranch) {
        const joinedBranchRoom = await joinExistingRoomIdentifier(gitContext.activeRefRoomLocator, "config");
        if (joinedBranchRoom) {
          await ensureAgentIdentity();
          console.error(`🏠 Auto-joined existing branch room '${gitContext.activeRefRoomLocator}' (from .letagents.json + branch '${gitContext.currentBranch}')`);
          return;
        }
      }

      await joinRoomIdentifier(configRoom, "config");
      await ensureAgentIdentity();
      const branchNote = gitContext.activeRefRoomLocator && gitContext.currentBranch
        ? `; branch '${gitContext.currentBranch}' has no existing Git Room`
        : "";
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json${branchNote})`);
      return;
    }

    const gitContext = getGitRoomContext();
    if (gitContext.repoRoom) {
      source = "git-remote";
      if (gitContext.activeRefRoomLocator && gitContext.currentBranch) {
        const joinedBranchRoom = await joinExistingRoomIdentifier(gitContext.activeRefRoomLocator, "git-remote");
        if (joinedBranchRoom) {
          await ensureAgentIdentity();
          console.error(`🏠 Auto-joined existing branch room '${gitContext.activeRefRoomLocator}' (inferred from git remote and branch '${gitContext.currentBranch}' — consider adding a .letagents.json)`);
          return;
        }
      }

      await joinRoomIdentifier(gitContext.repoRoom, "git-remote");
      await ensureAgentIdentity();
      const branchNote = gitContext.activeRefRoomLocator && gitContext.currentBranch
        ? `; branch '${gitContext.currentBranch}' has no existing Git Room`
        : "";
      console.error(`🏠 Auto-joined room '${gitContext.repoRoom}' (inferred from git remote${branchNote} — consider adding a .letagents.json)`);
      return;
    }

    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      source = "saved-room";
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

    const unsupportedProvider = describeUnsupportedProviderAutoJoin(err, source);
    if (unsupportedProvider) {
      console.error(unsupportedProvider);
      return;
    }

    console.error("⚠️ Auto-join failed (server still running):", err instanceof Error ? err.message : err);
  }
}
