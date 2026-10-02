export const MESSAGE_PIN_LIMIT: 50;
export const MESSAGE_PIN_SNIPPET_LENGTH: 240;
export const MESSAGE_PIN_LIMIT_NOTICE: string;
export function isPinMessageId(value: unknown): value is string;
export function messagePinSnippet(text: string, displayText?: string | null): string;
export interface MessagePin {
  message_id: string;
  sender: string;
  source: string | null;
  timestamp: string;
  thread_root_id: string | null;
  snippet: string;
  pinned_at: string;
  pinned_by: { login: string; name: string; avatar_url: string | null };
}
export interface MessagePinsResponse {
  room_id: string;
  pins: MessagePin[];
  available?: boolean;
}
export interface MessagePinMutationResponse {
  room_id: string;
  message_id: string;
  changed: boolean;
}
