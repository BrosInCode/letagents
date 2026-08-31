import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SseClient, type Message } from "../../sse-client.js";
import {
  getStoredAgentIdentity,
  saveRoomSession,
  touchRoomSession,
  type RoomSessionState,
} from "../../local-state.js";
import {
  getCanonicalRoomWebPath,
  type JoinedVia,
} from "../../room-id.js";
import { getApiUrl, getLetagentsToken } from "./api.js";
import {
  AGENT_INSTANCE_UUID,
  currentAgentIdentity,
  currentAgentIdentityKey,
} from "./identity.js";
import { hasSupervisedWorkerAuthority } from "./worker-bearer.js";
import {
  getCurrentSupervisedRoomAuthority,
  runWithSupervisedRoomAuthority,
} from "./supervised-room-authority.js";

let mcpServer: McpServer | null = null;
let sseClient: SseClient | null = null;

export interface RoomState {
  room_id: string;
  navigation_locator?: string | null;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  git_room?: unknown;
  joined_via: JoinedVia;
  is_local?: boolean;
}

export let currentRoom: RoomState | null = null;

export function attachMcpServer(server: McpServer): void {
  mcpServer = server;
}

export function shutdownRuntime(): void {
  sseClient?.unsubscribeAll();
}

function getSseClient(): SseClient {
  sseClient ??= new SseClient(getApiUrl(), () => getLetagentsToken());
  return sseClient;
}

function getCurrentStreamAgentIdentity():
  | {
    actorLabel: string;
    actorKey: string | null;
    actorInstanceId: string;
  }
  | null {
  const identity = currentAgentIdentity ?? getStoredAgentIdentity(currentAgentIdentityKey);
  if (!identity?.actor_label || !identity.canonical_key) {
    return null;
  }

  return {
    actorLabel: identity.actor_label,
    actorKey: identity.canonical_key,
    actorInstanceId: AGENT_INSTANCE_UUID,
  };
}

export function toRoomState(input: {
  room_id: string;
  navigation_locator?: string | null;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  git_room?: unknown;
  joined_via: JoinedVia;
  is_local?: boolean;
}): RoomState {
  return {
    room_id: input.room_id,
    navigation_locator: input.navigation_locator ?? null,
    project_id: input.project_id ?? null,
    code: input.code ?? null,
    display_name: input.display_name ?? null,
    git_room: input.git_room ?? null,
    joined_via: input.joined_via,
    is_local: input.is_local ?? false,
  };
}

export function currentRoomMatchesLocator(locator: string | null): boolean {
  const value = locator?.trim();
  return Boolean(value && currentRoom && (
    currentRoom.room_id === value || currentRoom.navigation_locator === value
  ));
}

function getCanonicalRoomWebUrl(roomId: string): string {
  return new URL(getCanonicalRoomWebPath(roomId), `${getApiUrl()}/`).toString();
}

export function withCanonicalRoomLink<T extends Record<string, unknown>>(
  roomId: string,
  payload: T
): T & { room_path: string; room_url: string } {
  return {
    ...payload,
    room_path: getCanonicalRoomWebPath(roomId),
    room_url: getCanonicalRoomWebUrl(roomId),
  };
}

export function toPublicRoomState(state: RoomState | null): Record<string, unknown> | null {
  if (!state) {
    return null;
  }

  return withCanonicalRoomLink(state.room_id, {
    room_id: state.room_id,
    code: state.code ?? null,
    display_name: state.display_name ?? null,
    git_room: state.git_room ?? null,
    joined_via: state.joined_via,
    is_local: state.is_local ?? false,
  });
}

export function toPublicStoredRoomSession(session: RoomSessionState | null): Record<string, unknown> | null {
  if (!session) {
    return null;
  }

  return withCanonicalRoomLink(session.room_id, {
    room_id: session.room_id,
    code: session.code ?? null,
    display_name: session.display_name ?? null,
    git_room: session.git_room ?? null,
    joined_via: session.joined_via,
    joined_at: session.joined_at,
    last_seen_at: session.last_seen_at,
    last_message_id: session.last_message_id ?? null,
  });
}

