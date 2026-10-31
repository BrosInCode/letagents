export declare const ROOM_EXPRESSION_GUIDANCE: string;
export interface RoomGif { provider: "giphy"; id: string; title: string; text_fallback_only?: true }
export declare function validReplyGifIntent(value: unknown): boolean;
export interface RoomExpressionsSetting {
  room_id: string;
  enabled: boolean;
  can_manage: boolean;
  gif_provider_configured: boolean;
}
export declare function normalizeRoomGif(value: unknown): RoomGif | null;
export declare function roomGifPageUrl(gif: unknown): string | null;
