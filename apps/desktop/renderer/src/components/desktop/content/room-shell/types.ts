import type { AgentInspectorRequest } from "../desktop-chat-message/types";

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


export type AttentionNavigationIntent = { roomIdentifier: string; taskId?: string; messageId?: string; threadRootId?: string; eventId?: string; eventUrl?: string; reasoningSessionId?: string; activity?: boolean;
  /** Supervised agent to open in the Inspector's Diagnostics. */
  agentEntryId?: string;
  /** Settings opens the same exact-identity inspector used by room participants. */
  agentInspector?: AgentInspectorRequest;
  /** Open this room's existing agent setup flow. */
  addAgent?: boolean;
  /** Board → Manager → Requests. */
  boardRequests?: boolean;
  /** Chat, where tool approval cards are docked above the composer. */
  approvals?: boolean };