export function toPublicRoomResponse(
  response: Record<string, unknown>,
  fallbackRoomId: string
): Record<string, unknown> {
  const {
    id: _legacyId,
    project_id: _legacyProjectId,
    ...rest
  } = response;

  return {
    ...withCanonicalRoomLink(
      typeof rest.room_id === "string" ? rest.room_id : fallbackRoomId,
      rest
    ),
    room_id: typeof rest.room_id === "string" ? rest.room_id : fallbackRoomId,
  };
}

export function rememberRoom(state: RoomState, lastMessageId?: string): RoomState {
  currentRoom = state;
  if (hasSupervisedWorkerAuthority()) return state;
  saveRoomSession({
    room_id: state.room_id,
    project_id: state.project_id ?? null,
    code: state.code ?? null,
    display_name: state.display_name ?? null,
    git_room: state.git_room ?? null,
    joined_via: state.joined_via,
    last_message_id: lastMessageId,
  });
  getSseClient().unsubscribeAll();
  if (state.is_local) {
    return state;
  }
  getSseClient().subscribe(
    {
      roomId: state.room_id,
      projectId: state.project_id ?? null,
      agentIdentity: getCurrentStreamAgentIdentity(),
    },
    (_message: Message) => {
      touchRoomSession(state.room_id);
      mcpServer?.server.sendResourceListChanged();
    },
    () => {
      // The SSE cursor crossed a broker/bridge loss boundary. MCP resources
      // are pull-based, so invalidating the list is the full-state repair.
      touchRoomSession(state.room_id);
      mcpServer?.server.sendResourceListChanged();
    },
  );
  return state;
}

export function touchCurrentRoom(lastMessageId?: string): void {
  if (hasSupervisedWorkerAuthority()) return;
  if (!currentRoom) {
    return;
  }

  touchRoomSession(currentRoom.room_id, lastMessageId);
}

export function getTargetRoomId(roomId?: string): string | null {
  if (hasSupervisedWorkerAuthority()) {
    const exactRoomAuthority = getCurrentSupervisedRoomAuthority();
    if (!exactRoomAuthority) {
      throw new Error("The daemon-supervised tool has not received its exact room authority.");
    }
    if (roomId && roomId !== exactRoomAuthority) {
      throw new Error(`The daemon-supervised tool is authorized for ${exactRoomAuthority}, not ${roomId}.`);
    }
    return exactRoomAuthority;
  }
  return roomId || currentRoom?.room_id || null;
}

/** The last room authority returned by this process's exact daemon effect. */
export { getCurrentSupervisedRoomAuthority } from "./supervised-room-authority.js";

/** Public room metadata without inventing join provenance or locality. */
export function toPublicCurrentRoomState(): Record<string, unknown> | null {
  const exactRoomAuthority = getCurrentSupervisedRoomAuthority();
  if (!exactRoomAuthority) return toPublicRoomState(currentRoom);
  return {
    ...toPublicRoomState(toRoomState({ room_id: exactRoomAuthority, joined_via: "join_room" })),
    joined_via: null,
    is_local: null,
  };
}

/**
 * Bind only the in-memory default used by one supervised MCP process. The
 * daemon response is the authority; this performs no join, storage, SSE, or
 * repository inspection and can safely rebind after a durable room move.
 */
export function runWithCurrentSupervisedRoom<T>(roomId: string, callback: () => T): T {
  if (!hasSupervisedWorkerAuthority()) {
    throw new Error("Only a daemon-supervised bounded turn can bind supervisor room authority.");
  }
  const normalized = roomId.trim();
  if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("The daemon-supervised room authority is malformed.");
  }
  return runWithSupervisedRoomAuthority(normalized, callback);
}

export function getFallbackProjectId(): string | null {
  if (hasSupervisedWorkerAuthority()) return null;
  return currentRoom?.project_id ?? null;
}
