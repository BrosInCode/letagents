import type { MessagePin, MessagePinsResponse } from "./message-pins.mjs";
export interface MessagePinState {
  pins: MessagePin[];
  available: boolean;
  loading: boolean;
  pending: string | null;
  error: string | null;
}
export function createMessagePinStore<Context>(options: {
  load(context: Context): Promise<MessagePinsResponse>;
  mutate(context: Context, messageId: string, pinned: boolean): Promise<unknown>;
  onChange?(state: MessagePinState): void;
  onError?(message: string): void;
}): {
  readonly state: MessagePinState;
  reset(context?: Context | null): void;
  refresh(): Promise<unknown>;
  setPinned(messageId: string, pinned: boolean): Promise<unknown>;
  dispose(): void;
};
