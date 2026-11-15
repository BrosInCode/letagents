export declare const ROOM_INVITE_EVENT: 'room_invite';
export declare const ROOM_INVITE_TTL_MS: number;

export type RoomInvitePlatform = 'grok' | 'chatgpt' | 'claude' | 'other';
/** 'admit': an admin made it, so it lets the bot in. 'request': a member made it, so it asks the admins. */
export type RoomInviteKind = 'admit' | 'request';
export type RoomInviteState = 'open' | 'used' | 'cancelled' | 'expired';
/** What a used invite did: let the account in, or file a request to join. */
export type RoomInviteOutcome = 'admitted' | 'requested';

export declare const ROOM_INVITE_PLATFORMS: readonly RoomInvitePlatform[];
export declare const ROOM_INVITE_KINDS: readonly RoomInviteKind[];
export declare const ROOM_INVITE_STATES: readonly RoomInviteState[];
export declare const ROOM_INVITE_OUTCOMES: readonly RoomInviteOutcome[];
export declare const ROOM_INVITE_CODE_ALPHABET: string;

/** One invite as its maker sees it. The code itself is never stored or returned again. */
export interface RoomInvite {
  id: string;
  /** The room the bot joins: always a members-only room, never a Git Room. */
  room_id: string;
  room_display_name: string;
  /** The room where the maker made it (a Git Room for its room picker), when it differs or is known. */
  origin_room_id: string | null;
  platform: RoomInvitePlatform;
  kind: RoomInviteKind;
  state: RoomInviteState;
  outcome: RoomInviteOutcome | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  /** The account that used it; for the maker only. */
  used_by_login: string | null;
}

/** The `room_invite` SSE payload. */
export interface RoomInviteEvent {
  invite: RoomInvite;
}

export declare function isRoomInvitePlatform(value: unknown): value is RoomInvitePlatform;
export declare function roomInvitePlatformLabel(platform: RoomInvitePlatform | string): string;
export declare function normalizeRoomInviteCode(value: unknown): string | null;
export declare function isRoomInviteCodeShape(value: unknown): boolean;
export declare function roomInviteJoinedText(platform: RoomInvitePlatform | string, makerLogin: string | null | undefined): string;
export declare function parseRoomInvite(value: unknown): RoomInvite | null;
export declare function parseRoomInviteEvent(value: unknown): RoomInviteEvent | null;
