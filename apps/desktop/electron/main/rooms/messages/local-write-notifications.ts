import type { RoomMessagePayload } from "./mappers.js";

export type LocalChatMessageWrite = {
  localRoomIdentifier: string;
  message: RoomMessagePayload;
};

type LocalChatMessageWriteListener = (write: LocalChatMessageWrite) => void;

const localChatMessageWriteListeners = new Set<LocalChatMessageWriteListener>();

export function subscribeToLocalChatMessageWrites(
  listener: LocalChatMessageWriteListener,
): () => void {
  localChatMessageWriteListeners.add(listener);
  return () => localChatMessageWriteListeners.delete(listener);
}

export function publishLocalChatMessageWrite(write: LocalChatMessageWrite): void {
  for (const listener of localChatMessageWriteListeners) {
    try {
      listener(write);
    } catch {
      // Persistence has already committed. One faulty consumer must not turn a
      // successful local send into a failed send or suppress other consumers.
    }
  }
}
