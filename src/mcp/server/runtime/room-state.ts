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
import { API_URL, getLetagentsToken } from "./api.js";
import {
  AGENT_INSTANCE_UUID,
  currentAgentIdentity,
  currentAgentIdentityKey,
} from "./identity.js";

let mcpServer: McpServer | null = null;
let sseClient: SseClient | null = null;

export interface RoomState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
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
  sseClient ??= new SseClient(API_URL, () => getLetagentsToken());
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
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  joined_via: JoinedVia;
  is_local?: boolean;
}): RoomState {
  return {
    room_id: input.room_id,
    project_id: input.project_id ?? null,
    code: input.code ?? null,
    display_name: input.display_name ?? null,
    joined_via: input.joined_via,
    is_local: input.is_local ?? false,
  };
}

function getCanonicalRoomWebUrl(roomId: string): string {
  return new URL(getCanonicalRoomWebPath(roomId), `${API_URL}/`).toString();
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
  saveRoomSession({
    room_id: state.room_id,
    project_id: state.project_id ?? null,
    code: state.code ?? null,
    display_name: state.display_name ?? null,
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
    }
  );
  return state;
}

export function touchCurrentRoom(lastMessageId?: string): void {
  if (!currentRoom) {
    return;
  }

  touchRoomSession(currentRoom.room_id, lastMessageId);
}

export function getTargetRoomId(roomId?: string): string | null {
  return roomId || currentRoom?.room_id || null;
}

export function getFallbackProjectId(): string | null {
  return currentRoom?.project_id ?? null;
}
