export type RoomTabId = "chat" | "inbox" | "events" | "board" | "activity" | "rooms";

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
