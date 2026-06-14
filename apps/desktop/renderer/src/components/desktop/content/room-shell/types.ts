export type RoomTabId = "chat" | "events" | "board" | "activity" | "rooms" | "rent";

export interface RoomTab {
  id: RoomTabId;
  label: string;
  count: number | null;
}
