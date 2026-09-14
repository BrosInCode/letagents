export type RoomTabId = "chat" | "memory" | "events" | "board" | "activity" | "rooms";

export interface RoomTabIndicator {
  label: string;
  count?: number | null;
  tone?: "info" | "success" | "warning" | "danger";
  pulse?: boolean;
  mode?: "dot" | "count";
}

export interface RoomTab {
  id: RoomTabId;
  label: string;
  count: number | null;
  indicator?: RoomTabIndicator | null;
}

export function isRoomTabId(value: string | null): value is RoomTabId {
  return (
    value === "chat"
    || value === "memory"
    || value === "events"
    || value === "board"
    || value === "activity"
    || value === "rooms"
  );
}


export type AttentionNavigationIntent = { roomIdentifier: string; taskId?: string; messageId?: string; threadRootId?: string; eventId?: string; eventUrl?: string; reasoningSessionId?: string; activity?: boolean };
