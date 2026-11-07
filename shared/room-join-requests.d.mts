import type { RoomJoinRequest } from './room-membership.mjs';

export declare const ROOM_JOIN_REQUEST_EVENT: 'join_request';
export declare const JOIN_REQUEST_HIDDEN_SOUND_INTERVAL_MS: number;

/** A request as a room admin sees it, with the room's name for notifications. */
export interface RoomJoinRequestAlert extends RoomJoinRequest {
  /** The room's name, for a notification shown outside the room; '' or null when the reader has it already. */
  room_display_name: string | null;
}

/** The `join_request` SSE payload. */
export interface RoomJoinRequestEvent {
  /** The room the stream is for: the access room, or one of its focus rooms. */
  room_id: string;
  /** The room whose admins decide: the parent of a focus room, else the room. */
  access_room_id: string;
  request: RoomJoinRequestAlert;
}

export declare function parseRoomJoinRequest(value: unknown): RoomJoinRequestAlert | null;
export declare function parseRoomJoinRequestEvent(value: unknown): RoomJoinRequestEvent | null;
export declare function joinRequesterLabel(request: Pick<RoomJoinRequest, 'login' | 'display_name'>): string;
export declare function joinRequestBannerText(requests: ReadonlyArray<Pick<RoomJoinRequest, 'login' | 'display_name'>>): string;
export declare function joinRequestNotificationText(
  request: Pick<RoomJoinRequest, 'login' | 'display_name' | 'room_id'> & { room_display_name?: string | null },
  roomDisplayName?: string | null,
): { title: string; body: string };

export declare function joinRequestAskedLabel(createdAt: string, now?: number): string;

export interface JoinRequestSoundGate {
  shouldPlay(requestId: string, hidden: boolean): boolean;
  remember(requestId: string): void;
  reset(): void;
}
export declare function createJoinRequestSoundGate(options?: {
  now?: () => number;
  hiddenIntervalMs?: number;
}): JoinRequestSoundGate;
