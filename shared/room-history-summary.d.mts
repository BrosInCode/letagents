export declare const ROOM_HISTORY_LINE_BYTES: number;
export declare const ROOM_HISTORY_BACKFILL_MESSAGES: number;
export declare const ROOM_HISTORY_DEFAULT_VIEW_LINES: number;
export declare const ROOM_HISTORY_MIN_VIEW_LINES: number;
export declare const ROOM_HISTORY_MAX_VIEW_LINES: number;
export declare const ROOM_HISTORY_SUMMARY_NOTE: string;

export declare function formatRoomHistoryNodeId(level: number, index: number): string;
export declare function parseRoomHistoryNodeId(value: unknown): { level: number; index: number } | null;
export declare function utf8Bytes(text: string): number;
export declare function clipUtf8(text: string, maxBytes: number): string;
export declare function singleLine(text: string): string;
export declare function clampRoomHistoryViewLines(value: unknown): number;

/**
 * Why summaries are or are not being written for a room:
 * - "off": a room admin turned them off;
 * - "unavailable": this server has no summarizer key;
 * - "building": messages are waiting to be summarized;
 * - "waiting": the summarizer failed and is retried at `retry_at`;
 * - "ready": every message the summary covers is summarized.
 */
export type RoomHistorySummaryState = "off" | "unavailable" | "building" | "waiting" | "ready";

export interface RoomHistorySummarySetting {
  room_id: string;
  enabled: boolean;
  can_manage: boolean;
  state: RoomHistorySummaryState;
  /** Messages read into the tree, and of those not summarized yet. */
  summarized_messages: number;
  pending_lines: number;
  retry_at: string | null;
  /** A short, credential-free reason for the last failure. */
  last_error: string | null;
}

export interface RoomHistoryLine {
  /** "level:index"; expand it to see the two lines it was made from. */
  node: string;
  level: number;
  /** The first and last message the line covers ("msg_12"). */
  first_message_id: string;
  last_message_id: string;
  first_at: string;
  last_at: string;
  /** How many messages the line covers. */
  messages: number;
  text: string;
  /** True for a message not summarized yet: its text is clipped, not summarized. */
  pending: boolean;
}

export interface RoomHistorySummaryView {
  room_id: string;
  state: RoomHistorySummaryState;
  note: string;
  lines: RoomHistoryLine[];
  /** The newest message the summary reached; read newer ones with read_messages. */
  covered_through_message_id: string | null;
}

export interface RoomHistoryExpansion {
  room_id: string;
  node: string;
  /** The two lines the node was made from; empty for a single message. */
  lines: RoomHistoryLine[];
  /** For a single message: the message itself. */
  message: { id: string; sender: string; text: string; timestamp: string; thread_root_id: string | null } | null;
}
